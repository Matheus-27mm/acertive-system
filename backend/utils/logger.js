/**
 * Sistema de Log/Auditoria - ACERTIVE
 */

/**
 * Registra ação no sistema de auditoria
 * @param {Object} pool - Pool de conexão PostgreSQL
 * @param {Object} req - Request do Express
 * @param {string} acao - Tipo de ação (CRIAR, ATUALIZAR, EXCLUIR, etc)
 * @param {string} entidade - Nome da entidade (cobrancas, clientes, etc)
 * @param {string} entidadeId - ID do registro
 * @param {Object} detalhes - Detalhes adicionais
 */
async function registrarLog(pool, req, acao, entidade, entidadeId = null, detalhes = null) {
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

/**
 * Cria função de log com pool já injetado
 */
function createLogger(pool) {
  return async (req, acao, entidade, entidadeId = null, detalhes = null) => {
    return registrarLog(pool, req, acao, entidade, entidadeId, detalhes);
  };
}

module.exports = { registrarLog, createLogger };
