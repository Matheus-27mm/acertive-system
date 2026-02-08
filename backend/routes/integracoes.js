/**
 * ========================================
 * ACERTIVE - Módulo de Integrações
 * routes/integracoes.js
 * ========================================
 * Unifica: asaas, sync-asaas, whatsapp, email, pdf, configuracoes, dashboard
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // ASAAS - Integração de Pagamentos
    // ═══════════════════════════════════════════════════════════════

    const ASAAS_ENV = process.env.ASAAS_ENV || 'sandbox';
    const ASAAS_API_URL = ASAAS_ENV === 'production' ? 'https://www.asaas.com/api/v3' : 'https://sandbox.asaas.com/api/v3';
    const ASAAS_API_KEY = ASAAS_ENV === 'production' ? process.env.ASAAS_API_KEY : (process.env.ASAAS_API_KEY_SANDBOX || process.env.ASAAS_API_KEY);

    async function asaasRequest(endpoint, method = 'GET', body = null) {
        if (!ASAAS_API_KEY) throw new Error('ASAAS_API_KEY não configurada');
        const options = { method, headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY } };
        if (body) options.body = JSON.stringify(body);
        const response = await fetch(`${ASAAS_API_URL}${endpoint}`, options);
        return response.json();
    }

    // GET /api/integracoes/asaas/status
    router.get('/asaas/status', auth, async (req, res) => {
        try {
            if (!ASAAS_API_KEY) return res.json({ success: false, conectado: false, erro: 'API Key não configurada', ambiente: ASAAS_ENV });
            const resultado = await asaasRequest('/finance/balance');
            if (resultado.balance !== undefined) {
                res.json({ success: true, conectado: true, ambiente: ASAAS_ENV, saldo: resultado.balance });
            } else {
                res.json({ success: false, conectado: false, erro: resultado.errors?.[0]?.description || 'Erro na API', ambiente: ASAAS_ENV });
            }
        } catch (error) {
            res.json({ success: false, conectado: false, erro: error.message, ambiente: ASAAS_ENV });
        }
    });

    // GET /api/integracoes/asaas/config
    router.get('/asaas/config', auth, async (req, res) => {
        res.json({ success: true, ambiente: ASAAS_ENV, api_url: ASAAS_API_URL, api_key_configurada: !!ASAAS_API_KEY });
    });

    // POST /api/integracoes/asaas/webhook
    router.post('/asaas/webhook', async (req, res) => {
        try {
            const { event, payment } = req.body;
            console.log('[ASAAS] Webhook:', event, payment?.id, '(FIX_V3 queries separadas)');

            try { await pool.query('INSERT INTO asaas_webhooks_log (event, payment_id, payload, created_at) VALUES ($1, $2, $3, NOW())', [event, payment?.id, JSON.stringify(req.body)]); } catch (e) {}

            if (!payment) return res.json({ received: true });

            const statusMap = { 'PAYMENT_CONFIRMED': 'pago', 'PAYMENT_RECEIVED': 'pago', 'PAYMENT_OVERDUE': 'vencido', 'PAYMENT_DELETED': 'cancelado', 'PAYMENT_REFUNDED': 'cancelado' };
            const novoStatus = statusMap[event];
            if (!novoStatus) return res.json({ received: true });

            // Atualizar cobrança
            try {
                const cob = await pool.query('SELECT * FROM cobrancas WHERE asaas_id = $1', [payment.id]);
                if (cob.rowCount > 0) {
                    await pool.query(`UPDATE cobrancas SET status = $1, valor_pago = CASE WHEN $1 = 'pago' THEN $2 ELSE valor_pago END, data_pagamento = CASE WHEN $1 = 'pago' THEN NOW() ELSE data_pagamento END, asaas_sync_at = NOW() WHERE id = $3`, [novoStatus, payment.value, cob.rows[0].id]);
                    console.log('[ASAAS] ✅ Cobrança atualizada:', cob.rows[0].id, '->', novoStatus);
                }
            } catch (e) { console.log('[ASAAS] Cobrança não encontrada ou erro:', e.message); }

            // Atualizar parcela (tabela parcelas - antiga)
            try {
                const parc = await pool.query('SELECT p.*, a.id as acordo_id FROM parcelas p JOIN acordos a ON p.acordo_id = a.id WHERE p.asaas_payment_id = $1', [payment.id]);
                if (parc.rowCount > 0) {
                    await pool.query(`UPDATE parcelas SET status = $1, data_pagamento = CASE WHEN $1 = 'pago' THEN NOW() ELSE data_pagamento END WHERE id = $2`, [novoStatus, parc.rows[0].id]);
                    console.log('[ASAAS] ✅ Parcela (antiga) atualizada:', parc.rows[0].id, '->', novoStatus);
                    if (novoStatus === 'pago') {
                        const pendentes = await pool.query('SELECT COUNT(*) FROM parcelas WHERE acordo_id = $1 AND status != \'pago\'', [parc.rows[0].acordo_id]);
                        if (parseInt(pendentes.rows[0].count) === 0) {
                            await pool.query('UPDATE acordos SET status = \'quitado\', updated_at = NOW() WHERE id = $1', [parc.rows[0].acordo_id]);
                            console.log('[ASAAS] ✅ Acordo quitado (antiga):', parc.rows[0].acordo_id);
                        }
                    }
                }
            } catch (e) { console.log('[ASAAS] Tabela parcelas não encontrada ou sem coluna:', e.message); }

            // Atualizar parcela_acordo (tabela nova - Suri v3)
            try {
                var parc2 = { rowCount: 0, rows: [] };
                // Buscar por asaas_payment_id primeiro
                var findByPayment = await pool.query('SELECT pa.*, pa.acordo_id FROM parcelas_acordo pa WHERE pa.asaas_payment_id = $1', [String(payment.id)]);
                if (findByPayment.rowCount > 0) {
                    parc2 = findByPayment;
                } else if (payment.externalReference) {
                    // Se não achou, buscar por external_reference
                    var findByRef = await pool.query('SELECT pa.*, pa.acordo_id FROM parcelas_acordo pa WHERE pa.external_reference = $1', [String(payment.externalReference)]);
                    if (findByRef.rowCount > 0) parc2 = findByRef;
                }
                if (parc2.rowCount > 0) {
                    await pool.query(`UPDATE parcelas_acordo SET status = $1, data_pagamento = CASE WHEN $1 = 'pago' THEN NOW() ELSE data_pagamento END, updated_at = NOW() WHERE id = $2`, [novoStatus, parc2.rows[0].id]);
                    console.log('[ASAAS] ✅ Parcela acordo atualizada:', parc2.rows[0].id, '->', novoStatus);
                    if (novoStatus === 'pago') {
                        var acordoId = parc2.rows[0].acordo_id;
                        const pendentes2 = await pool.query('SELECT COUNT(*) as n FROM parcelas_acordo WHERE acordo_id = $1 AND status != \'pago\'', [acordoId]);
                        if (parseInt(pendentes2.rows[0].n) === 0) {
                            await pool.query('UPDATE acordos SET status = \'quitado\', updated_at = NOW() WHERE id = $1', [acordoId]);
                            console.log('[ASAAS] ✅ Acordo quitado:', acordoId);
                            // Atualizar status do cliente
                            try {
                                var cliRes = await pool.query('SELECT cliente_id FROM acordos WHERE id = $1', [acordoId]);
                                if (cliRes.rowCount > 0) {
                                    await pool.query("UPDATE clientes SET status_cobranca = 'quitado' WHERE id = $1", [cliRes.rows[0].cliente_id]);
                                    console.log('[ASAAS] ✅ Cliente quitado:', cliRes.rows[0].cliente_id);
                                }
                            } catch (e2) { console.log('[ASAAS] Erro ao atualizar cliente:', e2.message); }
                        }
                    }
                }
            } catch (e) { console.log('[ASAAS] parcelas_acordo erro:', e.message); }

            res.json({ received: true });
        } catch (error) {
            console.error('[ASAAS] Erro webhook:', error.message);
            res.status(500).json({ error: 'Erro ao processar webhook' });
        }
    });

    // POST /api/integracoes/asaas/criar-cobranca
    router.post('/asaas/criar-cobranca', auth, async (req, res) => {
        try {
            const { cliente_id, valor, vencimento, descricao, tipo = 'BOLETO' } = req.body;
            const cli = await pool.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
            if (!cli.rowCount) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

            let customerId = cli.rows[0].asaas_customer_id;
            if (!customerId) {
                const novo = await asaasRequest('/customers', 'POST', { name: cli.rows[0].nome, cpfCnpj: cli.rows[0].cpf_cnpj?.replace(/\D/g, ''), email: cli.rows[0].email, phone: cli.rows[0].telefone?.replace(/\D/g, '') });
                if (novo.id) {
                    customerId = novo.id;
                    await pool.query('UPDATE clientes SET asaas_customer_id = $1 WHERE id = $2', [customerId, cliente_id]);
                } else {
                    return res.status(400).json({ success: false, error: 'Erro ao criar cliente no Asaas', details: novo });
                }
            }

            const cobranca = await asaasRequest('/payments', 'POST', { customer: customerId, billingType: tipo, value: parseFloat(valor), dueDate: vencimento, description: descricao, externalReference: `ACERTIVE_${Date.now()}` });
            if (cobranca.id) {
                res.json({ success: true, asaas_id: cobranca.id, bankSlipUrl: cobranca.bankSlipUrl, invoiceUrl: cobranca.invoiceUrl, pixQrCode: cobranca.pixQrCodeUrl });
            } else {
                res.status(400).json({ success: false, error: 'Erro ao criar cobrança', details: cobranca });
            }
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao criar cobrança' });
        }
    });

    // POST /api/integracoes/asaas/criar-parcelas/:acordoId
    router.post('/asaas/criar-parcelas/:acordoId', auth, async (req, res) => {
        try {
            const { acordoId } = req.params;
            const { tipo = 'BOLETO' } = req.body;

            const acordo = await pool.query('SELECT a.*, cl.nome, cl.cpf_cnpj, cl.email, cl.telefone, cl.asaas_customer_id FROM acordos a JOIN clientes cl ON a.cliente_id = cl.id WHERE a.id = $1', [acordoId]);
            if (!acordo.rowCount) return res.status(404).json({ success: false, error: 'Acordo não encontrado' });

            const ac = acordo.rows[0];
            let customerId = ac.asaas_customer_id;
            if (!customerId) {
                const novo = await asaasRequest('/customers', 'POST', { name: ac.nome, cpfCnpj: ac.cpf_cnpj?.replace(/\D/g, ''), email: ac.email, phone: ac.telefone?.replace(/\D/g, '') });
                if (novo.id) {
                    customerId = novo.id;
                    await pool.query('UPDATE clientes SET asaas_customer_id = $1 WHERE id = $2', [customerId, ac.cliente_id]);
                }
            }

            const parcelas = await pool.query('SELECT * FROM parcelas WHERE acordo_id = $1 ORDER BY numero', [acordoId]);
            const resultados = [];

            for (const p of parcelas.rows) {
                const cob = await asaasRequest('/payments', 'POST', { customer: customerId, billingType: tipo, value: parseFloat(p.valor), dueDate: p.data_vencimento.toISOString().split('T')[0], description: `Parcela ${p.numero} - Acordo #${acordoId}`, externalReference: `ACORDO_${acordoId}_PARCELA_${p.id}` });
                if (cob.id) {
                    await pool.query('UPDATE parcelas SET asaas_payment_id = $1, link_boleto = $2, link_pix = $3 WHERE id = $4', [cob.id, cob.bankSlipUrl, cob.pixQrCodeUrl, p.id]);
                    resultados.push({ parcela: p.numero, asaas_id: cob.id, boleto: cob.bankSlipUrl, pix: cob.pixQrCodeUrl });
                }
            }

            res.json({ success: true, parcelas_criadas: resultados.length, detalhes: resultados });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao criar parcelas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // SYNC ASAAS
    // ═══════════════════════════════════════════════════════════════

    // GET /api/integracoes/sync/status
    router.get('/sync/status', auth, async (req, res) => {
        try {
            const local = await pool.query('SELECT COUNT(*) as clientes FROM clientes');
            const cob = await pool.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE asaas_id IS NOT NULL) as sincronizadas FROM cobrancas');

            let asaasStatus = { connected: false };
            try {
                const teste = await asaasRequest('/customers?limit=1');
                asaasStatus = { connected: true, totalCustomers: teste.totalCount || 0 };
            } catch (e) { asaasStatus = { connected: false, error: e.message }; }

            res.json({
                success: true, data: {
                    local: { clientes: parseInt(local.rows[0].clientes), cobrancas: parseInt(cob.rows[0].total), sincronizadas: parseInt(cob.rows[0].sincronizadas) },
                    asaas: asaasStatus, ambiente: ASAAS_ENV
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // POST /api/integracoes/sync/completa
    router.post('/sync/completa', auth, async (req, res) => {
        try {
            const { empresa_id, credor_id } = req.body;
            if (!empresa_id) return res.status(400).json({ success: false, error: 'empresa_id é obrigatório' });

            const resultados = { clientes: { importados: 0, atualizados: 0 }, cobrancas: { importados: 0, atualizados: 0, erros: 0 } };
            let offset = 0;
            const limit = 100;

            // Sync clientes
            while (true) {
                const response = await asaasRequest(`/customers?offset=${offset}&limit=${limit}`);
                if (!response.data || response.data.length === 0) break;

                for (const customer of response.data) {
                    const existe = await pool.query('SELECT id FROM clientes WHERE asaas_customer_id = $1 OR cpf_cnpj = $2', [customer.id, customer.cpfCnpj]);
                    if (existe.rowCount > 0) {
                        await pool.query('UPDATE clientes SET nome = COALESCE($1, nome), email = COALESCE($2, email), telefone = COALESCE($3, telefone), asaas_customer_id = $4, asaas_sync_at = NOW() WHERE id = $5', [customer.name, customer.email, customer.phone, customer.id, existe.rows[0].id]);
                        resultados.clientes.atualizados++;
                    } else {
                        await pool.query('INSERT INTO clientes (nome, email, telefone, cpf_cnpj, empresa_id, asaas_customer_id, asaas_sync_at, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), \'ativo\', NOW())', [customer.name, customer.email, customer.phone, customer.cpfCnpj, empresa_id, customer.id]);
                        resultados.clientes.importados++;
                    }
                }
                if (!response.hasMore) break;
                offset += limit;
            }

            // Sync cobranças
            offset = 0;
            while (true) {
                const response = await asaasRequest(`/payments?offset=${offset}&limit=${limit}`);
                if (!response.data || response.data.length === 0) break;

                for (const payment of response.data) {
                    try {
                        const cli = await pool.query('SELECT id FROM clientes WHERE asaas_customer_id = $1', [payment.customer]);
                        if (!cli.rowCount) continue;

                        const statusMap = { 'PENDING': 'pendente', 'RECEIVED': 'pago', 'CONFIRMED': 'pago', 'OVERDUE': 'vencido', 'REFUNDED': 'cancelado', 'RECEIVED_IN_CASH': 'pago' };
                        const statusInterno = statusMap[payment.status] || 'pendente';

                        const existe = await pool.query('SELECT id FROM cobrancas WHERE asaas_id = $1', [payment.id]);
                        if (existe.rowCount > 0) {
                            await pool.query('UPDATE cobrancas SET status = $1, valor_pago = CASE WHEN $1 = \'pago\' THEN $2 ELSE valor_pago END, data_pagamento = CASE WHEN $1 = \'pago\' THEN $3 ELSE data_pagamento END, asaas_sync_at = NOW() WHERE id = $4', [statusInterno, payment.value, payment.paymentDate, existe.rows[0].id]);
                            resultados.cobrancas.atualizados++;
                        } else {
                            await pool.query('INSERT INTO cobrancas (cliente_id, empresa_id, credor_id, descricao, valor_original, valor, data_vencimento, status, valor_pago, data_pagamento, asaas_id, asaas_invoice_url, asaas_boleto_url, asaas_sync_at, created_at) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())', [cli.rows[0].id, empresa_id, credor_id, payment.description || 'Cobrança Asaas', payment.value, payment.dueDate, statusInterno, statusInterno === 'pago' ? payment.value : null, payment.paymentDate, payment.id, payment.invoiceUrl, payment.bankSlipUrl]);
                            resultados.cobrancas.importados++;
                        }
                    } catch (err) { resultados.cobrancas.erros++; }
                }
                if (!response.hasMore) break;
                offset += limit;
            }

            res.json({ success: true, data: resultados });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // WHATSAPP
    // ═══════════════════════════════════════════════════════════════

    // GET /api/integracoes/whatsapp/cobranca/:id
    router.get('/whatsapp/cobranca/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('SELECT c.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone, cr.nome as credor_nome FROM cobrancas c JOIN clientes cl ON c.cliente_id = cl.id LEFT JOIN credores cr ON c.credor_id = cr.id WHERE c.id = $1', [id]);
            if (!result.rowCount) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            const c = result.rows[0];
            if (!c.cliente_telefone) return res.status(400).json({ success: false, error: 'Cliente não possui telefone' });

            let telefone = c.cliente_telefone.replace(/\D/g, '');
            if (telefone.length <= 11) telefone = '55' + telefone;

            const valor = parseFloat(c.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const vencimento = new Date(c.data_vencimento).toLocaleDateString('pt-BR');
            const mensagem = `Olá ${c.cliente_nome}!\n\nIdentificamos uma pendência:\n\n📋 *Credor:* ${c.credor_nome || 'Não informado'}\n📝 *Descrição:* ${c.descricao}\n💰 *Valor:* ${valor}\n📅 *Vencimento:* ${vencimento}\n\nEntre em contato para regularizar!\n\n_ACERTIVE_`;

            res.json({ success: true, link: `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`, telefone, mensagem });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar link' });
        }
    });

    // GET /api/integracoes/whatsapp/acordo/:id
    router.get('/whatsapp/acordo/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('SELECT a.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone, cr.nome as credor_nome FROM acordos a JOIN clientes cl ON a.cliente_id = cl.id LEFT JOIN credores cr ON a.credor_id = cr.id WHERE a.id = $1', [id]);
            if (!result.rowCount) return res.status(404).json({ success: false, error: 'Acordo não encontrado' });

            const a = result.rows[0];
            if (!a.cliente_telefone) return res.status(400).json({ success: false, error: 'Cliente não possui telefone' });

            let telefone = a.cliente_telefone.replace(/\D/g, '');
            if (telefone.length <= 11) telefone = '55' + telefone;

            const valorTotal = parseFloat(a.valor_acordo).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const valorParcela = parseFloat(a.valor_parcela).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const mensagem = `Olá ${a.cliente_nome}!\n\nResumo do seu acordo:\n\n📋 *Credor:* ${a.credor_nome || 'Não informado'}\n💰 *Valor Total:* ${valorTotal}\n📊 *Parcelas:* ${a.numero_parcelas}x de ${valorParcela}\n📅 *Primeiro Vencimento:* ${new Date(a.data_primeiro_vencimento).toLocaleDateString('pt-BR')}\n\nDúvidas? Estamos à disposição!\n\n_ACERTIVE_`;

            res.json({ success: true, link: `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`, telefone, mensagem });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar link' });
        }
    });

    // POST /api/integracoes/whatsapp/registrar-contato/:cobrancaId
    router.post('/whatsapp/registrar-contato/:cobrancaId', auth, async (req, res) => {
        try {
            const { cobrancaId } = req.params;
            const { observacao } = req.body;
            await pool.query('UPDATE cobrancas SET ultimo_contato = NOW(), observacoes = CONCAT(observacoes, E\'\\n[\', TO_CHAR(NOW(), \'DD/MM/YYYY HH24:MI\'), \'] WhatsApp: \', $2) WHERE id = $1', [cobrancaId, observacao || 'Contato realizado']);
            await registrarLog(req.user?.id, 'WHATSAPP_CONTATO', 'cobrancas', cobrancaId, { observacao });
            res.json({ success: true, message: 'Contato registrado' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao registrar contato' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // EMAIL
    // ═══════════════════════════════════════════════════════════════

    async function getTransporter() {
        const config = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
        const cfg = config.rows[0] || {};
        return nodemailer.createTransport({ host: cfg.smtp_host || 'smtp.gmail.com', port: cfg.smtp_port || 587, secure: false, auth: { user: cfg.smtp_user || process.env.SMTP_USER || process.env.EMAIL_USER, pass: cfg.smtp_pass || process.env.SMTP_PASS || process.env.EMAIL_PASS } });
    }

    // POST /api/integracoes/email/enviar-cobranca/:id
    router.post('/email/enviar-cobranca/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('SELECT c.*, cl.nome as cliente_nome, cl.email as cliente_email, cr.nome as credor_nome FROM cobrancas c JOIN clientes cl ON c.cliente_id = cl.id LEFT JOIN credores cr ON c.credor_id = cr.id WHERE c.id = $1', [id]);
            if (!result.rowCount) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            const c = result.rows[0];
            if (!c.cliente_email) return res.status(400).json({ success: false, error: 'Cliente não possui email' });

            const transporter = await getTransporter();
            const valor = parseFloat(c.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const vencimento = new Date(c.data_vencimento).toLocaleDateString('pt-BR');

            const html = `<div style="font-family:Arial;max-width:600px;margin:0 auto"><div style="background:#1e3a5f;color:white;padding:20px;text-align:center"><h1>ACERTIVE</h1><p>Sistema de Cobranças</p></div><div style="padding:20px;background:#f9f9f9"><p>Prezado(a) <strong>${c.cliente_nome}</strong>,</p><p>Existe uma pendência financeira em seu nome:</p><div style="background:white;padding:15px;border-radius:8px;margin:20px 0"><table style="width:100%"><tr><td><strong>Credor:</strong></td><td>${c.credor_nome || 'Não informado'}</td></tr><tr><td><strong>Descrição:</strong></td><td>${c.descricao}</td></tr><tr><td><strong>Valor:</strong></td><td style="color:#e74c3c;font-weight:bold">${valor}</td></tr><tr><td><strong>Vencimento:</strong></td><td>${vencimento}</td></tr></table></div><p>Entre em contato para regularizar.</p></div></div>`;

            await transporter.sendMail({ from: process.env.SMTP_USER || process.env.EMAIL_USER, to: c.cliente_email, subject: `Cobrança - ${c.descricao}`, html });
            await pool.query('UPDATE cobrancas SET ultimo_contato = NOW(), observacoes = CONCAT(observacoes, E\'\\n[\', NOW(), \'] Email enviado\') WHERE id = $1', [id]);
            await registrarLog(req.user?.id, 'EMAIL_ENVIADO', 'cobrancas', id, { destinatario: c.cliente_email });

            res.json({ success: true, message: 'Email enviado com sucesso' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao enviar email: ' + error.message });
        }
    });

    // POST /api/integracoes/email/teste
    router.post('/email/teste', auth, async (req, res) => {
        try {
            const { destinatario } = req.body;
            if (!destinatario) return res.status(400).json({ success: false, error: 'Destinatário é obrigatório' });
            const transporter = await getTransporter();
            await transporter.sendMail({ from: process.env.SMTP_USER || process.env.EMAIL_USER, to: destinatario, subject: 'Teste ACERTIVE', html: '<h1>Teste de Email</h1><p>Configuração OK!</p>' });
            res.json({ success: true, message: 'Email de teste enviado' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PDF
    // ═══════════════════════════════════════════════════════════════

    const formatarMoeda = (v) => parseFloat(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const formatarData = (d) => d ? new Date(d).toLocaleDateString('pt-BR') : 'Não informada';

    // GET /api/integracoes/pdf/cobranca/:id
    router.get('/pdf/cobranca/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('SELECT c.*, cl.nome as cliente_nome, cl.cpf_cnpj as cliente_documento, cl.telefone as cliente_telefone, cl.email as cliente_email, cr.nome as credor_nome, cr.cnpj as credor_cnpj FROM cobrancas c JOIN clientes cl ON c.cliente_id = cl.id LEFT JOIN credores cr ON c.credor_id = cr.id WHERE c.id = $1', [id]);
            if (!result.rowCount) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            const c = result.rows[0];
            const doc = new PDFDocument({ margin: 50 });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=cobranca_${id}.pdf`);
            doc.pipe(res);

            doc.fontSize(20).fillColor('#1e3a5f').text('ACERTIVE', { align: 'center' });
            doc.fontSize(12).fillColor('#666').text('Sistema de Cobranças', { align: 'center' });
            doc.moveDown(2);
            doc.fontSize(16).fillColor('#000').text('NOTIFICAÇÃO DE COBRANÇA', { align: 'center' });
            doc.moveDown();

            doc.fontSize(14).fillColor('#1e3a5f').text('DADOS DO DEVEDOR');
            doc.fontSize(11).fillColor('#000');
            doc.text(`Nome: ${c.cliente_nome}`);
            doc.text(`Documento: ${c.cliente_documento || 'Não informado'}`);
            doc.text(`Telefone: ${c.cliente_telefone || 'Não informado'}`);
            doc.moveDown();

            if (c.credor_nome) {
                doc.fontSize(14).fillColor('#1e3a5f').text('DADOS DO CREDOR');
                doc.fontSize(11).fillColor('#000').text(`Nome: ${c.credor_nome}`);
                doc.moveDown();
            }

            doc.fontSize(14).fillColor('#1e3a5f').text('DADOS DA DÍVIDA');
            doc.fontSize(11).fillColor('#000');
            doc.text(`Descrição: ${c.descricao}`);
            doc.text(`Valor: ${formatarMoeda(c.valor)}`);
            doc.text(`Vencimento: ${formatarData(c.data_vencimento)}`);
            doc.text(`Status: ${c.status?.toUpperCase() || 'PENDENTE'}`);
            doc.moveDown(2);

            doc.fontSize(8).fillColor('#999').text(`Documento gerado em ${new Date().toLocaleString('pt-BR')}`, { align: 'center' });
            doc.end();

            await registrarLog(req.user?.id, 'PDF_GERADO', 'cobrancas', id, {});
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar PDF' });
        }
    });

    // GET /api/integracoes/pdf/acordo/:id
    router.get('/pdf/acordo/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('SELECT a.*, cl.nome as cliente_nome, cl.cpf_cnpj as cliente_documento, cr.nome as credor_nome FROM acordos a JOIN clientes cl ON a.cliente_id = cl.id LEFT JOIN credores cr ON a.credor_id = cr.id WHERE a.id = $1', [id]);
            if (!result.rowCount) return res.status(404).json({ success: false, error: 'Acordo não encontrado' });

            const a = result.rows[0];
            const parcelas = await pool.query('SELECT * FROM parcelas WHERE acordo_id = $1 ORDER BY numero', [id]);

            const doc = new PDFDocument({ margin: 50 });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=acordo_${id}.pdf`);
            doc.pipe(res);

            doc.fontSize(20).fillColor('#1e3a5f').text('ACERTIVE', { align: 'center' });
            doc.fontSize(12).fillColor('#666').text('Sistema de Cobranças', { align: 'center' });
            doc.moveDown(2);
            doc.fontSize(16).fillColor('#000').text('TERMO DE ACORDO', { align: 'center' });
            doc.moveDown();

            doc.fontSize(14).fillColor('#1e3a5f').text('DADOS DO ACORDO');
            doc.fontSize(11).fillColor('#000');
            doc.text(`Devedor: ${a.cliente_nome}`);
            doc.text(`Documento: ${a.cliente_documento || 'Não informado'}`);
            doc.text(`Credor: ${a.credor_nome || 'Não informado'}`);
            doc.text(`Valor Original: ${formatarMoeda(a.valor_original)}`);
            doc.text(`Valor Acordado: ${formatarMoeda(a.valor_acordo)}`);
            doc.text(`Parcelas: ${a.numero_parcelas}x de ${formatarMoeda(a.valor_parcela)}`);
            doc.moveDown();

            if (parcelas.rowCount > 0) {
                doc.fontSize(14).fillColor('#1e3a5f').text('PARCELAS');
                doc.fontSize(10).fillColor('#000');
                parcelas.rows.forEach(p => { doc.text(`${p.numero}. ${formatarData(p.data_vencimento)} - ${formatarMoeda(p.valor)} - ${p.status?.toUpperCase()}`); });
            }

            doc.moveDown(2);
            doc.fontSize(10).fillColor('#000');
            doc.text('_________________________________', 50);
            doc.text('Devedor');
            doc.moveDown(2);
            doc.text('_________________________________', 50);
            doc.text('Credor/Representante');
            doc.moveDown(2);
            doc.fontSize(8).fillColor('#999').text(`Documento gerado em ${new Date().toLocaleString('pt-BR')}`, { align: 'center' });
            doc.end();

            await registrarLog(req.user?.id, 'PDF_ACORDO_GERADO', 'acordos', id, {});
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar PDF' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // CONFIGURAÇÕES
    // ═══════════════════════════════════════════════════════════════

    // GET /api/integracoes/configuracoes
    router.get('/configuracoes', auth, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
            if (!result.rowCount) {
                await pool.query('INSERT INTO configuracoes (id, created_at) VALUES (1, NOW())');
                return res.json({ success: true, data: {} });
            }
            const config = result.rows[0];
            delete config.smtp_pass;
            delete config.asaas_api_key;
            delete config.openai_api_key;
            res.json({ success: true, data: config });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar configurações' });
        }
    });

    // PUT /api/integracoes/configuracoes
    router.put('/configuracoes', auth, async (req, res) => {
        try {
            const b = req.body || {};
            const existe = await pool.query('SELECT id FROM configuracoes WHERE id = 1');
            if (!existe.rowCount) await pool.query('INSERT INTO configuracoes (id) VALUES (1)');

            const campos = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'email_remetente', 'asaas_api_key', 'asaas_ambiente', 'nome_empresa', 'percentual_comissao_padrao', 'dias_aviso_vencimento', 'openai_api_key', 'ia_ativa'];
            const updates = [];
            const params = [];
            let idx = 1;

            campos.forEach(campo => {
                if (b[campo] !== undefined) { updates.push(`${campo} = $${idx}`); params.push(b[campo]); idx++; }
            });

            if (updates.length > 0) {
                updates.push('updated_at = NOW()');
                await pool.query(`UPDATE configuracoes SET ${updates.join(', ')} WHERE id = 1`, params);
            }

            await registrarLog(req.user?.id, 'CONFIGURACOES_ATUALIZADAS', 'configuracoes', 1, {});
            res.json({ success: true, message: 'Configurações atualizadas' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao atualizar configurações' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DASHBOARD
    // ═══════════════════════════════════════════════════════════════

    // GET /api/integracoes/dashboard
    router.get('/dashboard', auth, async (req, res) => {
        try {
            const cobrancas = await pool.query(`
                SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'pendente') as pendentes, COUNT(*) FILTER (WHERE status = 'pago') as pagas,
                       COUNT(*) FILTER (WHERE status = 'vencido' OR (status = 'pendente' AND data_vencimento < CURRENT_DATE)) as vencidas,
                       COALESCE(SUM(valor_original), 0) as valor_total, COALESCE(SUM(valor_original) FILTER (WHERE status = 'pendente'), 0) as valor_pendente,
                       COALESCE(SUM(valor_original) FILTER (WHERE status = 'pago'), 0) as valor_pago
                FROM cobrancas
            `);
            const clientes = await pool.query('SELECT COUNT(*) FROM clientes');
            let credoresCount = 0;
            try { const cr = await pool.query('SELECT COUNT(*) FROM credores'); credoresCount = parseInt(cr.rows[0].count); } catch (e) {}
            let acordosMes = { count: 0, valor: 0 };
            try { const ac = await pool.query('SELECT COUNT(*) as count, COALESCE(SUM(valor_acordo), 0) as valor FROM acordos WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)'); acordosMes = ac.rows[0]; } catch (e) {}

            res.json({ success: true, data: { cobrancas: cobrancas.rows[0], clientes: parseInt(clientes.rows[0].count), credores: credoresCount, acordos_mes: acordosMes } });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/integracoes/dashboard/graficos
    router.get('/dashboard/graficos', auth, async (req, res) => {
        try {
            const porMes = await pool.query(`SELECT TO_CHAR(data_vencimento, 'YYYY-MM') as mes, COUNT(*) as total, COALESCE(SUM(valor_original), 0) as valor, COUNT(*) FILTER (WHERE status = 'pago') as pagas FROM cobrancas WHERE data_vencimento >= CURRENT_DATE - INTERVAL '6 months' GROUP BY TO_CHAR(data_vencimento, 'YYYY-MM') ORDER BY mes`);
            let porCredor = [];
            try { const cr = await pool.query(`SELECT COALESCE(cr.nome, 'Sem credor') as credor, COUNT(*) as total, COALESCE(SUM(c.valor_original), 0) as valor FROM cobrancas c LEFT JOIN credores cr ON c.credor_id = cr.id GROUP BY cr.id, cr.nome ORDER BY valor DESC LIMIT 10`); porCredor = cr.rows; } catch (e) {}
            const porStatus = await pool.query('SELECT status, COUNT(*) as total, COALESCE(SUM(valor_original), 0) as valor FROM cobrancas GROUP BY status');
            const vencimentosProximos = await pool.query(`SELECT data_vencimento::date as data, COUNT(*) as total, COALESCE(SUM(valor_original), 0) as valor FROM cobrancas WHERE status = 'pendente' AND data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' GROUP BY data_vencimento::date ORDER BY data`);

            res.json({ success: true, data: { por_mes: porMes.rows, por_credor: porCredor, por_status: porStatus.rows, vencimentos_proximos: vencimentosProximos.rows } });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar dados' });
        }
    });

    // GET /api/integracoes/dashboard/alertas
    router.get('/dashboard/alertas', auth, async (req, res) => {
        try {
            const venceHoje = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE status = \'pendente\' AND data_vencimento = CURRENT_DATE');
            const vencidas = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE status = \'pendente\' AND data_vencimento < CURRENT_DATE');
            let agendamentosCount = 0;
            try { const ag = await pool.query('SELECT COUNT(*) FROM agendamentos WHERE data_agendamento = CURRENT_DATE AND status = \'pendente\''); agendamentosCount = parseInt(ag.rows[0].count); } catch (e) {}
            let parcelasCount = 0;
            try { const pc = await pool.query('SELECT COUNT(*) FROM parcelas WHERE status = \'pendente\' AND data_vencimento = CURRENT_DATE'); parcelasCount = parseInt(pc.rows[0].count); } catch (e) {}

            res.json({ success: true, data: { vence_hoje: parseInt(venceHoje.rows[0].count), vencidas: parseInt(vencidas.rows[0].count), agendamentos_hoje: agendamentosCount, parcelas_hoje: parcelasCount } });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar alertas' });
        }
    });

    return router;
};