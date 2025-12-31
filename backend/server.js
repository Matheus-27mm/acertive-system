/**
 * server.js — ACERTIVE (PostgreSQL + JWT + Front estático)
 * Ajustes para Render + domínio + evitar "Cannot GET /"
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
// Frontend: descobrir pasta automaticamente
// =====================
const FRONTEND_DIR_CANDIDATES = [
  path.join(__dirname, "frontend"),       // backend/frontend
  path.join(__dirname, "..", "frontend"), // raiz/frontend (seu caso)
];

const FRONTEND_DIR = FRONTEND_DIR_CANDIDATES.find((p) => fs.existsSync(p));

if (!FRONTEND_DIR) {
  console.error("[ACERTIVE] ERRO: Pasta do frontend não encontrada.");
  console.error("[ACERTIVE] Tentativas:", FRONTEND_DIR_CANDIDATES);
  process.exit(1); // <- falha o deploy, evita Cannot GET / e fallback quebrado
}

console.log("[ACERTIVE] Servindo arquivos estáticos de:", FRONTEND_DIR);

app.use(express.static(FRONTEND_DIR));
// =====================
// Middlewares
// =====================

// CORS: lista por env (recomendado)
// FRONTEND_ORIGIN=https://acertivecobranca.com.br,https://www.acertivecobranca.com.br,http://localhost:3000
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
      // requests sem origin (curl/healthchecks) devem passar
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// preflight
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
// Health check (pra testar no domínio)
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
// GET dashboard (KPIs) — protegido
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
// Rotas estáticas do frontend
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

// ========================
// Rotas principais (páginas)
// ========================
app.get("/", sendFront("login.html"));
app.get("/login", sendFront("login.html"));
app.get("/dashboard", sendFront("dashboard.html"));
app.get("/nova-cobranca", sendFront("nova-cobranca.html"));
app.get("/cobrancas", sendFront("cobrancas.html"));
app.get("/clientes-ativos", sendFront("clientes-ativos.html"));
// Novo cliente: atende COM e SEM barra, sem redirect
app.get(["/novo-cliente", "/novo-cliente/"], sendFront("novo-cliente.html"));
app.get("/novo-cliente.html", sendFront("novo-cliente.html"));



// ===============================
// Fallback APENAS para páginas (sem extensão)
// ===============================
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();

  // Se tiver extensão, é arquivo (JS/CSS/img) -> não devolver HTML
  if (req.path.includes(".")) {
    return res.status(404).send("Arquivo não encontrado");
  }

  // Para rota de página desconhecida, manda login.html
  return res.sendFile(path.join(FRONTEND_DIR, "login.html"));
});

// =====================
// APIs: cobranças
// =====================

// GET cobranças (protegido) — com nome do cliente
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

// POST criar cobrança (protegido)
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

    // Busca cliente: por ID se veio, senão por nome
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
// =====================
// PUT atualizar status da cobrança (UUID ok) — protegido
// /api/cobrancas/:id/status
// body: { status: "pago" | "pendente" | "vencido" }
// =====================
app.put("/api/cobrancas/:id/status", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim(); // UUID/string
    const status = String(req.body?.status || "").toLowerCase().trim();

    const allowed = new Set(["pago", "pendente", "vencido"]);
    if (!id) {
      return res.status(400).json({ success: false, message: "ID inválido." });
    }
    if (!allowed.has(status)) {
      return res.status(400).json({ success: false, message: "Status inválido." });
    }

    const r = await pool.query(
      `UPDATE cobrancas
         SET status = $2
       WHERE id = $1
       RETURNING *`,
      [id, status]
    );

    if (!r.rowCount) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }

    return res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error("[PUT /api/cobrancas/:id/status] erro:", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Erro ao atualizar status.", error: err.message });
  }
});

// COBRANÇA (PDF BONITO) — protegido
// GET /api/cobrancas/:id/pdf
// =====================
app.get("/api/cobrancas/:id/pdf", auth, async (req, res) => {
  let browser;
  try {
    const id = String(req.params.id || "").trim();

    // valida UUID (Postgres)
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

    if (!isUuid) {
      return res.status(400).json({ success: false, message: "ID inválido." });
    }

    const q = await pool.query(
      `SELECT
         c.id,
         COALESCE(cl.nome, '') AS cliente,
         c.descricao,
         c.valor_original,
         c.multa,
         c.juros,
         c.desconto,
         c.valor_atualizado,
         c.status,
         c.vencimento,
         c.created_at
       FROM cobrancas c
       LEFT JOIN clientes cl ON cl.id = c.cliente_id
       WHERE c.id = $1::uuid
       LIMIT 1`,
      [id]
    );

    if (!q.rows.length) {
      return res.status(404).json({ success: false, message: "Cobrança não encontrada." });
    }

    const r = q.rows[0];

    // ... (seu HTML/CSS e geração Playwright continuam iguais daqui pra baixo)


    const esc = (s) =>
      String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    const fmtMoney = (n) =>
      Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

    const fmtDate = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return String(d);
      return dt.toLocaleDateString("pt-BR");
    };

    const status = String(r.status || "").toLowerCase();
    const badgeClass = status === "pago" ? "pago" : status === "vencido" ? "vencido" : "pendente";

    // referência amigável: se for número, faz AC-000001; se for uuid, usa os 8 primeiros
    const idStr = String(r.id);
    const refCode =
      /^\d+$/.test(idStr) ? `AC-${idStr.padStart(6, "0")}` : `AC-${idStr.slice(0, 8).toUpperCase()}`;

    const html = `
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Cobrança ${esc(refCode)} • ACERTIVE</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root{
      --bg1:#070707; --bg2:#131313;
      --card:#0f0f10cc; --card2:#111114f2;
      --gold:#FFD700; --gold2:#FFA500;
      --white:#ffffff;
      --shadow: 0 18px 60px rgba(0,0,0,.62);
      --shadowSoft: 0 10px 28px rgba(0,0,0,.50);
      --radius:18px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:'Montserrat',sans-serif;
      color:var(--white);
      background:
        radial-gradient(900px 500px at 20% 20%, rgba(255,215,0,.10), transparent 55%),
        radial-gradient(800px 500px at 85% 20%, rgba(255,165,0,.10), transparent 50%),
        linear-gradient(135deg, var(--bg1), var(--bg2));
    }
    .page{ padding: 26px; }
    .topbar{
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
      border: 1px solid rgba(255,215,0,.18);
      box-shadow: var(--shadowSoft);
      padding: 16px 18px;
      display:flex; align-items:center; justify-content:space-between;
      gap:12px;
    }
    .brand{ display:flex; align-items:center; gap:10px; font-weight:900; letter-spacing:.4px; }
    .mark{
      width:42px;height:42px;border-radius:14px;
      background: linear-gradient(135deg, rgba(255,215,0,.95), rgba(255,165,0,.95));
      display:flex;align-items:center;justify-content:center;
      color:#111;font-weight:900;
      box-shadow: 0 10px 20px rgba(255,215,0,.18);
    }
    .brand small{display:block;color:rgba(255,215,0,.92);font-weight:700;margin-top:2px;font-size:12px}
    .meta{ text-align:right; font-size:12px; color:rgba(255,255,255,.75); line-height:1.35; }
    .meta .gold{color:rgba(255,215,0,.95); font-weight:800}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace}
    .muted{color: rgba(255,255,255,.65)}
    .strong{font-weight:900}

    .grid{ margin-top: 16px; display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; }
    .card{
      border-radius: var(--radius);
      background: linear-gradient(180deg, var(--card), var(--card2));
      border: 1px solid rgba(255,215,0,.20);
      box-shadow: var(--shadow);
      padding: 14px 14px;
      min-height: 86px;
    }
    .kpiTitle{ font-size: 11px; letter-spacing:.6px; text-transform: uppercase; color: rgba(255,215,0,.92); font-weight: 900; margin-bottom: 8px; }
    .kpiValue{ font-size: 18px; font-weight: 900; color: rgba(255,255,255,.96); }

    .divider{ height:1px; background: linear-gradient(90deg, transparent, rgba(255,215,0,.22), transparent); margin: 16px 0; }

    .box{
      border-radius: 16px;
      border: 1px solid rgba(255,215,0,.14);
      background: rgba(0,0,0,.18);
      box-shadow: var(--shadowSoft);
      padding: 14px;
    }
    .title{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin: 0 0 10px; }
    .title h2{ margin:0; font-size: 14px; font-weight: 900; }
    .hint{ font-size: 12px; color: rgba(255,255,255,.70); }

    .kv{ display:grid; grid-template-columns: 160px 1fr; gap:8px 12px; font-size: 11px; line-height: 1.35; }
    .k{ color: rgba(255,255,255,.65); }
    .v{ font-weight: 700; }

    .badge{
      display:inline-flex;
      padding: 5px 8px;
      border-radius: 999px;
      font-weight: 900;
      letter-spacing:.3px;
      border: 1px solid rgba(255,215,0,.18);
      background: rgba(255,215,0,.10);
      color: rgba(255,215,0,.95);
      white-space:nowrap;
      font-size: 10px;
    }
    .badge.pago{ border-color: rgba(40,167,69,.35); background: rgba(40,167,69,.12); color: rgba(40,167,69,.95); }
    .badge.vencido{ border-color: rgba(220,53,69,.35); background: rgba(220,53,69,.12); color: rgba(220,53,69,.95); }
    .badge.pendente{ border-color: rgba(255,215,0,.25); background: rgba(255,215,0,.12); color: rgba(255,215,0,.95); }

    @page { size: A4; margin: 14mm; }
  </style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand">
        <div class="mark">A</div>
        <div>
          ACERTIVE
          <small>Documento de Cobrança</small>
        </div>
      </div>
      <div class="meta">
        <div><span class="gold">Referência:</span> <span class="mono">${esc(refCode)}</span></div>
        <div><span class="gold">Status:</span> <span class="badge ${badgeClass}">${esc(String(r.status||"").toUpperCase())}</span></div>
        <div class="muted">Gerado em: ${new Date().toLocaleString("pt-BR")}</div>
      </div>
    </div>

    <div class="grid">
      <div class="card"><div class="kpiTitle">Valor Atualizado</div><div class="kpiValue">${fmtMoney(r.valor_atualizado)}</div></div>
      <div class="card"><div class="kpiTitle">Vencimento</div><div class="kpiValue">${esc(fmtDate(r.vencimento) || "—")}</div></div>
      <div class="card"><div class="kpiTitle">Valor Original</div><div class="kpiValue">${fmtMoney(r.valor_original)}</div></div>
      <div class="card"><div class="kpiTitle">Ajustes</div><div class="kpiValue">${fmtMoney((r.juros||0) + (r.multa||0) - (r.desconto||0))}</div></div>
    </div>

    <div class="divider"></div>

    <div class="box">
      <div class="title">
        <h2>Dados da Cobrança</h2>
        <div class="hint">ID: <span class="mono">#${esc(String(r.id))}</span></div>
      </div>
      <div class="kv">
        <div class="k">Cliente</div><div class="v strong">${esc(r.cliente || "—")}</div>
        <div class="k">Descrição</div><div class="v">${esc(r.descricao || "—")}</div>
        <div class="k">Criada em</div><div class="v">${esc(fmtDate(r.created_at) || "—")}</div>
      </div>
    </div>

    <div class="box" style="margin-top:12px;">
      <div class="title"><h2>Resumo Financeiro</h2><div class="hint">Detalhes</div></div>
      <div class="kv">
        <div class="k">Valor original</div><div class="v">${fmtMoney(r.valor_original)}</div>
        <div class="k">Juros</div><div class="v">${fmtMoney(r.juros)}</div>
        <div class="k">Multa</div><div class="v">${fmtMoney(r.multa)}</div>
        <div class="k">Desconto</div><div class="v">${fmtMoney(r.desconto)}</div>
        <div class="k strong">Total atualizado</div><div class="v strong">${fmtMoney(r.valor_atualizado)}</div>
      </div>
    </div>

    <div style="margin-top:12px; display:flex; justify-content:space-between; color: rgba(255,255,255,.55); font-size: 10px;">
      <div>© ${new Date().getFullYear()} ACERTIVE</div>
      <div class="muted">Documento gerado automaticamente</div>
    </div>
  </div>
</body>
</html>
    `;

    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });

    await browser.close();
    browser = null;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="cobranca_${refCode}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    console.error("[COBRANCA PDF] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao gerar PDF da cobrança.", error: err.message });
  }
});

// DELETE cobrança (protegido)
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

// GET clientes ativos (público)
app.get("/api/clientes-ativos", async (req, res) => {
  try {
    const resultado = await pool.query("SELECT * FROM clientes WHERE status = 'ativo' ORDER BY created_at DESC");
    return res.json({ success: true, data: resultado.rows });
  } catch (err) {
    console.error("[GET /api/clientes-ativos] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao buscar clientes ativos.", error: err.message });
  }
});

// POST criar cliente (protegido)
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

// PUT atualizar cliente (protegido)
app.put("/api/clientes/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { nome, email, telefone, status, tipo, cpf_cnpj, endereco, observacoes } = req.body || {};
  if (!id) return res.status(400).json({ success: false, message: "id é obrigatório" });

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
         updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [nome, email, telefone, status, tipo, cpf_cnpj, endereco, observacoes, id]
    );

    if (!result.rowCount) return res.status(404).json({ success: false, message: "Cliente não encontrado" });
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("[PUT /api/clientes/:id] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao atualizar cliente", error: err.message });
  }
});

// DELETE cliente (soft delete -> inativo) (protegido)
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
// IMPORTAÇÃO (Excel/CSV) — protegido
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
      String(s || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");

    const pick = (obj, keys) => {
      const keyMap = new Map(Object.keys(obj).map((k) => [norm(k), obj[k]]));
      for (const k of keys) {
        const v = keyMap.get(norm(k));
        if (v !== undefined && String(v).trim() !== "") return String(v).trim();
      }
      return "";
    };

    let imported = 0;
    let skipped = 0;
    let duplicates = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        const nome = pick(r, ["NOMECLI", "NOME_CLIENTE", "CLIENTE", "nome", "name"]);
        if (!nome) {
          skipped++;
          continue;
        }

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

        if (exists) {
          duplicates++;
          continue;
        }

        await pool.query(
          `INSERT INTO clientes (nome, email, telefone, cpf_cnpj, endereco, status, observacoes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
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
// RELATÓRIO (CSV) — protegido
// GET /api/relatorios/export-csv?start=YYYY-MM-DD&end=YYYY-MM-DD
// =====================
app.get("/api/relatorios/export-csv", auth, async (req, res) => {
  try {
    const start = (req.query.start || "").trim();
    const end = (req.query.end || "").trim();
    const hasRange = start && end;

    const qRecebido = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total
       FROM cobrancas
       WHERE status = 'pago'
       ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qPendente = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total
       FROM cobrancas
       WHERE status = 'pendente'
       ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qVencido = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total
       FROM cobrancas
       WHERE status = 'vencido'
       ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qCountCobrancas = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM cobrancas
       ${hasRange ? "WHERE vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qClientesAtivos = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM clientes
       WHERE status = 'ativo'`
    );

    const qRows = await pool.query(
      `SELECT
         c.id,
         COALESCE(cl.nome, '') AS cliente,
         c.descricao,
         c.valor_original,
         c.multa,
         c.juros,
         c.desconto,
         c.valor_atualizado,
         c.status,
         c.vencimento,
         c.created_at
       FROM cobrancas c
       LEFT JOIN clientes cl ON cl.id = c.cliente_id
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
    lines.push(
      ["ID","Cliente","Descricao","Valor Original","Multa","Juros","Desconto","Valor Atualizado","Status","Vencimento","Criado Em"].join(",")
    );

    for (const r of qRows.rows) {
      lines.push([
        esc(r.id),
        esc(r.cliente),
        esc(r.descricao || ""),
        esc(fmtMoney(r.valor_original)),
        esc(fmtMoney(r.multa)),
        esc(fmtMoney(r.juros)),
        esc(fmtMoney(r.desconto)),
        esc(fmtMoney(r.valor_atualizado)),
        esc(r.status),
        esc(fmtDate(r.vencimento)),
        esc(fmtDate(r.created_at)),
      ].join(","));
    }

    const csv = "\uFEFF" + lines.join("\n");
    const fileName = hasRange
      ? `relatorio_acertive_${start}_a_${end}.csv`
      : `relatorio_acertive_completo.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error("[RELATORIO] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao exportar relatório.", error: err.message });
  }
});

// Alias opcional (caso seu front ainda chame o antigo)
app.get("/api/relatorio/exportar", auth, (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return res.redirect(`/api/relatorios/export-csv${qs}`);
});
// =====================
// RELATÓRIO (PDF BONITO) — protegido
// GET /api/relatorios/export-pdf?start=YYYY-MM-DD&end=YYYY-MM-DD
// =====================
app.get("/api/relatorios/export-pdf", auth, async (req, res) => {
  let browser;
  try {
    const start = (req.query.start || "").trim();
    const end = (req.query.end || "").trim();
    const hasRange = start && end;

    // --- consultas (mesmas da sua CSV) ---
    const qRecebido = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total
       FROM cobrancas
       WHERE status = 'pago'
       ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qPendente = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total
       FROM cobrancas
       WHERE status = 'pendente'
       ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qVencido = await pool.query(
      `SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total
       FROM cobrancas
       WHERE status = 'vencido'
       ${hasRange ? "AND vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qCountCobrancas = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM cobrancas
       ${hasRange ? "WHERE vencimento BETWEEN $1 AND $2" : ""}`,
      hasRange ? [start, end] : []
    );

    const qClientesAtivos = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM clientes
       WHERE status = 'ativo'`
    );

    const qRows = await pool.query(
      `SELECT
         c.id,
         COALESCE(cl.nome, '') AS cliente,
         c.descricao,
         c.valor_original,
         c.multa,
         c.juros,
         c.desconto,
         c.valor_atualizado,
         c.status,
         c.vencimento,
         c.created_at
       FROM cobrancas c
       LEFT JOIN clientes cl ON cl.id = c.cliente_id
       ${hasRange ? "WHERE c.vencimento BETWEEN $1 AND $2" : ""}
       ORDER BY c.created_at DESC`,
      hasRange ? [start, end] : []
    );

    const fmtMoney = (n) =>
      Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

    const fmtDate = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return String(d);
      return dt.toLocaleDateString("pt-BR");
    };

    const periodLabel = hasRange ? `${start} a ${end}` : "Todos";
    const totalRecebido = fmtMoney(qRecebido.rows[0]?.total);
    const totalPendente = fmtMoney(qPendente.rows[0]?.total);
    const totalVencido = fmtMoney(qVencido.rows[0]?.total);
    const totalCobrancas = qCountCobrancas.rows[0]?.total ?? 0;
    const totalClientes = qClientesAtivos.rows[0]?.total ?? 0;

    // Monta linhas da tabela
    const rowsHtml = qRows.rows
      .map((r) => {
        const badgeClass =
          r.status === "pago" ? "pago" : r.status === "vencido" ? "vencido" : "pendente";

        const desc = (r.descricao || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const cliente = (r.cliente || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        return `
          <tr>
            <td class="mono">#${r.id}</td>
            <td>
              <div class="strong">${cliente}</div>
              <div class="muted small">${desc || "&nbsp;"}</div>
            </td>
            <td>${fmtDate(r.vencimento)}</td>
            <td>${fmtMoney(r.valor_original)}</td>
            <td>${fmtMoney(r.juros)}</td>
            <td>${fmtMoney(r.multa)}</td>
            <td class="strong">${fmtMoney(r.valor_atualizado)}</td>
            <td><span class="badge ${badgeClass}">${String(r.status || "").toUpperCase()}</span></td>
          </tr>
        `;
      })
      .join("");

    // HTML com o “jeito ACERTIVE”
    const html = `
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Relatório ACERTIVE</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root{
      --bg1:#070707; --bg2:#131313;
      --card:#0f0f10cc; --card2:#111114f2;
      --gold:#FFD700; --gold2:#FFA500;
      --white:#ffffff; --muted:#b9b9b9;
      --line:rgba(255,215,0,.18);
      --shadow: 0 18px 60px rgba(0,0,0,.62);
      --shadowSoft: 0 10px 28px rgba(0,0,0,.50);
      --radius:18px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:'Montserrat',sans-serif;
      color:var(--white);
      background:
        radial-gradient(900px 500px at 20% 20%, rgba(255,215,0,.10), transparent 55%),
        radial-gradient(800px 500px at 85% 20%, rgba(255,165,0,.10), transparent 50%),
        linear-gradient(135deg, var(--bg1), var(--bg2));
    }
    .page{
      padding: 26px;
    }
    .topbar{
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
      border: 1px solid rgba(255,215,0,.18);
      box-shadow: var(--shadowSoft);
      padding: 16px 18px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      overflow:hidden;
    }
    .brand{
      display:flex; align-items:center; gap:10px;
      font-weight:900; letter-spacing:.4px;
    }
    .mark{
      width:42px;height:42px;border-radius:14px;
      background: linear-gradient(135deg, rgba(255,215,0,.95), rgba(255,165,0,.95));
      display:flex;align-items:center;justify-content:center;
      color:#111;font-weight:900;
      box-shadow: 0 10px 20px rgba(255,215,0,.18);
    }
    .brand small{display:block;color:rgba(255,215,0,.92);font-weight:700;margin-top:2px;font-size:12px}
    .meta{
      text-align:right;
      font-size:12px;
      color:rgba(255,255,255,.75);
      line-height:1.3;
    }
    .meta .gold{color:rgba(255,215,0,.95); font-weight:800}
    .grid{
      margin-top: 16px;
      display:grid;
      grid-template-columns: repeat(4, 1fr);
      gap:12px;
    }
    .card{
      border-radius: var(--radius);
      background: linear-gradient(180deg, var(--card), var(--card2));
      border: 1px solid rgba(255,215,0,.20);
      box-shadow: var(--shadow);
      padding: 14px 14px;
      min-height: 86px;
    }
    .kpiTitle{
      font-size: 11px;
      letter-spacing:.6px;
      text-transform: uppercase;
      color: rgba(255,215,0,.92);
      font-weight: 900;
      margin-bottom: 8px;
    }
    .kpiValue{
      font-size: 18px;
      font-weight: 900;
      color: rgba(255,255,255,.96);
    }
    .divider{
      height:1px;
      background: linear-gradient(90deg, transparent, rgba(255,215,0,.22), transparent);
      margin: 16px 0;
    }
    .sectionTitle{
      display:flex; align-items:center; justify-content:space-between;
      gap:10px;
      margin: 0 0 10px;
    }
    .sectionTitle h2{
      margin:0;
      font-size: 16px;
      font-weight: 900;
      letter-spacing:.2px;
    }
    .sectionTitle .hint{
      font-size: 12px;
      color: rgba(255,255,255,.70);
    }

    .tableWrap{
      border-radius: 16px;
      border: 1px solid rgba(255,215,0,.14);
      background: rgba(0,0,0,.18);
      overflow: hidden;
      box-shadow: var(--shadowSoft);
    }
    table{
      width:100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    th, td{
      padding: 10px 10px;
      border-bottom: 1px solid rgba(255,255,255,.08);
      vertical-align: top;
    }
    th{
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing:.6px;
      color: rgba(255,215,0,.95);
      background: rgba(0,0,0,.30);
    }
    .badge{
      display:inline-flex;
      padding: 5px 8px;
      border-radius: 999px;
      font-weight: 900;
      letter-spacing:.3px;
      border: 1px solid rgba(255,215,0,.18);
      background: rgba(255,215,0,.10);
      color: rgba(255,215,0,.95);
      white-space:nowrap;
      font-size: 10px;
    }
    .badge.pago{
      border-color: rgba(40,167,69,.35);
      background: rgba(40,167,69,.12);
      color: rgba(40,167,69,.95);
    }
    .badge.vencido{
      border-color: rgba(220,53,69,.35);
      background: rgba(220,53,69,.12);
      color: rgba(220,53,69,.95);
    }
    .badge.pendente{
      border-color: rgba(255,215,0,.25);
      background: rgba(255,215,0,.12);
      color: rgba(255,215,0,.95);
    }
    .muted{color: rgba(255,255,255,.65)}
    .small{font-size:10px}
    .strong{font-weight:900}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace}

    .footer{
      margin-top: 10px;
      display:flex;
      justify-content:space-between;
      color: rgba(255,255,255,.55);
      font-size: 10px;
    }

    /* para PDF: quebra boa */
    tr{page-break-inside: avoid;}
    @page { size: A4; margin: 14mm; }
  </style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand">
        <div class="mark">A</div>
        <div>
          ACERTIVE
          <small>Relatório de Cobranças</small>
        </div>
      </div>
      <div class="meta">
        <div><span class="gold">Período:</span> ${periodLabel}</div>
        <div class="muted">Gerado em: ${new Date().toLocaleString("pt-BR")}</div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="kpiTitle">Total Recebido</div>
        <div class="kpiValue">${totalRecebido}</div>
      </div>
      <div class="card">
        <div class="kpiTitle">Total Pendente</div>
        <div class="kpiValue">${totalPendente}</div>
      </div>
      <div class="card">
        <div class="kpiTitle">Total Vencido</div>
        <div class="kpiValue">${totalVencido}</div>
      </div>
      <div class="card">
        <div class="kpiTitle">Clientes / Cobranças</div>
        <div class="kpiValue">${totalClientes} / ${totalCobrancas}</div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="sectionTitle">
      <h2>Detalhamento</h2>
      <div class="hint">Total de itens: ${qRows.rows.length}</div>
    </div>

    <div class="tableWrap">
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
          ${rowsHtml || `<tr><td colspan="8" class="muted">Nenhuma cobrança encontrada no período.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="footer">
      <div>© ${new Date().getFullYear()} ACERTIVE</div>
      <div class="muted">Relatório gerado automaticamente</div>
    </div>
  </div>
</body>
</html>
    `;

    // Renderiza HTML -> PDF
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });

    await browser.close();
    browser = null;

    const fileName = hasRange
      ? `relatorio_acertive_${start}_a_${end}.pdf`
      : `relatorio_acertive_completo.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    console.error("[RELATORIO PDF] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao exportar relatório (PDF).", error: err.message });
  }
});
// =====================
// 404 (por último)
// =====================
app.use((req, res) => res.status(404).send("Página não encontrada."));

// =====================
// Start
// =====================
app.listen(PORT, () => {
  console.log(`[ACERTIVE] Servidor rodando na porta ${PORT}`);
  console.log("[ACERTIVE] Allowed origins:", allowedOrigins);
});