/**
 * ========================================
 * ROTAS ASAAS - ACERTIVE
 * Integração com plataforma de pagamentos Asaas
 * ATUALIZADO: Adicionada rota /status
 * ========================================
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // Configuração dinâmica baseada no ambiente
    const ASAAS_ENV = process.env.ASAAS_ENV || 'sandbox';
    const ASAAS_API_URL = ASAAS_ENV === 'production' 
        ? 'https://www.asaas.com/api/v3'
        : 'https://sandbox.asaas.com/api/v3';
    const ASAAS_API_KEY = ASAAS_ENV === 'production'
        ? process.env.ASAAS_API_KEY
        : (process.env.ASAAS_API_KEY_SANDBOX || process.env.ASAAS_API_KEY);

    console.log(`[ASAAS] Ambiente: ${ASAAS_ENV}, URL: ${ASAAS_API_URL}`);

    // Função para fazer requisições à API do Asaas
    async function asaasRequest(endpoint, method = 'GET', body = null) {
        if (!ASAAS_API_KEY) {
            throw new Error('ASAAS_API_KEY não configurada');
        }

        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'access_token': ASAAS_API_KEY
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(`${ASAAS_API_URL}${endpoint}`, options);
        return response.json();
    }

    // =====================================================
    // GET /api/asaas/status - Verificar status da conexão
    // =====================================================
    router.get('/status', auth, async (req, res) => {
        try {
            console.log('[ASAAS] Verificando status da conexão...');

            if (!ASAAS_API_KEY) {
                return res.json({
                    success: false,
                    conectado: false,
                    erro: 'API Key não configurada',
                    ambiente: ASAAS_ENV
                });
            }

            // Testar conexão buscando saldo da conta
            const resultado = await asaasRequest('/finance/balance');

            if (resultado.balance !== undefined) {
                console.log('[ASAAS] Conexão OK, saldo:', resultado.balance);
                return res.json({
                    success: true,
                    conectado: true,
                    ambiente: ASAAS_ENV,
                    saldo: resultado.balance
                });
            } else if (resultado.errors) {
                console.log('[ASAAS] Erro na API:', resultado.errors);
                return res.json({
                    success: false,
                    conectado: false,
                    erro: resultado.errors[0]?.description || 'Erro na API',
                    ambiente: ASAAS_ENV
                });
            } else {
                return res.json({
                    success: true,
                    conectado: true,
                    ambiente: ASAAS_ENV,
                    saldo: 0
                });
            }

        } catch (error) {
            console.error('[ASAAS] Erro ao verificar status:', error);
            res.json({
                success: false,
                conectado: false,
                erro: error.message,
                ambiente: ASAAS_ENV
            });
        }
    });

    // =====================================================
    // GET /api/asaas/config - Retornar configuração atual
    // =====================================================
    router.get('/config', auth, async (req, res) => {
        res.json({
            success: true,
            ambiente: ASAAS_ENV,
            api_url: ASAAS_API_URL,
            api_key_configurada: !!ASAAS_API_KEY
        });
    });

    // =====================================================
    // POST /api/asaas/webhook - Webhook para eventos
    // =====================================================
    router.post('/webhook', async (req, res) => {
        try {
            const { event, payment } = req.body;

            console.log('[ASAAS] Webhook recebido:', event, payment?.id);

            // Registrar webhook
            try {
                await pool.query(`
                    INSERT INTO asaas_webhooks_log (event, payment_id, payload, created_at)
                    VALUES ($1, $2, $3, NOW())
                `, [event, payment?.id, JSON.stringify(req.body)]);
            } catch (logErr) {
                console.error('[ASAAS] Erro ao registrar webhook:', logErr);
            }

            if (!payment) {
                return res.json({ received: true });
            }

            // Mapear status
            const statusMap = {
                'PAYMENT_CONFIRMED': 'pago',
                'PAYMENT_RECEIVED': 'pago',
                'PAYMENT_OVERDUE': 'vencido',
                'PAYMENT_DELETED': 'cancelado',
                'PAYMENT_REFUNDED': 'cancelado'
            };

            const novoStatus = statusMap[event];
            if (!novoStatus) {
                return res.json({ received: true });
            }

            // Atualizar cobrança
            const cobrancaResult = await pool.query(`
                SELECT * FROM cobrancas WHERE asaas_id = $1
            `, [payment.id]);

            if (cobrancaResult.rows.length > 0) {
                const cobranca = cobrancaResult.rows[0];

                await pool.query(`
                    UPDATE cobrancas 
                    SET status = $1,
                        valor_pago = CASE WHEN $1 = 'pago' THEN $2 ELSE valor_pago END,
                        data_pagamento = CASE WHEN $1 = 'pago' THEN NOW() ELSE data_pagamento END,
                        asaas_sync_at = NOW(),
                        updated_at = NOW()
                    WHERE id = $3
                `, [novoStatus, payment.value, cobranca.id]);

                console.log(`[ASAAS] Cobrança ${cobranca.id} atualizada para ${novoStatus}`);

                // Registrar log
                try {
                    await registrarLog(null, `ASAAS_${event}`, 'cobrancas', cobranca.id, {
                        asaas_id: payment.id,
                        valor: payment.value,
                        status: novoStatus
                    });
                } catch (e) {}
            }

            // Verificar parcelas também
            const parcelaResult = await pool.query(`
                SELECT p.*, a.cliente_id, a.credor_id
                FROM parcelas p
                JOIN acordos a ON p.acordo_id = a.id
                WHERE p.asaas_payment_id = $1
            `, [payment.id]);

            if (parcelaResult.rows.length > 0) {
                const parcela = parcelaResult.rows[0];

                await pool.query(`
                    UPDATE parcelas 
                    SET status = $1,
                        data_pagamento = CASE WHEN $1 = 'pago' THEN NOW() ELSE data_pagamento END
                    WHERE id = $2
                `, [novoStatus, parcela.id]);

                console.log(`[ASAAS] Parcela ${parcela.id} atualizada para ${novoStatus}`);

                // Verificar se acordo foi quitado
                if (novoStatus === 'pago') {
                    const pendentes = await pool.query(`
                        SELECT COUNT(*) FROM parcelas 
                        WHERE acordo_id = $1 AND status != 'pago'
                    `, [parcela.acordo_id]);

                    if (parseInt(pendentes.rows[0].count) === 0) {
                        await pool.query(`
                            UPDATE acordos SET status = 'quitado', updated_at = NOW() WHERE id = $1
                        `, [parcela.acordo_id]);
                        console.log(`[ASAAS] Acordo ${parcela.acordo_id} quitado!`);
                    }
                }
            }

            res.json({ received: true });

        } catch (error) {
            console.error('[ASAAS] Erro no webhook:', error);
            res.status(500).json({ error: 'Erro ao processar webhook' });
        }
    });

    // =====================================================
    // POST /api/asaas/criar-cobranca - Criar cobrança
    // =====================================================
    router.post('/criar-cobranca', auth, async (req, res) => {
        try {
            const { cliente_id, valor, vencimento, descricao, tipo = 'BOLETO' } = req.body;

            // Buscar cliente
            const cliente = await pool.query(`
                SELECT * FROM clientes WHERE id = $1
            `, [cliente_id]);

            if (cliente.rows.length === 0) {
                return res.status(404).json({ error: 'Cliente não encontrado' });
            }

            const cli = cliente.rows[0];

            // Verificar se cliente tem asaas_customer_id
            let customerId = cli.asaas_customer_id;

            if (!customerId) {
                // Criar cliente no Asaas
                const novoCliente = await asaasRequest('/customers', 'POST', {
                    name: cli.nome,
                    cpfCnpj: cli.cpf_cnpj?.replace(/\D/g, ''),
                    email: cli.email,
                    phone: cli.telefone?.replace(/\D/g, ''),
                    mobilePhone: cli.celular?.replace(/\D/g, '') || cli.telefone?.replace(/\D/g, '')
                });

                if (novoCliente.id) {
                    customerId = novoCliente.id;
                    await pool.query(`
                        UPDATE clientes SET asaas_customer_id = $1, asaas_sync_at = NOW() WHERE id = $2
                    `, [customerId, cliente_id]);
                } else {
                    return res.status(400).json({ error: 'Erro ao criar cliente no Asaas', details: novoCliente });
                }
            }

            // Criar cobrança
            const cobranca = await asaasRequest('/payments', 'POST', {
                customer: customerId,
                billingType: tipo,
                value: parseFloat(valor),
                dueDate: vencimento,
                description: descricao,
                externalReference: `ACERTIVE_${Date.now()}`
            });

            if (cobranca.id) {
                res.json({
                    success: true,
                    asaas_id: cobranca.id,
                    bankSlipUrl: cobranca.bankSlipUrl,
                    invoiceUrl: cobranca.invoiceUrl,
                    pixQrCode: cobranca.pixQrCodeUrl,
                    pixPayload: cobranca.pixTransaction?.payload
                });
            } else {
                res.status(400).json({ error: 'Erro ao criar cobrança', details: cobranca });
            }

        } catch (error) {
            console.error('[ASAAS] Erro ao criar cobrança:', error);
            res.status(500).json({ error: 'Erro ao criar cobrança' });
        }
    });

    // =====================================================
    // POST /api/asaas/criar-parcelas/:acordoId
    // =====================================================
    router.post('/criar-parcelas/:acordoId', auth, async (req, res) => {
        try {
            const { acordoId } = req.params;
            const { tipo = 'BOLETO' } = req.body;

            // Buscar acordo com cliente
            const acordo = await pool.query(`
                SELECT a.*, cl.nome as cliente_nome, cl.cpf_cnpj, cl.email, cl.telefone, cl.asaas_customer_id
                FROM acordos a
                JOIN clientes cl ON a.cliente_id = cl.id
                WHERE a.id = $1
            `, [acordoId]);

            if (acordo.rows.length === 0) {
                return res.status(404).json({ error: 'Acordo não encontrado' });
            }

            const ac = acordo.rows[0];
            let customerId = ac.asaas_customer_id;

            if (!customerId) {
                const novoCliente = await asaasRequest('/customers', 'POST', {
                    name: ac.cliente_nome,
                    cpfCnpj: ac.cpf_cnpj?.replace(/\D/g, ''),
                    email: ac.email,
                    phone: ac.telefone?.replace(/\D/g, '')
                });

                if (novoCliente.id) {
                    customerId = novoCliente.id;
                    await pool.query(`
                        UPDATE clientes SET asaas_customer_id = $1 WHERE id = $2
                    `, [customerId, ac.cliente_id]);
                }
            }

            // Buscar parcelas
            const parcelas = await pool.query(`
                SELECT * FROM parcelas WHERE acordo_id = $1 ORDER BY numero
            `, [acordoId]);

            const resultados = [];

            for (const parcela of parcelas.rows) {
                const cobranca = await asaasRequest('/payments', 'POST', {
                    customer: customerId,
                    billingType: tipo,
                    value: parseFloat(parcela.valor),
                    dueDate: parcela.data_vencimento.toISOString().split('T')[0],
                    description: `Parcela ${parcela.numero} - Acordo #${acordoId}`,
                    externalReference: `ACORDO_${acordoId}_PARCELA_${parcela.id}`
                });

                if (cobranca.id) {
                    await pool.query(`
                        UPDATE parcelas 
                        SET asaas_payment_id = $1,
                            link_boleto = $2,
                            link_pix = $3
                        WHERE id = $4
                    `, [cobranca.id, cobranca.bankSlipUrl, cobranca.pixQrCodeUrl, parcela.id]);

                    resultados.push({
                        parcela: parcela.numero,
                        asaas_id: cobranca.id,
                        boleto: cobranca.bankSlipUrl,
                        pix: cobranca.pixQrCodeUrl
                    });
                }
            }

            res.json({
                success: true,
                parcelas_criadas: resultados.length,
                detalhes: resultados
            });

        } catch (error) {
            console.error('[ASAAS] Erro ao criar parcelas:', error);
            res.status(500).json({ error: 'Erro ao criar parcelas' });
        }
    });

    // =====================================================
    // GET /api/asaas/payment/:paymentId - Status pagamento
    // =====================================================
    router.get('/payment/:paymentId', auth, async (req, res) => {
        try {
            const { paymentId } = req.params;
            const payment = await asaasRequest(`/payments/${paymentId}`);
            res.json(payment);
        } catch (error) {
            console.error('[ASAAS] Erro ao verificar status:', error);
            res.status(500).json({ error: 'Erro ao verificar status' });
        }
    });

    // Alias para compatibilidade
    router.get('/status/:paymentId', auth, async (req, res) => {
        try {
            const { paymentId } = req.params;
            const payment = await asaasRequest(`/payments/${paymentId}`);
            res.json(payment);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao verificar status' });
        }
    });

    return router;
};