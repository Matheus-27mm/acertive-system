/**
 * ========================================
 * ACERTIVE - Sistema de Cobranças
 * Server.js v3.0 - Refatorado e Organizado
 * ========================================
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const multer = require("multer");

const app = express();

// ========================================
// CONFIGURAÇÕES BÁSICAS
// ========================================

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, "frontend")))

// ========================================
// CONEXÃO COM BANCO DE DADOS
// ========================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Testar conexão
pool.query('SELECT NOW()')
    .then(() => console.log('✅ Banco de dados conectado'))
    .catch(err => console.error('❌ Erro ao conectar ao banco:', err));

// ========================================
// MIDDLEWARES DE AUTENTICAÇÃO
// ========================================

const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "acertive_secret_key_2024";

// Middleware de autenticação
const auth = (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        if (!token) {
            return res.status(401).json({ error: "Token não fornecido" });
        }
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: "Token inválido" });
    }
};

// Middleware de autenticação admin
const authAdmin = (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        if (!token) {
            return res.status(401).json({ error: "Token não fornecido" });
        }
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.perfil !== "admin") {
            return res.status(403).json({ error: "Acesso negado" });
        }
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: "Token inválido" });
    }
};

// ========================================
// SISTEMA DE LOG/AUDITORIA
// ========================================

async function registrarLog(userId, acao, tabela, registroId, detalhes = {}) {
    try {
        await pool.query(`
            INSERT INTO historico (usuario_id, acao, tabela, registro_id, detalhes, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
        `, [userId, acao, tabela, registroId, JSON.stringify(detalhes)]);
    } catch (error) {
        console.error('Erro ao registrar log:', error);
    }
}

// ========================================
// CONFIGURAÇÃO MULTER (UPLOAD)
// ========================================

const storage = multer.memoryStorage();
const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ========================================
// ROTA DE HEALTH CHECK
// ========================================

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ========================================
// IMPORTAR E REGISTRAR ROTAS
// ========================================

// Autenticação
const authRoutes = require("./routes/auth")(pool, registrarLog);
app.use("/api/auth", authRoutes);

// Rota de login alternativa (compatibilidade)
app.post("/api/login", async (req, res) => {
    // Redirecionar para /api/auth/login
    const authRouter = require("./routes/auth")(pool, registrarLog);
    req.url = "/login";
    authRouter.handle(req, res);
});

// Usuários
const usuariosRoutes = require("./routes/usuarios")(pool, auth, authAdmin, registrarLog);
app.use("/api/usuarios", usuariosRoutes);

// Empresas
const empresasRoutes = require("./routes/empresas")(pool, auth, registrarLog);
app.use("/api/empresas", empresasRoutes);

// Credores (se existir o arquivo, senão criar básico)
try {
    const credoresRoutes = require("./routes/credores")(pool, auth, registrarLog);
    app.use("/api/credores", credoresRoutes);
} catch (e) {
    console.log("⚠️ routes/credores.js não encontrado, usando rotas inline");
    // Rotas básicas de credores inline
    app.get("/api/credores", auth, async (req, res) => {
        const result = await pool.query("SELECT * FROM credores ORDER BY nome");
        res.json(result.rows);
    });
}

// Clientes (Devedores)
const clientesRoutes = require("./routes/clientes")(pool, auth, registrarLog);
app.use("/api/clientes", clientesRoutes);

// Cobranças - CORRIGIDO com credor_id
const cobrancasRoutes = require("./routes/cobrancas")(pool, auth, registrarLog);
app.use("/api/cobrancas", cobrancasRoutes);

// Acordos (se existir)
try {
    const acordosRoutes = require("./routes/acordos")(pool, auth, registrarLog);
    app.use("/api/acordos", acordosRoutes);
} catch (e) {
    console.log("⚠️ routes/acordos.js não encontrado");
}

// Parcelas (se existir)
try {
    const parcelasRoutes = require("./routes/parcelas")(pool, auth, registrarLog);
    app.use("/api/parcelas", parcelasRoutes);
} catch (e) {
    console.log("⚠️ routes/parcelas.js não encontrado");
}

// Financeiro (se existir)
try {
    const financeiroRoutes = require("./routes/financeiro")(pool, auth, registrarLog);
    app.use("/api/financeiro", financeiroRoutes);
} catch (e) {
    console.log("⚠️ routes/financeiro.js não encontrado");
}

// Dashboard
const dashboardRoutes = require("./routes/dashboard")(pool, auth);
app.use("/api/dashboard", dashboardRoutes);

// Agendamentos
const agendamentosRoutes = require("./routes/agendamentos")(pool, auth, registrarLog);
app.use("/api/agendamentos", agendamentosRoutes);

// Configurações
const configuracoesRoutes = require("./routes/configuracoes")(pool, auth, registrarLog);
app.use("/api/configuracoes", configuracoesRoutes);

// PDF
const pdfRoutes = require("./routes/pdf")(pool, auth, registrarLog);
app.use("/api/pdf", pdfRoutes);

// WhatsApp
const whatsappRoutes = require("./routes/whatsapp")(pool, auth, registrarLog);
app.use("/api/whatsapp", whatsappRoutes);

// Email
const emailRoutes = require("./routes/email")(pool, auth, registrarLog);
app.use("/api/email", emailRoutes);

// Asaas (webhooks e integração)
const asaasRoutes = require("./routes/asaas")(pool, auth, registrarLog);
app.use("/api/asaas", asaasRoutes);

// Régua de cobrança
const reguaRoutes = require("./routes/regua")(pool, auth, registrarLog);
app.use("/api/regua", reguaRoutes);

// Relatórios
const relatoriosRoutes = require("./routes/relatorios")(pool, auth, registrarLog);
app.use("/api/relatorios", relatoriosRoutes);

// Importação
const importacaoRoutes = require("./routes/importacao")(pool, auth, upload, registrarLog);
app.use("/api/importacao", importacaoRoutes);

// ========================================
// ROTAS DO FRONTEND (SPA)
// ========================================

const sendFront = (file) => (req, res) => {
    res.sendFile(path.join(__dirname, "frontend", file));
};

// Páginas principais
app.get("/", sendFront("login.html"));
app.get("/login", sendFront("login.html"));
app.get("/dashboard", sendFront("dashboard.html"));
app.get("/nova-cobranca", sendFront("nova-cobranca.html"));
app.get("/cobrancas", sendFront("cobrancas.html"));
app.get(["/novo-cliente", "/novo-cliente/"], sendFront("novo-cliente.html"));
app.get("/clientes", sendFront("clientes.html"));
app.get("/devedores", sendFront("clientes.html"));
app.get("/credores", sendFront("credores.html"));
app.get("/acordos", sendFront("acordos.html"));
app.get("/parcelas", sendFront("parcelas.html"));
app.get("/agendamentos", sendFront("agendamentos.html"));
app.get("/novo-agendamento", sendFront("novo-agendamento.html"));
app.get("/configuracoes", sendFront("configuracoes.html"));
app.get("/config", sendFront("configuracoes.html"));
app.get("/usuarios", sendFront("usuarios.html"));
app.get("/historico", sendFront("historico.html"));
app.get("/relatorios", sendFront("relatorios.html"));
app.get("/financeiro", sendFront("financeiro.html"));
app.get("/financeiro-b2b", sendFront("financeiro-b2b.html"));
app.get("/comissoes", sendFront("comissoes.html"));
app.get("/repasses", sendFront("repasses.html"));
app.get("/regua-cobranca", sendFront("regua-cobranca.html"));
app.get("/regua", sendFront("regua-cobranca.html"));
app.get("/fila-cobranca", sendFront("fila-cobranca.html"));
app.get("/fila", sendFront("fila-cobranca.html"));
app.get("/importar-cobrancas", sendFront("importar-cobrancas.html"));
app.get("/importar-clientes", sendFront("importar-clientes.html"));
app.get("/importar-massa", sendFront("importar-massa.html"));
app.get("/templates", sendFront("templates-mensagem.html"));
app.get("/simulador", sendFront("simulador.html"));
app.get("/atendimento", sendFront("atendimento.html"));
app.get("/dividas", sendFront("dividas.html"));
app.get("/lembretes", sendFront("lembretes.html"));
app.get("/cobrancas-recorrentes", sendFront("cobrancas-recorrentes.html"));
app.get("/nova-recorrente", sendFront("nova-recorrente.html"));

// Fallback para SPA - arquivos .html
app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    const htmlPath = path.join(__dirname, "frontend", req.path + ".html");
res.sendFile(htmlPath, (err) => {
    if (err) {
        res.sendFile(path.join(__dirname, "frontend", "login.html"));
    }
});
});

// ========================================
// TRATAMENTO DE ERROS
// ========================================

app.use((err, req, res, next) => {
    console.error("Erro:", err);
    res.status(500).json({ error: "Erro interno do servidor" });
});

// ========================================
// INICIAR SERVIDOR
// ========================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`
========================================
🚀 ACERTIVE v3.0 - Servidor Iniciado
========================================
📍 URL: http://localhost:${PORT}
📅 Data: ${new Date().toLocaleString('pt-BR')}
========================================
    `);
});

module.exports = app;
