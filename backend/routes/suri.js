/**
 * ========================================
 * ACERTIVE - Integração SURI (Chatbot Maker)
 * routes/suri.js
 * ========================================
 * 
 * Funcionalidades:
 * - Enviar mensagens via WhatsApp
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
        identificador: 'cb126955962'
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
    // API: ENVIAR MENSAGEM
    // ═══════════════════════════════════════════════════════════════

    // POST /api/suri/enviar-mensagem
    router.post('/enviar-mensagem', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            var mensagem = req.body.mensagem;
            var tipo = req.body.tipo || 'texto';

            if (!cliente_id || !mensagem) {
                return res.status(400).json({ success: false, error: 'Cliente e mensagem são obrigatórios' });
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

            // Primeiro, importar/atualizar contato na Suri
            var contatoSuri = await importarContatoSuri(cliente, telefone);
            
            if (!contatoSuri || !contatoSuri.id) {
                return res.status(500).json({ success: false, error: 'Erro ao importar contato na Suri' });
            }

            // Enviar mensagem
            var resultado = await enviarMensagemSuri(contatoSuri.id, mensagem, tipo);

            if (resultado.success) {
                // Registrar acionamento
                await pool.query(
                    'INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
                    [cliente_id, req.user.id, 'whatsapp', 'suri', 'enviado', 'Mensagem enviada via Suri: ' + mensagem.substring(0, 100)]
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

    // Função para importar contato na Suri
    async function importarContatoSuri(cliente, telefone) {
        try {
            var response = await fetch(SURI_CONFIG.endpoint + '/api/v1/contacts/import', {
                method: 'POST',
                headers: getSuriHeaders(),
                body: JSON.stringify({
                    phone: telefone,
                    name: cliente.nome,
                    email: cliente.email || '',
                    document: cliente.cpf_cnpj || '',
                    notes: 'Cliente ACERTIVE - ID: ' + cliente.id
                })
            });

            var data = await response.json();
            console.log('[SURI] Contato importado:', data);
            return data;
        } catch (error) {
            console.error('[SURI] Erro ao importar contato:', error);
            return null;
        }
    }

    // Função para enviar mensagem via Suri
    async function enviarMensagemSuri(contatoId, mensagem, tipo) {
        try {
            var body = {
                contactId: contatoId,
                message: mensagem
            };

            if (tipo === 'template') {
                body.type = 'template';
            }

            var response = await fetch(SURI_CONFIG.endpoint + '/api/v1/messages/send', {
                method: 'POST',
                headers: getSuriHeaders(),
                body: JSON.stringify(body)
            });

            var data = await response.json();
            console.log('[SURI] Mensagem enviada:', data);
            
            return { success: response.ok, data: data };
        } catch (error) {
            console.error('[SURI] Erro ao enviar mensagem:', error);
            return { success: false, error: error.message };
        }
    }

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

            // Buscar cobranças pendentes
            var cobrancasResult = await pool.query(
                "SELECT SUM(valor) as total, COUNT(*) as qtd, MIN(data_vencimento) as vencimento FROM cobrancas WHERE cliente_id = $1 AND status IN ('pendente', 'vencido')",
                [cliente_id]
            );

            var cobranca = cobrancasResult.rows[0];
            var valorTotal = parseFloat(cobranca.total) || 0;
            var qtdCobrancas = parseInt(cobranca.qtd) || 0;

            if (qtdCobrancas === 0) {
                return res.status(400).json({ success: false, error: 'Cliente não possui cobranças pendentes' });
            }

            // Montar mensagem baseada no tipo
            var mensagem = montarMensagemCobranca(cliente, valorTotal, qtdCobrancas, tipo_mensagem);

            // Enviar via endpoint padrão
            req.body.mensagem = mensagem;
            
            // Chamar função de envio
            var telefone = formatarTelefone(cliente.telefone || cliente.celular);
            
            if (!telefone) {
                return res.status(400).json({ success: false, error: 'Cliente sem telefone cadastrado' });
            }

            var contatoSuri = await importarContatoSuri(cliente, telefone);
            
            if (!contatoSuri || !contatoSuri.id) {
                return res.status(500).json({ success: false, error: 'Erro ao importar contato na Suri' });
            }

            var resultado = await enviarMensagemSuri(contatoSuri.id, mensagem, 'texto');

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
                    mensagem_enviada: mensagem
                });
            } else {
                res.status(500).json({ success: false, error: resultado.error || 'Erro ao enviar' });
            }

        } catch (error) {
            console.error('[SURI] Erro ao enviar cobrança:', error);
            res.status(500).json({ success: false, error: 'Erro interno: ' + error.message });
        }
    });

    function montarMensagemCobranca(cliente, valorTotal, qtdCobrancas, tipo) {
        var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];
        var valorFormatado = formatarMoeda(valorTotal);

        var mensagens = {
            lembrete: 'Olá ' + primeiroNome + '! 👋\n\n' +
                'Passando para lembrar que você possui ' + qtdCobrancas + ' cobrança(s) em aberto no valor total de *' + valorFormatado + '*.\n\n' +
                'Entre em contato conosco para regularizar sua situação e evitar juros e multas.\n\n' +
                'Atenciosamente,\n*Equipe ACERTIVE*',
            
            urgente: '⚠️ *AVISO IMPORTANTE* ⚠️\n\n' +
                'Prezado(a) ' + primeiroNome + ',\n\n' +
                'Identificamos pendências em seu nome no valor de *' + valorFormatado + '*.\n\n' +
                'Para evitar medidas de cobrança judicial e negativação, entre em contato URGENTE para negociação.\n\n' +
                '*Equipe ACERTIVE*',
            
            negociacao: 'Olá ' + primeiroNome + '! 🤝\n\n' +
                'Temos uma *proposta especial* para você regularizar sua situação!\n\n' +
                '💰 Valor em aberto: *' + valorFormatado + '*\n\n' +
                'Oferecemos condições facilitadas de pagamento. Responda essa mensagem para conhecer nossas opções!\n\n' +
                '*Equipe ACERTIVE*',
            
            acordo: 'Olá ' + primeiroNome + '! ✅\n\n' +
                'Que tal resolver sua pendência hoje?\n\n' +
                'Valor: *' + valorFormatado + '*\n\n' +
                'Temos opções de:\n' +
                '• Pagamento à vista com desconto\n' +
                '• Parcelamento em até 12x\n\n' +
                'Responda *ACORDO* para falar com um de nossos consultores!\n\n' +
                '*Equipe ACERTIVE*'
        };

        return mensagens[tipo] || mensagens.lembrete;
    }

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
    // API: LISTAR CONTATOS DA SURI
    // ═══════════════════════════════════════════════════════════════

    // GET /api/suri/contatos
    router.get('/contatos', auth, async function(req, res) {
        try {
            var response = await fetch(SURI_CONFIG.endpoint + '/api/v1/contacts', {
                method: 'GET',
                headers: getSuriHeaders()
            });

            var data = await response.json();
            res.json({ success: true, data: data });
        } catch (error) {
            console.error('[SURI] Erro ao listar contatos:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // API: BUSCAR CONVERSAS DE UM CONTATO
    // ═══════════════════════════════════════════════════════════════

    // GET /api/suri/conversas/:contactId
    router.get('/conversas/:contactId', auth, async function(req, res) {
        try {
            var contactId = req.params.contactId;
            
            var response = await fetch(SURI_CONFIG.endpoint + '/api/v1/contacts/' + contactId + '/messages', {
                method: 'GET',
                headers: getSuriHeaders()
            });

            var data = await response.json();
            res.json({ success: true, data: data });
        } catch (error) {
            console.error('[SURI] Erro ao buscar conversas:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

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

            // Buscar clientes com cobranças vencidas
            var query = "\n                SELECT \n                    c.id, c.nome, c.telefone, c.celular, c.cpf_cnpj, c.email,\n                    SUM(cob.valor) as valor_total,\n                    COUNT(cob.id) as qtd_cobrancas,\n                    MAX(CURRENT_DATE - cob.data_vencimento) as maior_atraso\n                FROM clientes c\n                JOIN cobrancas cob ON cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')\n                WHERE c.ativo = true \n                  AND (c.telefone IS NOT NULL OR c.celular IS NOT NULL)\n                  AND c.status_cobranca NOT IN ('acordo', 'incobravel', 'juridico')\n                GROUP BY c.id\n                HAVING MAX(CURRENT_DATE - cob.data_vencimento) BETWEEN $1 AND $2\n                ORDER BY MAX(CURRENT_DATE - cob.data_vencimento) DESC\n                LIMIT $3\n            ";

            var result = await pool.query(query, [filtro_atraso_min, filtro_atraso_max, limite]);
            var clientes = result.rows;

            var enviados = 0;
            var erros = [];

            for (var i = 0; i < clientes.length; i++) {
                var cliente = clientes[i];
                try {
                    var telefone = formatarTelefone(cliente.telefone || cliente.celular);
                    if (!telefone) continue;

                    var mensagem = montarMensagemCobranca(
                        cliente, 
                        parseFloat(cliente.valor_total), 
                        parseInt(cliente.qtd_cobrancas), 
                        tipo_mensagem
                    );

                    var contatoSuri = await importarContatoSuri(cliente, telefone);
                    if (contatoSuri && contatoSuri.id) {
                        var resultado = await enviarMensagemSuri(contatoSuri.id, mensagem, 'texto');
                        if (resultado.success) {
                            enviados++;
                            
                            await pool.query(
                                "INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, 'whatsapp', 'suri', 'enviado', $3, NOW())",
                                [cliente.id, req.user.id, 'Disparo em massa: ' + tipo_mensagem]
                            );
                        }
                    }

                    // Delay entre mensagens para não sobrecarregar
                    await new Promise(function(resolve) { setTimeout(resolve, 1000); });
                    
                } catch (err) {
                    erros.push({ cliente_id: cliente.id, erro: err.message });
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
            // Testar conexão com a Suri
            var response = await fetch(SURI_CONFIG.endpoint + '/api/v1/contacts?limit=1', {
                method: 'GET',
                headers: getSuriHeaders()
            });

            var conectado = response.ok;

            // Buscar estatísticas
            var statsResult = await pool.query("\n                SELECT \n                    COUNT(*) FILTER (WHERE tipo = 'whatsapp' AND canal = 'suri' AND DATE(created_at) = CURRENT_DATE) as mensagens_hoje,\n                    COUNT(*) FILTER (WHERE tipo = 'whatsapp' AND canal = 'suri' AND created_at >= NOW() - INTERVAL '7 days') as mensagens_semana,\n                    COUNT(*) FILTER (WHERE tipo = 'whatsapp' AND canal = 'suri') as mensagens_total\n                FROM acionamentos\n            ");

            res.json({
                success: true,
                data: {
                    conectado: conectado,
                    endpoint: SURI_CONFIG.endpoint,
                    identificador: SURI_CONFIG.identificador,
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