/**
 * ROTAS DE CLIENTES (DEVEDORES) - ACERTIVE
 * CRUD de clientes/devedores
 * ATUALIZADO: Formato de resposta compatível com frontend
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/clientes - Listar clientes
    router.get('/', auth, async (req, res) => {
        try {
            const { busca, search, status, page = 1, limit = 50 } = req.query;
            const searchTerm = busca || search; // Aceita ambos os parâmetros

            let query = `
                SELECT c.*,
                       COUNT(cb.id) as total_cobrancas,
                       COUNT(cb.id) as qtd_cobrancas,
                       COALESCE(SUM(CASE WHEN cb.status = 'pendente' THEN cb.valor ELSE 0 END), 0) as divida_pendente,
                       COALESCE(SUM(CASE WHEN cb.status = 'pago' THEN cb.valor ELSE 0 END), 0) as total_pago
                FROM clientes c
                LEFT JOIN cobrancas cb ON c.id = cb.cliente_id
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;

            if (searchTerm) {
                query += ` AND (c.nome ILIKE $${paramIndex} OR c.cpf_cnpj ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.telefone ILIKE $${paramIndex})`;
                params.push(`%${searchTerm}%`);
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
            let countIndex = 1;
            
            if (searchTerm) {
                countQuery += ` AND (nome ILIKE $${countIndex} OR cpf_cnpj ILIKE $${countIndex} OR email ILIKE $${countIndex} OR telefone ILIKE $${countIndex})`;
                countParams.push(`%${searchTerm}%`);
                countIndex++;
            }

            if (status) {
                countQuery += ` AND status = $${countIndex}`;
                countParams.push(status);
            }

            const countResult = await pool.query(countQuery, countParams);
            const total = parseInt(countResult.rows[0].count);

            // Estatísticas
            const statsResult = await pool.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'ativo' OR status IS NULL) as ativos,
                    COUNT(*) FILTER (WHERE status = 'inativo') as inativos,
                    COUNT(*) FILTER (WHERE status = 'negativado') as negativados
                FROM clientes
            `);

            const cobrancasStats = await pool.query(`
                SELECT COUNT(DISTINCT cliente_id) as com_cobrancas,
                       COUNT(*) as total_cobrancas
                FROM cobrancas
            `);

            const acordosStats = await pool.query(`
                SELECT COUNT(DISTINCT cliente_id) as com_acordo
                FROM acordos
                WHERE status = 'ativo'
            `);

            const stats = {
                total: parseInt(statsResult.rows[0].total) || 0,
                ativos: parseInt(statsResult.rows[0].ativos) || 0,
                inativos: parseInt(statsResult.rows[0].inativos) || 0,
                negativados: parseInt(statsResult.rows[0].negativados) || 0,
                totalCobrancas: parseInt(cobrancasStats.rows[0].total_cobrancas) || 0,
                comAcordo: parseInt(acordosStats.rows[0].com_acordo) || 0
            };

            // FORMATO COMPATÍVEL COM FRONTEND
            res.json({
                success: true,
                data: result.rows,
                stats,
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            });

        } catch (error) {
            console.error('Erro ao listar clientes:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar clientes' });
        }
    });

    // GET /api/clientes/estatisticas - Estatísticas de clientes
    router.get('/estatisticas', auth, async (req, res) => {
        try {
            const statsResult = await pool.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'ativo' OR status IS NULL) as ativos,
                    COUNT(*) FILTER (WHERE status = 'inativo') as inativos,
                    COUNT(*) FILTER (WHERE status = 'negativado') as negativados
                FROM clientes
            `);

            const cobrancasStats = await pool.query(`
                SELECT COUNT(DISTINCT cliente_id) as com_cobrancas,
                       COUNT(*) as total_cobrancas
                FROM cobrancas
            `);

            const acordosStats = await pool.query(`
                SELECT COUNT(DISTINCT cliente_id) as com_acordo
                FROM acordos
                WHERE status = 'ativo'
            `);

            res.json({
                success: true,
                data: {
                    total: parseInt(statsResult.rows[0].total) || 0,
                    ativos: parseInt(statsResult.rows[0].ativos) || 0,
                    inativos: parseInt(statsResult.rows[0].inativos) || 0,
                    negativados: parseInt(statsResult.rows[0].negativados) || 0,
                    totalCobrancas: parseInt(cobrancasStats.rows[0].total_cobrancas) || 0,
                    comAcordo: parseInt(acordosStats.rows[0].com_acordo) || 0
                }
            });

        } catch (error) {
            console.error('Erro ao buscar estatísticas:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/clientes/buscar - Buscar clientes para autocomplete
    router.get('/buscar', auth, async (req, res) => {
        try {
            const { q } = req.query;

            if (!q || q.length < 2) {
                return res.json({ success: true, data: [] });
            }

            const result = await pool.query(`
                SELECT id, nome, cpf_cnpj, telefone, email
                FROM clientes
                WHERE nome ILIKE $1 OR cpf_cnpj ILIKE $1
                ORDER BY nome
                LIMIT 20
            `, [`%${q}%`]);

            res.json({ success: true, data: result.rows });

        } catch (error) {
            console.error('Erro ao buscar clientes:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar clientes' });
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
            res.json({ success: true, data: result.rows });
        } catch (error) {
            console.error('Erro ao listar clientes ativos:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar clientes' });
        }
    });

    // GET /api/clientes/:id - Buscar cliente específico
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Evitar conflito com outras rotas
            if (['estatisticas', 'buscar', 'ativos'].includes(id)) {
                return;
            }

            const result = await pool.query(`
                SELECT c.*,
                       COUNT(cb.id) as total_cobrancas,
                       COUNT(cb.id) as qtd_cobrancas,
                       COALESCE(SUM(CASE WHEN cb.status = 'pendente' THEN cb.valor ELSE 0 END), 0) as divida_pendente
                FROM clientes c
                LEFT JOIN cobrancas cb ON c.id = cb.cliente_id
                WHERE c.id = $1::uuid
                GROUP BY c.id
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error('Erro ao buscar cliente:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar cliente' });
        }
    });

    // GET /api/clientes/:id/completo - Cliente com todas as cobranças
    router.get('/:id/completo', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Dados do cliente
            const cliente = await pool.query('SELECT * FROM clientes WHERE id = $1::uuid', [id]);
            
            if (cliente.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            // Cobranças do cliente
            const cobrancas = await pool.query(`
                SELECT c.*, cr.nome as credor_nome
                FROM cobrancas c
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.cliente_id = $1::uuid
                ORDER BY c.data_vencimento DESC
            `, [id]);

            // Acordos do cliente
            let acordos = { rows: [] };
            try {
                acordos = await pool.query(`
                    SELECT a.*, cr.nome as credor_nome
                    FROM acordos a
                    LEFT JOIN credores cr ON a.credor_id = cr.id
                    WHERE a.cliente_id = $1::uuid
                    ORDER BY a.created_at DESC
                `, [id]);
            } catch (e) {
                console.log('Tabela acordos não existe ou erro:', e.message);
            }

            // Estatísticas
            const stats = await pool.query(`
                SELECT 
                    COUNT(*) as total_cobrancas,
                    COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
                    COUNT(*) FILTER (WHERE status = 'pago') as pagas,
                    COALESCE(SUM(valor), 0) as valor_total,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pendente'), 0) as divida_pendente
                FROM cobrancas WHERE cliente_id = $1::uuid
            `, [id]);

            res.json({
                success: true,
                data: {
                    cliente: cliente.rows[0],
                    cobrancas: cobrancas.rows,
                    acordos: acordos.rows,
                    estatisticas: stats.rows[0]
                }
            });

        } catch (error) {
            console.error('Erro ao buscar cliente completo:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar cliente' });
        }
    });

    // POST /api/clientes - Criar cliente
    router.post('/', auth, async (req, res) => {
        try {
            console.log('[CLIENTES] Criando cliente:', req.body);
            
            const {
                nome,
                cpf_cnpj,
                telefone,
                celular,
                email,
                endereco,
                cidade,
                estado,
                cep,
                bairro,
                numero,
                complemento,
                data_nascimento,
                observacoes,
                tipo
            } = req.body;

            if (!nome) {
                return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
            }

            // Verificar CPF/CNPJ duplicado (se informado)
            if (cpf_cnpj) {
                const existe = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpf_cnpj]);
                if (existe.rows.length > 0) {
                    return res.status(400).json({ success: false, error: 'CPF/CNPJ já cadastrado' });
                }
            }

            // Usar telefone ou celular
            const telefoneVal = telefone || celular || null;

            const result = await pool.query(`
                INSERT INTO clientes (
                    nome, cpf_cnpj, telefone, email, endereco,
                    cidade, estado, cep, data_nascimento, observacoes,
                    status, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ativo', NOW(), NOW())
                RETURNING *
            `, [nome, cpf_cnpj || null, telefoneVal, email || null, endereco || null, 
                cidade || null, estado || null, cep || null, data_nascimento || null, observacoes || null]);

            console.log('[CLIENTES] Cliente criado:', result.rows[0].id);

            try {
                await registrarLog(req.user?.id, 'CLIENTE_CRIADO', 'clientes', result.rows[0].id, { nome });
            } catch (logErr) {
                console.error('Erro ao registrar log:', logErr);
            }

            res.status(201).json({ success: true, data: result.rows[0], message: 'Cliente cadastrado com sucesso!' });

        } catch (error) {
            console.error('Erro ao criar cliente:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar cliente: ' + error.message });
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
                WHERE id = $1::uuid
                RETURNING *
            `, [id, nome, cpf_cnpj, telefone, email, endereco, cidade, estado, cep, data_nascimento, observacoes, status]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            try {
                await registrarLog(req.user?.id, 'CLIENTE_ATUALIZADO', 'clientes', id, {});
            } catch (logErr) {}

            res.json({ success: true, data: result.rows[0], message: 'Cliente atualizado!' });

        } catch (error) {
            console.error('Erro ao atualizar cliente:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar cliente' });
        }
    });

    // PUT /api/clientes/:id/status - Atualizar status do cliente
    router.put('/:id/status', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;

            const result = await pool.query(`
                UPDATE clientes SET status = $2, updated_at = NOW()
                WHERE id = $1::uuid RETURNING *
            `, [id, status]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error('Erro ao atualizar status:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar status' });
        }
    });

    // DELETE /api/clientes/:id - Remover cliente
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Verificar se tem cobranças vinculadas
            const cobrancas = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE cliente_id = $1::uuid', [id]);
            
            if (parseInt(cobrancas.rows[0].count) > 0) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Não é possível remover cliente com cobranças vinculadas. Inative-o ao invés disso.' 
                });
            }

            await pool.query('DELETE FROM clientes WHERE id = $1::uuid', [id]);

            try {
                await registrarLog(req.user?.id, 'CLIENTE_REMOVIDO', 'clientes', id, {});
            } catch (logErr) {}

            res.json({ success: true, message: 'Cliente removido com sucesso!' });

        } catch (error) {
            console.error('Erro ao remover cliente:', error);
            res.status(500).json({ success: false, error: 'Erro ao remover cliente' });
        }
    });

    return router;
};