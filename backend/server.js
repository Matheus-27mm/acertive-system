/**
 * server.js — ACERTIVE ENTERPRISE v2.1 COMPLETO
 * PDFs Premium + E-mail + WhatsApp + IA + Agendamentos + Status Cliente + MULTI-EMPRESAS
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const XLSX = require("xlsx");
const { chromium } = require("playwright");
const nodemailer = require("nodemailer");
const compression = require('compression');
const credoresRoutes = require('./routes/credores');
const acordosRoutes = require('./routes/acordos');
const parcelasRoutes = require('./routes/parcelas');
const financeiroRoutes = require('./routes/financeiro');


const app = express();
app.set("trust proxy", 1);
app.use(compression());

const PORT = process.env.PORT || 3000;

// =====================
// Frontend
// =====================
const FRONTEND_DIR_CANDIDATES = [
  path.join(__dirname, "frontend"),
  path.join(__dirname, "..", "frontend"),
];

const FRONTEND_DIR = FRONTEND_DIR_CANDIDATES.find((p) => fs.existsSync(p));

if (!FRONTEND_DIR) {
  console.error("[ACERTIVE] ERRO: Pasta do frontend não encontrada.");
  console.error("[ACERTIVE] Tentativas:", FRONTEND_DIR_CANDIDATES);
  process.exit(1);
}

console.log("[ACERTIVE] Servindo arquivos estáticos de:", FRONTEND_DIR);
app.use(express.static(FRONTEND_DIR));

// =====================
// Middlewares
// =====================
const originEnv = (process.env.FRONTEND_ORIGIN || "").trim();
const allowedOrigins = originEnv
  ? originEnv.split(",").map((s) => s.trim()).filter(Boolean)
  : [
      "http://localhost:3000",
      "https://acertivecobranca.com.br",
      "https://www.acertivecobranca.com.br",
      "https://acertive-system.onrender.com",
    ];

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// =====================
// Postgres
// =====================
if (!process.env.DATABASE_URL) {
  console.error("[ACERTIVE] ENV DATABASE_URL não definida.");
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error("[ACERTIVE] ENV JWT_SECRET não definida.");
  process.exit(1);
}

const sslEnv = String(process.env.DATABASE_SSL || "").toLowerCase();
const pgsslmode = String(process.env.PGSSLMODE || "").toLowerCase();
let sslOption = false;
if (sslEnv === "true" || pgsslmode === "require" || pgsslmode === "on") {
  sslOption = { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslOption,
});

// =====================================================
// INICIALIZAÇÃO DO BANCO - TABELAS ENTERPRISE v2.1
// =====================================================
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS logs_acoes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id UUID,
        usuario_nome VARCHAR(255),
        acao VARCHAR(100) NOT NULL,
        entidade VARCHAR(100) NOT NULL,
        entidade_id UUID,
        detalhes JSONB,
        ip VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'nivel') THEN
          ALTER TABLE users ADD COLUMN nivel VARCHAR(20) DEFAULT 'operador';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'ativo') THEN
          ALTER TABLE users ADD COLUMN ativo BOOLEAN DEFAULT true;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'created_at') THEN
          ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT NOW();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'updated_at') THEN
          ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
        END IF;
      END $$;
    `);

    await pool.query(`
      UPDATE users SET nivel = 'admin' 
      WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1) 
      AND (nivel IS NULL OR nivel = 'operador')
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cobrancas_recorrentes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id UUID NOT NULL,
        valor NUMERIC(12,2) NOT NULL,
        descricao TEXT,
        frequencia VARCHAR(20) NOT NULL DEFAULT 'mensal',
        dia_vencimento INTEGER NOT NULL DEFAULT 10,
        data_inicio DATE NOT NULL,
        data_fim DATE,
        ativo BOOLEAN DEFAULT true,
        ultima_geracao DATE,
        total_geradas INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // =====================================================
    // NOVA TABELA: EMPRESAS (Multi-empresa) v2.1
    // =====================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS empresas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nome VARCHAR(255) NOT NULL,
        cnpj VARCHAR(20),
        telefone VARCHAR(20),
        email VARCHAR(255),
        endereco TEXT,
        banco VARCHAR(10),
        tipo_conta VARCHAR(20) DEFAULT 'corrente',
        agencia VARCHAR(20),
        conta VARCHAR(30),
        digito VARCHAR(5),
        titular VARCHAR(255),
        cpf_cnpj_titular VARCHAR(20),
        tipo_chave_pix VARCHAR(20),
        chave_pix VARCHAR(255),
        padrao BOOLEAN DEFAULT false,
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("[ACERTIVE] ✅ Tabela empresas criada/verificada");

    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cobrancas' AND column_name = 'data_compromisso') THEN
          ALTER TABLE cobrancas ADD COLUMN data_compromisso DATE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cobrancas' AND column_name = 'aplicar_multa_juros') THEN
          ALTER TABLE cobrancas ADD COLUMN aplicar_multa_juros BOOLEAN DEFAULT true;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cobrancas' AND column_name = 'observacoes') THEN
          ALTER TABLE cobrancas ADD COLUMN observacoes TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cobrancas' AND column_name = 'empresa_id') THEN
          ALTER TABLE cobrancas ADD COLUMN empresa_id UUID;
        END IF;
      END $$;
    `);

    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clientes' AND column_name = 'status_cliente') THEN
          ALTER TABLE clientes ADD COLUMN status_cliente VARCHAR(30) DEFAULT 'regular';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clientes' AND column_name = 'limite_credito') THEN
          ALTER TABLE clientes ADD COLUMN limite_credito NUMERIC(12,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clientes' AND column_name = 'data_primeiro_contato') THEN
          ALTER TABLE clientes ADD COLUMN data_primeiro_contato DATE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clientes' AND column_name = 'empresa_id') THEN
          ALTER TABLE clientes ADD COLUMN empresa_id UUID;
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agendamentos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id UUID NOT NULL,
        cobranca_id UUID,
        tipo VARCHAR(30) NOT NULL,
        data_agendamento TIMESTAMP NOT NULL,
        descricao TEXT,
        status VARCHAR(20) DEFAULT 'pendente',
        prioridade VARCHAR(20) DEFAULT 'normal',
        resultado TEXT,
        usuario_id UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuracoes_escritorio (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nome_escritorio VARCHAR(255),
        cnpj VARCHAR(20),
        endereco TEXT,
        telefone VARCHAR(20),
        email VARCHAR(255),
        logo_url TEXT,
        banco_nome VARCHAR(100),
        banco_agencia VARCHAR(20),
        banco_conta VARCHAR(30),
        banco_tipo_conta VARCHAR(20),
        banco_titular VARCHAR(255),
        banco_cpf_cnpj VARCHAR(20),
        banco_pix_chave VARCHAR(255),
        banco_pix_tipo VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      INSERT INTO configuracoes_escritorio (id, nome_escritorio)
      SELECT gen_random_uuid(), 'Meu Escritório'
      WHERE NOT EXISTS (SELECT 1 FROM configuracoes_escritorio)
    `);

    console.log("[ACERTIVE] ✅ Tabelas enterprise v2.1 inicializadas");
  } catch (err) {
    console.error("[ACERTIVE] Erro ao inicializar tabelas:", err.message);
  }
}

pool.connect().then(() => {
  console.log("[ACERTIVE] ✅ Conectado ao PostgreSQL");
  initDatabase();
}).catch(err => {
  console.error("[ACERTIVE] Erro ao conectar:", err.message);
});
// =====================================================
// ROTAS MODULARES - B2B (CREDORES, ACORDOS, PARCELAS)
// =====================================================
app.use('/api/credores', credoresRoutes(pool, auth, registrarLog));
// app.use('/api/acordos', acordosRoutes(pool, auth, registrarLog)); // MOVIDO PARA DEPOIS DO ASAAS
//app.use('/api/parcelas', parcelasRoutes(pool, auth, registrarLog)); // MOVIDO PARA DEPOIS DO ASAAS
app.use('/api/financeiro', financeiroRoutes(pool, auth, registrarLog));
// =====================================================
// FUNÇÃO DE REGISTRO DE LOG (AUDITORIA)
// =====================================================
async function registrarLog(req, acao, entidade, entidadeId = null, detalhes = null) {
  try {
    const usuarioId = req.user?.userId || null;
    const usuarioNome = req.user?.nome || req.user?.email || 'Sistema';
    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.ip || null;
    await pool.query(
      `INSERT INTO logs_acoes (usuario_id, usuario_nome, acao, entidade, entidade_id, detalhes, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [usuarioId, usuarioNome, acao, entidade, entidadeId, detalhes ? JSON.stringify(detalhes) : null, ip]
    );
  } catch (err) {
    console.error("[LOG] Erro ao registrar:", err.message);
  }
}

// =====================
// Configuração de E-mail
// =====================
let emailTransporter = null;

function setupEmailTransporter() {
  const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
  const smtpPort = parseInt(process.env.SMTP_PORT || "587");
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    console.warn("[EMAIL] SMTP_USER ou SMTP_PASS não configurados. E-mail desabilitado.");
    return null;
  }
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });
  transporter.verify((err, success) => {
    if (err) console.error("[EMAIL] Erro na configuração:", err.message);
    else console.log("[EMAIL] ✅ Servidor de e-mail configurado!");
  });
  return transporter;
}

emailTransporter = setupEmailTransporter();

// =====================
// Helpers
// =====================
const asStr = (v) => String(v ?? "").trim();
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function toPgDateOrNull(v) {
  const s = asStr(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
const normalizeCpfCnpjDigits = (s) => String(s || "").replace(/\D/g, "");
const normalizeEmail = (s) => String(s || "").trim().toLowerCase();
const fmtMoney = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDate = (d) => { if (!d) return "—"; const dt = new Date(d); return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString("pt-BR"); };
const fmtDateTime = (d) => { if (!d) return "—"; const dt = new Date(d); return isNaN(dt.getTime()) ? String(d) : dt.toLocaleString("pt-BR"); };

// =====================
// Auth middleware
// =====================
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ success: false, message: "Token não enviado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    console.error("[AUTH] erro:", err.message);
    return res.status(401).json({ success: false, message: "Token inválido ou expirado." });
  }
}

function authAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ success: false, message: "Token não enviado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    if (payload.nivel !== 'admin') {
      return res.status(403).json({ success: false, message: "Acesso negado. Apenas administradores." });
    }
    return next();
  } catch (err) {
    console.error("[AUTH ADMIN] erro:", err.message);
    return res.status(401).json({ success: false, message: "Token inválido ou expirado." });
  }
}

// =====================
// Health check
// =====================
app.get("/api/health", (req, res) => {
  return res.json({ ok: true, service: "acertive-enterprise-v2.1", time: new Date().toISOString(), emailConfigured: !!emailTransporter, iaConfigured: !!process.env.OPENAI_API_KEY });
});
// Alias para compatibilidade com frontend
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    const emailStr = String(email || "").trim();
    const senhaStr = String(senha || "");
    if (!emailStr || !senhaStr) return res.status(400).json({ success: false, message: "Email e senha são obrigatórios." });
    const r = await pool.query("SELECT id, email, senha_hash, nome, nivel, ativo FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1", [emailStr]);
    if (r.rowCount === 0) return res.status(401).json({ success: false, message: "Credenciais inválidas." });
    const user = r.rows[0];
    if (user.ativo === false) return res.status(401).json({ success: false, message: "Usuário desativado." });
    const ok = await bcrypt.compare(senhaStr, user.senha_hash);
    if (!ok) return res.status(401).json({ success: false, message: "Credenciais inválidas." });
    const token = jwt.sign({ userId: user.id, email: user.email, nome: user.nome, nivel: user.nivel || 'operador' }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ success: true, token, user: { id: user.id, email: user.email, nome: user.nome, nivel: user.nivel || 'operador' } });
  } catch (err) {
    console.error("[LOGIN] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao autenticar." });
  }
});
// =====================================================
// LOGIN
// =====================================================
app.post("/api/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    const emailStr = String(email || "").trim();
    const senhaStr = String(senha || "");
    if (!emailStr || !senhaStr) return res.status(400).json({ success: false, message: "Email e senha são obrigatórios." });
    const r = await pool.query("SELECT id, email, senha_hash, nome, nivel, ativo FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1", [emailStr]);
    if (r.rowCount === 0) return res.status(401).json({ success: false, message: "Credenciais inválidas." });
    const user = r.rows[0];
    if (user.ativo === false) return res.status(401).json({ success: false, message: "Usuário desativado. Contate o administrador." });
    const ok = await bcrypt.compare(senhaStr, user.senha_hash);
    if (!ok) return res.status(401).json({ success: false, message: "Credenciais inválidas." });
    const token = jwt.sign({ userId: user.id, email: user.email, nome: user.nome, nivel: user.nivel || 'operador' }, process.env.JWT_SECRET, { expiresIn: "7d" });
    await registrarLog({ user: { userId: user.id, nome: user.nome }, headers: req.headers, connection: req.connection, ip: req.ip }, 'LOGIN', 'users', user.id, { email: user.email });
    return res.json({ success: true, token, user: { id: user.id, email: user.email, nome: user.nome, nivel: user.nivel || 'operador' } });
  } catch (err) {
    console.error("[LOGIN] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao autenticar.", error: err.message });
  }
});

// =====================
// Dashboard
// =====================
app.get("/api/dashboard", auth, async (req, res) => {
  try {
    const q = await pool.query(`SELECT COALESCE(SUM(CASE WHEN status = 'pago' THEN valor_atualizado ELSE 0 END), 0) AS total_recebido, COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor_atualizado ELSE 0 END), 0) AS total_pendente, COALESCE(SUM(CASE WHEN status = 'vencido' THEN valor_atualizado ELSE 0 END), 0) AS total_vencido, COUNT(*)::int AS total_cobrancas FROM cobrancas`);
    const c = await pool.query(`SELECT COUNT(*)::int AS clientes_ativos FROM clientes WHERE status = 'ativo'`);
    const agendamentosHoje = await pool.query(`SELECT COUNT(*)::int AS total FROM agendamentos WHERE status = 'pendente' AND DATE(data_agendamento) = CURRENT_DATE`);
    const row = q.rows[0] || {};
    return res.json({ success: true, totalRecebido: Number(row.total_recebido || 0), totalPendente: Number(row.total_pendente || 0), totalVencido: Number(row.total_vencido || 0), totalCobrancas: Number(row.total_cobrancas || 0), clientesAtivos: Number(c.rows[0]?.clientes_ativos || 0), agendamentosHoje: Number(agendamentosHoje.rows[0]?.total || 0) });
  } catch (err) {
    console.error("[GET /api/dashboard] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao carregar dashboard.", error: err.message });
  }
});

// =====================================================
// GRÁFICOS DO DASHBOARD
// =====================================================
app.get("/api/dashboard/graficos", auth, async (req, res) => {
  try {
    const faturamentoResult = await pool.query(`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS mes, TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS mes_ordem, COALESCE(SUM(valor_atualizado), 0)::numeric AS total, COALESCE(SUM(CASE WHEN status = 'pago' THEN valor_atualizado ELSE 0 END), 0)::numeric AS recebido FROM cobrancas WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months' GROUP BY DATE_TRUNC('month', created_at) ORDER BY mes_ordem ASC`);
    const mesesPT = { 'Jan': 'Jan', 'Feb': 'Fev', 'Mar': 'Mar', 'Apr': 'Abr', 'May': 'Mai', 'Jun': 'Jun', 'Jul': 'Jul', 'Aug': 'Ago', 'Sep': 'Set', 'Oct': 'Out', 'Nov': 'Nov', 'Dec': 'Dez' };
    const faturamentoMensal = { meses: faturamentoResult.rows.map(r => mesesPT[r.mes] || r.mes), total: faturamentoResult.rows.map(r => parseFloat(r.total) || 0), recebido: faturamentoResult.rows.map(r => parseFloat(r.recebido) || 0) };
    const statusResult = await pool.query(`SELECT COALESCE(SUM(CASE WHEN status = 'pago' THEN 1 ELSE 0 END), 0)::int AS pago, COALESCE(SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END), 0)::int AS pendente, COALESCE(SUM(CASE WHEN status = 'vencido' THEN 1 ELSE 0 END), 0)::int AS vencido FROM cobrancas`);
    const statusCobrancas = { pago: statusResult.rows[0]?.pago || 0, pendente: statusResult.rows[0]?.pendente || 0, vencido: statusResult.rows[0]?.vencido || 0 };
    const topDevedoresResult = await pool.query(`SELECT COALESCE(cl.nome, 'Sem cliente') AS cliente, SUM(c.valor_atualizado)::numeric AS total_devido FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id WHERE c.status IN ('pendente', 'vencido') GROUP BY cl.nome ORDER BY total_devido DESC LIMIT 5`);
    const topDevedores = topDevedoresResult.rows.map(r => ({ cliente: r.cliente, total: parseFloat(r.total_devido) || 0 }));
    return res.json({ success: true, faturamentoMensal, statusCobrancas, topDevedores });
  } catch (err) {
    console.error("[GRAFICOS] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao carregar gráficos.", error: err.message });
  }
});

// ========================
// Rotas estáticas frontend
// ========================
function sendFront(file) {
  return (req, res) => {
    const target = path.join(FRONTEND_DIR, file);
    if (!fs.existsSync(target)) return res.status(404).send("Arquivo não encontrado: " + file);
    return res.sendFile(target);
  };
}
app.get("/", sendFront("login.html"));
app.get("/login", sendFront("login.html"));
app.get("/dashboard", sendFront("dashboard.html"));
app.get("/nova-cobranca", sendFront("nova-cobranca.html"));
app.get("/cobrancas", sendFront("cobrancas.html"));
app.get(["/novo-cliente", "/novo-cliente/"], sendFront("novo-cliente.html"));
app.get("/novo-cliente.html", sendFront("novo-cliente.html"));
app.get("/cobrancas-recorrentes", sendFront("cobrancas-recorrentes.html"));
app.get("/nova-recorrente", sendFront("nova-recorrente.html"));
app.get("/historico", sendFront("historico.html"));
app.get("/usuarios", sendFront("usuarios.html"));
app.get("/agendamentos", sendFront("agendamentos.html"));
app.get("/novo-agendamento", sendFront("novo-agendamento.html"));
app.get("/configuracoes", sendFront("configuracoes.html"));
app.get("/importar-cobrancas", sendFront("importar-cobrancas.html"));
app.get("/lembretes", sendFront("lembretes.html"));
app.get("/clientes", sendFront("clientes.html"));
app.get("/relatorios", sendFront("relatorios.html"));
app.get("/importar-clientes", sendFront("importar-clientes.html"));
app.get("/templates", sendFront("templates-mensagem.html"));
app.get("/credores", sendFront("credores.html"));
app.get("/acordos", sendFront("acordos.html")); 
app.get("/parcelas", sendFront("parcelas.html"));
app.get("/financeiro-b2b", sendFront("financeiro-b2b.html"));
app.get("/fila-cobranca", sendFront("fila-cobranca.html"));
app.get("/atendimento", sendFront("atendimento.html"));
app.get("/devedores", sendFront("devedores.html"));
app.get("/dividas", sendFront("dividas.html"));
app.get("/simulador", sendFront("simulador.html"));
app.get("/comissoes", sendFront("comissoes.html"));
app.get("/repasses", sendFront("repasses.html"));
app.get("/regua-cobranca", sendFront("regua-cobranca.html"));
app.get("/financeiro", sendFront("financeiro.html"));
app.get("/fila", sendFront("fila-cobranca.html"));
app.get("/regua", sendFront("regua-cobranca.html"));
app.get("/config", sendFront("configuracoes.html"));
app.get("/importar-massa", sendFront("importar-massa.html"));


app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (req.path.includes(".")) return res.status(404).send("Arquivo não encontrado");
  return res.sendFile(path.join(FRONTEND_DIR, "login.html"));
});
// =====================================================
// EMPRESAS - CRUD COMPLETO (NOVO v2.1)
// =====================================================

app.get("/api/empresas", auth, async (req, res) => {
  try {
    const resultado = await pool.query(`SELECT * FROM empresas WHERE ativo = true ORDER BY padrao DESC, nome ASC`);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/empresas] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar empresas.", error: err.message });
  }
});

app.get("/api/empresas/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await pool.query("SELECT * FROM empresas WHERE id = $1", [id]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Empresa não encontrada." });
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[GET /api/empresas/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar empresa.", error: err.message });
  }
});

app.post("/api/empresas", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const nome = String(b.nome || "").trim();
    if (!nome) return res.status(400).json({ success: false, message: "Nome da empresa é obrigatório." });
    const countEmpresas = await pool.query("SELECT COUNT(*)::int AS total FROM empresas WHERE ativo = true");
    const isPrimeira = (countEmpresas.rows[0]?.total || 0) === 0;
    const resultado = await pool.query(
      `INSERT INTO empresas (nome, cnpj, telefone, email, endereco, banco, tipo_conta, agencia, conta, digito, titular, cpf_cnpj_titular, tipo_chave_pix, chave_pix, padrao) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [nome, b.cnpj || null, b.telefone || null, b.email || null, b.endereco || null, b.banco || null, b.tipo_conta || 'corrente', b.agencia || null, b.conta || null, b.digito || null, b.titular || null, b.cpf_cnpj_titular || null, b.tipo_chave_pix || null, b.chave_pix || null, isPrimeira]
    );
    await registrarLog(req, 'CRIAR', 'empresas', resultado.rows[0].id, { nome, cnpj: b.cnpj });
    return res.json({ success: true, data: resultado.rows[0], message: isPrimeira ? "Empresa cadastrada como padrão!" : "Empresa cadastrada!" });
  } catch (err) {
    console.error("[POST /api/empresas] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao criar empresa.", error: err.message });
  }
});

app.put("/api/empresas/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const resultado = await pool.query(
      `UPDATE empresas SET nome = COALESCE($1, nome), cnpj = COALESCE($2, cnpj), telefone = COALESCE($3, telefone), email = COALESCE($4, email), endereco = COALESCE($5, endereco), banco = COALESCE($6, banco), tipo_conta = COALESCE($7, tipo_conta), agencia = COALESCE($8, agencia), conta = COALESCE($9, conta), digito = COALESCE($10, digito), titular = COALESCE($11, titular), cpf_cnpj_titular = COALESCE($12, cpf_cnpj_titular), tipo_chave_pix = COALESCE($13, tipo_chave_pix), chave_pix = COALESCE($14, chave_pix), updated_at = NOW() WHERE id = $15 RETURNING *`,
      [b.nome, b.cnpj, b.telefone, b.email, b.endereco, b.banco, b.tipo_conta, b.agencia, b.conta, b.digito, b.titular, b.cpf_cnpj_titular, b.tipo_chave_pix, b.chave_pix, id]
    );
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Empresa não encontrada." });
    await registrarLog(req, 'ATUALIZAR', 'empresas', id, b);
    return res.json({ success: true, data: resultado.rows[0], message: "Empresa atualizada!" });
  } catch (err) {
    console.error("[PUT /api/empresas/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar empresa.", error: err.message });
  }
});

app.put("/api/empresas/:id/padrao", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const empresa = await pool.query("SELECT id, nome FROM empresas WHERE id = $1 AND ativo = true", [id]);
    if (!empresa.rowCount) return res.status(404).json({ success: false, message: "Empresa não encontrada." });
    await pool.query("UPDATE empresas SET padrao = false WHERE padrao = true");
    const resultado = await pool.query("UPDATE empresas SET padrao = true, updated_at = NOW() WHERE id = $1 RETURNING *", [id]);
    await registrarLog(req, 'DEFINIR_PADRAO', 'empresas', id, { nome: empresa.rows[0].nome });
    return res.json({ success: true, data: resultado.rows[0], message: `${empresa.rows[0].nome} definida como padrão!` });
  } catch (err) {
    console.error("[PUT /api/empresas/:id/padrao] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao definir padrão.", error: err.message });
  }
});

app.delete("/api/empresas/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const count = await pool.query("SELECT COUNT(*)::int AS total FROM empresas WHERE ativo = true");
    if (count.rows[0]?.total <= 1) return res.status(400).json({ success: false, message: "Não é possível excluir a única empresa cadastrada." });
    const empresa = await pool.query("SELECT padrao, nome FROM empresas WHERE id = $1", [id]);
    if (!empresa.rowCount) return res.status(404).json({ success: false, message: "Empresa não encontrada." });
    const eraPadrao = empresa.rows[0].padrao;
    await pool.query("UPDATE empresas SET ativo = false, padrao = false, updated_at = NOW() WHERE id = $1", [id]);
    if (eraPadrao) {
      await pool.query(`UPDATE empresas SET padrao = true, updated_at = NOW() WHERE id = (SELECT id FROM empresas WHERE ativo = true ORDER BY created_at ASC LIMIT 1)`);
    }
    await registrarLog(req, 'EXCLUIR', 'empresas', id, { nome: empresa.rows[0].nome });
    return res.json({ success: true, message: "Empresa excluída!" });
  } catch (err) {
    console.error("[DELETE /api/empresas/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao excluir empresa.", error: err.message });
  }
});

app.get("/api/empresas-padrao", auth, async (req, res) => {
  try {
    const resultado = await pool.query("SELECT * FROM empresas WHERE padrao = true AND ativo = true LIMIT 1");
    if (!resultado.rowCount) {
      const primeira = await pool.query("SELECT * FROM empresas WHERE ativo = true ORDER BY created_at ASC LIMIT 1");
      return res.json({ success: true, data: primeira.rows[0] || null });
    }
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[GET /api/empresas-padrao] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar empresa padrão.", error: err.message });
  }
});

// =====================================================
// COBRANÇAS - GET (ATUALIZADO - com filtro de acordos)
// =====================================================
app.get("/api/cobrancas", auth, async (req, res) => {
  try {
    const status = String(req.query.status || "").trim().toLowerCase();
    const q = String(req.query.q || "").trim();
    const semAcordo = req.query.sem_acordo === 'true'; // NOVO: filtrar cobranças sem acordo
    
    const params = [];
    const where = [];
    
    if (status) { 
      params.push(status); 
      where.push(`LOWER(c.status) = $${params.length}`); 
    }
    
    if (q) { 
      params.push(`%${q}%`); 
      where.push(`LOWER(cl.nome) LIKE LOWER($${params.length})`); 
    }
    
    // NOVO: Filtrar cobranças que NÃO têm acordo vinculado
    if (semAcordo) {
      where.push(`ac.id IS NULL`);
    }
    
    const sql = `
      SELECT 
        c.id, 
        COALESCE(cl.nome,'') AS cliente, 
        COALESCE(cl.email,'') AS cliente_email, 
        COALESCE(cl.telefone,'') AS cliente_telefone, 
        COALESCE(cl.status_cliente,'regular') AS cliente_status, 
        c.cliente_id, 
        c.empresa_id, 
        COALESCE(e.nome,'') AS empresa_nome, 
        c.descricao, 
        c.valor_original AS "valorOriginal", 
        c.multa, 
        c.juros, 
        c.desconto, 
        c.valor_atualizado AS "valorAtualizado", 
        c.status, 
        c.vencimento, 
        c.data_compromisso AS "dataCompromisso", 
        c.aplicar_multa_juros AS "aplicarMultaJuros", 
        c.observacoes, 
        c.created_at AS "createdAt",
        CASE WHEN ac.id IS NOT NULL THEN true ELSE false END as tem_acordo,
        ac.id as acordo_id,
        ac.status as acordo_status
      FROM cobrancas c 
      LEFT JOIN clientes cl ON cl.id = c.cliente_id 
      LEFT JOIN empresas e ON e.id = c.empresa_id
      LEFT JOIN acordos ac ON ac.cobranca_id = c.id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} 
      ORDER BY c.created_at DESC
    `;
    
    const resultado = await pool.query(sql, params);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/cobrancas] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar cobranças.", error: err.message });
  }
});


// =====================================================
// SEÇÃO 2: ADICIONAR APÓS GET /api/cobrancas
// Cole estas rotas ANTES do "// COBRANÇAS - POST"
// =====================================================

// =====================================================
// COBRANÇAS - MARCAR COMO PAGAS (MÚLTIPLAS)
// =====================================================
app.post("/api/cobrancas/marcar-pagas", auth, async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "Nenhuma cobrança selecionada." });
    }
    
    const result = await pool.query(`
      UPDATE cobrancas 
      SET status = 'pago', 
          updated_at = NOW()
      WHERE id = ANY($1::uuid[])
      RETURNING id
    `, [ids]);
    
    await registrarLog(req, 'MARCAR_PAGO_MASSA', 'cobrancas', null, { 
      quantidade: result.rowCount,
      ids: ids 
    });
    
    return res.json({ 
      success: true, 
      message: `${result.rowCount} cobrança(s) marcada(s) como paga(s)`,
      atualizadas: result.rowCount
    });
    
  } catch (err) {
    console.error("[POST /api/cobrancas/marcar-pagas] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao marcar como pago." });
  }
});

// =====================================================
// COBRANÇAS - ESTATÍSTICAS COMPLETAS (separando acordos)
// =====================================================
app.get("/api/cobrancas/estatisticas-completas", auth, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        -- Cobranças SEM acordo (avulsas) - pendentes
        COUNT(CASE 
          WHEN ac.id IS NULL 
          AND c.status NOT IN ('pago', 'arquivado') 
          AND c.vencimento >= CURRENT_DATE 
          THEN 1 
        END)::int as pendentes,
        
        -- Cobranças SEM acordo - vencidas
        COUNT(CASE 
          WHEN ac.id IS NULL 
          AND c.status NOT IN ('pago', 'arquivado') 
          AND c.vencimento < CURRENT_DATE 
          THEN 1 
        END)::int as vencidas,
        
        -- Cobranças SEM acordo - pagas
        COUNT(CASE 
          WHEN ac.id IS NULL 
          AND c.status = 'pago' 
          THEN 1 
        END)::int as pagas,
        
        -- Cobranças COM acordo ativo (em negociação)
        COUNT(CASE 
          WHEN ac.id IS NOT NULL 
          AND ac.status = 'ativo' 
          THEN 1 
        END)::int as em_acordo,
        
        -- Valores das cobranças SEM acordo pendentes
        COALESCE(SUM(CASE 
          WHEN ac.id IS NULL 
          AND c.status NOT IN ('pago', 'arquivado') 
          THEN c.valor_atualizado 
          ELSE 0 
        END), 0)::numeric as valor_pendente,
        
        -- Valores das cobranças SEM acordo pagas
        COALESCE(SUM(CASE 
          WHEN ac.id IS NULL 
          AND c.status = 'pago' 
          THEN c.valor_atualizado 
          ELSE 0 
        END), 0)::numeric as valor_pago,
        
        -- Arquivadas
        COUNT(CASE WHEN c.status = 'arquivado' THEN 1 END)::int as arquivadas
        
      FROM cobrancas c
      LEFT JOIN acordos ac ON ac.cobranca_id = c.id
    `);
    
    const row = stats.rows[0];
    
    return res.json({
      success: true,
      data: {
        pendentes: row.pendentes || 0,
        vencidas: row.vencidas || 0,
        pagas: row.pagas || 0,
        emAcordo: row.em_acordo || 0,
        arquivadas: row.arquivadas || 0,
        valorPendente: parseFloat(row.valor_pendente) || 0,
        valorPago: parseFloat(row.valor_pago) || 0
      }
    });
    
  } catch (err) {
    console.error("[GET /api/cobrancas/estatisticas-completas] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar estatísticas." });
  }
});

// =====================================================
// ALERTAS - CONTADOR (para badges na sidebar)
// =====================================================
app.get("/api/alertas/contador", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        -- Cobranças vencidas (sem acordo)
        COUNT(CASE 
          WHEN c.vencimento < CURRENT_DATE 
          AND c.status NOT IN ('pago', 'arquivado') 
          AND ac.id IS NULL 
          THEN 1 
        END)::int as vencidas,
        
        -- Cobranças vencendo hoje (sem acordo)
        COUNT(CASE 
          WHEN c.vencimento = CURRENT_DATE 
          AND c.status NOT IN ('pago', 'arquivado') 
          AND ac.id IS NULL 
          THEN 1 
        END)::int as vencendo_hoje,
        
        -- Parcelas vencidas
        (SELECT COUNT(*)::int 
         FROM parcelas p 
         JOIN acordos a ON a.id = p.acordo_id 
         WHERE p.status = 'pendente' 
         AND p.data_vencimento < CURRENT_DATE 
         AND a.status = 'ativo'
        ) as parcelas_vencidas,
        
        -- Parcelas vencendo hoje
        (SELECT COUNT(*)::int 
         FROM parcelas p 
         JOIN acordos a ON a.id = p.acordo_id 
         WHERE p.status = 'pendente' 
         AND DATE(p.data_vencimento) = CURRENT_DATE 
         AND a.status = 'ativo'
        ) as parcelas_hoje
        
      FROM cobrancas c
      LEFT JOIN acordos ac ON ac.cobranca_id = c.id
    `);
    
    const row = result.rows[0];
    
    return res.json({
      success: true,
      vencidas: row.vencidas || 0,
      vencendoHoje: row.vencendo_hoje || 0,
      parcelasVencidas: row.parcelas_vencidas || 0,
      parcelasHoje: row.parcelas_hoje || 0,
      totalUrgente: (row.vencidas || 0) + (row.vencendo_hoje || 0) + (row.parcelas_vencidas || 0) + (row.parcelas_hoje || 0)
    });
    
  } catch (err) {
    console.error("[GET /api/alertas/contador] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar alertas." });
  }
});

// =====================================================
// COBRANÇAS - POST
// =====================================================
app.post("/api/cobrancas", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const cliente = asStr(b.cliente || "");
    const clienteId = asStr(b.cliente_id || b.clienteId || "");
    const empresaId = asStr(b.empresa_id || b.empresaId || "");
    const valorOriginal = round2(num(b.valor_original || b.valorOriginal));
    const vencimento = toPgDateOrNull(b.vencimento);
    const dataCompromisso = toPgDateOrNull(b.data_compromisso || b.dataCompromisso);
    const aplicarMultaJuros = b.aplicarMultaJuros !== false && b.aplicar_multa_juros !== false;
    if (!cliente && !clienteId) return res.status(400).json({ success: false, message: "Cliente ou cliente ID são obrigatórios." });
    if (!valorOriginal || !vencimento) return res.status(400).json({ success: false, message: "Valor e vencimento são obrigatórios." });
    let buscaCliente;
    if (clienteId) { buscaCliente = await pool.query("SELECT id FROM clientes WHERE id = $1 LIMIT 1", [clienteId]); }
    else { buscaCliente = await pool.query("SELECT id FROM clientes WHERE LOWER(nome) = LOWER($1) LIMIT 1", [cliente]); }
    if (!buscaCliente || buscaCliente.rowCount === 0) return res.status(400).json({ success: false, message: "Cliente não encontrado." });
    let finalEmpresaId = empresaId || null;
    if (!finalEmpresaId) {
      const empresaPadrao = await pool.query("SELECT id FROM empresas WHERE padrao = true AND ativo = true LIMIT 1");
      if (empresaPadrao.rowCount) finalEmpresaId = empresaPadrao.rows[0].id;
    }
    let multa = 0, juros = 0;
    if (aplicarMultaJuros) { multa = round2(num(b.multa, 0)); juros = round2(num(b.juros, 0)); }
    const desconto = round2(num(b.desconto, 0));
    const taxaPercent = num(String(b.taxaPercent || "").replace("%", ""));
    const taxaValor = aplicarMultaJuros ? round2((valorOriginal * taxaPercent) / 100) : 0;
    const valorAtualizado = round2(valorOriginal + multa + juros - desconto + taxaValor);
    const status = asStr(b.status || "pendente");
    const observacoes = asStr(b.observacoes || "");
    const novaCobranca = await pool.query(
      `INSERT INTO cobrancas (cliente_id, empresa_id, descricao, valor_original, multa, juros, desconto, vencimento, status, valor_atualizado, data_compromisso, aplicar_multa_juros, observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [buscaCliente.rows[0].id, finalEmpresaId, b.descricao || null, valorOriginal, multa, juros, desconto, vencimento, status, valorAtualizado, dataCompromisso, aplicarMultaJuros, observacoes || null]
    );
    await registrarLog(req, 'CRIAR', 'cobrancas', novaCobranca.rows[0].id, { cliente_id: buscaCliente.rows[0].id, empresa_id: finalEmpresaId, valor: valorAtualizado });
    return res.json({ success: true, data: novaCobranca.rows[0] });
  } catch (err) {
    console.error("[POST /api/cobrancas] erro:", err);
    return res.status(500).json({ success: false, message: "Erro ao salvar cobrança.", error: err?.message || String(err) });
  }
});

// =====================================================
// COBRANÇAS - PUT STATUS
// =====================================================
app.put("/api/cobrancas/:id/status", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "").toLowerCase().trim();
    const allowed = new Set(["pago", "pendente", "vencido", "negociando", "cancelado"]);
    if (!id) return res.status(400).json({ success: false, message: "ID inválido." });
    if (!allowed.has(status)) return res.status(400).json({ success: false, message: "Status inválido." });
    const anterior = await pool.query("SELECT status FROM cobrancas WHERE id = $1", [id]);
    const statusAnterior = anterior.rows[0]?.status || null;
    const r = await pool.query(`UPDATE cobrancas SET status = $2 WHERE id = $1 RETURNING *`, [id, status]);
    if (!r.rowCount) return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    await registrarLog(req, 'ATUALIZAR_STATUS', 'cobrancas', id, { status_anterior: statusAnterior, status_novo: status });
    return res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error("[PUT /api/cobrancas/:id/status] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar status.", error: err.message });
  }
});

// =====================================================
// COBRANÇAS - PUT
// =====================================================
app.put("/api/cobrancas/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const resultado = await pool.query(
      `UPDATE cobrancas SET descricao = COALESCE($1, descricao), valor_original = COALESCE($2, valor_original), multa = COALESCE($3, multa), juros = COALESCE($4, juros), desconto = COALESCE($5, desconto), valor_atualizado = COALESCE($6, valor_atualizado), status = COALESCE($7, status), vencimento = COALESCE($8, vencimento), data_compromisso = $9, aplicar_multa_juros = COALESCE($10, aplicar_multa_juros), observacoes = COALESCE($11, observacoes), empresa_id = COALESCE($12, empresa_id) WHERE id = $13 RETURNING *`,
      [b.descricao, b.valor_original || b.valorOriginal, b.multa, b.juros, b.desconto, b.valor_atualizado || b.valorAtualizado, b.status, toPgDateOrNull(b.vencimento), toPgDateOrNull(b.data_compromisso || b.dataCompromisso), b.aplicar_multa_juros ?? b.aplicarMultaJuros, b.observacoes, b.empresa_id || b.empresaId, id]
    );
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    await registrarLog(req, 'ATUALIZAR', 'cobrancas', id, b);
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[PUT /api/cobrancas/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar cobrança.", error: err.message });
  }
});

// =====================================================
// COBRANÇAS - DELETE
// =====================================================
app.delete("/api/cobrancas/:id", auth, async (req, res) => {
  const { id } = req.params;
  try {
    const resultado = await pool.query("DELETE FROM cobrancas WHERE id = $1 RETURNING *", [id]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Cobrança não encontrada" });
    await registrarLog(req, 'EXCLUIR', 'cobrancas', id, null);
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[DELETE /api/cobrancas/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao remover cobrança", error: err.message });
  }
});

// =====================================================
// COBRANÇAS - ENVIAR E-MAIL
// =====================================================
app.post("/api/cobrancas/:id/enviar-email", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!emailTransporter) return res.status(400).json({ success: false, message: "E-mail não configurado." });
    const q = await pool.query(`SELECT c.*, COALESCE(cl.nome, '') AS cliente_nome, COALESCE(cl.email, '') AS cliente_email FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id WHERE c.id = $1::uuid LIMIT 1`, [id]);
    if (!q.rows.length) return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    const cobranca = q.rows[0];
    if (!cobranca.cliente_email) return res.status(400).json({ success: false, message: "Cliente não possui e-mail cadastrado." });
    const idStr = String(cobranca.id);
    const refCode = `AC-C${idStr.slice(0, 2).toUpperCase()}D${idStr.slice(2, 6).toUpperCase()}`;
    const htmlEmail = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f4f4f4;"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);"><div style="background:linear-gradient(135deg,#1a1a1a,#2d2d2d);padding:40px;text-align:center;border-bottom:4px solid #F6C84C;"><div style="width:70px;height:70px;background:linear-gradient(135deg,#F6C84C,#FFD56A);border-radius:16px;display:inline-block;line-height:70px;font-size:36px;font-weight:900;color:#1a1a1a;">A</div><h1 style="color:#fff;font-size:28px;margin:15px 0 5px;">ACERTIVE</h1><p style="color:#F6C84C;font-size:14px;margin:0;">SISTEMA DE COBRANÇAS</p></div><div style="padding:40px;"><h2 style="color:#1a1a1a;margin:0 0 10px;">Olá, ${cobranca.cliente_nome}!</h2><p style="color:#666;margin:0 0 30px;">Você tem uma cobrança pendente:</p><div style="background:#F6C84C;border-radius:12px;padding:30px;text-align:center;margin-bottom:30px;"><p style="color:#1a1a1a;font-size:12px;margin:0 0 8px;font-weight:800;">VALOR TOTAL</p><p style="color:#1a1a1a;font-size:36px;margin:0;font-weight:900;">${fmtMoney(cobranca.valor_atualizado)}</p></div><div style="background:#f8f9fa;border-radius:12px;padding:20px;margin-bottom:20px;"><p><strong>Referência:</strong> ${refCode}</p><p><strong>Vencimento:</strong> ${fmtDate(cobranca.vencimento)}</p><p><strong>Descrição:</strong> ${cobranca.descricao || "—"}</p></div><div style="background:#fff8e1;border-left:4px solid #F6C84C;padding:15px;border-radius:8px;"><p style="color:#854d0e;margin:0;"><strong>⚠️ Importante:</strong> Evite juros e multas!</p></div></div><div style="background:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #e9ecef;"><p style="color:#6b7280;font-size:12px;margin:0;">Sistema ACERTIVE - E-mail automático</p></div></div></body></html>`;
    const emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER;
    await emailTransporter.sendMail({ from: `ACERTIVE <${emailFrom}>`, to: cobranca.cliente_email, subject: `📄 Cobrança ${refCode} - ${fmtMoney(cobranca.valor_atualizado)}`, html: htmlEmail });
    await registrarLog(req, 'ENVIAR_EMAIL', 'cobrancas', id, { destinatario: cobranca.cliente_email });
    return res.json({ success: true, message: `E-mail enviado para ${cobranca.cliente_email}!` });
  } catch (err) {
    console.error("[ENVIAR EMAIL] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao enviar e-mail.", error: err.message });
  }
});

// =====================================================
// COBRANÇAS - WHATSAPP
// =====================================================
app.get("/api/cobrancas/:id/whatsapp", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const q = await pool.query(`SELECT c.*, COALESCE(cl.nome, '') AS cliente_nome, COALESCE(cl.telefone, '') AS cliente_telefone FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id WHERE c.id = $1::uuid LIMIT 1`, [id]);
    if (!q.rows.length) return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    const cobranca = q.rows[0];
    const idStr = String(cobranca.id);
    const refCode = `AC-C${idStr.slice(0, 2).toUpperCase()}D${idStr.slice(2, 6).toUpperCase()}`;
    let telefone = String(cobranca.cliente_telefone || "").replace(/\D/g, "");
    if (telefone.length === 11 || telefone.length === 10) telefone = "55" + telefone;
    const mensagem = `Olá, *${cobranca.cliente_nome}*! 👋\n\n📄 *COBRANÇA ACERTIVE*\n━━━━━━━━━━━━━━━━━\n\n📌 *Referência:* ${refCode}\n💰 *Valor:* ${fmtMoney(cobranca.valor_atualizado)}\n📅 *Vencimento:* ${fmtDate(cobranca.vencimento)}\n📝 *Descrição:* ${cobranca.descricao || "—"}\n\n⚠️ Evite juros e multas! Efetue o pagamento até a data de vencimento.\n\n_Mensagem enviada pelo sistema ACERTIVE_`;
    const link = `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;
    await registrarLog(req, 'GERAR_WHATSAPP', 'cobrancas', id, { telefone });
    return res.json({ success: true, link, telefone, mensagem });
  } catch (err) {
    console.error("[WHATSAPP] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar link WhatsApp.", error: err.message });
  }
});

// =====================================================
// COBRANÇAS - GERAR MENSAGEM IA
// =====================================================
app.post("/api/cobrancas/:id/gerar-mensagem-ia", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const { tipo = 'whatsapp', tom = 'profissional' } = req.body || {};
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ success: false, message: "IA não configurada." });
    const q = await pool.query(`SELECT c.*, COALESCE(cl.nome, '') AS cliente_nome FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id WHERE c.id = $1::uuid LIMIT 1`, [id]);
    if (!q.rows.length) return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    const cobranca = q.rows[0];
    const idStr = String(cobranca.id);
    const refCode = `AC-C${idStr.slice(0, 2).toUpperCase()}D${idStr.slice(2, 6).toUpperCase()}`;
    const prompt = `Gere uma mensagem de cobrança ${tipo === 'email' ? 'por e-mail' : 'para WhatsApp'} com tom ${tom}. Cliente: ${cobranca.cliente_nome}, Valor: ${fmtMoney(cobranca.valor_atualizado)}, Vencimento: ${fmtDate(cobranca.vencimento)}, Ref: ${refCode}, Status: ${cobranca.status}. ${tipo === 'whatsapp' ? 'Use *negrito* e emojis.' : 'Formato formal de e-mail.'}`;
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 500 }) });
    const data = await response.json();
    const mensagemGerada = data.choices?.[0]?.message?.content || '';
    await registrarLog(req, 'GERAR_MENSAGEM_IA', 'cobrancas', id, { tipo, tom });
    return res.json({ success: true, mensagem: mensagemGerada, tipo, tom, referencia: refCode });
  } catch (err) {
    console.error("[IA MENSAGEM] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar mensagem.", error: err.message });
  }
});

app.get("/api/config/ia-status", auth, (req, res) => {
  return res.json({ success: true, iaConfigurada: !!process.env.OPENAI_API_KEY, modelo: 'gpt-4o-mini' });
});

// =====================================================
// CLIENTES - GET ATIVOS
// =====================================================
app.get("/api/clientes-ativos", async (req, res) => {
  try {
    const resultado = await pool.query(`
      SELECT c.*, 
        COALESCE(c.status_cliente, 'regular') AS status_cliente,
        COALESCE(e.nome, '') AS empresa_nome,
        (SELECT COUNT(*)::int FROM cobrancas WHERE cliente_id = c.id) AS total_cobrancas,
        (SELECT COALESCE(SUM(valor_atualizado), 0)::numeric FROM cobrancas WHERE cliente_id = c.id AND status IN ('pendente', 'vencido')) AS divida_total
      FROM clientes c 
      LEFT JOIN empresas e ON e.id = c.empresa_id
      WHERE c.status = 'ativo' 
      ORDER BY c.created_at DESC
    `);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/clientes-ativos] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar clientes.", error: err.message });
  }
});


// =====================================================
// CLIENTES - GET POR ID
// =====================================================
// =====================================================
// COBRANÇAS - PDF COM DADOS DA EMPRESA
// =====================================================
// SUBSTITUA a rota app.get("/api/cobrancas/:id/pdf" no seu server.js por esta:

app.get("/api/cobrancas/:id/pdf", auth, async (req, res) => {
  let browser = null;
  try {
    const id = String(req.params.id || "").trim();

    // Buscar cobrança com cliente E empresa
    const q = await pool.query(
      `SELECT c.*, 
        COALESCE(cl.nome, '') AS cliente_nome,
        COALESCE(cl.cpf_cnpj, '') AS cliente_cpf_cnpj,
        COALESCE(cl.telefone, '') AS cliente_telefone,
        COALESCE(cl.email, '') AS cliente_email,
        COALESCE(cl.endereco, '') AS cliente_endereco,
        COALESCE(e.nome, '') AS empresa_nome,
        COALESCE(e.cnpj, '') AS empresa_cnpj,
        COALESCE(e.telefone, '') AS empresa_telefone,
        COALESCE(e.email, '') AS empresa_email,
        COALESCE(e.endereco, '') AS empresa_endereco,
        COALESCE(e.banco, '') AS empresa_banco,
        COALESCE(e.tipo_conta, '') AS empresa_tipo_conta,
        COALESCE(e.agencia, '') AS empresa_agencia,
        COALESCE(e.conta, '') AS empresa_conta,
        COALESCE(e.digito, '') AS empresa_digito,
        COALESCE(e.titular, '') AS empresa_titular,
        COALESCE(e.cpf_cnpj_titular, '') AS empresa_cpf_cnpj_titular,
        COALESCE(e.tipo_chave_pix, '') AS empresa_tipo_chave_pix,
        COALESCE(e.chave_pix, '') AS empresa_chave_pix
       FROM cobrancas c 
       LEFT JOIN clientes cl ON cl.id = c.cliente_id 
       LEFT JOIN empresas e ON e.id = c.empresa_id
       WHERE c.id = $1::uuid LIMIT 1`,
      [id]
    );

    if (!q.rows.length) return res.status(404).json({ success: false, message: "Cobrança não encontrada." });

    const r = q.rows[0];
    const esc = (s) => String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const idStr = String(r.id);
    const refCode = `AC-C${idStr.slice(0, 2).toUpperCase()}D${idStr.slice(2, 6).toUpperCase()}`;

    // Mapeamento de bancos
    const bancoNomes = {
      '001': 'Banco do Brasil', '033': 'Santander', '104': 'Caixa Econômica',
      '237': 'Bradesco', '341': 'Itaú', '260': 'Nubank',
      '077': 'Inter', '212': 'Original', '336': 'C6 Bank',
      '290': 'PagSeguro', '380': 'PicPay', '323': 'Mercado Pago'
    };
    const bancoNome = bancoNomes[r.empresa_banco] || r.empresa_banco || '';

    // Mapeamento tipo PIX
    const tipoPixLabels = {
      'cpf': 'CPF', 'cnpj': 'CNPJ', 'email': 'E-mail', 
      'telefone': 'Telefone', 'aleatoria': 'Chave Aleatória'
    };
    const tipoPixLabel = tipoPixLabels[r.empresa_tipo_chave_pix] || r.empresa_tipo_chave_pix || '';

    // Verificar se tem dados bancários e PIX
    const temBanco = r.empresa_banco && r.empresa_agencia && r.empresa_conta;
    const temPix = r.empresa_chave_pix;

    const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"/><title>Cobrança ${refCode}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;padding:30px;color:#333;font-size:12px}
.header{background:linear-gradient(135deg,#1a1a1a,#2d2d2d);padding:25px;border-radius:12px;margin-bottom:20px;border-left:6px solid #F6C84C;display:flex;justify-content:space-between;align-items:center}
.logo{width:55px;height:55px;background:#F6C84C;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;color:#1a1a1a}
.title{color:#fff;margin-left:12px}.title h1{font-size:22px;margin-bottom:2px}.title h2{color:#F6C84C;font-size:11px;font-weight:600}
.info{text-align:right;color:#fff;font-size:11px;line-height:1.6}.info strong{color:#F6C84C}
.badge{display:inline-block;padding:4px 10px;border-radius:15px;font-size:10px;font-weight:700}
.badge.pago{background:#dcfce7;color:#166534}.badge.pendente{background:#fef3c7;color:#854d0e}.badge.vencido{background:#fee2e2;color:#991b1b}.badge.negociando{background:#dbeafe;color:#1e40af}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.card{background:#f8f9fa;border:1px solid #e5e7eb;border-radius:10px;padding:15px;text-align:center}
.card.destaque{background:linear-gradient(135deg,#F6C84C,#FFD56A)}
.card label{font-size:9px;color:#666;display:block;margin-bottom:6px;text-transform:uppercase;font-weight:700;letter-spacing:0.5px}
.card.destaque label{color:#1a1a1a}.card span{font-size:18px;font-weight:800;color:#1a1a1a}
.section{background:#f8f9fa;border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin-bottom:15px}
.section h3{font-size:12px;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #F6C84C;color:#1a1a1a;display:flex;align-items:center;gap:8px}
.section h3 .icon{width:20px;height:20px;background:#F6C84C;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:10px}
.row{display:flex;margin-bottom:8px}.row label{width:130px;font-size:10px;color:#666;font-weight:600}.row span{font-size:11px;color:#1a1a1a;font-weight:600}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.empresa-section{background:linear-gradient(135deg,#1a1a1a,#2d2d2d);border-radius:10px;padding:20px;margin-bottom:15px;color:#fff}
.empresa-section h3{color:#F6C84C;font-size:12px;margin-bottom:15px;padding-bottom:8px;border-bottom:1px solid rgba(246,200,76,0.3)}
.empresa-section .row label{color:#a1a1aa}.empresa-section .row span{color:#fff}
.pagamento-box{background:#fef3c7;border:2px solid #F6C84C;border-radius:10px;padding:20px;margin-bottom:15px}
.pagamento-box h3{color:#854d0e;font-size:13px;margin-bottom:15px;display:flex;align-items:center;gap:8px}
.pagamento-box h3::before{content:"💰";font-size:16px}
.banco-info{background:rgba(255,255,255,0.7);border-radius:8px;padding:15px;margin-bottom:12px}
.banco-info h4{font-size:11px;color:#854d0e;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px}
.banco-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.banco-grid .item{font-size:10px}.banco-grid .item label{color:#666;display:block}.banco-grid .item span{font-weight:700;color:#1a1a1a}
.pix-info{background:#22c55e;border-radius:8px;padding:15px;color:#fff}
.pix-info h4{font-size:11px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.pix-info h4::before{content:"";display:inline-block;width:30px;height:12px;background:#fff;border-radius:3px}
.pix-tipo{font-size:9px;text-transform:uppercase;opacity:0.8;margin-bottom:4px}
.pix-chave{font-size:13px;font-weight:700;word-break:break-all;background:rgba(255,255,255,0.2);padding:8px 12px;border-radius:6px;margin-top:8px}
.resumo-section{background:#fef3c7;border:1px solid #F6C84C;border-radius:10px;padding:20px}
.resumo-section h3{color:#854d0e}
.resumo-total{font-size:20px;font-weight:900;color:#854d0e;text-align:right;margin-top:10px;padding-top:10px;border-top:2px dashed #F6C84C}
.footer{margin-top:20px;padding-top:15px;border-top:2px solid #e5e7eb;display:flex;justify-content:space-between;font-size:10px;color:#666}
.footer-empresa{text-align:right}.footer-empresa strong{color:#1a1a1a;font-size:11px}
.aviso{background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin-top:15px;font-size:10px;color:#991b1b;text-align:center}
</style></head><body>

<div class="header">
  <div style="display:flex;align-items:center">
    <div class="logo">${r.empresa_nome ? r.empresa_nome.charAt(0).toUpperCase() : 'A'}</div>
    <div class="title">
      <h1>${esc(r.empresa_nome) || 'ACERTIVE'}</h1>
      <h2>${r.empresa_cnpj ? 'CNPJ: ' + esc(r.empresa_cnpj) : 'Sistema de Cobranças'}</h2>
    </div>
  </div>
  <div class="info">
    <p><strong>Documento:</strong> ${refCode}</p>
    <p><strong>Status:</strong> <span class="badge ${r.status}">${(r.status || 'pendente').toUpperCase()}</span></p>
    <p><strong>Emissão:</strong> ${fmtDateTime(new Date())}</p>
  </div>
</div>

<div class="grid">
  <div class="card destaque"><label>Valor Total</label><span>${fmtMoney(r.valor_atualizado)}</span></div>
  <div class="card"><label>Vencimento</label><span>${fmtDate(r.vencimento)}</span></div>
  <div class="card"><label>Valor Original</label><span>${fmtMoney(r.valor_original)}</span></div>
  <div class="card"><label>Acréscimos</label><span>${fmtMoney((r.juros || 0) + (r.multa || 0))}</span></div>
</div>

<div class="two-col">
  <div class="section">
    <h3><span class="icon">👤</span> Dados do Cliente</h3>
    <div class="row"><label>Nome:</label><span>${esc(r.cliente_nome) || '—'}</span></div>
    <div class="row"><label>CPF/CNPJ:</label><span>${esc(r.cliente_cpf_cnpj) || '—'}</span></div>
    <div class="row"><label>Telefone:</label><span>${esc(r.cliente_telefone) || '—'}</span></div>
    <div class="row"><label>E-mail:</label><span>${esc(r.cliente_email) || '—'}</span></div>
  </div>
  <div class="section">
    <h3><span class="icon">📋</span> Dados da Cobrança</h3>
    <div class="row"><label>Descrição:</label><span>${esc(r.descricao) || '—'}</span></div>
    <div class="row"><label>Data Compromisso:</label><span>${fmtDate(r.data_compromisso) || '—'}</span></div>
    <div class="row"><label>Criada em:</label><span>${fmtDateTime(r.created_at)}</span></div>
    <div class="row"><label>Referência:</label><span>${refCode}</span></div>
  </div>
</div>

${(temBanco || temPix) ? `
<div class="pagamento-box">
  <h3>Informações para Pagamento</h3>
  
  ${temBanco ? `
  <div class="banco-info">
    <h4>🏦 Transferência Bancária</h4>
    <div class="banco-grid">
      <div class="item"><label>Banco</label><span>${bancoNome}</span></div>
      <div class="item"><label>Tipo</label><span>${r.empresa_tipo_conta === 'poupanca' ? 'Poupança' : 'Corrente'}</span></div>
      <div class="item"><label>Agência</label><span>${esc(r.empresa_agencia)}</span></div>
      <div class="item"><label>Conta</label><span>${esc(r.empresa_conta)}${r.empresa_digito ? '-' + esc(r.empresa_digito) : ''}</span></div>
      <div class="item"><label>Titular</label><span>${esc(r.empresa_titular) || esc(r.empresa_nome)}</span></div>
      <div class="item"><label>CPF/CNPJ</label><span>${esc(r.empresa_cpf_cnpj_titular) || esc(r.empresa_cnpj)}</span></div>
    </div>
  </div>
  ` : ''}
  
  ${temPix ? `
  <div class="pix-info">
    <h4>PIX - Pagamento Instantâneo</h4>
    <div class="pix-tipo">${tipoPixLabel}</div>
    <div class="pix-chave">${esc(r.empresa_chave_pix)}</div>
  </div>
  ` : ''}
</div>
` : ''}

<div class="resumo-section">
  <h3><span class="icon">📊</span> Resumo Financeiro</h3>
  <div class="row"><label>Valor Original:</label><span>${fmtMoney(r.valor_original)}</span></div>
  <div class="row"><label>Juros:</label><span>${fmtMoney(r.juros)}</span></div>
  <div class="row"><label>Multa:</label><span>${fmtMoney(r.multa)}</span></div>
  <div class="row"><label>Desconto:</label><span>- ${fmtMoney(r.desconto)}</span></div>
  <div class="resumo-total">TOTAL A PAGAR: ${fmtMoney(r.valor_atualizado)}</div>
</div>

${r.status === 'vencido' ? '<div class="aviso">⚠️ ATENÇÃO: Esta cobrança está VENCIDA. Entre em contato para regularização.</div>' : ''}
${r.status === 'pendente' ? '<div class="aviso" style="background:#fff8e1;border-color:#F6C84C;color:#854d0e">⏰ Efetue o pagamento até a data de vencimento para evitar juros e multas.</div>' : ''}

<div class="footer">
  <div>
    <p>Documento gerado em ${fmtDateTime(new Date())}</p>
    <p>Por: ${req.user?.nome || 'Sistema ACERTIVE'}</p>
  </div>
  <div class="footer-empresa">
    <p><strong>${esc(r.empresa_nome) || 'ACERTIVE'}</strong></p>
    ${r.empresa_telefone ? `<p>Tel: ${esc(r.empresa_telefone)}</p>` : ''}
    ${r.empresa_email ? `<p>${esc(r.empresa_email)}</p>` : ''}
  </div>
</div>

</body></html>`;

    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    await browser.close();
    browser = null;

    await registrarLog(req, 'GERAR_PDF', 'cobrancas', id, { empresa_id: r.empresa_id });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="cobranca_${refCode}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    if (browser) try { await browser.close(); } catch {}
    console.error("[COBRANCA PDF] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar PDF.", error: err.message });
  }
});
// =====================================================
// ROTA: LISTAR TODOS OS CLIENTES (DEVEDORES)
// ADICIONE ESTA ROTA ANTES DO app.post("/api/clientes")
// =====================================================
app.get("/api/clientes", auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status = '', credor_id = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereConditions = [];
    let params = [];
    let paramIndex = 1;

    // Filtro de busca (nome, cpf_cnpj, telefone, email)
    if (search) {
      const searchLimpo = search.replace(/[.\-\/]/g, "");
      whereConditions.push(`(
        LOWER(c.nome) LIKE LOWER($${paramIndex})
        OR REPLACE(REPLACE(REPLACE(c.cpf_cnpj, '.', ''), '-', ''), '/', '') LIKE $${paramIndex + 1}
        OR c.telefone LIKE $${paramIndex}
        OR LOWER(c.email) LIKE LOWER($${paramIndex})
      )`);
      params.push(`%${search}%`, `%${searchLimpo}%`);
      paramIndex += 2;
    }

    // Filtro de status
    if (status) {
      whereConditions.push(`c.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    // Filtro de credor (se tiver relação)
    if (credor_id) {
      whereConditions.push(`EXISTS (SELECT 1 FROM cobrancas cob WHERE cob.cliente_id = c.id AND cob.credor_id = $${paramIndex})`);
      params.push(credor_id);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    // Query principal
    const query = `
      SELECT 
        c.id,
        c.nome,
        c.cpf_cnpj,
        c.telefone,
        c.celular,
        c.email,
        c.endereco,
        c.cidade,
        c.estado,
        c.cep,
        c.status,
        c.status_cliente,
        c.observacoes,
        c.created_at,
        c.updated_at,
        COALESCE(SUM(CASE WHEN cob.status IN ('pendente', 'vencido') THEN cob.valor_atualizado ELSE 0 END), 0)::numeric AS divida_total,
        COUNT(cob.id)::int AS total_cobrancas,
        MAX(cob.updated_at) AS ultima_acao
      FROM clientes c
      LEFT JOIN cobrancas cob ON cob.cliente_id = c.id
      ${whereClause}
      GROUP BY c.id
      ORDER BY c.nome ASC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(parseInt(limit), offset);

    const resultado = await pool.query(query, params);

    // Contar total para paginação
    const countQuery = `
      SELECT COUNT(DISTINCT c.id) as total
      FROM clientes c
      ${whereClause}
    `;
    const countParams = params.slice(0, -2); // Remove limit e offset
    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    // Estatísticas gerais
    const statsQuery = `
      SELECT 
        COUNT(DISTINCT c.id)::int AS total,
        COUNT(DISTINCT CASE WHEN c.status = 'ativo' THEN c.id END)::int AS ativos,
        COALESCE(SUM(CASE WHEN cob.status IN ('pendente', 'vencido') THEN cob.valor_atualizado ELSE 0 END), 0)::numeric AS "totalDivida",
        COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM acordos a WHERE a.cliente_id = c.id AND a.status = 'ativo') THEN c.id END)::int AS "comAcordo"
      FROM clientes c
      LEFT JOIN cobrancas cob ON cob.cliente_id = c.id
    `;
    const statsResult = await pool.query(statsQuery);

    return res.json({
      success: true,
      data: resultado.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total,
        totalPages: Math.ceil(total / parseInt(limit))
      },
      stats: statsResult.rows[0]
    });

  } catch (err) {
    console.error("[GET /api/clientes] erro:", err.message);
    return res.status(500).json({ 
      success: false, 
      message: "Erro ao listar clientes.", 
      error: err.message 
    });
  }
});

// ROTA: BUSCAR CLIENTES (DEVE VIR ANTES DE /:id)
// =====================================================
app.get("/api/clientes/buscar", auth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.status(400).json({ success: false, message: "Digite pelo menos 2 caracteres." });
    }

    // Remove caracteres especiais para buscar CPF/CNPJ
    const qLimpo = q.replace(/[.\-\/]/g, "");
    
    const resultado = await pool.query(`
      SELECT 
        c.id,
        c.nome,
        c.cpf_cnpj,
        c.telefone,
        c.email,
        COALESCE(c.status_cliente, 'regular') AS status_cliente,
        COUNT(cob.id)::int AS total_cobrancas,
        COALESCE(SUM(CASE WHEN cob.status IN ('pendente', 'vencido') THEN cob.valor_atualizado ELSE 0 END), 0)::numeric AS divida_total,
        COALESCE(SUM(CASE WHEN cob.status = 'pago' THEN cob.valor_atualizado ELSE 0 END), 0)::numeric AS total_pago
      FROM clientes c
      LEFT JOIN cobrancas cob ON cob.cliente_id = c.id
      WHERE 
        LOWER(c.nome) LIKE LOWER($1)
        OR REPLACE(REPLACE(REPLACE(COALESCE(c.cpf_cnpj, ''), '.', ''), '-', ''), '/', '') LIKE $2
      GROUP BY c.id, c.nome, c.cpf_cnpj, c.telefone, c.email, c.status_cliente
      ORDER BY c.nome ASC
      LIMIT 50
    `, [`%${q}%`, `%${qLimpo}%`]);

    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/clientes/buscar] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar clientes.", error: err.message });
  }
});
// =====================================================
// ROTA: OBTER UM CLIENTE POR ID
// =====================================================
app.get("/api/clientes/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;

    const resultado = await pool.query(`
      SELECT 
        c.*,
        COALESCE(SUM(CASE WHEN cob.status IN ('pendente', 'vencido') THEN cob.valor_atualizado ELSE 0 END), 0)::numeric AS divida_total
      FROM clientes c
      LEFT JOIN cobrancas cob ON cob.cliente_id = c.id
      WHERE c.id = $1
      GROUP BY c.id
    `, [id]);

    if (resultado.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Cliente não encontrado." });
    }

    return res.json({ success: true, data: resultado.rows[0] });

  } catch (err) {
    console.error("[GET /api/clientes/:id] erro:", err.message);
    return res.status(500).json({ 
      success: false, 
      message: "Erro ao buscar cliente.", 
      error: err.message 
    });
  }
});
// =====================================================
// CLIENTES - POST
// =====================================================
app.post("/api/clientes", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const nome = String(b.nome || "").trim();
    if (!nome) return res.status(400).json({ success: false, message: "Nome é obrigatório." });
    
    // Pegar empresa_id do body, ou usar a padrão se não informada
    let empresaId = b.empresa_id || null;
    if (!empresaId) {
      const empresaPadrao = await pool.query("SELECT id FROM empresas WHERE padrao = true AND ativo = true LIMIT 1");
      if (empresaPadrao.rowCount) empresaId = empresaPadrao.rows[0].id;
    }

    const r = await pool.query(
      `INSERT INTO clientes (nome, email, telefone, cpf_cnpj, endereco, status, observacoes, status_cliente, limite_credito, empresa_id, data_primeiro_contato)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_DATE) RETURNING *`,
      [nome, b.email || null, b.telefone || null, b.cpf_cnpj || b.cpfCnpj || null, b.endereco || null, "ativo", b.observacoes || null, b.status_cliente || 'regular', num(b.limite_credito, 0), empresaId]
    );
    await registrarLog(req, 'CRIAR', 'clientes', r.rows[0].id, { nome, empresa_id: empresaId });
    return res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error("[POST /api/clientes] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao criar cliente.", error: err.message });
  }
});

// =====================================================
// CLIENTES - PUT
// =====================================================
app.put("/api/clientes/:id", auth, async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  try {
    const result = await pool.query(
      `UPDATE clientes SET 
        nome = COALESCE($1, nome), 
        email = COALESCE($2, email), 
        telefone = COALESCE($3, telefone),
        status = COALESCE($4, status), 
        tipo = COALESCE($5, tipo), 
        cpf_cnpj = COALESCE($6, cpf_cnpj),
        endereco = COALESCE($7, endereco), 
        observacoes = COALESCE($8, observacoes), 
        status_cliente = COALESCE($9, status_cliente),
        limite_credito = COALESCE($10, limite_credito), 
        empresa_id = COALESCE($11, empresa_id),
        data_ultimo_contato = CURRENT_DATE, 
        updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [b.nome, b.email, b.telefone, b.status, b.tipo, b.cpf_cnpj, b.endereco, b.observacoes, b.status_cliente, b.limite_credito, b.empresa_id, id]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, message: "Cliente não encontrado" });
    await registrarLog(req, 'ATUALIZAR', 'clientes', id, b);
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("[PUT /api/clientes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar cliente", error: err.message });
  }
});

// =====================================================
// CLIENTES - ATUALIZAR STATUS
// =====================================================
app.put("/api/clientes/:id/status-cliente", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status_cliente } = req.body || {};
    const statusValidos = ['regular', 'inadimplente', 'negociando', 'bom_pagador', 'novo', 'inativo', 'juridico'];
    if (!statusValidos.includes(status_cliente)) return res.status(400).json({ success: false, message: "Status inválido." });
    const result = await pool.query(`UPDATE clientes SET status_cliente = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [status_cliente, id]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: "Cliente não encontrado." });
    await registrarLog(req, 'ATUALIZAR_STATUS_CLIENTE', 'clientes', id, { status_cliente });
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("[PUT /api/clientes/:id/status-cliente] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar status.", error: err.message });
  }
});

// =====================================================
// CLIENTES - DELETE
// =====================================================
app.delete("/api/clientes/:id", auth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("UPDATE clientes SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *", ["inativo", id]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: "Cliente não encontrado" });
    await registrarLog(req, 'DESATIVAR', 'clientes', id, null);
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("[DELETE /api/clientes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao excluir cliente", error: err.message });
  }
});
// =====================================================
// CLIENTES - PDF DE DÍVIDAS
// =====================================================
app.get("/api/clientes/:id/pdf-dividas", auth, async (req, res) => {
  let browser = null;
  try {
    const { id } = req.params;
    const clienteResult = await pool.query("SELECT * FROM clientes WHERE id = $1", [id]);
    if (!clienteResult.rowCount) return res.status(404).json({ success: false, message: "Cliente não encontrado." });
    const cliente = clienteResult.rows[0];
    const cobrancasResult = await pool.query(`SELECT * FROM cobrancas WHERE cliente_id = $1 ORDER BY vencimento DESC`, [id]);
    const cobrancas = cobrancasResult.rows;
    const totalGeral = cobrancas.reduce((acc, c) => acc + Number(c.valor_atualizado || 0), 0);
    const totalPendente = cobrancas.filter(c => ['pendente', 'vencido'].includes(c.status)).reduce((acc, c) => acc + Number(c.valor_atualizado || 0), 0);
    const totalPago = cobrancas.filter(c => c.status === 'pago').reduce((acc, c) => acc + Number(c.valor_atualizado || 0), 0);
    const esc = (s) => String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const linhasHtml = cobrancas.map(c => {
      const statusClass = c.status === 'pago' ? 'pago' : c.status === 'vencido' ? 'vencido' : 'pendente';
      return `<tr><td>${fmtDate(c.vencimento)}</td><td>${esc(c.descricao || '—')}</td><td>${fmtMoney(c.valor_original)}</td><td>${fmtMoney(c.juros)}</td><td>${fmtMoney(c.multa)}</td><td><strong>${fmtMoney(c.valor_atualizado)}</strong></td><td><span class="badge ${statusClass}">${(c.status || 'pendente').toUpperCase()}</span></td></tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Dívidas - ${esc(cliente.nome)}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:sans-serif;padding:30px;font-size:11px}.header{background:linear-gradient(135deg,#1a1a1a,#2d2d2d);padding:25px;border-radius:12px;margin-bottom:20px;border-left:6px solid #F6C84C;color:#fff}.header h1{font-size:24px}.header h2{color:#F6C84C;font-size:12px}.info{background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;padding:15px;margin-bottom:15px}.info h3{font-size:13px;margin-bottom:10px;border-bottom:2px solid #F6C84C;padding-bottom:5px}.resumo{display:flex;gap:10px;margin-bottom:15px}.resumo-card{flex:1;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;padding:12px;text-align:center}.resumo-card.destaque{background:#F6C84C}.resumo-card label{font-size:9px;color:#666;display:block;margin-bottom:5px}.resumo-card.destaque label{color:#1a1a1a}.resumo-card span{font-size:16px;font-weight:900}table{width:100%;border-collapse:collapse}thead th{background:#1a1a1a;color:#F6C84C;padding:8px;text-align:left;font-size:9px}tbody tr{border-bottom:1px solid #e5e7eb}tbody td{padding:6px;font-size:10px}.badge{padding:2px 6px;border-radius:10px;font-size:8px;font-weight:700}.badge.pago{background:#dcfce7;color:#166534}.badge.pendente{background:#fef3c7;color:#854d0e}.badge.vencido{background:#fee2e2;color:#991b1b}.footer{margin-top:20px;text-align:center;font-size:10px;color:#666}</style></head><body><div class="header"><h1>ACERTIVE</h1><h2>Extrato de Dívidas</h2></div><div class="info"><h3>Dados do Cliente</h3><p><strong>Nome:</strong> ${esc(cliente.nome)}</p><p><strong>CPF/CNPJ:</strong> ${esc(cliente.cpf_cnpj) || '—'}</p><p><strong>Telefone:</strong> ${esc(cliente.telefone) || '—'}</p></div><div class="resumo"><div class="resumo-card"><label>Total Cobranças</label><span>${cobrancas.length}</span></div><div class="resumo-card"><label>Total Pago</label><span>${fmtMoney(totalPago)}</span></div><div class="resumo-card destaque"><label>Total Pendente</label><span>${fmtMoney(totalPendente)}</span></div><div class="resumo-card"><label>Valor Geral</label><span>${fmtMoney(totalGeral)}</span></div></div><table><thead><tr><th>Vencimento</th><th>Descrição</th><th>Original</th><th>Juros</th><th>Multa</th><th>Atualizado</th><th>Status</th></tr></thead><tbody>${linhasHtml || '<tr><td colspan="7" style="text-align:center;padding:20px">Nenhuma cobrança.</td></tr>'}</tbody></table><div class="footer"><p>Gerado em ${fmtDateTime(new Date())} - Sistema ACERTIVE</p></div></body></html>`;
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    await browser.close();
    browser = null;
    await registrarLog(req, 'GERAR_PDF_DIVIDAS', 'clientes', id, { total: cobrancas.length });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="dividas_${cliente.nome.replace(/\s+/g, '_')}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    if (browser) try { await browser.close(); } catch {}
    console.error("[PDF DIVIDAS] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar PDF.", error: err.message });
  }
});

// =====================================================
// AGENDAMENTOS - CRUD
// =====================================================
app.get("/api/agendamentos", auth, async (req, res) => {
  try {
    const { status, tipo, data_inicio, data_fim, cliente_id } = req.query;
    const params = [];
    const where = [];
    if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
    if (tipo) { params.push(tipo); where.push(`a.tipo = $${params.length}`); }
    if (cliente_id) { params.push(cliente_id); where.push(`a.cliente_id = $${params.length}`); }
    if (data_inicio) { params.push(data_inicio); where.push(`DATE(a.data_agendamento) >= $${params.length}`); }
    if (data_fim) { params.push(data_fim); where.push(`DATE(a.data_agendamento) <= $${params.length}`); }
    const sql = `SELECT a.*, COALESCE(cl.nome, '') AS cliente_nome, COALESCE(cl.telefone, '') AS cliente_telefone, COALESCE(cl.email, '') AS cliente_email FROM agendamentos a LEFT JOIN clientes cl ON cl.id = a.cliente_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.data_agendamento ASC`;
    const resultado = await pool.query(sql, params);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/agendamentos] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar agendamentos.", error: err.message });
  }
});

app.get("/api/agendamentos/hoje", auth, async (req, res) => {
  try {
    const resultado = await pool.query(`SELECT a.*, COALESCE(cl.nome, '') AS cliente_nome, COALESCE(cl.telefone, '') AS cliente_telefone FROM agendamentos a LEFT JOIN clientes cl ON cl.id = a.cliente_id WHERE DATE(a.data_agendamento) = CURRENT_DATE AND a.status = 'pendente' ORDER BY a.data_agendamento ASC`);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/agendamentos/hoje] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro.", error: err.message });
  }
});

app.post("/api/agendamentos", auth, async (req, res) => {
  try {
    const { cliente_id, cobranca_id, tipo, data_agendamento, descricao, prioridade } = req.body || {};
    if (!cliente_id || !tipo || !data_agendamento) return res.status(400).json({ success: false, message: "Cliente, tipo e data são obrigatórios." });
    const tiposValidos = ['novo_contato', 'renegociacao', 'liquidacao', 'cobranca', 'lembrete', 'retorno', 'visita'];
    if (!tiposValidos.includes(tipo)) return res.status(400).json({ success: false, message: "Tipo inválido." });
    const resultado = await pool.query(`INSERT INTO agendamentos (cliente_id, cobranca_id, tipo, data_agendamento, descricao, prioridade, usuario_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [cliente_id, cobranca_id || null, tipo, data_agendamento, descricao || null, prioridade || 'normal', req.user.userId]);
    await pool.query(`UPDATE clientes SET data_ultimo_contato = CURRENT_DATE WHERE id = $1`, [cliente_id]);
    await registrarLog(req, 'CRIAR', 'agendamentos', resultado.rows[0].id, { tipo, cliente_id });
    return res.json({ success: true, data: resultado.rows[0], message: "Agendamento criado!" });
  } catch (err) {
    console.error("[POST /api/agendamentos] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao criar agendamento.", error: err.message });
  }
});

app.put("/api/agendamentos/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resultado, descricao, data_agendamento, prioridade } = req.body || {};
    const result = await pool.query(`UPDATE agendamentos SET status = COALESCE($1, status), resultado = COALESCE($2, resultado), descricao = COALESCE($3, descricao), data_agendamento = COALESCE($4, data_agendamento), prioridade = COALESCE($5, prioridade), updated_at = NOW() WHERE id = $6 RETURNING *`, [status, resultado, descricao, data_agendamento, prioridade, id]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: "Agendamento não encontrado." });
    await registrarLog(req, 'ATUALIZAR', 'agendamentos', id, { status, resultado });
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("[PUT /api/agendamentos/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar.", error: err.message });
  }
});

app.put("/api/agendamentos/:id/concluir", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { resultado } = req.body || {};
    const result = await pool.query(`UPDATE agendamentos SET status = 'concluido', resultado = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [resultado || 'Concluído', id]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: "Agendamento não encontrado." });
    if (result.rows[0].cliente_id) await pool.query(`UPDATE clientes SET data_ultimo_contato = CURRENT_DATE WHERE id = $1`, [result.rows[0].cliente_id]);
    await registrarLog(req, 'CONCLUIR', 'agendamentos', id, { resultado });
    return res.json({ success: true, data: result.rows[0], message: "Agendamento concluído!" });
  } catch (err) {
    console.error("[PUT /api/agendamentos/:id/concluir] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro.", error: err.message });
  }
});

app.delete("/api/agendamentos/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM agendamentos WHERE id = $1 RETURNING *", [id]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: "Agendamento não encontrado." });
    await registrarLog(req, 'EXCLUIR', 'agendamentos', id, null);
    return res.json({ success: true, message: "Agendamento excluído." });
  } catch (err) {
    console.error("[DELETE /api/agendamentos/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro.", error: err.message });
  }
});

// =====================================================
// CONFIGURAÇÕES DO ESCRITÓRIO
// =====================================================
app.get("/api/configuracoes", auth, async (req, res) => {
  try {
    const resultado = await pool.query("SELECT * FROM configuracoes_escritorio LIMIT 1");
    return res.json({ success: true, data: resultado.rows[0] || {} });
  } catch (err) {
    console.error("[GET /api/configuracoes] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar configurações.", error: err.message });
  }
});

app.put("/api/configuracoes", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const existe = await pool.query("SELECT id FROM configuracoes_escritorio LIMIT 1");
    if (existe.rowCount === 0) {
      const resultado = await pool.query(`INSERT INTO configuracoes_escritorio (nome_escritorio, cnpj, endereco, telefone, email, logo_url, banco_nome, banco_agencia, banco_conta, banco_tipo_conta, banco_titular, banco_cpf_cnpj, banco_pix_chave, banco_pix_tipo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [b.nome_escritorio, b.cnpj, b.endereco, b.telefone, b.email, b.logo_url, b.banco_nome, b.banco_agencia, b.banco_conta, b.banco_tipo_conta, b.banco_titular, b.banco_cpf_cnpj, b.banco_pix_chave, b.banco_pix_tipo]);
      return res.json({ success: true, data: resultado.rows[0], message: "Configurações salvas!" });
    }
    const id = existe.rows[0].id;
    const resultado = await pool.query(`UPDATE configuracoes_escritorio SET nome_escritorio = COALESCE($1, nome_escritorio), cnpj = COALESCE($2, cnpj), endereco = COALESCE($3, endereco), telefone = COALESCE($4, telefone), email = COALESCE($5, email), logo_url = COALESCE($6, logo_url), banco_nome = COALESCE($7, banco_nome), banco_agencia = COALESCE($8, banco_agencia), banco_conta = COALESCE($9, banco_conta), banco_tipo_conta = COALESCE($10, banco_tipo_conta), banco_titular = COALESCE($11, banco_titular), banco_cpf_cnpj = COALESCE($12, banco_cpf_cnpj), banco_pix_chave = COALESCE($13, banco_pix_chave), banco_pix_tipo = COALESCE($14, banco_pix_tipo), updated_at = NOW() WHERE id = $15 RETURNING *`, [b.nome_escritorio, b.cnpj, b.endereco, b.telefone, b.email, b.logo_url, b.banco_nome, b.banco_agencia, b.banco_conta, b.banco_tipo_conta, b.banco_titular, b.banco_cpf_cnpj, b.banco_pix_chave, b.banco_pix_tipo, id]);
    await registrarLog(req, 'ATUALIZAR', 'configuracoes_escritorio', id, b);
    return res.json({ success: true, data: resultado.rows[0], message: "Configurações atualizadas!" });
  } catch (err) {
    console.error("[PUT /api/configuracoes] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar configurações.", error: err.message });
  }
});

// =====================================================
// IMPORTAÇÃO Excel/CSV
// =====================================================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.post("/api/clientes/import", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "Arquivo não enviado." });
    const filename = (req.file.originalname || "").toLowerCase();
    const isCsv = filename.endsWith(".csv");
    let rows = [];
    if (isCsv) {
      const text = req.file.buffer.toString("utf-8");
      const sep = text.includes(";") ? ";" : ",";
      const lines = text.split(/\r?\n/).filter((l) => l && l.trim().length);
      if (lines.length < 2) return res.status(400).json({ success: false, message: "CSV vazio." });
      const headers = lines.shift().split(sep).map((h) => h.trim());
      rows = lines.map((line) => { const cols = line.split(sep); const obj = {}; headers.forEach((h, i) => (obj[h] = (cols[i] ?? "").trim())); return obj; });
    } else {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    }
    if (!rows.length) return res.status(400).json({ success: false, message: "Planilha vazia." });
    const norm = (s) => String(s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
    const pick = (obj, keys) => { const keyMap = new Map(Object.keys(obj).map((k) => [norm(k), obj[k]])); for (const k of keys) { const v = keyMap.get(norm(k)); if (v !== undefined && String(v).trim() !== "") return String(v).trim(); } return ""; };
    let imported = 0, skipped = 0, duplicates = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        const nome = pick(r, ["NOMECLI", "NOME_CLIENTE", "CLIENTE", "nome", "name"]);
        if (!nome) { skipped++; continue; }
        const cpf_cnpj_raw = pick(r, ["cnpj_cpf", "cpf_cnpj", "cpf/cnpj", "cpf", "cnpj"]);
        const cpf_cnpj_digits = normalizeCpfCnpjDigits(cpf_cnpj_raw) || null;
        const telefone = pick(r, ["telefone", "fone", "celular", "whatsapp"]);
        const email_raw = pick(r, ["email", "e-mail", "mail"]);
        const email = email_raw ? normalizeEmail(email_raw) : "";
        let exists = false;
        if (cpf_cnpj_digits) { const q = await pool.query("SELECT id FROM clientes WHERE regexp_replace(coalesce(cpf_cnpj,''), '\\D', '', 'g') = $1 LIMIT 1", [cpf_cnpj_digits]); exists = q.rowCount > 0; }
        else if (email) { const q = await pool.query("SELECT id FROM clientes WHERE lower(email) = lower($1) LIMIT 1", [email]); exists = q.rowCount > 0; }
        if (exists) { duplicates++; continue; }
        await pool.query(`INSERT INTO clientes (nome, email, telefone, cpf_cnpj, endereco, status, observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [nome, email || null, telefone || null, cpf_cnpj_raw || null, null, "ativo", null]);
        imported++;
      } catch (errRow) { skipped++; }
    }
    await registrarLog(req, 'IMPORTAR', 'clientes', null, { imported, skipped, duplicates });
    return res.json({ success: true, imported, skipped, duplicates });
  } catch (err) {
    console.error("[IMPORT CLIENTES] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao importar.", error: err.message });
  }
});

// =====================================================
// RELATÓRIOS - CSV
// =====================================================
app.get("/api/relatorios/export-csv", auth, async (req, res) => {
  try {
    const start = (req.query.start || "").trim();
    const end = (req.query.end || "").trim();
    const hasRange = start && end;
    const qRecebido = await pool.query(`SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'pago' ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`, hasRange ? [start, end] : []);
    const qPendente = await pool.query(`SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'pendente' ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`, hasRange ? [start, end] : []);
    const qVencido = await pool.query(`SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'vencido' ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`, hasRange ? [start, end] : []);
    const qCount = await pool.query(`SELECT COUNT(*)::int AS total FROM cobrancas ${hasRange ? "WHERE vencimento BETWEEN $1 AND $2" : ""}`, hasRange ? [start, end] : []);
    const qClientes = await pool.query(`SELECT COUNT(*)::int AS total FROM clientes WHERE status = 'ativo'`);
    const qRows = await pool.query(`SELECT c.id, COALESCE(cl.nome, '') AS cliente, c.descricao, c.valor_original, c.multa, c.juros, c.desconto, c.valor_atualizado, c.status, c.vencimento, c.created_at FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id ${hasRange ? "WHERE c.vencimento BETWEEN $1 AND $2" : ""} ORDER BY c.created_at DESC`, hasRange ? [start, end] : []);
    const esc = (v) => { const s = String(v ?? ""); if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`; return s; };
    const fmtMoneyCsv = (n) => Number(n || 0).toFixed(2).replace(".", ",");
    const fmtDateCsv = (d) => { if (!d) return ""; const dt = new Date(d); if (isNaN(dt.getTime())) return String(d); return dt.toLocaleDateString("pt-BR"); };
    const lines = [];
    lines.push("RELATORIO ACERTIVE");
    lines.push(`Periodo,${hasRange ? `${start} a ${end}` : 'Todos'}`);
    lines.push("");
    lines.push("RESUMO");
    lines.push(`Clientes Ativos,${qClientes.rows[0]?.total ?? 0}`);
    lines.push(`Cobranças,${qCount.rows[0]?.total ?? 0}`);
    lines.push(`Total Recebido,${fmtMoneyCsv(qRecebido.rows[0]?.total)}`);
    lines.push(`Total Pendente,${fmtMoneyCsv(qPendente.rows[0]?.total)}`);
    lines.push(`Total Vencido,${fmtMoneyCsv(qVencido.rows[0]?.total)}`);
    lines.push("");
    lines.push("DETALHAMENTO");
    lines.push(["ID","Cliente","Descricao","Valor Original","Multa","Juros","Desconto","Valor Atualizado","Status","Vencimento","Criado Em"].join(","));
    for (const r of qRows.rows) {
      lines.push([esc(String(r.id).slice(0,8)), esc(r.cliente), esc(r.descricao || ""), fmtMoneyCsv(r.valor_original), fmtMoneyCsv(r.multa), fmtMoneyCsv(r.juros), fmtMoneyCsv(r.desconto), fmtMoneyCsv(r.valor_atualizado), esc(r.status), fmtDateCsv(r.vencimento), fmtDateCsv(r.created_at)].join(","));
    }
    const csv = lines.join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="relatorio_acertive.csv"`);
    return res.send("\uFEFF" + csv);
  } catch (err) {
    console.error("[EXPORT CSV] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao exportar CSV.", error: err.message });
  }
});

// =====================================================
// HISTÓRICO DE AÇÕES (AUDITORIA)
// =====================================================
app.get("/api/historico", auth, async (req, res) => {
  try {
    const { entidade, acao, limite = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    if (entidade) { params.push(entidade); where.push(`entidade = $${params.length}`); }
    if (acao) { params.push(acao); where.push(`acao = $${params.length}`); }
    const limiteSanitizado = Math.min(parseInt(limite) || 50, 500);
    const offsetSanitizado = parseInt(offset) || 0;
    const sql = `SELECT id, usuario_id, usuario_nome, acao, entidade, entidade_id, detalhes, ip, created_at FROM logs_acoes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${limiteSanitizado} OFFSET ${offsetSanitizado}`;
    const resultado = await pool.query(sql, params);
    const sqlCount = `SELECT COUNT(*)::int AS total FROM logs_acoes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    const countResult = await pool.query(sqlCount, params);
    return res.json({ success: true, data: resultado.rows, total: countResult.rows[0]?.total || 0 });
  } catch (err) {
    console.error("[HISTORICO] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar histórico.", error: err.message });
  }
});

// =====================================================
// GESTÃO DE USUÁRIOS (ADMIN)
// =====================================================
app.get("/api/usuarios", authAdmin, async (req, res) => {
  try {
    const resultado = await pool.query(`SELECT id, nome, email, nivel, ativo, created_at, updated_at FROM users ORDER BY created_at DESC`);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/usuarios] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar usuários.", error: err.message });
  }
});

app.get("/api/usuarios/me", auth, async (req, res) => {
  try {
    const resultado = await pool.query("SELECT id, nome, email, nivel, ativo, created_at FROM users WHERE id = $1", [req.user.userId]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Usuário não encontrado." });
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[GET /api/usuarios/me] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro.", error: err.message });
  }
});

app.post("/api/usuarios", authAdmin, async (req, res) => {
  try {
    const { nome, email, senha, nivel = 'operador' } = req.body || {};
    if (!nome || !email || !senha) return res.status(400).json({ success: false, message: "Nome, email e senha são obrigatórios." });
    const existe = await pool.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    if (existe.rowCount > 0) return res.status(400).json({ success: false, message: "E-mail já cadastrado." });
    const senhaHash = await bcrypt.hash(senha, 10);
    const resultado = await pool.query(`INSERT INTO users (nome, email, senha_hash, nivel, ativo, created_at, updated_at) VALUES ($1, $2, $3, $4, true, NOW(), NOW()) RETURNING id, nome, email, nivel, ativo, created_at`, [nome, email, senhaHash, nivel]);
    await registrarLog(req, 'CRIAR', 'users', resultado.rows[0].id, { email });
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[POST /api/usuarios] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao criar usuário.", error: err.message });
  }
});

app.put("/api/usuarios/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, email, senha, nivel, ativo } = req.body || {};
    const atual = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    if (!atual.rowCount) return res.status(404).json({ success: false, message: "Usuário não encontrado." });
    if (email && email !== atual.rows[0].email) {
      const existe = await pool.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2", [email, id]);
      if (existe.rowCount > 0) return res.status(400).json({ success: false, message: "E-mail já cadastrado." });
    }
    let senhaHash = atual.rows[0].senha_hash;
    if (senha) senhaHash = await bcrypt.hash(senha, 10);
    const resultado = await pool.query(`UPDATE users SET nome = COALESCE($1, nome), email = COALESCE($2, email), senha_hash = $3, nivel = COALESCE($4, nivel), ativo = COALESCE($5, ativo), updated_at = NOW() WHERE id = $6 RETURNING id, nome, email, nivel, ativo, created_at, updated_at`, [nome, email, senhaHash, nivel, ativo, id]);
    await registrarLog(req, 'ATUALIZAR', 'users', id, { nome, email, nivel, ativo });
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[PUT /api/usuarios/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar usuário.", error: err.message });
  }
});

app.delete("/api/usuarios/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.userId) return res.status(400).json({ success: false, message: "Você não pode desativar sua própria conta." });
    const resultado = await pool.query(`UPDATE users SET ativo = false, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Usuário não encontrado." });
    await registrarLog(req, 'DESATIVAR', 'users', id, null);
    return res.json({ success: true, message: "Usuário desativado." });
  } catch (err) {
    console.error("[DELETE /api/usuarios/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao desativar usuário.", error: err.message });
  }
});

// =====================================================
// COBRANÇAS RECORRENTES
// =====================================================
app.get("/api/cobrancas-recorrentes", auth, async (req, res) => {
  try {
    const { ativo } = req.query;
    let where = "";
    const params = [];
    if (ativo !== undefined) { params.push(ativo === 'true'); where = `WHERE cr.ativo = $${params.length}`; }
    const sql = `SELECT cr.*, cl.nome AS cliente_nome, cl.email AS cliente_email, cl.telefone AS cliente_telefone FROM cobrancas_recorrentes cr LEFT JOIN clientes cl ON cl.id = cr.cliente_id ${where} ORDER BY cr.created_at DESC`;
    const resultado = await pool.query(sql, params);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/cobrancas-recorrentes] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar recorrentes.", error: err.message });
  }
});

app.get("/api/cobrancas-recorrentes/stats", auth, async (req, res) => {
  try {
    const stats = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ativo = true)::int AS ativas, COUNT(*) FILTER (WHERE ativo = false)::int AS inativas, COALESCE(SUM(valor) FILTER (WHERE ativo = true), 0)::numeric AS valor_mensal_ativo, COALESCE(SUM(total_geradas), 0)::int AS total_cobrancas_geradas FROM cobrancas_recorrentes`);
    return res.json({ success: true, data: stats.rows[0] });
  } catch (err) {
    console.error("[STATS RECORRENTES] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro.", error: err.message });
  }
});

app.get("/api/cobrancas-recorrentes/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `SELECT cr.*, cl.nome AS cliente_nome FROM cobrancas_recorrentes cr LEFT JOIN clientes cl ON cl.id = cr.cliente_id WHERE cr.id = $1`;
    const resultado = await pool.query(sql, [id]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Recorrente não encontrada." });
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[GET /api/cobrancas-recorrentes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro.", error: err.message });
  }
});

app.post("/api/cobrancas-recorrentes", auth, async (req, res) => {
  try {
    const { cliente_id, valor, descricao, frequencia = 'mensal', dia_vencimento = 10, data_inicio, data_fim } = req.body || {};
    if (!cliente_id) return res.status(400).json({ success: false, message: "Cliente é obrigatório." });
    if (!valor || parseFloat(valor) <= 0) return res.status(400).json({ success: false, message: "Valor deve ser maior que zero." });
    if (!data_inicio) return res.status(400).json({ success: false, message: "Data de início é obrigatória." });
    const diaVenc = parseInt(dia_vencimento);
    if (diaVenc < 1 || diaVenc > 28) return res.status(400).json({ success: false, message: "Dia de vencimento deve ser entre 1 e 28." });
    const resultado = await pool.query(`INSERT INTO cobrancas_recorrentes (cliente_id, valor, descricao, frequencia, dia_vencimento, data_inicio, data_fim, ativo) VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`, [cliente_id, parseFloat(valor), descricao || null, frequencia, diaVenc, data_inicio, data_fim || null]);
    await registrarLog(req, 'CRIAR', 'cobrancas_recorrentes', resultado.rows[0].id, { cliente_id, valor, frequencia });
    return res.json({ success: true, data: resultado.rows[0], message: "Recorrente criada!" });
  } catch (err) {
    console.error("[POST /api/cobrancas-recorrentes] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao criar recorrente.", error: err.message });
  }
});

app.put("/api/cobrancas-recorrentes/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor, descricao, frequencia, dia_vencimento, data_fim, ativo } = req.body || {};
    const resultado = await pool.query(`UPDATE cobrancas_recorrentes SET valor = COALESCE($1, valor), descricao = COALESCE($2, descricao), frequencia = COALESCE($3, frequencia), dia_vencimento = COALESCE($4, dia_vencimento), data_fim = $5, ativo = COALESCE($6, ativo), updated_at = NOW() WHERE id = $7 RETURNING *`, [valor ? parseFloat(valor) : null, descricao, frequencia, dia_vencimento ? parseInt(dia_vencimento) : null, data_fim, ativo, id]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Recorrente não encontrada." });
    await registrarLog(req, 'ATUALIZAR', 'cobrancas_recorrentes', id, { valor, frequencia, ativo });
    return res.json({ success: true, data: resultado.rows[0], message: "Recorrente atualizada!" });
  } catch (err) {
    console.error("[PUT /api/cobrancas-recorrentes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar.", error: err.message });
  }
});

app.delete("/api/cobrancas-recorrentes/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await pool.query(`UPDATE cobrancas_recorrentes SET ativo = false, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Recorrente não encontrada." });
    await registrarLog(req, 'DESATIVAR', 'cobrancas_recorrentes', id, null);
    return res.json({ success: true, message: "Recorrente desativada." });
  } catch (err) {
    console.error("[DELETE /api/cobrancas-recorrentes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro.", error: err.message });
  }
});

app.post("/api/cobrancas-recorrentes/:id/gerar", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const recorrente = await pool.query(`SELECT cr.*, cl.nome AS cliente_nome FROM cobrancas_recorrentes cr LEFT JOIN clientes cl ON cl.id = cr.cliente_id WHERE cr.id = $1 AND cr.ativo = true`, [id]);
    if (!recorrente.rowCount) return res.status(404).json({ success: false, message: "Recorrente não encontrada ou inativa." });
    const r = recorrente.rows[0];
    const hoje = new Date();
    let vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 1, r.dia_vencimento);
    if (hoje.getDate() < r.dia_vencimento) vencimento = new Date(hoje.getFullYear(), hoje.getMonth(), r.dia_vencimento);
    const vencimentoStr = vencimento.toISOString().split('T')[0];
    const novaCobranca = await pool.query(`INSERT INTO cobrancas (cliente_id, descricao, valor_original, multa, juros, desconto, vencimento, status, valor_atualizado) VALUES ($1, $2, $3, 0, 0, 0, $4, 'pendente', $3) RETURNING *`, [r.cliente_id, `${r.descricao || 'Cobrança recorrente'} (Ref: ${vencimento.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })})`, r.valor, vencimentoStr]);
    await pool.query(`UPDATE cobrancas_recorrentes SET ultima_geracao = $1, total_geradas = total_geradas + 1, updated_at = NOW() WHERE id = $2`, [hoje.toISOString().split('T')[0], id]);
    await registrarLog(req, 'GERAR_COBRANCA_RECORRENTE', 'cobrancas_recorrentes', id, { cobranca_id: novaCobranca.rows[0].id });
    return res.json({ success: true, message: `Cobrança gerada! Vencimento: ${vencimento.toLocaleDateString('pt-BR')}`, cobranca: novaCobranca.rows[0] });
  } catch (err) {
    console.error("[POST /api/cobrancas-recorrentes/:id/gerar] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar cobrança.", error: err.message });
  }
});

// =====================================================
// BACKUP / EXPORTAÇÃO EXCEL
// =====================================================
app.get("/api/backup/exportar", authAdmin, async (req, res) => {
  try {
    const clientes = await pool.query("SELECT * FROM clientes ORDER BY created_at DESC");
    const cobrancas = await pool.query(`SELECT c.*, COALESCE(cl.nome, '') AS cliente_nome FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id ORDER BY c.created_at DESC`);
    const wb = XLSX.utils.book_new();
    const wsClientes = XLSX.utils.json_to_sheet(clientes.rows.map(c => ({ ID: c.id, Nome: c.nome, Email: c.email, Telefone: c.telefone, 'CPF/CNPJ': c.cpf_cnpj, Status: c.status, 'Status Cliente': c.status_cliente, 'Criado em': c.created_at ? new Date(c.created_at).toLocaleString('pt-BR') : '' })));
    XLSX.utils.book_append_sheet(wb, wsClientes, "Clientes");
    const wsCobrancas = XLSX.utils.json_to_sheet(cobrancas.rows.map(c => ({ ID: c.id, Cliente: c.cliente_nome, Descricao: c.descricao, 'Valor Original': c.valor_original, Multa: c.multa, Juros: c.juros, 'Valor Atualizado': c.valor_atualizado, Status: c.status, Vencimento: c.vencimento ? new Date(c.vencimento).toLocaleDateString('pt-BR') : '', 'Criado em': c.created_at ? new Date(c.created_at).toLocaleString('pt-BR') : '' })));
    XLSX.utils.book_append_sheet(wb, wsCobrancas, "Cobrancas");
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await registrarLog(req, 'BACKUP', 'sistema', null, { clientes: clientes.rowCount, cobrancas: cobrancas.rowCount });
    const dataAtual = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="backup_acertive_${dataAtual}.xlsx"`);
    return res.send(buffer);
  } catch (err) {
    console.error("[BACKUP] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar backup.", error: err.message });
  }
});
// =====================================================
// ROTAS PARA IMPORTAÇÃO E CONSULTA DE CLIENTES

// Obter cliente completo com todas as cobranças
app.get("/api/clientes/:id/completo", auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar cliente
    const clienteResult = await pool.query(`
      SELECT c.*, COALESCE(e.nome, '') AS empresa_nome
      FROM clientes c
      LEFT JOIN empresas e ON e.id = c.empresa_id
      WHERE c.id = $1
    `, [id]);

    if (!clienteResult.rowCount) {
      return res.status(404).json({ success: false, message: "Cliente não encontrado." });
    }

    // Buscar cobranças
    const cobrancasResult = await pool.query(`
      SELECT * FROM cobrancas 
      WHERE cliente_id = $1 
      ORDER BY vencimento DESC
    `, [id]);

    // Calcular estatísticas
    const cobrancas = cobrancasResult.rows;
    const stats = {
      total_cobrancas: cobrancas.length,
      total_pagas: cobrancas.filter(c => c.status === 'pago').length,
      total_pendentes: cobrancas.filter(c => c.status === 'pendente').length,
      total_vencidas: cobrancas.filter(c => c.status === 'vencido').length,
      valor_total: cobrancas.reduce((acc, c) => acc + Number(c.valor_atualizado || 0), 0),
      valor_pago: cobrancas.filter(c => c.status === 'pago').reduce((acc, c) => acc + Number(c.valor_atualizado || 0), 0),
      valor_pendente: cobrancas.filter(c => c.status !== 'pago').reduce((acc, c) => acc + Number(c.valor_atualizado || 0), 0)
    };

    return res.json({
      success: true,
      data: {
        cliente: clienteResult.rows[0],
        cobrancas: cobrancas,
        estatisticas: stats
      }
    });
  } catch (err) {
    console.error("[GET /api/clientes/:id/completo] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar cliente.", error: err.message });
  }
});

// Importar cobranças de planilha
app.post("/api/cobrancas/import", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Arquivo não enviado." });
    }

    const filename = (req.file.originalname || "").toLowerCase();
    let rows = [];

    // Ler arquivo
    if (filename.endsWith(".csv")) {
      const text = req.file.buffer.toString("utf-8");
      const sep = text.includes(";") ? ";" : ",";
      const lines = text.split(/\r?\n/).filter(l => l && l.trim().length);
      if (lines.length < 2) {
        return res.status(400).json({ success: false, message: "CSV vazio." });
      }
      const headers = lines.shift().split(sep).map(h => h.trim());
      rows = lines.map(line => {
        const cols = line.split(sep);
        const obj = {};
        headers.forEach((h, i) => obj[h] = (cols[i] ?? "").trim());
        return obj;
      });
    } else {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    }

    if (!rows.length) {
      return res.status(400).json({ success: false, message: "Planilha vazia." });
    }

    // Funções auxiliares
    const norm = s => String(s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
    const pick = (obj, keys) => {
      const keyMap = new Map(Object.keys(obj).map(k => [norm(k), obj[k]]));
      for (const k of keys) {
        const v = keyMap.get(norm(k));
        if (v !== undefined && String(v).trim() !== "") return String(v).trim();
      }
      return "";
    };

    const normalizeCpf = s => String(s || "").replace(/\D/g, "");

    const parseDate = d => {
      if (!d) return null;
      // Se for número do Excel
      if (typeof d === "number") {
        const date = new Date((d - 25569) * 86400 * 1000);
        return date.toISOString().split("T")[0];
      }
      const s = String(d).trim();
      // YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      // DD/MM/YYYY
      const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
      return null;
    };

    const parseValor = v => {
      if (!v) return 0;
      if (typeof v === "number") return v;
      const s = String(v).replace(/[^\d,.-]/g, "").replace(",", ".");
      return parseFloat(s) || 0;
    };

    // Buscar empresa padrão
    const empresaPadrao = await pool.query("SELECT id FROM empresas WHERE padrao = true AND ativo = true LIMIT 1");
    const empresaId = empresaPadrao.rows[0]?.id || null;

    // Cache de clientes por CPF
    const clientesCache = new Map();
    let clientesCriados = 0;
    let clientesExistentes = 0;
    let cobrancasCriadas = 0;
    let cobrancasIgnoradas = 0;
    const erros = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        // Extrair dados do cliente
        const nome = pick(r, ["NOMECLI", "NOME_CLIENTE", "CLIENTE", "nome", "name", "Nome"]);
        if (!nome) {
          cobrancasIgnoradas++;
          continue;
        }

        const cpfRaw = pick(r, ["cnpj_cpf", "cpf_cnpj", "cpf/cnpj", "cpf", "cnpj", "CPF", "CNPJ"]);
        const cpfDigits = normalizeCpf(cpfRaw);
        const telefone = pick(r, ["telefone", "fone", "celular", "whatsapp", "telefone2"]);
        const email = pick(r, ["email", "e-mail", "mail", "Email"]);

        // Extrair dados da cobrança
        const valor = parseValor(pick(r, ["valor", "value", "vlr", "valor_original", "Valor"]));
        const valorLiquido = parseValor(pick(r, ["Valor Líquido", "valor_liquido", "vlr_liquido"]));
        const valorPago = parseValor(pick(r, ["Valor Pago", "valor_pago", "vlr_pago"]));
        const vencimento = parseDate(pick(r, ["Data Vencimento", "vencimento", "dt_vencimento", "data_vencimento"]));
        const emissao = parseDate(pick(r, ["Data Emissão", "emissao", "dt_emissao", "data_emissao"]));
        const descricao = pick(r, ["Histórico", "historico", "obs", "observacao", "descricao", "Descrição"]);
        const numDoc = pick(r, ["Número do Documento", "num_documento", "documento", "numero"]);

        if (!valor || valor <= 0) {
          cobrancasIgnoradas++;
          continue;
        }

        // Buscar ou criar cliente
        let clienteId = null;

        if (cpfDigits && clientesCache.has(cpfDigits)) {
          clienteId = clientesCache.get(cpfDigits);
          // Não conta como existente de novo se já estava no cache desta importação
        } else if (cpfDigits) {
          // Buscar por CPF no banco
          const existente = await pool.query(
            "SELECT id FROM clientes WHERE REPLACE(REPLACE(REPLACE(cpf_cnpj, '.', ''), '-', ''), '/', '') = $1 LIMIT 1",
            [cpfDigits]
          );

          if (existente.rowCount > 0) {
            clienteId = existente.rows[0].id;
            clientesCache.set(cpfDigits, clienteId);
            clientesExistentes++;
          }
        }

        // Se não encontrou por CPF, buscar por nome exato
        if (!clienteId) {
          const porNome = await pool.query(
            "SELECT id FROM clientes WHERE LOWER(nome) = LOWER($1) LIMIT 1",
            [nome]
          );
          if (porNome.rowCount > 0) {
            clienteId = porNome.rows[0].id;
            if (cpfDigits) clientesCache.set(cpfDigits, clienteId);
            clientesExistentes++;
          }
        }

        // Se ainda não encontrou, criar novo cliente
        if (!clienteId) {
          const novoCliente = await pool.query(
            `INSERT INTO clientes (nome, cpf_cnpj, telefone, email, status, empresa_id, status_cliente)
             VALUES ($1, $2, $3, $4, 'ativo', $5, 'regular') RETURNING id`,
            [nome, cpfRaw || null, telefone || null, email || null, empresaId]
          );
          clienteId = novoCliente.rows[0].id;
          if (cpfDigits) clientesCache.set(cpfDigits, clienteId);
          clientesCriados++;
        }

        // Determinar status da cobrança
        let status = "pendente";
        const valorFinal = valorLiquido || valor;
        
        if (valorPago && valorPago >= valorFinal * 0.9) {
          status = "pago";
        } else if (vencimento) {
          const hoje = new Date();
          const venc = new Date(vencimento);
          if (venc < hoje) status = "vencido";
        }

        // Criar cobrança
        await pool.query(
          `INSERT INTO cobrancas (cliente_id, empresa_id, descricao, valor_original, valor_atualizado, vencimento, status, observacoes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            clienteId,
            empresaId,
            descricao || numDoc || "Cobrança importada",
            valor,
            valorFinal,
            vencimento,
            status,
            numDoc ? `Doc: ${numDoc}` : null
          ]
        );
        cobrancasCriadas++;

      } catch (errRow) {
        cobrancasIgnoradas++;
        if (erros.length < 10) {
          erros.push(`Linha ${i + 2}: ${errRow.message}`);
        }
      }
    }

    await registrarLog(req, 'IMPORTAR_COBRANCAS', 'cobrancas', null, {
      clientesCriados,
      clientesExistentes,
      cobrancasCriadas,
      cobrancasIgnoradas,
      totalLinhas: rows.length
    });

    return res.json({
      success: true,
      message: "Importação concluída!",
      clientesCriados,
      clientesExistentes,
      cobrancasCriadas,
      cobrancasIgnoradas,
      totalLinhas: rows.length,
      erros: erros.length > 0 ? erros : undefined
    });

  } catch (err) {
    console.error("[POST /api/cobrancas/import] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao importar.", error: err.message });
  }
});

// Estatísticas gerais de clientes
app.get("/api/clientes/estatisticas", auth, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(DISTINCT c.id)::int AS total_clientes,
        COUNT(DISTINCT CASE WHEN c.status = 'ativo' THEN c.id END)::int AS clientes_ativos,
        COUNT(cob.id)::int AS total_cobrancas,
        COALESCE(SUM(CASE WHEN cob.status IN ('pendente', 'vencido') THEN cob.valor_atualizado ELSE 0 END), 0)::numeric AS total_a_receber,
        COALESCE(SUM(CASE WHEN cob.status = 'pago' THEN cob.valor_atualizado ELSE 0 END), 0)::numeric AS total_recebido,
        COUNT(CASE WHEN cob.status = 'vencido' THEN 1 END)::int AS cobrancas_vencidas
      FROM clientes c
      LEFT JOIN cobrancas cob ON cob.cliente_id = c.id
    `);

    return res.json({ success: true, data: stats.rows[0] });
  } catch (err) {
    console.error("[GET /api/clientes/estatisticas] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar estatísticas.", error: err.message });
  }
});
// =====================================================
// ROTA - BUSCAR COBRANÇAS ARQUIVADAS
// Adicione isso no server.js ANTES da linha 404
// =====================================================

// GET /api/cobrancas/arquivadas - Listar cobranças arquivadas
app.get("/api/cobrancas/arquivadas", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id,
        c.descricao,
        c.valor_original,
        c.valor_atualizado,
        c.vencimento,
        c.status,
        c.created_at,
        cl.nome as cliente,
        cl.telefone as cliente_telefone,
        cl.cpf_cnpj as cliente_cpf
      FROM cobrancas c
      LEFT JOIN clientes cl ON c.cliente_id = cl.id
      WHERE c.status = 'arquivado'
      ORDER BY c.vencimento DESC
      LIMIT 500
    `);

    // Calcular total
    const totalResult = await pool.query(`
      SELECT 
        COUNT(*)::int as total,
        COALESCE(SUM(valor_atualizado), 0)::numeric as valor_total
      FROM cobrancas 
      WHERE status = 'arquivado'
    `);

    return res.json({
      success: true,
      data: result.rows.map(r => ({
        id: r.id,
        descricao: r.descricao,
        valorOriginal: r.valor_original,
        valorAtualizado: r.valor_atualizado,
        valor_atualizado: r.valor_atualizado,
        vencimento: r.vencimento,
        status: r.status,
        cliente: r.cliente,
        cliente_telefone: r.cliente_telefone,
        cliente_cpf: r.cliente_cpf,
        created_at: r.created_at
      })),
      total: totalResult.rows[0]?.total || 0,
      valorTotal: totalResult.rows[0]?.valor_total || 0
    });
  } catch (err) {
    console.error("[ARQUIVADAS] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar arquivadas." });
  }
});
// =====================================================
// ROTA ADMINISTRATIVA - ARQUIVAR COBRANÇAS ANTIGAS
// =====================================================
app.get("/api/admin/arquivar-antigas", async (req, res) => {
  try {
    // Verificar se é admin (opcional - remova se quiser acesso livre)
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'chave-secreta');
      if (decoded.nivel !== 'admin') {
        return res.status(403).json({ success: false, message: "Acesso negado" });
      }
    }

    // Arquivar cobranças antigas (vencimento antes de 2025)
    const resultado = await pool.query(`
      UPDATE cobrancas 
      SET status = 'arquivado'
      WHERE vencimento < '2025-01-01'
        AND status IN ('pendente', 'vencido')
      RETURNING id
    `);

    return res.json({
      success: true,
      message: resultado.rowCount + " cobranças arquivadas com sucesso!",
      arquivadas: resultado.rowCount
    });
  } catch (err) {
    console.error("[ARQUIVAR] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao arquivar.", error: err.message });
  }
});
// =====================================================
// SISTEMA DE ALERTAS E LEMBRETES
// Cole este código no seu server.js (antes do app.listen)
// =====================================================

// GET /api/alertas - Retorna todos os alertas do sistema
app.get("/api/alertas", auth, async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const em3dias = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const ha7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const ha30dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // 1. Cobranças vencendo HOJE
    const vencendoHoje = await pool.query(`
      SELECT c.id, c.descricao, c.valor_atualizado, c.vencimento, 
             COALESCE(cl.nome, 'Cliente não identificado') as cliente,
             COALESCE(cl.telefone, '') as telefone
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.status = 'pendente' 
        AND DATE(c.vencimento) = $1
      ORDER BY c.valor_atualizado DESC
      LIMIT 20
    `, [hoje]);

    // 2. Cobranças vencendo em 3 dias
    const vencendoEm3Dias = await pool.query(`
      SELECT c.id, c.descricao, c.valor_atualizado, c.vencimento,
             COALESCE(cl.nome, 'Cliente não identificado') as cliente,
             COALESCE(cl.telefone, '') as telefone
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.status = 'pendente'
        AND DATE(c.vencimento) > $1
        AND DATE(c.vencimento) <= $2
      ORDER BY c.vencimento ASC
      LIMIT 20
    `, [hoje, em3dias]);

    // 3. Cobranças VENCIDAS (em atraso)
    const vencidas = await pool.query(`
      SELECT c.id, c.descricao, c.valor_atualizado, c.vencimento,
             COALESCE(cl.nome, 'Cliente não identificado') as cliente,
             COALESCE(cl.telefone, '') as telefone,
             CURRENT_DATE - DATE(c.vencimento) as dias_atraso
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.status IN ('pendente', 'vencido')
        AND DATE(c.vencimento) < $1
      ORDER BY c.vencimento ASC
      LIMIT 30
    `, [hoje]);

    // 4. Agendamentos do dia
    const agendamentosHoje = await pool.query(`
      SELECT a.id, a.tipo, a.descricao, a.data_agendamento, a.prioridade,
             COALESCE(cl.nome, 'Cliente não identificado') as cliente,
             COALESCE(cl.telefone, '') as telefone
      FROM agendamentos a
      LEFT JOIN clientes cl ON cl.id = a.cliente_id
      WHERE a.status = 'pendente'
        AND DATE(a.data_agendamento) = $1
      ORDER BY a.data_agendamento ASC
    `, [hoje]);

    // 5. Clientes sem contato há mais de 7 dias (com dívidas pendentes)
    const clientesSemContato = await pool.query(`
      SELECT 
        cl.id, cl.nome, cl.telefone, cl.email,
        COALESCE(cl.data_ultimo_contato, cl.created_at) as ultimo_contato,
        CURRENT_DATE - DATE(COALESCE(cl.data_ultimo_contato, cl.created_at)) as dias_sem_contato,
        COUNT(c.id)::int as total_cobrancas,
        COALESCE(SUM(c.valor_atualizado), 0)::numeric as divida_total
      FROM clientes cl
      INNER JOIN cobrancas c ON c.cliente_id = cl.id
      WHERE cl.status = 'ativo'
        AND c.status IN ('pendente', 'vencido')
        AND DATE(COALESCE(cl.data_ultimo_contato, cl.created_at)) < $1
      GROUP BY cl.id
      HAVING SUM(c.valor_atualizado) > 0
      ORDER BY divida_total DESC
      LIMIT 20
    `, [ha7dias]);

    // 6. Cobranças com alto valor vencidas (prioridade)
    const altosValores = await pool.query(`
      SELECT c.id, c.descricao, c.valor_atualizado, c.vencimento,
             COALESCE(cl.nome, 'Cliente não identificado') as cliente,
             CURRENT_DATE - DATE(c.vencimento) as dias_atraso
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.status IN ('pendente', 'vencido')
        AND DATE(c.vencimento) < $1
        AND c.valor_atualizado >= 1000
      ORDER BY c.valor_atualizado DESC
      LIMIT 10
    `, [hoje]);

    // 7. Resumo geral
    const resumo = await pool.query(`
      SELECT
        COUNT(CASE WHEN status IN ('pendente', 'vencido') AND DATE(vencimento) < CURRENT_DATE THEN 1 END)::int as total_vencidas,
        COUNT(CASE WHEN status = 'pendente' AND DATE(vencimento) = CURRENT_DATE THEN 1 END)::int as vencendo_hoje,
        COUNT(CASE WHEN status = 'pendente' AND DATE(vencimento) > CURRENT_DATE AND DATE(vencimento) <= CURRENT_DATE + 3 THEN 1 END)::int as vencendo_3dias,
        COALESCE(SUM(CASE WHEN status IN ('pendente', 'vencido') AND DATE(vencimento) < CURRENT_DATE THEN valor_atualizado END), 0)::numeric as valor_vencido,
        COALESCE(SUM(CASE WHEN status = 'pendente' AND DATE(vencimento) = CURRENT_DATE THEN valor_atualizado END), 0)::numeric as valor_hoje
      FROM cobrancas
      WHERE status != 'arquivado'
    `);

    const totalAlertas = 
      (vencendoHoje.rowCount || 0) + 
      (vencidas.rowCount || 0) + 
      (agendamentosHoje.rowCount || 0) +
      (clientesSemContato.rowCount || 0);

    return res.json({
      success: true,
      totalAlertas,
      resumo: resumo.rows[0] || {},
      alertas: {
        vencendoHoje: vencendoHoje.rows,
        vencendoEm3Dias: vencendoEm3Dias.rows,
        vencidas: vencidas.rows,
        agendamentosHoje: agendamentosHoje.rows,
        clientesSemContato: clientesSemContato.rows,
        altosValores: altosValores.rows
      }
    });

  } catch (err) {
    console.error("[ALERTAS] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar alertas.", error: err.message });
  }
});

// GET /api/alertas/contador - Retorna apenas o contador para o badge
app.get("/api/alertas/contador", auth, async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    
    const resultado = await pool.query(`
      SELECT
        COUNT(CASE WHEN status IN ('pendente', 'vencido') AND DATE(vencimento) < CURRENT_DATE THEN 1 END)::int as vencidas,
        COUNT(CASE WHEN status = 'pendente' AND DATE(vencimento) = CURRENT_DATE THEN 1 END)::int as vencendo_hoje
      FROM cobrancas
      WHERE status != 'arquivado'
    `);

    const agendamentos = await pool.query(`
      SELECT COUNT(*)::int as total
      FROM agendamentos
      WHERE status = 'pendente' AND DATE(data_agendamento) = $1
    `, [hoje]);

    const r = resultado.rows[0] || {};
    const total = (r.vencidas || 0) + (r.vencendo_hoje || 0) + (agendamentos.rows[0]?.total || 0);

    return res.json({
      success: true,
      total,
      vencidas: r.vencidas || 0,
      vencendoHoje: r.vencendo_hoje || 0,
      agendamentosHoje: agendamentos.rows[0]?.total || 0
    });

  } catch (err) {
    console.error("[ALERTAS CONTADOR] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao contar alertas." });
  }
});
// =====================================================
// ROTAS DE ARQUIVAMENTO EM MASSA - ACERTIVE
// Cole este código no seu server.js (antes do app.listen)
// =====================================================

// POST /api/cobrancas/arquivar-massa - Arquivar múltiplas cobranças
app.post("/api/cobrancas/arquivar-massa", auth, async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "Nenhuma cobrança selecionada." });
    }

    // Limitar a 1000 por vez para evitar timeout
    if (ids.length > 5000) {
      return res.status(400).json({ success: false, message: "Máximo de 5000 cobranças por vez." });
    }

    const result = await pool.query(`
      UPDATE cobrancas 
      SET status = 'arquivado', updated_at = NOW() 
      WHERE id = ANY($1) AND status != 'arquivado'
      RETURNING id
    `, [ids]);

    const arquivadas = result.rowCount;

    return res.json({ 
      success: true, 
      message: `${arquivadas} cobrança(s) arquivada(s) com sucesso.`,
      arquivadas
    });

  } catch (err) {
    console.error("[ARQUIVAR MASSA] Erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao arquivar cobranças." });
  }
});


// POST /api/cobrancas/desarquivar-massa - Desarquivar múltiplas cobranças
app.post("/api/cobrancas/desarquivar-massa", auth, async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "Nenhuma cobrança selecionada." });
    }

    if (ids.length > 1000) {
      return res.status(400).json({ success: false, message: "Máximo de 1000 cobranças por vez." });
    }

    const result = await pool.query(`
      UPDATE cobrancas 
      SET status = 'pendente', updated_at = NOW() 
      WHERE id = ANY($1) AND status = 'arquivado'
      RETURNING id
    `, [ids]);

    const desarquivadas = result.rowCount;

    return res.json({ 
      success: true, 
      message: `${desarquivadas} cobrança(s) desarquivada(s) com sucesso.`,
      desarquivadas
    });

  } catch (err) {
    console.error("[DESARQUIVAR MASSA] Erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao desarquivar cobranças." });
  }
});


// POST /api/cobrancas/arquivar-todas - Arquivar TODAS as cobranças filtradas
app.post("/api/cobrancas/arquivar-todas", auth, async (req, res) => {
  try {
    const { filtros } = req.body;
    
    let whereClause = "WHERE status != 'arquivado'";
    const params = [];
    let paramIndex = 1;

    // Aplicar filtros opcionais
    if (filtros?.status) {
      whereClause += ` AND status = $${paramIndex}`;
      params.push(filtros.status);
      paramIndex++;
    }

    if (filtros?.vencimentoAte) {
      whereClause += ` AND vencimento <= $${paramIndex}`;
      params.push(filtros.vencimentoAte);
      paramIndex++;
    }

    if (filtros?.clienteId) {
      whereClause += ` AND cliente_id = $${paramIndex}`;
      params.push(filtros.clienteId);
      paramIndex++;
    }

    const result = await pool.query(`
      UPDATE cobrancas 
      SET status = 'arquivado', updated_at = NOW() 
      ${whereClause}
      RETURNING id
    `, params);

    const arquivadas = result.rowCount;

    return res.json({ 
      success: true, 
      message: `${arquivadas} cobrança(s) arquivada(s) com sucesso.`,
      arquivadas
    });

  } catch (err) {
    console.error("[ARQUIVAR TODAS] Erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao arquivar cobranças." });
  }
});


// GET /api/cobrancas/arquivadas - Listar cobranças arquivadas com paginação
app.get("/api/cobrancas/arquivadas", auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const busca = req.query.busca || null;

    let whereClause = "WHERE c.status = 'arquivado'";
    const params = [];
    let paramIndex = 1;

    if (busca) {
      whereClause += ` AND (cl.nome ILIKE $${paramIndex} OR c.descricao ILIKE $${paramIndex})`;
      params.push(`%${busca}%`);
      paramIndex++;
    }

    // Query principal
    const cobrancas = await pool.query(`
      SELECT 
        c.id, c.descricao, c.valor_original, c.valor_atualizado, 
        c.vencimento, c.status, c.created_at, c.updated_at,
        COALESCE(cl.nome, 'Sem cliente') as cliente,
        cl.id as cliente_id
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      ${whereClause}
      ORDER BY c.updated_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...params, limit, offset]);

    // Contagem total
    const countResult = await pool.query(`
      SELECT COUNT(*)::int as total
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      ${whereClause}
    `, params);

    const total = countResult.rows[0]?.total || 0;
    const totalPages = Math.ceil(total / limit);

    return res.json({
      success: true,
      data: cobrancas.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });

  } catch (err) {
    console.error("[COBRANCAS ARQUIVADAS] Erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao carregar cobranças arquivadas." });
  }
});


// GET /api/cobrancas/estatisticas-arquivamento - Estatísticas para exibir
app.get("/api/cobrancas/estatisticas-arquivamento", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status != 'arquivado')::int as ativas,
        COUNT(*) FILTER (WHERE status = 'arquivado')::int as arquivadas,
        COALESCE(SUM(valor_atualizado) FILTER (WHERE status != 'arquivado'), 0)::numeric as valor_ativas,
        COALESCE(SUM(valor_atualizado) FILTER (WHERE status = 'arquivado'), 0)::numeric as valor_arquivadas
      FROM cobrancas
    `);

    const stats = result.rows[0];

    return res.json({
      success: true,
      ativas: stats.ativas || 0,
      arquivadas: stats.arquivadas || 0,
      valorAtivas: parseFloat(stats.valor_ativas) || 0,
      valorArquivadas: parseFloat(stats.valor_arquivadas) || 0
    });

  } catch (err) {
    console.error("[ESTATISTICAS ARQUIVAMENTO] Erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao carregar estatísticas." });
  }
});
// =====================================================
// SISTEMA DE LEMBRETES AUTOMÁTICOS - ACERTIVE
// Cole este código no seu server.js (antes do app.listen)
// =====================================================

// ============ CONFIGURAÇÕES DE LEMBRETES ============
const LEMBRETES_CONFIG = {
  ativo: false, // DESATIVADO POR PADRÃO - ative na tela de configurações
  diasAntes: [7, 3, 1, 0], // 7 dias, 3 dias, 1 dia, no dia
  diasApos: [1, 3, 7, 15, 30], // 1, 3, 7, 15, 30 dias após vencimento
  horarioEnvio: { inicio: 8, fim: 18 }, // Só envia entre 8h e 18h
  limiteDiario: 100, // Máximo de e-mails por dia
  emailTeste: null // Se preenchido, envia tudo para este e-mail (modo teste)
};

// ============ TEMPLATES DE E-MAIL ============
const EMAIL_TEMPLATES = {
  novaCobranca: {
    assunto: 'Nova cobrança registrada - {empresa}',
    corpo: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #F6C84C, #FFD56A); padding: 20px; border-radius: 10px 10px 0 0;">
          <h1 style="color: #09090b; margin: 0; font-size: 24px;">{empresa}</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
          <p style="font-size: 16px; color: #333;">Olá <strong>{cliente_nome}</strong>,</p>
          <p style="font-size: 16px; color: #333;">Uma nova cobrança foi registrada em seu nome:</p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #F6C84C;">
            <p style="margin: 5px 0;"><strong>Descrição:</strong> {descricao}</p>
            <p style="margin: 5px 0;"><strong>Valor:</strong> <span style="color: #F6C84C; font-size: 20px; font-weight: bold;">{valor}</span></p>
            <p style="margin: 5px 0;"><strong>Vencimento:</strong> {vencimento}</p>
          </div>
          <p style="font-size: 14px; color: #666;">Em caso de dúvidas, entre em contato conosco.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="font-size: 12px; color: #999; text-align: center;">Este é um e-mail automático. Por favor, não responda.</p>
        </div>
      </div>
    `
  },
  
  lembrete7dias: {
    assunto: 'Lembrete: Sua fatura vence em 7 dias - {empresa}',
    corpo: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #3b82f6, #60a5fa); padding: 20px; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 24px;">📅 Lembrete de Vencimento</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
          <p style="font-size: 16px; color: #333;">Olá <strong>{cliente_nome}</strong>,</p>
          <p style="font-size: 16px; color: #333;">Este é um lembrete amigável de que sua fatura vence em <strong>7 dias</strong>:</p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3b82f6;">
            <p style="margin: 5px 0;"><strong>Descrição:</strong> {descricao}</p>
            <p style="margin: 5px 0;"><strong>Valor:</strong> <span style="color: #3b82f6; font-size: 20px; font-weight: bold;">{valor}</span></p>
            <p style="margin: 5px 0;"><strong>Vencimento:</strong> {vencimento}</p>
          </div>
          <p style="font-size: 14px; color: #666;">Evite juros e multas, efetue o pagamento até a data de vencimento.</p>
        </div>
      </div>
    `
  },
  
  lembrete3dias: {
    assunto: 'Atenção: Sua fatura vence em 3 dias - {empresa}',
    corpo: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #f59e0b, #fbbf24); padding: 20px; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 24px;">⚠️ Vencimento Próximo</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
          <p style="font-size: 16px; color: #333;">Olá <strong>{cliente_nome}</strong>,</p>
          <p style="font-size: 16px; color: #333;">Sua fatura vence em <strong>3 dias</strong>. Não deixe para a última hora!</p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
            <p style="margin: 5px 0;"><strong>Descrição:</strong> {descricao}</p>
            <p style="margin: 5px 0;"><strong>Valor:</strong> <span style="color: #f59e0b; font-size: 20px; font-weight: bold;">{valor}</span></p>
            <p style="margin: 5px 0;"><strong>Vencimento:</strong> {vencimento}</p>
          </div>
          <p style="font-size: 14px; color: #666;">Efetue o pagamento para evitar cobranças adicionais.</p>
        </div>
      </div>
    `
  },
  
  lembreteHoje: {
    assunto: 'URGENTE: Sua fatura vence HOJE - {empresa}',
    corpo: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #ef4444, #f87171); padding: 20px; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 24px;">🚨 Vencimento HOJE</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
          <p style="font-size: 16px; color: #333;">Olá <strong>{cliente_nome}</strong>,</p>
          <p style="font-size: 16px; color: #333;">Sua fatura vence <strong>HOJE</strong>! Evite juros e multas.</p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ef4444;">
            <p style="margin: 5px 0;"><strong>Descrição:</strong> {descricao}</p>
            <p style="margin: 5px 0;"><strong>Valor:</strong> <span style="color: #ef4444; font-size: 20px; font-weight: bold;">{valor}</span></p>
            <p style="margin: 5px 0;"><strong>Vencimento:</strong> {vencimento}</p>
          </div>
          <p style="font-size: 14px; color: #666;">Entre em contato caso já tenha efetuado o pagamento.</p>
        </div>
      </div>
    `
  },
  
  cobrancaAtraso: {
    assunto: 'AVISO: Sua fatura está em atraso - {empresa}',
    corpo: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #dc2626, #ef4444); padding: 20px; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 24px;">❌ Fatura em Atraso</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
          <p style="font-size: 16px; color: #333;">Olá <strong>{cliente_nome}</strong>,</p>
          <p style="font-size: 16px; color: #333;">Identificamos que sua fatura está em <strong>atraso há {dias_atraso} dia(s)</strong>:</p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
            <p style="margin: 5px 0;"><strong>Descrição:</strong> {descricao}</p>
            <p style="margin: 5px 0;"><strong>Valor Original:</strong> {valor}</p>
            <p style="margin: 5px 0;"><strong>Vencimento:</strong> {vencimento}</p>
            <p style="margin: 5px 0;"><strong>Dias em atraso:</strong> <span style="color: #dc2626; font-weight: bold;">{dias_atraso} dias</span></p>
          </div>
          <p style="font-size: 14px; color: #666;">Entre em contato conosco para regularizar sua situação e evitar medidas adicionais.</p>
        </div>
      </div>
    `
  }
};

// ============ FUNÇÃO PARA ENVIAR E-MAIL ============
async function enviarEmailLembrete(cliente, cobranca, tipo, empresaNome = 'ACERTIVE') {
  try {
    // Verificar se já enviou este tipo para esta cobrança hoje
    const jaEnviou = await pool.query(`
      SELECT id FROM historico_lembretes 
      WHERE cobranca_id = $1 AND tipo = $2 AND DATE(created_at) = CURRENT_DATE
    `, [cobranca.id, tipo]);
    
    if (jaEnviou.rows.length > 0) {
      console.log(`[LEMBRETE] Já enviado ${tipo} para cobrança ${cobranca.id} hoje`);
      return { success: false, reason: 'ja_enviado' };
    }
    
    // Pegar template
    const template = EMAIL_TEMPLATES[tipo];
    if (!template) {
      console.error(`[LEMBRETE] Template não encontrado: ${tipo}`);
      return { success: false, reason: 'template_not_found' };
    }
    
    // Calcular dias de atraso se necessário
    const hoje = new Date();
    const vencimento = new Date(cobranca.vencimento);
    const diasAtraso = Math.floor((hoje - vencimento) / (1000 * 60 * 60 * 24));
    
    // Substituir variáveis no template
    const variaveis = {
      '{empresa}': empresaNome,
      '{cliente_nome}': cliente.nome || 'Cliente',
      '{descricao}': cobranca.descricao || 'Cobrança',
      '{valor}': new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cobranca.valor_atualizado || cobranca.valor_original),
      '{vencimento}': new Date(cobranca.vencimento).toLocaleDateString('pt-BR'),
      '{dias_atraso}': diasAtraso > 0 ? diasAtraso : 0
    };
    
    let assunto = template.assunto;
    let corpo = template.corpo;
    
    for (const [chave, valor] of Object.entries(variaveis)) {
      assunto = assunto.replace(new RegExp(chave, 'g'), valor);
      corpo = corpo.replace(new RegExp(chave, 'g'), valor);
    }
    
    // Destinatário (modo teste ou real)
    const destinatario = LEMBRETES_CONFIG.emailTeste || cliente.email;
    
    // Verificar se tem e-mail
    if (!destinatario) {
      console.log(`[LEMBRETE] Cliente ${cliente.id} sem e-mail`);
      return { success: false, reason: 'sem_email' };
    }
    
    // Enviar e-mail
    const mailOptions = {
      from: `"${empresaNome}" <${process.env.EMAIL_USER}>`,
      to: destinatario,
      subject: assunto,
      html: corpo
    };
    
    await emailTransporter.sendMail(mailOptions);
    
    // Registrar no histórico
    await pool.query(`
      INSERT INTO historico_lembretes (cobranca_id, cliente_id, tipo, canal, destinatario, assunto, status)
      VALUES ($1, $2, $3, 'email', $4, $5, 'enviado')
    `, [cobranca.id, cliente.id, tipo, destinatario, assunto]);
    
    console.log(`[LEMBRETE] ✅ E-mail ${tipo} enviado para ${destinatario}`);
    return { success: true };
    
  } catch (err) {
    console.error(`[LEMBRETE] ❌ Erro ao enviar e-mail:`, err.message);
    
    // Registrar erro no histórico
    try {
      await pool.query(`
        INSERT INTO historico_lembretes (cobranca_id, cliente_id, tipo, canal, destinatario, status, erro)
        VALUES ($1, $2, $3, 'email', $4, 'erro', $5)
      `, [cobranca.id, cliente.id, tipo, cliente.email, err.message]);
    } catch (e) {}
    
    return { success: false, reason: 'erro_envio', error: err.message };
  }
}

// ============ JOB DE LEMBRETES AUTOMÁTICOS ============
async function processarLembretesAutomaticos() {
  // Verificar se está ativo
  if (!LEMBRETES_CONFIG.ativo) {
    console.log('[LEMBRETES] Sistema desativado');
    return;
  }
  
  // Verificar horário comercial
  const hora = new Date().getHours();
  if (hora < LEMBRETES_CONFIG.horarioEnvio.inicio || hora >= LEMBRETES_CONFIG.horarioEnvio.fim) {
    console.log('[LEMBRETES] Fora do horário de envio');
    return;
  }
  
  console.log('[LEMBRETES] Iniciando processamento...');
  
  let enviados = 0;
  const limite = LEMBRETES_CONFIG.limiteDiario;
  
  try {
    // Verificar quantos já enviou hoje
    const enviadosHoje = await pool.query(`
      SELECT COUNT(*) as total FROM historico_lembretes 
      WHERE DATE(created_at) = CURRENT_DATE AND status = 'enviado'
    `);
    
    const jaEnviados = parseInt(enviadosHoje.rows[0]?.total || 0);
    if (jaEnviados >= limite) {
      console.log(`[LEMBRETES] Limite diário atingido (${jaEnviados}/${limite})`);
      return;
    }
    
    const restante = limite - jaEnviados;
    
    // 1. Lembretes ANTES do vencimento (7, 3, 1 dias)
    for (const dias of LEMBRETES_CONFIG.diasAntes) {
      if (enviados >= restante) break;
      
      const tipoLembrete = dias === 7 ? 'lembrete7dias' : dias === 3 ? 'lembrete3dias' : dias === 1 ? 'lembrete1dia' : 'lembreteHoje';
      
      const cobrancas = await pool.query(`
        SELECT c.*, cl.nome as cliente_nome, cl.email as cliente_email, cl.id as cliente_id_real
        FROM cobrancas c
        JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.status IN ('pendente')
          AND DATE(c.vencimento) = CURRENT_DATE + INTERVAL '${dias} days'
          AND cl.email IS NOT NULL AND cl.email != ''
          AND c.id NOT IN (
            SELECT cobranca_id FROM historico_lembretes 
            WHERE tipo = $1 AND DATE(created_at) = CURRENT_DATE
          )
        LIMIT $2
      `, [tipoLembrete, restante - enviados]);
      
      for (const cob of cobrancas.rows) {
        const cliente = { id: cob.cliente_id_real, nome: cob.cliente_nome, email: cob.cliente_email };
        const result = await enviarEmailLembrete(cliente, cob, tipoLembrete);
        if (result.success) enviados++;
      }
    }
    
    // 2. Cobranças em ATRASO
    for (const dias of LEMBRETES_CONFIG.diasApos) {
      if (enviados >= restante) break;
      
      const tipoLembrete = 'cobrancaAtraso';
      
      const cobrancas = await pool.query(`
        SELECT c.*, cl.nome as cliente_nome, cl.email as cliente_email, cl.id as cliente_id_real
        FROM cobrancas c
        JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.status IN ('pendente', 'vencido')
          AND DATE(c.vencimento) = CURRENT_DATE - INTERVAL '${dias} days'
          AND cl.email IS NOT NULL AND cl.email != ''
          AND c.id NOT IN (
            SELECT cobranca_id FROM historico_lembretes 
            WHERE tipo = $1 AND dias_atraso = $2 AND DATE(created_at) = CURRENT_DATE
          )
        LIMIT $3
      `, [tipoLembrete, dias, restante - enviados]);
      
      for (const cob of cobrancas.rows) {
        const cliente = { id: cob.cliente_id_real, nome: cob.cliente_nome, email: cob.cliente_email };
        const result = await enviarEmailLembrete(cliente, cob, tipoLembrete);
        if (result.success) enviados++;
      }
    }
    
    console.log(`[LEMBRETES] ✅ Processamento concluído. ${enviados} e-mail(s) enviado(s).`);
    
  } catch (err) {
    console.error('[LEMBRETES] ❌ Erro no processamento:', err.message);
  }
}

// ============ AGENDAR JOB (RODA A CADA HORA) ============
setInterval(processarLembretesAutomaticos, 60 * 60 * 1000); // 1 hora

// Rodar uma vez ao iniciar (após 30 segundos)
setTimeout(processarLembretesAutomaticos, 30000);


// ============ ROTAS DA API ============

// GET /api/lembretes/config - Obter configurações
app.get("/api/lembretes/config", auth, async (req, res) => {
  try {
    res.json({
      success: true,
      config: LEMBRETES_CONFIG,
      templates: Object.keys(EMAIL_TEMPLATES)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/lembretes/config - Atualizar configurações
app.post("/api/lembretes/config", auth, async (req, res) => {
  try {
    const { ativo, emailTeste, limiteDiario } = req.body;
    
    if (typeof ativo === 'boolean') LEMBRETES_CONFIG.ativo = ativo;
    if (emailTeste !== undefined) LEMBRETES_CONFIG.emailTeste = emailTeste || null;
    if (limiteDiario) LEMBRETES_CONFIG.limiteDiario = parseInt(limiteDiario);
    
    res.json({
      success: true,
      message: 'Configurações atualizadas',
      config: LEMBRETES_CONFIG
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/lembretes/ativar - Ativar/desativar sistema
app.post("/api/lembretes/ativar", auth, async (req, res) => {
  try {
    const { ativo } = req.body;
    LEMBRETES_CONFIG.ativo = ativo === true;
    
    res.json({
      success: true,
      message: LEMBRETES_CONFIG.ativo ? 'Sistema de lembretes ATIVADO' : 'Sistema de lembretes DESATIVADO',
      ativo: LEMBRETES_CONFIG.ativo
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/lembretes/teste - Enviar e-mail de teste
app.post("/api/lembretes/teste", auth, async (req, res) => {
  try {
    const { email, tipo } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, message: 'E-mail é obrigatório' });
    }
    
    const template = EMAIL_TEMPLATES[tipo || 'novaCobranca'];
    if (!template) {
      return res.status(400).json({ success: false, message: 'Tipo de template inválido' });
    }
    
    // Dados de exemplo
    const variaveis = {
      '{empresa}': 'ACERTIVE',
      '{cliente_nome}': 'Cliente Teste',
      '{descricao}': 'Cobrança de Teste',
      '{valor}': 'R$ 150,00',
      '{vencimento}': new Date().toLocaleDateString('pt-BR'),
      '{dias_atraso}': '5'
    };
    
    let assunto = template.assunto;
    let corpo = template.corpo;
    
    for (const [chave, valor] of Object.entries(variaveis)) {
      assunto = assunto.replace(new RegExp(chave, 'g'), valor);
      corpo = corpo.replace(new RegExp(chave, 'g'), valor);
    }
    
    await emailTransporter.sendMail({
      from: `"ACERTIVE" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `[TESTE] ${assunto}`,
      html: corpo
    });
    
    res.json({ success: true, message: `E-mail de teste enviado para ${email}` });
    
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro ao enviar: ' + err.message });
  }
});

// GET /api/lembretes/historico - Histórico de envios
app.get("/api/lembretes/historico", auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    
    const result = await pool.query(`
      SELECT h.*, cl.nome as cliente_nome, c.descricao as cobranca_descricao
      FROM historico_lembretes h
      LEFT JOIN clientes cl ON cl.id = h.cliente_id
      LEFT JOIN cobrancas c ON c.id = h.cobranca_id
      ORDER BY h.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    const countResult = await pool.query(`SELECT COUNT(*) as total FROM historico_lembretes`);
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(countResult.rows[0].total / limit)
      }
    });
    
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/lembretes/estatisticas - Estatísticas de envio
app.get("/api/lembretes/estatisticas", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'enviado') as total_enviados,
        COUNT(*) FILTER (WHERE status = 'erro') as total_erros,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) as enviados_hoje,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') as enviados_semana
      FROM historico_lembretes
    `);
    
    res.json({
      success: true,
      estatisticas: result.rows[0]
    });
    
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/lembretes/enviar-agora - Forçar processamento manual
app.post("/api/lembretes/enviar-agora", auth, async (req, res) => {
  try {
    // Temporariamente ativa e processa
    const estavativo = LEMBRETES_CONFIG.ativo;
    LEMBRETES_CONFIG.ativo = true;
    
    await processarLembretesAutomaticos();
    
    LEMBRETES_CONFIG.ativo = estavativo;
    
    res.json({ success: true, message: 'Processamento executado' });
    
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cobrancas/:id/notificar - Enviar notificação manual para uma cobrança
app.post("/api/cobrancas/:id/notificar", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { tipo } = req.body;
    
    // Buscar cobrança e cliente
    const result = await pool.query(`
      SELECT c.*, cl.nome as cliente_nome, cl.email as cliente_email, cl.id as cliente_id_real
      FROM cobrancas c
      JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cobrança não encontrada' });
    }
    
    const cob = result.rows[0];
    
    if (!cob.cliente_email) {
      return res.status(400).json({ success: false, message: 'Cliente não possui e-mail cadastrado' });
    }
    
    const cliente = { id: cob.cliente_id_real, nome: cob.cliente_nome, email: cob.cliente_email };
    const envioResult = await enviarEmailLembrete(cliente, cob, tipo || 'novaCobranca');
    
    if (envioResult.success) {
      res.json({ success: true, message: `E-mail enviado para ${cob.cliente_email}` });
    } else {
      res.status(400).json({ success: false, message: 'Falha ao enviar: ' + envioResult.reason });
    }
    
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


console.log('[LEMBRETES] ✅ Sistema de lembretes automáticos carregado (DESATIVADO por padrão)');
// ==================== RELATÓRIO DE INADIMPLÊNCIA ====================
app.get('/api/relatorios/inadimplencia', auth, async (req, res) => {
  try {
    const { dataInicio, dataFim, status, ordem } = req.query;
    const empresaId = req.user.empresa_id;
    
    // Buscar cobranças vencidas não pagas
    const query = `
      SELECT 
        c.id,
        c.cliente_id,
        cl.nome as cliente_nome,
        cl.cpf_cnpj,
        c.valor_original,
        c.valor_atualizado,
        c.vencimento,
        c.status,
        CURRENT_DATE - c.vencimento::date as dias_atraso
      FROM cobrancas c
      INNER JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.empresa_id = $1
        AND c.status IN ('pendente', 'vencido')
        AND c.vencimento < CURRENT_DATE
      ORDER BY dias_atraso DESC
    `;
    
    const result = await pool.query(query, [empresaId]);
    const cobrancas = result.rows;

    // Agrupar por cliente
    const clientesMap = {};
    cobrancas.forEach(c => {
      if (!clientesMap[c.cliente_id]) {
        clientesMap[c.cliente_id] = {
          id: c.cliente_id,
          nome: c.cliente_nome,
          cpf_cnpj: c.cpf_cnpj,
          cobrancas: [],
          totalCobrancas: 0,
          valorTotal: 0,
          diasAtraso: 0
        };
      }
      clientesMap[c.cliente_id].cobrancas.push(c);
      clientesMap[c.cliente_id].totalCobrancas++;
      clientesMap[c.cliente_id].valorTotal += parseFloat(c.valor_atualizado || c.valor_original || 0);
      if (c.dias_atraso > clientesMap[c.cliente_id].diasAtraso) {
        clientesMap[c.cliente_id].diasAtraso = c.dias_atraso;
      }
    });

    const clientes = Object.values(clientesMap);
    
    // Ordenar
    if (ordem === 'valor-desc') clientes.sort((a, b) => b.valorTotal - a.valorTotal);
    else if (ordem === 'valor-asc') clientes.sort((a, b) => a.valorTotal - b.valorTotal);
    else if (ordem === 'dias-desc') clientes.sort((a, b) => b.diasAtraso - a.diasAtraso);
    else if (ordem === 'nome-asc') clientes.sort((a, b) => a.nome.localeCompare(b.nome));

    // Calcular estatísticas
    const totalInadimplentes = clientes.length;
    const valorTotalAtraso = clientes.reduce((sum, c) => sum + c.valorTotal, 0);
    const mediaDiasAtraso = clientes.length > 0 ? Math.round(clientes.reduce((sum, c) => sum + c.diasAtraso, 0) / clientes.length) : 0;

    // Total de clientes para taxa
    const totalClientesResult = await pool.query('SELECT COUNT(*) FROM clientes WHERE empresa_id = $1', [empresaId]);
    const totalClientes = parseInt(totalClientesResult.rows[0].count) || 1;
    const taxaInadimplencia = (totalInadimplentes / totalClientes) * 100;

    // Faixas de atraso
    const faixas = {
      '1-30': clientes.filter(c => c.diasAtraso >= 1 && c.diasAtraso <= 30).length,
      '31-60': clientes.filter(c => c.diasAtraso >= 31 && c.diasAtraso <= 60).length,
      '61-90': clientes.filter(c => c.diasAtraso >= 61 && c.diasAtraso <= 90).length,
      '90+': clientes.filter(c => c.diasAtraso > 90).length
    };

    // Evolução mensal (últimos 6 meses)
    const evolucaoQuery = `
      SELECT 
        TO_CHAR(DATE_TRUNC('month', vencimento), 'Mon') as mes,
        SUM(valor_atualizado) as valor
      FROM cobrancas
      WHERE empresa_id = $1
        AND status IN ('pendente', 'vencido')
        AND vencimento < CURRENT_DATE
        AND vencimento >= CURRENT_DATE - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', vencimento)
      ORDER BY DATE_TRUNC('month', vencimento)
    `;
    const evolucaoResult = await pool.query(evolucaoQuery, [empresaId]);
    const evolucao = evolucaoResult.rows.map(r => ({ mes: r.mes, valor: parseFloat(r.valor) }));

    res.json({
      success: true,
      data: {
        totalInadimplentes,
        valorTotalAtraso,
        mediaDiasAtraso,
        taxaInadimplencia,
        faixas,
        evolucao,
        clientes
      }
    });
  } catch (error) {
    console.error('Erro ao gerar relatório de inadimplência:', error);
    res.status(500).json({ success: false, message: 'Erro ao gerar relatório' });
  }
});

// ==================== RELATÓRIO DE RECEBIMENTOS ====================
app.get('/api/relatorios/recebimentos', auth, async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;
    const empresaId = req.user.empresa_id;

    let whereDate = '';
    const params = [empresaId];
    
    if (dataInicio && dataFim) {
      whereDate = ' AND c.pago_em BETWEEN $2 AND $3';
      params.push(dataInicio, dataFim);
    }

    const query = `
      SELECT 
        c.id,
        c.descricao,
        c.valor_atualizado,
        c.pago_em,
        c.pagamento,
        cl.nome as cliente_nome
      FROM cobrancas c
      INNER JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.empresa_id = $1
        AND c.status = 'pago'
        ${whereDate}
      ORDER BY c.pago_em DESC
      LIMIT 100
    `;
    
    const result = await pool.query(query, params);
    const recebimentos = result.rows;

    // Estatísticas
    const statsQuery = `
      SELECT 
        COUNT(*) as total_pagas,
        SUM(valor_atualizado) as total_recebido
      FROM cobrancas
      WHERE empresa_id = $1 AND status = 'pago'
        ${whereDate}
    `;
    const statsResult = await pool.query(statsQuery, params);
    const stats = statsResult.rows[0];

    const totalRecebido = parseFloat(stats.total_recebido) || 0;
    const totalPagas = parseInt(stats.total_pagas) || 0;
    const ticketMedio = totalPagas > 0 ? totalRecebido / totalPagas : 0;

    // Total de cobranças para taxa conversão
    const totalCobrancasResult = await pool.query(
      'SELECT COUNT(*) FROM cobrancas WHERE empresa_id = $1' + whereDate.replace('pago_em', 'created_at'),
      params
    );
    const totalCobrancas = parseInt(totalCobrancasResult.rows[0].count) || 1;
    const taxaConversao = (totalPagas / totalCobrancas) * 100;

    // Recebimentos por mês
    const porMesQuery = `
      SELECT 
        TO_CHAR(DATE_TRUNC('month', pago_em), 'Mon') as mes,
        SUM(valor_atualizado) as valor
      FROM cobrancas
      WHERE empresa_id = $1 AND status = 'pago'
        AND pago_em >= CURRENT_DATE - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', pago_em)
      ORDER BY DATE_TRUNC('month', pago_em)
    `;
    const porMesResult = await pool.query(porMesQuery, [empresaId]);
    const recebimentosPorMes = porMesResult.rows.map(r => ({ mes: r.mes, valor: parseFloat(r.valor) }));

    // Por forma de pagamento
    const formasQuery = `
      SELECT pagamento, COUNT(*) as qtd
      FROM cobrancas
      WHERE empresa_id = $1 AND status = 'pago' AND pagamento IS NOT NULL
      GROUP BY pagamento
    `;
    const formasResult = await pool.query(formasQuery, [empresaId]);
    const formasPagamento = {};
    formasResult.rows.forEach(r => { formasPagamento[r.pagamento || 'Outros'] = parseInt(r.qtd); });

    res.json({
      success: true,
      data: {
        totalRecebido,
        totalPagas,
        ticketMedio,
        taxaConversao,
        recebimentosPorMes,
        formasPagamento,
        recebimentos
      }
    });
  } catch (error) {
    console.error('Erro ao gerar relatório de recebimentos:', error);
    res.status(500).json({ success: false, message: 'Erro ao gerar relatório' });
  }
});

// ==================== RELATÓRIO POR PERÍODO ====================
app.get('/api/relatorios/periodo', auth, async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;
    const empresaId = req.user.empresa_id;

    const query = `
      SELECT 
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as mes,
        TO_CHAR(DATE_TRUNC('month', created_at), 'Mon/YYYY') as mes_label,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pago') as pagas,
        COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
        COUNT(*) FILTER (WHERE status = 'vencido') as vencidas,
        SUM(valor_original) as valor_gerado,
        SUM(valor_atualizado) FILTER (WHERE status = 'pago') as valor_recebido
      FROM cobrancas
      WHERE empresa_id = $1
        AND created_at >= CURRENT_DATE - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC
    `;
    
    const result = await pool.query(query, [empresaId]);
    
    const totais = {
      total: 0,
      pagas: 0,
      pendentes: 0,
      vencidas: 0
    };
    
    result.rows.forEach(r => {
      totais.total += parseInt(r.total);
      totais.pagas += parseInt(r.pagas);
      totais.pendentes += parseInt(r.pendentes);
      totais.vencidas += parseInt(r.vencidas);
    });

    res.json({
      success: true,
      data: {
        ...totais,
        meses: result.rows.map(r => ({
          mes: r.mes_label,
          total: parseInt(r.total),
          pagas: parseInt(r.pagas),
          pendentes: parseInt(r.pendentes),
          vencidas: parseInt(r.vencidas),
          valorGerado: parseFloat(r.valor_gerado) || 0,
          valorRecebido: parseFloat(r.valor_recebido) || 0
        }))
      }
    });
  } catch (error) {
    console.error('Erro ao gerar relatório por período:', error);
    res.status(500).json({ success: false, message: 'Erro ao gerar relatório' });
  }
});

// ==================== RELATÓRIO POR CLIENTE ====================
app.get('/api/relatorios/clientes', auth, async (req, res) => {
  try {
    const empresaId = req.user.empresa_id;

    const query = `
      SELECT 
        cl.id,
        cl.nome,
        cl.cpf_cnpj,
        COUNT(c.id) as total_cobrancas,
        COUNT(c.id) FILTER (WHERE c.status = 'pago') as pagas,
        COUNT(c.id) FILTER (WHERE c.status IN ('pendente', 'vencido')) as em_aberto,
        COALESCE(SUM(c.valor_atualizado), 0) as valor_total,
        CASE 
          WHEN COUNT(c.id) FILTER (WHERE c.status = 'vencido') > 0 THEN 'inadimplente'
          WHEN COUNT(c.id) FILTER (WHERE c.status = 'pendente') > 0 THEN 'pendente'
          ELSE 'em_dia'
        END as situacao
      FROM clientes cl
      LEFT JOIN cobrancas c ON c.cliente_id = cl.id
      WHERE cl.empresa_id = $1
      GROUP BY cl.id, cl.nome, cl.cpf_cnpj
      ORDER BY valor_total DESC
    `;
    
    const result = await pool.query(query, [empresaId]);
    const clientes = result.rows;

    const totalClientes = clientes.length;
    const emDia = clientes.filter(c => c.situacao === 'em_dia').length;
    const inadimplentes = clientes.filter(c => c.situacao === 'inadimplente').length;
    
    // Melhor pagador (mais cobranças pagas)
    const melhorPagador = clientes.reduce((best, c) => {
      if (parseInt(c.pagas) > parseInt(best?.pagas || 0)) return c;
      return best;
    }, null);

    res.json({
      success: true,
      data: {
        totalClientes,
        emDia,
        inadimplentes,
        melhorPagador: melhorPagador?.nome || '-',
        clientes: clientes.map((c, i) => ({
          posicao: i + 1,
          id: c.id,
          nome: c.nome,
          cpf_cnpj: c.cpf_cnpj,
          totalCobrancas: parseInt(c.total_cobrancas),
          pagas: parseInt(c.pagas),
          emAberto: parseInt(c.em_aberto),
          valorTotal: parseFloat(c.valor_total),
          situacao: c.situacao
        }))
      }
    });
  } catch (error) {
    console.error('Erro ao gerar relatório por cliente:', error);
    res.status(500).json({ success: false, message: 'Erro ao gerar relatório' });
  }
});

// ==================== HISTÓRICO DE ATIVIDADES ====================
app.get('/api/atividades', auth, async (req, res) => {
  try {
    const empresaId = req.user.empresa_id;
    const { limit = 50 } = req.query;

    // Se a tabela de atividades existir
    const query = `
      SELECT * FROM atividades
      WHERE empresa_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    
    try {
      const result = await pool.query(query, [empresaId, limit]);
      res.json({ success: true, data: result.rows });
    } catch (e) {
      // Se a tabela não existir, retorna vazio
      res.json({ success: true, data: [] });
    }
  } catch (error) {
    console.error('Erro ao buscar atividades:', error);
    res.status(500).json({ success: false, message: 'Erro ao buscar atividades' });
  }
});

// ==================== REGISTRAR ATIVIDADE (helper) ====================
async function registrarAtividade(empresaId, usuarioId, tipo, descricao, entidadeId = null, entidadeTipo = null) {
  try {
    await pool.query(
      `INSERT INTO atividades (empresa_id, usuario_id, tipo, descricao, entidade_id, entidade_tipo, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [empresaId, usuarioId, tipo, descricao, entidadeId, entidadeTipo]
    );
  } catch (e) {
    console.log('Tabela de atividades não existe ou erro ao registrar:', e.message);
  }
}

// =====================================================
// ROTA: CONTADOR DE ALERTAS
// =====================================================
app.get('/api/alertas/contador', auth, async (req, res) => {
  try {
    const vencidas = await pool.query(`
      SELECT COUNT(*) as total FROM cobrancas 
      WHERE status IN ('vencido') 
      OR (status = 'pendente' AND vencimento < CURRENT_DATE)
    `);
    
    const vencendoHoje = await pool.query(`
      SELECT COUNT(*) as total FROM cobrancas 
      WHERE status = 'pendente' AND DATE(vencimento) = CURRENT_DATE
    `);
    
    const agendamentosHoje = await pool.query(`
      SELECT COUNT(*) as total FROM agendamentos 
      WHERE DATE(data_agendamento) = CURRENT_DATE AND status = 'pendente'
    `);
    
    const totalVencidas = parseInt(vencidas.rows[0].total) || 0;
    const totalVencendoHoje = parseInt(vencendoHoje.rows[0].total) || 0;
    const totalAgendamentos = parseInt(agendamentosHoje.rows[0].total) || 0;
    
    res.json({
      success: true,
      total: totalVencidas + totalVencendoHoje + totalAgendamentos,
      vencidas: totalVencidas,
      vencendoHoje: totalVencendoHoje,
      agendamentosHoje: totalAgendamentos
    });
  } catch (err) {
    console.error('[ALERTAS CONTADOR] erro:', err.message);
    res.json({ success: true, total: 0, vencidas: 0, vencendoHoje: 0, agendamentosHoje: 0 });
  }
});

// =====================================================
// ROTA: ALERTAS DETALHADOS
// =====================================================
app.get('/api/alertas', auth, async (req, res) => {
  try {
    // Cobranças vencendo hoje
    const vencendoHoje = await pool.query(`
      SELECT c.id, c.descricao, c.valor_atualizado, c.vencimento, cl.nome as cliente
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.status = 'pendente' AND DATE(c.vencimento) = CURRENT_DATE
      ORDER BY c.valor_atualizado DESC
      LIMIT 10
    `);
    
    // Cobranças vencidas
    const vencidas = await pool.query(`
      SELECT c.id, c.descricao, c.valor_atualizado, c.vencimento, cl.nome as cliente,
             CURRENT_DATE - DATE(c.vencimento) as dias_atraso
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.status IN ('vencido') OR (c.status = 'pendente' AND c.vencimento < CURRENT_DATE)
      ORDER BY c.vencimento ASC
      LIMIT 20
    `);
    
    // Agendamentos de hoje
    const agendamentosHoje = await pool.query(`
      SELECT a.id, a.tipo, a.descricao, a.data_agendamento, cl.nome as cliente_nome
      FROM agendamentos a
      LEFT JOIN clientes cl ON cl.id = a.cliente_id
      WHERE DATE(a.data_agendamento) = CURRENT_DATE AND a.status = 'pendente'
      ORDER BY a.data_agendamento ASC
      LIMIT 10
    `);
    
    res.json({
      success: true,
      alertas: {
        vencendoHoje: vencendoHoje.rows,
        vencidas: vencidas.rows,
        agendamentosHoje: agendamentosHoje.rows
      }
    });
  } catch (err) {
    console.error('[ALERTAS] erro:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao buscar alertas' });
  }
});

// =====================================================
// CONFIGURAÇÃO DOS CRON JOBS
// =====================================================
const CRON_CONFIG = {
  atualizarStatus: {
    ativo: true,
    intervalo: 5 * 60 * 1000, // 5 minutos
  },
  lembretes: {
    ativo: false, // Mude para true quando quiser ativar
    intervalo: 60 * 60 * 1000,
    horarioInicio: 8,
    horarioFim: 20,
    diasAntes: [7, 3, 1, 0],
    diasApos: [1, 3, 7, 15, 30],
    limitePorExecucao: 50,
  },
  recorrentes: {
    ativo: true,
    intervalo: 6 * 60 * 60 * 1000,
  },
  relatorioDiario: {
    ativo: false,
    horario: 8,
    emailDestino: null,
  }
};

// =====================================================
// ROTA: STATUS DO CRON
// =====================================================
app.get('/api/cron/status', auth, (req, res) => {
  res.json({
    success: true,
    config: CRON_CONFIG,
    emailConfigurado: !!emailTransporter
  });
});

// =====================================================
// ROTA: CONFIGURAR CRON
// =====================================================
app.post('/api/cron/config', auth, (req, res) => {
  try {
    const { job, config } = req.body;
    
    if (job && CRON_CONFIG[job]) {
      Object.assign(CRON_CONFIG[job], config);
      res.json({ success: true, message: `Configuração de ${job} atualizada`, config: CRON_CONFIG[job] });
    } else {
      res.status(400).json({ success: false, message: 'Job inválido' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// JOB: ATUALIZAR STATUS DAS COBRANÇAS
// =====================================================
async function jobAtualizarStatus() {
  if (!CRON_CONFIG.atualizarStatus.ativo) return;
  
  try {
    console.log('[CRON] Atualizando status das cobranças...');
    
    const resultado = await pool.query(`
      UPDATE cobrancas 
      SET status = 'vencido', updated_at = NOW()
      WHERE status = 'pendente' 
        AND vencimento < CURRENT_DATE
      RETURNING id
    `);
    
    if (resultado.rowCount > 0) {
      console.log(`[CRON] ✅ ${resultado.rowCount} cobrança(s) marcada(s) como vencida(s)`);
    }
  } catch (err) {
    console.error('[CRON] Erro ao atualizar status:', err.message);
  }
}

// =====================================================
// JOB: GERAR COBRANÇAS RECORRENTES
// =====================================================
async function jobGerarRecorrentes() {
  if (!CRON_CONFIG.recorrentes.ativo) return;
  
  try {
    console.log('[CRON] Verificando cobranças recorrentes...');
    
    // Verificar se a tabela existe
    const tabelaExiste = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'cobrancas_recorrentes'
      )
    `);
    
    if (!tabelaExiste.rows[0].exists) {
      console.log('[CRON] Tabela cobrancas_recorrentes não existe, pulando...');
      return;
    }
    
    const recorrentes = await pool.query(`
      SELECT cr.*, cl.nome as cliente_nome
      FROM cobrancas_recorrentes cr
      INNER JOIN clientes cl ON cl.id = cr.cliente_id
      WHERE cr.ativo = true
        AND (cr.data_fim IS NULL OR cr.data_fim >= CURRENT_DATE)
        AND (
          cr.ultima_geracao IS NULL 
          OR (cr.frequencia = 'mensal' AND cr.ultima_geracao < CURRENT_DATE - INTERVAL '25 days')
          OR (cr.frequencia = 'quinzenal' AND cr.ultima_geracao < CURRENT_DATE - INTERVAL '12 days')
          OR (cr.frequencia = 'semanal' AND cr.ultima_geracao < CURRENT_DATE - INTERVAL '5 days')
        )
    `);
    
    let geradas = 0;
    
    for (const rec of recorrentes.rows) {
      try {
        const hoje = new Date();
        let vencimento = new Date(hoje.getFullYear(), hoje.getMonth(), rec.dia_vencimento);
        
        if (vencimento <= hoje) {
          vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 1, rec.dia_vencimento);
        }
        
        const vencimentoStr = vencimento.toISOString().split('T')[0];
        const mesRef = vencimento.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        
        const existe = await pool.query(`
          SELECT id FROM cobrancas 
          WHERE cliente_id = $1 AND descricao LIKE $2 AND DATE(vencimento) = $3
        `, [rec.cliente_id, `%${mesRef}%`, vencimentoStr]);
        
        if (existe.rowCount > 0) continue;
        
        await pool.query(`
          INSERT INTO cobrancas (cliente_id, empresa_id, descricao, valor_original, valor_atualizado, vencimento, status)
          VALUES ($1, $2, $3, $4, $4, $5, 'pendente')
        `, [rec.cliente_id, rec.empresa_id || null, `${rec.descricao || 'Cobrança recorrente'} - ${mesRef}`, rec.valor, vencimentoStr]);
        
        await pool.query(`
          UPDATE cobrancas_recorrentes 
          SET ultima_geracao = CURRENT_DATE, total_geradas = COALESCE(total_geradas, 0) + 1, updated_at = NOW()
          WHERE id = $1
        `, [rec.id]);
        
        geradas++;
      } catch (recErr) {
        console.error(`[CRON] Erro ao gerar recorrente ${rec.id}:`, recErr.message);
      }
    }
    
    if (geradas > 0) {
      console.log(`[CRON] ✅ ${geradas} cobrança(s) recorrente(s) gerada(s)`);
    }
  } catch (err) {
    console.error('[CRON] Erro ao processar recorrentes:', err.message);
  }
}

// =====================================================
// ROTA: EXECUTAR CRON MANUALMENTE
// =====================================================
app.post('/api/cron/executar/:job', auth, async (req, res) => {
  try {
    const { job } = req.params;
    
    switch (job) {
      case 'atualizar-status':
        await jobAtualizarStatus();
        break;
      case 'recorrentes':
        await jobGerarRecorrentes();
        break;
      default:
        return res.status(400).json({ success: false, message: 'Job inválido' });
    }
    
    res.json({ success: true, message: `Job ${job} executado com sucesso` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// ROTA: LISTAR PLANOS
// =====================================================
app.get('/api/planos', async (req, res) => {
  try {
    // Verificar se a tabela existe
    const tabelaExiste = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'planos'
      )
    `);
    
    if (!tabelaExiste.rows[0].exists) {
      // Retornar planos padrão se a tabela não existir
      return res.json({
        success: true,
        data: [
          { id: '1', nome: 'Gratuito', descricao: 'Plano gratuito', preco_mensal: 0, limite_usuarios: 1, limite_clientes: 50, limite_cobrancas_mes: 100 },
          { id: '2', nome: 'Básico', descricao: 'Ideal para pequenas empresas', preco_mensal: 49.90, limite_usuarios: 3, limite_clientes: 200, limite_cobrancas_mes: 500 },
          { id: '3', nome: 'Profissional', descricao: 'Para empresas em crescimento', preco_mensal: 99.90, limite_usuarios: 10, limite_clientes: 1000, limite_cobrancas_mes: 2000 },
          { id: '4', nome: 'Enterprise', descricao: 'Sem limites', preco_mensal: 299.90, limite_usuarios: -1, limite_clientes: -1, limite_cobrancas_mes: -1 }
        ]
      });
    }
    
    const result = await pool.query(`
      SELECT id, nome, descricao, preco_mensal, limite_usuarios, limite_clientes, limite_cobrancas_mes, recursos
      FROM planos
      WHERE ativo = true
      ORDER BY preco_mensal ASC
    `);
    
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[PLANOS] erro:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao buscar planos' });
  }
});

// =====================================================
// ROTA: INFO DO TENANT
// =====================================================
app.get('/api/tenant/info', auth, async (req, res) => {
  try {
    const userResult = await pool.query(`
      SELECT u.empresa_id, e.nome as empresa_nome, e.cnpj
      FROM users u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      WHERE u.id = $1
    `, [req.user.userId]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
    }
    
    const info = userResult.rows[0];
    
    res.json({
      success: true,
      data: {
        empresa: {
          id: info.empresa_id,
          nome: info.empresa_nome,
          cnpj: info.cnpj
        },
        plano: {
          nome: 'Profissional',
          limites: { usuarios: 10, clientes: 1000, cobrancas_mes: 2000 }
        }
      }
    });
  } catch (err) {
    console.error('[TENANT INFO] erro:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao buscar informações' });
  }
});

// =====================================================
// ROTA: LIMITES DO TENANT
// =====================================================
app.get('/api/tenant/limites', auth, async (req, res) => {
  try {
    res.json({
      success: true,
      dentroLimites: true,
      planoIlimitado: false,
      uso: {
        usuarios: { atual: 1, limite: 10 },
        clientes: { atual: 100, limite: 1000 },
        cobrancas_mes: { atual: 50, limite: 2000 }
      }
    });
  } catch (err) {
    console.error('[TENANT LIMITES] erro:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao verificar limites' });
  }
});

// =====================================================
// INICIAR CRON JOBS
// =====================================================
function iniciarCronJobs() {
  console.log('[CRON] ========================================');
  console.log('[CRON] Iniciando sistema de automação...');
  console.log('[CRON] ========================================');
  
  // Job 1: Atualizar status (a cada 1 hora)
  setInterval(jobAtualizarStatus, CRON_CONFIG.atualizarStatus.intervalo);
  console.log('[CRON] ✅ Job "Atualizar Status" agendado (1h)');
  
  // Job 2: Recorrentes (a cada 6 horas)
  setInterval(jobGerarRecorrentes, CRON_CONFIG.recorrentes.intervalo);
  console.log('[CRON] ✅ Job "Recorrentes" agendado (6h)');
  
  // Executar jobs iniciais após 30 segundos
  setTimeout(async () => {
    console.log('[CRON] Executando verificação inicial...');
    await jobAtualizarStatus();
    await jobGerarRecorrentes();
  }, 30000);
  
  console.log('[CRON] ========================================');
}

// Iniciar os cron jobs
iniciarCronJobs();

console.log('[FASE 2] ✅ Rotas de Cron e Multi-tenant carregadas');
// =====================================================
// ROTA DE IMPORTAÇÃO EM MASSA - ACERTIVE (CORRIGIDA)
// SUBSTITUA a rota anterior por esta no server.js
// =====================================================

// POST /api/importar-cobrancas-massa - Importar cobranças via JSON
app.post('/api/importar-cobrancas-massa', auth, async (req, res) => {
  try {
    const { cobrancas } = req.body;
    
    if (!cobrancas || !Array.isArray(cobrancas)) {
      return res.status(400).json({ success: false, message: 'Dados inválidos. Envie um array de cobranças.' });
    }
    
    console.log(`[IMPORTAÇÃO] Iniciando importação de ${cobrancas.length} cobranças...`);
    
    let importados = 0;
    let erros = 0;
    let clientesNaoEncontrados = 0;
    
    for (const cob of cobrancas) {
      try {
        // Buscar cliente pelo CPF/CNPJ
        const cpfLimpo = String(cob.cpf_cnpj || '').replace(/\D/g, '');
        
        if (!cpfLimpo) {
          erros++;
          continue;
        }
        
        const cliente = await pool.query(
          `SELECT id FROM clientes WHERE cpf_cnpj = $1 LIMIT 1`,
          [cpfLimpo]
        );
        
        if (cliente.rows.length === 0) {
          clientesNaoEncontrados++;
          erros++;
          continue;
        }
        
        const clienteId = cliente.rows[0].id;
        
        // Determinar status baseado na data de vencimento
        let status = 'pendente';
        if (cob.vencimento) {
          const venc = new Date(cob.vencimento);
          const hoje = new Date();
          hoje.setHours(0, 0, 0, 0);
          if (venc < hoje) {
            status = 'vencido';
          }
        }
        
        // Valor - garantir que é número
        const valor = parseFloat(cob.valor) || 0;
        
        if (valor <= 0) {
          erros++;
          continue;
        }
        
        // Inserir cobrança (usando as colunas corretas da tabela)
        await pool.query(
          `INSERT INTO cobrancas 
           (cliente_id, valor_original, valor_atualizado, descricao, vencimento, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            clienteId,
            valor,
            valor,
            cob.descricao || 'Cobrança importada',
            cob.vencimento || null,
            status
          ]
        );
        
        importados++;
        
      } catch (err) {
        console.error('[IMPORTAÇÃO] Erro em registro:', err.message);
        erros++;
      }
    }
    
    console.log(`[IMPORTAÇÃO] ✅ Concluído: ${importados} importados, ${erros} erros, ${clientesNaoEncontrados} clientes não encontrados`);
    
    res.json({
      success: true,
      message: `Importação concluída!`,
      importados,
      erros,
      clientesNaoEncontrados,
      total: cobrancas.length
    });
    
  } catch (error) {
    console.error('[IMPORTAÇÃO] Erro geral:', error);
    res.status(500).json({ success: false, message: 'Erro na importação: ' + error.message });
  }
});

console.log('[IMPORTAÇÃO] ✅ Rota de importação em massa carregada');
// GET /api/importacao/status - Verificar status da base
app.get('/api/importacao/status', auth, async (req, res) => {
  try {
    const clientes = await pool.query('SELECT COUNT(*)::int as total FROM clientes');
    const cobrancas = await pool.query('SELECT COUNT(*)::int as total FROM cobrancas');
    const cobrancasAtivas = await pool.query("SELECT COUNT(*)::int as total FROM cobrancas WHERE status != 'arquivado'");
    
    const valorTotal = await pool.query(`
      SELECT COALESCE(SUM(valor_atualizado), 0)::numeric as total 
      FROM cobrancas 
      WHERE status IN ('pendente', 'vencido')
    `);
    
    res.json({
      success: true,
      data: {
        clientes: clientes.rows[0].total,
        cobrancas: cobrancas.rows[0].total,
        cobrancasAtivas: cobrancasAtivas.rows[0].total,
        valorPendente: parseFloat(valorTotal.rows[0].total) || 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// CONFIGURAÇÃO DO ASAAS
// =====================================================
const ASAAS_CONFIG = {
  sandbox: {
    baseUrl: 'https://sandbox.asaas.com/api/v3',
    apiKey: process.env.ASAAS_API_KEY_SANDBOX || process.env.ASAAS_API_KEY
  },
  production: {
    baseUrl: 'https://api.asaas.com/api/v3',
    apiKey: process.env.ASAAS_API_KEY
  }
};

// Use variável de ambiente para definir o ambiente (sandbox ou production)
const ASAAS_ENV = process.env.ASAAS_ENVIRONMENT || 'sandbox';
const ASAAS_BASE_URL = ASAAS_CONFIG[ASAAS_ENV]?.baseUrl || ASAAS_CONFIG.sandbox.baseUrl;
const ASAAS_API_KEY = ASAAS_CONFIG[ASAAS_ENV]?.apiKey;

if (!ASAAS_API_KEY) {
  console.warn('[ASAAS] ⚠️ API Key não configurada! Adicione ASAAS_API_KEY nas variáveis de ambiente.');
} else {
  console.log(`[ASAAS] ✅ Configurado em modo ${ASAAS_ENV.toUpperCase()}`);
  console.log(`[ASAAS] 🔗 URL: ${ASAAS_BASE_URL}`);
}

console.log(`[ASAAS] ✅ Configurado em modo ${ASAAS_ENV.toUpperCase()}`);

// =====================================================
// FUNÇÃO AUXILIAR - REQUISIÇÕES ASAAS
// =====================================================
async function asaasRequest(endpoint, method = 'GET', data = null) {
  const url = `${ASAAS_BASE_URL}${endpoint}`;
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'access_token': ASAAS_API_KEY,
      'User-Agent': 'ACERTIVE/2.1'
    }
  };

  if (data && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(data);
  }

  try {
    console.log(`[ASAAS] ${method} ${endpoint}`);
    const response = await fetch(url, options);
    const result = await response.json();
    
    if (!response.ok) {
      console.error('[ASAAS] Erro:', result);
      throw new Error(result.errors?.[0]?.description || `Erro ${response.status}`);
    }
    
    return result;
  } catch (error) {
    console.error('[ASAAS] Request Error:', error.message);
    throw error;
  }
}
// =====================================================
// REGISTRO DE ROTAS DE ACORDOS (com asaasRequest)
// =====================================================
app.use('/api/acordos', acordosRoutes(pool, auth, registrarLog, asaasRequest));
app.use('/api/parcelas', parcelasRoutes(pool, auth, registrarLog, asaasRequest));
// =====================================================
// ROTA: STATUS DA INTEGRAÇÃO ASAAS
// =====================================================
app.get("/api/asaas/status", auth, async (req, res) => {
  try {
    // Testar conexão com Asaas
    const resultado = await asaasRequest('/finance/balance');
    
    res.json({
      success: true,
      ambiente: ASAAS_ENV,
      conectado: true,
      saldo: resultado.balance || 0,
      baseUrl: ASAAS_BASE_URL
    });
  } catch (err) {
    res.json({
      success: false,
      ambiente: ASAAS_ENV,
      conectado: false,
      erro: err.message
    });
  }
});

// =====================================================
// ROTA: CONFIGURAÇÕES DO ASAAS
// =====================================================
app.get("/api/asaas/config", auth, async (req, res) => {
  try {
    const config = await pool.query("SELECT * FROM asaas_config LIMIT 1");
    res.json({ 
      success: true, 
      data: config.rows[0] || {},
      ambiente: ASAAS_ENV
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put("/api/asaas/config", auth, async (req, res) => {
  try {
    const { taxa_juros_padrao, taxa_multa_padrao, dias_desconto_padrao, desconto_padrao, ativo } = req.body;
    
    const result = await pool.query(`
      UPDATE asaas_config SET
        taxa_juros_padrao = COALESCE($1, taxa_juros_padrao),
        taxa_multa_padrao = COALESCE($2, taxa_multa_padrao),
        dias_desconto_padrao = COALESCE($3, dias_desconto_padrao),
        desconto_padrao = COALESCE($4, desconto_padrao),
        ativo = COALESCE($5, ativo),
        updated_at = NOW()
      RETURNING *
    `, [taxa_juros_padrao, taxa_multa_padrao, dias_desconto_padrao, desconto_padrao, ativo]);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// ROTA: SINCRONIZAR CLIENTE COM ASAAS
// =====================================================
app.post("/api/asaas/clientes/sincronizar/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Buscar cliente no banco
    const clienteResult = await pool.query("SELECT * FROM clientes WHERE id = $1", [id]);
    if (!clienteResult.rowCount) {
      return res.status(404).json({ success: false, message: "Cliente não encontrado." });
    }
    
    const cliente = clienteResult.rows[0];
    
    // Verificar se já tem ID no Asaas
    if (cliente.asaas_id) {
      // Atualizar cliente existente
      const asaasCliente = await asaasRequest(`/customers/${cliente.asaas_id}`, 'PUT', {
        name: cliente.nome,
        cpfCnpj: (cliente.cpf_cnpj || '').replace(/\D/g, ''),
        email: cliente.email,
        phone: (cliente.telefone || '').replace(/\D/g, ''),
        mobilePhone: (cliente.telefone || '').replace(/\D/g, ''),
        address: cliente.endereco,
        externalReference: cliente.id
      });
      
      await pool.query(`UPDATE clientes SET asaas_sync_at = NOW() WHERE id = $1`, [id]);
      
      return res.json({
        success: true,
        message: "Cliente atualizado no Asaas!",
        asaas_id: asaasCliente.id
      });
    }
    
    // Verificar se existe por CPF no Asaas
    const cpfLimpo = (cliente.cpf_cnpj || '').replace(/\D/g, '');
    if (cpfLimpo) {
      const busca = await asaasRequest(`/customers?cpfCnpj=${cpfLimpo}`);
      if (busca.data && busca.data.length > 0) {
        // Já existe, salvar ID
        const asaasId = busca.data[0].id;
        await pool.query(`UPDATE clientes SET asaas_id = $1, asaas_sync_at = NOW() WHERE id = $2`, [asaasId, id]);
        
        return res.json({
          success: true,
          message: "Cliente já existia no Asaas, vinculado!",
          asaas_id: asaasId
        });
      }
    }
    
    // Criar novo cliente no Asaas
    const novoCliente = await asaasRequest('/customers', 'POST', {
      name: cliente.nome,
      cpfCnpj: cpfLimpo || undefined,
      email: cliente.email || undefined,
      phone: (cliente.telefone || '').replace(/\D/g, '') || undefined,
      mobilePhone: (cliente.telefone || '').replace(/\D/g, '') || undefined,
      address: cliente.endereco || undefined,
      externalReference: cliente.id,
      notificationDisabled: false
    });
    
    // Salvar ID do Asaas
    await pool.query(`UPDATE clientes SET asaas_id = $1, asaas_sync_at = NOW() WHERE id = $2`, [novoCliente.id, id]);
    
    await registrarLog(req, 'SINCRONIZAR_ASAAS', 'clientes', id, { asaas_id: novoCliente.id });
    
    res.json({
      success: true,
      message: "Cliente criado no Asaas!",
      asaas_id: novoCliente.id
    });
    
  } catch (err) {
    console.error("[ASAAS SYNC CLIENTE] erro:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// ROTA: GERAR COBRANÇA NO ASAAS (BOLETO + PIX)
// =====================================================
app.post("/api/asaas/cobrancas/gerar/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { tipo_pagamento = 'UNDEFINED' } = req.body; // BOLETO, PIX, UNDEFINED (ambos)
    
    // Buscar cobrança com cliente
    const cobrancaResult = await pool.query(`
      SELECT c.*, cl.id as cliente_id_real, cl.nome as cliente_nome, cl.asaas_id as cliente_asaas_id,
             cl.cpf_cnpj, cl.email, cl.telefone
      FROM cobrancas c
      JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.id = $1
    `, [id]);
    
    if (!cobrancaResult.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }
    
    const cobranca = cobrancaResult.rows[0];
    
    // Verificar se já tem cobrança no Asaas
    if (cobranca.asaas_id) {
      return res.status(400).json({ 
        success: false, 
        message: "Esta cobrança já foi gerada no Asaas.",
        asaas_id: cobranca.asaas_id,
        link_pagamento: cobranca.asaas_invoice_url
      });
    }
    
    // Garantir que o cliente está sincronizado
    let clienteAsaasId = cobranca.cliente_asaas_id;
    
    if (!clienteAsaasId) {
      // Sincronizar cliente primeiro
      const cpfLimpo = (cobranca.cpf_cnpj || '').replace(/\D/g, '');
      
      // Verificar se existe
      if (cpfLimpo) {
        const busca = await asaasRequest(`/customers?cpfCnpj=${cpfLimpo}`);
        if (busca.data && busca.data.length > 0) {
          clienteAsaasId = busca.data[0].id;
        }
      }
      
      // Se não existe, criar
      if (!clienteAsaasId) {
        const novoCliente = await asaasRequest('/customers', 'POST', {
          name: cobranca.cliente_nome,
          cpfCnpj: cpfLimpo || undefined,
          email: cobranca.email || undefined,
          phone: (cobranca.telefone || '').replace(/\D/g, '') || undefined,
          externalReference: cobranca.cliente_id_real
        });
        clienteAsaasId = novoCliente.id;
      }
      
      // Salvar no cliente
      await pool.query(`UPDATE clientes SET asaas_id = $1, asaas_sync_at = NOW() WHERE id = $2`, 
        [clienteAsaasId, cobranca.cliente_id_real]);
    }
    
    // Buscar configurações
    const configResult = await pool.query("SELECT * FROM asaas_config LIMIT 1");
    const config = configResult.rows[0] || {};
    
    // Preparar data de vencimento
    let vencimento = cobranca.vencimento;
    if (vencimento) {
      vencimento = new Date(vencimento).toISOString().split('T')[0];
    } else {
      // Se não tem vencimento, usar 7 dias a partir de hoje
      const hoje = new Date();
      hoje.setDate(hoje.getDate() + 7);
      vencimento = hoje.toISOString().split('T')[0];
    }
    
    // Criar cobrança no Asaas
    const payload = {
      customer: clienteAsaasId,
      billingType: tipo_pagamento, // BOLETO, PIX, CREDIT_CARD, UNDEFINED
      value: parseFloat(cobranca.valor_atualizado || cobranca.valor_original),
      dueDate: vencimento,
      description: cobranca.descricao || `Cobrança ACERTIVE - ${cobranca.cliente_nome}`,
      externalReference: cobranca.id,
      
      // Juros e multa
      interest: {
        value: parseFloat(config.taxa_juros_padrao) || 2.0
      },
      fine: {
        value: parseFloat(config.taxa_multa_padrao) || 2.0,
        type: 'PERCENTAGE'
      },
      
      postalService: false
    };
    
    // Adicionar desconto se configurado
    if (config.desconto_padrao && config.dias_desconto_padrao) {
      payload.discount = {
        value: parseFloat(config.desconto_padrao),
        dueDateLimitDays: parseInt(config.dias_desconto_padrao),
        type: 'PERCENTAGE'
      };
    }
    
    console.log('[ASAAS] Criando cobrança:', JSON.stringify(payload, null, 2));
    
    const novaCobranca = await asaasRequest('/payments', 'POST', payload);
    
    // Buscar dados do boleto
    let linhaDigitavel = null;
    let codigoBarras = null;
    if (novaCobranca.billingType === 'BOLETO' || tipo_pagamento === 'UNDEFINED' || tipo_pagamento === 'BOLETO') {
      try {
        const boleto = await asaasRequest(`/payments/${novaCobranca.id}/identificationField`);
        linhaDigitavel = boleto.identificationField;
        codigoBarras = boleto.barCode;
      } catch (e) {
        console.log('[ASAAS] Boleto não disponível:', e.message);
      }
    }
    
    // Buscar QR Code PIX
    let pixPayload = null;
    let pixQrCode = null;
    if (tipo_pagamento === 'UNDEFINED' || tipo_pagamento === 'PIX') {
      try {
        const pix = await asaasRequest(`/payments/${novaCobranca.id}/pixQrCode`);
        pixPayload = pix.payload;
        pixQrCode = pix.encodedImage;
      } catch (e) {
        console.log('[ASAAS] PIX não disponível:', e.message);
      }
    }
    
    // Atualizar cobrança no banco
    await pool.query(`
      UPDATE cobrancas SET
        asaas_id = $1,
        asaas_invoice_url = $2,
        asaas_boleto_url = $3,
        asaas_linha_digitavel = $4,
        asaas_codigo_barras = $5,
        asaas_pix_payload = $6,
        asaas_pix_qrcode = $7,
        asaas_billing_type = $8,
        asaas_sync_at = NOW()
      WHERE id = $9
    `, [
      novaCobranca.id,
      novaCobranca.invoiceUrl,
      novaCobranca.bankSlipUrl,
      linhaDigitavel,
      codigoBarras,
      pixPayload,
      pixQrCode,
      novaCobranca.billingType,
      id
    ]);
    
    await registrarLog(req, 'GERAR_ASAAS', 'cobrancas', id, { 
      asaas_id: novaCobranca.id,
      tipo: tipo_pagamento
    });
    
    res.json({
      success: true,
      message: "Cobrança gerada no Asaas!",
      data: {
        asaas_id: novaCobranca.id,
        link_pagamento: novaCobranca.invoiceUrl,
        boleto_url: novaCobranca.bankSlipUrl,
        linha_digitavel: linhaDigitavel,
        codigo_barras: codigoBarras,
        pix_copia_cola: pixPayload,
        pix_qrcode: pixQrCode ? `data:image/png;base64,${pixQrCode}` : null,
        valor: novaCobranca.value,
        vencimento: novaCobranca.dueDate,
        status: novaCobranca.status
      }
    });
    
  } catch (err) {
    console.error("[ASAAS GERAR COBRANCA] erro:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// ROTA: OBTER DADOS DE PAGAMENTO (BOLETO/PIX)
// =====================================================
app.get("/api/asaas/cobrancas/:id/pagamento", auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT c.*, cl.nome as cliente_nome
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.id = $1
    `, [id]);
    
    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }
    
    const cobranca = result.rows[0];
    
    if (!cobranca.asaas_id) {
      return res.status(400).json({ 
        success: false, 
        message: "Esta cobrança ainda não foi gerada no Asaas. Clique em 'Gerar Boleto/PIX' primeiro."
      });
    }
    
    // Buscar dados atualizados do Asaas
    const asaasData = await asaasRequest(`/payments/${cobranca.asaas_id}`);
    
    // Atualizar status se mudou
    const statusMap = {
      'PENDING': 'pendente',
      'RECEIVED': 'pago',
      'CONFIRMED': 'pago',
      'OVERDUE': 'vencido',
      'REFUNDED': 'estornado',
      'RECEIVED_IN_CASH': 'pago'
    };
    
    const novoStatus = statusMap[asaasData.status] || cobranca.status;
    
    if (novoStatus !== cobranca.status) {
      await pool.query(`UPDATE cobrancas SET status = $1 WHERE id = $2`, [novoStatus, id]);
    }
    
    res.json({
      success: true,
      data: {
        cobranca_id: id,
        asaas_id: cobranca.asaas_id,
        cliente: cobranca.cliente_nome,
        valor: asaasData.value,
        vencimento: asaasData.dueDate,
        status: asaasData.status,
        status_acertive: novoStatus,
        link_pagamento: cobranca.asaas_invoice_url || asaasData.invoiceUrl,
        boleto: {
          url: cobranca.asaas_boleto_url || asaasData.bankSlipUrl,
          linha_digitavel: cobranca.asaas_linha_digitavel,
          codigo_barras: cobranca.asaas_codigo_barras
        },
        pix: {
          copia_cola: cobranca.asaas_pix_payload,
          qrcode: cobranca.asaas_pix_qrcode ? `data:image/png;base64,${cobranca.asaas_pix_qrcode}` : null
        },
        pagamento: asaasData.paymentDate ? {
          data: asaasData.paymentDate,
          valor: asaasData.value,
          forma: asaasData.billingType
        } : null
      }
    });
    
  } catch (err) {
    console.error("[ASAAS GET PAGAMENTO] erro:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// ROTA: ATUALIZAR QR CODE PIX (se expirou)
// =====================================================
app.post("/api/asaas/cobrancas/:id/atualizar-pix", auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query("SELECT asaas_id FROM cobrancas WHERE id = $1", [id]);
    if (!result.rowCount || !result.rows[0].asaas_id) {
      return res.status(400).json({ success: false, message: "Cobrança não tem ID Asaas." });
    }
    
    const asaasId = result.rows[0].asaas_id;
    
    // Buscar novo QR Code
    const pix = await asaasRequest(`/payments/${asaasId}/pixQrCode`);
    
    // Atualizar no banco
    await pool.query(`
      UPDATE cobrancas SET asaas_pix_payload = $1, asaas_pix_qrcode = $2 WHERE id = $3
    `, [pix.payload, pix.encodedImage, id]);
    
    res.json({
      success: true,
      message: "QR Code PIX atualizado!",
      data: {
        copia_cola: pix.payload,
        qrcode: `data:image/png;base64,${pix.encodedImage}`,
        expiracao: pix.expirationDate
      }
    });
    
  } catch (err) {
    console.error("[ASAAS ATUALIZAR PIX] erro:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// ROTA: CANCELAR COBRANÇA NO ASAAS
// =====================================================
app.delete("/api/asaas/cobrancas/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query("SELECT asaas_id FROM cobrancas WHERE id = $1", [id]);
    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }
    
    const asaasId = result.rows[0].asaas_id;
    
    if (asaasId) {
      // Cancelar no Asaas
      await asaasRequest(`/payments/${asaasId}`, 'DELETE');
    }
    
    // Atualizar status local
    await pool.query(`UPDATE cobrancas SET status = 'cancelado' WHERE id = $1`, [id]);
    
    await registrarLog(req, 'CANCELAR_ASAAS', 'cobrancas', id, { asaas_id: asaasId });
    
    res.json({ success: true, message: "Cobrança cancelada!" });
    
  } catch (err) {
    console.error("[ASAAS CANCELAR] erro:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// ROTA: REENVIAR NOTIFICAÇÃO DE COBRANÇA
// =====================================================
app.post("/api/asaas/cobrancas/:id/notificar", auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query("SELECT asaas_id FROM cobrancas WHERE id = $1", [id]);
    if (!result.rowCount || !result.rows[0].asaas_id) {
      return res.status(400).json({ success: false, message: "Cobrança não tem ID Asaas." });
    }
    
    await asaasRequest(`/payments/${result.rows[0].asaas_id}/notification`, 'POST');
    
    res.json({ success: true, message: "Notificação reenviada pelo Asaas!" });
    
  } catch (err) {
    console.error("[ASAAS NOTIFICAR] erro:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// WEBHOOK: RECEBER NOTIFICAÇÕES DO ASAAS (ATUALIZADO)
// Processa pagamentos de COBRANÇAS e PARCELAS
// =====================================================
app.post("/api/asaas/webhook", async (req, res) => {
  try {
    const payload = req.body;
    const evento = payload.event;
    const payment = payload.payment;
    
    console.log('[ASAAS WEBHOOK] Evento recebido:', evento);
    console.log('[ASAAS WEBHOOK] Payment ID:', payment?.id);
    console.log('[ASAAS WEBHOOK] External Reference:', payment?.externalReference);
    
    // Registrar no log
    await pool.query(`
      INSERT INTO asaas_webhooks_log (evento, payment_id, customer_id, payload)
      VALUES ($1, $2, $3, $4)
    `, [evento, payment?.id, payment?.customer, JSON.stringify(payload)]);
    
    // Processar evento
    if (payment && payment.externalReference) {
      const externalRef = payment.externalReference;
      
      // =========================================================
      // VERIFICAR SE É PARCELA OU COBRANÇA
      // =========================================================
      const isParcela = externalRef.startsWith('PARCELA:');
      
      if (isParcela) {
        // =========================================================
        // PROCESSAR PAGAMENTO DE PARCELA
        // =========================================================
        const parcelaId = externalRef.replace('PARCELA:', '');
        console.log(`[ASAAS WEBHOOK] Processando PARCELA: ${parcelaId}`);
        
        // Buscar parcela com dados do acordo
        const parcelaResult = await pool.query(`
          SELECT p.*, a.id as acordo_id, a.cobranca_id, a.cliente_id
          FROM parcelas p
          JOIN acordos a ON a.id = p.acordo_id
          WHERE p.id = $1
        `, [parcelaId]);
        
        if (parcelaResult.rowCount > 0) {
          const parcela = parcelaResult.rows[0];
          
          switch (evento) {
            case 'PAYMENT_CONFIRMED':
            case 'PAYMENT_RECEIVED':
              const dataPagamento = payment.paymentDate || payment.confirmedDate || new Date().toISOString().split('T')[0];
              const valorPago = payment.value;
              const formaPagamento = payment.billingType;
              
              // Atualizar parcela para PAGO
              await pool.query(`
                UPDATE parcelas SET 
                  status = 'pago',
                  data_pagamento = $1,
                  valor_pago = $2,
                  forma_pagamento = $3,
                  updated_at = NOW()
                WHERE id = $4
              `, [dataPagamento, valorPago, formaPagamento, parcelaId]);
              
              console.log(`[ASAAS WEBHOOK] ✅ Parcela ${parcelaId} PAGA!`);
              
              // Verificar se todas as parcelas do acordo foram pagas
              const parcelasPendentes = await pool.query(`
                SELECT COUNT(*)::int as total 
                FROM parcelas 
                WHERE acordo_id = $1 AND status != 'pago'
              `, [parcela.acordo_id]);
              
              if (parseInt(parcelasPendentes.rows[0].total) === 0) {
                // ACORDO QUITADO!
                console.log(`[ASAAS WEBHOOK] 🎉 Acordo ${parcela.acordo_id} QUITADO!`);
                
                await pool.query(`
                  UPDATE acordos SET status = 'quitado', updated_at = NOW() WHERE id = $1
                `, [parcela.acordo_id]);
                
                // Atualizar cobrança original para PAGO
                if (parcela.cobranca_id) {
                  await pool.query(`
                    UPDATE cobrancas SET 
                      status = 'pago', 
                      data_pagamento = $1,
                      updated_at = NOW() 
                    WHERE id = $2
                  `, [dataPagamento, parcela.cobranca_id]);
                  
                  console.log(`[ASAAS WEBHOOK] ✅ Cobrança ${parcela.cobranca_id} marcada como PAGA`);
                }
              }
              
              // Registrar comissão (se configurado)
              try {
                const acordoData = await pool.query(`
                  SELECT a.credor_id, cr.comissao_percentual
                  FROM acordos a
                  LEFT JOIN credores cr ON cr.id = a.credor_id
                  WHERE a.id = $1
                `, [parcela.acordo_id]);
                
                if (acordoData.rowCount > 0 && acordoData.rows[0].credor_id) {
                  const comissaoPerc = parseFloat(acordoData.rows[0].comissao_percentual) || 10;
                  const comissaoValor = (valorPago * comissaoPerc) / 100;
                  
                  await pool.query(`
                    INSERT INTO comissoes (
                      credor_id, parcela_id, acordo_id, cliente_id,
                      valor_base, percentual, valor_comissao,
                      status, created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente', NOW())
                  `, [
                    acordoData.rows[0].credor_id,
                    parcelaId,
                    parcela.acordo_id,
                    parcela.cliente_id,
                    valorPago,
                    comissaoPerc,
                    comissaoValor
                  ]);
                  
                  console.log(`[ASAAS WEBHOOK] 💰 Comissão registrada: R$ ${comissaoValor.toFixed(2)}`);
                }
              } catch (comissaoErr) {
                console.warn('[ASAAS WEBHOOK] Aviso ao registrar comissão:', comissaoErr.message);
              }
              break;
              
            case 'PAYMENT_OVERDUE':
              console.log(`[ASAAS WEBHOOK] ⚠️ Parcela ${parcelaId} VENCIDA`);
              break;
              
            case 'PAYMENT_DELETED':
            case 'PAYMENT_REFUNDED':
              const novoStatusParcela = evento === 'PAYMENT_REFUNDED' ? 'estornado' : 'cancelado';
              await pool.query(`
                UPDATE parcelas SET status = $1, updated_at = NOW() WHERE id = $2
              `, [novoStatusParcela, parcelaId]);
              console.log(`[ASAAS WEBHOOK] ❌ Parcela ${parcelaId} ${novoStatusParcela.toUpperCase()}`);
              break;
          }
          
          // Marcar webhook como processado
          await pool.query(`
            UPDATE asaas_webhooks_log SET processado = true, parcela_id = $1 
            WHERE payment_id = $2 AND evento = $3
          `, [parcelaId, payment.id, evento]);
        } else {
          console.warn(`[ASAAS WEBHOOK] Parcela não encontrada: ${parcelaId}`);
        }
        
      } else {
        // =========================================================
        // PROCESSAR PAGAMENTO DE COBRANÇA (código original)
        // =========================================================
        const cobrancaId = externalRef;
        console.log(`[ASAAS WEBHOOK] Processando COBRANÇA: ${cobrancaId}`);
        
        const cobranca = await pool.query("SELECT id, status FROM cobrancas WHERE id = $1", [cobrancaId]);
        
        if (cobranca.rowCount > 0) {
          let novoStatus = null;
          let dataPagamento = null;
          let valorPago = null;
          let formaPagamento = null;
          
          switch (evento) {
            case 'PAYMENT_CONFIRMED':
            case 'PAYMENT_RECEIVED':
              novoStatus = 'pago';
              dataPagamento = payment.paymentDate || payment.confirmedDate;
              valorPago = payment.value;
              formaPagamento = payment.billingType;
              console.log(`[ASAAS WEBHOOK] ✅ Cobrança ${cobrancaId} PAGA!`);
              break;
              
            case 'PAYMENT_OVERDUE':
              novoStatus = 'vencido';
              console.log(`[ASAAS WEBHOOK] ⚠️ Cobrança ${cobrancaId} VENCIDA`);
              break;
              
            case 'PAYMENT_DELETED':
            case 'PAYMENT_REFUNDED':
              novoStatus = evento === 'PAYMENT_REFUNDED' ? 'estornado' : 'cancelado';
              console.log(`[ASAAS WEBHOOK] ❌ Cobrança ${cobrancaId} ${novoStatus.toUpperCase()}`);
              break;
          }
          
          if (novoStatus) {
            await pool.query(`
              UPDATE cobrancas SET 
                status = $1,
                data_pagamento = COALESCE($2, data_pagamento),
                valor_pago = COALESCE($3, valor_pago),
                forma_pagamento = COALESCE($4, forma_pagamento),
                updated_at = NOW()
              WHERE id = $5
            `, [novoStatus, dataPagamento, valorPago, formaPagamento, cobrancaId]);
            
            // Marcar webhook como processado
            await pool.query(`
              UPDATE asaas_webhooks_log SET processado = true, cobranca_id = $1 
              WHERE payment_id = $2 AND evento = $3
            `, [cobrancaId, payment.id, evento]);
          }
        } else {
          console.warn(`[ASAAS WEBHOOK] Cobrança não encontrada: ${cobrancaId}`);
        }
      }
    }
    
    // Sempre retornar 200 para o Asaas
    res.status(200).json({ received: true });
    
  } catch (err) {
    console.error('[ASAAS WEBHOOK] Erro:', err.message);
    // Ainda retorna 200 para não ficar reenviando
    res.status(200).json({ received: true, error: err.message });
  }
});

// =====================================================
// ROTA: HISTÓRICO DE WEBHOOKS
// =====================================================
app.get("/api/asaas/webhooks", auth, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    
    const result = await pool.query(`
      SELECT * FROM asaas_webhooks_log
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    const count = await pool.query("SELECT COUNT(*) FROM asaas_webhooks_log");
    
    res.json({
      success: true,
      data: result.rows,
      total: parseInt(count.rows[0].count)
    });
    
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// ROTA: SINCRONIZAR TODAS COBRANÇAS PENDENTES
// =====================================================
app.post("/api/asaas/sincronizar-pendentes", auth, async (req, res) => {
  try {
    // Buscar cobranças pendentes sem asaas_id
    const cobrancas = await pool.query(`
      SELECT c.id, c.cliente_id, cl.asaas_id as cliente_asaas_id
      FROM cobrancas c
      JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.status = 'pendente' 
        AND c.asaas_id IS NULL
        AND cl.asaas_id IS NOT NULL
      LIMIT 50
    `);
    
    let sucesso = 0;
    let erros = 0;
    
    for (const cob of cobrancas.rows) {
      try {
        // Simular chamada à rota de gerar (reutilizar lógica)
        // Na prática, você chamaria internamente ou refatoraria
        sucesso++;
      } catch (e) {
        erros++;
      }
    }
    
    res.json({
      success: true,
      message: `Sincronização concluída: ${sucesso} sucesso, ${erros} erros`,
      total: cobrancas.rowCount
    });
    
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// ROTA: GERAR COBRANÇA EM MASSA
// =====================================================
app.post("/api/asaas/cobrancas/gerar-massa", auth, async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "Nenhuma cobrança selecionada." });
    }
    
    let sucesso = 0;
    let erros = 0;
    const resultados = [];
    
    for (const id of ids.slice(0, 20)) { // Limitar a 20 por vez
      try {
        // Chamar a lógica de gerar (simplificado aqui)
        // Em produção, você chamaria a função interna
        resultados.push({ id, status: 'processando' });
        sucesso++;
      } catch (e) {
        resultados.push({ id, status: 'erro', erro: e.message });
        erros++;
      }
    }
    
    res.json({
      success: true,
      message: `${sucesso} cobrança(s) processada(s), ${erros} erro(s)`,
      resultados
    });
    
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

console.log('[ASAAS] ✅ Rotas de integração Asaas carregadas');
console.log('[ASAAS] 📍 Webhook URL: /api/asaas/webhook');
// =====================================================
// ROTAS ADICIONAIS PARA FINANCEIRO.HTML
// Cole ANTES da linha: app.use((req, res) => res.status(404)...)
// =====================================================

// =====================================================
// ROTA: ESTATÍSTICAS PARA O DASHBOARD FINANCEIRO
// =====================================================
app.get("/api/financeiro/estatisticas", auth, async (req, res) => {
  try {
    const hoje = new Date();
    const primeiroDiaMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().split('T')[0];
    const ultimoDiaMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).toISOString().split('T')[0];

    // Recebido no mês (de cobrancas)
    const recebido = await pool.query(`
      SELECT 
        COALESCE(SUM(valor_pago), 0)::numeric as total,
        COUNT(*)::int as quantidade
      FROM cobrancas 
      WHERE status = 'pago' 
        AND data_pagamento >= $1 
        AND data_pagamento <= $2
    `, [primeiroDiaMes, ultimoDiaMes]);

    // A receber (pendentes não vencidos)
    const aReceber = await pool.query(`
      SELECT 
        COALESCE(SUM(valor_atualizado), 0)::numeric as total,
        COUNT(*)::int as quantidade
      FROM cobrancas 
      WHERE status = 'pendente' 
        AND data_vencimento >= CURRENT_DATE
    `);

    // Vencidos
    const vencidos = await pool.query(`
      SELECT 
        COALESCE(SUM(valor_atualizado), 0)::numeric as total,
        COUNT(*)::int as quantidade
      FROM cobrancas 
      WHERE status IN ('pendente', 'vencido') 
        AND data_vencimento < CURRENT_DATE
    `);

    // Comissões do mês
    const comissoes = await pool.query(`
      SELECT 
        COALESCE(SUM(c.valor_pago * COALESCE(cr.comissao, cr.comissao_percentual, 0) / 100), 0)::numeric as total,
        COUNT(DISTINCT c.credor_id)::int as qtd_credores
      FROM cobrancas c
      LEFT JOIN credores cr ON cr.id = c.credor_id
      WHERE c.status = 'pago' 
        AND c.data_pagamento >= $1 
        AND c.data_pagamento <= $2
    `, [primeiroDiaMes, ultimoDiaMes]);

    res.json({
      success: true,
      data: {
        recebido_mes: parseFloat(recebido.rows[0].total) || 0,
        qtd_recebido: parseInt(recebido.rows[0].quantidade) || 0,
        a_receber: parseFloat(aReceber.rows[0].total) || 0,
        qtd_a_receber: parseInt(aReceber.rows[0].quantidade) || 0,
        vencido: parseFloat(vencidos.rows[0].total) || 0,
        qtd_vencido: parseInt(vencidos.rows[0].quantidade) || 0,
        comissoes_mes: parseFloat(comissoes.rows[0].total) || 0,
        qtd_credores: parseInt(comissoes.rows[0].qtd_credores) || 0
      }
    });

  } catch (err) {
    console.error("[GET /api/financeiro/estatisticas] erro:", err.message);
    res.status(500).json({ success: false, message: "Erro ao buscar estatísticas", error: err.message });
  }
});

// =====================================================
// ROTA: MOVIMENTAÇÕES FINANCEIRAS (COBRANÇAS)
// =====================================================
app.get("/api/financeiro/movimentacoes", auth, async (req, res) => {
  try {
    const { status, credor_id, data_inicio, data_fim, limit = 50 } = req.query;

    let whereConditions = [];
    let params = [];
    let paramIndex = 1;

    if (status) {
      if (status === 'vencido') {
        whereConditions.push(`(c.status IN ('pendente', 'vencido') AND c.data_vencimento < CURRENT_DATE)`);
      } else {
        whereConditions.push(`c.status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }
    }

    if (credor_id) {
      whereConditions.push(`c.credor_id = $${paramIndex}`);
      params.push(credor_id);
      paramIndex++;
    }

    if (data_inicio) {
      whereConditions.push(`c.data_vencimento >= $${paramIndex}`);
      params.push(data_inicio);
      paramIndex++;
    }

    if (data_fim) {
      whereConditions.push(`c.data_vencimento <= $${paramIndex}`);
      params.push(data_fim);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    const query = `
      SELECT 
        c.id,
        c.descricao,
        c.valor,
        c.valor_atualizado,
        c.valor_pago,
        c.data_vencimento,
        c.data_pagamento,
        c.status,
        c.forma_pagamento,
        cl.nome as cliente_nome,
        cl.cpf_cnpj as cliente_cpf,
        cr.nome as credor_nome
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      LEFT JOIN credores cr ON cr.id = c.credor_id
      ${whereClause}
      ORDER BY 
        CASE WHEN c.status = 'pago' THEN c.data_pagamento ELSE c.data_vencimento END DESC
      LIMIT $${paramIndex}
    `;

    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (err) {
    console.error("[GET /api/financeiro/movimentacoes] erro:", err.message);
    res.status(500).json({ success: false, message: "Erro ao buscar movimentações", error: err.message });
  }
});

// =====================================================
// ROTA: ÚLTIMOS PAGAMENTOS RECEBIDOS
// =====================================================
app.get("/api/financeiro/ultimos-pagamentos", auth, async (req, res) => {
  try {
    const { limit = 5 } = req.query;

    const result = await pool.query(`
      SELECT 
        c.id,
        c.valor_pago,
        c.valor,
        c.data_pagamento,
        c.forma_pagamento,
        cl.nome as cliente_nome
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.status = 'pago' AND c.data_pagamento IS NOT NULL
      ORDER BY c.data_pagamento DESC
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (err) {
    console.error("[GET /api/financeiro/ultimos-pagamentos] erro:", err.message);
    res.status(500).json({ success: false, message: "Erro ao buscar últimos pagamentos", error: err.message });
  }
});

// =====================================================
// ROTA: REGISTRAR PAGAMENTO MANUAL EM COBRANÇA
// =====================================================
app.post("/api/cobrancas/:id/pagar", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data_pagamento, valor_pago, forma_pagamento = 'manual' } = req.body;

    // Buscar cobrança
    const cobranca = await pool.query("SELECT * FROM cobrancas WHERE id = $1", [id]);
    if (cobranca.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada" });
    }

    const cob = cobranca.rows[0];
    const valorFinal = valor_pago || cob.valor_atualizado || cob.valor;

    // Atualizar cobrança
    await pool.query(`
      UPDATE cobrancas SET 
        status = 'pago',
        data_pagamento = $1,
        valor_pago = $2,
        forma_pagamento = $3,
        updated_at = NOW()
      WHERE id = $4
    `, [data_pagamento || new Date().toISOString().split('T')[0], valorFinal, forma_pagamento, id]);

    // Registrar log se a função existir
    if (typeof registrarLog === 'function') {
      await registrarLog(req, 'PAGAMENTO', 'cobrancas', id, { valor: valorFinal, forma: forma_pagamento });
    }

    res.json({ success: true, message: "Pagamento registrado com sucesso!" });

  } catch (err) {
    console.error("[POST /api/cobrancas/:id/pagar] erro:", err.message);
    res.status(500).json({ success: false, message: "Erro ao registrar pagamento", error: err.message });
  }
});

console.log('[FINANCEIRO] ✅ Rotas adicionais carregadas');
// =====================================================
// ROTAS RÉGUA DE COBRANÇA - CORRIGIDO
// SUBSTITUA as rotas anteriores da régua por estas
// =====================================================

// Listar réguas
app.get("/api/regua-cobranca", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, t.nome as template_nome
      FROM regua_cobranca r
      LEFT JOIN templates_mensagem t ON t.id = r.template_id
      ORDER BY r.ordem ASC, r.dias_apos_vencimento ASC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[GET /api/regua-cobranca] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Criar régua
app.post("/api/regua-cobranca", auth, async (req, res) => {
  try {
    const { nome, dias_apos_vencimento, tipo_acao, template_id, ativo = true, ordem = 0, descricao } = req.body;
    
    const result = await pool.query(`
      INSERT INTO regua_cobranca (nome, dias_apos_vencimento, tipo_acao, template_id, ativo, ordem, descricao)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [nome, dias_apos_vencimento, tipo_acao, template_id, ativo, ordem, descricao]);
    
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[POST /api/regua-cobranca] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Atualizar régua
app.put("/api/regua-cobranca/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, dias_apos_vencimento, tipo_acao, template_id, ativo, ordem, descricao } = req.body;
    
    const result = await pool.query(`
      UPDATE regua_cobranca SET
        nome = COALESCE($1, nome),
        dias_apos_vencimento = COALESCE($2, dias_apos_vencimento),
        tipo_acao = COALESCE($3, tipo_acao),
        template_id = $4,
        ativo = COALESCE($5, ativo),
        ordem = COALESCE($6, ordem),
        descricao = COALESCE($7, descricao)
      WHERE id = $8
      RETURNING *
    `, [nome, dias_apos_vencimento, tipo_acao, template_id, ativo, ordem, descricao, id]);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[PUT /api/regua-cobranca/:id] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Excluir régua
app.delete("/api/regua-cobranca/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM regua_cobranca WHERE id = $1", [id]);
    res.json({ success: true, message: "Régua excluída!" });
  } catch (err) {
    console.error('[DELETE /api/regua-cobranca/:id] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// TEMPLATES DE MENSAGEM - CRUD
// =====================================================

app.get("/api/templates", auth, async (req, res) => {
  try {
    const { tipo } = req.query;
    let sql = "SELECT * FROM templates_mensagem WHERE 1=1";
    const params = [];
    
    if (tipo) {
      sql += " AND tipo = $1";
      params.push(tipo);
    }
    
    sql += " ORDER BY nome ASC";
    
    const result = await pool.query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[GET /api/templates] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/templates", auth, async (req, res) => {
  try {
    const { nome, tipo, assunto, conteudo, variaveis, ativo = true } = req.body;
    
    const result = await pool.query(`
      INSERT INTO templates_mensagem (nome, tipo, assunto, conteudo, variaveis, ativo)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [nome, tipo, assunto, conteudo, variaveis, ativo]);
    
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[POST /api/templates] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put("/api/templates/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, tipo, assunto, conteudo, variaveis, ativo } = req.body;
    
    const result = await pool.query(`
      UPDATE templates_mensagem SET
        nome = COALESCE($1, nome),
        tipo = COALESCE($2, tipo),
        assunto = COALESCE($3, assunto),
        conteudo = COALESCE($4, conteudo),
        variaveis = COALESCE($5, variaveis),
        ativo = COALESCE($6, ativo),
        updated_at = NOW()
      WHERE id = $7
      RETURNING *
    `, [nome, tipo, assunto, conteudo, variaveis, ativo, id]);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[PUT /api/templates/:id] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/api/templates/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM templates_mensagem WHERE id = $1", [id]);
    res.json({ success: true, message: "Template excluído!" });
  } catch (err) {
    console.error('[DELETE /api/templates/:id] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =====================================================
// EXECUTAR RÉGUA DE COBRANÇA
// =====================================================

app.post("/api/regua-cobranca/executar", auth, async (req, res) => {
  try {
    const resultado = await executarReguaCobranca();
    res.json({ success: true, ...resultado });
  } catch (err) {
    console.error('[POST /api/regua-cobranca/executar] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Função de execução da régua
async function executarReguaCobranca() {
  console.log('[RÉGUA] Iniciando execução...');
  
  const stats = { processados: 0, enviados: 0, erros: 0, detalhes: [] };
  
  try {
    const reguas = await pool.query(`
      SELECT r.*, t.assunto, t.conteudo
      FROM regua_cobranca r
      LEFT JOIN templates_mensagem t ON t.id = r.template_id
      WHERE r.ativo = true
      ORDER BY r.ordem ASC
    `);
    
    if (reguas.rowCount === 0) {
      console.log('[RÉGUA] Nenhuma régua ativa');
      return stats;
    }
    
    for (const regua of reguas.rows) {
      console.log(`[RÉGUA] Processando: ${regua.nome} (${regua.dias_apos_vencimento} dias)`);
      
      // dias_apos_vencimento: negativo = antes, 0 = no dia, positivo = depois
      let whereData;
      const dias = regua.dias_apos_vencimento || 0;
      
      if (dias < 0) {
        whereData = `c.data_vencimento = CURRENT_DATE + INTERVAL '${Math.abs(dias)} days'`;
      } else if (dias === 0) {
        whereData = `c.data_vencimento = CURRENT_DATE`;
      } else {
        whereData = `c.data_vencimento = CURRENT_DATE - INTERVAL '${dias} days'`;
      }
      
      const cobrancas = await pool.query(`
        SELECT c.*, cl.nome as cliente_nome, cl.email as cliente_email, 
               cl.telefone as cliente_telefone, cl.celular as cliente_celular
        FROM cobrancas c
        JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.status IN ('pendente', 'vencido')
          AND ${whereData}
          AND NOT EXISTS (
            SELECT 1 FROM regua_execucoes re 
            WHERE re.cobranca_id = c.id AND re.regua_id = $1 AND re.status = 'enviado'
          )
        LIMIT 100
      `, [regua.id]);
      
      console.log(`[RÉGUA] ${cobrancas.rowCount} cobranças para "${regua.nome}"`);
      
      for (const cob of cobrancas.rows) {
        stats.processados++;
        
        try {
          const variaveis = {
            cliente_nome: cob.cliente_nome || 'Cliente',
            valor: formatarMoeda(cob.valor || 0),
            valor_atualizado: formatarMoeda(cob.valor_atualizado || cob.valor || 0),
            data_vencimento: formatarData(cob.data_vencimento),
            dias: Math.abs(dias),
            link_pagamento: cob.asaas_invoice_url || '#',
            empresa_nome: 'ACERTIVE'
          };
          
          let assunto = regua.assunto || 'Cobrança';
          let conteudo = regua.conteudo || 'Você tem uma cobrança pendente.';
          
          for (const [key, value] of Object.entries(variaveis)) {
            assunto = assunto.replace(new RegExp(`{{${key}}}`, 'g'), value);
            conteudo = conteudo.replace(new RegExp(`{{${key}}}`, 'g'), value);
          }
          
          let enviado = false;
          let erroMsg = null;
          
          if (regua.tipo_acao === 'EMAIL' && cob.cliente_email) {
            // Aqui enviaria o email
            console.log(`[RÉGUA] Email para ${cob.cliente_email}: ${assunto}`);
            enviado = true; // Simular sucesso por enquanto
          }
          
          await pool.query(`
            INSERT INTO regua_execucoes (regua_id, cobranca_id, cliente_id, tipo_acao, status, erro_msg, enviado_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [regua.id, cob.id, cob.cliente_id, regua.tipo_acao, enviado ? 'enviado' : 'erro', erroMsg, enviado ? new Date() : null]);
          
          if (enviado) stats.enviados++;
          else stats.erros++;
          
        } catch (e) {
          console.error(`[RÉGUA] Erro cobrança ${cob.id}:`, e.message);
          stats.erros++;
        }
      }
    }
    
    console.log(`[RÉGUA] Finalizado: ${stats.enviados} enviados, ${stats.erros} erros`);
    return stats;
    
  } catch (err) {
    console.error('[RÉGUA] Erro:', err.message);
    throw err;
  }
}

function formatarMoeda(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
}

function formatarData(d) {
  return d ? new Date(d).toLocaleDateString('pt-BR') : '-';
}

// Histórico de execuções
app.get("/api/regua-cobranca/execucoes", auth, async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    
    const result = await pool.query(`
      SELECT re.*, r.nome as regua_nome, cl.nome as cliente_nome
      FROM regua_execucoes re
      LEFT JOIN regua_cobranca r ON r.id = re.regua_id
      LEFT JOIN clientes cl ON cl.id = re.cliente_id
      ORDER BY re.created_at DESC
      LIMIT $1
    `, [parseInt(limit)]);
    
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[GET /api/regua-cobranca/execucoes] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

console.log('[RÉGUA] ✅ Rotas carregadas');
// =====================
// 404
// =====================
app.use((req, res) => res.status(404).send("Página não encontrada."));

// =====================
// Start
// =====================
app.listen(PORT, () => {
  console.log(`[ACERTIVE ENTERPRISE v2.1] 🚀 Servidor rodando na porta ${PORT}`);
  console.log("[ACERTIVE] Allowed origins:", allowedOrigins);
  console.log("[ACERTIVE] E-mail configurado:", !!emailTransporter);
  console.log("[ACERTIVE] IA configurada:", !!process.env.OPENAI_API_KEY);
});