/**
 * ACERTIVE - MULTI-TENANT v2.2
 * Preparação do sistema para SaaS (múltiplas empresas)
 * 
 * COMO FUNCIONA:
 * - Cada usuário pertence a uma empresa
 * - Cada empresa só vê seus próprios dados
 * - Dados são isolados automaticamente
 * 
 * COMO USAR:
 * 1. Execute o SQL abaixo no seu banco de dados
 * 2. Cole o código JavaScript no seu server.js
 */

// =====================================================
// SQL PARA ADICIONAR SUPORTE MULTI-TENANT
// Execute este SQL no seu banco de dados PostgreSQL
// =====================================================
/*

-- 1. Adicionar empresa_id aos usuários
ALTER TABLE users ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);

-- 2. Criar índices para performance
CREATE INDEX IF NOT EXISTS idx_cobrancas_empresa ON cobrancas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_users_empresa ON users(empresa_id);
CREATE INDEX IF NOT EXISTS idx_agendamentos_empresa ON agendamentos(cliente_id);

-- 3. Associar usuários existentes à empresa padrão
UPDATE users 
SET empresa_id = (SELECT id FROM empresas WHERE padrao = true LIMIT 1)
WHERE empresa_id IS NULL;

-- 4. Associar clientes existentes à empresa padrão
UPDATE clientes 
SET empresa_id = (SELECT id FROM empresas WHERE padrao = true LIMIT 1)
WHERE empresa_id IS NULL;

-- 5. Associar cobranças existentes à empresa padrão
UPDATE cobrancas 
SET empresa_id = (SELECT id FROM empresas WHERE padrao = true LIMIT 1)
WHERE empresa_id IS NULL;

-- 6. Tabela de planos (para futuro sistema de assinatura)
CREATE TABLE IF NOT EXISTS planos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  preco_mensal NUMERIC(10,2) NOT NULL DEFAULT 0,
  limite_usuarios INTEGER DEFAULT 5,
  limite_clientes INTEGER DEFAULT 100,
  limite_cobrancas_mes INTEGER DEFAULT 500,
  recursos JSONB DEFAULT '{}',
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 7. Inserir planos padrão
INSERT INTO planos (nome, descricao, preco_mensal, limite_usuarios, limite_clientes, limite_cobrancas_mes, recursos) VALUES
('Gratuito', 'Plano gratuito para teste', 0, 1, 50, 100, '{"email": false, "relatorios": false, "api": false}'),
('Básico', 'Ideal para pequenas empresas', 49.90, 3, 200, 500, '{"email": true, "relatorios": true, "api": false}'),
('Profissional', 'Para empresas em crescimento', 99.90, 10, 1000, 2000, '{"email": true, "relatorios": true, "api": true}'),
('Enterprise', 'Sem limites', 299.90, -1, -1, -1, '{"email": true, "relatorios": true, "api": true, "suporte_prioritario": true}')
ON CONFLICT DO NOTHING;

-- 8. Adicionar plano às empresas
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plano_id UUID REFERENCES planos(id);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS data_expiracao DATE;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS uso_mes JSONB DEFAULT '{"cobrancas": 0, "emails": 0}';

-- 9. Associar empresas ao plano gratuito por padrão
UPDATE empresas 
SET plano_id = (SELECT id FROM planos WHERE nome = 'Gratuito' LIMIT 1)
WHERE plano_id IS NULL;

*/

// =====================================================
// MIDDLEWARE MULTI-TENANT
// =====================================================

/**
 * Middleware que adiciona o filtro de empresa automaticamente
 * Cole isso APÓS a definição da função auth() no server.js
 */
async function authMultiTenant(req, res, next) {
  try {
    // Primeiro, fazer a autenticação normal
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ success: false, message: "Token não enviado." });
    
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    
    // Buscar empresa do usuário
    const userResult = await pool.query(
      'SELECT empresa_id FROM users WHERE id = $1',
      [payload.userId]
    );
    
    if (userResult.rows.length > 0 && userResult.rows[0].empresa_id) {
      req.user.empresa_id = userResult.rows[0].empresa_id;
    } else {
      // Se não tem empresa, usar a padrão
      const empresaPadrao = await pool.query(
        'SELECT id FROM empresas WHERE padrao = true LIMIT 1'
      );
      if (empresaPadrao.rows.length > 0) {
        req.user.empresa_id = empresaPadrao.rows[0].id;
      }
    }
    
    return next();
  } catch (err) {
    console.error("[AUTH MULTI-TENANT] erro:", err.message);
    return res.status(401).json({ success: false, message: "Token inválido ou expirado." });
  }
}

// =====================================================
// ROTAS MULTI-TENANT
// =====================================================

// GET /api/tenant/info - Informações da empresa do usuário
app.get('/api/tenant/info', auth, async (req, res) => {
  try {
    // Buscar empresa do usuário
    const userResult = await pool.query(`
      SELECT u.empresa_id, e.nome as empresa_nome, e.cnpj, e.plano_id,
             p.nome as plano_nome, p.limite_usuarios, p.limite_clientes, p.limite_cobrancas_mes,
             e.uso_mes
      FROM users u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      LEFT JOIN planos p ON p.id = e.plano_id
      WHERE u.id = $1
    `, [req.user.userId]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
    }
    
    const info = userResult.rows[0];
    
    // Contar uso atual
    const usoAtual = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users WHERE empresa_id = $1) as usuarios,
        (SELECT COUNT(*) FROM clientes WHERE empresa_id = $1) as clientes,
        (SELECT COUNT(*) FROM cobrancas WHERE empresa_id = $1 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)) as cobrancas_mes
    `, [info.empresa_id]);
    
    const uso = usoAtual.rows[0];
    
    res.json({
      success: true,
      data: {
        empresa: {
          id: info.empresa_id,
          nome: info.empresa_nome,
          cnpj: info.cnpj
        },
        plano: {
          nome: info.plano_nome || 'Gratuito',
          limites: {
            usuarios: info.limite_usuarios || 1,
            clientes: info.limite_clientes || 50,
            cobrancas_mes: info.limite_cobrancas_mes || 100
          }
        },
        uso: {
          usuarios: parseInt(uso.usuarios) || 0,
          clientes: parseInt(uso.clientes) || 0,
          cobrancas_mes: parseInt(uso.cobrancas_mes) || 0
        }
      }
    });
  } catch (err) {
    console.error('[TENANT INFO] erro:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao buscar informações' });
  }
});

// GET /api/tenant/limites - Verificar se atingiu limites
app.get('/api/tenant/limites', auth, async (req, res) => {
  try {
    const userResult = await pool.query(`
      SELECT u.empresa_id, p.limite_usuarios, p.limite_clientes, p.limite_cobrancas_mes
      FROM users u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      LEFT JOIN planos p ON p.id = e.plano_id
      WHERE u.id = $1
    `, [req.user.userId]);
    
    if (userResult.rows.length === 0) {
      return res.json({ success: true, dentroLimites: true });
    }
    
    const limites = userResult.rows[0];
    const empresaId = limites.empresa_id;
    
    // -1 significa ilimitado
    if (limites.limite_usuarios === -1 && limites.limite_clientes === -1 && limites.limite_cobrancas_mes === -1) {
      return res.json({ success: true, dentroLimites: true, planoIlimitado: true });
    }
    
    const usoAtual = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users WHERE empresa_id = $1) as usuarios,
        (SELECT COUNT(*) FROM clientes WHERE empresa_id = $1) as clientes,
        (SELECT COUNT(*) FROM cobrancas WHERE empresa_id = $1 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)) as cobrancas_mes
    `, [empresaId]);
    
    const uso = usoAtual.rows[0];
    
    const alertas = [];
    
    if (limites.limite_usuarios > 0 && parseInt(uso.usuarios) >= limites.limite_usuarios) {
      alertas.push({ tipo: 'usuarios', mensagem: 'Limite de usuários atingido' });
    }
    if (limites.limite_clientes > 0 && parseInt(uso.clientes) >= limites.limite_clientes) {
      alertas.push({ tipo: 'clientes', mensagem: 'Limite de clientes atingido' });
    }
    if (limites.limite_cobrancas_mes > 0 && parseInt(uso.cobrancas_mes) >= limites.limite_cobrancas_mes) {
      alertas.push({ tipo: 'cobrancas', mensagem: 'Limite de cobranças do mês atingido' });
    }
    
    res.json({
      success: true,
      dentroLimites: alertas.length === 0,
      alertas,
      uso: {
        usuarios: { atual: parseInt(uso.usuarios), limite: limites.limite_usuarios },
        clientes: { atual: parseInt(uso.clientes), limite: limites.limite_clientes },
        cobrancas_mes: { atual: parseInt(uso.cobrancas_mes), limite: limites.limite_cobrancas_mes }
      }
    });
  } catch (err) {
    console.error('[TENANT LIMITES] erro:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao verificar limites' });
  }
});

// GET /api/planos - Listar planos disponíveis
app.get('/api/planos', async (req, res) => {
  try {
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

// POST /api/tenant/upgrade - Solicitar upgrade de plano
app.post('/api/tenant/upgrade', auth, async (req, res) => {
  try {
    const { plano_id } = req.body;
    
    // Por enquanto, apenas registra a solicitação
    // Futuramente, integrar com gateway de pagamento
    
    await pool.query(`
      INSERT INTO logs_acoes (usuario_id, usuario_nome, acao, entidade, detalhes)
      VALUES ($1, $2, 'SOLICITAR_UPGRADE', 'planos', $3)
    `, [req.user.userId, req.user.nome, JSON.stringify({ plano_id })]);
    
    res.json({ 
      success: true, 
      message: 'Solicitação de upgrade registrada. Entraremos em contato em breve.' 
    });
  } catch (err) {
    console.error('[UPGRADE] erro:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao solicitar upgrade' });
  }
});

// =====================================================
// MIDDLEWARE DE VERIFICAÇÃO DE LIMITES
// Use antes de criar novos recursos
// =====================================================

async function verificarLimiteClientes(req, res, next) {
  try {
    const userResult = await pool.query(`
      SELECT u.empresa_id, p.limite_clientes
      FROM users u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      LEFT JOIN planos p ON p.id = e.plano_id
      WHERE u.id = $1
    `, [req.user.userId]);
    
    if (userResult.rows.length === 0) return next();
    
    const { empresa_id, limite_clientes } = userResult.rows[0];
    
    if (limite_clientes === -1) return next(); // Ilimitado
    
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM clientes WHERE empresa_id = $1',
      [empresa_id]
    );
    
    if (parseInt(countResult.rows[0].count) >= limite_clientes) {
      return res.status(403).json({
        success: false,
        message: 'Limite de clientes atingido. Faça upgrade do seu plano.',
        codigo: 'LIMITE_CLIENTES'
      });
    }
    
    next();
  } catch (err) {
    console.error('[LIMITE CLIENTES] erro:', err.message);
    next(); // Em caso de erro, permite continuar
  }
}

async function verificarLimiteCobrancas(req, res, next) {
  try {
    const userResult = await pool.query(`
      SELECT u.empresa_id, p.limite_cobrancas_mes
      FROM users u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      LEFT JOIN planos p ON p.id = e.plano_id
      WHERE u.id = $1
    `, [req.user.userId]);
    
    if (userResult.rows.length === 0) return next();
    
    const { empresa_id, limite_cobrancas_mes } = userResult.rows[0];
    
    if (limite_cobrancas_mes === -1) return next(); // Ilimitado
    
    const countResult = await pool.query(`
      SELECT COUNT(*) FROM cobrancas 
      WHERE empresa_id = $1 
        AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)
    `, [empresa_id]);
    
    if (parseInt(countResult.rows[0].count) >= limite_cobrancas_mes) {
      return res.status(403).json({
        success: false,
        message: 'Limite de cobranças do mês atingido. Faça upgrade do seu plano.',
        codigo: 'LIMITE_COBRANCAS'
      });
    }
    
    next();
  } catch (err) {
    console.error('[LIMITE COBRANCAS] erro:', err.message);
    next();
  }
}

// =====================================================
// ESTATÍSTICAS POR EMPRESA
// =====================================================

app.get('/api/tenant/estatisticas', auth, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT empresa_id FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    const empresaId = userResult.rows[0]?.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ success: false, message: 'Empresa não encontrada' });
    }
    
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM clientes WHERE empresa_id = $1 AND status = 'ativo') as clientes_ativos,
        (SELECT COUNT(*) FROM cobrancas WHERE empresa_id = $1) as total_cobrancas,
        (SELECT COUNT(*) FROM cobrancas WHERE empresa_id = $1 AND status = 'pago') as cobrancas_pagas,
        (SELECT COUNT(*) FROM cobrancas WHERE empresa_id = $1 AND status = 'vencido') as cobrancas_vencidas,
        (SELECT COALESCE(SUM(valor_atualizado), 0) FROM cobrancas WHERE empresa_id = $1 AND status = 'pago') as total_recebido,
        (SELECT COALESCE(SUM(valor_atualizado), 0) FROM cobrancas WHERE empresa_id = $1 AND status IN ('pendente', 'vencido')) as total_a_receber,
        (SELECT COUNT(*) FROM users WHERE empresa_id = $1 AND ativo = true) as usuarios_ativos
    `, [empresaId]);
    
    res.json({ success: true, data: stats.rows[0] });
  } catch (err) {
    console.error('[TENANT STATS] erro:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao buscar estatísticas' });
  }
});

console.log('[MULTI-TENANT] ✅ Sistema Multi-tenant carregado');
