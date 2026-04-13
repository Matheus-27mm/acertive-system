/**
 * ========================================
 * ACERTIVE - Sistema de Cobrança
 * server.js - Servidor Principal
 * ========================================
 * v2.5.1 - Portal do Credor registrado
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const multer = require('multer');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
// SEGURANÇA
// ═══════════════════════════════════════════════════════════════
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:  ["'self'"],
            scriptSrc:   ["'self'", "'unsafe-inline'", "'unsafe-eval'", "cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc:    ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
            fontSrc:     ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            imgSrc:      ["'self'", "data:", "blob:"],
            connectSrc:  ["'self'"],
            frameSrc:    ["'none'"],
            objectSrc:   ["'none'"],
        }
    },
    crossOriginEmbedderPolicy: false
}));

const limiterGeral  = rateLimit({ windowMs: 15*60*1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' } });
const limiterLogin  = rateLimit({ windowMs: 15*60*1000, max: 10,  standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' } });
const limiterImport = rateLimit({ windowMs: 60*60*1000, max: 5,   message: { error: 'Limite de importações atingido.' } });

app.use('/api/', limiterGeral);
app.use('/api/auth/login', limiterLogin);
app.use('/api/importacao', limiterImport);

// ═══════════════════════════════════════════════════════════════
// CONFIGURAÇÕES
// ═══════════════════════════════════════════════════════════════
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? ['https://acertivecobranca.com.br', 'https://www.acertivecobranca.com.br']
        : ['https://acertivecobranca.com.br', 'https://www.acertivecobranca.com.br', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
// SERVIÇO ASAAS
// ═══════════════════════════════════════════════════════════════
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_URL = process.env.ASAAS_SANDBOX === 'true' ? 'https://sandbox.asaas.com/api/v3' : 'https://api.asaas.com/api/v3';

const asaasService = ASAAS_API_KEY ? {
    async criarCliente(dados) { try { const r = await fetch(`${ASAAS_URL}/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY }, body: JSON.stringify({ name: dados.name, cpfCnpj: dados.cpfCnpj, email: dados.email||null, phone: dados.phone||null, mobilePhone: dados.mobilePhone||dados.phone||null }) }); const result = await r.json(); if (!r.ok) { if (result.errors?.some(e => e.code === 'invalid_cpfCnpj' || e.description?.includes('já cadastrado'))) return await this.buscarClientePorCpf(dados.cpfCnpj); return null; } return result; } catch(e){ return null; } },
    async buscarClientePorCpf(cpfCnpj) { try { const cpf = cpfCnpj?.replace(/\D/g,''); if(!cpf) return null; const r = await fetch(`${ASAAS_URL}/customers?cpfCnpj=${cpf}`, { headers: { 'access_token': ASAAS_API_KEY } }); const result = await r.json(); return result.data?.length > 0 ? result.data[0] : null; } catch(e){ return null; } },
    async criarCobranca(dados) { try { const body = { customer: dados.customer, billingType: dados.billingType||'BOLETO', value: parseFloat(dados.value), dueDate: dados.dueDate, description: dados.description||'Cobrança ACERTIVE', externalReference: dados.externalReference||null }; if(dados.fine) body.fine = { value: dados.fine.value||2, type: dados.fine.type||'PERCENTAGE' }; if(dados.interest) body.interest = { value: dados.interest.value||1, type: dados.interest.type||'PERCENTAGE' }; const r = await fetch(`${ASAAS_URL}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY }, body: JSON.stringify(body) }); const result = await r.json(); if(!r.ok) return null; return result; } catch(e){ return null; } },
    async buscarCobranca(id) { try { const r = await fetch(`${ASAAS_URL}/payments/${id}`, { headers: { 'access_token': ASAAS_API_KEY } }); return await r.json(); } catch(e){ return null; } },
    async cancelarCobranca(id) { try { const r = await fetch(`${ASAAS_URL}/payments/${id}`, { method: 'DELETE', headers: { 'access_token': ASAAS_API_KEY } }); return await r.json(); } catch(e){ return null; } },
    async gerarPixQrCode(id) { try { const r = await fetch(`${ASAAS_URL}/payments/${id}/pixQrCode`, { headers: { 'access_token': ASAAS_API_KEY } }); return await r.json(); } catch(e){ return null; } }
} : null;

if (asaasService) console.log('[ASAAS] Configurado -', ASAAS_URL.includes('sandbox') ? 'SANDBOX' : 'PRODUÇÃO');
else console.log('[ASAAS] NÃO configurado');

// ═══════════════════════════════════════════════════════════════
// VALIDAÇÃO DE VARIÁVEIS CRÍTICAS
// ═══════════════════════════════════════════════════════════════
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('ERRO FATAL: JWT_SECRET não definido'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('ERRO FATAL: DATABASE_URL não definida'); process.exit(1); }

// ═══════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
const auth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Token não fornecido' });
        const decoded = jwt.verify(token, JWT_SECRET);
        const usuario = await pool.query('SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = $1', [decoded.id]);
        if (usuario.rows.length === 0 || !usuario.rows[0].ativo) return res.status(401).json({ error: 'Usuário inválido ou desativado' });
        req.user = usuario.rows[0];
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token inválido ou expirado' });
        res.status(500).json({ error: 'Erro na autenticação' });
    }
};

const authAdmin = async (req, res, next) => {
    await auth(req, res, () => {
        if (req.user?.perfil !== 'admin') return res.status(403).json({ error: 'Acesso negado. Requer perfil admin.' });
        next();
    });
};

// ═══════════════════════════════════════════════════════════════
// LOG
// ═══════════════════════════════════════════════════════════════
async function registrarLog(usuario_id, acao, tabela, registro_id, dados = {}) {
    try {
        await pool.query('INSERT INTO historico (usuario_id, acao, tabela, registro_id, dados, created_at) VALUES ($1,$2,$3,$4,$5,NOW())', [usuario_id, acao, tabela, registro_id, JSON.stringify(dados)]);
    } catch (e) { console.error('[LOG]', e.message); }
}

// ═══════════════════════════════════════════════════════════════
// ROTAS - MÓDULOS
// ═══════════════════════════════════════════════════════════════
const authRoutes = require('./routes/auth')(pool, registrarLog);
app.use('/api/auth', authRoutes);

const usuariosRoutes = require('./routes/usuarios')(pool, auth, authAdmin, registrarLog);
app.use('/api/usuarios', usuariosRoutes);

const cadastrosRoutes = require('./routes/cadastros')(pool, auth, registrarLog);
app.use('/api/cadastros', cadastrosRoutes);

const cobrancasRoutes = require('./routes/cobrancas')(pool, auth, upload, registrarLog, asaasService);
app.use('/api/cobrancas', cobrancasRoutes);

const acordosRoutes = require('./routes/acordos')(pool, auth, registrarLog);
app.use('/api/acordos', acordosRoutes);

const acionamentosRoutes = require('./routes/acionamentos')(pool, auth, authAdmin, registrarLog);
app.use('/api/acionamentos', acionamentosRoutes);

const financeiroRoutes = require('./routes/financeiro')(pool, auth, registrarLog);
app.use('/api/financeiro', financeiroRoutes);

const integracoesRoutes = require('./routes/integracoes')(pool, auth, registrarLog);
app.use('/api/integracoes', integracoesRoutes);

const importacaoRoutes = require('./routes/importacao')(pool, auth, upload, registrarLog);
app.use('/api/importacao', importacaoRoutes);

const suriRoutes = require('./routes/suri')(pool, auth, registrarLog);
app.use('/api/suri', suriRoutes);
console.log('[SURI] Integração WhatsApp ✓');

const operacaoRoutes = require('./routes/operacao')(pool, auth, registrarLog);
app.use('/api/operacao', operacaoRoutes);
console.log('[OPERACAO] Painel Operacional ✓');

const relatoriosRoutes = require('./routes/relatorios')(pool, auth);
app.use('/api/relatorios', relatoriosRoutes);
console.log('[RELATORIOS] PDF + Excel ✓');

const templatesRoutes = require('./routes/templates-disparo')(pool, auth);
app.use('/api/templates', templatesRoutes);
console.log('[TEMPLATES] Disparo variável ✓');

// ── PORTAL DO CREDOR ───────────────────────────────────────────
// Registra todas as rotas /api/portal/* definidas em routes/portal.js
// Inclui: login, me, dashboard, carteira, acordos, export, admin/*
const portalRoutes = require('./routes/portal')(pool, registrarLog);
app.use('/api/portal', portalRoutes);
console.log('[PORTAL] Portal do Credor ✓');

// ── CRON JOBS ──────────────────────────────────────────────────
pool.query('SELECT 1').then(() => {
    const cronJobs = require('./cron-jobs')(pool);
    console.log('[CRON] Jobs agendados ✓');

    app.post('/api/admin/cron/:job', authAdmin, async (req, res) => {
        try {
            const jobs = {
                'parcelas-vencendo': cronJobs.notificarParcelasVencendo,
                'parcelas-vencidas': cronJobs.notificarParcelasVencidas,
                'cobrancas-amanha':  cronJobs.notificarCobrancasAmanha
            };
            const fn = jobs[req.params.job];
            if (!fn) return res.status(404).json({ error: 'Job não encontrado' });
            await fn();
            res.json({ success: true, message: `Job ${req.params.job} executado` });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
}).catch(e => console.error('[CRON] Erro ao iniciar jobs:', e.message));

// ═══════════════════════════════════════════════════════════════
// ROTAS LEGADO
// ═══════════════════════════════════════════════════════════════
app.use('/api/credores',    (req, res, next) => { req.url = '/credores'    + req.url; cadastrosRoutes(req, res, next); });
app.use('/api/clientes',    (req, res, next) => { req.url = '/clientes'    + req.url; cadastrosRoutes(req, res, next); });
app.use('/api/empresas',    (req, res, next) => { req.url = '/empresas'    + req.url; cadastrosRoutes(req, res, next); });
app.use('/api/parcelas',    (req, res, next) => { req.url = '/parcelas'    + req.url; acordosRoutes(req, res, next); });
app.post('/api/importacao/clientes', auth, upload.single('file'), (req, res, next) => { req.url = '/importar/clientes'; cobrancasRoutes(req, res, next); });
app.post('/api/importacao/cobrancas', auth, upload.single('file'), (req, res, next) => { req.url = '/importar/cobrancas'; cobrancasRoutes(req, res, next); });
app.post('/api/importacao/massa',    auth, upload.single('file'), (req, res, next) => { req.url = '/importar/massa';     cobrancasRoutes(req, res, next); });
app.use('/api/dashboard',      (req, res, next) => { req.url = '/dashboard'      + req.url; integracoesRoutes(req, res, next); });
app.use('/api/configuracoes',  (req, res, next) => { req.url = '/configuracoes'  + req.url; integracoesRoutes(req, res, next); });
app.use('/api/asaas',          (req, res, next) => { req.url = '/asaas'          + req.url; integracoesRoutes(req, res, next); });
app.use('/api/sync',           (req, res, next) => { req.url = '/sync'           + req.url; integracoesRoutes(req, res, next); });
app.use('/api/sync-asaas',     (req, res, next) => { req.url = '/sync'           + req.url; integracoesRoutes(req, res, next); });
app.use('/api/whatsapp',       (req, res, next) => { req.url = '/whatsapp'       + req.url; integracoesRoutes(req, res, next); });
app.use('/api/email',          (req, res, next) => { req.url = '/email'          + req.url; integracoesRoutes(req, res, next); });
app.use('/api/pdf',            (req, res, next) => { req.url = '/pdf'            + req.url; integracoesRoutes(req, res, next); });
app.use('/api/regua',          (req, res, next) => { req.url = '/regua'          + req.url; acionamentosRoutes(req, res, next); });
app.use('/api/agendamentos',   (req, res, next) => { req.url = '/agendamentos'   + req.url; acionamentosRoutes(req, res, next); });
app.use('/api/historico',      (req, res, next) => { req.url = '/historico'      + req.url; acionamentosRoutes(req, res, next); });
app.use('/api/comissoes',      (req, res, next) => { req.url = '/comissoes'      + req.url; financeiroRoutes(req, res, next); });
app.use('/api/repasses',       (req, res, next) => { req.url = '/repasses'       + req.url; financeiroRoutes(req, res, next); });

// ═══════════════════════════════════════════════════════════════
// ROTA /api/auth/me
// ═══════════════════════════════════════════════════════════════
app.get('/api/auth/me', auth, async (req, res) => {
    res.json({ success: true, user: req.user });
});

// ═══════════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        const isProd = process.env.NODE_ENV === 'production';
        res.json({ status: 'ok', timestamp: new Date().toISOString(), database: 'connected', version: '2.5.1', ...(isProd ? {} : { asaas: asaasService ? 'configured' : 'not_configured' }) });
    } catch (e) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

// ═══════════════════════════════════════════════════════════════
// FALLBACK
// ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint não encontrado' });
    let filePath = path.join(__dirname, 'public', req.path);
    if (!path.extname(filePath)) filePath += '.html';
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return res.sendFile(filePath);
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║            ACERTIVE - Sistema de Cobrança v2.5.1              ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  🚀 Servidor: http://localhost:${PORT}                          ║`);
    console.log('║                                                               ║');
    console.log('║  🔒 Segurança: Helmet+CSP, RateLimit, CORS, JWT ✓             ║');
    console.log('║                                                               ║');
    console.log('║  📦 Módulos:                                                  ║');
    console.log('║     auth, usuarios, cadastros, cobrancas, acordos             ║');
    console.log('║     acionamentos, financeiro, integracoes, suri               ║');
    console.log('║     operacao, relatorios, templates, cron-jobs                ║');
    console.log('║     portal ← NOVO                                             ║');
    console.log('║                                                               ║');
    console.log('║  🆕 Portal do Credor:                                         ║');
    console.log('║     🔐 Login próprio com JWT tipo=credor                      ║');
    console.log('║     📊 Dashboard, Carteira, Acordos                           ║');
    console.log('║     📁 Export Excel + PDF                                     ║');
    console.log('║     👥 Admin: criar/listar/toggle/resetar usuários            ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');
});