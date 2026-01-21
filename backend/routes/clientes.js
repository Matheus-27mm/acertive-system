/**
 * ROTAS DE CLIENTES (DEVEDORES) - ACERTIVE
 * CRUD de clientes/devedores
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/clientes - Listar clientes
    router.get('/', auth, async (req, res) => {
        try {
            const { busca, status, page = 1, limit = 50 } = req.query;

            let query = `
                SELECT c.*,
                       COUNT(cb.id) as total_cobrancas,
                       COALESCE(SUM(CASE WHEN cb.status = 'pendente' THEN cb.valor ELSE 0 END), 0) as divida_pendente,
                       COALESCE(SUM(CASE WHEN cb.status = 'pago' THEN cb.valor ELSE 0 END), 0) as total_pago
                FROM clientes c
                LEFT JOIN cobrancas cb ON c.id = cb.cliente_id
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;

            if (busca) {
                query += ` AND (c.nome ILIKE $${paramIndex} OR c.cpf_cnpj ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex})`;
                params.push(`%${busca}%`);
                paramIndex++;
            }

            if (status) {
                query += ` AND c.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            query += ' GROUP BY c.id ORDER BY c.nome';

            // Paginação
            const offset = (parseInt(page) - 1) * parseInt(limit);
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), offset);

            const result = await pool.query(query, params);

            // Contar total
            let countQuery = 'SELECT COUNT(*) FROM clientes WHERE 1=1';
            const countParams = [];
            
            if (busca) {
                countQuery += ` AND (nome ILIKE $1 OR cpf_cnpj ILIKE $1 OR email ILIKE $1)`;
                countParams.push(`%${busca}%`);
            }

            const countResult = await pool.query(countQuery, countParams);
            const total = parseInt(countResult.rows[0].count);

            res.json({
                clientes: result.rows,
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            });

        } catch (error) {
            console.error('Erro ao listar clientes:', error);
            res.status(500).json({ error: 'Erro ao listar clientes' });
        }
    });

    // GET /api/clientes/buscar - Buscar clientes para autocomplete
    router.get('/buscar', auth, async (req, res) => {
        try {
            const { q } = req.query;

            if (!q || q.length < 2) {
                return res.json([]);
            }

            const result = await pool.query(`
                SELECT id, nome, cpf_cnpj, telefone, email
                FROM clientes
                WHERE nome ILIKE $1 OR cpf_cnpj ILIKE $1
                ORDER BY nome
                LIMIT 20
            `, [`%${q}%`]);

            res.json(result.rows);

        } catch (error) {
            console.error('Erro ao buscar clientes:', error);
            res.status(500).json({ error: 'Erro ao buscar clientes' });
        }
    });

    // GET /api/clientes/ativos - Listar clientes ativos (para select)
    router.get('/ativos', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT id, nome, cpf_cnpj, telefone
                FROM clientes
                WHERE status = 'ativo' OR status IS NULL
                ORDER BY nome
            `);
            res.json(result.rows);
        } catch (error) {
            console.error('Erro ao listar clientes ativos:', error);
            res.status(500).json({ error: 'Erro ao listar clientes' });
        }
    });

    // GET /api/clientes/:id - Buscar cliente específico
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT c.*,
                       COUNT(cb.id) as total_cobrancas,
                       COALESCE(SUM(CASE WHEN cb.status = 'pendente' THEN cb.valor ELSE 0 END), 0) as divida_pendente
                FROM clientes c
                LEFT JOIN cobrancas cb ON c.id = cb.cliente_id
                WHERE c.id = $1
                GROUP BY c.id
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Cliente não encontrado' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao buscar cliente:', error);
            res.status(500).json({ error: 'Erro ao buscar cliente' });
        }
    });

    // GET /api/clientes/:id/completo - Cliente com todas as cobranças
    router.get('/:id/completo', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Dados do cliente
            const cliente = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
            
            if (cliente.rows.length === 0) {
                return res.status(404).json({ error: 'Cliente não encontrado' });
            }

            // Cobranças do cliente
            const cobrancas = await pool.query(`
                SELECT c.*, cr.nome as credor_nome
                FROM cobrancas c
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.cliente_id = $1
                ORDER BY c.data_vencimento DESC
            `, [id]);

            // Acordos do cliente
            const acordos = await pool.query(`
                SELECT a.*, cr.nome as credor_nome
                FROM acordos a
                LEFT JOIN credores cr ON a.credor_id = cr.id
                WHERE a.cliente_id = $1
                ORDER BY a.created_at DESC
            `, [id]);

            // Estatísticas
            const stats = await pool.query(`
                SELECT 
                    COUNT(*) as total_cobrancas,
                    COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
                    COUNT(*) FILTER (WHERE status = 'pago') as pagas,
                    COALESCE(SUM(valor), 0) as valor_total,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pendente'), 0) as divida_pendente
                FROM cobrancas WHERE cliente_id = $1
            `, [id]);

            res.json({
                cliente: cliente.rows[0],
                cobrancas: cobrancas.rows,
                acordos: acordos.rows,
                estatisticas: stats.rows[0]
            });

        } catch (error) {
            console.error('Erro ao buscar cliente completo:', error);
            res.status(500).json({ error: 'Erro ao buscar cliente' });
        }
    });

    // POST /api/clientes - Criar cliente
    router.post('/', auth, async (req, res) => {
        try {
            const {
                nome,
                cpf_cnpj,
                telefone,
                email,
                endereco,
                cidade,
                estado,
                cep,
                data_nascimento,
                observacoes
            } = req.body;

            if (!nome) {
                return res.status(400).json({ error: 'Nome é obrigatório' });
            }

            // Verificar CPF/CNPJ duplicado
            if (cpf_cnpj) {
                const existe = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpf_cnpj]);
                if (existe.rows.length > 0) {
                    return res.status(400).json({ error: 'CPF/CNPJ já cadastrado' });
                }
            }

            const result = await pool.query(`
                INSERT INTO clientes (
                    nome, cpf_cnpj, telefone, email, endereco,
                    cidade, estado, cep, data_nascimento, observacoes,
                    status, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ativo', NOW())
                RETURNING *
            `, [nome, cpf_cnpj, telefone, email, endereco, cidade, estado, cep, data_nascimento, observacoes]);

            await registrarLog(req.user?.id, 'CLIENTE_CRIADO', 'clientes', result.rows[0].id, { nome });

            res.status(201).json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao criar cliente:', error);
            res.status(500).json({ error: 'Erro ao criar cliente' });
        }
    });

    // PUT /api/clientes/:id - Atualizar cliente
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const {
                nome,
                cpf_cnpj,
                telefone,
                email,
                endereco,
                cidade,
                estado,
                cep,
                data_nascimento,
                observacoes,
                status
            } = req.body;

            const result = await pool.query(`
                UPDATE clientes SET
                    nome = COALESCE($2, nome),
                    cpf_cnpj = COALESCE($3, cpf_cnpj),
                    telefone = COALESCE($4, telefone),
                    email = COALESCE($5, email),
                    endereco = COALESCE($6, endereco),
                    cidade = COALESCE($7, cidade),
                    estado = COALESCE($8, estado),
                    cep = COALESCE($9, cep),
                    data_nascimento = COALESCE($10, data_nascimento),
                    observacoes = COALESCE($11, observacoes),
                    status = COALESCE($12, status),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `, [id, nome, cpf_cnpj, telefone, email, endereco, cidade, estado, cep, data_nascimento, observacoes, status]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Cliente não encontrado' });
            }

            await registrarLog(req.user?.id, 'CLIENTE_ATUALIZADO', 'clientes', id, {});

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao atualizar cliente:', error);
            res.status(500).json({ error: 'Erro ao atualizar cliente' });
        }
    });

    // PUT /api/clientes/:id/status - Atualizar status do cliente
    router.put('/:id/status', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;

            const result = await pool.query(`
                UPDATE clientes SET status = $2, updated_at = NOW()
                WHERE id = $1 RETURNING *
            `, [id, status]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Cliente não encontrado' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao atualizar status:', error);
            res.status(500).json({ error: 'Erro ao atualizar status' });
        }
    });

    // DELETE /api/clientes/:id - Remover cliente
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Verificar se tem cobranças vinculadas
            const cobrancas = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE cliente_id = $1', [id]);
            
            if (parseInt(cobrancas.rows[0].count) > 0) {
                return res.status(400).json({ 
                    error: 'Não é possível remover cliente com cobranças vinculadas. Inative-o ao invés disso.' 
                });
            }

            await pool.query('DELETE FROM clientes WHERE id = $1', [id]);

            await registrarLog(req.user?.id, 'CLIENTE_REMOVIDO', 'clientes', id, {});

            res.json({ success: true });

        } catch (error) {
            console.error('Erro ao remover cliente:', error);
            res.status(500).json({ error: 'Erro ao remover cliente' });
        }
    });

    return router;
};
