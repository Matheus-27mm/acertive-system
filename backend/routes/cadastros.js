/**
 * ========================================
 * ACERTIVE - Módulo de Cadastros
 * routes/cadastros.js
 * ========================================
 * Unifica: credores, clientes, empresas
 * 
 * Endpoints:
 * - /api/cadastros/credores/*
 * - /api/cadastros/clientes/*
 * - /api/cadastros/empresas/*
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║                         CREDORES                              ║
    // ╚═══════════════════════════════════════════════════════════════╝

    // GET /api/cadastros/credores - Listar credores
    router.get('/credores', auth, async (req, res) => {
        try {
            const { status, search, ordem } = req.query;
            
            let sql = `
                SELECT 
                    cr.*,
                    COUNT(DISTINCT c.id) as total_cobrancas,
                    COUNT(DISTINCT c.cliente_id) as total_devedores,
                    COALESCE(SUM(CASE WHEN c.status IN ('pendente', 'vencido') THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_carteira,
                    COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_recuperado
                FROM credores cr
                LEFT JOIN cobrancas c ON c.credor_id = cr.id
                WHERE 1=1
            `;
            
            const params = [];
            let idx = 1;
            
            if (status) {
                sql += ` AND cr.status = $${idx}`;
                params.push(status);
                idx++;
            }
            
            if (search) {
                sql += ` AND (cr.nome ILIKE $${idx} OR cr.cnpj ILIKE $${idx})`;
                params.push(`%${search}%`);
                idx++;
            }
            
            sql += ` GROUP BY cr.id`;
            
            switch (ordem) {
                case 'carteira': sql += ' ORDER BY valor_carteira DESC'; break;
                case 'recuperado': sql += ' ORDER BY valor_recuperado DESC'; break;
                case 'recente': sql += ' ORDER BY cr.created_at DESC'; break;
                default: sql += ' ORDER BY cr.nome ASC';
            }
            
            const resultado = await pool.query(sql, params);
            
            const credores = resultado.rows.map(cr => ({
                ...cr,
                taxa_recuperacao: parseFloat(cr.valor_carteira) > 0 
                    ? ((parseFloat(cr.valor_recuperado) / (parseFloat(cr.valor_carteira) + parseFloat(cr.valor_recuperado))) * 100).toFixed(1)
                    : 0
            }));
            
            res.json({ success: true, data: credores });
            
        } catch (error) {
            console.error('[CADASTROS] Erro ao listar credores:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar credores' });
        }
    });

    // GET /api/cadastros/credores/stats - Estatísticas de credores
    router.get('/credores/stats', auth, async (req, res) => {
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(DISTINCT cr.id)::int as total_credores,
                    COUNT(DISTINCT CASE WHEN cr.status = 'ativo' THEN cr.id END)::int as credores_ativos,
                    COALESCE(SUM(CASE WHEN c.status IN ('pendente', 'vencido') THEN c.valor_atualizado ELSE 0 END), 0)::numeric as total_carteira,
                    COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado ELSE 0 END), 0)::numeric as total_recuperado
                FROM credores cr
                LEFT JOIN cobrancas c ON c.credor_id = cr.id
            `);
            
            const row = stats.rows[0];
            const taxaGeral = (parseFloat(row.total_carteira) + parseFloat(row.total_recuperado)) > 0
                ? ((parseFloat(row.total_recuperado) / (parseFloat(row.total_carteira) + parseFloat(row.total_recuperado))) * 100).toFixed(1)
                : 0;
            
            res.json({
                success: true,
                data: {
                    totalCredores: row.total_credores,
                    credoresAtivos: row.credores_ativos,
                    totalCarteira: parseFloat(row.total_carteira),
                    totalRecuperado: parseFloat(row.total_recuperado),
                    taxaRecuperacao: parseFloat(taxaGeral)
                }
            });
            
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/cadastros/credores/:id - Buscar credor por ID
    router.get('/credores/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            if (id === 'stats') return;
            
            const resultado = await pool.query(`
                SELECT 
                    cr.*,
                    COUNT(DISTINCT c.id)::int as total_cobrancas,
                    COUNT(DISTINCT c.cliente_id)::int as total_devedores,
                    COALESCE(SUM(CASE WHEN c.status IN ('pendente', 'vencido') THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_carteira,
                    COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_recuperado
                FROM credores cr
                LEFT JOIN cobrancas c ON c.credor_id = cr.id
                WHERE cr.id = $1
                GROUP BY cr.id
            `, [id]);
            
            if (!resultado.rowCount) {
                return res.status(404).json({ success: false, error: 'Credor não encontrado' });
            }
            
            res.json({ success: true, data: resultado.rows[0] });
            
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar credor' });
        }
    });

    // POST /api/cadastros/credores - Criar credor
    router.post('/credores', auth, async (req, res) => {
        try {
            const b = req.body || {};
            
            const nome = String(b.nome || '').trim();
            if (!nome) {
                return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
            }
            
            if (b.cnpj) {
                const existe = await pool.query('SELECT id FROM credores WHERE cnpj = $1', [b.cnpj.replace(/\D/g, '')]);
                if (existe.rowCount > 0) {
                    return res.status(400).json({ success: false, error: 'CNPJ já cadastrado' });
                }
            }
            
            const resultado = await pool.query(`
                INSERT INTO credores (
                    nome, razao_social, cnpj, telefone, email,
                    contato_nome, contato_telefone, contato_email,
                    endereco, cidade, estado, cep,
                    comissao_tipo, comissao_percentual, comissao_meta, comissao_valor_fixo,
                    permite_desconto, desconto_maximo, permite_parcelamento, parcelas_maximo,
                    banco, agencia, conta, tipo_conta, pix_tipo, pix_chave,
                    observacoes, status, multa_atraso, juros_atraso, tipo_juros, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, NOW()
                ) RETURNING *
            `, [
                nome, b.razao_social || null, b.cnpj ? b.cnpj.replace(/\D/g, '') : null,
                b.telefone || null, b.email || null,
                b.contato_nome || null, b.contato_telefone || null, b.contato_email || null,
                b.endereco || null, b.cidade || null, b.estado || null, b.cep || null,
                b.comissao_tipo || 'percentual', b.comissao_percentual || 10, b.comissao_meta || null, b.comissao_valor_fixo || null,
                b.permite_desconto !== false, b.desconto_maximo || 30, b.permite_parcelamento !== false, b.parcelas_maximo || 12,
                b.banco || null, b.agencia || null, b.conta || null, b.tipo_conta || 'corrente',
                b.pix_tipo || null, b.pix_chave || null, b.observacoes || null, b.status || 'ativo',
                b.multa_atraso || null, b.juros_atraso || null, b.tipo_juros || null
            ]);
            
            await registrarLog(req.user?.id, 'CREDOR_CRIADO', 'credores', resultado.rows[0].id, { nome });
            
            res.status(201).json({ success: true, data: resultado.rows[0], message: 'Credor criado com sucesso!' });
            
        } catch (error) {
            console.error('[CADASTROS] Erro ao criar credor:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar credor' });
        }
    });

    // PUT /api/cadastros/credores/:id - Atualizar credor
    router.put('/credores/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const b = req.body || {};
            
            const resultado = await pool.query(`
                UPDATE credores SET
                    nome = COALESCE($1, nome),
                    razao_social = COALESCE($2, razao_social),
                    cnpj = COALESCE($3, cnpj),
                    telefone = COALESCE($4, telefone),
                    email = COALESCE($5, email),
                    contato_nome = COALESCE($6, contato_nome),
                    contato_telefone = COALESCE($7, contato_telefone),
                    contato_email = COALESCE($8, contato_email),
                    endereco = COALESCE($9, endereco),
                    cidade = COALESCE($10, cidade),
                    estado = COALESCE($11, estado),
                    cep = COALESCE($12, cep),
                    comissao_tipo = COALESCE($13, comissao_tipo),
                    comissao_percentual = COALESCE($14, comissao_percentual),
                    banco = COALESCE($15, banco),
                    agencia = COALESCE($16, agencia),
                    conta = COALESCE($17, conta),
                    pix_tipo = COALESCE($18, pix_tipo),
                    pix_chave = COALESCE($19, pix_chave),
                    observacoes = COALESCE($20, observacoes),
                    status = COALESCE($21, status),
                    updated_at = NOW()
                WHERE id = $22
                RETURNING *
            `, [
                b.nome, b.razao_social, b.cnpj ? b.cnpj.replace(/\D/g, '') : null,
                b.telefone, b.email, b.contato_nome, b.contato_telefone, b.contato_email,
                b.endereco, b.cidade, b.estado, b.cep,
                b.comissao_tipo, b.comissao_percentual,
                b.banco, b.agencia, b.conta, b.pix_tipo, b.pix_chave,
                b.observacoes, b.status, id
            ]);
            
            if (!resultado.rowCount) {
                return res.status(404).json({ success: false, error: 'Credor não encontrado' });
            }
            
            await registrarLog(req.user?.id, 'CREDOR_ATUALIZADO', 'credores', id, b);
            
            res.json({ success: true, data: resultado.rows[0], message: 'Credor atualizado!' });
            
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao atualizar credor' });
        }
    });

    // DELETE /api/cadastros/credores/:id - Desativar credor
    router.delete('/credores/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            
            const cobrancas = await pool.query(`
                SELECT COUNT(*)::int as total FROM cobrancas 
                WHERE credor_id = $1 AND status IN ('pendente', 'vencido')
            `, [id]);
            
            if (parseInt(cobrancas.rows[0].total) > 0) {
                await pool.query('UPDATE credores SET status = $1, updated_at = NOW() WHERE id = $2', ['inativo', id]);
                return res.json({ success: true, message: 'Credor inativado (possui cobranças pendentes)' });
            }
            
            await pool.query('DELETE FROM credores WHERE id = $1', [id]);
            await registrarLog(req.user?.id, 'CREDOR_EXCLUIDO', 'credores', id, {});
            
            res.json({ success: true, message: 'Credor removido com sucesso' });
            
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao remover credor' });
        }
    });

    // GET /api/cadastros/credores/:id/cobrancas - Cobranças do credor
    router.get('/credores/:id/cobrancas', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { status, page = 1, limit = 50 } = req.query;
            
            let sql = `
                SELECT c.*, cl.nome as cliente_nome, cl.cpf_cnpj as cliente_cpf, cl.telefone as cliente_telefone
                FROM cobrancas c
                LEFT JOIN clientes cl ON cl.id = c.cliente_id
                WHERE c.credor_id = $1
            `;
            
            const params = [id];
            let idx = 2;
            
            if (status) {
                sql += ` AND c.status = $${idx}`;
                params.push(status);
                idx++;
            }
            
            sql += ` ORDER BY c.data_vencimento DESC LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
            
            const resultado = await pool.query(sql, params);
            
            res.json({ success: true, data: resultado.rows });
            
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar cobranças' });
        }
    });

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║                         CLIENTES                              ║
    // ╚═══════════════════════════════════════════════════════════════╝

    // GET /api/cadastros/clientes - Listar clientes
    router.get('/clientes', auth, async (req, res) => {
        try {
            const { busca, search, status, page = 1, limit = 50 } = req.query;
            const searchTerm = busca || search;

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

            const offset = (parseInt(page) - 1) * parseInt(limit);
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), offset);

            const result = await pool.query(query, params);

            // Contar total
            let countQuery = 'SELECT COUNT(*) FROM clientes WHERE 1=1';
            const countParams = [];
            let countIndex = 1;
            
            if (searchTerm) {
                countQuery += ` AND (nome ILIKE $${countIndex} OR cpf_cnpj ILIKE $${countIndex})`;
                countParams.push(`%${searchTerm}%`);
                countIndex++;
            }

            if (status) {
                countQuery += ` AND status = $${countIndex}`;
                countParams.push(status);
            }

            const countResult = await pool.query(countQuery, countParams);
            const total = parseInt(countResult.rows[0].count);

            res.json({
                success: true,
                data: result.rows,
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            });

        } catch (error) {
            console.error('[CADASTROS] Erro ao listar clientes:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar clientes' });
        }
    });

    // GET /api/cadastros/clientes/estatisticas
    router.get('/clientes/estatisticas', auth, async (req, res) => {
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
                SELECT COUNT(DISTINCT cliente_id) as com_cobrancas, COUNT(*) as total_cobrancas FROM cobrancas
            `);

            res.json({
                success: true,
                data: {
                    total: parseInt(statsResult.rows[0].total) || 0,
                    ativos: parseInt(statsResult.rows[0].ativos) || 0,
                    inativos: parseInt(statsResult.rows[0].inativos) || 0,
                    negativados: parseInt(statsResult.rows[0].negativados) || 0,
                    totalCobrancas: parseInt(cobrancasStats.rows[0].total_cobrancas) || 0
                }
            });

        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/cadastros/clientes/buscar - Autocomplete
    router.get('/clientes/buscar', auth, async (req, res) => {
        try {
            const { q } = req.query;

            if (!q || q.length < 2) {
                return res.json({ success: true, data: [] });
            }

            const result = await pool.query(`
                SELECT id, nome, cpf_cnpj, telefone, email
                FROM clientes WHERE nome ILIKE $1 OR cpf_cnpj ILIKE $1
                ORDER BY nome LIMIT 20
            `, [`%${q}%`]);

            res.json({ success: true, data: result.rows });

        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar clientes' });
        }
    });

    // GET /api/cadastros/clientes/ativos - Para select
    router.get('/clientes/ativos', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT id, nome, cpf_cnpj, telefone FROM clientes
                WHERE status = 'ativo' OR status IS NULL ORDER BY nome
            `);
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar clientes' });
        }
    });

    // GET /api/cadastros/clientes/:id - Buscar cliente
    router.get('/clientes/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            if (['estatisticas', 'buscar', 'ativos'].includes(id)) return;

            const cliente = await pool.query('SELECT * FROM clientes WHERE id = $1::uuid', [id]);

            if (cliente.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            // Buscar cobranças
            const cobrancas = await pool.query(`
                SELECT c.*, cr.nome as credor_nome
                FROM cobrancas c LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.cliente_id = $1::uuid ORDER BY c.data_vencimento DESC
            `, [id]);

            // Buscar acordos
            let acordos = { rows: [] };
            try {
                acordos = await pool.query(`
                    SELECT a.*, cr.nome as credor_nome,
                        (SELECT COUNT(*) FROM parcelas WHERE acordo_id = a.id) as total_parcelas,
                        (SELECT COUNT(*) FROM parcelas WHERE acordo_id = a.id AND status = 'pago') as parcelas_pagas
                    FROM acordos a LEFT JOIN credores cr ON a.credor_id = cr.id
                    WHERE a.cliente_id = $1::uuid ORDER BY a.created_at DESC
                `, [id]);
            } catch (e) {}

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
            console.error('[CADASTROS] Erro ao buscar cliente:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar cliente' });
        }
    });

    // POST /api/cadastros/clientes - Criar cliente
    router.post('/clientes', auth, async (req, res) => {
        try {
            const { nome, cpf_cnpj, telefone, celular, email, endereco, cidade, estado, cep, data_nascimento, observacoes } = req.body;

            if (!nome) {
                return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
            }

            if (cpf_cnpj) {
                const existe = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpf_cnpj]);
                if (existe.rows.length > 0) {
                    return res.status(400).json({ success: false, error: 'CPF/CNPJ já cadastrado' });
                }
            }

            const telefoneVal = telefone || celular || null;

            const result = await pool.query(`
                INSERT INTO clientes (nome, cpf_cnpj, telefone, email, endereco, cidade, estado, cep, data_nascimento, observacoes, status, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ativo', NOW(), NOW())
                RETURNING *
            `, [nome, cpf_cnpj || null, telefoneVal, email || null, endereco || null, cidade || null, estado || null, cep || null, data_nascimento || null, observacoes || null]);

            await registrarLog(req.user?.id, 'CLIENTE_CRIADO', 'clientes', result.rows[0].id, { nome });

            res.status(201).json({ success: true, data: result.rows[0], message: 'Cliente cadastrado com sucesso!' });

        } catch (error) {
            console.error('[CADASTROS] Erro ao criar cliente:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar cliente' });
        }
    });

    // PUT /api/cadastros/clientes/:id - Atualizar cliente
    router.put('/clientes/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { nome, cpf_cnpj, telefone, email, endereco, cidade, estado, cep, data_nascimento, observacoes, status } = req.body;

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
                WHERE id = $1::uuid RETURNING *
            `, [id, nome, cpf_cnpj, telefone, email, endereco, cidade, estado, cep, data_nascimento, observacoes, status]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            await registrarLog(req.user?.id, 'CLIENTE_ATUALIZADO', 'clientes', id, {});

            res.json({ success: true, data: result.rows[0], message: 'Cliente atualizado!' });

        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao atualizar cliente' });
        }
    });

    // DELETE /api/cadastros/clientes/:id - Remover cliente
    router.delete('/clientes/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const cobrancas = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE cliente_id = $1::uuid', [id]);
            
            if (parseInt(cobrancas.rows[0].count) > 0) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Não é possível remover cliente com cobranças vinculadas. Inative-o.' 
                });
            }

            await pool.query('DELETE FROM clientes WHERE id = $1::uuid', [id]);
            await registrarLog(req.user?.id, 'CLIENTE_REMOVIDO', 'clientes', id, {});

            res.json({ success: true, message: 'Cliente removido com sucesso!' });

        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao remover cliente' });
        }
    });

    // ╔═══════════════════════════════════════════════════════════════╗
    // ║                         EMPRESAS                              ║
    // ╚═══════════════════════════════════════════════════════════════╝

    // GET /api/cadastros/empresas - Listar empresas
    router.get('/empresas', auth, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM empresas ORDER BY padrao DESC, nome ASC');
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar empresas' });
        }
    });

    // GET /api/cadastros/empresas/padrao - Empresa padrão
    router.get('/empresas/padrao', auth, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM empresas WHERE padrao = true LIMIT 1');
            
            if (result.rows.length === 0) {
                const primeira = await pool.query('SELECT * FROM empresas ORDER BY created_at LIMIT 1');
                return res.json({ success: true, data: primeira.rows[0] || null });
            }
            
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar empresa' });
        }
    });

    // GET /api/cadastros/empresas/:id - Buscar empresa
    router.get('/empresas/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            if (id === 'padrao') return;
            
            const result = await pool.query('SELECT * FROM empresas WHERE id = $1', [id]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Empresa não encontrada' });
            }
            
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar empresa' });
        }
    });

    // POST /api/cadastros/empresas - Criar empresa
    router.post('/empresas', auth, async (req, res) => {
        try {
            const { nome, cnpj, endereco, telefone, email, logo_url, banco, agencia, conta, digito, tipo_conta, titular, cpf_cnpj_titular, tipo_chave_pix, chave_pix, padrao = false, ativo = true } = req.body;

            if (!nome) {
                return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
            }

            if (padrao) {
                await pool.query('UPDATE empresas SET padrao = false');
            }

            const result = await pool.query(`
                INSERT INTO empresas (nome, cnpj, endereco, telefone, email, logo_url, banco, agencia, conta, digito, tipo_conta, titular, cpf_cnpj_titular, tipo_chave_pix, chave_pix, padrao, ativo, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
                RETURNING *
            `, [nome, cnpj || null, endereco || null, telefone || null, email || null, logo_url || null, banco || null, agencia || null, conta || null, digito || null, tipo_conta || null, titular || null, cpf_cnpj_titular || null, tipo_chave_pix || null, chave_pix || null, padrao, ativo]);

            await registrarLog(req.user?.id, 'EMPRESA_CRIADA', 'empresas', result.rows[0].id, { nome });

            res.status(201).json({ success: true, data: result.rows[0], message: 'Empresa criada com sucesso!' });

        } catch (error) {
            console.error('[CADASTROS] Erro ao criar empresa:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar empresa' });
        }
    });

    // PUT /api/cadastros/empresas/:id - Atualizar empresa
    router.put('/empresas/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { nome, cnpj, endereco, telefone, email, logo_url, banco, agencia, conta, digito, tipo_conta, titular, cpf_cnpj_titular, tipo_chave_pix, chave_pix, padrao, ativo } = req.body;

            if (padrao === true) {
                await pool.query('UPDATE empresas SET padrao = false WHERE id != $1', [id]);
            }

            const result = await pool.query(`
                UPDATE empresas SET
                    nome = COALESCE($2, nome), cnpj = COALESCE($3, cnpj), endereco = COALESCE($4, endereco),
                    telefone = COALESCE($5, telefone), email = COALESCE($6, email), logo_url = COALESCE($7, logo_url),
                    banco = COALESCE($8, banco), agencia = COALESCE($9, agencia), conta = COALESCE($10, conta),
                    digito = COALESCE($11, digito), tipo_conta = COALESCE($12, tipo_conta), titular = COALESCE($13, titular),
                    cpf_cnpj_titular = COALESCE($14, cpf_cnpj_titular), tipo_chave_pix = COALESCE($15, tipo_chave_pix),
                    chave_pix = COALESCE($16, chave_pix), padrao = COALESCE($17, padrao), ativo = COALESCE($18, ativo),
                    updated_at = NOW()
                WHERE id = $1 RETURNING *
            `, [id, nome, cnpj, endereco, telefone, email, logo_url, banco, agencia, conta, digito, tipo_conta, titular, cpf_cnpj_titular, tipo_chave_pix, chave_pix, padrao, ativo]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Empresa não encontrada' });
            }

            res.json({ success: true, data: result.rows[0], message: 'Empresa atualizada!' });

        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao atualizar empresa' });
        }
    });

    // PUT /api/cadastros/empresas/:id/padrao - Definir como padrão
    router.put('/empresas/:id/padrao', auth, async (req, res) => {
        try {
            const { id } = req.params;

            await pool.query('UPDATE empresas SET padrao = false');
            
            const result = await pool.query('UPDATE empresas SET padrao = true, updated_at = NOW() WHERE id = $1 RETURNING *', [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Empresa não encontrada' });
            }

            res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao definir padrão' });
        }
    });

    // DELETE /api/cadastros/empresas/:id - Remover empresa
    router.delete('/empresas/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const empresa = await pool.query('SELECT * FROM empresas WHERE id = $1', [id]);
            if (empresa.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Empresa não encontrada' });
            }

            const eraPadrao = empresa.rows[0].padrao;

            // Desvincular dependências
            try { await pool.query('UPDATE usuarios SET empresa_id = NULL WHERE empresa_id = $1', [id]); } catch (e) {}
            try { await pool.query('UPDATE cobrancas SET empresa_id = NULL WHERE empresa_id = $1', [id]); } catch (e) {}
            try { await pool.query('UPDATE clientes SET empresa_id = NULL WHERE empresa_id = $1', [id]); } catch (e) {}

            await pool.query('DELETE FROM empresas WHERE id = $1', [id]);

            if (eraPadrao) {
                await pool.query('UPDATE empresas SET padrao = true WHERE id = (SELECT id FROM empresas ORDER BY created_at LIMIT 1)');
            }

            await registrarLog(req.user?.id, 'EMPRESA_REMOVIDA', 'empresas', id, {});

            res.json({ success: true, message: 'Empresa removida com sucesso!' });

        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao remover empresa' });
        }
    });

    return router;
};