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

const app = express();
app.set("trust proxy", 1);

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
    const token = jwt.sign({ userId: user.id, email: user.email, nome: user.nome, nivel: user.nivel || 'operador' }, process.env.JWT_SECRET, { expiresIn: "12h" });
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
app.get("/clientes-ativos", sendFront("clientes-ativos.html"));
app.get(["/novo-cliente", "/novo-cliente/"], sendFront("novo-cliente.html"));
app.get("/novo-cliente.html", sendFront("novo-cliente.html"));
app.get("/cobrancas-recorrentes", sendFront("cobrancas-recorrentes.html"));
app.get("/nova-recorrente", sendFront("nova-recorrente.html"));
app.get("/historico", sendFront("historico.html"));
app.get("/usuarios", sendFront("usuarios.html"));
app.get("/agendamentos", sendFront("agendamentos.html"));
app.get("/novo-agendamento", sendFront("novo-agendamento.html"));
app.get("/configuracoes", sendFront("configuracoes.html"));
app.get("/consulta-cliente", sendFront("consulta-cliente.html"));
app.get("/importar-cobrancas", sendFront("importar-cobrancas.html"));

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
// COBRANÇAS - GET
// =====================================================
app.get("/api/cobrancas", auth, async (req, res) => {
  try {
    const status = String(req.query.status || "").trim().toLowerCase();
    const q = String(req.query.q || "").trim();
    const params = [];
    const where = [];
    if (status) { params.push(status); where.push(`LOWER(c.status) = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`LOWER(cl.nome) LIKE LOWER($${params.length})`); }
    const sql = `SELECT c.id, COALESCE(cl.nome,'') AS cliente, COALESCE(cl.email,'') AS cliente_email, COALESCE(cl.telefone,'') AS cliente_telefone, COALESCE(cl.status_cliente,'regular') AS cliente_status, c.cliente_id, c.empresa_id, COALESCE(e.nome,'') AS empresa_nome, c.descricao, c.valor_original AS "valorOriginal", c.multa, c.juros, c.desconto, c.valor_atualizado AS "valorAtualizado", c.status, c.vencimento, c.data_compromisso AS "dataCompromisso", c.aplicar_multa_juros AS "aplicarMultaJuros", c.observacoes, c.created_at AS "createdAt" FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id LEFT JOIN empresas e ON e.id = c.empresa_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.created_at DESC`;
    const resultado = await pool.query(sql, params);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/cobrancas] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar cobranças.", error: err.message });
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
// Cole este conteúdo no server.js ANTES da linha:
// app.use((req, res) => res.status(404).send("Página não encontrada."));
// =====================================================

// Buscar clientes por nome ou CPF/CNPJ (para autocomplete e consulta)
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
        c.status_cliente,
        COUNT(cob.id)::int AS total_cobrancas,
        COALESCE(SUM(CASE WHEN cob.status IN ('pendente', 'vencido') THEN cob.valor_atualizado ELSE 0 END), 0)::numeric AS divida_total,
        COALESCE(SUM(CASE WHEN cob.status = 'pago' THEN cob.valor_atualizado ELSE 0 END), 0)::numeric AS total_pago
      FROM clientes c
      LEFT JOIN cobrancas cob ON cob.cliente_id = c.id
      WHERE c.status = 'ativo'
        AND (
          LOWER(c.nome) LIKE LOWER($1)
          OR REPLACE(REPLACE(REPLACE(c.cpf_cnpj, '.', ''), '-', ''), '/', '') LIKE $2
        )
      GROUP BY c.id
      ORDER BY c.nome ASC
      LIMIT 50
    `, [`%${q}%`, `%${qLimpo}%`]);

    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/clientes/buscar] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar clientes.", error: err.message });
  }
});

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