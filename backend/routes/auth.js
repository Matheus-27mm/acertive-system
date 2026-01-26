/**
 * ========================================
 * ACERTIVE - Módulo de Autenticação
 * routes/auth.js
 * ========================================
 * Login, logout, verificação e recuperação de senha
 * ATUALIZADO: Adicionada rota /me
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function(pool, registrarLog) {
    const router = express.Router();

    const JWT_SECRET = process.env.JWT_SECRET || 'acertive_secret_key_2024';
    const JWT_EXPIRES = '24h';

    // =====================================================
    // Middleware de autenticação local
    // =====================================================
    const authLocal = async (req, res, next) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) return res.status(401).json({ error: 'Token não fornecido' });

            const decoded = jwt.verify(token, JWT_SECRET);
            const usuario = await pool.query('SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = $1', [decoded.id]);
            
            if (usuario.rows.length === 0 || !usuario.rows[0].ativo) {
                return res.status(401).json({ error: 'Usuário inválido ou desativado' });
            }

            req.user = usuario.rows[0];
            next();
        } catch (error) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token inválido ou expirado' });
            }
            res.status(500).json({ error: 'Erro na autenticação' });
        }
    };

    // =====================================================
    // GET /api/auth/me - Retorna dados do usuário logado
    // =====================================================
    router.get('/me', authLocal, async (req, res) => {
        try {
            res.json({ 
                success: true, 
                user: {
                    id: req.user.id,
                    nome: req.user.nome,
                    email: req.user.email,
                    perfil: req.user.perfil
                }
            });
        } catch (error) {
            console.error('[AUTH] Erro ao buscar usuário:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar usuário' });
        }
    });

    // =====================================================
    // POST /api/auth/login
    // =====================================================
    router.post('/login', async (req, res) => {
        try {
            const { email, senha } = req.body;

            if (!email || !senha) {
                return res.status(400).json({ error: 'Email e senha são obrigatórios' });
            }

            // Buscar usuário
            const result = await pool.query(`
                SELECT id, nome, email, senha, perfil, ativo
                FROM usuarios WHERE email = $1
            `, [email.toLowerCase()]);

            if (result.rows.length === 0) {
                return res.status(401).json({ error: 'Email ou senha incorretos' });
            }

            const usuario = result.rows[0];

            if (!usuario.ativo) {
                return res.status(401).json({ error: 'Usuário desativado' });
            }

            // Verificar senha
            const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
            
            if (!senhaCorreta) {
                return res.status(401).json({ error: 'Email ou senha incorretos' });
            }

            // Gerar token JWT
            const token = jwt.sign(
                { id: usuario.id, email: usuario.email, perfil: usuario.perfil },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRES }
            );

            // Atualizar último login
            await pool.query('UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1', [usuario.id]);

            // Registrar log
            try {
                await registrarLog(usuario.id, 'LOGIN', 'usuarios', usuario.id, {
                    ip: req.ip,
                    userAgent: req.headers['user-agent']
                });
            } catch (e) {}

            res.json({
                success: true,
                token,
                usuario: {
                    id: usuario.id,
                    nome: usuario.nome,
                    email: usuario.email,
                    perfil: usuario.perfil
                }
            });

        } catch (error) {
            console.error('[AUTH] Erro no login:', error);
            res.status(500).json({ error: 'Erro ao fazer login' });
        }
    });

    // =====================================================
    // POST /api/auth/logout
    // =====================================================
    router.post('/logout', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            
            if (token) {
                try {
                    const decoded = jwt.verify(token, JWT_SECRET);
                    await registrarLog(decoded.id, 'LOGOUT', 'usuarios', decoded.id, {});
                } catch (e) {}
            }

            res.json({ success: true, message: 'Logout realizado' });

        } catch (error) {
            res.status(500).json({ error: 'Erro ao fazer logout' });
        }
    });

    // =====================================================
    // POST /api/auth/verificar
    // =====================================================
    router.post('/verificar', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                return res.status(401).json({ valid: false, error: 'Token não fornecido' });
            }

            const decoded = jwt.verify(token, JWT_SECRET);

            const usuario = await pool.query(`
                SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = $1
            `, [decoded.id]);

            if (usuario.rows.length === 0 || !usuario.rows[0].ativo) {
                return res.status(401).json({ valid: false, error: 'Usuário inválido' });
            }

            res.json({ valid: true, usuario: usuario.rows[0] });

        } catch (error) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({ valid: false, error: 'Token inválido ou expirado' });
            }
            res.status(500).json({ valid: false, error: 'Erro ao verificar token' });
        }
    });

    // =====================================================
    // POST /api/auth/refresh
    // =====================================================
    router.post('/refresh', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                return res.status(401).json({ error: 'Token não fornecido' });
            }

            let decoded;
            try {
                decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
            } catch (e) {
                return res.status(401).json({ error: 'Token inválido' });
            }

            // Verificar se não é muito antigo (máximo 7 dias)
            const tokenAge = Date.now() / 1000 - decoded.iat;
            if (tokenAge > 7 * 24 * 60 * 60) {
                return res.status(401).json({ error: 'Token muito antigo, faça login novamente' });
            }

            const usuario = await pool.query(`
                SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = $1
            `, [decoded.id]);

            if (usuario.rows.length === 0 || !usuario.rows[0].ativo) {
                return res.status(401).json({ error: 'Usuário inválido' });
            }

            const novoToken = jwt.sign(
                { id: usuario.rows[0].id, email: usuario.rows[0].email, perfil: usuario.rows[0].perfil },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRES }
            );

            res.json({ success: true, token: novoToken, usuario: usuario.rows[0] });

        } catch (error) {
            res.status(500).json({ error: 'Erro ao renovar token' });
        }
    });

    // =====================================================
    // POST /api/auth/recuperar-senha
    // =====================================================
    router.post('/recuperar-senha', async (req, res) => {
        try {
            const { email } = req.body;

            if (!email) {
                return res.status(400).json({ error: 'Email é obrigatório' });
            }

            const usuario = await pool.query('SELECT id, nome FROM usuarios WHERE email = $1', [email.toLowerCase()]);

            // Sempre retornar sucesso para não revelar se email existe
            if (usuario.rows.length === 0) {
                return res.json({ success: true, message: 'Se o email existir, você receberá as instruções' });
            }

            const tokenRecuperacao = jwt.sign(
                { id: usuario.rows[0].id, tipo: 'recuperacao' },
                JWT_SECRET,
                { expiresIn: '1h' }
            );

            // TODO: Implementar envio de email
            console.log(`[AUTH] Token de recuperação para ${email}: ${tokenRecuperacao}`);

            await registrarLog(usuario.rows[0].id, 'RECUPERACAO_SENHA_SOLICITADA', 'usuarios', usuario.rows[0].id, {});

            res.json({ success: true, message: 'Se o email existir, você receberá as instruções' });

        } catch (error) {
            res.status(500).json({ error: 'Erro ao processar solicitação' });
        }
    });

    // =====================================================
    // POST /api/auth/redefinir-senha
    // =====================================================
    router.post('/redefinir-senha', async (req, res) => {
        try {
            const { token, nova_senha } = req.body;

            if (!token || !nova_senha) {
                return res.status(400).json({ error: 'Token e nova senha são obrigatórios' });
            }

            let decoded;
            try {
                decoded = jwt.verify(token, JWT_SECRET);
            } catch (e) {
                return res.status(401).json({ error: 'Token inválido ou expirado' });
            }

            if (decoded.tipo !== 'recuperacao') {
                return res.status(401).json({ error: 'Token inválido' });
            }

            const senhaHash = await bcrypt.hash(nova_senha, 10);
            
            await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [senhaHash, decoded.id]);

            await registrarLog(decoded.id, 'SENHA_REDEFINIDA', 'usuarios', decoded.id, {});

            res.json({ success: true, message: 'Senha redefinida com sucesso' });

        } catch (error) {
            res.status(500).json({ error: 'Erro ao redefinir senha' });
        }
    });

    return router;
};