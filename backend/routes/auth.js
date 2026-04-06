/**
 * ========================================
 * ACERTIVE - Módulo de Autenticação
 * routes/auth.js
 * ========================================
 * v2.4.1 - Corrigido HTTP 500 no login
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function(pool, registrarLog) {
    const router = express.Router();

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) throw new Error('JWT_SECRET não definido');

    const JWT_EXPIRES = '24h';

    // =====================================================
    // Middleware de autenticação local
    // =====================================================
    const authLocal = async (req, res, next) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) return res.status(401).json({ error: 'Token não fornecido' });

            const decoded = jwt.verify(token, JWT_SECRET);
            const usuario = await pool.query(
                'SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = $1',
                [decoded.id]
            );

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
    // GET /api/auth/me
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

            // Validação básica de input
            if (!email || !senha) {
                return res.status(400).json({ error: 'Email e senha são obrigatórios' });
            }

            if (typeof email !== 'string' || typeof senha !== 'string') {
                return res.status(400).json({ error: 'Dados inválidos' });
            }

            // Buscar usuário
            const result = await pool.query(
                'SELECT id, nome, email, senha, perfil, ativo FROM usuarios WHERE email = $1',
                [email.toLowerCase().trim()]
            );

            // ── CORREÇÃO DO HTTP 500 ──────────────────────────────
            // Mesmo se o usuário não existir, fazemos um bcrypt.compare
            // com um hash falso para manter o tempo de resposta constante
            // e evitar timing attacks + evitar que bcrypt receba null
            const HASH_FALSO = '$2a$10$invalidhashtopreventtimingattacksXXXXXXXXXXXXXXXX';
            const hashParaComparar = result.rows[0]?.senha || HASH_FALSO;

            // Verificar senha (sempre executa, mesmo se usuário não existe)
            let senhaCorreta = false;
            try {
                senhaCorreta = await bcrypt.compare(senha, hashParaComparar);
            } catch (bcryptError) {
                // Hash inválido no banco — trata como senha errada
                console.error('[AUTH] Erro bcrypt:', bcryptError.message);
                senhaCorreta = false;
            }

            // Usuário não existe ou senha errada — mesma mensagem (anti-enumeração)
            if (result.rows.length === 0 || !senhaCorreta) {
                return res.status(401).json({ error: 'Email ou senha incorretos' });
            }

            const usuario = result.rows[0];

            if (!usuario.ativo) {
                return res.status(401).json({ error: 'Usuário desativado' });
            }

            // Gerar token JWT
            const token = jwt.sign(
                { id: usuario.id, email: usuario.email, perfil: usuario.perfil },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRES }
            );

            // Atualizar último login (não bloqueia resposta)
            pool.query('UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1', [usuario.id])
                .catch(e => console.error('[AUTH] Erro ao atualizar ultimo_login:', e.message));

            // Registrar log (não bloqueia resposta)
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
            // Nunca expõe detalhes do erro para o cliente
            res.status(500).json({ error: 'Erro interno. Tente novamente.' });
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
            if (!token) return res.status(401).json({ valid: false, error: 'Token não fornecido' });

            const decoded = jwt.verify(token, JWT_SECRET);
            const usuario = await pool.query(
                'SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = $1',
                [decoded.id]
            );

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
            if (!token) return res.status(401).json({ error: 'Token não fornecido' });

            let decoded;
            try {
                decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
            } catch (e) {
                return res.status(401).json({ error: 'Token inválido' });
            }

            // Máximo 7 dias para renovar
            const tokenAge = Date.now() / 1000 - decoded.iat;
            if (tokenAge > 7 * 24 * 60 * 60) {
                return res.status(401).json({ error: 'Token muito antigo, faça login novamente' });
            }

            const usuario = await pool.query(
                'SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = $1',
                [decoded.id]
            );

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
            if (!email) return res.status(400).json({ error: 'Email é obrigatório' });

            const usuario = await pool.query(
                'SELECT id, nome FROM usuarios WHERE email = $1',
                [email.toLowerCase().trim()]
            );

            // Sempre retorna sucesso — não revela se email existe
            if (usuario.rows.length === 0) {
                return res.json({ success: true, message: 'Se o email existir, você receberá as instruções' });
            }

            const tokenRecuperacao = jwt.sign(
                { id: usuario.rows[0].id, tipo: 'recuperacao' },
                JWT_SECRET,
                { expiresIn: '1h' }
            );

            // TODO: Implementar envio de email
            console.log(`[AUTH] Token de recuperação gerado para: ${email}`);

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

            // Senha mínima de 6 caracteres
            if (nova_senha.length < 6) {
                return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
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