/**
 * ROTAS DE CREDORES - ACERTIVE
 * Empresas que contratam o escritório para cobrar
 * CORRIGIDO: credor_id -> empresa_id
 */

const express = require('express');
const router = express.Router();

module.exports = (pool, auth, registrarLog) => {

  // =====================================================
  // GET /api/credores - Listar todos os credores
  // =====================================================
  router.get('/', auth, async (req, res) => {
    try {
      const { status, search, ordem } = req.query;
      
      let sql = `
        SELECT 
          cr.*,
          COUNT(DISTINCT c.id) as total_cobrancas,
          COUNT(DISTINCT c.cliente_id) as total_devedores,
          COALESCE(SUM(CASE WHEN c.status IN ('pendente', 'vencido') THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_carteira,
          COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_recuperado
        FROM credores cr
        LEFT JOIN cobrancas c ON c.empresa_id = cr.id
        WHERE 1=1
      `;
      
      const params = [];
      let idx = 1;
      
      if (status) {
        sql += ` AND cr.status = $${idx}`;
        params.push(status);
        idx++;
      }
      
      if (search) {
        sql += ` AND (cr.nome ILIKE $${idx} OR cr.cnpj ILIKE $${idx})`;
        params.push(`%${search}%`);
        idx++;
      }
      
      sql += ` GROUP BY cr.id`;
      
      switch (ordem) {
        case 'carteira':
          sql += ' ORDER BY valor_carteira DESC';
          break;
        case 'recuperado':
          sql += ' ORDER BY valor_recuperado DESC';
          break;
        case 'recente':
          sql += ' ORDER BY cr.created_at DESC';
          break;
        default:
          sql += ' ORDER BY cr.nome ASC';
      }
      
      const resultado = await pool.query(sql, params);
      
      const credores = resultado.rows.map(cr => ({
        ...cr,
        taxa_recuperacao: parseFloat(cr.valor_carteira) > 0 
          ? ((parseFloat(cr.valor_recuperado) / (parseFloat(cr.valor_carteira) + parseFloat(cr.valor_recuperado))) * 100).toFixed(1)
          : 0
      }));
      
      return res.json({ success: true, data: credores });
      
    } catch (err) {
      console.error('[GET /api/credores] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao listar credores.' });
    }
  });

  // =====================================================
  // GET /api/credores/stats - Estatísticas gerais
  // =====================================================
  router.get('/stats', auth, async (req, res) => {
    try {
      const stats = await pool.query(`
        SELECT 
          COUNT(DISTINCT cr.id)::int as total_credores,
          COUNT(DISTINCT CASE WHEN cr.status = 'ativo' THEN cr.id END)::int as credores_ativos,
          COALESCE(SUM(CASE WHEN c.status IN ('pendente', 'vencido') THEN c.valor_atualizado ELSE 0 END), 0)::numeric as total_carteira,
          COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado ELSE 0 END), 0)::numeric as total_recuperado
        FROM credores cr
        LEFT JOIN cobrancas c ON c.empresa_id = cr.id
      `);
      
      const row = stats.rows[0];
      const taxaGeral = (parseFloat(row.total_carteira) + parseFloat(row.total_recuperado)) > 0
        ? ((parseFloat(row.total_recuperado) / (parseFloat(row.total_carteira) + parseFloat(row.total_recuperado))) * 100).toFixed(1)
        : 0;
      
      return res.json({
        success: true,
        data: {
          totalCredores: row.total_credores,
          credoresAtivos: row.credores_ativos,
          totalCarteira: parseFloat(row.total_carteira),
          totalRecuperado: parseFloat(row.total_recuperado),
          taxaRecuperacao: parseFloat(taxaGeral)
        }
      });
      
    } catch (err) {
      console.error('[GET /api/credores/stats] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar estatísticas.' });
    }
  });

  // =====================================================
  // GET /api/credores/:id - Buscar credor por ID
  // =====================================================
  router.get('/:id', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const resultado = await pool.query(`
        SELECT 
          cr.*,
          COUNT(DISTINCT c.id)::int as total_cobrancas,
          COUNT(DISTINCT c.cliente_id)::int as total_devedores,
          COALESCE(SUM(CASE WHEN c.status IN ('pendente', 'vencido') THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_carteira,
          COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_recuperado
        FROM credores cr
        LEFT JOIN cobrancas c ON c.empresa_id = cr.id
        WHERE cr.id = $1
        GROUP BY cr.id
      `, [id]);
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Credor não encontrado.' });
      }
      
      return res.json({ success: true, data: resultado.rows[0] });
      
    } catch (err) {
      console.error('[GET /api/credores/:id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar credor.' });
    }
  });

  // =====================================================
  // POST /api/credores - Criar novo credor
  // =====================================================
  router.post('/', auth, async (req, res) => {
    try {
      const b = req.body || {};
      
      const nome = String(b.nome || '').trim();
      if (!nome) {
        return res.status(400).json({ success: false, message: 'Nome é obrigatório.' });
      }
      
      if (b.cnpj) {
        const existe = await pool.query(
          'SELECT id FROM credores WHERE cnpj = $1',
          [b.cnpj.replace(/\D/g, '')]
        );
        if (existe.rowCount > 0) {
          return res.status(400).json({ success: false, message: 'CNPJ já cadastrado.' });
        }
      }
      
      const resultado = await pool.query(`
        INSERT INTO credores (
          nome, razao_social, cnpj, telefone, email,
          contato_nome, contato_telefone, contato_email,
          endereco, cidade, estado, cep,
          comissao_tipo, comissao_percentual, comissao_meta, comissao_valor_fixo,
          permite_desconto, desconto_maximo, permite_parcelamento, parcelas_maximo,
          banco, agencia, conta, tipo_conta, pix_tipo, pix_chave,
          observacoes, status, multa_atraso, juros_atraso, tipo_juros, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, NOW()
        ) RETURNING *
      `, [
        nome,
        b.razao_social || null,
        b.cnpj ? b.cnpj.replace(/\D/g, '') : null,
        b.telefone || null,
        b.email || null,
        b.contato_nome || null,
        b.contato_telefone || null,
        b.contato_email || null,
        b.endereco || null,
        b.cidade || null,
        b.estado || null,
        b.cep || null,
        b.comissao_tipo || 'percentual',
        b.comissao_percentual || 10,
        b.comissao_meta || null,
        b.comissao_valor_fixo || null,
        b.permite_desconto !== false,
        b.desconto_maximo || 30,
        b.permite_parcelamento !== false,
        b.parcelas_maximo || 12,
        b.banco || null,
        b.agencia || null,
        b.conta || null,
        b.tipo_conta || 'corrente',
        b.pix_tipo || null,
        b.pix_chave || null,
        b.observacoes || null,
        b.status || 'ativo',
        b.multa_atraso || 2,
        b.juros_atraso || 1,
        b.tipo_juros || 'simples'
      ]);
      
      await registrarLog(req, 'CRIAR', 'credores', resultado.rows[0].id, { nome });
      
      return res.status(201).json({ 
        success: true, 
        data: resultado.rows[0],
        message: 'Credor cadastrado com sucesso!'
      });
      
    } catch (err) {
      console.error('[POST /api/credores] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao criar credor.' });
    }
  });

  // =====================================================
  // PUT /api/credores/:id - Atualizar credor
  // =====================================================
  router.put('/:id', auth, async (req, res) => {
    try {
      const { id } = req.params;
      const b = req.body || {};
      
      const resultado = await pool.query(`
        UPDATE credores SET
          nome = COALESCE($1, nome),
          razao_social = COALESCE($2, razao_social),
          cnpj = COALESCE($3, cnpj),
          telefone = COALESCE($4, telefone),
          email = COALESCE($5, email),
          contato_nome = COALESCE($6, contato_nome),
          contato_telefone = COALESCE($7, contato_telefone),
          contato_email = COALESCE($8, contato_email),
          endereco = COALESCE($9, endereco),
          cidade = COALESCE($10, cidade),
          estado = COALESCE($11, estado),
          cep = COALESCE($12, cep),
          comissao_tipo = COALESCE($13, comissao_tipo),
          comissao_percentual = COALESCE($14, comissao_percentual),
          comissao_meta = COALESCE($15, comissao_meta),
          comissao_valor_fixo = COALESCE($16, comissao_valor_fixo),
          permite_desconto = COALESCE($17, permite_desconto),
          desconto_maximo = COALESCE($18, desconto_maximo),
          permite_parcelamento = COALESCE($19, permite_parcelamento),
          parcelas_maximo = COALESCE($20, parcelas_maximo),
          banco = COALESCE($21, banco),
          agencia = COALESCE($22, agencia),
          conta = COALESCE($23, conta),
          tipo_conta = COALESCE($24, tipo_conta),
          pix_tipo = COALESCE($25, pix_tipo),
          pix_chave = COALESCE($26, pix_chave),
          observacoes = COALESCE($27, observacoes),
          status = COALESCE($28, status),
          multa_atraso = COALESCE($29, multa_atraso),
          juros_atraso = COALESCE($30, juros_atraso),
          tipo_juros = COALESCE($31, tipo_juros),
          updated_at = NOW()
        WHERE id = $32
        RETURNING *
      `, [
        b.nome, b.razao_social, b.cnpj ? b.cnpj.replace(/\D/g, '') : null,
        b.telefone, b.email, b.contato_nome, b.contato_telefone, b.contato_email,
        b.endereco, b.cidade, b.estado, b.cep,
        b.comissao_tipo, b.comissao_percentual, b.comissao_meta, b.comissao_valor_fixo,
        b.permite_desconto, b.desconto_maximo, b.permite_parcelamento, b.parcelas_maximo,
        b.banco, b.agencia, b.conta, b.tipo_conta, b.pix_tipo, b.pix_chave,
        b.observacoes, b.status,
        b.multa_atraso, b.juros_atraso, b.tipo_juros,
        id
      ]);
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Credor não encontrado.' });
      }
      
      await registrarLog(req, 'ATUALIZAR', 'credores', id, b);
      
      return res.json({ 
        success: true, 
        data: resultado.rows[0],
        message: 'Credor atualizado com sucesso!'
      });
      
    } catch (err) {
      console.error('[PUT /api/credores/:id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao atualizar credor.' });
    }
  });

  // =====================================================
  // DELETE /api/credores/:id - Desativar credor
  // =====================================================
  router.delete('/:id', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const cobrancas = await pool.query(`
        SELECT COUNT(*)::int as total 
        FROM cobrancas 
        WHERE empresa_id = $1 AND status IN ('pendente', 'vencido')
      `, [id]);
      
      if (parseInt(cobrancas.rows[0].total) > 0) {
        await pool.query(
          'UPDATE credores SET status = $1, updated_at = NOW() WHERE id = $2',
          ['inativo', id]
        );
        await registrarLog(req, 'DESATIVAR', 'credores', id, { motivo: 'possui_cobrancas' });
        return res.json({ success: true, message: 'Credor inativado (possui cobranças pendentes).' });
      }
      
      const resultado = await pool.query('DELETE FROM credores WHERE id = $1 RETURNING *', [id]);
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Credor não encontrado.' });
      }
      
      await registrarLog(req, 'EXCLUIR', 'credores', id, null);
      
      return res.json({ success: true, message: 'Credor removido com sucesso.' });
      
    } catch (err) {
      console.error('[DELETE /api/credores/:id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao remover credor.' });
    }
  });

  // =====================================================
  // GET /api/credores/:id/cobrancas - Cobranças do credor
  // =====================================================
  router.get('/:id/cobrancas', auth, async (req, res) => {
    try {
      const { id } = req.params;
      const { status, page = 1, limit = 50 } = req.query;
      
      let sql = `
        SELECT 
          c.*,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          cl.telefone as cliente_telefone
        FROM cobrancas c
        LEFT JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.empresa_id = $1
      `;
      
      const params = [id];
      let idx = 2;
      
      if (status) {
        sql += ` AND c.status = $${idx}`;
        params.push(status);
        idx++;
      }
      
      sql += ` ORDER BY c.vencimento DESC LIMIT $${idx} OFFSET $${idx + 1}`;
      params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
      
      const resultado = await pool.query(sql, params);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/credores/:id/cobrancas] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar cobranças.' });
    }
  });

  // =====================================================
  // GET /api/credores/:id/financeiro - Resumo financeiro
  // =====================================================
  router.get('/:id/financeiro', auth, async (req, res) => {
    try {
      const { id } = req.params;
      const { mes, ano } = req.query;
      
      const anoAtual = ano || new Date().getFullYear();
      const mesAtual = mes || (new Date().getMonth() + 1);
      
      const resumo = await pool.query(`
        SELECT 
          COALESCE(SUM(CASE WHEN status = 'pago' THEN valor_atualizado ELSE 0 END), 0)::numeric as total_recuperado,
          COALESCE(SUM(CASE WHEN status IN ('pendente', 'vencido') THEN valor_atualizado ELSE 0 END), 0)::numeric as total_pendente,
          COUNT(CASE WHEN status = 'pago' THEN 1 END)::int as cobrancas_pagas,
          COUNT(CASE WHEN status IN ('pendente', 'vencido') THEN 1 END)::int as cobrancas_pendentes
        FROM cobrancas
        WHERE empresa_id = $1
      `, [id]);
      
      const recuperadoMes = await pool.query(`
        SELECT COALESCE(SUM(valor_atualizado), 0)::numeric as valor
        FROM cobrancas
        WHERE empresa_id = $1 
          AND status = 'pago'
          AND EXTRACT(MONTH FROM updated_at) = $2
          AND EXTRACT(YEAR FROM updated_at) = $3
      `, [id, mesAtual, anoAtual]);
      
      const credor = await pool.query(
        'SELECT comissao_tipo, comissao_percentual, comissao_meta, comissao_valor_fixo FROM credores WHERE id = $1',
        [id]
      );
      
      const config = credor.rows[0] || {};
      const valorRecuperadoMes = parseFloat(recuperadoMes.rows[0].valor) || 0;
      
      let comissaoMes = 0;
      if (config.comissao_tipo === 'percentual') {
        comissaoMes = (valorRecuperadoMes * parseFloat(config.comissao_percentual || 10)) / 100;
      } else if (config.comissao_tipo === 'fixo') {
        comissaoMes = parseFloat(config.comissao_valor_fixo) || 0;
      } else if (config.comissao_tipo === 'meta' && config.comissao_meta) {
        if (valorRecuperadoMes >= parseFloat(config.comissao_meta)) {
          comissaoMes = parseFloat(config.comissao_valor_fixo) || 0;
        }
      }
      
      const valorRepasse = valorRecuperadoMes - comissaoMes;
      
      return res.json({
        success: true,
        data: {
          geral: resumo.rows[0],
          mes: {
            periodo: `${mesAtual}/${anoAtual}`,
            recuperado: valorRecuperadoMes,
            comissao: comissaoMes,
            repasse: valorRepasse
          },
          configComissao: config
        }
      });
      
    } catch (err) {
      console.error('[GET /api/credores/:id/financeiro] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar financeiro.' });
    }
  });

  return router;
};
