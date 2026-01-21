/**
 * ROTAS DE HISTÓRICO - ACERTIVE
 * Consulta de logs e auditoria
 */

const express = require('express');

module.exports = function(pool, auth, authAdmin) {
    const router = express.Router();

    // GET /api/historico - Listar histórico
    router.get('/', auth, async (req, res) => {
        try {
            const { 
                usuario_id, 
                acao, 
                tabela, 
                data_inicio, 
                data_fim,
                page = 1,
                limit = 50
            } = req.query;

            let query = `
                SELECT h.*, u.nome as usuario_nome
                FROM historico h
                LEFT JOIN usuarios u ON h.usuario_id = u.id
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;

            if (usuario_id) {
                query += ` AND h.usuario_id = $${paramIndex}`;
                params.push(usuario_id);
                paramIndex++;
            }

            if (acao) {
                query += ` AND h.acao = $${paramIndex}`;
                params.push(acao);
                paramIndex++;
            }

            if (tabela) {
                query += ` AND h.tabela = $${paramIndex}`;
                params.push(tabela);
                paramIndex++;
            }

            if (data_inicio) {
                query += ` AND h.created_at >= $${paramIndex}`;
                params.push(data_inicio);
                paramIndex++;
            }

            if (data_fim) {
                query += ` AND h.created_at <= $${paramIndex}`;
                params.push(data_fim);
                paramIndex++;
            }

            query += ' ORDER BY h.created_at DESC';

            // Paginação
            const offset = (parseInt(page) - 1) * parseInt(limit);
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), offset);

            const result = await pool.query(query, params);

            // Contar total
            let countQuery = 'SELECT COUNT(*) FROM historico WHERE 1=1';
            const countParams = [];
            let countIndex = 1;

            if (usuario_id) {
                countQuery += ` AND usuario_id = $${countIndex}`;
                countParams.push(usuario_id);
                countIndex++;
            }

            if (acao) {
                countQuery += ` AND acao = $${countIndex}`;
                countParams.push(acao);
                countIndex++;
            }

            const countResult = await pool.query(countQuery, countParams);
            const total = parseInt(countResult.rows[0].count);

            res.json({
                historico: result.rows,
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            });

        } catch (error) {
            console.error('Erro ao listar histórico:', error);
            res.status(500).json({ error: 'Erro ao listar histórico' });
        }
    });

    // GET /api/historico/acoes - Listar tipos de ações
    router.get('/acoes', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT DISTINCT acao, COUNT(*) as total
                FROM historico
                GROUP BY acao
                ORDER BY total DESC
            `);
            res.json(result.rows);
        } catch (error) {
            console.error('Erro ao listar ações:', error);
            res.status(500).json({ error: 'Erro ao listar ações' });
        }
    });

    // GET /api/historico/registro/:tabela/:id - Histórico de um registro específico
    router.get('/registro/:tabela/:id', auth, async (req, res) => {
        try {
            const { tabela, id } = req.params;

            const result = await pool.query(`
                SELECT h.*, u.nome as usuario_nome
                FROM historico h
                LEFT JOIN usuarios u ON h.usuario_id = u.id
                WHERE h.tabela = $1 AND h.registro_id = $2
                ORDER BY h.created_at DESC
            `, [tabela, id]);

            res.json(result.rows);

        } catch (error) {
            console.error('Erro ao buscar histórico do registro:', error);
            res.status(500).json({ error: 'Erro ao buscar histórico' });
        }
    });

    // DELETE /api/historico/limpar - Limpar histórico antigo (admin)
    router.delete('/limpar', authAdmin, async (req, res) => {
        try {
            const { dias = 90 } = req.query;

            const result = await pool.query(`
                DELETE FROM historico
                WHERE created_at < NOW() - INTERVAL '${parseInt(dias)} days'
                RETURNING id
            `);

            res.json({
                success: true,
                registros_removidos: result.rowCount
            });

        } catch (error) {
            console.error('Erro ao limpar histórico:', error);
            res.status(500).json({ error: 'Erro ao limpar histórico' });
        }
    });

    return router;
};
