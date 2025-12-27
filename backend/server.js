/**
 * server.js — ACERTIVE (PostgreSQL + JWT + Front estático)
 * Corrigido:
 * - remove duplicate require("path")
 * - remove rota /api/dashboard duplicada (fica só uma)
 * - FRONTEND_DIR resolve automaticamente e não quebra caso não exista
 * - adiciona rota /cadastro
 * - melhora CORS para aceitar múltiplos origins (Render + domínio + localhost)
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

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

// =====================
// Frontend: descobrir pasta automaticamente
// =====================
const FRONTEND_DIR_CANDIDATES = [
  path.join(__dirname, "frontend"),       // backend/frontend
  path.join(__dirname, "..", "frontend"), // raiz/frontend  ✅ seu caso
];

const FRONTEND_DIR = FRONTEND_DIR_CANDIDATES.find((p) => fs.existsSync(p));

if (!FRONTEND_DIR) {
  console.error("[ACERTIVE] ERRO: Pasta do frontend não encontrada.");
  console.error("[ACERTIVE] Tentativas:", FRONTEND_DIR_CANDIDATES);
} else {
  console.log("[ACERTIVE] Servindo arquivos estáticos de:", FRONTEND_DIR);
  app.use(express.static(FRONTEND_DIR));
}

// =====================
// Middlewares
// =====================

// CORS: aceita lista por env (recomendado) ou fallback seguro
// Exemplo de FRONTEND_ORIGIN no Render:
// FRONTEND_ORIGIN=https://acertivecobranca.com.br,https://www.acertivecobranca.com.br,http://localhost:3000
const originEnv = (process.env.FRONTEND_ORIGIN || "").trim();
const allowedOrigins = originEnv
  ? originEnv.split(",").map((s) => s.trim()).filter(Boolean)
  : [
      "http://localhost:3000",
      "https://acertivecobranca.com.br",
      "https://www.acertivecobranca.com.br",
    ];

app.use(
  cors({
    origin: function (origin, cb) {
      // requests sem origin (curl, healthchecks) devem passar
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

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
// API: Dashboard (KPIs) — protegido (APENAS UMA VERSÃO)
// =====================
app.get("/api/dashboard", auth, async (req, res) => {
  try {
    const qClientes = await pool.query(
      "SELECT COUNT(*)::int AS total FROM clientes WHERE lower(trim(status)) = 'ativo'"
    );
    const qCobrancas = await pool.query("SELECT COUNT(*)::int AS total FROM cobrancas");
    const qRecebido = await pool.query(
      "SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'pago'"
    );
    const qPendente = await pool.query(
      "SELECT COALESCE(SUM(valor_atualizado), 0)::numeric AS total FROM cobrancas WHERE status = 'pendente'"
    );

    return res.json({
      success: true,
      clientesAtivos: Number(qClientes.rows?.[0]?.total ?? 0),
      totalCobrancas: Number(qCobrancas.rows?.[0]?.total ?? 0),
      totalRecebido: Number(qRecebido.rows?.[0]?.total ?? 0),
      totalPendente: Number(qPendente.rows?.[0]?.total ?? 0),
    });
  } catch (err) {
    console.error("[DASHBOARD] erro:", err.message);
    return res.status(500).json({
      success: false,
      message: "Erro ao carregar dados do dashboard.",
      error: err.message,
    });
  }
});

// =====================
// Rotas estáticas do frontend
// (só registra se FRONTEND_DIR existir)
// =====================
function sendFront(file) {
  return (req, res) => {
    if (!FRONTEND_DIR) return res.status(500).send("Frontend não encontrado no servidor.");
    return res.sendFile(path.join(FRONTEND_DIR, file));
  };
}
app.get("/", sendFront("login.html"));
app.get("/login", sendFront("login.html"));
app.get("/dashboard", sendFront("dashboard.html"));
app.get("/nova-cobranca", sendFront("nova-cobranca.html"));
app.get("/novo-cliente", sendFront("novo-cliente.html"));
app.get("/cobrancas", sendFront("cobrancas.html"));
app.get("/clientes-ativos", sendFront("clientes-ativos.html"));

// =====================
// APIs: cobranças
// =====================

// GET cobranças (mantive como você tinha: público)
app.get("/api/cobrancas", async (req, res) => {
  try {
    const resultado = await pool.query("SELECT * FROM cobrancas ORDER BY created_at DESC");
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
    const clienteId = asStr(b.cliente_id);
    const valorOriginal = round2(num(b.valor_original || b.valorOriginal));
    const vencimento = toPgDateOrNull(b.vencimento);

    if (!cliente && !clienteId) {
      return res.status(400).json({ success: false, message: "Cliente ou cliente ID são obrigatórios." });
    }
    if (!valorOriginal || !vencimento) {
      return res.status(400).json({ success: false, message: "Valor e vencimento são obrigatórios." });
    }

    const buscaCliente = await pool.query(
      "SELECT id FROM clientes WHERE LOWER(nome) = LOWER($1) OR id = $2 LIMIT 1",
      [cliente, clienteId]
    );
    if (buscaCliente.rowCount === 0) {
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
      [buscaCliente.rows[0].id, b.descricao || null, valorOriginal, multa, juros, desconto, vencimento, status, valorAtualizado]
    );

    return res.json({ success: true, data: novaCobranca.rows[0] });
  } catch (err) {
    console.error("[POST /api/cobrancas] erro:", err.message);
    return res.status(500).json({ success: false, message: "Erro ao salvar cobrança.", error: err.message });
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

// GET clientes ativos (mantive público como estava)
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

// Alias opcional caso algum front esteja chamando outro endpoint antigo
app.get("/api/relatorio/exportar", auth, (req, res) => {
  // redireciona para o correto
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return res.redirect(`/api/relatorios/export-csv${qs}`);
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
});
