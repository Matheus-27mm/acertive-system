/**
 * ROTAS ASAAS - ACERTIVE
 * Integração com plataforma de pagamentos Asaas
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    const ASAAS_API_URL = process.env.ASAAS_API_URL || 'https://www.asaas.com/api/v3';
    const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

    // Função para fazer requisições à API do Asaas
    async function asaasRequest(endpoint, method = 'GET', body = null) {
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

    // POST /api/asaas/webhook - Webhook para receber eventos do Asaas
    router.post('/webhook', async (req, res) => {
        try {
            const { event, payment } = req.body;

            console.log('Webhook Asaas recebido:', event, payment?.id);

            if (!payment) {
                return res.json({ received: true });
            }

            // Buscar parcela pelo payment_id do Asaas
            const parcelaResult = await pool.query(`
                SELECT p.*, a.cliente_id, a.credor_id
                FROM parcelas p
                JOIN acordos a ON p.acordo_id = a.id
                WHERE p.asaas_payment_id = $1
            `, [payment.id]);

            // Se não encontrou parcela, tentar buscar cobrança
            if (parcelaResult.rows.length === 0) {
                const cobrancaResult = await pool.query(`
                    SELECT * FROM cobrancas WHERE asaas_payment_id = $1
                `, [payment.id]);

                if (cobrancaResult.rows.length > 0) {
                    const cobranca = cobrancaResult.rows[0];

                    // Processar evento de cobrança
                    if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
                        await pool.query(`
                            UPDATE cobrancas 
                            SET status = 'pago',
                                data_pagamento = NOW(),
                                observacoes = COALESCE(observacoes, '') || E'\n[ASAAS] Pagamento confirmado em ' || NOW()
                            WHERE id = $1
                        `, [cobranca.id]);

                        await registrarLog(null, 'ASAAS_PAGAMENTO_COBRANCA', 'cobrancas', cobranca.id, {
                            asaas_id: payment.id,
                            valor: payment.value
                        });
                    }
                }

                return res.json({ received: true });
            }

            const parcela = parcelaResult.rows[0];

            // Processar eventos de parcela
            switch (event) {
                case 'PAYMENT_CONFIRMED':
                case 'PAYMENT_RECEIVED':
                    // Marcar parcela como paga
                    await pool.query(`
                        UPDATE parcelas 
                        SET status = 'pago',
                            data_pagamento = NOW()
                        WHERE id = $1
                    `, [parcela.id]);

                    // Verificar se todas as parcelas foram pagas
                    const parcelasPendentes = await pool.query(`
                        SELECT COUNT(*) FROM parcelas 
                        WHERE acordo_id = $1 AND status != 'pago'
                    `, [parcela.acordo_id]);

                    if (parseInt(parcelasPendentes.rows[0].count) === 0) {
                        // Todas pagas, atualizar acordo
                        await pool.query(`
                            UPDATE acordos SET status = 'quitado' WHERE id = $1
                        `, [parcela.acordo_id]);
                    }

                    // Registrar comissão se configurado
                    await calcularComissao(pool, parcela);

                    await registrarLog(null, 'ASAAS_PAGAMENTO_PARCELA', 'parcelas', parcela.id, {
                        asaas_id: payment.id,
                        valor: payment.value,
                        acordo_id: parcela.acordo_id
                    });
                    break;

                case 'PAYMENT_OVERDUE':
                    await pool.query(`
                        UPDATE parcelas SET status = 'vencido' WHERE id = $1
                    `, [parcela.id]);
                    break;

                case 'PAYMENT_DELETED':
                case 'PAYMENT_REFUNDED':
                    await pool.query(`
                        UPDATE parcelas SET status = 'cancelado' WHERE id = $1
                    `, [parcela.id]);
                    break;
            }

            res.json({ received: true });

        } catch (error) {
            console.error('Erro no webhook Asaas:', error);
            res.status(500).json({ error: 'Erro ao processar webhook' });
        }
    });

    // Função para calcular comissão
    async function calcularComissao(pool, parcela) {
        try {
            // Buscar configuração de comissão do credor
            const credorResult = await pool.query(`
                SELECT percentual_comissao FROM credores WHERE id = $1
            `, [parcela.credor_id]);

            if (credorResult.rows.length === 0) return;

            const percentual = parseFloat(credorResult.rows[0].percentual_comissao || 0);
            if (percentual <= 0) return;

            const valorComissao = parseFloat(parcela.valor) * (percentual / 100);

            // Registrar comissão
            await pool.query(`
                INSERT INTO comissoes (
                    credor_id, acordo_id, parcela_id, 
                    valor_parcela, percentual, valor_comissao,
                    status, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW())
            `, [
                parcela.credor_id,
                parcela.acordo_id,
                parcela.id,
                parcela.valor,
                percentual,
                valorComissao
            ]);

        } catch (error) {
            console.error('Erro ao calcular comissão:', error);
        }
    }

    // POST /api/asaas/criar-cobranca - Criar cobrança no Asaas
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

            // Verificar se cliente tem asaas_id, senão criar
            let customerId = cli.asaas_customer_id;

            if (!customerId) {
                // Criar cliente no Asaas
                const novoCliente = await asaasRequest('/customers', 'POST', {
                    name: cli.nome,
                    cpfCnpj: cli.cpf_cnpj?.replace(/\D/g, ''),
                    email: cli.email,
                    phone: cli.telefone?.replace(/\D/g, ''),
                    mobilePhone: cli.telefone?.replace(/\D/g, '')
                });

                if (novoCliente.id) {
                    customerId = novoCliente.id;
                    await pool.query(`
                        UPDATE clientes SET asaas_customer_id = $1 WHERE id = $2
                    `, [customerId, cliente_id]);
                } else {
                    return res.status(400).json({ error: 'Erro ao criar cliente no Asaas', details: novoCliente });
                }
            }

            // Criar cobrança
            const cobranca = await asaasRequest('/payments', 'POST', {
                customer: customerId,
                billingType: tipo, // BOLETO, PIX, CREDIT_CARD
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
                    pixQrCode: cobranca.pixQrCodeUrl
                });
            } else {
                res.status(400).json({ error: 'Erro ao criar cobrança', details: cobranca });
            }

        } catch (error) {
            console.error('Erro ao criar cobrança Asaas:', error);
            res.status(500).json({ error: 'Erro ao criar cobrança' });
        }
    });

    // POST /api/asaas/criar-parcelas/:acordoId - Criar parcelas no Asaas
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

            // Verificar/criar cliente no Asaas
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

            // Buscar parcelas do acordo
            const parcelas = await pool.query(`
                SELECT * FROM parcelas WHERE acordo_id = $1 ORDER BY numero
            `, [acordoId]);

            const resultados = [];

            for (const parcela of parcelas.rows) {
                // Criar cobrança para cada parcela
                const cobranca = await asaasRequest('/payments', 'POST', {
                    customer: customerId,
                    billingType: tipo,
                    value: parseFloat(parcela.valor),
                    dueDate: parcela.data_vencimento.toISOString().split('T')[0],
                    description: `Parcela ${parcela.numero} - Acordo #${acordoId}`,
                    externalReference: `ACORDO_${acordoId}_PARCELA_${parcela.id}`
                });

                if (cobranca.id) {
                    // Atualizar parcela com ID do Asaas
                    await pool.query(`
                        UPDATE parcelas 
                        SET asaas_payment_id = $1,
                            link_boleto = $2,
                            link_pix = $3
                        WHERE id = $4
                    `, [
                        cobranca.id,
                        cobranca.bankSlipUrl,
                        cobranca.pixQrCodeUrl,
                        parcela.id
                    ]);

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
            console.error('Erro ao criar parcelas Asaas:', error);
            res.status(500).json({ error: 'Erro ao criar parcelas' });
        }
    });

    // GET /api/asaas/status/:paymentId - Verificar status de pagamento
    router.get('/status/:paymentId', auth, async (req, res) => {
        try {
            const { paymentId } = req.params;
            const payment = await asaasRequest(`/payments/${paymentId}`);
            res.json(payment);
        } catch (error) {
            console.error('Erro ao verificar status:', error);
            res.status(500).json({ error: 'Erro ao verificar status' });
        }
    });

    return router;
};
