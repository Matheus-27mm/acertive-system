/**
 * ========================================
 * ACERTIVE - Sistema de Cobrança
 * server.js - Servidor Principal
 * ========================================
 * v2.4.0 - Segurança: Helmet + Rate Limiting
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
// SEGURANÇA - HELMET (headers HTTP seguros)
// ═══════════════════════════════════════════════════════════════
app.use(helmet({
    contentSecurityPolicy: false, // desabilitado pois o frontend usa CDNs externos
    crossOriginEmbedderPolicy: false
}));

// ═══════════════════════════════════════════════════════════════
// SEGURANÇA - RATE LIMITING
// ═══════════════════════════════════════════════════════════════

// Geral: 200 req por IP a cada 15 min
const limiterGeral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});

// Login: máximo 10 tentativas por IP a cada 15 min (anti força bruta)
const limiterLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' }
});

// Importação: máximo 5 uploads por IP por hora
const limiterImport = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Limite de importações atingido. Tente novamente em 1 hora.' }
});

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
// SERVIÇO ASAAS
// ═══════════════════════════════════════════════════════════════

const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_URL = process.env.ASAAS_SANDBOX === 'true'
    ? 'https://sandbox.asaas.com/api/v3'
    : 'https://api.asaas.com/api/v3';

const asaasService = ASAAS_API_KEY ? {
    async criarCliente(dados) {
        try {
            const response = await fetch(`${ASAAS_URL}/customers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY },
                body: JSON.stringify({
                    name: dados.name, cpfCnpj: dados.cpfCnpj,
                    email: dados.email || null, phone: dados.phone || null,
                    mobilePhone: dados.mobilePhone || dados.phone || null
                })
            });
            const result = await response.json();
            if (!response.ok) {
                if (result.errors?.some(e => e.code === 'invalid_cpfCnpj' || e.description?.includes('já cadastrado'))) {
                    return await this.buscarClientePorCpf(dados.cpfCnpj);
                }
                return null;
            }
            return result;
        } catch (error) { console.error('[ASAAS] criarCliente:', error.message); return null; }
    },

    async buscarClientePorCpf(cpfCnpj) {
        try {
            const cpfLimpo = cpfCnpj?.replace(/\D/g, '');
            if (!cpfLimpo) return null;
            const response = await fetch(`${ASAAS_URL}/customers?cpfCnpj=${cpfLimpo}`, { headers: { 'access_token': ASAAS_API_KEY } });
            const result = await response.json();
            return result.data?.length > 0 ? result.data[0] : null;
        } catch (error) { console.error('[ASAAS] buscarCliente:', error.message); return null; }
    },

    async criarCobranca(dados) {
        try {
            const body = {
                customer: dados.customer, billingType: dados.billingType || 'BOLETO',
                value: parseFloat(dados.value), dueDate: dados.dueDate,
                description: dados.description || 'Cobrança ACERTIVE',
                externalReference: dados.externalReference || null
            };
            if (dados.fine) body.fine = { value: dados.fine.value || 2, type: dados.fine.type || 'PERCENTAGE' };
            if (dados.interest) body.interest = { value: dados.interest.value || 1, type: dados.interest.type || 'PERCENTAGE' };
            const response = await fetch(`${ASAAS_URL}/payments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY },
                body: JSON.stringify(body)
            });
            const result = await response.json();
            if (!response.ok) { console.error('[ASAAS] criarCobranca:', result); return null; }
            return result;
        } catch (error) { console.error('[ASAAS] criarCobranca:', error.message); return null; }
    },

    async buscarCobranca(id) {
        try {
            const response = await fetch(`${ASAAS_URL}/payments/${id}`, { headers: { 'access_token': ASAAS_API_KEY } });
            return await response.json();
        } catch (error) { console.error('[ASAAS] buscarCobranca:', error.message); return null; }
    },

    async cancelarCobranca(id) {
        try {
            const response = await fetch(`${ASAAS_URL}/payments/${id}`, { method: 'DELETE', headers: { 'access_token': ASAAS_API_KEY } });
            return await response.json();
        } catch (error) { console.error('[ASAAS] cancelarCobranca:', error.message); return null; }
    },

    async gerarPixQrCode(paymentId) {
        try {
            const response = await fetch(`${ASAAS_URL}/payments/${paymentId}/pixQrCode`, { headers: { 'access_token': ASAAS_API_KEY } });
            return await response.json();
        } catch (error) { console.error('[ASAAS] gerarPix:', error.message); return null; }
    }
} : null;

if (asaasService) {
    console.log('[ASAAS] Serviço configurado -', ASAAS_URL.includes('sandbox') ? 'SANDBOX' : 'PRODUÇÃO');
} else {
    console.log('[ASAAS] Serviço NÃO configurado - defina ASAAS_API_KEY no .env');
}

// ═══════════════════════════════════════════════════════════════
// VALIDAÇÃO DE VARIÁVEIS CRÍTICAS
// ═══════════════════════════════════════════════════════════════

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('ERRO FATAL: JWT_SECRET não definido no .env');
    process.exit(1);
}
if (!process.env.DATABASE_URL) {
    console.error('ERRO FATAL: DATABASE_URL não definida no .env');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARES DE AUTENTICAÇÃO
// ═══════════════════════════════════════════════════════════════

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
        await pool.query(
            'INSERT INTO historico (usuario_id, acao, tabela, registro_id, dados, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
            [usuario_id, acao, tabela, registro_id, JSON.stringify(dados)]
        );
    } catch (error) {
        console.error('[LOG] Erro ao registrar:', error.message);
    }
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
console.log('[SURI] Integração WhatsApp configurada ✓');

const operacaoRoutes = require('./routes/operacao')(pool, auth, registrarLog);
app.use('/api/operacao', operacaoRoutes);
console.log('[OPERACAO] Painel Operacional configurado ✓');

// ═══════════════════════════════════════════════════════════════
// ROTAS LEGADO
// ═══════════════════════════════════════════════════════════════

app.use('/api/credores', (req, res, next) => { req.url = '/credores' + req.url; cadastrosRoutes(req, res, next); });
app.use('/api/clientes', (req, res, next) => { req.url = '/clientes' + req.url; cadastrosRoutes(req, res, next); });
app.use('/api/empresas', (req, res, next) => { req.url = '/empresas' + req.url; cadastrosRoutes(req, res, next); });
app.use('/api/parcelas', (req, res, next) => { req.url = '/parcelas' + req.url; acordosRoutes(req, res, next); });

app.post('/api/importacao/clientes', auth, upload.single('file'), (req, res, next) => { req.url = '/importar/clientes'; cobrancasRoutes(req, res, next); });
app.post('/api/importacao/cobrancas', auth, upload.single('file'), (req, res, next) => { req.url = '/importar/cobrancas'; cobrancasRoutes(req, res, next); });
app.post('/api/importacao/massa', auth, upload.single('file'), (req, res, next) => { req.url = '/importar/massa'; cobrancasRoutes(req, res, next); });

app.use('/api/dashboard', (req, res, next) => { req.url = '/dashboard' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/configuracoes', (req, res, next) => { req.url = '/configuracoes' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/asaas', (req, res, next) => { req.url = '/asaas' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/sync', (req, res, next) => { req.url = '/sync' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/sync-asaas', (req, res, next) => { req.url = '/sync' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/whatsapp', (req, res, next) => { req.url = '/whatsapp' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/email', (req, res, next) => { req.url = '/email' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/pdf', (req, res, next) => { req.url = '/pdf' + req.url; integracoesRoutes(req, res, next); });
app.use('/api/regua', (req, res, next) => { req.url = '/regua' + req.url; acionamentosRoutes(req, res, next); });
app.use('/api/agendamentos', (req, res, next) => { req.url = '/agendamentos' + req.url; acionamentosRoutes(req, res, next); });
app.use('/api/historico', (req, res, next) => { req.url = '/historico' + req.url; acionamentosRoutes(req, res, next); });
app.use('/api/comissoes', (req, res, next) => { req.url = '/comissoes' + req.url; financeiroRoutes(req, res, next); });
app.use('/api/repasses', (req, res, next) => { req.url = '/repasses' + req.url; financeiroRoutes(req, res, next); });
app.use('/api/relatorios', (req, res, next) => { req.url = '/relatorios' + req.url; financeiroRoutes(req, res, next); });

// ═══════════════════════════════════════════════════════════════
// ROTA /api/auth/me
// ═══════════════════════════════════════════════════════════════

app.get('/api/auth/me', auth, async (req, res) => {
    try {
        res.json({ success: true, user: req.user });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao buscar usuário' });
    }
});

// ═══════════════════════════════════════════════════════════════
// ROTA DE SAÚDE - sem expor detalhes em produção
// ═══════════════════════════════════════════════════════════════

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        const isProd = process.env.NODE_ENV === 'production';
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: 'connected',
            version: '2.4.0',
            ...(isProd ? {} : {
                asaas: asaasService ? 'configured' : 'not_configured',
                asaas_mode: ASAAS_URL?.includes('sandbox') ? 'sandbox' : 'production',
                modules: ['auth', 'usuarios', 'cadastros', 'cobrancas', 'acordos', 'acionamentos', 'financeiro', 'integracoes', 'suri', 'operacao']
            })
        });
    } catch (error) {
        // Não expõe detalhes do erro em produção
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

// ═══════════════════════════════════════════════════════════════
// FALLBACK
// ═══════════════════════════════════════════════════════════════

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Endpoint não encontrado' });
    }
    let filePath = path.join(__dirname, 'public', req.path);
    if (!path.extname(filePath)) filePath += '.html';
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return res.sendFile(filePath);
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ═══════════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║            ACERTIVE - Sistema de Cobrança v2.4                ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  🚀 Servidor: http://localhost:${PORT}                          ║`);
    console.log('║                                                               ║');
    console.log('║  🔒 Segurança:                                                ║');
    console.log('║     • Helmet     - Headers HTTP seguros ✓                     ║');
    console.log('║     • RateLimit  - Proteção força bruta ✓                     ║');
    console.log('║     • CORS       - Domínios restritos ✓                       ║');
    console.log('║     • JWT        - Autenticação por token ✓                   ║');
    console.log('║     • .env       - Variáveis isoladas ✓                       ║');
    console.log('║                                                               ║');
    console.log('║  📦 Módulos: auth, usuarios, cadastros, cobrancas,            ║');
    console.log('║     acordos, acionamentos, financeiro, integracoes,           ║');
    console.log('║     suri, operacao                                            ║');
    console.log('║                                                               ║');
    console.log(`║  🔗 Asaas: ${asaasService ? (ASAAS_URL.includes('sandbox') ? 'SANDBOX ✓' : 'PRODUÇÃO ✓') : 'NÃO CONFIGURADO'}                                  ║`);
    console.log('║  💬 Suri:  CONFIGURADO ✓                                      ║');
    console.log('║  📊 Oper:  CONFIGURADO ✓                                      ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');
});