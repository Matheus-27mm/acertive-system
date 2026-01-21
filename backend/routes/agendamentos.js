/**
 * ROTAS DE AGENDAMENTOS - ACERTIVE
 * CRUD de agendamentos de contato
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/agendamentos - Listar agendamentos
    router.get('/', auth, async (req, res) => {
        try {
            const { data_inicio, data_fim, status, cliente_id } = req.query;

            let query = `
                SELECT a.*, 
                       cl.nome as cliente_nome,
                       cl.telefone as cliente_telefone
                FROM agendamentos a
                LEFT JOIN clientes cl ON a.cliente_id = cl.id
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;

            if (data_inicio) {
                query += ` AND a.data_agendamento >= $${paramIndex}`;
                params.push(data_inicio);
                paramIndex++;
            }

            if (data_fim) {
                query += ` AND a.data_agendamento <= $${paramIndex}`;
                params.push(data_fim);
                paramIndex++;
            }

            if (status) {
                query += ` AND a.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (cliente_id) {
                query += ` AND a.cliente_id = $${paramIndex}`;
                params.push(cliente_id);
                paramIndex++;
            }

            query += ' ORDER BY a.data_agendamento ASC, a.hora ASC';

            const result = await pool.query(query, params);
            res.json(result.rows);

        } catch (error) {
            console.error('Erro ao listar agendamentos:', error);
            res.status(500).json({ error: 'Erro ao listar agendamentos' });
        }
    });

    // GET /api/agendamentos/hoje - Agendamentos de hoje
    router.get('/hoje', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT a.*, 
                       cl.nome as cliente_nome,
                       cl.telefone as cliente_telefone
                FROM agendamentos a
                LEFT JOIN clientes cl ON a.cliente_id = cl.id
                WHERE a.data_agendamento = CURRENT_DATE
                  AND a.status = 'pendente'
                ORDER BY a.hora ASC
            `);
            res.json(result.rows);
        } catch (error) {
            console.error('Erro ao listar agendamentos de hoje:', error);
            res.status(500).json({ error: 'Erro ao listar agendamentos' });
        }
    });

    // GET /api/agendamentos/semana - Agendamentos da semana
    router.get('/semana', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT a.*, 
                       cl.nome as cliente_nome,
                       cl.telefone as cliente_telefone
                FROM agendamentos a
                LEFT JOIN clientes cl ON a.cliente_id = cl.id
                WHERE a.data_agendamento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
                  AND a.status = 'pendente'
                ORDER BY a.data_agendamento ASC, a.hora ASC
            `);
            res.json(result.rows);
        } catch (error) {
            console.error('Erro ao listar agendamentos da semana:', error);
            res.status(500).json({ error: 'Erro ao listar agendamentos' });
        }
    });

    // GET /api/agendamentos/:id - Buscar agendamento
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query(`
                SELECT a.*, 
                       cl.nome as cliente_nome,
                       cl.telefone as cliente_telefone
                FROM agendamentos a
                LEFT JOIN clientes cl ON a.cliente_id = cl.id
                WHERE a.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Agendamento não encontrado' });
            }

            res.json(result.rows[0]);
        } catch (error) {
            console.error('Erro ao buscar agendamento:', error);
            res.status(500).json({ error: 'Erro ao buscar agendamento' });
        }
    });

    // POST /api/agendamentos - Criar agendamento
    router.post('/', auth, async (req, res) => {
        try {
            const { 
                cliente_id, 
                data_agendamento, 
                hora, 
                tipo,  // 'ligacao', 'whatsapp', 'email', 'visita'
                descricao,
                cobranca_id
            } = req.body;

            if (!data_agendamento) {
                return res.status(400).json({ error: 'Data é obrigatória' });
            }

            const result = await pool.query(`
                INSERT INTO agendamentos (
                    cliente_id, data_agendamento, hora, tipo, 
                    descricao, cobranca_id, status, usuario_id, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7, NOW())
                RETURNING *
            `, [cliente_id, data_agendamento, hora, tipo, descricao, cobranca_id, req.user?.id]);

            await registrarLog(req.user?.id, 'AGENDAMENTO_CRIADO', 'agendamentos', result.rows[0].id, {
                data: data_agendamento,
                tipo
            });

            res.status(201).json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao criar agendamento:', error);
            res.status(500).json({ error: 'Erro ao criar agendamento' });
        }
    });

    // PUT /api/agendamentos/:id - Atualizar agendamento
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { data_agendamento, hora, tipo, descricao, status } = req.body;

            const result = await pool.query(`
                UPDATE agendamentos SET
                    data_agendamento = COALESCE($2, data_agendamento),
                    hora = COALESCE($3, hora),
                    tipo = COALESCE($4, tipo),
                    descricao = COALESCE($5, descricao),
                    status = COALESCE($6, status),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `, [id, data_agendamento, hora, tipo, descricao, status]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Agendamento não encontrado' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao atualizar agendamento:', error);
            res.status(500).json({ error: 'Erro ao atualizar agendamento' });
        }
    });

    // PUT /api/agendamentos/:id/concluir - Marcar como concluído
    router.put('/:id/concluir', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { observacao } = req.body;

            const result = await pool.query(`
                UPDATE agendamentos SET
                    status = 'concluido',
                    observacao = $2,
                    data_conclusao = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `, [id, observacao]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Agendamento não encontrado' });
            }

            await registrarLog(req.user?.id, 'AGENDAMENTO_CONCLUIDO', 'agendamentos', id, {
                observacao
            });

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao concluir agendamento:', error);
            res.status(500).json({ error: 'Erro ao concluir agendamento' });
        }
    });

    // DELETE /api/agendamentos/:id - Remover agendamento
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            await pool.query('DELETE FROM agendamentos WHERE id = $1', [id]);
            res.json({ success: true });
        } catch (error) {
            console.error('Erro ao remover agendamento:', error);
            res.status(500).json({ error: 'Erro ao remover agendamento' });
        }
    });

    return router;
};
