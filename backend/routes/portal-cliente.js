/**
 * ============================================
 * ACERTIVE — Portal do Cliente (Devedor)
 * routes/portal-cliente.js
 * ============================================
 *
 * ROTAS:
 *  POST /api/portal-cliente/cadastro          — cria conta com CPF + nasc + senha
 *  POST /api/portal-cliente/login             — retorna JWT tipo:'cliente'
 *  GET  /api/portal-cliente/minhas-dividas    — dívidas + histórico (auth)
 *  POST /api/portal-cliente/proposta-acordo   — envia proposta (auth)
 *
 * REGISTRAR NO server.js:
 *  const portalClienteRoutes = require('./routes/portal-cliente');
 *  app.use('/api/portal-cliente', portalClienteRoutes(pool, jwt, bcrypt));
 *
 * MIGRATION SQL (rodar uma vez):
 *  ALTER TABLE clientes
 *    ADD COLUMN IF NOT EXISTS portal_senha_hash TEXT,
 *    ADD COLUMN IF NOT EXISTS portal_ativo BOOLEAN DEFAULT true;
 *
 *  CREATE TABLE IF NOT EXISTS propostas_acordo (
 *    id              SERIAL PRIMARY KEY,
 *    cliente_id      UUID REFERENCES clientes(id),   -- UUID igual ao id da tabela clientes
 *    valor_proposto  NUMERIC(12,2),
 *    forma_pagamento TEXT DEFAULT 'avista',
 *    num_parcelas    INTEGER DEFAULT 1,
 *    observacao      TEXT,
 *    status          TEXT DEFAULT 'pendente',
 *    created_at      TIMESTAMP DEFAULT NOW(),
 *    updated_at      TIMESTAMP DEFAULT NOW()
 *  );
 */

const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');

const JWT_SECRET  = process.env.JWT_SECRET || 'acertive_secret_key';
const SALT_ROUNDS = 10;

module.exports = function(pool) {
  const router = express.Router();

  /* ── middleware de auth do cliente ── */
  function authCliente(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token  = header.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ success: false, error: 'Token obrigatório' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.tipo !== 'cliente') throw new Error('Token inválido');
      req.cliente = decoded;
      next();
    } catch (e) {
      return res.status(401).json({ success: false, error: 'Token inválido ou expirado' });
    }
  }

  /* ── helpers ── */
  function limparCpf(cpf) { return (cpf || '').replace(/\D/g, ''); }

  function calcularJurosMulta(valor, diasAtraso, multa_pct, juros_pct) {
    if (diasAtraso <= 0) return parseFloat(valor) || 0;
    const v   = parseFloat(valor) || 0;
    const m   = v * ((parseFloat(multa_pct) || 2) / 100);
    const j   = v * ((parseFloat(juros_pct) || 9) / 100) * (diasAtraso / 30);
    return Math.round((v + m + j) * 100) / 100;
  }

  async function buscarConfigGlobal() {
    try {
      const r = await pool.query('SELECT multa_atraso, juros_atraso FROM configuracoes WHERE id = 1');
      if (r.rowCount > 0) return r.rows[0];
    } catch (e) {}
    return { multa_atraso: 2, juros_atraso: 9 };
  }

  /* ══════════════════════════════════════════════
     POST /api/portal-cliente/cadastro
     Body: { cpf, data_nascimento, senha }
  ══════════════════════════════════════════════ */
  router.post('/cadastro', async (req, res) => {
    try {
      const cpf   = limparCpf(req.body.cpf);
      const nasc  = req.body.data_nascimento;
      const senha = req.body.senha;

      if (cpf.length !== 11)  return res.status(400).json({ success: false, error: 'CPF inválido' });
      if (!nasc)              return res.status(400).json({ success: false, error: 'Data de nascimento obrigatória' });
      if (!senha || senha.length < 6)
                              return res.status(400).json({ success: false, error: 'Senha deve ter ao menos 6 caracteres' });

      /* verifica se CPF existe no sistema */
      const rCli = await pool.query(
        "SELECT id, nome, data_nascimento, portal_senha_hash FROM clientes WHERE REPLACE(REPLACE(REPLACE(cpf_cnpj,'.',''),'-',''),'/','') = $1 AND ativo = true LIMIT 1",
        [cpf]
      );

      if (rCli.rowCount === 0)
        return res.status(404).json({ success: false, error: 'CPF não encontrado no sistema. Verifique se está correto ou entre em contato.' });

      const cliente = rCli.rows[0];

      /* valida data de nascimento */
      const nascDB   = cliente.data_nascimento ? new Date(cliente.data_nascimento).toISOString().split('T')[0] : null;
      const nascReq  = new Date(nasc).toISOString().split('T')[0];
      if (nascDB && nascDB !== nascReq)
        return res.status(400).json({ success: false, error: 'Data de nascimento não confere com o cadastro.' });

      /* verifica se já tem conta */
      if (cliente.portal_senha_hash)
        return res.status(409).json({ success: false, error: 'Já existe uma conta para este CPF. Faça login.' });

      /* cria hash da senha */
      const hash = await bcrypt.hash(senha, SALT_ROUNDS);
      await pool.query(
        'UPDATE clientes SET portal_senha_hash = $1, portal_ativo = true, updated_at = NOW() WHERE id = $2',
        [hash, cliente.id]
      );

      const token = jwt.sign(
        { id: cliente.id, nome: cliente.nome, cpf, tipo: 'cliente' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({ success: true, token, cliente: { id: cliente.id, nome: cliente.nome } });

    } catch (e) {
      console.error('[PORTAL-CLIENTE] Erro cadastro:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /* ══════════════════════════════════════════════
     POST /api/portal-cliente/login
     Body: { cpf, senha }
  ══════════════════════════════════════════════ */
  router.post('/login', async (req, res) => {
    try {
      const cpf   = limparCpf(req.body.cpf);
      const senha = req.body.senha;

      if (cpf.length !== 11 || !senha)
        return res.status(400).json({ success: false, error: 'CPF e senha obrigatórios' });

      const rCli = await pool.query(
        "SELECT id, nome, portal_senha_hash, portal_ativo FROM clientes WHERE REPLACE(REPLACE(REPLACE(cpf_cnpj,'.',''),'-',''),'/','') = $1 AND ativo = true LIMIT 1",
        [cpf]
      );

      if (rCli.rowCount === 0)
        return res.status(401).json({ success: false, error: 'CPF não encontrado.' });

      const cliente = rCli.rows[0];

      if (!cliente.portal_senha_hash)
        return res.status(401).json({ success: false, error: 'Conta não encontrada. Crie uma conta primeiro.' });

      if (!cliente.portal_ativo)
        return res.status(403).json({ success: false, error: 'Conta bloqueada. Entre em contato.' });

      const senhaOk = await bcrypt.compare(senha, cliente.portal_senha_hash);
      if (!senhaOk)
        return res.status(401).json({ success: false, error: 'Senha incorreta.' });

      const token = jwt.sign(
        { id: cliente.id, nome: cliente.nome, cpf, tipo: 'cliente' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({ success: true, token, cliente: { id: cliente.id, nome: cliente.nome } });

    } catch (e) {
      console.error('[PORTAL-CLIENTE] Erro login:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /* ══════════════════════════════════════════════
     GET /api/portal-cliente/minhas-dividas
     Retorna: dívidas pendentes/vencidas com valores
              atualizados + histórico de acionamentos
  ══════════════════════════════════════════════ */
  router.get('/minhas-dividas', authCliente, async (req, res) => {
    try {
      const cliente_id = req.cliente.id;
      const cfg        = await buscarConfigGlobal();

      /* dados do cliente */
      const rCli = await pool.query('SELECT id, nome, cpf_cnpj, email, telefone FROM clientes WHERE id = $1', [cliente_id]);
      if (rCli.rowCount === 0) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
      const cliente = rCli.rows[0];

      /* cobranças pendentes/vencidas */
      const rCob = await pool.query(
        "SELECT cob.id, cob.valor, cob.status, cob.data_vencimento, cob.descricao, " +
        "  cr.nome as credor_nome, " +
        "  GREATEST(0, (CURRENT_DATE - cob.data_vencimento)::int) as dias_atraso " +
        "FROM cobrancas cob " +
        "LEFT JOIN credores cr ON cr.id = cob.credor_id " +
        "WHERE cob.cliente_id = $1 AND cob.status IN ('pendente','vencido') " +
        "ORDER BY cob.data_vencimento ASC",
        [cliente_id]
      );

      /* enriquecer com valor atualizado */
      const dividas = rCob.rows.map(d => ({
        ...d,
        valor_atualizado: calcularJurosMulta(d.valor, d.dias_atraso, cfg.multa_atraso, cfg.juros_atraso)
      }));

      /* resumo */
      const valor_total_original   = dividas.reduce((s, d) => s + parseFloat(d.valor  || 0), 0);
      const valor_total_atualizado = dividas.reduce((s, d) => s + parseFloat(d.valor_atualizado || 0), 0);
      const maior_atraso           = dividas.length ? Math.max(...dividas.map(d => d.dias_atraso || 0)) : 0;

      /* histórico: acionamentos + propostas */
      const rHist = await pool.query(
        "SELECT tipo, canal, resultado as descricao, created_at, NULL::numeric as valor " +
        "FROM acionamentos WHERE cliente_id = $1 " +
        "UNION ALL " +
        "SELECT 'proposta' as tipo, 'portal' as canal, " +
        "  'Proposta de acordo: ' || forma_pagamento || ' · R$ ' || valor_proposto::text as descricao, " +
        "  created_at, valor_proposto as valor " +
        "FROM propostas_acordo WHERE cliente_id = $1 " +
        "ORDER BY created_at DESC LIMIT 30",
        [cliente_id]
      );

      res.json({
        success: true,
        cliente: { id: cliente.id, nome: cliente.nome, cpf_cnpj: cliente.cpf_cnpj, email: cliente.email, telefone: cliente.telefone },
        dividas,
        resumo:  { qtd: dividas.length, valor_total_original, valor_total_atualizado, maior_atraso },
        historico: rHist.rows
      });

    } catch (e) {
      console.error('[PORTAL-CLIENTE] Erro minhas-dividas:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  /* ══════════════════════════════════════════════
     POST /api/portal-cliente/proposta-acordo
     Body: { valor_proposto, forma_pagamento, num_parcelas, observacao }
  ══════════════════════════════════════════════ */
  router.post('/proposta-acordo', authCliente, async (req, res) => {
    try {
      const cliente_id      = req.cliente.id;
      const valor_proposto  = parseFloat(req.body.valor_proposto) || 0;
      const forma_pagamento = req.body.forma_pagamento || 'avista';
      const num_parcelas    = parseInt(req.body.num_parcelas) || 1;
      const observacao      = (req.body.observacao || '').slice(0, 1000);

      if (valor_proposto <= 0)
        return res.status(400).json({ success: false, error: 'Informe um valor válido.' });

      /* salva proposta */
      await pool.query(
        "INSERT INTO propostas_acordo (cliente_id, valor_proposto, forma_pagamento, num_parcelas, observacao, status, created_at) " +
        "VALUES ($1, $2, $3, $4, $5, 'pendente', NOW())",
        [cliente_id, valor_proposto, forma_pagamento, num_parcelas, observacao]
      );

      /* registra acionamento para aparecer no sistema */
      await pool.query(
        "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) " +
        "VALUES ($1, 'proposta', 'portal', 'proposta_recebida', $2, NOW())",
        [cliente_id, `Proposta via portal: ${forma_pagamento} R$ ${valor_proposto.toFixed(2)}${num_parcelas > 1 ? ' em ' + num_parcelas + 'x' : ''}${observacao ? ' — ' + observacao.slice(0, 100) : ''}`]
      );

      res.json({ success: true, message: 'Proposta registrada! Entraremos em contato em breve.' });

    } catch (e) {
      console.error('[PORTAL-CLIENTE] Erro proposta-acordo:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
};