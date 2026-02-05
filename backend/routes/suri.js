/**
 * ========================================
 * ACERTIVE - Integração SURI (Chatbot Maker)
 * routes/suri.js
 * ========================================
 * 
 * Funcionalidades:
 * - Enviar mensagens via WhatsApp (template)
 * - Receber webhooks (mensagens recebidas)
 * - Registrar acionamentos automaticamente
 * - Chatbot de cobrança
 */

var express = require('express');

module.exports = function(pool, auth, registrarLog) {
    var router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // CONFIGURAÇÕES DA SURI
    // ═══════════════════════════════════════════════════════════════
    
    var SURI_CONFIG = {
        endpoint: 'https://cbm-wap-babysuri-cb126955962.azurewebsites.net',
        token: 'c79ce62a-eb6c-495a-b102-0e780b5d2047',
        identificador: 'cb126955962',
        channelId: 'wp946373665229352',
        channelType: 1,
        // Template padrão para cobrança (SURI - INICIANDO ATENDIMENTO)
        templateId: '1182587867397343'
    };

    function getSuriHeaders() {
        return {
            'Authorization': 'Bearer ' + SURI_CONFIG.token,
            'Content-Type': 'application/json'
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // FUNÇÕES AUXILIARES
    // ═══════════════════════════════════════════════════════════════

    function formatarTelefone(telefone) {
        if (!telefone) return null;
        var numeros = telefone.replace(/\D/g, '');
        if (numeros.length === 11) {
            return '55' + numeros;
        } else if (numeros.length === 10) {
            return '55' + numeros;
        } else if (numeros.length === 13 && numeros.startsWith('55')) {
            return numeros;
        }
        return numeros;
    }

    function formatarMoeda(valor) {
        return (valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    // ═══════════════════════════════════════════════════════════════
    // FUNÇÃO PRINCIPAL: ENVIAR TEMPLATE COM IMPORT
    // ═══════════════════════════════════════════════════════════════

    async function enviarTemplateComImport(cliente, telefone, templateId, bodyParams) {
        try {
            var body = {
                user: {
                    name: cliente.nome || 'Cliente',
                    phone: telefone,
                    email: cliente.email || null,
                    gender: 0,
                    channelId: SURI_CONFIG.channelId,
                    channelType: SURI_CONFIG.channelType,
                    defaultDepartmentId: null
                },
                message: {
                    templateId: templateId,
                    BodyParameters: bodyParams,
                    ButtonsParameters: []
                }
            };

            console.log('[SURI] Enviando template:', JSON.stringify(body, null, 2));

            var response = await fetch(SURI_CONFIG.endpoint + '/api/messages/send', {
                method: 'POST',
                headers: getSuriHeaders(),
                body: JSON.stringify(body)
            });

            var text = await response.text();
            console.log('[SURI] Resposta:', response.status, text);
            
            var data = text ? JSON.parse(text) : {};
            
            return { 
                success: data.success === true || response.ok, 
                data: data 
            };
        } catch (error) {
            console.error('[SURI] Erro ao enviar template:', error);
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // API: ENVIAR MENSAGEM (Template)
    // ═══════════════════════════════════════════════════════════════

    // POST /api/suri/enviar-mensagem
    router.post('/enviar-mensagem', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            var mensagem = req.body.mensagem || '';
            var assunto = req.body.assunto || 'uma pendência financeira';

            if (!cliente_id) {
                return res.status(400).json({ success: false, error: 'Cliente é obrigatório' });
            }

            // Buscar dados do cliente
            var clienteResult = await pool.query(
                'SELECT * FROM clientes WHERE id = $1',
                [cliente_id]
            );

            if (clienteResult.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            var cliente = clienteResult.rows[0];
            var telefone = formatarTelefone(cliente.telefone || cliente.celular);

            if (!telefone) {
                return res.status(400).json({ success: false, error: 'Cliente sem telefone cadastrado' });
            }

            // Pegar primeiro nome
            var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];

            // Enviar template com import
            var resultado = await enviarTemplateComImport(
                cliente, 
                telefone, 
                SURI_CONFIG.templateId,
                [primeiroNome, assunto]
            );

            if (resultado.success) {
                // Registrar acionamento
                await pool.query(
                    'INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
                    [cliente_id, req.user.id, 'whatsapp', 'suri', 'enviado', 'Mensagem enviada via Suri - Assunto: ' + assunto]
                );

                // Atualizar último contato
                await pool.query(
                    'UPDATE clientes SET data_ultimo_contato = NOW(), updated_at = NOW() WHERE id = $1',
                    [cliente_id]
                );

                if (registrarLog) {
                    await registrarLog(req.user.id, 'SURI_MENSAGEM_ENVIADA', 'clientes', cliente_id, { telefone: telefone });
                }

                res.json({ 
                    success: true, 
                    message: 'Mensagem enviada com sucesso!',
                    data: resultado.data
                });
            } else {
                res.status(500).json({ success: false, error: resultado.error || 'Erro ao enviar mensagem' });
            }

        } catch (error) {
            console.error('[SURI] Erro ao enviar mensagem:', error);
            res.status(500).json({ success: false, error: 'Erro interno: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // API: ENVIAR COBRANÇA (Mensagem formatada)
    // ═══════════════════════════════════════════════════════════════

    // POST /api/suri/enviar-cobranca
    router.post('/enviar-cobranca', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            var tipo_mensagem = req.body.tipo_mensagem || 'lembrete';

            if (!cliente_id) {
                return res.status(400).json({ success: false, error: 'Cliente é obrigatório' });
            }

            // Buscar dados do cliente e cobranças
            var clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
            
            if (clienteResult.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            var cliente = clienteResult.rows[0];
            var telefone = formatarTelefone(cliente.telefone || cliente.celular);
            
            if (!telefone) {
                return res.status(400).json({ success: false, error: 'Cliente sem telefone cadastrado' });
            }

            // Buscar cobranças pendentes
            var cobrancasResult = await pool.query(
                "SELECT SUM(valor) as total, COUNT(*) as qtd, MIN(data_vencimento) as vencimento FROM cobrancas WHERE cliente_id = $1 AND status IN ('pendente', 'vencido')",
                [cliente_id]
            );

            var cobranca = cobrancasResult.rows[0];
            var valorTotal = parseFloat(cobranca.total) || 0;
            var qtdCobrancas = parseInt(cobranca.qtd) || 0;

            // Pegar primeiro nome
            var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];

            // Definir assunto baseado no tipo de mensagem
            var assuntos = {
                lembrete: 'sua pendência financeira',
                urgente: 'um débito urgente em seu nome',
                negociacao: 'uma proposta de negociação',
                acordo: 'uma oportunidade de acordo'
            };

            var assunto = assuntos[tipo_mensagem] || assuntos.lembrete;

            // Se tiver valor, adicionar ao assunto
            if (valorTotal > 0) {
                assunto = 'seu débito de ' + formatarMoeda(valorTotal);
            }

            // Enviar template com import
            var resultado = await enviarTemplateComImport(
                cliente, 
                telefone, 
                SURI_CONFIG.templateId,
                [primeiroNome, assunto]
            );

            if (resultado.success) {
                await pool.query(
                    'INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
                    [cliente_id, req.user.id, 'whatsapp', 'suri', 'enviado', 'Cobrança automática: ' + tipo_mensagem]
                );

                await pool.query(
                    'UPDATE clientes SET data_ultimo_contato = NOW(), updated_at = NOW() WHERE id = $1',
                    [cliente_id]
                );

                res.json({ 
                    success: true, 
                    message: 'Cobrança enviada com sucesso!',
                    tipo: tipo_mensagem,
                    assunto: assunto
                });
            } else {
                res.status(500).json({ success: false, error: resultado.error || 'Erro ao enviar' });
            }

        } catch (error) {
            console.error('[SURI] Erro ao enviar cobrança:', error);
            res.status(500).json({ success: false, error: 'Erro interno: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // WEBHOOK: RECEBER EVENTOS DA SURI
    // ═══════════════════════════════════════════════════════════════

    // POST /api/suri/webhook
    router.post('/webhook', async function(req, res) {
        try {
            var evento = req.body;
            console.log('[SURI WEBHOOK] Evento recebido:', JSON.stringify(evento, null, 2));

            var tipo = evento.type || evento.event || 'unknown';

            switch (tipo) {
                case 'new-contact':
                    await processarNovoContato(evento);
                    break;
                
                case 'message-received':
                    await processarMensagemRecebida(evento);
                    break;
                
                case 'change-queue':
                    await processarMudancaFila(evento);
                    break;
                
                case 'finish-attendance':
                    await processarFinalizacaoAtendimento(evento);
                    break;
                
                default:
                    console.log('[SURI WEBHOOK] Tipo de evento não tratado:', tipo);
            }

            res.json({ success: true, message: 'Webhook recebido' });

        } catch (error) {
            console.error('[SURI WEBHOOK] Erro:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Processar novo contato
    async function processarNovoContato(evento) {
        try {
            var contato = evento.contact || evento.data || evento;
            var telefone = contato.phone || contato.telefone;
            
            if (!telefone) return;

            // Verificar se já existe cliente com esse telefone
            var telefoneNumeros = telefone.replace(/\D/g, '');
            // Remover DDI se existir
            if (telefoneNumeros.startsWith('55') && telefoneNumeros.length > 11) {
                telefoneNumeros = telefoneNumeros.substring(2);
            }

            var clienteResult = await pool.query(
                "SELECT * FROM clientes WHERE REPLACE(REPLACE(REPLACE(telefone, '(', ''), ')', ''), '-', '') LIKE $1 OR REPLACE(REPLACE(REPLACE(celular, '(', ''), ')', ''), '-', '') LIKE $1",
                ['%' + telefoneNumeros + '%']
            );

            if (clienteResult.rowCount > 0) {
                var cliente = clienteResult.rows[0];
                console.log('[SURI] Novo contato identificado como cliente:', cliente.nome);
                
                // Registrar acionamento
                await pool.query(
                    "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'novo_contato', 'Cliente iniciou contato via WhatsApp', NOW())",
                    [cliente.id]
                );
            }
        } catch (error) {
            console.error('[SURI] Erro ao processar novo contato:', error);
        }
    }

    // Processar mensagem recebida
    async function processarMensagemRecebida(evento) {
        try {
            var mensagem = evento.message || evento.data || evento;
            var contato = mensagem.contact || evento.contact || {};
            var telefone = contato.phone || contato.telefone || mensagem.from;
            var texto = mensagem.text || mensagem.body || mensagem.message || '';

            if (!telefone) return;

            console.log('[SURI] Mensagem recebida de', telefone, ':', texto);

            // Buscar cliente pelo telefone
            var telefoneNumeros = telefone.replace(/\D/g, '');
            if (telefoneNumeros.startsWith('55') && telefoneNumeros.length > 11) {
                telefoneNumeros = telefoneNumeros.substring(2);
            }

            var clienteResult = await pool.query(
                "SELECT * FROM clientes WHERE REPLACE(REPLACE(REPLACE(telefone, '(', ''), ')', ''), '-', '') LIKE $1 OR REPLACE(REPLACE(REPLACE(celular, '(', ''), ')', ''), '-', '') LIKE $1",
                ['%' + telefoneNumeros + '%']
            );

            if (clienteResult.rowCount > 0) {
                var cliente = clienteResult.rows[0];

                // Registrar acionamento com a mensagem recebida
                await pool.query(
                    "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'resposta_recebida', $2, NOW())",
                    [cliente.id, 'Mensagem do cliente: ' + texto.substring(0, 500)]
                );

                // Verificar se é uma resposta de interesse em acordo
                var textoLower = texto.toLowerCase();
                if (textoLower.includes('acordo') || textoLower.includes('negociar') || textoLower.includes('pagar') || textoLower.includes('parcela')) {
                    // Atualizar status para "negociando"
                    await pool.query(
                        "UPDATE clientes SET status_cobranca = 'negociando', updated_at = NOW() WHERE id = $1 AND status_cobranca NOT IN ('acordo')",
                        [cliente.id]
                    );

                    console.log('[SURI] Cliente', cliente.nome, 'demonstrou interesse em negociação');
                }
            }
        } catch (error) {
            console.error('[SURI] Erro ao processar mensagem:', error);
        }
    }

    // Processar mudança de fila
    async function processarMudancaFila(evento) {
        console.log('[SURI] Mudança de fila:', evento);
    }

    // Processar finalização de atendimento
    async function processarFinalizacaoAtendimento(evento) {
        try {
            var atendimento = evento.attendance || evento.data || evento;
            var contato = atendimento.contact || {};
            var telefone = contato.phone || contato.telefone;

            if (!telefone) return;

            var telefoneNumeros = telefone.replace(/\D/g, '');
            if (telefoneNumeros.startsWith('55') && telefoneNumeros.length > 11) {
                telefoneNumeros = telefoneNumeros.substring(2);
            }

            var clienteResult = await pool.query(
                "SELECT * FROM clientes WHERE REPLACE(REPLACE(REPLACE(telefone, '(', ''), ')', ''), '-', '') LIKE $1 OR REPLACE(REPLACE(REPLACE(celular, '(', ''), ')', ''), '-', '') LIKE $1",
                ['%' + telefoneNumeros + '%']
            );

            if (clienteResult.rowCount > 0) {
                var cliente = clienteResult.rows[0];
                
                await pool.query(
                    "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'atendimento_finalizado', 'Atendimento via Suri finalizado', NOW())",
                    [cliente.id]
                );
            }
        } catch (error) {
            console.error('[SURI] Erro ao processar finalização:', error);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // API: DISPARO EM MASSA (RÉGUA DE COBRANÇA)
    // ═══════════════════════════════════════════════════════════════

    // POST /api/suri/disparo-massa
    router.post('/disparo-massa', auth, async function(req, res) {
        try {
            var tipo_mensagem = req.body.tipo_mensagem || 'lembrete';
            var filtro_atraso_min = req.body.filtro_atraso_min || 0;
            var filtro_atraso_max = req.body.filtro_atraso_max || 9999;
            var limite = req.body.limite || 50;

            // Definir assunto baseado no tipo
            var assuntos = {
                lembrete: 'sua pendência financeira',
                urgente: 'um débito urgente em seu nome',
                negociacao: 'uma proposta de negociação',
                acordo: 'uma oportunidade de acordo'
            };

            // Buscar clientes com cobranças vencidas
            var query = `
                SELECT 
                    c.id, c.nome, c.telefone, c.celular, c.cpf_cnpj, c.email,
                    SUM(cob.valor) as valor_total,
                    COUNT(cob.id) as qtd_cobrancas,
                    MAX(CURRENT_DATE - cob.data_vencimento) as maior_atraso
                FROM clientes c
                JOIN cobrancas cob ON cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')
                WHERE c.ativo = true 
                  AND (c.telefone IS NOT NULL OR c.celular IS NOT NULL)
                  AND c.status_cobranca NOT IN ('acordo', 'incobravel', 'juridico')
                GROUP BY c.id
                HAVING MAX(CURRENT_DATE - cob.data_vencimento) BETWEEN $1 AND $2
                ORDER BY MAX(CURRENT_DATE - cob.data_vencimento) DESC
                LIMIT $3
            `;

            var result = await pool.query(query, [filtro_atraso_min, filtro_atraso_max, limite]);
            var clientes = result.rows;

            var enviados = 0;
            var erros = [];

            for (var i = 0; i < clientes.length; i++) {
                var cliente = clientes[i];
                try {
                    var telefone = formatarTelefone(cliente.telefone || cliente.celular);
                    if (!telefone) continue;

                    var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];
                    var valorTotal = parseFloat(cliente.valor_total) || 0;
                    
                    // Usar valor no assunto se disponível
                    var assunto = valorTotal > 0 
                        ? 'seu débito de ' + formatarMoeda(valorTotal)
                        : assuntos[tipo_mensagem] || assuntos.lembrete;

                    var resultado = await enviarTemplateComImport(
                        cliente, 
                        telefone, 
                        SURI_CONFIG.templateId,
                        [primeiroNome, assunto]
                    );

                    if (resultado.success) {
                        enviados++;
                        
                        await pool.query(
                            "INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, 'whatsapp', 'suri', 'enviado', $3, NOW())",
                            [cliente.id, req.user.id, 'Disparo em massa: ' + tipo_mensagem]
                        );
                    } else {
                        erros.push({ cliente_id: cliente.id, nome: cliente.nome, erro: resultado.error });
                    }

                    // Delay entre mensagens para não sobrecarregar (2 segundos)
                    await new Promise(function(resolve) { setTimeout(resolve, 2000); });
                    
                } catch (err) {
                    erros.push({ cliente_id: cliente.id, nome: cliente.nome, erro: err.message });
                }
            }

            if (registrarLog) {
                await registrarLog(req.user.id, 'SURI_DISPARO_MASSA', 'sistema', null, { 
                    tipo: tipo_mensagem, 
                    enviados: enviados, 
                    total: clientes.length 
                });
            }

            res.json({
                success: true,
                message: 'Disparo concluído!',
                data: {
                    total_clientes: clientes.length,
                    enviados: enviados,
                    erros: erros.length,
                    detalhes_erros: erros
                }
            });

        } catch (error) {
            console.error('[SURI] Erro no disparo em massa:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // API: STATUS DA INTEGRAÇÃO
    // ═══════════════════════════════════════════════════════════════

    // GET /api/suri/status
    router.get('/status', auth, async function(req, res) {
        try {
            // Testar conexão importando contato de teste
            var response = await fetch(SURI_CONFIG.endpoint + '/api/contacts', {
                method: 'POST',
                headers: getSuriHeaders(),
                body: JSON.stringify({
                    phone: '5500000000000',
                    name: 'Teste Conexão',
                    channelId: SURI_CONFIG.channelId,
                    channelType: SURI_CONFIG.channelType
                })
            });

            var text = await response.text();
            var data = text ? JSON.parse(text) : {};
            var conectado = data.success === true;

            // Buscar estatísticas
            var statsResult = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE tipo = 'whatsapp' AND canal = 'suri' AND DATE(created_at) = CURRENT_DATE) as mensagens_hoje,
                    COUNT(*) FILTER (WHERE tipo = 'whatsapp' AND canal = 'suri' AND created_at >= NOW() - INTERVAL '7 days') as mensagens_semana,
                    COUNT(*) FILTER (WHERE tipo = 'whatsapp' AND canal = 'suri') as mensagens_total
                FROM acionamentos
            `);

            res.json({
                success: true,
                data: {
                    conectado: conectado,
                    endpoint: SURI_CONFIG.endpoint,
                    identificador: SURI_CONFIG.identificador,
                    channelId: SURI_CONFIG.channelId,
                    templateId: SURI_CONFIG.templateId,
                    estatisticas: statsResult.rows[0]
                }
            });
        } catch (error) {
            res.json({
                success: false,
                data: {
                    conectado: false,
                    erro: error.message
                }
            });
        }
    });

    return router;
};