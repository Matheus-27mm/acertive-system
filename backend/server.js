/**
 * ========================================
 * ACERTIVE - Sistema de Cobrança
 * server.js - Servidor Principal
 * ========================================
 * FASE 2: Backend Consolidado (8 módulos)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
// CONFIGURAÇÕES
// ═══════════════════════════════════════════════════════════════

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

// ═══════════════════════════════════════════════════════════════
// BANCO DE DADOS
// ═══════════════════════════════════════════════════════════════

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => console.log('[DB] Conectado ao PostgreSQL'));
pool.on('error', (err) => console.error('[DB] Erro:', err));

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARES DE AUTENTICAÇÃO
// ═══════════════════════════════════════════════════════════════

const JWT_SECRET = process.env.JWT_SECRET || 'acertive_secret_key_2024';

const auth = async (req, res, next) => {
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

const authAdmin = async (req, res, next) => {
    await auth(req, res, () => {
        if (req.user?.perfil !== 'admin') {
            return res.status(403).json({ error: 'Acesso negado. Requer perfil admin.' });
        }
        next();
    });
};

// ═══════════════════════════════════════════════════════════════
// FUNÇÃO DE LOG
// ═══════════════════════════════════════════════════════════════

async function registrarLog(usuario_id, acao, tabela, registro_id, dados = {}) {
    try {
        await pool.query(`
            INSERT INTO historico (usuario_id, acao, tabela, registro_id, dados, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
        `, [usuario_id, acao, tabela, registro_id, JSON.stringify(dados)]);
    } catch (error) {
        console.error('[LOG] Erro ao registrar:', error.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// ROTAS - 8 MÓDULOS CONSOLIDADOS
// ═══════════════════════════════════════════════════════════════

const authRoutes = require('./routes/auth')(pool, registrarLog);
app.use('/api/auth', authRoutes);

const usuariosRoutes = require('./routes/usuarios')(pool, auth, authAdmin, registrarLog);
app.use('/api/usuarios', usuariosRoutes);

const cadastrosRoutes = require('./routes/cadastros')(pool, auth, registrarLog);
app.use('/api/cadastros', cadastrosRoutes);

const cobrancasRoutes = require('./routes/cobrancas')(pool, auth, upload, registrarLog);
app.use('/api/cobrancas', cobrancasRoutes);

const acordosRoutes = require('./routes/acordos')(pool, auth, registrarLog);
app.use('/api/acordos', acordosRoutes);

const acionamentosRoutes = require('./routes/acionamentos')(pool, auth, authAdmin, registrarLog);
app.use('/api/acionamentos', acionamentosRoutes);

const financeiroRoutes = require('./routes/financeiro')(pool, auth, registrarLog);
app.use('/api/financeiro', financeiroRoutes);

const integracoesRoutes = require('./routes/integracoes')(pool, auth, registrarLog);
app.use('/api/integracoes', integracoesRoutes);

// ═══════════════════════════════════════════════════════════════
// ROTAS LEGADO - Compatibilidade com frontend antigo
// ═══════════════════════════════════════════════════════════════

// Credores, Clientes, Empresas -> cadastros
app.use('/api/credores', (req, res, next) => { req.url = '/credores' + req.url; cadastrosRoutes(req, res, next); });
app.use('/api/clientes', (req, res, next) => { req.url = '/clientes' + req.url; cadastrosRoutes(req, res, next); });
app.use('/api/empresas', (req, res, next) => { req.url = '/empresas' + req.url; cadastrosRoutes(req, res, next); });

// Parcelas -> acordos/parcelas
app.use('/api/parcelas', (req, res, next) => { req.url = '/parcelas' + req.url; acordosRoutes(req, res, next); });

// Importação -> cobrancas/importar
app.post('/api/importacao/clientes', auth, upload.single('file'), (req, res, next) => { req.url = '/importar/clientes'; cobrancasRoutes(req, res, next); });
app.post('/api/importacao/cobrancas', auth, upload.single('file'), (req, res, next) => { req.url = '/importar/cobrancas'; cobrancasRoutes(req, res, next); });
app.post('/api/importacao/massa', auth, upload.single('file'), (req, res, next) => { req.url = '/importar/massa'; cobrancasRoutes(req, res, next); });

// Dashboard, Config -> integracoes
app.use('/api/dashboard', (req, res, next) => { req.url = '/dashboard' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/configuracoes', (req, res, next) => { req.url = '/configuracoes' + req.url; integracoesRoutes(req, res, next); });

// Asaas, Sync, WhatsApp, Email, PDF -> integracoes
app.use('/api/asaas', (req, res, next) => { req.url = '/asaas' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/sync', (req, res, next) => { req.url = '/sync' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/sync-asaas', (req, res, next) => { req.url = '/sync' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/whatsapp', (req, res, next) => { req.url = '/whatsapp' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/email', (req, res, next) => { req.url = '/email' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/pdf', (req, res, next) => { req.url = '/pdf' + req.url; integracoesRoutes(req, res, next); });

// Régua, Agendamentos, Histórico -> acionamentos
app.use('/api/regua', (req, res, next) => { req.url = '/regua' + req.url; acionamentosRoutes(req, res, next); });
app.use('/api/agendamentos', (req, res, next) => { req.url = '/agendamentos' + req.url; acionamentosRoutes(req, res, next); });
app.use('/api/historico', (req, res, next) => { req.url = '/historico' + req.url; acionamentosRoutes(req, res, next); });

// Comissões, Repasses, Relatórios -> financeiro
app.use('/api/comissoes', (req, res, next) => { req.url = '/comissoes' + req.url; financeiroRoutes(req, res, next); });
app.use('/api/repasses', (req, res, next) => { req.url = '/repasses' + req.url; financeiroRoutes(req, res, next); });
app.use('/api/relatorios', (req, res, next) => { req.url = '/relatorios' + req.url; financeiroRoutes(req, res, next); });

// ═══════════════════════════════════════════════════════════════
// ROTA DE SAÚDE
// ═══════════════════════════════════════════════════════════════

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            database: 'connected',
            version: '2.0.0',
            modules: ['auth', 'usuarios', 'cadastros', 'cobrancas', 'acordos', 'acionamentos', 'financeiro', 'integracoes']
        });
    } catch (error) {
        res.status(500).json({ status: 'error', database: 'disconnected', error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// FALLBACK
// ═══════════════════════════════════════════════════════════════

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Endpoint não encontrado' });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
    console.error('[ERROR]', err);
    res.status(500).json({ error: 'Erro interno do servidor', details: err.message });
});

// ═══════════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║            ACERTIVE - Sistema de Cobrança v2.0                ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  🚀 Servidor: http://localhost:${PORT}                          ║`);
    console.log('║                                                               ║');
    console.log('║  📦 Módulos:                                                  ║');
    console.log('║     • auth         - Autenticação                             ║');
    console.log('║     • usuarios     - Gestão de usuários                       ║');
    console.log('║     • cadastros    - Credores, Clientes, Empresas             ║');
    console.log('║     • cobrancas    - Cobranças + Importação                   ║');
    console.log('║     • acordos      - Acordos + Parcelas                       ║');
    console.log('║     • acionamentos - Régua, Agendamentos, Histórico           ║');
    console.log('║     • financeiro   - Comissões, Repasses, Relatórios          ║');
    console.log('║     • integracoes  - Asaas, WhatsApp, Email, PDF              ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');
});