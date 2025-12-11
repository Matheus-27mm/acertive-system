require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Conexão com PostgreSQL
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Rota de teste do banco
app.get('/api/teste', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ msg: 'Banco conectado!', time: result.rows[0].now });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// REGISTRO REAL
app.post('/api/register', async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Dados incompletos' });

    try {
        const hashed = await bcrypt.hash(senha, 10);
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING id, nome, email',
            [nome, email, hashed]
        );
        res.json({ usuario: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ erro: 'Email já cadastrado' });
        res.status(500).json({ erro: err.message });
    }
});

// LOGIN REAL
app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Dados incompletos' });

    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ erro: 'Credenciais inválidas' });

        const user = result.rows[0];
        const ok = await bcrypt.compare(senha, user.senha_hash);
        if (!ok) return res.status(401).json({ erro: 'Credenciais inválidas' });

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, usuario: { id: user.id, nome: user.nome, email: user.email } });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

// ROTA PROTEGIDA (exemplo)
app.get('/api/usuario', autenticar, async (req, res) => {
    const result = await pool.query('SELECT id, nome, email FROM usuarios WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
});

// Middleware de autenticação
function autenticar(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ erro: 'Token necessário' });

    const token = auth.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch {
        res.status(403).json({ erro: 'Token inválido' });
    }
}

// Iniciar servidor
app.listen(PORT, () => console.log(`🚀 Servidor rodando em http://localhost:${PORT}`));

