/**
 * ROTAS DE REPASSES - ACERTIVE
 * Gerenciamento de repasses para credores
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/repasses - Listar repasses
    router.get('/', auth, async (req, res) => {
        try {
            const { credor_id, status, mes, ano } = req.query;
            
            let query = `
                SELECT 
                    r.*,
                    cr.nome as credor_nome
                FROM repasses r
                LEFT JOIN credores cr ON r.credor_id = cr.id
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;

            if (credor_id) {
                query += ` AND r.credor_id = $${paramIndex}`;
                params.push(credor_id);
                paramIndex++;
            }

            if (status) {
                query += ` AND r.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (mes && ano) {
                query += ` AND EXTRACT(MONTH FROM r.created_at) = $${paramIndex}`;
                params.push(mes);
                paramIndex++;
                query += ` AND EXTRACT(YEAR FROM r.created_at) = $${paramIndex}`;
                params.push(ano);
                paramIndex++;
            }

            query += ' ORDER BY r.created_at DESC';

            const result = await pool.query(query, params);
            res.json(result.rows);

        } catch (error) {
            console.error('Erro ao listar repasses:', error);
            res.status(500).json({ error: 'Erro ao listar repasses' });
        }
    });

    // GET /api/repasses/estatisticas - Estatísticas de repasses
    router.get('/estatisticas', auth, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesAtual = mes || new Date().getMonth() + 1;
            const anoAtual = ano || new Date().getFullYear();

            const stats = await pool.query(`
                SELECT 
                    COALESCE(SUM(valor), 0) as total_mes,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0) as total_pago,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pendente'), 0) as total_pendente,
                    COUNT(DISTINCT credor_id) FILTER (WHERE status = 'pendente') as credores_pendentes
                FROM repasses
                WHERE EXTRACT(MONTH FROM created_at) = $1
                  AND EXTRACT(YEAR FROM created_at) = $2
            `, [mesAtual, anoAtual]);

            res.json(stats.rows[0]);

        } catch (error) {
            console.error('Erro ao buscar estatísticas:', error);
            res.status(500).json({ error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/repasses/pendentes - Repasses pendentes por credor
    router.get('/pendentes', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    cr.id as credor_id,
                    cr.nome as credor_nome,
                    COALESCE(SUM(p.valor_pago), 0) as valor_recuperado,
                    COALESCE(SUM(p.valor_pago * COALESCE(cr.taxa_comissao, 10) / 100), 0) as comissao,
                    COALESCE(SUM(p.valor_pago) - SUM(p.valor_pago * COALESCE(cr.taxa_comissao, 10) / 100), 0) as valor_repassar
                FROM credores cr
                LEFT JOIN cobrancas c ON c.credor_id = cr.id
                LEFT JOIN parcelas p ON p.cobranca_id = c.id AND p.status = 'pago'
                LEFT JOIN repasses r ON r.credor_id = cr.id AND r.status = 'pago'
                GROUP BY cr.id, cr.nome
                HAVING COALESCE(SUM(p.valor_pago), 0) > 0
                ORDER BY valor_repassar DESC
            `);

            res.json(result.rows);

        } catch (error) {
            console.error('Erro ao buscar pendentes:', error);
            res.status(500).json({ error: 'Erro ao buscar pendentes' });
        }
    });

    // GET /api/repasses/:id - Buscar repasse por ID
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT 
                    r.*,
                    cr.nome as credor_nome
                FROM repasses r
                LEFT JOIN credores cr ON r.credor_id = cr.id
                WHERE r.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Repasse não encontrado' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao buscar repasse:', error);
            res.status(500).json({ error: 'Erro ao buscar repasse' });
        }
    });

    // POST /api/repasses - Criar repasse
    router.post('/', auth, async (req, res) => {
        try {
            const { credor_id, valor_recuperado, comissao, valor, forma_pagamento, observacao } = req.body;

            const result = await pool.query(`
                INSERT INTO repasses (credor_id, valor_recuperado, comissao, valor, forma_pagamento, observacao, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW())
                RETURNING *
            `, [credor_id, valor_recuperado, comissao, valor, forma_pagamento, observacao]);

            await registrarLog(req.user.id, 'REPASSE_CRIADO', 'repasses', result.rows[0].id, { valor, credor_id });

            res.status(201).json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao criar repasse:', error);
            res.status(500).json({ error: 'Erro ao criar repasse' });
        }
    });

    // PUT /api/repasses/:id - Atualizar repasse
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { status, data_pagamento, comprovante, observacao } = req.body;

            const result = await pool.query(`
                UPDATE repasses 
                SET status = COALESCE($1, status),
                    data_pagamento = COALESCE($2, data_pagamento),
                    comprovante = COALESCE($3, comprovante),
                    observacao = COALESCE($4, observacao),
                    updated_at = NOW()
                WHERE id = $5
                RETURNING *
            `, [status, data_pagamento, comprovante, observacao, id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Repasse não encontrado' });
            }

            await registrarLog(req.user.id, 'REPASSE_ATUALIZADO', 'repasses', id, { status });

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao atualizar repasse:', error);
            res.status(500).json({ error: 'Erro ao atualizar repasse' });
        }
    });

    // POST /api/repasses/:id/pagar - Marcar repasse como pago
    router.post('/:id/pagar', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { comprovante } = req.body;

            const result = await pool.query(`
                UPDATE repasses 
                SET status = 'pago',
                    data_pagamento = NOW(),
                    comprovante = $1,
                    updated_at = NOW()
                WHERE id = $2
                RETURNING *
            `, [comprovante, id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Repasse não encontrado' });
            }

            await registrarLog(req.user.id, 'REPASSE_PAGO', 'repasses', id, {});

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao pagar repasse:', error);
            res.status(500).json({ error: 'Erro ao pagar repasse' });
        }
    });

    // POST /api/repasses/calcular - Calcular pendentes para um credor
    router.post('/calcular', auth, async (req, res) => {
        try {
            const { credor_id } = req.body;

            const result = await pool.query(`
                SELECT 
                    COALESCE(SUM(p.valor_pago), 0) as valor_recuperado,
                    COALESCE(SUM(p.valor_pago * COALESCE(cr.taxa_comissao, 10) / 100), 0) as comissao,
                    COALESCE(SUM(p.valor_pago) - SUM(p.valor_pago * COALESCE(cr.taxa_comissao, 10) / 100), 0) as valor_repassar
                FROM credores cr
                LEFT JOIN cobrancas c ON c.credor_id = cr.id
                LEFT JOIN parcelas p ON p.cobranca_id = c.id AND p.status = 'pago'
                WHERE cr.id = $1
            `, [credor_id]);

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao calcular repasse:', error);
            res.status(500).json({ error: 'Erro ao calcular repasse' });
        }
    });

    // DELETE /api/repasses/:id - Excluir repasse
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query('DELETE FROM repasses WHERE id = $1 RETURNING *', [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Repasse não encontrado' });
            }

            await registrarLog(req.user.id, 'REPASSE_EXCLUIDO', 'repasses', id, {});

            res.json({ success: true, message: 'Repasse excluído' });

        } catch (error) {
            console.error('Erro ao excluir repasse:', error);
            res.status(500).json({ error: 'Erro ao excluir repasse' });
        }
    });

    return router;
};