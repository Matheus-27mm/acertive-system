/**
 * server.js — ACERTIVE (PostgreSQL + JWT + Front estático)
 * PDFs Premium Dourados Embutidos
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

// =====================
// Health check
// =====================
app.get("/api/health", (req, res) => {
  return res.json({
    ok: true,
    service: "acertive",
    time: new Date().toISOString(),
    frontendDir: FRONTEND_DIR || null,
  });
});

// =====================
// API: Login
// =====================
app.post("/api/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    const emailStr = String(email || "").trim();
    const senhaStr = String(senha || "");

    if (!emailStr || !senhaStr) {
      return res.status(400).json({ success: false, message: "Email e senha são obrigatórios." });
    }

    const r = await pool.query(
      "SELECT id, email, senha_hash, nome FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [emailStr]
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ success: false, message: "Credenciais inválidas." });
    }

    const user = r.rows[0];
    const ok = await bcrypt.compare(senhaStr, user.senha_hash);
    if (!ok) return res.status(401).json({ success: false, message: "Credenciais inválidas." });

    const token = jwt.sign(
      { userId: user.id, email: user.email, nome: user.nome },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({ success: true, token, user: { id: user.id, email: user.email, nome: user.nome } });
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

    const r = await pool.query(
      `UPDATE cobrancas SET status = $2 WHERE id = $1 RETURNING *`,
      [id, status]
    );

    if (!r.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }

    return res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error("[PUT /api/cobrancas/:id/status] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar status.", error: err.message });
  }
});

// =====================================================
// PDF COBRANÇA PREMIUM DOURADO (HTML EMBUTIDO)
// =====================================================
app.get("/api/cobrancas/:id/pdf", auth, async (req, res) => {
  let browser;
  try {
    const id = String(req.params.id || "").trim();

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(400).json({ success: false, message: "ID inválido." });
    }

    const q = await pool.query(
      `SELECT c.id, COALESCE(cl.nome, '') AS cliente, c.descricao, c.valor_original, c.multa, c.juros, c.desconto,
       c.valor_atualizado, c.status, c.vencimento, c.created_at
       FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id WHERE c.id = $1::uuid LIMIT 1`,
      [id]
    );

    if (!q.rows.length) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }

    const r = q.rows[0];

    const esc = (s) => String(s || "—").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

    const valorOriginal2 = parseFloat(r.valor_original || 0);
    const juros2 = parseFloat(r.juros || 0);
    const multa2 = parseFloat(r.multa || 0);
    const desconto2 = parseFloat(r.desconto || 0);
    const valorAtualizado2 = parseFloat(r.valor_atualizado || valorOriginal2);
    const ajustes2 = juros2 + multa2 - desconto2;

    const status2 = String(r.status || "").toLowerCase();
    const badgeClass2 = status2 === "pago" ? "pago" : status2 === "vencido" ? "vencido" : "pendente";
    const statusLabel2 = status2 === "pago" ? "PAGO" : status2 === "vencido" ? "VENCIDO" : "PENDENTE";

    const idStr2 = String(r.id);
    const refCode2 = `AC-C${idStr2.slice(0, 2).toUpperCase()}D${idStr2.slice(2, 6).toUpperCase()}${idStr2.slice(6, 8).toUpperCase()}`;

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Cobrança ${refCode2}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
@page{size:A4;margin:0}
body{font-family:'Segoe UI',sans-serif;background:#fff;color:#2c3e50;padding:50px;line-height:1.6}
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
.status-badge{display:inline-block;padding:8px 16px;border-radius:25px;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:1px;margin-top:10px}
.status-badge.pago{background:#dcfce7;color:#166534;border:2px solid #16a34a}
.status-badge.pendente{background:#fef3c7;color:#854d0e;border:2px solid #F6C84C}
.status-badge.vencido{background:#fee2e2;color:#991b1b;border:2px solid #dc2626}
.valores-section{margin-bottom:35px}
.section-title{color:#1a1a1a;font-size:18px;font-weight:900;margin-bottom:20px;padding-bottom:10px;border-bottom:3px solid #F6C84C}
.valores-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.valor-card{background:linear-gradient(135deg,#f8f9fa 0%,#e9ecef 100%);border:2px solid #d1d5db;border-radius:16px;padding:22px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.08)}
.valor-label{color:#6b7280;font-size:11px;text-transform:uppercase;font-weight:800;letter-spacing:.8px;margin-bottom:12px}
.valor-amount{color:#1a1a1a;font-size:24px;font-weight:900;letter-spacing:-.5px}
.valor-card.destaque{background:linear-gradient(135deg,#F6C84C 0%,#FFD56A 100%);border-color:#d4a028;box-shadow:0 8px 25px rgba(246,200,76,.4);transform:scale(1.05)}
.valor-card.destaque .valor-label{color:#1a1a1a}
.valor-card.destaque .valor-amount{color:#1a1a1a;font-size:28px}
.dados-section{background:linear-gradient(135deg,#f8f9fa 0%,#fff 100%);border:2px solid #d1d5db;border-radius:16px;padding:30px;margin-bottom:30px}
.dados-grid{display:grid;grid-template-columns:200px 1fr;gap:16px;row-gap:20px}
.dados-label{color:#6b7280;font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:.5px}
.dados-value{color:#1a1a1a;font-weight:700;font-size:15px}
.dados-value.highlight{color:#F6C84C;font-weight:900;font-size:16px}
.resumo-section{background:linear-gradient(135deg,#fef3c7 0%,#fef9e7 100%);border:3px solid #F6C84C;border-radius:16px;padding:30px;margin-bottom:30px}
.resumo-table{width:100%;border-collapse:collapse}
.resumo-table tr{border-bottom:2px solid rgba(246,200,76,.2)}
.resumo-table tr:last-child{border-bottom:none}
.resumo-table td{padding:16px 20px;font-size:15px}
.resumo-table td:first-child{color:#854d0e;font-weight:800;text-transform:uppercase;letter-spacing:.5px;font-size:13px}
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
    const fmtMoney = (n) => Number(n || 0).toFixed(2).replace(".", ",");
    const fmtDate = (d) => {
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
    lines.push(`Total Recebido (Pago),${fmtMoney(qRecebido.rows[0]?.total)}`);
    lines.push(`Total Pendente,${fmtMoney(qPendente.rows[0]?.total)}`);
    lines.push(`Total Vencido,${fmtMoney(qVencido.rows[0]?.total)}`);
    lines.push("");
    lines.push("DETALHAMENTO");
    lines.push(["ID","Cliente","Descricao","Valor Original","Multa","Juros","Desconto","Valor Atualizado","Status","Vencimento","Criado Em"].join(","));

    for (const r of qRows.rows) {
      lines.push([
        esc(r.id), esc(r.cliente), esc(r.descricao || ""), esc(fmtMoney(r.valor_original)),
        esc(fmtMoney(r.multa)), esc(fmtMoney(r.juros)), esc(fmtMoney(r.desconto)),
        esc(fmtMoney(r.valor_atualizado)), esc(r.status), esc(fmtDate(r.vencimento)), esc(fmtDate(r.created_at))
      ].join(","));
    }

    const csv = "\uFEFF" + lines.join("\n");
    const fileName = hasRange ? `relatorio_acertive_${start}_a_${end}.csv` : `relatorio_acertive_completo.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error("[RELATORIO] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao exportar relatório.", error: err.message });
  }
});

app.get("/api/relatorio/exportar", auth, (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return res.redirect(`/api/relatorios/export-csv${qs}`);
});

// =====================================================
// RELATÓRIO PDF PREMIUM DOURADO (HTML EMBUTIDO)
// =====================================================
app.get("/api/relatorios/export-pdf", auth, async (req, res) => {
  let browser;
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

    const fmtMoney = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    const fmtDate = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return String(d);
      return dt.toLocaleDateString("pt-BR");
    };

    const periodLabel = hasRange ? `${fmtDate(start)} a ${fmtDate(end)}` : "Todos os períodos";
    const totalRecebido = fmtMoney(qRecebido.rows[0]?.total);
    const totalPendente = fmtMoney(qPendente.rows[0]?.total);
    const totalVencido = fmtMoney(qVencido.rows[0]?.total);
    const totalCobrancas = qCountCobrancas.rows[0]?.total ?? 0;
    const totalClientes = qClientesAtivos.rows[0]?.total ?? 0;

    const esc = (s) => String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const rowsHtml = qRows.rows.map((r) => {
      const badgeClass = r.status === "pago" ? "pago" : r.status === "vencido" ? "vencido" : "pendente";
      return `<tr>
<td class="mono">${esc(String(r.id).slice(0,8))}</td>
<td><div class="strong">${esc(r.cliente)}</div><div class="muted small">${esc(r.descricao || "—")}</div></td>
<td>${fmtDate(r.vencimento)}</td>
<td>${fmtMoney(r.valor_original)}</td>
<td>${fmtMoney(r.juros)}</td>
<td>${fmtMoney(r.multa)}</td>
<td class="strong">${fmtMoney(r.valor_atualizado)}</td>
<td><span class="badge ${badgeClass}">${String(r.status || "").toUpperCase()}</span></td>
</tr>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>Relatório ACERTIVE</title>
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
.kpis-section{margin-bottom:35px}
.section-title{color:#1a1a1a;font-size:18px;font-weight:900;margin-bottom:20px;padding-bottom:10px;border-bottom:3px solid #F6C84C;display:flex;align-items:center;gap:10px}
.kpis-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.kpi-card{background:linear-gradient(135deg,#f8f9fa 0%,#e9ecef 100%);border:2px solid #d1d5db;border-radius:16px;padding:22px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.08)}
.kpi-label{color:#6b7280;font-size:11px;text-transform:uppercase;font-weight:800;letter-spacing:.8px;margin-bottom:12px}
.kpi-value{color:#1a1a1a;font-size:24px;font-weight:900;letter-spacing:-.5px}
.kpi-card.recebido{background:linear-gradient(135deg,#dcfce7 0%,#f0fdf4 100%);border-color:#4CAF50}
.kpi-card.recebido .kpi-value{color:#166534}
.kpi-card.pendente{background:linear-gradient(135deg,#fef3c7 0%,#fef9e7 100%);border-color:#F6C84C}
.kpi-card.pendente .kpi-value{color:#854d0e}
.kpi-card.vencido{background:linear-gradient(135deg,#fee2e2 0%,#fef2f2 100%);border-color:#F44336}
.kpi-card.vencido .kpi-value{color:#991b1b}
.table-section{background:linear-gradient(135deg,#f8f9fa 0%,#fff 100%);border:2px solid #d1d5db;border-radius:16px;padding:30px;margin-bottom:30px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:11px}
thead th{background:linear-gradient(135deg,#1a1a1a,#2d2d2d);color:#F6C84C;padding:14px 12px;text-align:left;font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:.8px;border-bottom:3px solid #F6C84C}
tbody tr{border-bottom:1px solid #e5e7eb}
tbody tr:last-child{border-bottom:none}
tbody td{padding:12px;color:#374151;vertical-align:top}
.badge{display:inline-block;padding:5px 10px;border-radius:20px;font-size:10px;font-weight:900;letter-spacing:.5px;text-transform:uppercase}
.badge.pago{background:#dcfce7;color:#166534;border:1px solid #16a34a}
.badge.pendente{background:#fef3c7;color:#854d0e;border:1px solid #F6C84C}
.badge.vencido{background:#fee2e2;color:#991b1b;border:1px solid #dc2626}
.mono{font-family:'Courier New',monospace;font-size:10px}
.strong{font-weight:900}
.muted{color:#9ca3af}
.small{font-size:10px}
.footer{margin-top:40px;padding-top:25px;border-top:3px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center}
.footer-info p{color:#6b7280;font-size:13px;margin-bottom:6px;font-weight:600}
.footer-info strong{color:#1a1a1a;font-weight:900}
.footer-logo{display:flex;align-items:center;gap:12px}
.footer-logo-icon{width:50px;height:50px;background:linear-gradient(135deg,#F6C84C,#FFD56A);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#1a1a1a;font-size:26px;font-weight:900;box-shadow:0 4px 12px rgba(246,200,76,.3)}
.footer-logo-text{color:#1a1a1a;font-size:22px;font-weight:900;letter-spacing:.8px}
.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:120px;color:rgba(246,200,76,.03);font-weight:900;letter-spacing:20px;pointer-events:none;z-index:-1}
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
<h2>Relatório de Cobranças</h2>
</div>
</div>
<div class="header-info">
<div class="info-row"><span class="info-label">Período:</span><span class="info-value">${periodLabel}</span></div>
<div class="info-row"><span class="info-label">Gerado em:</span><span class="info-value">${new Date().toLocaleDateString("pt-BR")}</span></div>
</div>
</div>
</div>
<div class="kpis-section">
<h3 class="section-title">💰 Indicadores Financeiros</h3>
<div class="kpis-grid">
<div class="kpi-card recebido"><div class="kpi-label">Total Recebido</div><div class="kpi-value">${totalRecebido}</div></div>
<div class="kpi-card pendente"><div class="kpi-label">Total Pendente</div><div class="kpi-value">${totalPendente}</div></div>
<div class="kpi-card vencido"><div class="kpi-label">Total Vencido</div><div class="kpi-value">${totalVencido}</div></div>
<div class="kpi-card"><div class="kpi-label">Clientes / Cobranças</div><div class="kpi-value">${totalClientes} / ${totalCobrancas}</div></div>
</div>
</div>
<div class="table-section">
<h3 class="section-title">📋 Detalhamento (${qRows.rows.length} registro${qRows.rows.length !== 1 ? 's' : ''})</h3>
<table>
<thead>
<tr>
<th>ID</th>
<th>Cliente / Descrição</th>
<th>Vencimento</th>
<th>Original</th>
<th>Juros</th>
<th>Multa</th>
<th>Atualizado</th>
<th>Status</th>
</tr>
</thead>
<tbody>
${rowsHtml || '<tr><td colspan="8" class="muted" style="text-align:center;padding:40px">Nenhuma cobrança encontrada no período.</td></tr>'}
</tbody>
</table>
</div>
<div class="footer">
<div class="footer-info">
<p><strong>Gerado por:</strong> Sistema ACERTIVE</p>
<p><strong>Data/hora:</strong> ${new Date().toLocaleString("pt-BR")}</p>
<p><strong>Usuário:</strong> ${req.user?.nome || 'Administrador'}</p>
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

// =====================
// 404
// =====================
app.use((req, res) => res.status(404).send("Página não encontrada."));

// =====================
// Start
// =====================
app.listen(PORT, () => {
  console.log(`[ACERTIVE] Servidor rodando na porta ${PORT}`);
  console.log("[ACERTIVE] Allowed origins:", allowedOrigins);
});
