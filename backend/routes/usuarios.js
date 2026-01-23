/**
 * ========================================
 * ACERTIVE - Módulo de Usuários
 * routes/usuarios.js
 * ========================================
 * CRUD de usuários do sistema
 */

const express = require('express');
const bcrypt = require('bcryptjs');

module.exports = function(pool, auth, authAdmin, registrarLog) {
    const router = express.Router();

    // =====================================================
    // GET /api/usuarios - Listar usuários (admin)
    // =====================================================
    router.get('/', authAdmin, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT id, nome, email, perfil, ativo, created_at, ultimo_login
                FROM usuarios ORDER BY nome
            `);
            res.json({ success: true, data: result.rows });
        } catch (error) {
            console.error('[USUARIOS] Erro ao listar:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar usuários' });
        }
    });

    // =====================================================
    // GET /api/usuarios/me - Dados do usuário logado
    // =====================================================
    router.get('/me', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT id, nome, email, perfil, created_at
                FROM usuarios WHERE id = $1
            `, [req.user.id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
            }

            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar dados' });
        }
    });

    // =====================================================
    // GET /api/usuarios/:id - Buscar usuário específico
    // =====================================================
    router.get('/:id', authAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            
            // Evitar conflito com /me
            if (id === 'me') return;

            const result = await pool.query(`
                SELECT id, nome, email, perfil, ativo, created_at, ultimo_login
                FROM usuarios WHERE id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
            }

            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar usuário' });
        }
    });

    // =====================================================
    // POST /api/usuarios - Criar usuário (admin)
    // =====================================================
    router.post('/', authAdmin, async (req, res) => {
        try {
            const { nome, email, senha, perfil = 'operador' } = req.body;

            if (!nome || !email || !senha) {
                return res.status(400).json({ success: false, error: 'Nome, email e senha são obrigatórios' });
            }

            // Verificar se email já existe
            const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase()]);
            if (existe.rows.length > 0) {
                return res.status(400).json({ success: false, error: 'Email já cadastrado' });
            }

            const senhaHash = await bcrypt.hash(senha, 10);

            const result = await pool.query(`
                INSERT INTO usuarios (nome, email, senha, perfil, ativo, created_at)
                VALUES ($1, $2, $3, $4, true, NOW())
                RETURNING id, nome, email, perfil
            `, [nome, email.toLowerCase(), senhaHash, perfil]);

            await registrarLog(req.user.id, 'USUARIO_CRIADO', 'usuarios', result.rows[0].id, { nome, email, perfil });

            res.status(201).json({ success: true, data: result.rows[0], message: 'Usuário criado com sucesso!' });

        } catch (error) {
            console.error('[USUARIOS] Erro ao criar:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar usuário' });
        }
    });

    // =====================================================
    // PUT /api/usuarios/:id - Atualizar usuário (admin)
    // =====================================================
    router.put('/:id', authAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { nome, email, senha, perfil, ativo } = req.body;

            let updateFields = [];
            let params = [];
            let paramIndex = 1;

            if (nome !== undefined) {
                updateFields.push(`nome = $${paramIndex}`);
                params.push(nome);
                paramIndex++;
            }

            if (email !== undefined) {
                updateFields.push(`email = $${paramIndex}`);
                params.push(email.toLowerCase());
                paramIndex++;
            }

            if (senha) {
                const senhaHash = await bcrypt.hash(senha, 10);
                updateFields.push(`senha = $${paramIndex}`);
                params.push(senhaHash);
                paramIndex++;
            }

            if (perfil !== undefined) {
                updateFields.push(`perfil = $${paramIndex}`);
                params.push(perfil);
                paramIndex++;
            }

            if (ativo !== undefined) {
                updateFields.push(`ativo = $${paramIndex}`);
                params.push(ativo);
                paramIndex++;
            }

            if (updateFields.length === 0) {
                return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
            }

            updateFields.push('updated_at = NOW()');
            params.push(id);
            
            const result = await pool.query(`
                UPDATE usuarios SET ${updateFields.join(', ')}
                WHERE id = $${paramIndex}
                RETURNING id, nome, email, perfil, ativo
            `, params);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
            }

            await registrarLog(req.user.id, 'USUARIO_ATUALIZADO', 'usuarios', id, { campos: updateFields });

            res.json({ success: true, data: result.rows[0], message: 'Usuário atualizado!' });

        } catch (error) {
            console.error('[USUARIOS] Erro ao atualizar:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar usuário' });
        }
    });

    // =====================================================
    // PUT /api/usuarios/me/senha - Alterar própria senha
    // =====================================================
    router.put('/me/senha', auth, async (req, res) => {
        try {
            const { senha_atual, nova_senha } = req.body;

            if (!senha_atual || !nova_senha) {
                return res.status(400).json({ success: false, error: 'Senha atual e nova senha são obrigatórias' });
            }

            const usuario = await pool.query('SELECT senha FROM usuarios WHERE id = $1', [req.user.id]);
            
            if (usuario.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
            }

            const senhaCorreta = await bcrypt.compare(senha_atual, usuario.rows[0].senha);
            
            if (!senhaCorreta) {
                return res.status(401).json({ success: false, error: 'Senha atual incorreta' });
            }

            const senhaHash = await bcrypt.hash(nova_senha, 10);
            
            await pool.query('UPDATE usuarios SET senha = $1, updated_at = NOW() WHERE id = $2', [senhaHash, req.user.id]);

            await registrarLog(req.user.id, 'SENHA_ALTERADA', 'usuarios', req.user.id, {});

            res.json({ success: true, message: 'Senha alterada com sucesso' });

        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao alterar senha' });
        }
    });

    // =====================================================
    // DELETE /api/usuarios/:id - Desativar usuário (admin)
    // =====================================================
    router.delete('/:id', authAdmin, async (req, res) => {
        try {
            const { id } = req.params;

            if (id === req.user.id) {
                return res.status(400).json({ success: false, error: 'Não é possível desativar seu próprio usuário' });
            }

            const result = await pool.query(`
                UPDATE usuarios SET ativo = false, updated_at = NOW() WHERE id = $1 RETURNING id
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
            }

            await registrarLog(req.user.id, 'USUARIO_DESATIVADO', 'usuarios', id, {});

            res.json({ success: true, message: 'Usuário desativado' });

        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao desativar usuário' });
        }
    });

    return router;
};