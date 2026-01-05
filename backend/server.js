/**
 * server.js — ACERTIVE ENTERPRISE COMPLETO
 * PDFs Premium Dourados + E-mail + WhatsApp + IA (OpenAI) + Múltiplos Usuários + Histórico + Backup
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
// INICIALIZAÇÃO DO BANCO - TABELAS ENTERPRISE
// =====================================================
async function initDatabase() {
  try {
    // Tabela de logs de ações (auditoria)
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

    // Adicionar colunas de permissão na tabela users (se não existirem)
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

    // Garantir que o primeiro usuário seja admin
    await pool.query(`
      UPDATE users SET nivel = 'admin' 
      WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1) 
      AND (nivel IS NULL OR nivel = 'operador')
    `);
// Tabela de cobranças recorrentes
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
    console.log("[ACERTIVE] ✅ Tabelas enterprise inicializadas");
  } catch (err) {
    console.error("[ACERTIVE] Erro ao inicializar tabelas:", err.message);
  }
}

// Inicializar banco ao conectar
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
      `INSERT INTO logs_acoes (usuario_id, usuario_nome, acao, entidade, entidade_id, detalhes, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  transporter.verify((err, success) => {
    if (err) {
      console.error("[EMAIL] Erro na configuração:", err.message);
    } else {
      console.log("[EMAIL] ✅ Servidor de e-mail configurado com sucesso!");
    }
  });

  return transporter;
}

emailTransporter = setupEmailTransporter();

// =====================
// Template de E-mail HTML
// =====================
function gerarEmailCobrancaHTML(dados) {
  const { cliente, valor, vencimento, descricao, status, referencia } = dados;
  
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cobrança ACERTIVE</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;background:#f4f4f4;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 20px;">
<tr>
<td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">

<!-- Header -->
<tr>
<td style="background:linear-gradient(135deg,#1a1a1a,#2d2d2d);padding:40px;text-align:center;border-bottom:4px solid #F6C84C;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td align="center">
<div style="width:70px;height:70px;background:linear-gradient(135deg,#F6C84C,#FFD56A);border-radius:16px;display:inline-block;line-height:70px;font-size:36px;font-weight:900;color:#1a1a1a;">A</div>
<h1 style="color:#ffffff;font-size:28px;margin:15px 0 5px;font-weight:900;letter-spacing:1px;">ACERTIVE</h1>
<p style="color:#F6C84C;font-size:14px;margin:0;font-weight:700;letter-spacing:2px;">SISTEMA DE COBRANÇAS</p>
</td>
</tr>
</table>
</td>
</tr>

<!-- Saudação -->
<tr>
<td style="padding:40px 40px 20px;">
<h2 style="color:#1a1a1a;font-size:22px;margin:0 0 10px;font-weight:700;">Olá, ${cliente}!</h2>
<p style="color:#666;font-size:15px;margin:0;line-height:1.6;">Você tem uma cobrança pendente. Confira os detalhes abaixo:</p>
</td>
</tr>

<!-- Card de Valor -->
<tr>
<td style="padding:0 40px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#F6C84C,#FFD56A);border-radius:12px;overflow:hidden;">
<tr>
<td style="padding:30px;text-align:center;">
<p style="color:#1a1a1a;font-size:12px;margin:0 0 8px;font-weight:800;text-transform:uppercase;letter-spacing:1px;">Valor Total</p>
<p style="color:#1a1a1a;font-size:36px;margin:0;font-weight:900;">${valor}</p>
</td>
</tr>
</table>
</td>
</tr>

<!-- Detalhes -->
<tr>
<td style="padding:30px 40px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:12px;border:1px solid #e9ecef;">
<tr>
<td style="padding:20px;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td style="padding:10px 0;border-bottom:1px solid #e9ecef;">
<span style="color:#666;font-size:12px;font-weight:700;text-transform:uppercase;">Referência</span><br>
<span style="color:#1a1a1a;font-size:15px;font-weight:600;">${referencia}</span>
</td>
</tr>
<tr>
<td style="padding:10px 0;border-bottom:1px solid #e9ecef;">
<span style="color:#666;font-size:12px;font-weight:700;text-transform:uppercase;">Vencimento</span><br>
<span style="color:#1a1a1a;font-size:15px;font-weight:600;">${vencimento}</span>
</td>
</tr>
<tr>
<td style="padding:10px 0;border-bottom:1px solid #e9ecef;">
<span style="color:#666;font-size:12px;font-weight:700;text-transform:uppercase;">Descrição</span><br>
<span style="color:#1a1a1a;font-size:15px;font-weight:600;">${descricao || "—"}</span>
</td>
</tr>
<tr>
<td style="padding:10px 0;">
<span style="color:#666;font-size:12px;font-weight:700;text-transform:uppercase;">Status</span><br>
<span style="display:inline-block;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:800;background:${status === 'pago' ? '#dcfce7' : status === 'vencido' ? '#fee2e2' : '#fef3c7'};color:${status === 'pago' ? '#166534' : status === 'vencido' ? '#991b1b' : '#854d0e'};text-transform:uppercase;">${status || 'PENDENTE'}</span>
</td>
</tr>
</table>
</td>
</tr>
</table>
</td>
</tr>

<!-- Aviso -->
<tr>
<td style="padding:0 40px 30px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8e1;border-radius:12px;border-left:4px solid #F6C84C;">
<tr>
<td style="padding:20px;">
<p style="color:#854d0e;font-size:14px;margin:0;line-height:1.6;">
<strong>⚠️ Importante:</strong> Evite juros e multas! Efetue o pagamento até a data de vencimento.
</p>
</td>
</tr>
</table>
</td>
</tr>

<!-- Footer -->
<tr>
<td style="background:#f8f9fa;padding:30px 40px;text-align:center;border-top:1px solid #e9ecef;">
<p style="color:#6b7280;font-size:13px;margin:0 0 10px;font-weight:600;">Sistema ACERTIVE - Gestão de Cobranças</p>
<p style="color:#9ca3af;font-size:12px;margin:0;">Este é um e-mail automático. Por favor, não responda.</p>
</td>
</tr>

</table>
</td>
</tr>
</table>
</body>
</html>
  `;
}

// =====================
// Helpers
// =====================
const asStr = (v) => String(v ?? "").trim();
const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
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
const fmtDate = (d) => {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString("pt-BR");
};
const fmtDateTime = (d) => {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleString("pt-BR");
};

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

// =====================================================
// MIDDLEWARE DE ADMIN (ENTERPRISE)
// =====================================================
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
  return res.json({
    ok: true,
    service: "acertive-enterprise",
    time: new Date().toISOString(),
    frontendDir: FRONTEND_DIR || null,
    emailConfigured: !!emailTransporter,
    iaConfigured: !!process.env.OPENAI_API_KEY,
  });
});

// =====================================================
// API: Login (ENTERPRISE - com nível e verificação de ativo)
// =====================================================
app.post("/api/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    const emailStr = String(email || "").trim();
    const senhaStr = String(senha || "");

    if (!emailStr || !senhaStr) {
      return res.status(400).json({ success: false, message: "Email e senha são obrigatórios." });
    }

    const r = await pool.query(
      "SELECT id, email, senha_hash, nome, nivel, ativo FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [emailStr]
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ success: false, message: "Credenciais inválidas." });
    }

    const user = r.rows[0];

    // Verificar se usuário está ativo
    if (user.ativo === false) {
      return res.status(401).json({ success: false, message: "Usuário desativado. Contate o administrador." });
    }

    const ok = await bcrypt.compare(senhaStr, user.senha_hash);
    if (!ok) return res.status(401).json({ success: false, message: "Credenciais inválidas." });

    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        nome: user.nome,
        nivel: user.nivel || 'operador'
      },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    // Registrar log de login
    await registrarLog(
      { user: { userId: user.id, nome: user.nome }, headers: req.headers, connection: req.connection, ip: req.ip },
      'LOGIN',
      'users',
      user.id,
      { email: user.email }
    );

    return res.json({ 
      success: true, 
      token, 
      user: { 
        id: user.id, 
        email: user.email, 
        nome: user.nome,
        nivel: user.nivel || 'operador'
      } 
    });
  } catch (err) {
    console.error("[LOGIN] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao autenticar.", error: err.message });
  }
});

// =====================
// GET dashboard (KPIs)
// =====================
app.get("/api/dashboard", auth, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pago' THEN valor_atualizado ELSE 0 END), 0) AS total_recebido,
        COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor_atualizado ELSE 0 END), 0) AS total_pendente,
        COALESCE(SUM(CASE WHEN status = 'vencido' THEN valor_atualizado ELSE 0 END), 0) AS total_vencido,
        COUNT(*)::int AS total_cobrancas
      FROM cobrancas
    `);

    const c = await pool.query(`SELECT COUNT(*)::int AS clientes_ativos FROM clientes`);

    const row = q.rows[0] || {};
    return res.json({
      success: true,
      totalRecebido: Number(row.total_recebido || 0),
      totalPendente: Number(row.total_pendente || 0),
      totalVencido: Number(row.total_vencido || 0),
      totalCobrancas: Number(row.total_cobrancas || 0),
      clientesAtivos: Number(c.rows[0]?.clientes_ativos || 0),
    });
  } catch (err) {
    console.error("[GET /api/dashboard] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao carregar dashboard.", error: err.message });
  }
});
// =====================================================
// ENDPOINT PARA GRÁFICOS DO DASHBOARD
// Adicione este código no seu server.js (após o endpoint /api/dashboard)
// =====================================================

// GET /api/dashboard/graficos - Dados para os gráficos
app.get("/api/dashboard/graficos", auth, async (req, res) => {
  try {
    // ========== 1. FATURAMENTO MENSAL (últimos 6 meses) ==========
    const faturamentoQuery = `
      SELECT 
        TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS mes,
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS mes_ordem,
        COALESCE(SUM(valor_atualizado), 0)::numeric AS total,
        COALESCE(SUM(CASE WHEN status = 'pago' THEN valor_atualizado ELSE 0 END), 0)::numeric AS recebido
      FROM cobrancas
      WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY mes_ordem ASC
    `;
    
    const faturamentoResult = await pool.query(faturamentoQuery);
    
    // Mapeia nomes dos meses para português
    const mesesPT = {
      'Jan': 'Jan', 'Feb': 'Fev', 'Mar': 'Mar', 'Apr': 'Abr',
      'May': 'Mai', 'Jun': 'Jun', 'Jul': 'Jul', 'Aug': 'Ago',
      'Sep': 'Set', 'Oct': 'Out', 'Nov': 'Nov', 'Dec': 'Dez'
    };
    
    const faturamentoMensal = {
      meses: faturamentoResult.rows.map(r => mesesPT[r.mes] || r.mes),
      total: faturamentoResult.rows.map(r => parseFloat(r.total) || 0),
      recebido: faturamentoResult.rows.map(r => parseFloat(r.recebido) || 0)
    };

    // ========== 2. STATUS DAS COBRANÇAS (contagem) ==========
    const statusQuery = `
      SELECT 
        COALESCE(SUM(CASE WHEN status = 'pago' THEN 1 ELSE 0 END), 0)::int AS pago,
        COALESCE(SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END), 0)::int AS pendente,
        COALESCE(SUM(CASE WHEN status = 'vencido' THEN 1 ELSE 0 END), 0)::int AS vencido
      FROM cobrancas
    `;
    
    const statusResult = await pool.query(statusQuery);
    
    const statusCobrancas = {
      pago: statusResult.rows[0]?.pago || 0,
      pendente: statusResult.rows[0]?.pendente || 0,
      vencido: statusResult.rows[0]?.vencido || 0
    };

    // ========== 3. TOP CLIENTES DEVEDORES (opcional, para futuro) ==========
    const topDevedoresQuery = `
      SELECT 
        COALESCE(cl.nome, 'Sem cliente') AS cliente,
        SUM(c.valor_atualizado)::numeric AS total_devido
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.status IN ('pendente', 'vencido')
      GROUP BY cl.nome
      ORDER BY total_devido DESC
      LIMIT 5
    `;
    
    const topDevedoresResult = await pool.query(topDevedoresQuery);
    
    const topDevedores = topDevedoresResult.rows.map(r => ({
      cliente: r.cliente,
      total: parseFloat(r.total_devido) || 0
    }));

    return res.json({
      success: true,
      faturamentoMensal,
      statusCobrancas,
      topDevedores
    });

  } catch (err) {
    console.error("[GRAFICOS] erro:", err.message);
    return res.status(500).json({ 
      success: false, 
      message: "Erro ao carregar dados dos gráficos.", 
      error: err.message 
    });
  }
});
// ========================
// Rotas estáticas frontend
// ========================
function sendFront(file) {
  return (req, res) => {
    const target = path.join(FRONTEND_DIR, file);
    if (!fs.existsSync(target)) {
      return res.status(404).send("Arquivo não encontrado: " + file);
    }
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

// =====================================================
// NOVAS ROTAS - PÁGINAS ENTERPRISE
// =====================================================
app.get("/historico", sendFront("historico.html"));
app.get("/usuarios", sendFront("usuarios.html"));

// ===============================
// Fallback
// ===============================
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (req.path.includes(".")) {
    return res.status(404).send("Arquivo não encontrado");
  }
  return res.sendFile(path.join(FRONTEND_DIR, "login.html"));
});

// =====================
// APIs: cobranças
// =====================

app.get("/api/cobrancas", auth, async (req, res) => {
  try {
    const status = String(req.query.status || "").trim().toLowerCase();
    const q = String(req.query.q || "").trim();

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

    const sql = `
      SELECT
        c.id,
        COALESCE(cl.nome,'') AS cliente,
        COALESCE(cl.email,'') AS cliente_email,
        COALESCE(cl.telefone,'') AS cliente_telefone,
        c.cliente_id,
        c.descricao,
        c.valor_original  AS "valorOriginal",
        c.multa           AS "multa",
        c.juros           AS "juros",
        c.desconto        AS "desconto",
        c.valor_atualizado AS "valorAtualizado",
        c.status,
        c.vencimento,
        c.created_at      AS "createdAt"
      FROM cobrancas c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
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

app.post("/api/cobrancas", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const cliente = asStr(b.cliente || "");
    const clienteId = asStr(b.cliente_id || b.clienteId || "");
    const valorOriginal = round2(num(b.valor_original || b.valorOriginal));
    const vencimento = toPgDateOrNull(b.vencimento);

    if (!cliente && !clienteId) {
      return res.status(400).json({ success: false, message: "Cliente ou cliente ID são obrigatórios." });
    }
    if (!valorOriginal || !vencimento) {
      return res.status(400).json({ success: false, message: "Valor e vencimento são obrigatórios." });
    }

    let buscaCliente;
    if (clienteId) {
      buscaCliente = await pool.query("SELECT id FROM clientes WHERE id = $1 LIMIT 1", [clienteId]);
    } else {
      buscaCliente = await pool.query("SELECT id FROM clientes WHERE LOWER(nome) = LOWER($1) LIMIT 1", [cliente]);
    }

    if (!buscaCliente || buscaCliente.rowCount === 0) {
      return res.status(400).json({ success: false, message: "Cliente não encontrado." });
    }

    const multa = round2(num(b.multa, 0));
    const juros = round2(num(b.juros, 0));
    const desconto = round2(num(b.desconto, 0));
    const taxaPercent = num(String(b.taxaPercent || "").replace("%", ""));
    const taxaValor = round2((valorOriginal * taxaPercent) / 100);

    const valorAtualizado = round2(valorOriginal + multa + juros - desconto + taxaValor);
    const status = asStr(b.status || "pendente");

    const novaCobranca = await pool.query(
      `INSERT INTO cobrancas (cliente_id, descricao, valor_original, multa, juros, desconto, vencimento, status, valor_atualizado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        buscaCliente.rows[0].id,
        b.descricao || null,
        valorOriginal,
        multa,
        juros,
        desconto,
        vencimento,
        status,
        valorAtualizado,
      ]
    );

    // Registrar log
    await registrarLog(req, 'CRIAR', 'cobrancas', novaCobranca.rows[0].id, { cliente_id: buscaCliente.rows[0].id, valor: valorAtualizado });

    return res.json({ success: true, data: novaCobranca.rows[0] });
  } catch (err) {
    console.error("[POST /api/cobrancas] erro:", err);
    return res.status(500).json({
      success: false,
      message: "Erro ao salvar cobrança.",
      error: err?.message || String(err),
      detail: err?.detail || null,
      hint: err?.hint || null,
      code: err?.code || null,
    });
  }
});

app.put("/api/cobrancas/:id/status", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "").toLowerCase().trim();

    const allowed = new Set(["pago", "pendente", "vencido"]);
    if (!id) {
      return res.status(400).json({ success: false, message: "ID inválido." });
    }
    if (!allowed.has(status)) {
      return res.status(400).json({ success: false, message: "Status inválido." });
    }

    // Buscar status anterior
    const anterior = await pool.query("SELECT status FROM cobrancas WHERE id = $1", [id]);
    const statusAnterior = anterior.rows[0]?.status || null;

    const r = await pool.query(
      `UPDATE cobrancas SET status = $2 WHERE id = $1 RETURNING *`,
      [id, status]
    );

    if (!r.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }

    // Registrar log
    await registrarLog(req, 'ATUALIZAR_STATUS', 'cobrancas', id, { status_anterior: statusAnterior, status_novo: status });

    return res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error("[PUT /api/cobrancas/:id/status] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar status.", error: err.message });
  }
});

// =====================================================
// ENVIAR E-MAIL DE COBRANÇA
// =====================================================
app.post("/api/cobrancas/:id/enviar-email", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!emailTransporter) {
      return res.status(400).json({ success: false, message: "E-mail não configurado. Configure SMTP_USER e SMTP_PASS no .env" });
    }

    const q = await pool.query(
      `SELECT c.*, COALESCE(cl.nome, '') AS cliente_nome, COALESCE(cl.email, '') AS cliente_email
       FROM cobrancas c
       LEFT JOIN clientes cl ON cl.id = c.cliente_id
       WHERE c.id = $1::uuid LIMIT 1`,
      [id]
    );

    if (!q.rows.length) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }

    const cobranca = q.rows[0];

    if (!cobranca.cliente_email) {
      return res.status(400).json({ success: false, message: "Cliente não possui e-mail cadastrado." });
    }

    const idStr = String(cobranca.id);
    const refCode = `AC-C${idStr.slice(0, 2).toUpperCase()}D${idStr.slice(2, 6).toUpperCase()}`;

    const htmlEmail = gerarEmailCobrancaHTML({
      cliente: cobranca.cliente_nome,
      valor: fmtMoney(cobranca.valor_atualizado),
      vencimento: fmtDate(cobranca.vencimento),
      descricao: cobranca.descricao,
      status: cobranca.status,
      referencia: refCode,
    });

    const emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER;
    
    await emailTransporter.sendMail({
      from: `ACERTIVE <${emailFrom}>`,
      to: cobranca.cliente_email,
      subject: `📄 Cobrança ${refCode} - ${fmtMoney(cobranca.valor_atualizado)} - Vencimento: ${fmtDate(cobranca.vencimento)}`,
      html: htmlEmail,
    });

    console.log(`[EMAIL] ✅ Cobrança ${refCode} enviada para ${cobranca.cliente_email}`);

    // Registrar log
    await registrarLog(req, 'ENVIAR_EMAIL', 'cobrancas', id, { destinatario: cobranca.cliente_email });

    return res.json({ 
      success: true, 
      message: `E-mail enviado com sucesso para ${cobranca.cliente_email}!`,
      destinatario: cobranca.cliente_email
    });

  } catch (err) {
    console.error("[ENVIAR EMAIL] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao enviar e-mail.", error: err.message });
  }
});

// =====================================================
// GERAR LINK WHATSAPP
// =====================================================
app.get("/api/cobrancas/:id/whatsapp", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const q = await pool.query(
      `SELECT c.*, COALESCE(cl.nome, '') AS cliente_nome, COALESCE(cl.telefone, '') AS cliente_telefone
       FROM cobrancas c
       LEFT JOIN clientes cl ON cl.id = c.cliente_id
       WHERE c.id = $1::uuid LIMIT 1`,
      [id]
    );

    if (!q.rows.length) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }

    const cobranca = q.rows[0];

    const idStr = String(cobranca.id);
    const refCode = `AC-C${idStr.slice(0, 2).toUpperCase()}D${idStr.slice(2, 6).toUpperCase()}`;

    let telefone = String(cobranca.cliente_telefone || "").replace(/\D/g, "");
    
    if (telefone.length === 11 || telefone.length === 10) {
      telefone = "55" + telefone;
    }

    const mensagem = `Olá, *${cobranca.cliente_nome}*! 👋

📄 *COBRANÇA ACERTIVE*
━━━━━━━━━━━━━━━━━

📌 *Referência:* ${refCode}
💰 *Valor:* ${fmtMoney(cobranca.valor_atualizado)}
📅 *Vencimento:* ${fmtDate(cobranca.vencimento)}
📝 *Descrição:* ${cobranca.descricao || "—"}

⚠️ Evite juros e multas! Efetue o pagamento até a data de vencimento.

Qualquer dúvida, estamos à disposição!

_Mensagem enviada pelo sistema ACERTIVE_`;

    const link = `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;

    // Registrar log
    await registrarLog(req, 'GERAR_WHATSAPP', 'cobrancas', id, { telefone });

    return res.json({
      success: true,
      link,
      telefone,
      mensagem,
    });

  } catch (err) {
    console.error("[WHATSAPP] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar link WhatsApp.", error: err.message });
  }
});

// =====================================================
// GERAR MENSAGEM COM IA (OpenAI)
// =====================================================
app.post("/api/cobrancas/:id/gerar-mensagem-ia", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const { tipo = 'whatsapp', tom = 'profissional' } = req.body || {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ success: false, message: "IA não configurada. Configure OPENAI_API_KEY no ambiente." });
    }

    const q = await pool.query(
      `SELECT c.*, COALESCE(cl.nome, '') AS cliente_nome, COALESCE(cl.email, '') AS cliente_email
       FROM cobrancas c
       LEFT JOIN clientes cl ON cl.id = c.cliente_id
       WHERE c.id = $1::uuid LIMIT 1`,
      [id]
    );

    if (!q.rows.length) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }

    const cobranca = q.rows[0];
    const idStr = String(cobranca.id);
    const refCode = `AC-C${idStr.slice(0, 2).toUpperCase()}D${idStr.slice(2, 6).toUpperCase()}`;

    const tomDescricao = {
      'profissional': 'tom profissional e formal',
      'amigavel': 'tom amigável e cordial',
      'firme': 'tom firme mas respeitoso, enfatizando a urgência'
    };

    const tipoDescricao = tipo === 'email' 
      ? 'um e-mail profissional de cobrança' 
      : 'uma mensagem de WhatsApp de cobrança';

    const prompt = `Você é um assistente de cobranças da empresa ACERTIVE. 
Gere ${tipoDescricao} com ${tomDescricao[tom] || tomDescricao['profissional']}.

DADOS DA COBRANÇA:
- Cliente: ${cobranca.cliente_nome}
- Valor: ${fmtMoney(cobranca.valor_atualizado)}
- Vencimento: ${fmtDate(cobranca.vencimento)}
- Descrição: ${cobranca.descricao || 'Cobrança'}
- Referência: ${refCode}
- Status: ${cobranca.status}

REGRAS:
1. ${tipo === 'whatsapp' ? 'Use formatação WhatsApp (*negrito*, _itálico_) e emojis moderadamente' : 'Mantenha formato de e-mail profissional com saudação e assinatura'}
2. Seja ${tom === 'firme' ? 'direto e enfático sobre a necessidade de pagamento' : 'cordial e educado'}
3. Mencione o valor e vencimento claramente
4. ${cobranca.status === 'vencido' ? 'Enfatize que a cobrança está VENCIDA e há urgência' : 'Lembre sobre a data de vencimento'}
5. Finalize oferecendo ajuda para dúvidas
6. Não invente dados que não foram fornecidos

Gere apenas a mensagem, sem explicações adicionais.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("[IA] Erro OpenAI:", errorData);
      return res.status(500).json({ success: false, message: "Erro ao gerar mensagem com IA.", error: errorData.error?.message || 'Erro na API OpenAI' });
    }

    const data = await response.json();
    const mensagemGerada = data.choices?.[0]?.message?.content || '';

    if (!mensagemGerada) {
      return res.status(500).json({ success: false, message: "IA não retornou mensagem." });
    }

    // Registrar log
    await registrarLog(req, 'GERAR_MENSAGEM_IA', 'cobrancas', id, { tipo, tom });

    return res.json({
      success: true,
      mensagem: mensagemGerada,
      tipo,
      tom,
      referencia: refCode
    });

  } catch (err) {
    console.error("[IA MENSAGEM] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar mensagem com IA.", error: err.message });
  }
});

// Status da IA
app.get("/api/config/ia-status", auth, (req, res) => {
  return res.json({
    success: true,
    iaConfigurada: !!process.env.OPENAI_API_KEY,
    modelo: 'gpt-4o-mini'
  });
});

// =====================================================
// GERAR PDF DE COBRANÇA
// =====================================================
app.get("/api/cobrancas/:id/pdf", auth, async (req, res) => {
  let browser = null;
  try {
    const id = String(req.params.id || "").trim();

    const q = await pool.query(
      `SELECT c.*, COALESCE(cl.nome, '') AS cliente
       FROM cobrancas c
       LEFT JOIN clientes cl ON cl.id = c.cliente_id
       WHERE c.id = $1::uuid LIMIT 1`,
      [id]
    );

    if (!q.rows.length) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }

    const r = q.rows[0];
    const esc = (s) => String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const idStr = String(r.id);
    const refCode2 = `AC-C${idStr.slice(0, 2).toUpperCase()}D${idStr.slice(2, 6).toUpperCase()}`;
    const statusLabel2 = (r.status || "pendente").toUpperCase();
    const badgeClass2 = r.status === "pago" ? "pago" : r.status === "vencido" ? "vencido" : "pendente";
    const valorOriginal2 = Number(r.valor_original || 0);
    const multa2 = Number(r.multa || 0);
    const juros2 = Number(r.juros || 0);
    const desconto2 = Number(r.desconto || 0);
    const valorAtualizado2 = Number(r.valor_atualizado || 0);
    const ajustes2 = multa2 + juros2 - desconto2;

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>Cobrança ${refCode2}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
@page{size:A4;margin:0}
body{font-family:'Montserrat',sans-serif;background:#fff;color:#2c3e50;padding:50px;line-height:1.6}
.header{background:linear-gradient(135deg,#1a1a1a 0%,#2d2d2d 100%);padding:35px 40px;border-radius:20px;margin-bottom:35px;box-shadow:0 10px 30px rgba(0,0,0,.3);border-left:8px solid #F6C84C;position:relative;overflow:hidden}
.header::before{content:'';position:absolute;top:-50px;right:-50px;width:200px;height:200px;background:radial-gradient(circle,rgba(246,200,76,.15) 0%,transparent 70%);border-radius:50%}
.header-content{display:flex;justify-content:space-between;align-items:flex-start;position:relative;z-index:1}
.logo-section{display:flex;align-items:center;gap:20px}
.logo{width:80px;height:80px;background:linear-gradient(135deg,#F6C84C,#FFD56A);border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:900;color:#1a1a1a;box-shadow:0 10px 25px rgba(246,200,76,.5)}
.title-section h1{color:#fff;font-size:32px;font-weight:900;margin-bottom:8px;letter-spacing:.8px}
.title-section h2{color:#F6C84C;font-size:16px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase}
.header-info{text-align:right}
.info-row{margin-bottom:10px;font-size:14px}
.info-label{color:#9ca3af;font-weight:700;margin-right:10px;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.info-value{color:#fff;font-weight:900;font-size:15px}
.status-badge{display:inline-block;padding:8px 18px;border-radius:25px;font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase}
.status-badge.pago{background:#dcfce7;color:#166534;border:2px solid #16a34a}
.status-badge.pendente{background:#fef3c7;color:#854d0e;border:2px solid #F6C84C}
.status-badge.vencido{background:#fee2e2;color:#991b1b;border:2px solid #dc2626}
.valores-section{margin-bottom:35px}
.section-title{color:#1a1a1a;font-size:18px;font-weight:900;margin-bottom:20px;padding-bottom:10px;border-bottom:3px solid #F6C84C;display:flex;align-items:center;gap:10px}
.valores-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.valor-card{background:linear-gradient(135deg,#f8f9fa 0%,#e9ecef 100%);border:2px solid #d1d5db;border-radius:16px;padding:22px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.08)}
.valor-label{color:#6b7280;font-size:11px;text-transform:uppercase;font-weight:800;letter-spacing:.8px;margin-bottom:12px}
.valor-amount{color:#1a1a1a;font-size:24px;font-weight:900;letter-spacing:-.5px}
.valor-card.destaque{background:linear-gradient(135deg,#F6C84C,#FFD56A);border-color:#F6C84C}
.valor-card.destaque .valor-label{color:#1a1a1a}
.valor-card.destaque .valor-amount{color:#1a1a1a;font-size:28px}
.dados-section{background:linear-gradient(135deg,#f8f9fa 0%,#fff 100%);border:2px solid #d1d5db;border-radius:16px;padding:30px;margin-bottom:30px}
.dados-grid{display:grid;grid-template-columns:140px 1fr;gap:15px;align-items:center}
.dados-label{color:#6b7280;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.5px}
.dados-value{color:#1a1a1a;font-size:15px;font-weight:700}
.dados-value.highlight{color:#1a1a1a;font-size:18px;font-weight:900}
.resumo-section{background:linear-gradient(135deg,#fef3c7 0%,#fef9e7 100%);border:2px solid #F6C84C;border-radius:16px;padding:30px;margin-bottom:30px}
.resumo-table{width:100%;border-collapse:collapse}
.resumo-table td{padding:12px 0;border-bottom:1px solid rgba(0,0,0,.08);color:#6b7280;font-size:14px}
.resumo-table tr:last-child td{border-bottom:none}
.resumo-table td:last-child{text-align:right;color:#1a1a1a;font-weight:900;font-size:17px}
.resumo-total{background:linear-gradient(135deg,#F6C84C,#FFD56A);color:#1a1a1a!important;font-size:24px!important;border-radius:12px;font-weight:900!important}
.resumo-total td{color:#1a1a1a!important;padding:20px!important}
.footer{margin-top:50px;padding-top:25px;border-top:3px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center}
.footer-info p{color:#6b7280;font-size:13px;margin-bottom:6px;font-weight:600}
.footer-info strong{color:#1a1a1a;font-weight:900}
.footer-logo{display:flex;align-items:center;gap:12px}
.footer-logo-icon{width:50px;height:50px;background:linear-gradient(135deg,#F6C84C,#FFD56A);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#1a1a1a;font-size:26px;font-weight:900;box-shadow:0 4px 12px rgba(246,200,76,.3)}
.footer-logo-text{color:#1a1a1a;font-size:22px;font-weight:900;letter-spacing:.8px}
.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:120px;color:rgba(246,200,76,.03);font-weight:900;letter-spacing:20px;pointer-events:none;z-index:-1}
.unique-id{text-align:center;margin:30px 0;padding:15px;background:linear-gradient(90deg,transparent,rgba(246,200,76,.1),transparent);border-top:1px solid rgba(246,200,76,.3);border-bottom:1px solid rgba(246,200,76,.3)}
.unique-id-label{color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.unique-id-value{color:#1a1a1a;font-family:'Courier New',monospace;font-size:13px;font-weight:700;letter-spacing:1px}
</style>
</head>
<body>
<div class="watermark">ACERTIVE</div>
<div class="header">
<div class="header-content">
<div class="logo-section">
<div class="logo">A</div>
<div class="title-section">
<h1>ACERTIVE</h1>
<h2>Documento de Cobrança</h2>
</div>
</div>
<div class="header-info">
<div class="info-row"><span class="info-label">Referência:</span><span class="info-value">${refCode2}</span></div>
<div class="info-row"><span class="info-label">Status:</span><span class="status-badge ${badgeClass2}">${statusLabel2}</span></div>
<div class="info-row"><span class="info-label">Gerado em:</span><span class="info-value">${fmtDateTime(new Date())}</span></div>
</div>
</div>
</div>
<div class="valores-section">
<h3 class="section-title">💰 Valores da Cobrança</h3>
<div class="valores-grid">
<div class="valor-card destaque"><div class="valor-label">Valor Atualizado</div><div class="valor-amount">${fmtMoney(valorAtualizado2)}</div></div>
<div class="valor-card"><div class="valor-label">Vencimento</div><div class="valor-amount">${fmtDate(r.vencimento)}</div></div>
<div class="valor-card"><div class="valor-label">Valor Original</div><div class="valor-amount">${fmtMoney(valorOriginal2)}</div></div>
<div class="valor-card"><div class="valor-label">Ajustes</div><div class="valor-amount">${fmtMoney(ajustes2)}</div></div>
</div>
</div>
<div class="dados-section">
<h3 class="section-title">📋 Dados da Cobrança</h3>
<div class="dados-grid">
<div class="dados-label">Cliente</div><div class="dados-value highlight">${esc(r.cliente)}</div>
<div class="dados-label">Descrição</div><div class="dados-value">${esc(r.descricao)}</div>
<div class="dados-label">Criada em</div><div class="dados-value">${fmtDateTime(r.created_at)}</div>
</div>
</div>
<div class="unique-id">
<div class="unique-id-label">ID do Documento</div>
<div class="unique-id-value">#c${String(id).slice(0,8)}-${Date.now().toString(36).toUpperCase()}</div>
</div>
<div class="resumo-section">
<h3 class="section-title" style="border-color:#F6C84C;color:#854d0e">📊 Resumo Financeiro</h3>
<p style="color:#854d0e;font-size:13px;margin-bottom:20px;font-weight:700;text-align:right">Detalhes</p>
<table class="resumo-table">
<tr><td>Valor original</td><td>${fmtMoney(valorOriginal2)}</td></tr>
<tr><td>Juros</td><td>${fmtMoney(juros2)}</td></tr>
<tr><td>Multa (2%)</td><td>${fmtMoney(multa2)}</td></tr>
<tr><td>Desconto</td><td>${fmtMoney(desconto2)}</td></tr>
<tr class="resumo-total"><td>Total atualizado</td><td>${fmtMoney(valorAtualizado2)}</td></tr>
</table>
</div>
<div class="footer">
<div class="footer-info">
<p><strong>Gerado por:</strong> Sistema ACERTIVE</p>
<p><strong>Data de geração:</strong> ${fmtDateTime(new Date())}</p>
<p><strong>Usuário:</strong> ${req.user?.nome || "Administrador"}</p>
</div>
<div class="footer-logo">
<div class="footer-logo-icon">A</div>
<div class="footer-logo-text">ACERTIVE</div>
</div>
</div>
</body>
</html>`;

    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    await browser.close();
    browser = null;

    // Registrar log
    await registrarLog(req, 'GERAR_PDF', 'cobrancas', id, null);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="cobranca_${refCode2}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    console.error("[COBRANCA PDF] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar PDF da cobrança.", error: err.message });
  }
});

app.delete("/api/cobrancas/:id", auth, async (req, res) => {
  const { id } = req.params;
  try {
    const resultado = await pool.query("DELETE FROM cobrancas WHERE id = $1 RETURNING *", [id]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Cobrança não encontrada" });

    // Registrar log
    await registrarLog(req, 'EXCLUIR', 'cobrancas', id, null);

    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[DELETE /api/cobrancas/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao remover cobrança", error: err.message });
  }
});

// =====================
// APIs: clientes
// =====================

app.get("/api/clientes-ativos", async (req, res) => {
  try {
    const resultado = await pool.query("SELECT * FROM clientes WHERE status = 'ativo' ORDER BY created_at DESC");
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/clientes-ativos] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar clientes ativos.", error: err.message });
  }
});

app.post("/api/clientes", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const nome = String(b.nome || "").trim();
    const email = String(b.email || "").trim();
    const telefone = String(b.telefone || "").trim();
    const cpf_cnpj = String(b.cpf_cnpj || b.cpfCnpj || "").trim();
    const endereco = String(b.endereco || "").trim();
    const observacoes = String(b.observacoes || "").trim();

    if (!nome) return res.status(400).json({ success: false, message: "Nome é obrigatório." });

    const r = await pool.query(
      `INSERT INTO clientes (nome, email, telefone, cpf_cnpj, endereco, status, observacoes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [nome, email || null, telefone || null, cpf_cnpj || null, endereco || null, "ativo", observacoes || null]
    );

    // Registrar log
    await registrarLog(req, 'CRIAR', 'clientes', r.rows[0].id, { nome });

    return res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error("[POST /api/clientes] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao criar cliente.", error: err.message });
  }
});

app.put("/api/clientes/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { nome, email, telefone, status, tipo, cpf_cnpj, endereco, observacoes } = req.body || {};
  if (!id) return res.status(400).json({ success: false, message: "id é obrigatório" });

  try {
    const result = await pool.query(
      `UPDATE clientes SET nome = COALESCE($1, nome), email = COALESCE($2, email), telefone = COALESCE($3, telefone),
       status = COALESCE($4, status), tipo = COALESCE($5, tipo), cpf_cnpj = COALESCE($6, cpf_cnpj),
       endereco = COALESCE($7, endereco), observacoes = COALESCE($8, observacoes), updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [nome, email, telefone, status, tipo, cpf_cnpj, endereco, observacoes, id]
    );

    if (!result.rowCount) return res.status(404).json({ success: false, message: "Cliente não encontrado" });

    // Registrar log
    await registrarLog(req, 'ATUALIZAR', 'clientes', id, { nome });

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("[PUT /api/clientes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar cliente", error: err.message });
  }
});

app.delete("/api/clientes/:id", auth, async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ success: false, message: "id é obrigatório" });

  try {
    const result = await pool.query(
      "UPDATE clientes SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
      ["inativo", id]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, message: "Cliente não encontrado" });

    // Registrar log
    await registrarLog(req, 'DESATIVAR', 'clientes', id, null);

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("[DELETE /api/clientes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao excluir cliente", error: err.message });
  }
});

// =====================
// IMPORTAÇÃO Excel/CSV
// =====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

app.post("/api/clientes/import", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Arquivo não enviado (campo 'file')." });
    }

    const filename = (req.file.originalname || "").toLowerCase();
    const isCsv = filename.endsWith(".csv");
    let rows = [];

    if (isCsv) {
      const text = req.file.buffer.toString("utf-8");
      const sep = text.includes(";") ? ";" : ",";
      const lines = text.split(/\r?\n/).filter((l) => l && l.trim().length);
      if (lines.length < 2) {
        return res.status(400).json({ success: false, message: "CSV vazio ou inválido." });
      }
      const headers = lines.shift().split(sep).map((h) => h.trim());
      rows = lines.map((line) => {
        const cols = line.split(sep);
        const obj = {};
        headers.forEach((h, i) => (obj[h] = (cols[i] ?? "").trim()));
        return obj;
      });
    } else {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    }

    if (!rows.length) {
      return res.status(400).json({ success: false, message: "Planilha vazia ou inválida." });
    }

    const norm = (s) =>
      String(s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

    const pick = (obj, keys) => {
      const keyMap = new Map(Object.keys(obj).map((k) => [norm(k), obj[k]]));
      for (const k of keys) {
        const v = keyMap.get(norm(k));
        if (v !== undefined && String(v).trim() !== "") return String(v).trim();
      }
      return "";
    };

    let imported = 0, skipped = 0, duplicates = 0;
    const errors = [];

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
        if (cpf_cnpj_digits) {
          const q = await pool.query(
            "SELECT id FROM clientes WHERE regexp_replace(coalesce(cpf_cnpj,''), '\\D', '', 'g') = $1 LIMIT 1",
            [cpf_cnpj_digits]
          );
          exists = q.rowCount > 0;
        } else if (email) {
          const q = await pool.query("SELECT id FROM clientes WHERE lower(email) = lower($1) LIMIT 1", [email]);
          exists = q.rowCount > 0;
        }

        if (exists) { duplicates++; continue; }

        await pool.query(
          `INSERT INTO clientes (nome, email, telefone, cpf_cnpj, endereco, status, observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [nome, email || null, telefone || null, cpf_cnpj_raw || null, null, "ativo", null]
        );
        imported++;
      } catch (errRow) {
        errors.push({ line: i + 1, error: errRow?.message ? errRow.message : String(errRow) });
      }
    }

    // Registrar log
    await registrarLog(req, 'IMPORTAR', 'clientes', null, { imported, skipped, duplicates });

    return res.json({ success: true, imported, skipped, duplicates, errors });
  } catch (err) {
    console.error("[IMPORT CLIENTES] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao importar planilha.", error: err.message });
  }
});

// =====================
// RELATÓRIO CSV
// =====================
app.get("/api/relatorios/export-csv", auth, async (req, res) => {
  try {
    const start = (req.query.start || "").trim();
    const end = (req.query.end || "").trim();
    const hasRange = start && end;

    const qRecebido = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'pago'
       ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qPendente = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'pendente'
       ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qVencido = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'vencido'
       ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qCountCobrancas = await pool.query(
      `SELECT COUNT(*)::int AS total FROM cobrancas ${hasRange ? "WHERE vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qClientesAtivos = await pool.query(`SELECT COUNT(*)::int AS total FROM clientes WHERE status = 'ativo'`);

    const qRows = await pool.query(
      `SELECT c.id, COALESCE(cl.nome, '') AS cliente, c.descricao, c.valor_original, c.multa, c.juros, c.desconto,
       c.valor_atualizado, c.status, c.vencimento, c.created_at
       FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id
       ${hasRange ? "WHERE c.vencimento BETWEEN $1 AND $2" : ""}
       ORDER BY c.created_at DESC`,
      hasRange ? [start, end] : []
    );

    const esc = (v) => {
      const s = String(v ?? "");
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const fmtMoneyCsv = (n) => Number(n || 0).toFixed(2).replace(".", ",");
    const fmtDateCsv = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return String(d);
      const dd = String(dt.getDate()).padStart(2, "0");
      const mm = String(dt.getMonth() + 1).padStart(2, "0");
      const yy = dt.getFullYear();
      return `${dd}/${mm}/${yy}`;
    };

    const periodLabel = hasRange ? `${start} a ${end}` : "Todos";
    const lines = [];

    lines.push("RELATORIO ACERTIVE");
    lines.push(`Periodo,${esc(periodLabel)}`);
    lines.push("");
    lines.push("RESUMO");
    lines.push(`Clientes Ativos,${qClientesAtivos.rows[0]?.total ?? 0}`);
    lines.push(`Cobranças Emitidas,${qCountCobrancas.rows[0]?.total ?? 0}`);
    lines.push(`Total Recebido (Pago),${fmtMoneyCsv(qRecebido.rows[0]?.total)}`);
    lines.push(`Total Pendente,${fmtMoneyCsv(qPendente.rows[0]?.total)}`);
    lines.push(`Total Vencido,${fmtMoneyCsv(qVencido.rows[0]?.total)}`);
    lines.push("");
    lines.push("DETALHAMENTO");
    lines.push(["ID","Cliente","Descricao","Valor Original","Multa","Juros","Desconto","Valor Atualizado","Status","Vencimento","Criado Em"].join(","));

    for (const r of qRows.rows) {
      lines.push([
        esc(String(r.id).slice(0,8)),
        esc(r.cliente),
        esc(r.descricao || ""),
        fmtMoneyCsv(r.valor_original),
        fmtMoneyCsv(r.multa),
        fmtMoneyCsv(r.juros),
        fmtMoneyCsv(r.desconto),
        fmtMoneyCsv(r.valor_atualizado),
        esc(r.status),
        fmtDateCsv(r.vencimento),
        fmtDateCsv(r.created_at)
      ].join(","));
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

// =====================
// RELATÓRIO PDF
// =====================
app.get("/api/relatorios/export-pdf", auth, async (req, res) => {
  let browser = null;
  try {
    const start = (req.query.start || "").trim();
    const end = (req.query.end || "").trim();
    const hasRange = start && end;

    const qRecebido = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'pago' ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qPendente = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'pendente' ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qVencido = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'vencido' ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qCountCobrancas = await pool.query(
      `SELECT COUNT(*)::int AS total FROM cobrancas ${hasRange ? "WHERE vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qClientesAtivos = await pool.query(`SELECT COUNT(*)::int AS total FROM clientes WHERE status = 'ativo'`);

    const qRows = await pool.query(
      `SELECT c.id, COALESCE(cl.nome, '') AS cliente, c.descricao, c.valor_original, c.multa, c.juros, c.desconto, c.valor_atualizado, c.status, c.vencimento, c.created_at FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id ${hasRange ? "WHERE c.vencimento BETWEEN $1 AND $2" : ""} ORDER BY c.created_at DESC`,
      hasRange ? [start, end] : []
    );

    const periodLabel = hasRange ? `${fmtDate(start)} a ${fmtDate(end)}` : "Todos os períodos";
    const totalRecebido = fmtMoney(qRecebido.rows[0]?.total);
    const totalPendente = fmtMoney(qPendente.rows[0]?.total);
    const totalVencido = fmtMoney(qVencido.rows[0]?.total);
    const totalCobrancas = qCountCobrancas.rows[0]?.total ?? 0;
    const totalClientes = qClientesAtivos.rows[0]?.total ?? 0;

    const esc = (s) => String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const rowsHtml = qRows.rows.map((r) => {
      const badgeClass = r.status === "pago" ? "pago" : r.status === "vencido" ? "vencido" : "pendente";
      return `<tr><td class="mono">${esc(String(r.id).slice(0,8))}</td><td><div class="strong">${esc(r.cliente)}</div><div class="muted small">${esc(r.descricao || "—")}</div></td><td>${fmtDate(r.vencimento)}</td><td>${fmtMoney(r.valor_original)}</td><td>${fmtMoney(r.juros)}</td><td>${fmtMoney(r.multa)}</td><td class="strong">${fmtMoney(r.valor_atualizado)}</td><td><span class="badge ${badgeClass}">${String(r.status || "").toUpperCase()}</span></td></tr>`;
    }).join("");

    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"/><title>Relatório ACERTIVE</title><style>*{margin:0;padding:0;box-sizing:border-box}@page{size:A4;margin:0}body{font-family:sans-serif;background:#fff;color:#2c3e50;padding:50px;line-height:1.6}.header{background:linear-gradient(135deg,#1a1a1a,#2d2d2d);padding:35px 40px;border-radius:20px;margin-bottom:35px;border-left:8px solid #F6C84C}.header-content{display:flex;justify-content:space-between;align-items:flex-start}.logo-section{display:flex;align-items:center;gap:20px}.logo{width:80px;height:80px;background:linear-gradient(135deg,#F6C84C,#FFD56A);border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:900;color:#1a1a1a}.title-section h1{color:#fff;font-size:32px;font-weight:900}.title-section h2{color:#F6C84C;font-size:16px}.header-info{text-align:right}.info-row{margin-bottom:10px;font-size:14px}.info-label{color:#9ca3af;font-weight:700;margin-right:10px}.info-value{color:#fff;font-weight:900}.kpis-section{margin-bottom:35px}.section-title{color:#1a1a1a;font-size:18px;font-weight:900;margin-bottom:20px;padding-bottom:10px;border-bottom:3px solid #F6C84C}.kpis-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}.kpi-card{background:#f8f9fa;border:2px solid #d1d5db;border-radius:16px;padding:22px;text-align:center}.kpi-label{color:#6b7280;font-size:11px;font-weight:800;margin-bottom:12px}.kpi-value{color:#1a1a1a;font-size:24px;font-weight:900}.kpi-card.recebido{background:#dcfce7;border-color:#4CAF50}.kpi-card.recebido .kpi-value{color:#166534}.kpi-card.pendente{background:#fef3c7;border-color:#F6C84C}.kpi-card.pendente .kpi-value{color:#854d0e}.kpi-card.vencido{background:#fee2e2;border-color:#F44336}.kpi-card.vencido .kpi-value{color:#991b1b}.table-section{background:#f8f9fa;border:2px solid #d1d5db;border-radius:16px;padding:30px;margin-bottom:30px}table{width:100%;border-collapse:collapse;font-size:11px}thead th{background:#1a1a1a;color:#F6C84C;padding:14px 12px;text-align:left;font-weight:900;font-size:10px}tbody tr{border-bottom:1px solid #e5e7eb}tbody td{padding:12px;color:#374151}.badge{display:inline-block;padding:5px 10px;border-radius:20px;font-size:10px;font-weight:900}.badge.pago{background:#dcfce7;color:#166534}.badge.pendente{background:#fef3c7;color:#854d0e}.badge.vencido{background:#fee2e2;color:#991b1b}.mono{font-family:monospace;font-size:10px}.strong{font-weight:900}.muted{color:#9ca3af}.small{font-size:10px}.footer{margin-top:40px;padding-top:25px;border-top:3px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center}.footer-info p{color:#6b7280;font-size:13px;margin-bottom:6px}.footer-logo{display:flex;align-items:center;gap:12px}.footer-logo-icon{width:50px;height:50px;background:linear-gradient(135deg,#F6C84C,#FFD56A);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#1a1a1a;font-size:26px;font-weight:900}.footer-logo-text{color:#1a1a1a;font-size:22px;font-weight:900}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:120px;color:rgba(246,200,76,.03);font-weight:900;pointer-events:none;z-index:-1}</style></head><body><div class="watermark">ACERTIVE</div><div class="header"><div class="header-content"><div class="logo-section"><div class="logo">A</div><div class="title-section"><h1>ACERTIVE</h1><h2>Relatório de Cobranças</h2></div></div><div class="header-info"><div class="info-row"><span class="info-label">Período:</span><span class="info-value">${periodLabel}</span></div><div class="info-row"><span class="info-label">Gerado em:</span><span class="info-value">${new Date().toLocaleDateString("pt-BR")}</span></div></div></div></div><div class="kpis-section"><h3 class="section-title">💰 Indicadores Financeiros</h3><div class="kpis-grid"><div class="kpi-card recebido"><div class="kpi-label">Total Recebido</div><div class="kpi-value">${totalRecebido}</div></div><div class="kpi-card pendente"><div class="kpi-label">Total Pendente</div><div class="kpi-value">${totalPendente}</div></div><div class="kpi-card vencido"><div class="kpi-label">Total Vencido</div><div class="kpi-value">${totalVencido}</div></div><div class="kpi-card"><div class="kpi-label">Clientes / Cobranças</div><div class="kpi-value">${totalClientes} / ${totalCobrancas}</div></div></div></div><div class="table-section"><h3 class="section-title">📋 Detalhamento (${qRows.rows.length} registros)</h3><table><thead><tr><th>ID</th><th>Cliente / Descrição</th><th>Vencimento</th><th>Original</th><th>Juros</th><th>Multa</th><th>Atualizado</th><th>Status</th></tr></thead><tbody>${rowsHtml || '<tr><td colspan="8" style="text-align:center;padding:40px">Nenhuma cobrança encontrada.</td></tr>'}</tbody></table></div><div class="footer"><div class="footer-info"><p><strong>Gerado por:</strong> Sistema ACERTIVE</p><p><strong>Data/hora:</strong> ${new Date().toLocaleString("pt-BR")}</p><p><strong>Usuário:</strong> ${req.user?.nome || 'Administrador'}</p></div><div class="footer-logo"><div class="footer-logo-icon">A</div><div class="footer-logo-text">ACERTIVE</div></div></div></body></html>`;

    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    await browser.close();
    browser = null;

    const fileName = hasRange ? `relatorio_acertive_${start}_a_${end}.pdf` : `relatorio_acertive_completo.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    console.error("[RELATORIO PDF] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao exportar relatório (PDF).", error: err.message });
  }
});

// =====================================================
// BUSCA AVANÇADA DE COBRANÇAS (ENTERPRISE)
// =====================================================
app.get("/api/cobrancas/busca-avancada", auth, async (req, res) => {
  try {
    const { cliente, status, dataInicio, dataFim, valorMin, valorMax, ordem = 'created_at', direcao = 'DESC', limite = 100 } = req.query;

    const params = [];
    const where = [];

    if (cliente) { params.push(`%${cliente}%`); where.push(`LOWER(cl.nome) LIKE LOWER($${params.length})`); }
    if (status) { params.push(status.toLowerCase()); where.push(`LOWER(c.status) = $${params.length}`); }
    if (dataInicio) { params.push(dataInicio); where.push(`c.vencimento >= $${params.length}`); }
    if (dataFim) { params.push(dataFim); where.push(`c.vencimento <= $${params.length}`); }
    if (valorMin) { params.push(parseFloat(valorMin)); where.push(`c.valor_atualizado >= $${params.length}`); }
    if (valorMax) { params.push(parseFloat(valorMax)); where.push(`c.valor_atualizado <= $${params.length}`); }

    const ordenacaoPermitida = ['created_at', 'vencimento', 'valor_atualizado', 'status'];
    const ordemSanitizada = ordenacaoPermitida.includes(ordem) ? ordem : 'created_at';
    const direcaoSanitizada = direcao.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const limiteSanitizado = Math.min(parseInt(limite) || 100, 1000);

    const sql = `
      SELECT c.id, COALESCE(cl.nome,'') AS cliente, COALESCE(cl.email,'') AS cliente_email, c.cliente_id, c.descricao,
        c.valor_original AS "valorOriginal", c.multa, c.juros, c.desconto, c.valor_atualizado AS "valorAtualizado",
        c.status, c.vencimento, c.created_at AS "createdAt"
      FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.${ordemSanitizada} ${direcaoSanitizada} LIMIT ${limiteSanitizado}`;

    const resultado = await pool.query(sql, params);
    const sqlTotais = `SELECT COUNT(*)::int AS quantidade, COALESCE(SUM(c.valor_atualizado), 0)::numeric AS valor_total
      FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    const totais = await pool.query(sqlTotais, params);

    return res.json({ success: true, data: resultado.rows, totais: { quantidade: totais.rows[0]?.quantidade || 0, valorTotal: parseFloat(totais.rows[0]?.valor_total || 0) }});
  } catch (err) {
    console.error("[BUSCA AVANÇADA] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro na busca avançada.", error: err.message });
  }
});

// =====================================================
// HISTÓRICO DE AÇÕES (AUDITORIA - ENTERPRISE)
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

    const sql = `SELECT id, usuario_id, usuario_nome, acao, entidade, entidade_id, detalhes, ip, created_at
      FROM logs_acoes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${limiteSanitizado} OFFSET ${offsetSanitizado}`;

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
// GESTÃO DE USUÁRIOS (ADMIN ONLY - ENTERPRISE)
// =====================================================

// Listar usuários
app.get("/api/usuarios", authAdmin, async (req, res) => {
  try {
    const resultado = await pool.query(`SELECT id, nome, email, nivel, ativo, created_at, updated_at FROM users ORDER BY created_at DESC`);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/usuarios] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar usuários.", error: err.message });
  }
});

// Usuário atual
app.get("/api/usuarios/me", auth, async (req, res) => {
  try {
    const resultado = await pool.query("SELECT id, nome, email, nivel, ativo, created_at FROM users WHERE id = $1", [req.user.userId]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Usuário não encontrado." });
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[GET /api/usuarios/me] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar usuário.", error: err.message });
  }
});

// Criar usuário
app.post("/api/usuarios", authAdmin, async (req, res) => {
  try {
    const { nome, email, senha, nivel = 'operador' } = req.body || {};
    if (!nome || !email || !senha) return res.status(400).json({ success: false, message: "Nome, email e senha são obrigatórios." });

    const existe = await pool.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    if (existe.rowCount > 0) return res.status(400).json({ success: false, message: "E-mail já cadastrado." });

    const senhaHash = await bcrypt.hash(senha, 10);
    const resultado = await pool.query(
      `INSERT INTO users (nome, email, senha_hash, nivel, ativo, created_at, updated_at) VALUES ($1, $2, $3, $4, true, NOW(), NOW()) RETURNING id, nome, email, nivel, ativo, created_at`,
      [nome, email, senhaHash, nivel]
    );

    await registrarLog(req, 'CRIAR', 'users', resultado.rows[0].id, { email });
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[POST /api/usuarios] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao criar usuário.", error: err.message });
  }
});

// Atualizar usuário
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

    const resultado = await pool.query(
      `UPDATE users SET nome = COALESCE($1, nome), email = COALESCE($2, email), senha_hash = $3, nivel = COALESCE($4, nivel), ativo = COALESCE($5, ativo), updated_at = NOW() WHERE id = $6 RETURNING id, nome, email, nivel, ativo, created_at, updated_at`,
      [nome, email, senhaHash, nivel, ativo, id]
    );

    await registrarLog(req, 'ATUALIZAR', 'users', id, { alteracoes: { nome, email, nivel, ativo } });
    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[PUT /api/usuarios/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar usuário.", error: err.message });
  }
});

// Desativar usuário
app.delete("/api/usuarios/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.userId) return res.status(400).json({ success: false, message: "Você não pode desativar sua própria conta." });

    const resultado = await pool.query(`UPDATE users SET ativo = false, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
    if (!resultado.rowCount) return res.status(404).json({ success: false, message: "Usuário não encontrado." });

    await registrarLog(req, 'DESATIVAR', 'users', id, null);
    return res.json({ success: true, message: "Usuário desativado com sucesso." });
  } catch (err) {
    console.error("[DELETE /api/usuarios/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao desativar usuário.", error: err.message });
  }
});

// =====================================================
// BACKUP / EXPORTAÇÃO EXCEL (ADMIN ONLY - ENTERPRISE)
// =====================================================
app.get("/api/backup/exportar", authAdmin, async (req, res) => {
  try {
    const clientes = await pool.query("SELECT * FROM clientes ORDER BY created_at DESC");
    const cobrancas = await pool.query(`SELECT c.*, COALESCE(cl.nome, '') AS cliente_nome FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id ORDER BY c.created_at DESC`);

    const wb = XLSX.utils.book_new();

    const wsClientes = XLSX.utils.json_to_sheet(clientes.rows.map(c => ({
      ID: c.id, Nome: c.nome, Email: c.email, Telefone: c.telefone, 'CPF/CNPJ': c.cpf_cnpj,
      Endereco: c.endereco, Status: c.status, Observacoes: c.observacoes,
      'Criado em': c.created_at ? new Date(c.created_at).toLocaleString('pt-BR') : ''
    })));
    XLSX.utils.book_append_sheet(wb, wsClientes, "Clientes");

    const wsCobrancas = XLSX.utils.json_to_sheet(cobrancas.rows.map(c => ({
      ID: c.id, Cliente: c.cliente_nome, Descricao: c.descricao, 'Valor Original': c.valor_original,
      Multa: c.multa, Juros: c.juros, Desconto: c.desconto, 'Valor Atualizado': c.valor_atualizado,
      Status: c.status, Vencimento: c.vencimento ? new Date(c.vencimento).toLocaleDateString('pt-BR') : '',
      'Criado em': c.created_at ? new Date(c.created_at).toLocaleString('pt-BR') : ''
    })));
    XLSX.utils.book_append_sheet(wb, wsCobrancas, "Cobrancas");

    const resumo = [
      { Metrica: 'Total de Clientes', Valor: clientes.rowCount },
      { Metrica: 'Total de Cobranças', Valor: cobrancas.rowCount },
      { Metrica: 'Data do Backup', Valor: new Date().toLocaleString('pt-BR') },
      { Metrica: 'Gerado por', Valor: req.user?.nome || 'Admin' }
    ];
    const wsResumo = XLSX.utils.json_to_sheet(resumo);
    XLSX.utils.book_append_sheet(wb, wsResumo, "Resumo");

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
// COBRANÇAS RECORRENTES - ENDPOINTS
// =====================================================

// GET - Listar cobranças recorrentes
app.get("/api/cobrancas-recorrentes", auth, async (req, res) => {
  try {
    const { ativo } = req.query;
    
    let where = "";
    const params = [];
    
    if (ativo !== undefined) {
      params.push(ativo === 'true');
      where = `WHERE cr.ativo = $${params.length}`;
    }

    const sql = `
      SELECT 
        cr.*,
        cl.nome AS cliente_nome,
        cl.email AS cliente_email,
        cl.telefone AS cliente_telefone
      FROM cobrancas_recorrentes cr
      LEFT JOIN clientes cl ON cl.id = cr.cliente_id
      ${where}
      ORDER BY cr.created_at DESC
    `;

    const resultado = await pool.query(sql, params);
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/cobrancas-recorrentes] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar cobranças recorrentes.", error: err.message });
  }
});
// ESTATÍSTICAS DAS RECORRENTES
app.get("/api/cobrancas-recorrentes/stats", auth, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ativo = true)::int AS ativas,
        COUNT(*) FILTER (WHERE ativo = false)::int AS inativas,
        COALESCE(SUM(valor) FILTER (WHERE ativo = true), 0)::numeric AS valor_mensal_ativo,
        COALESCE(SUM(total_geradas), 0)::int AS total_cobrancas_geradas
      FROM cobrancas_recorrentes
    `);

    return res.json({ success: true, data: stats.rows[0] });
  } catch (err) {
    console.error("[STATS RECORRENTES] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar estatísticas.", error: err.message });
  }
});
// GET - Buscar uma cobrança recorrente por ID
app.get("/api/cobrancas-recorrentes/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `
      SELECT 
        cr.*,
        cl.nome AS cliente_nome,
        cl.email AS cliente_email,
        cl.telefone AS cliente_telefone
      FROM cobrancas_recorrentes cr
      LEFT JOIN clientes cl ON cl.id = cr.cliente_id
      WHERE cr.id = $1
    `;

    const resultado = await pool.query(sql, [id]);
    
    if (!resultado.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança recorrente não encontrada." });
    }

    return res.json({ success: true, data: resultado.rows[0] });
  } catch (err) {
    console.error("[GET /api/cobrancas-recorrentes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar cobrança recorrente.", error: err.message });
  }
});

// POST - Criar cobrança recorrente
app.post("/api/cobrancas-recorrentes", auth, async (req, res) => {
  try {
    const { 
      cliente_id, 
      valor, 
      descricao, 
      frequencia = 'mensal', 
      dia_vencimento = 10, 
      data_inicio, 
      data_fim 
    } = req.body || {};

    // Validações
    if (!cliente_id) {
      return res.status(400).json({ success: false, message: "Cliente é obrigatório." });
    }
    if (!valor || parseFloat(valor) <= 0) {
      return res.status(400).json({ success: false, message: "Valor deve ser maior que zero." });
    }
    if (!data_inicio) {
      return res.status(400).json({ success: false, message: "Data de início é obrigatória." });
    }

    const frequenciasValidas = ['semanal', 'quinzenal', 'mensal', 'bimestral', 'trimestral', 'semestral', 'anual'];
    if (!frequenciasValidas.includes(frequencia)) {
      return res.status(400).json({ success: false, message: "Frequência inválida." });
    }

    const diaVenc = parseInt(dia_vencimento);
    if (diaVenc < 1 || diaVenc > 28) {
      return res.status(400).json({ success: false, message: "Dia de vencimento deve ser entre 1 e 28." });
    }

    // Verificar se cliente existe
    const clienteExiste = await pool.query("SELECT id FROM clientes WHERE id = $1", [cliente_id]);
    if (!clienteExiste.rowCount) {
      return res.status(400).json({ success: false, message: "Cliente não encontrado." });
    }

    const resultado = await pool.query(
      `INSERT INTO cobrancas_recorrentes 
        (cliente_id, valor, descricao, frequencia, dia_vencimento, data_inicio, data_fim, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [cliente_id, parseFloat(valor), descricao || null, frequencia, diaVenc, data_inicio, data_fim || null]
    );

    // Registrar log
    await registrarLog(req, 'CRIAR', 'cobrancas_recorrentes', resultado.rows[0].id, { cliente_id, valor, frequencia });

    return res.json({ success: true, data: resultado.rows[0], message: "Cobrança recorrente criada com sucesso!" });
  } catch (err) {
    console.error("[POST /api/cobrancas-recorrentes] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao criar cobrança recorrente.", error: err.message });
  }
});

// PUT - Atualizar cobrança recorrente
app.put("/api/cobrancas-recorrentes/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor, descricao, frequencia, dia_vencimento, data_fim, ativo } = req.body || {};

    // Verificar se existe
    const existe = await pool.query("SELECT * FROM cobrancas_recorrentes WHERE id = $1", [id]);
    if (!existe.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança recorrente não encontrada." });
    }

    // Validações
    if (valor !== undefined && parseFloat(valor) <= 0) {
      return res.status(400).json({ success: false, message: "Valor deve ser maior que zero." });
    }

    if (frequencia) {
      const frequenciasValidas = ['semanal', 'quinzenal', 'mensal', 'bimestral', 'trimestral', 'semestral', 'anual'];
      if (!frequenciasValidas.includes(frequencia)) {
        return res.status(400).json({ success: false, message: "Frequência inválida." });
      }
    }

    if (dia_vencimento !== undefined) {
      const diaVenc = parseInt(dia_vencimento);
      if (diaVenc < 1 || diaVenc > 28) {
        return res.status(400).json({ success: false, message: "Dia de vencimento deve ser entre 1 e 28." });
      }
    }

    const resultado = await pool.query(
      `UPDATE cobrancas_recorrentes SET
        valor = COALESCE($1, valor),
        descricao = COALESCE($2, descricao),
        frequencia = COALESCE($3, frequencia),
        dia_vencimento = COALESCE($4, dia_vencimento),
        data_fim = $5,
        ativo = COALESCE($6, ativo),
        updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        valor ? parseFloat(valor) : null,
        descricao,
        frequencia,
        dia_vencimento ? parseInt(dia_vencimento) : null,
        data_fim,
        ativo,
        id
      ]
    );

    // Registrar log
    await registrarLog(req, 'ATUALIZAR', 'cobrancas_recorrentes', id, { valor, frequencia, ativo });

    return res.json({ success: true, data: resultado.rows[0], message: "Cobrança recorrente atualizada!" });
  } catch (err) {
    console.error("[PUT /api/cobrancas-recorrentes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar cobrança recorrente.", error: err.message });
  }
});

// DELETE - Desativar cobrança recorrente
app.delete("/api/cobrancas-recorrentes/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;

    const resultado = await pool.query(
      `UPDATE cobrancas_recorrentes SET ativo = false, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );

    if (!resultado.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança recorrente não encontrada." });
    }

    // Registrar log
    await registrarLog(req, 'DESATIVAR', 'cobrancas_recorrentes', id, null);

    return res.json({ success: true, message: "Cobrança recorrente desativada com sucesso." });
  } catch (err) {
    console.error("[DELETE /api/cobrancas-recorrentes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao desativar cobrança recorrente.", error: err.message });
  }
});

// POST - Gerar cobranças manualmente (para uma recorrente específica)
app.post("/api/cobrancas-recorrentes/:id/gerar", auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar a recorrente
    const recorrente = await pool.query(
      `SELECT cr.*, cl.nome AS cliente_nome 
       FROM cobrancas_recorrentes cr
       LEFT JOIN clientes cl ON cl.id = cr.cliente_id
       WHERE cr.id = $1 AND cr.ativo = true`,
      [id]
    );

    if (!recorrente.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança recorrente não encontrada ou inativa." });
    }

    const r = recorrente.rows[0];
    
    // Calcular data de vencimento (próximo mês com o dia configurado)
    const hoje = new Date();
    let vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 1, r.dia_vencimento);
    
    // Se o dia ainda não passou neste mês, gera para este mês mesmo
    if (hoje.getDate() < r.dia_vencimento) {
      vencimento = new Date(hoje.getFullYear(), hoje.getMonth(), r.dia_vencimento);
    }

    const vencimentoStr = vencimento.toISOString().split('T')[0];

    // Criar a cobrança
    const novaCobranca = await pool.query(
      `INSERT INTO cobrancas 
        (cliente_id, descricao, valor_original, multa, juros, desconto, vencimento, status, valor_atualizado)
       VALUES ($1, $2, $3, 0, 0, 0, $4, 'pendente', $3)
       RETURNING *`,
      [r.cliente_id, `${r.descricao || 'Cobrança recorrente'} (Ref: ${vencimento.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })})`, r.valor, vencimentoStr]
    );

    // Atualizar última geração e contador
    await pool.query(
      `UPDATE cobrancas_recorrentes SET ultima_geracao = $1, total_geradas = total_geradas + 1, updated_at = NOW() WHERE id = $2`,
      [hoje.toISOString().split('T')[0], id]
    );

    // Registrar log
    await registrarLog(req, 'GERAR_COBRANCA_RECORRENTE', 'cobrancas_recorrentes', id, { cobranca_id: novaCobranca.rows[0].id, vencimento: vencimentoStr });

    return res.json({ 
      success: true, 
      message: `Cobrança gerada com sucesso! Vencimento: ${vencimento.toLocaleDateString('pt-BR')}`,
      cobranca: novaCobranca.rows[0]
    });
  } catch (err) {
    console.error("[POST /api/cobrancas-recorrentes/:id/gerar] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar cobrança.", error: err.message });
  }
});

// Função que processa todas as cobranças recorrentes
async function processarCobrancasRecorrentes() {
  console.log("[RECORRENTE] Iniciando processamento de cobranças recorrentes...");
  
  try {
    const hoje = new Date();
    const diaHoje = hoje.getDate();
    const mesAtual = hoje.getMonth();
    const anoAtual = hoje.getFullYear();
    const hojeStr = hoje.toISOString().split('T')[0];

    // Buscar recorrentes ativas que precisam gerar hoje
    const recorrentes = await pool.query(`
      SELECT cr.*, cl.nome AS cliente_nome
      FROM cobrancas_recorrentes cr
      LEFT JOIN clientes cl ON cl.id = cr.cliente_id
      WHERE cr.ativo = true
        AND cr.data_inicio <= $1
        AND (cr.data_fim IS NULL OR cr.data_fim >= $1)
        AND cr.dia_vencimento = $2
        AND (cr.ultima_geracao IS NULL OR cr.ultima_geracao < $1)
    `, [hojeStr, diaHoje]);

    console.log(`[RECORRENTE] Encontradas ${recorrentes.rowCount} cobranças para processar hoje`);

    let geradas = 0;
    let erros = 0;

    for (const r of recorrentes.rows) {
      try {
        // Verificar frequência
        if (r.ultima_geracao) {
          const ultimaGeracao = new Date(r.ultima_geracao);
          const mesesDesdeUltima = (anoAtual - ultimaGeracao.getFullYear()) * 12 + (mesAtual - ultimaGeracao.getMonth());
          
          let intervaloMeses = 1; // mensal
          switch (r.frequencia) {
            case 'semanal': intervaloMeses = 0; break;
            case 'quinzenal': intervaloMeses = 0; break;
            case 'bimestral': intervaloMeses = 2; break;
            case 'trimestral': intervaloMeses = 3; break;
            case 'semestral': intervaloMeses = 6; break;
            case 'anual': intervaloMeses = 12; break;
          }

          // Pular se não for hora de gerar (baseado na frequência)
          if (intervaloMeses > 0 && mesesDesdeUltima < intervaloMeses) {
            continue;
          }
        }

        // Calcular vencimento
        const vencimento = new Date(anoAtual, mesAtual, r.dia_vencimento);
        const vencimentoStr = vencimento.toISOString().split('T')[0];
        const descMes = vencimento.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

        // Criar cobrança
        await pool.query(
          `INSERT INTO cobrancas 
            (cliente_id, descricao, valor_original, multa, juros, desconto, vencimento, status, valor_atualizado)
           VALUES ($1, $2, $3, 0, 0, 0, $4, 'pendente', $3)`,
          [r.cliente_id, `${r.descricao || 'Cobrança recorrente'} (Ref: ${descMes})`, r.valor, vencimentoStr]
        );

        // Atualizar recorrente
        await pool.query(
          `UPDATE cobrancas_recorrentes SET ultima_geracao = $1, total_geradas = total_geradas + 1, updated_at = NOW() WHERE id = $2`,
          [hojeStr, r.id]
        );

        geradas++;
        console.log(`[RECORRENTE] ✅ Cobrança gerada para ${r.cliente_nome} - R$ ${r.valor}`);

      } catch (errItem) {
        erros++;
        console.error(`[RECORRENTE] ❌ Erro ao processar recorrente ${r.id}:`, errItem.message);
      }
    }

    console.log(`[RECORRENTE] Processamento concluído: ${geradas} geradas, ${erros} erros`);
    return { geradas, erros };

  } catch (err) {
    console.error("[RECORRENTE] Erro geral no processamento:", err.message);
    return { geradas: 0, erros: 1 };
  }
}

// Endpoint para executar o job manualmente (admin only)
app.post("/api/cobrancas-recorrentes/processar", authAdmin, async (req, res) => {
  try {
    const resultado = await processarCobrancasRecorrentes();
    
    await registrarLog(req, 'PROCESSAR_RECORRENTES', 'sistema', null, resultado);
    
    return res.json({ 
      success: true, 
      message: `Processamento concluído: ${resultado.geradas} cobranças geradas, ${resultado.erros} erros.`,
      ...resultado
    });
  } catch (err) {
    console.error("[PROCESSAR RECORRENTES] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao processar cobranças recorrentes.", error: err.message });
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
  console.log(`[ACERTIVE ENTERPRISE] 🚀 Servidor rodando na porta ${PORT}`);
  console.log("[ACERTIVE] Allowed origins:", allowedOrigins);
  console.log("[ACERTIVE] E-mail configurado:", !!emailTransporter);
  console.log("[ACERTIVE] IA configurada:", !!process.env.OPENAI_API_KEY);
});
