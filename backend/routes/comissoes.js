/**
 * ROTAS DE COMISSÕES - ACERTIVE
 * Gerenciamento de comissões de cobrança
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/comissoes - Listar comissões
    router.get('/', auth, async (req, res) => {
        try {
            const { credor_id, status, mes, ano } = req.query;
            
            let query = `
                SELECT 
                    c.*,
                    cr.nome as credor_nome,
                    a.id as acordo_id
                FROM comissoes c
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN acordos a ON c.acordo_id = a.id
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;

            if (credor_id) {
                query += ` AND c.credor_id = $${paramIndex}`;
                params.push(credor_id);
                paramIndex++;
            }

            if (status) {
                query += ` AND c.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (mes && ano) {
                query += ` AND EXTRACT(MONTH FROM c.created_at) = $${paramIndex}`;
                params.push(mes);
                paramIndex++;
                query += ` AND EXTRACT(YEAR FROM c.created_at) = $${paramIndex}`;
                params.push(ano);
                paramIndex++;
            }

            query += ' ORDER BY c.created_at DESC';

            const result = await pool.query(query, params);
            res.json(result.rows);

        } catch (error) {
            console.error('Erro ao listar comissões:', error);
            res.status(500).json({ error: 'Erro ao listar comissões' });
        }
    });

    // GET /api/comissoes/estatisticas - Estatísticas de comissões
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
                    COUNT(*) as quantidade
                FROM comissoes
                WHERE EXTRACT(MONTH FROM created_at) = $1
                  AND EXTRACT(YEAR FROM created_at) = $2
            `, [mesAtual, anoAtual]);

            res.json(stats.rows[0]);

        } catch (error) {
            console.error('Erro ao buscar estatísticas:', error);
            res.status(500).json({ error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/comissoes/:id - Buscar comissão por ID
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT 
                    c.*,
                    cr.nome as credor_nome,
                    a.id as acordo_id
                FROM comissoes c
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN acordos a ON c.acordo_id = a.id
                WHERE c.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Comissão não encontrada' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao buscar comissão:', error);
            res.status(500).json({ error: 'Erro ao buscar comissão' });
        }
    });

    // POST /api/comissoes - Criar comissão
    router.post('/', auth, async (req, res) => {
        try {
            const { credor_id, acordo_id, parcela_id, valor_base, taxa, valor, descricao } = req.body;

            const result = await pool.query(`
                INSERT INTO comissoes (credor_id, acordo_id, parcela_id, valor_base, taxa, valor, descricao, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente', NOW())
                RETURNING *
            `, [credor_id, acordo_id, parcela_id, valor_base, taxa, valor, descricao]);

            await registrarLog(req.user.id, 'COMISSAO_CRIADA', 'comissoes', result.rows[0].id, { valor });

            res.status(201).json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao criar comissão:', error);
            res.status(500).json({ error: 'Erro ao criar comissão' });
        }
    });

    // PUT /api/comissoes/:id - Atualizar comissão
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { status, data_pagamento, observacao } = req.body;

            const result = await pool.query(`
                UPDATE comissoes 
                SET status = COALESCE($1, status),
                    data_pagamento = COALESCE($2, data_pagamento),
                    observacao = COALESCE($3, observacao),
                    updated_at = NOW()
                WHERE id = $4
                RETURNING *
            `, [status, data_pagamento, observacao, id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Comissão não encontrada' });
            }

            await registrarLog(req.user.id, 'COMISSAO_ATUALIZADA', 'comissoes', id, { status });

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao atualizar comissão:', error);
            res.status(500).json({ error: 'Erro ao atualizar comissão' });
        }
    });

    // POST /api/comissoes/:id/pagar - Marcar comissão como paga
    router.post('/:id/pagar', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                UPDATE comissoes 
                SET status = 'pago',
                    data_pagamento = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Comissão não encontrada' });
            }

            await registrarLog(req.user.id, 'COMISSAO_PAGA', 'comissoes', id, {});

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao pagar comissão:', error);
            res.status(500).json({ error: 'Erro ao pagar comissão' });
        }
    });

    // DELETE /api/comissoes/:id - Excluir comissão
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query('DELETE FROM comissoes WHERE id = $1 RETURNING *', [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Comissão não encontrada' });
            }

            await registrarLog(req.user.id, 'COMISSAO_EXCLUIDA', 'comissoes', id, {});

            res.json({ success: true, message: 'Comissão excluída' });

        } catch (error) {
            console.error('Erro ao excluir comissão:', error);
            res.status(500).json({ error: 'Erro ao excluir comissão' });
        }
    });

    return router;
};