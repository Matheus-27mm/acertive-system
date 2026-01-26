/**
 * ========================================
 * ACERTIVE - Módulo de Cobranças
 * routes/cobrancas.js
 * ========================================
 * ATUALIZADO: Suporte a parcelas, categorias, Asaas automático, notificações
 */

const express = require('express');
const XLSX = require('xlsx');

module.exports = function(pool, auth, upload, registrarLog, asaasService = null) {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas - Listar cobranças
    // ═══════════════════════════════════════════════════════════════
    router.get('/', auth, async (req, res) => {
        try {
            const { status, credor_id, empresa_id, cliente_id, categoria, data_inicio, data_fim, busca, page = 1, limit = 50 } = req.query;

            let query = `
                SELECT c.*, 
                       cl.nome as cliente, cl.cpf_cnpj as cliente_documento, cl.telefone as cliente_telefone, cl.email as cliente_email,
                       cr.nome as credor_nome, emp.nome as empresa_nome
                FROM cobrancas c
                LEFT JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN empresas emp ON c.empresa_id = emp.id
                WHERE (c.arquivado = false OR c.arquivado IS NULL)
            `;
            const params = [];
            let idx = 1;

            if (status && status !== 'todos') { query += ` AND c.status = $${idx}`; params.push(status); idx++; }
            if (credor_id) { query += ` AND c.credor_id = $${idx}::uuid`; params.push(credor_id); idx++; }
            if (empresa_id) { query += ` AND c.empresa_id = $${idx}::uuid`; params.push(empresa_id); idx++; }
            if (cliente_id) { query += ` AND c.cliente_id = $${idx}::uuid`; params.push(cliente_id); idx++; }
            if (categoria) { query += ` AND c.categoria = $${idx}`; params.push(categoria); idx++; }
            if (data_inicio) { query += ` AND c.data_vencimento >= $${idx}`; params.push(data_inicio); idx++; }
            if (data_fim) { query += ` AND c.data_vencimento <= $${idx}`; params.push(data_fim); idx++; }
            if (busca) { query += ` AND (cl.nome ILIKE $${idx} OR c.descricao ILIKE $${idx} OR cl.cpf_cnpj ILIKE $${idx} OR c.referencia ILIKE $${idx})`; params.push(`%${busca}%`); idx++; }

            query += ' ORDER BY c.data_vencimento DESC';
            const offset = (parseInt(page) - 1) * parseInt(limit);
            query += ` LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), offset);

            const result = await pool.query(query, params);

            // Contar total
            const countResult = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE arquivado = false OR arquivado IS NULL');
            const total = parseInt(countResult.rows[0].count);

            res.json({ success: true, data: result.rows, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });

        } catch (error) {
            console.error('[COBRANCAS] Erro ao listar:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar cobranças' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas/estatisticas
    // ═══════════════════════════════════════════════════════════════
    router.get('/estatisticas', auth, async (req, res) => {
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
                    COUNT(*) FILTER (WHERE status = 'pago') as pagas,
                    COUNT(*) FILTER (WHERE status = 'vencido' OR (status = 'pendente' AND data_vencimento < CURRENT_DATE)) as vencidas,
                    COUNT(*) FILTER (WHERE data_vencimento = CURRENT_DATE AND status = 'pendente') as vence_hoje,
                    COALESCE(SUM(valor), 0) as valor_total,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pendente'), 0) as valor_pendente,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0) as valor_pago,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pago' AND EXTRACT(MONTH FROM data_pagamento) = EXTRACT(MONTH FROM CURRENT_DATE)), 0) as valor_pago_mes
                FROM cobrancas WHERE arquivado = false OR arquivado IS NULL
            `);
            res.json({ success: true, data: stats.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas/arquivadas
    // ═══════════════════════════════════════════════════════════════
    router.get('/arquivadas', auth, async (req, res) => {
        try {
            const { page = 1, limit = 50 } = req.query;
            const offset = (parseInt(page) - 1) * parseInt(limit);
            
            const result = await pool.query(`
                SELECT c.*, cl.nome as cliente, cr.nome as credor_nome
                FROM cobrancas c LEFT JOIN clientes cl ON c.cliente_id = cl.id LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.arquivado = true ORDER BY c.updated_at DESC LIMIT $1 OFFSET $2
            `, [parseInt(limit), offset]);

            const countResult = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE arquivado = true');
            res.json({ success: true, data: result.rows, total: parseInt(countResult.rows[0].count), page: parseInt(page) });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar arquivadas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas/:id
    // ═══════════════════════════════════════════════════════════════
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            if (['estatisticas', 'arquivadas', 'importar'].includes(id)) return;

            const result = await pool.query(`
                SELECT c.*, cl.nome as cliente_nome, cl.cpf_cnpj as cliente_documento, cl.telefone as cliente_telefone, cl.email as cliente_email, cr.nome as credor_nome
                FROM cobrancas c LEFT JOIN clientes cl ON c.cliente_id = cl.id LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.id = $1::uuid
            `, [id]);

            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar cobrança' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/cobrancas - CRIAR COBRANÇA (ATUALIZADO)
    // ═══════════════════════════════════════════════════════════════
    router.post('/', auth, async (req, res) => {
        try {
            const { 
                cliente_id, 
                credor_id, 
                empresa_id, 
                descricao, 
                valor,              // Pode vir como 'valor' ou 'valor_original'
                valor_original,
                data_vencimento,    // Pode vir como 'data_vencimento' ou 'vencimento'
                vencimento,
                numero_contrato,
                // ═══ NOVOS CAMPOS ═══
                numero_parcelas = 1,
                multa = 2,
                juros = 1,
                categoria = 'outros',
                referencia = null,
                tipo_cobranca = 'boleto',
                gerar_asaas = false,
                notificar_cliente = false,
                canais_notificacao = [],
                observacoes = null,
                correcao = 'nenhuma'
            } = req.body;

            // Normalizar campos (suportar ambos os nomes)
            const valorFinal = parseFloat(valor || valor_original);
            const dataVencFinal = data_vencimento || vencimento;
            const numParcelas = parseInt(numero_parcelas) || 1;

            // Validações
            if (!cliente_id) {
                return res.status(400).json({ success: false, error: 'Cliente é obrigatório' });
            }
            if (!valorFinal || valorFinal <= 0) {
                return res.status(400).json({ success: false, error: 'Valor é obrigatório e deve ser maior que zero' });
            }
            if (!dataVencFinal) {
                return res.status(400).json({ success: false, error: 'Data de vencimento é obrigatória' });
            }

            const cobrancasCriadas = [];
            const valorParcela = valorFinal / numParcelas;
            
            // Buscar dados do cliente (para Asaas e notificações)
            const clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1::uuid', [cliente_id]);
            const cliente = clienteResult.rows[0];
            
            if (!cliente) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            // ═══════════════════════════════════════════════════════════
            // CRIAR COBRANÇAS (uma para cada parcela se parcelado)
            // ═══════════════════════════════════════════════════════════
            for (let i = 0; i < numParcelas; i++) {
                // Calcular vencimento de cada parcela
                const dataVenc = new Date(dataVencFinal);
                dataVenc.setMonth(dataVenc.getMonth() + i);
                
                // Descrição com número da parcela se parcelado
                const descricaoFinal = numParcelas > 1 
                    ? `${descricao} (${i + 1}/${numParcelas})` 
                    : descricao;

                const result = await pool.query(`
                    INSERT INTO cobrancas (
                        cliente_id, credor_id, empresa_id, descricao, 
                        valor, valor_original, valor_atualizado, 
                        vencimento, data_vencimento, numero_contrato,
                        numero_parcela, total_parcelas, 
                        multa, juros, categoria, referencia, 
                        tipo_cobranca, observacoes, correcao,
                        status, created_at
                    ) VALUES (
                        $1::uuid, $2::uuid, $3::uuid, $4, 
                        $5, $5, $5, 
                        $6, $6, $7,
                        $8, $9, 
                        $10, $11, $12, $13, 
                        $14, $15, $16,
                        'pendente', NOW()
                    ) RETURNING *
                `, [
                    cliente_id, 
                    credor_id || null, 
                    empresa_id || null, 
                    descricaoFinal,
                    valorParcela,
                    dataVenc.toISOString().split('T')[0],
                    numero_contrato || referencia || null,
                    i + 1,              // numero_parcela
                    numParcelas,        // total_parcelas
                    multa,
                    juros,
                    categoria,
                    referencia,
                    tipo_cobranca,
                    observacoes,
                    correcao
                ]);
                
                cobrancasCriadas.push(result.rows[0]);
            }

            // ═══════════════════════════════════════════════════════════
            // GERAR NO ASAAS AUTOMATICAMENTE (se marcado)
            // ═══════════════════════════════════════════════════════════
            let asaasUrls = [];
            let asaasErros = [];
            
            if (gerar_asaas && asaasService) {
                for (const cobranca of cobrancasCriadas) {
                    try {
                        // Verificar se cliente tem asaas_id, senão criar
                        let asaasCustomerId = cliente.asaas_id;
                        
                        if (!asaasCustomerId) {
                            // Criar cliente no Asaas
                            const novoCliente = await asaasService.criarCliente({
                                name: cliente.nome,
                                cpfCnpj: cliente.cpf_cnpj?.replace(/\D/g, ''),
                                email: cliente.email,
                                phone: cliente.telefone?.replace(/\D/g, ''),
                                mobilePhone: cliente.telefone?.replace(/\D/g, '')
                            });
                            
                            if (novoCliente && novoCliente.id) {
                                asaasCustomerId = novoCliente.id;
                                // Salvar asaas_id no cliente
                                await pool.query('UPDATE clientes SET asaas_id = $1 WHERE id = $2::uuid', [asaasCustomerId, cliente_id]);
                            }
                        }
                        
                        if (asaasCustomerId) {
                            // Determinar tipo de cobrança no Asaas
                            const billingType = tipo_cobranca === 'pix' ? 'PIX' 
                                              : tipo_cobranca === 'cartao' ? 'CREDIT_CARD' 
                                              : 'BOLETO';
                            
                            // Criar cobrança no Asaas
                            const asaasCobranca = await asaasService.criarCobranca({
                                customer: asaasCustomerId,
                                billingType: billingType,
                                value: cobranca.valor,
                                dueDate: cobranca.data_vencimento,
                                description: cobranca.descricao,
                                externalReference: cobranca.id,
                                fine: { value: multa, type: 'PERCENTAGE' },
                                interest: { value: juros, type: 'PERCENTAGE' }
                            });
                            
                            if (asaasCobranca && asaasCobranca.invoiceUrl) {
                                asaasUrls.push({
                                    cobranca_id: cobranca.id,
                                    url: asaasCobranca.invoiceUrl,
                                    asaas_id: asaasCobranca.id
                                });
                                
                                // Atualizar cobrança com dados do Asaas
                                await pool.query(`
                                    UPDATE cobrancas 
                                    SET asaas_id = $1, asaas_invoice_url = $2, asaas_status = $3
                                    WHERE id = $4::uuid
                                `, [asaasCobranca.id, asaasCobranca.invoiceUrl, asaasCobranca.status, cobranca.id]);
                            }
                        }
                    } catch (asaasError) {
                        console.error('[COBRANCAS] Erro Asaas:', asaasError.message);
                        asaasErros.push({ cobranca_id: cobranca.id, erro: asaasError.message });
                    }
                }
            }

            // ═══════════════════════════════════════════════════════════
            // ENVIAR NOTIFICAÇÃO AO CLIENTE (se marcado)
            // ═══════════════════════════════════════════════════════════
            let notificacoesEnviadas = [];
            
            if (notificar_cliente && canais_notificacao.length > 0) {
                const primeiraCobranca = cobrancasCriadas[0];
                const linkPagamento = asaasUrls.length > 0 ? asaasUrls[0].url : null;
                
                // WhatsApp
                if (canais_notificacao.includes('whatsapp') && cliente.telefone) {
                    try {
                        let telefone = cliente.telefone.replace(/\D/g, '');
                        if (telefone.length <= 11) telefone = '55' + telefone;
                        
                        const valorFormatado = valorFinal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
                        const vencFormatado = new Date(dataVencFinal).toLocaleDateString('pt-BR');
                        
                        let mensagem = `Olá ${cliente.nome}!\n\n`;
                        mensagem += `📄 *Nova Cobrança*\n\n`;
                        mensagem += `📝 ${descricao}\n`;
                        mensagem += `💰 Valor: *${valorFormatado}*\n`;
                        if (numParcelas > 1) {
                            mensagem += `📊 Parcelas: ${numParcelas}x de ${(valorFinal/numParcelas).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}\n`;
                        }
                        mensagem += `📅 Vencimento: ${vencFormatado}\n`;
                        
                        if (linkPagamento) {
                            mensagem += `\n🔗 *Link para pagamento:*\n${linkPagamento}`;
                        }
                        
                        mensagem += `\n\n_ACERTIVE Cobranças_`;
                        
                        const whatsappLink = `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;
                        
                        notificacoesEnviadas.push({
                            canal: 'whatsapp',
                            status: 'link_gerado',
                            link: whatsappLink
                        });
                    } catch (whatsappError) {
                        console.error('[COBRANCAS] Erro WhatsApp:', whatsappError);
                    }
                }
                
                // Email (placeholder - implementar com nodemailer ou serviço de email)
                if (canais_notificacao.includes('email') && cliente.email) {
                    notificacoesEnviadas.push({
                        canal: 'email',
                        status: 'pendente',
                        message: 'Envio de email a ser implementado'
                    });
                }
                
                // SMS (placeholder - implementar com Twilio ou outro serviço)
                if (canais_notificacao.includes('sms') && cliente.telefone) {
                    notificacoesEnviadas.push({
                        canal: 'sms',
                        status: 'pendente',
                        message: 'Envio de SMS a ser implementado'
                    });
                }
            }

            // Registrar log
            await registrarLog(req.user?.id, 'COBRANCA_CRIADA', 'cobrancas', cobrancasCriadas[0].id, { 
                valor: valorFinal, 
                descricao,
                parcelas: numParcelas,
                gerar_asaas,
                notificar_cliente
            });

            // ═══════════════════════════════════════════════════════════
            // RESPOSTA
            // ═══════════════════════════════════════════════════════════
            res.status(201).json({ 
                success: true, 
                message: numParcelas > 1 
                    ? `${numParcelas} cobranças criadas com sucesso!` 
                    : 'Cobrança criada com sucesso!',
                data: cobrancasCriadas,
                parcelas_criadas: cobrancasCriadas.length,
                // Dados do Asaas
                asaas_gerado: asaasUrls.length > 0,
                asaas_urls: asaasUrls,
                asaas_url: asaasUrls.length > 0 ? asaasUrls[0].url : null,
                asaas_erros: asaasErros,
                // Dados de notificação
                notificacoes: notificacoesEnviadas,
                whatsapp_link: notificacoesEnviadas.find(n => n.canal === 'whatsapp')?.link || null
            });

        } catch (error) {
            console.error('[COBRANCAS] Erro ao criar:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar cobrança: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/cobrancas/:id - Atualizar cobrança
    // ═══════════════════════════════════════════════════════════════
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { 
                cliente_id, credor_id, descricao, valor, data_vencimento, 
                numero_contrato, observacoes, status,
                // Novos campos
                categoria, referencia, tipo_cobranca, multa, juros, correcao
            } = req.body;

            let updates = ['updated_at = NOW()'];
            let params = [id];
            let idx = 2;

            if (cliente_id !== undefined) { updates.push(`cliente_id = $${idx}::uuid`); params.push(cliente_id); idx++; }
            if (credor_id !== undefined) { updates.push(`credor_id = $${idx}::uuid`); params.push(credor_id); idx++; }
            if (descricao !== undefined) { updates.push(`descricao = $${idx}`); params.push(descricao); idx++; }
            if (valor !== undefined) { updates.push(`valor = $${idx}`); params.push(parseFloat(valor)); idx++; }
            if (data_vencimento !== undefined) { updates.push(`data_vencimento = $${idx}`); params.push(data_vencimento); idx++; }
            if (numero_contrato !== undefined) { updates.push(`numero_contrato = $${idx}`); params.push(numero_contrato); idx++; }
            if (observacoes !== undefined) { updates.push(`observacoes = $${idx}`); params.push(observacoes); idx++; }
            if (status !== undefined) { updates.push(`status = $${idx}`); params.push(status); idx++; }
            // Novos campos
            if (categoria !== undefined) { updates.push(`categoria = $${idx}`); params.push(categoria); idx++; }
            if (referencia !== undefined) { updates.push(`referencia = $${idx}`); params.push(referencia); idx++; }
            if (tipo_cobranca !== undefined) { updates.push(`tipo_cobranca = $${idx}`); params.push(tipo_cobranca); idx++; }
            if (multa !== undefined) { updates.push(`multa = $${idx}`); params.push(multa); idx++; }
            if (juros !== undefined) { updates.push(`juros = $${idx}`); params.push(juros); idx++; }
            if (correcao !== undefined) { updates.push(`correcao = $${idx}`); params.push(correcao); idx++; }

            const result = await pool.query(`UPDATE cobrancas SET ${updates.join(', ')} WHERE id = $1::uuid RETURNING *`, params);
            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            await registrarLog(req.user?.id, 'COBRANCA_ATUALIZADA', 'cobrancas', id, {});
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao atualizar cobrança' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/cobrancas/:id/status
    // ═══════════════════════════════════════════════════════════════
    router.put('/:id/status', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { status, data_pagamento } = req.body;

            let query = 'UPDATE cobrancas SET status = $2, updated_at = NOW()';
            const params = [id, status];

            if (status === 'pago') {
                query += data_pagamento ? ', data_pagamento = $3' : ', data_pagamento = NOW()';
                if (data_pagamento) params.push(data_pagamento);
            }
            query += ' WHERE id = $1::uuid RETURNING *';

            const result = await pool.query(query, params);
            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            await registrarLog(req.user?.id, 'COBRANCA_STATUS', 'cobrancas', id, { status });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao atualizar status' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/cobrancas/:id/gerar-asaas - Gerar cobrança no Asaas
    // ═══════════════════════════════════════════════════════════════
    router.post('/:id/gerar-asaas', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { tipo_cobranca = 'boleto' } = req.body;

            // Buscar cobrança
            const cobrancaResult = await pool.query(`
                SELECT c.*, cl.nome as cliente_nome, cl.cpf_cnpj as cliente_cpf, 
                       cl.email as cliente_email, cl.telefone as cliente_telefone, cl.asaas_id as cliente_asaas_id
                FROM cobrancas c 
                LEFT JOIN clientes cl ON c.cliente_id = cl.id
                WHERE c.id = $1::uuid
            `, [id]);

            if (cobrancaResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });
            }

            const cobranca = cobrancaResult.rows[0];

            if (cobranca.asaas_id) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Cobrança já possui registro no Asaas',
                    asaas_url: cobranca.asaas_invoice_url
                });
            }

            if (!asaasService) {
                return res.status(500).json({ success: false, error: 'Serviço Asaas não configurado' });
            }

            // Criar/verificar cliente no Asaas
            let asaasCustomerId = cobranca.cliente_asaas_id;
            
            if (!asaasCustomerId) {
                const novoCliente = await asaasService.criarCliente({
                    name: cobranca.cliente_nome,
                    cpfCnpj: cobranca.cliente_cpf?.replace(/\D/g, ''),
                    email: cobranca.cliente_email,
                    phone: cobranca.cliente_telefone?.replace(/\D/g, ''),
                    mobilePhone: cobranca.cliente_telefone?.replace(/\D/g, '')
                });
                
                if (novoCliente && novoCliente.id) {
                    asaasCustomerId = novoCliente.id;
                    await pool.query('UPDATE clientes SET asaas_id = $1 WHERE id = $2::uuid', [asaasCustomerId, cobranca.cliente_id]);
                }
            }

            if (!asaasCustomerId) {
                return res.status(400).json({ success: false, error: 'Não foi possível criar cliente no Asaas' });
            }

            // Determinar tipo de cobrança
            const billingType = tipo_cobranca === 'pix' ? 'PIX' 
                              : tipo_cobranca === 'cartao' ? 'CREDIT_CARD' 
                              : 'BOLETO';

            // Criar cobrança no Asaas
            const asaasCobranca = await asaasService.criarCobranca({
                customer: asaasCustomerId,
                billingType: billingType,
                value: cobranca.valor,
                dueDate: cobranca.data_vencimento,
                description: cobranca.descricao,
                externalReference: cobranca.id,
                fine: { value: cobranca.multa || 2, type: 'PERCENTAGE' },
                interest: { value: cobranca.juros || 1, type: 'PERCENTAGE' }
            });

            if (!asaasCobranca || !asaasCobranca.invoiceUrl) {
                return res.status(500).json({ success: false, error: 'Erro ao gerar cobrança no Asaas' });
            }

            // Atualizar cobrança
            await pool.query(`
                UPDATE cobrancas 
                SET asaas_id = $1, asaas_invoice_url = $2, asaas_status = $3, tipo_cobranca = $4, updated_at = NOW()
                WHERE id = $5::uuid
            `, [asaasCobranca.id, asaasCobranca.invoiceUrl, asaasCobranca.status, tipo_cobranca, id]);

            await registrarLog(req.user?.id, 'COBRANCA_ASAAS_GERADA', 'cobrancas', id, { asaas_id: asaasCobranca.id });

            res.json({ 
                success: true, 
                message: 'Cobrança gerada no Asaas!',
                asaas_id: asaasCobranca.id,
                invoiceUrl: asaasCobranca.invoiceUrl,
                bankSlipUrl: asaasCobranca.bankSlipUrl,
                pixQrCode: asaasCobranca.pixQrCode
            });

        } catch (error) {
            console.error('[COBRANCAS] Erro ao gerar Asaas:', error);
            res.status(500).json({ success: false, error: 'Erro ao gerar cobrança no Asaas: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/cobrancas/arquivar-massa
    // ═══════════════════════════════════════════════════════════════
    router.post('/arquivar-massa', auth, async (req, res) => {
        try {
            const { ids } = req.body;
            if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: 'IDs são obrigatórios' });

            const result = await pool.query('UPDATE cobrancas SET arquivado = true, updated_at = NOW() WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);
            res.json({ success: true, message: `${result.rowCount} arquivada(s)`, arquivadas: result.rowCount });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao arquivar' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/cobrancas/desarquivar-massa
    // ═══════════════════════════════════════════════════════════════
    router.post('/desarquivar-massa', auth, async (req, res) => {
        try {
            const { ids } = req.body;
            if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: 'IDs são obrigatórios' });

            const result = await pool.query('UPDATE cobrancas SET arquivado = false, updated_at = NOW() WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);
            res.json({ success: true, message: `${result.rowCount} desarquivada(s)`, desarquivadas: result.rowCount });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao desarquivar' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/cobrancas/marcar-pagas
    // ═══════════════════════════════════════════════════════════════
    router.post('/marcar-pagas', auth, async (req, res) => {
        try {
            const { ids } = req.body;
            if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: 'IDs são obrigatórios' });

            const result = await pool.query('UPDATE cobrancas SET status = \'pago\', data_pagamento = NOW(), updated_at = NOW() WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);
            await registrarLog(req.user?.id, 'COBRANCAS_MARCADAS_PAGAS', 'cobrancas', null, { quantidade: result.rowCount });
            res.json({ success: true, message: `${result.rowCount} marcada(s) como paga(s)` });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao marcar pagas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DELETE /api/cobrancas/:id
    // ═══════════════════════════════════════════════════════════════
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('DELETE FROM cobrancas WHERE id = $1::uuid RETURNING id', [id]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            await registrarLog(req.user?.id, 'COBRANCA_REMOVIDA', 'cobrancas', id, {});
            res.json({ success: true, message: 'Cobrança removida' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao remover' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas/:id/whatsapp
    // ═══════════════════════════════════════════════════════════════
    router.get('/:id/whatsapp', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query(`
                SELECT c.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone, cr.nome as credor_nome
                FROM cobrancas c LEFT JOIN clientes cl ON c.cliente_id = cl.id LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.id = $1::uuid
            `, [id]);

            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            const cob = result.rows[0];
            if (!cob.cliente_telefone) return res.status(400).json({ success: false, error: 'Cliente sem telefone' });

            let telefone = cob.cliente_telefone.replace(/\D/g, '');
            if (telefone.length <= 11) telefone = '55' + telefone;

            const valor = parseFloat(cob.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const vencimento = new Date(cob.data_vencimento).toLocaleDateString('pt-BR');

            let mensagem = `Olá ${cob.cliente_nome}!\n\nIdentificamos uma pendência:\n\n`;
            if (cob.credor_nome) mensagem += `📋 *Credor:* ${cob.credor_nome}\n`;
            mensagem += `📝 *Descrição:* ${cob.descricao}\n`;
            mensagem += `💰 *Valor:* ${valor}\n`;
            mensagem += `📅 *Vencimento:* ${vencimento}\n`;
            
            if (cob.asaas_invoice_url) {
                mensagem += `\n🔗 *Link para pagamento:*\n${cob.asaas_invoice_url}\n`;
            }
            
            mensagem += `\nEntre em contato para regularizar!\n\n_ACERTIVE_`;

            res.json({ success: true, link: `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`, telefone, mensagem });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar link' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // IMPORTAÇÃO
    // ═══════════════════════════════════════════════════════════════

    // POST /api/cobrancas/importar/clientes
    router.post('/importar/clientes', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo é obrigatório' });

            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

            if (data.length === 0) return res.status(400).json({ success: false, error: 'Arquivo vazio' });

            let importados = 0, erros = [];

            for (const row of data) {
                try {
                    const nome = row.nome || row.Nome || row.cliente || row.Cliente;
                    const cpfCnpj = row.cpf_cnpj || row.cpf || row.cnpj || row.documento;
                    const telefone = row.telefone || row.Telefone;
                    const email = row.email || row.Email;

                    if (!nome) { erros.push({ linha: importados + 2, erro: 'Nome não encontrado' }); continue; }

                    if (cpfCnpj) {
                        const existe = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpfCnpj]);
                        if (existe.rows.length > 0) { erros.push({ linha: importados + 2, erro: `CPF/CNPJ já existe` }); continue; }
                    }

                    await pool.query('INSERT INTO clientes (nome, cpf_cnpj, telefone, email, status, created_at) VALUES ($1, $2, $3, $4, \'ativo\', NOW())', [nome, cpfCnpj, telefone, email]);
                    importados++;
                } catch (err) { erros.push({ linha: importados + 2, erro: err.message }); }
            }

            await registrarLog(req.user?.id, 'IMPORTACAO_CLIENTES', 'clientes', null, { total: data.length, importados });
            res.json({ success: true, total: data.length, importados, erros });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao importar' });
        }
    });

    // POST /api/cobrancas/importar/cobrancas
    router.post('/importar/cobrancas', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo é obrigatório' });

            const { credor_id } = req.body;
            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

            if (data.length === 0) return res.status(400).json({ success: false, error: 'Arquivo vazio' });

            let importados = 0, clientesCriados = 0, erros = [];

            for (let i = 0; i < data.length; i++) {
                const row = data[i];
                try {
                    const clienteNome = row.cliente || row.Cliente || row.nome || row.Nome;
                    const cpfCnpj = row.cpf_cnpj || row.cpf || row.cnpj;
                    const telefone = row.telefone || row.Telefone;
                    const email = row.email || row.Email;
                    const descricao = row.descricao || row.Descricao || 'Importado';
                    const valor = row.valor || row.Valor || 0;
                    const vencimento = row.vencimento || row.Vencimento || row.data_vencimento;
                    const categoria = row.categoria || row.Categoria || 'outros';
                    const referencia = row.referencia || row.Referencia || row.contrato;

                    if (!clienteNome) { erros.push({ linha: i + 2, erro: 'Nome não encontrado' }); continue; }
                    if (!valor || parseFloat(valor) <= 0) { erros.push({ linha: i + 2, erro: 'Valor inválido' }); continue; }

                    let clienteId;
                    if (cpfCnpj) {
                        const existe = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpfCnpj]);
                        if (existe.rows.length > 0) clienteId = existe.rows[0].id;
                    }

                    if (!clienteId) {
                        const porNome = await pool.query('SELECT id FROM clientes WHERE nome ILIKE $1', [clienteNome]);
                        if (porNome.rows.length > 0) {
                            clienteId = porNome.rows[0].id;
                        } else {
                            const novo = await pool.query('INSERT INTO clientes (nome, cpf_cnpj, telefone, email, status, created_at) VALUES ($1, $2, $3, $4, \'ativo\', NOW()) RETURNING id', [clienteNome, cpfCnpj, telefone, email]);
                            clienteId = novo.rows[0].id;
                            clientesCriados++;
                        }
                    }

                    let dataVenc = new Date();
                    if (vencimento) {
                        dataVenc = typeof vencimento === 'number' ? new Date(new Date(1899, 11, 30).getTime() + vencimento * 86400000) : new Date(vencimento);
                    }

                    await pool.query(`
                        INSERT INTO cobrancas (cliente_id, credor_id, descricao, valor, valor_original, vencimento, data_vencimento, categoria, referencia, status, created_at) 
                        VALUES ($1, $2, $3, $4, $4, $5, $5, $6, $7, 'pendente', NOW())
                    `, [clienteId, credor_id || null, descricao, parseFloat(valor), dataVenc, categoria, referencia]);
                    importados++;
                } catch (err) { erros.push({ linha: i + 2, erro: err.message }); }
            }

            await registrarLog(req.user?.id, 'IMPORTACAO_COBRANCAS', 'cobrancas', null, { total: data.length, importados, clientesCriados });
            res.json({ success: true, total: data.length, importados, clientes_criados: clientesCriados, erros });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao importar' });
        }
    });

    // POST /api/cobrancas/importar/massa
    router.post('/importar/massa', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo é obrigatório' });

            const { credor_id } = req.body;
            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

            if (data.length === 0) return res.status(400).json({ success: false, error: 'Arquivo vazio' });

            const resultado = { total: data.length, clientes_criados: 0, clientes_atualizados: 0, cobrancas_criadas: 0, erros: [] };

            for (let i = 0; i < data.length; i++) {
                const row = data[i];
                try {
                    const clienteNome = row.cliente || row.Cliente || row.nome || row.Nome;
                    const cpfCnpj = row.cpf_cnpj || row.cpf || row.cnpj;
                    const telefone = row.telefone || row.Telefone;
                    const email = row.email || row.Email;
                    const endereco = row.endereco || row.Endereco;
                    const descricao = row.descricao || row.Descricao || 'Importado';
                    const valor = row.valor || row.Valor || 0;
                    const vencimento = row.vencimento || row.Vencimento;
                    const contrato = row.contrato || row.Contrato;
                    const categoria = row.categoria || row.Categoria || 'outros';

                    if (!clienteNome) { resultado.erros.push({ linha: i + 2, erro: 'Nome não encontrado' }); continue; }

                    let clienteId;
                    if (cpfCnpj) {
                        const busca = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpfCnpj]);
                        if (busca.rows.length > 0) {
                            clienteId = busca.rows[0].id;
                            await pool.query('UPDATE clientes SET telefone = COALESCE($2, telefone), email = COALESCE($3, email), endereco = COALESCE($4, endereco), updated_at = NOW() WHERE id = $1', [clienteId, telefone, email, endereco]);
                            resultado.clientes_atualizados++;
                        }
                    }

                    if (!clienteId) {
                        const novo = await pool.query('INSERT INTO clientes (nome, cpf_cnpj, telefone, email, endereco, status, created_at) VALUES ($1, $2, $3, $4, $5, \'ativo\', NOW()) RETURNING id', [clienteNome, cpfCnpj, telefone, email, endereco]);
                        clienteId = novo.rows[0].id;
                        resultado.clientes_criados++;
                    }

                    if (valor && parseFloat(valor) > 0) {
                        let dataVenc = new Date();
                        if (vencimento) {
                            dataVenc = typeof vencimento === 'number' ? new Date(new Date(1899, 11, 30).getTime() + vencimento * 86400000) : new Date(vencimento);
                        }

                        await pool.query(`
                            INSERT INTO cobrancas (cliente_id, credor_id, descricao, valor, valor_original, vencimento, data_vencimento, numero_contrato, categoria, status, created_at) 
                            VALUES ($1, $2, $3, $4, $4, $5, $5, $6, $7, 'pendente', NOW())
                        `, [clienteId, credor_id || null, descricao, parseFloat(valor), dataVenc, contrato, categoria]);
                        resultado.cobrancas_criadas++;
                    }
                } catch (err) { resultado.erros.push({ linha: i + 2, erro: err.message }); }
            }

            await registrarLog(req.user?.id, 'IMPORTACAO_MASSA', 'cobrancas', null, resultado);
            res.json({ success: true, ...resultado });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao importar' });
        }
    });

    // GET /api/cobrancas/importar/template/:tipo
    router.get('/importar/template/:tipo', auth, async (req, res) => {
        try {
            const { tipo } = req.params;
            let dados = [], nomeArquivo = 'template.xlsx';

            if (tipo === 'clientes') {
                dados = [{ nome: 'João Silva', cpf_cnpj: '12345678901', telefone: '92999999999', email: 'joao@email.com' }];
                nomeArquivo = 'template_clientes.xlsx';
            } else if (tipo === 'cobrancas') {
                dados = [{ cliente: 'João Silva', cpf_cnpj: '12345678901', descricao: 'Mensalidade', valor: 150.00, vencimento: '2025-01-15', categoria: 'mensalidade', referencia: 'CONT-001' }];
                nomeArquivo = 'template_cobrancas.xlsx';
            } else {
                return res.status(400).json({ success: false, error: 'Tipo inválido' });
            }

            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(dados), 'Dados');
            const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=${nomeArquivo}`);
            res.send(buffer);
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar template' });
        }
    });

    return router;
};