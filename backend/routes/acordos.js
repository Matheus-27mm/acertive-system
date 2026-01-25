/**
 * ========================================
 * ACERTIVE - Módulo de Acordos
 * routes/acordos.js
 * ========================================
 * IMPORTANTE: Rotas específicas ANTES de rotas com :id
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // ROTAS ESPECÍFICAS (devem vir ANTES das rotas com :id)
    // ═══════════════════════════════════════════════════════════════

    // GET /api/acordos/stats
    router.get('/stats', auth, async (req, res) => {
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(*)::int as total_acordos,
                    COUNT(CASE WHEN status = 'ativo' THEN 1 END)::int as acordos_ativos,
                    COUNT(CASE WHEN status = 'quitado' THEN 1 END)::int as acordos_quitados,
                    COUNT(CASE WHEN status = 'quebrado' THEN 1 END)::int as acordos_quebrados,
                    COALESCE(SUM(valor_acordo), 0)::numeric as valor_total_acordos,
                    COALESCE(AVG(desconto_percentual), 0)::numeric as desconto_medio
                FROM acordos
            `);
            
            const row = stats.rows[0];
            const taxaQuitacao = row.total_acordos > 0 ? ((row.acordos_quitados / row.total_acordos) * 100).toFixed(1) : 0;
            
            res.json({
                success: true,
                data: {
                    totalAcordos: row.total_acordos,
                    acordosAtivos: row.acordos_ativos,
                    acordosQuitados: row.acordos_quitados,
                    acordosQuebrados: row.acordos_quebrados,
                    valorTotalAcordos: parseFloat(row.valor_total_acordos),
                    descontoMedio: parseFloat(row.desconto_medio).toFixed(1),
                    taxaQuitacao: parseFloat(taxaQuitacao)
                }
            });
        } catch (error) {
            console.error('[ACORDOS] Erro stats:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // POST /api/acordos/simular
    router.post('/simular', auth, async (req, res) => {
        try {
            const { valor_divida, desconto_percentual, numero_parcelas, valor_entrada } = req.body || {};
            
            const valorDivida = parseFloat(valor_divida) || 0;
            const desconto = parseFloat(desconto_percentual) || 0;
            const parcelas = parseInt(numero_parcelas) || 1;
            const entrada = parseFloat(valor_entrada) || 0;
            
            if (valorDivida <= 0) return res.status(400).json({ success: false, error: 'Valor da dívida é obrigatório' });
            
            const descontoValor = (valorDivida * desconto) / 100;
            const valorAcordo = valorDivida - descontoValor;
            const valorAPagar = valorAcordo - entrada;
            const valorParcela = parcelas > 0 ? (valorAPagar / parcelas) : 0;
            
            const previewParcelas = [];
            let dataVencimento = new Date();
            dataVencimento.setMonth(dataVencimento.getMonth() + 1);
            
            for (let i = 1; i <= parcelas; i++) {
                previewParcelas.push({
                    numero: i,
                    valor: Math.round(valorParcela * 100) / 100,
                    vencimento: dataVencimento.toISOString().split('T')[0]
                });
                dataVencimento.setMonth(dataVencimento.getMonth() + 1);
            }
            
            res.json({
                success: true,
                simulacao: {
                    valorDivida,
                    descontoPercentual: desconto,
                    descontoValor: Math.round(descontoValor * 100) / 100,
                    valorAcordo: Math.round(valorAcordo * 100) / 100,
                    valorEntrada: entrada,
                    valorAPagar: Math.round(valorAPagar * 100) / 100,
                    numeroParcelas: parcelas,
                    valorParcela: Math.round(valorParcela * 100) / 100,
                    parcelas: previewParcelas
                }
            });
        } catch (error) {
            console.error('[ACORDOS] Erro simular:', error);
            res.status(500).json({ success: false, error: 'Erro ao simular acordo' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PARCELAS (rotas específicas ANTES de :id)
    // ═══════════════════════════════════════════════════════════════

    // GET /api/acordos/parcelas - Listar parcelas
    router.get('/parcelas', auth, async (req, res) => {
        try {
            const { status, periodo, credor_id, acordo_id, cliente_id, page = 1, limit = 50 } = req.query;
            
            let sql = `
                SELECT p.*, a.valor_acordo, a.numero_parcelas as total_parcelas, a.status as acordo_status,
                       cl.nome as cliente_nome, cl.cpf_cnpj as cliente_cpf, cl.telefone as cliente_telefone, cl.email as cliente_email,
                       cr.nome as credor_nome, cr.id as credor_id
                FROM parcelas p
                JOIN acordos a ON a.id = p.acordo_id
                LEFT JOIN clientes cl ON cl.id = a.cliente_id
                LEFT JOIN credores cr ON cr.id = a.credor_id
                WHERE a.status IN ('ativo', 'quitado')
            `;
            
            const params = [];
            let idx = 1;
            
            if (status) { sql += ` AND p.status = $${idx}`; params.push(status); idx++; }
            if (credor_id) { sql += ` AND a.credor_id = $${idx}`; params.push(credor_id); idx++; }
            if (acordo_id) { sql += ` AND p.acordo_id = $${idx}`; params.push(acordo_id); idx++; }
            if (cliente_id) { sql += ` AND a.cliente_id = $${idx}`; params.push(cliente_id); idx++; }
            
            if (periodo === 'hoje') sql += ` AND DATE(p.data_vencimento) = CURRENT_DATE AND p.status = 'pendente'`;
            else if (periodo === 'semana') sql += ` AND p.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND p.status = 'pendente'`;
            else if (periodo === 'vencidas') sql += ` AND p.data_vencimento < CURRENT_DATE AND p.status = 'pendente'`;
            else if (periodo === 'futuras') sql += ` AND p.data_vencimento > CURRENT_DATE AND p.status = 'pendente'`;
            
            sql += ` ORDER BY p.data_vencimento ASC LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
            
            const resultado = await pool.query(sql, params);
            res.json({ success: true, data: resultado.rows });
        } catch (error) {
            console.error('[PARCELAS] Erro ao listar:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar parcelas' });
        }
    });

    // GET /api/acordos/parcelas/stats
    router.get('/parcelas/stats', auth, async (req, res) => {
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(CASE WHEN DATE(p.data_vencimento) = CURRENT_DATE AND p.status = 'pendente' THEN 1 END)::int as vencendo_hoje,
                    COALESCE(SUM(CASE WHEN DATE(p.data_vencimento) = CURRENT_DATE AND p.status = 'pendente' THEN p.valor ELSE 0 END), 0)::numeric as valor_hoje,
                    COUNT(CASE WHEN p.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND p.status = 'pendente' THEN 1 END)::int as vencendo_semana,
                    COALESCE(SUM(CASE WHEN p.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND p.status = 'pendente' THEN p.valor ELSE 0 END), 0)::numeric as valor_semana,
                    COUNT(CASE WHEN p.data_vencimento < CURRENT_DATE AND p.status = 'pendente' THEN 1 END)::int as vencidas,
                    COALESCE(SUM(CASE WHEN p.data_vencimento < CURRENT_DATE AND p.status = 'pendente' THEN p.valor ELSE 0 END), 0)::numeric as valor_vencidas,
                    COUNT(CASE WHEN p.status = 'pago' THEN 1 END)::int as total_pagas,
                    COALESCE(SUM(CASE WHEN p.status = 'pago' THEN COALESCE(p.valor_pago, p.valor) ELSE 0 END), 0)::numeric as valor_total_pago
                FROM parcelas p
                JOIN acordos a ON a.id = p.acordo_id
                WHERE a.status IN ('ativo', 'quitado')
            `);
            
            const row = stats.rows[0];
            res.json({
                success: true,
                data: {
                    vencendoHoje: { quantidade: row.vencendo_hoje, valor: parseFloat(row.valor_hoje) },
                    vencendoSemana: { quantidade: row.vencendo_semana, valor: parseFloat(row.valor_semana) },
                    vencidas: { quantidade: row.vencidas, valor: parseFloat(row.valor_vencidas) },
                    totalPagas: { quantidade: row.total_pagas, valor: parseFloat(row.valor_total_pago) }
                }
            });
        } catch (error) {
            console.error('[PARCELAS] Erro stats:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas de parcelas' });
        }
    });

    // PUT /api/acordos/parcelas/:id/pagar
    router.put('/parcelas/:id/pagar', auth, async (req, res) => {
        const client = await pool.connect();
        
        try {
            const { id } = req.params;
            const { valor_pago, data_pagamento, forma_pagamento } = req.body || {};
            
            await client.query('BEGIN');
            
            const parcela = await client.query('SELECT acordo_id, valor FROM parcelas WHERE id = $1', [id]);
            if (!parcela.rowCount) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Parcela não encontrada' });
            }
            
            const valorPago = valor_pago || parcela.rows[0].valor;
            
            await client.query(`
                UPDATE parcelas SET status = 'pago', valor_pago = $1, data_pagamento = $2, forma_pagamento = $3, updated_at = NOW()
                WHERE id = $4
            `, [valorPago, data_pagamento || new Date(), forma_pagamento || 'pix', id]);
            
            // Verificar se acordo foi quitado
            const acordoId = parcela.rows[0].acordo_id;
            const pendentes = await client.query('SELECT COUNT(*) FROM parcelas WHERE acordo_id = $1 AND status = \'pendente\'', [acordoId]);
            
            if (parseInt(pendentes.rows[0].count) === 0) {
                await client.query('UPDATE acordos SET status = \'quitado\', updated_at = NOW() WHERE id = $1', [acordoId]);
            }
            
            await client.query('COMMIT');
            
            await registrarLog(req.user?.id, 'PARCELA_PAGA', 'parcelas', id, { valor_pago: valorPago });
            
            const quitado = parseInt(pendentes.rows[0].count) === 0;
            res.json({ success: true, message: quitado ? 'Parcela paga! Acordo quitado!' : 'Parcela paga!', acordo_quitado: quitado });
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[PARCELAS] Erro ao pagar:', error);
            res.status(500).json({ success: false, error: 'Erro ao registrar pagamento' });
        } finally {
            client.release();
        }
    });

    // PUT /api/acordos/parcelas/:id/reagendar
    router.put('/parcelas/:id/reagendar', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { nova_data, motivo } = req.body || {};
            
            if (!nova_data) return res.status(400).json({ success: false, error: 'Nova data é obrigatória' });
            
            const resultado = await pool.query(`
                UPDATE parcelas SET data_vencimento = $1, observacoes = CONCAT(observacoes, ' | Reagendado: ', $2), updated_at = NOW()
                WHERE id = $3 AND status = 'pendente' RETURNING *
            `, [nova_data, motivo || 'Solicitação', id]);
            
            if (!resultado.rowCount) return res.status(404).json({ success: false, error: 'Parcela não encontrada ou já paga' });
            
            await registrarLog(req.user?.id, 'PARCELA_REAGENDADA', 'parcelas', id, { nova_data });
            res.json({ success: true, data: resultado.rows[0], message: 'Parcela reagendada!' });
        } catch (error) {
            console.error('[PARCELAS] Erro ao reagendar:', error);
            res.status(500).json({ success: false, error: 'Erro ao reagendar' });
        }
    });

    // GET /api/acordos/parcelas/:id/whatsapp
    router.get('/parcelas/:id/whatsapp', auth, async (req, res) => {
        try {
            const { id } = req.params;
            
            const resultado = await pool.query(`
                SELECT p.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone, a.numero_parcelas, cr.nome as credor_nome
                FROM parcelas p
                JOIN acordos a ON a.id = p.acordo_id
                LEFT JOIN clientes cl ON cl.id = a.cliente_id
                LEFT JOIN credores cr ON cr.id = a.credor_id
                WHERE p.id = $1
            `, [id]);
            
            if (!resultado.rowCount) return res.status(404).json({ success: false, error: 'Parcela não encontrada' });
            
            const p = resultado.rows[0];
            if (!p.cliente_telefone) return res.status(400).json({ success: false, error: 'Cliente sem telefone' });
            
            let telefone = String(p.cliente_telefone).replace(/\D/g, '');
            if (telefone.length <= 11) telefone = '55' + telefone;
            
            const valor = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(p.valor);
            const vencimento = new Date(p.data_vencimento).toLocaleDateString('pt-BR');
            
            const vencida = new Date(p.data_vencimento) < new Date();
            
            let mensagem = vencida
                ? `Olá, *${p.cliente_nome}*!\n\n⚠️ *PARCELA EM ATRASO*\n\n📌 *Parcela:* ${p.numero}/${p.numero_parcelas}\n💰 *Valor:* ${valor}\n📅 *Vencimento:* ${vencimento}\n\nPor favor, regularize.`
                : `Olá, *${p.cliente_nome}*!\n\n📄 *LEMBRETE DE PARCELA*\n\n📌 *Parcela:* ${p.numero}/${p.numero_parcelas}\n💰 *Valor:* ${valor}\n📅 *Vencimento:* ${vencimento}\n\nEvite juros!`;
            
            if (p.asaas_invoice_url) mensagem += `\n\n🔗 *Link:* ${p.asaas_invoice_url}`;
            
            res.json({ success: true, link: `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`, telefone, mensagem });
        } catch (error) {
            console.error('[PARCELAS] Erro WhatsApp:', error);
            res.status(500).json({ success: false, error: 'Erro ao gerar link' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // ACORDOS - Rotas principais
    // ═══════════════════════════════════════════════════════════════

    // GET /api/acordos - Listar acordos
    router.get('/', auth, async (req, res) => {
        try {
            const { status, credor_id, cliente_id, page = 1, limit = 50 } = req.query;
            
            let sql = `
                SELECT a.*, c.descricao as cobranca_descricao, c.valor_original as divida_original,
                       cl.nome as cliente_nome, cl.cpf_cnpj as cliente_cpf, cl.telefone as cliente_telefone,
                       cr.nome as credor_nome,
                       (SELECT COUNT(*)::int FROM parcelas WHERE acordo_id = a.id) as total_parcelas,
                       (SELECT COUNT(*)::int FROM parcelas WHERE acordo_id = a.id AND status = 'pago') as parcelas_pagas,
                       (SELECT MIN(data_vencimento) FROM parcelas WHERE acordo_id = a.id AND status = 'pendente') as proxima_parcela
                FROM acordos a
                LEFT JOIN cobrancas c ON c.id = a.cobranca_id
                LEFT JOIN clientes cl ON cl.id = a.cliente_id
                LEFT JOIN credores cr ON cr.id = a.credor_id
                WHERE 1=1
            `;
            
            const params = [];
            let idx = 1;
            
            if (status) { sql += ` AND a.status = $${idx}`; params.push(status); idx++; }
            if (credor_id) { sql += ` AND a.credor_id = $${idx}`; params.push(credor_id); idx++; }
            if (cliente_id) { sql += ` AND a.cliente_id = $${idx}`; params.push(cliente_id); idx++; }
            
            sql += ` ORDER BY a.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
            
            const resultado = await pool.query(sql, params);
            res.json({ success: true, data: resultado.rows });
            
        } catch (error) {
            console.error('[ACORDOS] Erro ao listar:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar acordos' });
        }
    });

    // POST /api/acordos - Criar acordo
    router.post('/', auth, async (req, res) => {
        const client = await pool.connect();
        
        try {
            const b = req.body || {};
            
            if (!b.cobranca_id && !b.cliente_id) {
                return res.status(400).json({ success: false, error: 'Cobrança ou cliente é obrigatório' });
            }
            if (!b.valor_acordo || parseFloat(b.valor_acordo) <= 0) {
                return res.status(400).json({ success: false, error: 'Valor do acordo é obrigatório' });
            }
            if (!b.numero_parcelas || parseInt(b.numero_parcelas) < 1) {
                return res.status(400).json({ success: false, error: 'Número de parcelas é obrigatório' });
            }
            
            await client.query('BEGIN');
            
            let clienteId = b.cliente_id;
            let credorId = b.credor_id;
            let valorOriginal = b.valor_original || b.valor_acordo;
            
            if (b.cobranca_id) {
                const cobranca = await client.query('SELECT cliente_id, credor_id, valor_atualizado FROM cobrancas WHERE id = $1', [b.cobranca_id]);
                if (cobranca.rowCount > 0) {
                    clienteId = clienteId || cobranca.rows[0].cliente_id;
                    credorId = credorId || cobranca.rows[0].credor_id;
                    valorOriginal = cobranca.rows[0].valor_atualizado || valorOriginal;
                }
            }
            
            const valorAcordo = parseFloat(b.valor_acordo);
            const numParcelas = parseInt(b.numero_parcelas);
            const valorEntrada = parseFloat(b.valor_entrada) || 0;
            const descontoPerc = valorOriginal > 0 ? ((valorOriginal - valorAcordo) / valorOriginal * 100) : 0;
            const valorParcela = numParcelas > 0 ? ((valorAcordo - valorEntrada) / numParcelas) : 0;
            
            const acordo = await client.query(`
                INSERT INTO acordos (cobranca_id, cliente_id, credor_id, valor_original, valor_acordo, desconto_percentual, valor_entrada, numero_parcelas, valor_parcela, data_primeiro_vencimento, observacoes, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ativo', NOW()) RETURNING *
            `, [b.cobranca_id || null, clienteId, credorId || null, valorOriginal, valorAcordo, descontoPerc, valorEntrada, numParcelas, valorParcela, b.data_primeiro_vencimento || new Date(), b.observacoes || null]);
            
            const acordoId = acordo.rows[0].id;
            
            // Criar parcelas
            let dataVenc = new Date(b.data_primeiro_vencimento || Date.now());
            
            for (let i = 1; i <= numParcelas; i++) {
                await client.query(`
                    INSERT INTO parcelas (acordo_id, numero, valor, data_vencimento, status, created_at)
                    VALUES ($1, $2, $3, $4, 'pendente', NOW())
                `, [acordoId, i, Math.round(valorParcela * 100) / 100, dataVenc]);
                
                dataVenc.setMonth(dataVenc.getMonth() + 1);
            }
            
            // Atualizar cobrança original
            if (b.cobranca_id) {
                await client.query('UPDATE cobrancas SET status = \'acordo\', acordo_id = $1, updated_at = NOW() WHERE id = $2', [acordoId, b.cobranca_id]);
            }
            
            await client.query('COMMIT');
            
            await registrarLog(req.user?.id, 'ACORDO_CRIADO', 'acordos', acordoId, { valor: valorAcordo, parcelas: numParcelas });
            
            res.status(201).json({ success: true, data: acordo.rows[0], message: 'Acordo criado com sucesso!' });
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[ACORDOS] Erro ao criar:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar acordo' });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // ROTAS COM :id (devem vir POR ÚLTIMO)
    // ═══════════════════════════════════════════════════════════════

    // GET /api/acordos/:id
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            
            const acordo = await pool.query(`
                SELECT a.*, c.descricao as cobranca_descricao, c.valor_original as divida_original,
                       cl.nome as cliente_nome, cl.cpf_cnpj as cliente_cpf, cl.telefone as cliente_telefone, cl.email as cliente_email,
                       cr.nome as credor_nome, cr.comissao_percentual as credor_comissao
                FROM acordos a
                LEFT JOIN cobrancas c ON c.id = a.cobranca_id
                LEFT JOIN clientes cl ON cl.id = a.cliente_id
                LEFT JOIN credores cr ON cr.id = a.credor_id
                WHERE a.id = $1
            `, [id]);
            
            if (!acordo.rowCount) return res.status(404).json({ success: false, error: 'Acordo não encontrado' });
            
            const parcelas = await pool.query('SELECT * FROM parcelas WHERE acordo_id = $1 ORDER BY numero ASC', [id]);
            
            res.json({ success: true, data: { ...acordo.rows[0], parcelas: parcelas.rows } });
        } catch (error) {
            console.error('[ACORDOS] Erro ao buscar:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar acordo' });
        }
    });

    // PUT /api/acordos/:id
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const b = req.body || {};
            
            const resultado = await pool.query(`
                UPDATE acordos SET observacoes = COALESCE($1, observacoes), status = COALESCE($2, status), updated_at = NOW()
                WHERE id = $3 RETURNING *
            `, [b.observacoes, b.status, id]);
            
            if (!resultado.rowCount) return res.status(404).json({ success: false, error: 'Acordo não encontrado' });
            
            await registrarLog(req.user?.id, 'ACORDO_ATUALIZADO', 'acordos', id, b);
            res.json({ success: true, data: resultado.rows[0] });
        } catch (error) {
            console.error('[ACORDOS] Erro ao atualizar:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar acordo' });
        }
    });

    // PUT /api/acordos/:id/quebrar
    router.put('/:id/quebrar', auth, async (req, res) => {
        const client = await pool.connect();
        
        try {
            const { id } = req.params;
            const { motivo } = req.body || {};
            
            await client.query('BEGIN');
            
            const acordo = await client.query(`
                UPDATE acordos SET status = 'quebrado', observacoes = CONCAT(observacoes, ' | QUEBRADO: ', $1), updated_at = NOW()
                WHERE id = $2 RETURNING cobranca_id
            `, [motivo || 'Não informado', id]);
            
            if (!acordo.rowCount) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Acordo não encontrado' });
            }
            
            // Cancelar parcelas pendentes
            await client.query('UPDATE parcelas SET status = \'cancelado\', updated_at = NOW() WHERE acordo_id = $1 AND status = \'pendente\'', [id]);
            
            // Voltar cobrança para vencido
            if (acordo.rows[0].cobranca_id) {
                await client.query('UPDATE cobrancas SET status = \'vencido\', updated_at = NOW() WHERE id = $1', [acordo.rows[0].cobranca_id]);
            }
            
            await client.query('COMMIT');
            
            await registrarLog(req.user?.id, 'ACORDO_QUEBRADO', 'acordos', id, { motivo });
            res.json({ success: true, message: 'Acordo quebrado. Cobrança voltou para status vencido.' });
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[ACORDOS] Erro ao quebrar:', error);
            res.status(500).json({ success: false, error: 'Erro ao quebrar acordo' });
        } finally {
            client.release();
        }
    });

    return router;
};