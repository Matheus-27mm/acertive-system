/**
 * ROTAS DE EMPRESAS - ACERTIVE
 * CRUD de empresas/escritórios
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/empresas - Listar empresas
    router.get('/', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT * FROM empresas ORDER BY padrao DESC, nome ASC
            `);
            res.json(result.rows);
        } catch (error) {
            console.error('Erro ao listar empresas:', error);
            res.status(500).json({ error: 'Erro ao listar empresas' });
        }
    });

    // GET /api/empresas/padrao - Buscar empresa padrão
    router.get('/padrao', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT * FROM empresas WHERE padrao = true LIMIT 1
            `);
            
            if (result.rows.length === 0) {
                // Se não tem padrão, pegar a primeira
                const primeira = await pool.query('SELECT * FROM empresas ORDER BY id LIMIT 1');
                return res.json(primeira.rows[0] || null);
            }
            
            res.json(result.rows[0]);
        } catch (error) {
            console.error('Erro ao buscar empresa padrão:', error);
            res.status(500).json({ error: 'Erro ao buscar empresa' });
        }
    });

    // GET /api/empresas/:id - Buscar empresa específica
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('SELECT * FROM empresas WHERE id = $1', [id]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Empresa não encontrada' });
            }
            
            res.json(result.rows[0]);
        } catch (error) {
            console.error('Erro ao buscar empresa:', error);
            res.status(500).json({ error: 'Erro ao buscar empresa' });
        }
    });

    // POST /api/empresas - Criar empresa
    router.post('/', auth, async (req, res) => {
        try {
            const { nome, cnpj, endereco, telefone, email, logo_url, padrao = false } = req.body;

            if (!nome) {
                return res.status(400).json({ error: 'Nome é obrigatório' });
            }

            // Se for padrão, remover padrão das outras
            if (padrao) {
                await pool.query('UPDATE empresas SET padrao = false');
            }

            const result = await pool.query(`
                INSERT INTO empresas (nome, cnpj, endereco, telefone, email, logo_url, padrao, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                RETURNING *
            `, [nome, cnpj, endereco, telefone, email, logo_url, padrao]);

            await registrarLog(req.user?.id, 'EMPRESA_CRIADA', 'empresas', result.rows[0].id, { nome });

            res.status(201).json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao criar empresa:', error);
            res.status(500).json({ error: 'Erro ao criar empresa' });
        }
    });

    // PUT /api/empresas/:id - Atualizar empresa
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { nome, cnpj, endereco, telefone, email, logo_url } = req.body;

            const result = await pool.query(`
                UPDATE empresas SET
                    nome = COALESCE($2, nome),
                    cnpj = COALESCE($3, cnpj),
                    endereco = COALESCE($4, endereco),
                    telefone = COALESCE($5, telefone),
                    email = COALESCE($6, email),
                    logo_url = COALESCE($7, logo_url),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `, [id, nome, cnpj, endereco, telefone, email, logo_url]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Empresa não encontrada' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao atualizar empresa:', error);
            res.status(500).json({ error: 'Erro ao atualizar empresa' });
        }
    });

    // PUT /api/empresas/:id/padrao - Definir empresa como padrão
    router.put('/:id/padrao', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Remover padrão de todas
            await pool.query('UPDATE empresas SET padrao = false');
            
            // Definir esta como padrão
            const result = await pool.query(`
                UPDATE empresas SET padrao = true WHERE id = $1 RETURNING *
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Empresa não encontrada' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao definir empresa padrão:', error);
            res.status(500).json({ error: 'Erro ao definir padrão' });
        }
    });

    // DELETE /api/empresas/:id - Remover empresa
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Verificar se é a única empresa
            const count = await pool.query('SELECT COUNT(*) FROM empresas');
            if (parseInt(count.rows[0].count) <= 1) {
                return res.status(400).json({ error: 'Não é possível remover a única empresa' });
            }

            await pool.query('DELETE FROM empresas WHERE id = $1', [id]);

            await registrarLog(req.user?.id, 'EMPRESA_REMOVIDA', 'empresas', id, {});

            res.json({ success: true });

        } catch (error) {
            console.error('Erro ao remover empresa:', error);
            res.status(500).json({ error: 'Erro ao remover empresa' });
        }
    });

    return router;
};
