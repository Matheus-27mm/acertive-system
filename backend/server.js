// server.js — ACERTIVE (PostgreSQL + Admin único + JWT + View vw_cobrancas)
// Render ENV obrigatórias:
// DATABASE_URL, JWT_SECRET
// (opcional para criar o admin automaticamente no 1º deploy): ADMIN_EMAIL, ADMIN_PASS

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// =====================
// STATIC (frontend) - agora dentro de backend/frontend
// =====================
const FRONTEND_DIR = path.join(__dirname, "frontend");
app.use(express.static(FRONTEND_DIR));

// =====================
// MIDDLEWARES
// =====================
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// =====================
// POSTGRES (Render via DATABASE_URL)
// =====================
if (!process.env.DATABASE_URL) {
  console.error("[ACERTIVE] ENV DATABASE_URL não definida.");
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error("[ACERTIVE] ENV JWT_SECRET não definida.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// =====================
// HELPERS
// =====================
function asStr(v) {
  return String(v ?? "").trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : "id_" + Date.now() + "_" + Math.random();
}

function isUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

// =====================
// AUTH (JWT)
// =====================
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ success: false, message: "Não autenticado." });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Token inválido/expirado." });
  }
}

// =====================
// INIT DB (tabelas + triggers + view)
// =====================
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id UUID PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT,
      telefone TEXT,
      cpf_cnpj TEXT,
      tipo TEXT DEFAULT 'pf',
      status TEXT DEFAULT 'ativo',
      endereco TEXT DEFAULT '',
      observacoes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cobrancas (
      id UUID PRIMARY KEY,
      cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

      valor_original NUMERIC(12,2) NOT NULL,
      vencimento DATE NOT NULL,
      pagamento DATE,

      taxa TEXT DEFAULT '8%',
      taxa_percent NUMERIC(8,4) DEFAULT 0,
      juros NUMERIC(12,2) DEFAULT 0,
      multa NUMERIC(12,2) DEFAULT 0,
      dias INT DEFAULT 0,

      valor_atualizado NUMERIC(12,2) DEFAULT 0,
      status TEXT DEFAULT 'pendente',

      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      action TEXT NOT NULL,
      record_id TEXT NOT NULL,
      payload JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated_at') THEN
        CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW
        EXECUTE FUNCTION set_updated_at();
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_clientes_updated_at') THEN
        CREATE TRIGGER trg_clientes_updated_at
        BEFORE UPDATE ON clientes
        FOR EACH ROW
        EXECUTE FUNCTION set_updated_at();
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cobrancas_updated_at') THEN
        CREATE TRIGGER trg_cobrancas_updated_at
        BEFORE UPDATE ON cobrancas
        FOR EACH ROW
        EXECUTE FUNCTION set_updated_at();
      END IF;
    END;
    $$;
  `);

  await pool.query(`
   CREATE OR REPLACE VIEW vw_cobrancas AS
  SELECT
    c.id,
    c.cliente_id,
    cl.nome AS cliente_nome,
    cl.email AS cliente_email,
    cl.telefone AS cliente_telefone,

    c.valor_original,
    c.vencimento,
    c.pago_em,
    c.taxa,
    c.taxa_percent,
    c.juros,
    c.multa,
    c.dias,
    c.valor_atualizado,
    c.status,
    c.created_at,
    c.updated_at
  FROM cobrancas c
  JOIN clientes cl ON cl.id = c.cliente_id;

  `);

  // Bootstrap admin (opcional)
  const adminEmail = asStr(process.env.ADMIN_EMAIL).toLowerCase();
  const adminPass = asStr(process.env.ADMIN_PASS);

  if (adminEmail && adminPass) {
    const exists = await pool.query("SELECT id FROM users WHERE email=$1", [adminEmail]);
    if (exists.rowCount === 0) {
      const hash = await bcrypt.hash(adminPass, 10);
      await pool.query("INSERT INTO users (nome, email, senha_hash) VALUES ($1,$2,$3)", [
        "Administrador",
        adminEmail,
        hash,
      ]);
      console.log("[ACERTIVE] Admin criado via ENV (ADMIN_EMAIL/ADMIN_PASS).");
    } else {
      console.log("[ACERTIVE] Admin já existe.");
    }
  } else {
    console.log("[ACERTIVE] ADMIN_EMAIL/ADMIN_PASS não definidos (ok).");
  }
}

// =====================
// LOGIN (sem cadastro público)
// =====================
app.post("/api/login", async (req, res) => {
  try {
    const email = asStr(req.body?.email).toLowerCase();
    const senha = asStr(req.body?.senha);

    if (!email || !senha) {
      return res.status(400).json({ success: false, message: "Informe email e senha." });
    }

    const r = await pool.query("SELECT id, nome, email, senha_hash FROM users WHERE email=$1", [email]);
    if (r.rowCount === 0) {
      return res.status(401).json({ success: false, message: "Usuário ou senha inválidos." });
    }

    const u = r.rows[0];
    const ok = await bcrypt.compare(senha, u.senha_hash);
    if (!ok) return res.status(401).json({ success: false, message: "Usuário ou senha inválidos." });

    const token = jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: "8h" });

    return res.json({
      success: true,
      token,
      usuario: { id: u.id, nome: u.nome, email: u.email },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Erro no login", error: err.message });
  }
});

// Trocar senha (admin logado)
app.put("/api/admin/senha", auth, async (req, res) => {
  try {
    const senhaAtual = asStr(req.body?.senhaAtual);
    const novaSenha = asStr(req.body?.novaSenha);

    if (!senhaAtual || !novaSenha) {
      return res.status(400).json({ success: false, message: "Informe senhaAtual e novaSenha." });
    }

    const r = await pool.query("SELECT senha_hash FROM users WHERE id=$1", [req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ success: false, message: "Usuário não encontrado." });

    const ok = await bcrypt.compare(senhaAtual, r.rows[0].senha_hash);
    if (!ok) return res.status(401).json({ success: false, message: "Senha atual incorreta." });

    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query("UPDATE users SET senha_hash=$1 WHERE id=$2", [hash, req.user.id]);

    return res.json({ success: true, message: "Senha alterada com sucesso." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Erro ao trocar senha", error: err.message });
  }
});

// =====================
// CLIENTES (CRUD) — PROTEGIDO
// =====================
app.get("/api/clientes", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM clientes ORDER BY created_at DESC");
  res.json({ success: true, data: r.rows });
});

app.post("/api/clientes/novo", auth, async (req, res) => {
  const b = req.body || {};
  const id = uuid();

  const nome = asStr(b.nome || b.name);
  const email = asStr(b.email);
  const telefone = asStr(b.telefone || b.phone);
  const cpf_cnpj = asStr(b.cpf_cnpj || b.cpfCnpj || b.cpf || b.cnpj);
  const tipo = asStr(b.tipo || b.type || "pf").toLowerCase();
  const status = asStr(b.status || "ativo").toLowerCase();
  const endereco = asStr(b.endereco || b.address || "");
  const observacoes = asStr(b.observacoes || b.notes || "");

  if (!nome) return res.status(400).json({ success: false, message: "Nome é obrigatório." });

  await pool.query(
    `INSERT INTO clientes (id, nome, email, telefone, cpf_cnpj, tipo, status, endereco, observacoes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, nome, email, telefone, cpf_cnpj, tipo, status, endereco, observacoes]
  );

  const r = await pool.query("SELECT * FROM clientes WHERE id=$1", [id]);
  return res.json({ success: true, data: r.rows[0] });
});

app.put("/api/clientes/:id", auth, async (req, res) => {
  const id = asStr(req.params.id);
  const b = req.body || {};

  const cur = await pool.query("SELECT * FROM clientes WHERE id=$1", [id]);
  if (cur.rowCount === 0) return res.status(404).json({ success: false, message: "Cliente não encontrado." });

  const c = cur.rows[0];

  const nome = asStr(b.nome || b.name) || c.nome;
  const email = asStr(b.email) || c.email;
  const telefone = asStr(b.telefone || b.phone) || c.telefone;
  const cpf_cnpj = asStr(b.cpf_cnpj || b.cpfCnpj || b.cpf || b.cnpj) || c.cpf_cnpj;
  const tipo = (asStr(b.tipo || b.type) || c.tipo || "pf").toLowerCase();
  const status = (asStr(b.status) || c.status || "ativo").toLowerCase();
  const endereco = asStr(b.endereco || b.address) || c.endereco;
  const observacoes = asStr(b.observacoes || b.notes) || c.observacoes;

  await pool.query(
    `UPDATE clientes
     SET nome=$1, email=$2, telefone=$3, cpf_cnpj=$4, tipo=$5, status=$6, endereco=$7, observacoes=$8
     WHERE id=$9`,
    [nome, email, telefone, cpf_cnpj, tipo, status, endereco, observacoes, id]
  );

  const r = await pool.query("SELECT * FROM clientes WHERE id=$1", [id]);
  return res.json({ success: true, data: r.rows[0] });
});

app.delete("/api/clientes/:id", auth, async (req, res) => {
  const id = asStr(req.params.id);
  await pool.query("DELETE FROM clientes WHERE id=$1", [id]);
  return res.json({ success: true });
});

// =====================
// COBRANÇAS — PROTEGIDO
// =====================
app.get("/api/cobrancas", auth, async (req, res) => {
  const status = asStr(req.query.status).toLowerCase();
  const q = asStr(req.query.q).toLowerCase();

  let sql = "SELECT * FROM vw_cobrancas";
  const params = [];
  const where = [];

  if (status) {
    params.push(status);
    where.push(`LOWER(status) = $${params.length}`);
  }

  if (q) {
    params.push(`%${q}%`);
    where.push(`LOWER(cliente_nome) LIKE $${params.length}`);
  }

  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at DESC";

  const r = await pool.query(sql, params);
  return res.json({ success: true, data: r.rows });
});

app.post("/api/cobrancas", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const id = uuid();

    let cliente_id = asStr(b.cliente_id || b.clienteId);
    const clienteNome = asStr(b.cliente || "");

    if (!cliente_id && clienteNome) {
      const rCli = await pool.query(
        "SELECT id FROM clientes WHERE LOWER(nome)=LOWER($1) ORDER BY created_at DESC LIMIT 1",
        [clienteNome]
      );
      if (rCli.rowCount) cliente_id = rCli.rows[0].id;
    }

    if (!cliente_id || !isUUID(cliente_id)) {
      return res.status(400).json({
        success: false,
        message: "Informe cliente_id válido (UUID). (Ou envie cliente=nome existente).",
      });
    }

    const valor_original = num(b.valorOriginal ?? b.valor_original);
    const vencimento = asStr(b.vencimento);
    if (!valor_original || !vencimento) {
      return res.status(400).json({
        success: false,
        message: "Campos obrigatórios: valorOriginal e vencimento (e cliente_id).",
      });
    }

    const pagamento = asStr(b.pagamento || "") || null;
    const taxa = asStr(b.taxa || "8%");
    const taxa_percent = num(b.taxaPercent ?? b.taxa_percent ?? 0);
    const juros = num(b.juros ?? 0);
    const multa = num(b.multa ?? 0);
    const dias = Number(b.dias ?? 0);
    const valor_atualizado = num(b.valorAtualizado ?? b.valor_atualizado ?? valor_original);
    const status = asStr(b.status || (dias > 0 ? "pendente" : "em-dia")).toLowerCase();

    await pool.query(
      `INSERT INTO cobrancas
       (id, cliente_id, valor_original, vencimento, pagamento, taxa, taxa_percent, juros, multa, dias, valor_atualizado, status)
       VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        cliente_id,
        valor_original,
        vencimento,
        pagamento,
        taxa,
        taxa_percent,
        juros,
        multa,
        dias,
        valor_atualizado,
        status,
      ]
    );

    const out = await pool.query("SELECT * FROM vw_cobrancas WHERE id=$1", [id]);
    return res.status(201).json({ success: true, data: out.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Erro ao criar cobrança", error: err.message });
  }
});

app.put("/api/cobrancas/:id/status", auth, async (req, res) => {
  const id = asStr(req.params.id);
  const status = asStr(req.body?.status).toLowerCase();
  if (!status) return res.status(400).json({ success: false, message: "Status é obrigatório." });

  await pool.query("UPDATE cobrancas SET status=$1 WHERE id=$2", [status, id]);
  const r = await pool.query("SELECT * FROM vw_cobrancas WHERE id=$1", [id]);
  if (r.rowCount === 0) return res.status(404).json({ success: false, message: "Cobrança não encontrada." });

  return res.json({ success: true, data: r.rows[0] });
});

app.delete("/api/cobrancas/:id", auth, async (req, res) => {
  const id = asStr(req.params.id);
  await pool.query("DELETE FROM cobrancas WHERE id=$1", [id]);
  return res.json({ success: true });
});

// =====================
// DASHBOARD — PROTEGIDO
// =====================
app.get("/api/dashboard", auth, async (req, res) => {
  const clientesAtivos = await pool.query(
    "SELECT COUNT(*)::int AS n FROM clientes WHERE COALESCE(status,'ativo') <> 'inativo'"
  );

  const totalCobrancas = await pool.query("SELECT COUNT(*)::int AS n FROM cobrancas");

  const totalRecebido = await pool.query(
    "SELECT COALESCE(SUM(valor_atualizado),0)::float AS n FROM cobrancas WHERE LOWER(status)='pago'"
  );

  const totalPendente = await pool.query(
    "SELECT COALESCE(SUM(valor_atualizado),0)::float AS n FROM cobrancas WHERE LOWER(status)='pendente'"
  );

  res.json({
    clientesAtivos: clientesAtivos.rows[0].n,
    totalCobrancas: totalCobrancas.rows[0].n,
    totalRecebido: totalRecebido.rows[0].n,
    totalPendente: totalPendente.rows[0].n,
  });
});

// =====================
// ROTAS DE PÁGINAS (frontend)
// =====================
const sendFrontend = (file) => (req, res) => res.sendFile(path.join(FRONTEND_DIR, file));

app.get("/", sendFrontend("login.html"));
app.get("/login", sendFrontend("login.html"));
app.get("/dashboard", sendFrontend("dashboard.html"));
app.get("/clientes-ativos", sendFrontend("clientes-ativos.html"));
app.get("/novo-cliente", sendFrontend("novo-cliente.html"));
app.get("/nova-cobranca", sendFrontend("nova-cobranca.html"));
app.get("/cobrancas", sendFrontend("cobrancas.html"));

app.get("/cadastro", (req, res) => res.status(404).send("Rota /cadastro desabilitada em produção."));

// =====================
// START
// =====================
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`[ACERTIVE] Servidor rodando na porta ${PORT}`));
  })
  .catch((e) => {
    console.error("[ACERTIVE] Falha ao iniciar DB:", e.message);
    process.exit(1);
  });
