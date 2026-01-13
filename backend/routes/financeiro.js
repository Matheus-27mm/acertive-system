/**
 * ROTAS FINANCEIRO - ACERTIVE
 * Comissões e Repasses aos Credores
 */

const express = require('express');
const router = express.Router();

module.exports = (pool, auth, registrarLog) => {

  // =====================================================
  // GET /api/financeiro/resumo - Resumo financeiro geral
  // =====================================================
  router.get('/resumo', auth, async (req, res) => {
    try {
      const { mes, ano } = req.query;
      
      const anoAtual = ano || new Date().getFullYear();
      const mesAtual = mes || (new Date().getMonth() + 1);
      
      // Total recuperado no mês
      const recuperado = await pool.query(`
        SELECT 
          COUNT(*)::int as quantidade,
          COALESCE(SUM(valor_pago), 0)::numeric as valor
        FROM parcelas
        WHERE status = 'pago'
          AND EXTRACT(MONTH FROM data_pagamento) = $1
          AND EXTRACT(YEAR FROM data_pagamento) = $2
      `, [mesAtual, anoAtual]);
      
      // Comissões do mês
      const comissoes = await pool.query(`
        SELECT 
          COALESCE(SUM(valor_comissao), 0)::numeric as total,
          COALESCE(SUM(CASE WHEN status = 'pago' THEN valor_comissao ELSE 0 END), 0)::numeric as pago,
          COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor_comissao ELSE 0 END), 0)::numeric as pendente
        FROM comissoes
        WHERE EXTRACT(MONTH FROM created_at) = $1
          AND EXTRACT(YEAR FROM created_at) = $2
      `, [mesAtual, anoAtual]);
      
      // Repasses do mês
      const repasses = await pool.query(`
        SELECT 
          COALESCE(SUM(valor), 0)::numeric as total,
          COALESCE(SUM(CASE WHEN status = 'pago' THEN valor ELSE 0 END), 0)::numeric as pago,
          COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor ELSE 0 END), 0)::numeric as pendente
        FROM repasses
        WHERE EXTRACT(MONTH FROM created_at) = $1
          AND EXTRACT(YEAR FROM created_at) = $2
      `, [mesAtual, anoAtual]);
      
      // Mês anterior para comparação
      let mesAnterior = mesAtual - 1;
      let anoAnterior = anoAtual;
      if (mesAnterior < 1) {
        mesAnterior = 12;
        anoAnterior = anoAtual - 1;
      }
      
      const recuperadoAnterior = await pool.query(`
        SELECT COALESCE(SUM(valor_pago), 0)::numeric as valor
        FROM parcelas
        WHERE status = 'pago'
          AND EXTRACT(MONTH FROM data_pagamento) = $1
          AND EXTRACT(YEAR FROM data_pagamento) = $2
      `, [mesAnterior, anoAnterior]);
      
      const valorAtual = parseFloat(recuperado.rows[0].valor) || 0;
      const valorAnterior = parseFloat(recuperadoAnterior.rows[0].valor) || 1;
      const variacao = ((valorAtual - valorAnterior) / valorAnterior * 100).toFixed(1);
      
      return res.json({
        success: true,
        data: {
          periodo: `${mesAtual}/${anoAtual}`,
          recuperado: {
            quantidade: recuperado.rows[0].quantidade,
            valor: valorAtual,
            variacao: parseFloat(variacao)
          },
          comissao: {
            total: parseFloat(comissoes.rows[0].total),
            pago: parseFloat(comissoes.rows[0].pago),
            pendente: parseFloat(comissoes.rows[0].pendente)
          },
          aRepassar: valorAtual - parseFloat(comissoes.rows[0].total),
          repasses: {
            total: parseFloat(repasses.rows[0].total),
            pago: parseFloat(repasses.rows[0].pago),
            pendente: parseFloat(repasses.rows[0].pendente)
          }
        }
      });
      
    } catch (err) {
      console.error('[GET /api/financeiro/resumo] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar resumo.' });
    }
  });

  // =====================================================
  // GET /api/financeiro/comissoes - Comissões por credor
  // =====================================================
  router.get('/comissoes', auth, async (req, res) => {
    try {
      const { mes, ano, status } = req.query;
      
      let sql = `
        SELECT 
          cr.id as credor_id,
          cr.nome as credor_nome,
          cr.comissao_percentual,
          COUNT(cm.id)::int as total_comissoes,
          COALESCE(SUM(cm.valor_base), 0)::numeric as valor_recuperado,
          COALESCE(SUM(cm.valor_comissao), 0)::numeric as valor_comissao,
          COALESCE(SUM(CASE WHEN cm.status = 'pago' THEN cm.valor_comissao ELSE 0 END), 0)::numeric as comissao_paga,
          COALESCE(SUM(CASE WHEN cm.status = 'pendente' THEN cm.valor_comissao ELSE 0 END), 0)::numeric as comissao_pendente
        FROM credores cr
        LEFT JOIN comissoes cm ON cm.credor_id = cr.id
      `;
      
      const params = [];
      const where = [];
      let idx = 1;
      
      if (mes && ano) {
        where.push(`EXTRACT(MONTH FROM cm.created_at) = $${idx} AND EXTRACT(YEAR FROM cm.created_at) = $${idx + 1}`);
        params.push(mes, ano);
        idx += 2;
      }
      
      if (status) {
        where.push(`cm.status = $${idx}`);
        params.push(status);
        idx++;
      }
      
      if (where.length > 0) {
        sql += ' WHERE ' + where.join(' AND ');
      }
      
      sql += ` GROUP BY cr.id, cr.nome, cr.comissao_percentual ORDER BY valor_comissao DESC`;
      
      const resultado = await pool.query(sql, params);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/financeiro/comissoes] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar comissões.' });
    }
  });

  // =====================================================
  // GET /api/financeiro/comissoes/:id - Detalhes comissão
  // =====================================================
  router.get('/comissoes/:id', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const resultado = await pool.query(`
        SELECT 
          cm.*,
          cr.nome as credor_nome,
          cl.nome as cliente_nome,
          p.numero as parcela_numero,
          a.numero_parcelas as total_parcelas
        FROM comissoes cm
        LEFT JOIN credores cr ON cr.id = cm.credor_id
        LEFT JOIN parcelas p ON p.id = cm.parcela_id
        LEFT JOIN acordos a ON a.id = cm.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        WHERE cm.id = $1
      `, [id]);
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Comissão não encontrada.' });
      }
      
      return res.json({ success: true, data: resultado.rows[0] });
      
    } catch (err) {
      console.error('[GET /api/financeiro/comissoes/:id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar comissão.' });
    }
  });

  // =====================================================
  // GET /api/financeiro/repasses - Repasses pendentes
  // =====================================================
  router.get('/repasses', auth, async (req, res) => {
    try {
      const { status } = req.query;
      
      let sql = `
        SELECT 
          r.*,
          cr.nome as credor_nome,
          cr.banco,
          cr.agencia,
          cr.conta,
          cr.tipo_conta,
          cr.pix_tipo,
          cr.pix_chave
        FROM repasses r
        LEFT JOIN credores cr ON cr.id = r.credor_id
        WHERE 1=1
      `;
      
      const params = [];
      
      if (status) {
        sql += ' AND r.status = $1';
        params.push(status);
      }
      
      sql += ' ORDER BY r.created_at DESC';
      
      const resultado = await pool.query(sql, params);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/financeiro/repasses] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar repasses.' });
    }
  });

  // =====================================================
  // GET /api/financeiro/repasses/calcular - Calcular pendentes
  // =====================================================
  router.get('/repasses/calcular', auth, async (req, res) => {
    try {
      // Calcular quanto deve para cada credor
      const resultado = await pool.query(`
        SELECT 
          cr.id as credor_id,
          cr.nome as credor_nome,
          cr.banco,
          cr.agencia,
          cr.conta,
          cr.tipo_conta,
          cr.pix_tipo,
          cr.pix_chave,
          COALESCE(SUM(p.valor_pago), 0)::numeric as total_recuperado,
          COALESCE(SUM(cm.valor_comissao), 0)::numeric as total_comissao,
          COALESCE((SELECT SUM(valor) FROM repasses WHERE credor_id = cr.id AND status = 'pago'), 0)::numeric as total_repassado
        FROM credores cr
        LEFT JOIN acordos a ON a.credor_id = cr.id
        LEFT JOIN parcelas p ON p.acordo_id = a.id AND p.status = 'pago'
        LEFT JOIN comissoes cm ON cm.credor_id = cr.id AND cm.status IN ('pago', 'pendente')
        WHERE cr.status = 'ativo'
        GROUP BY cr.id
        HAVING COALESCE(SUM(p.valor_pago), 0) - COALESCE(SUM(cm.valor_comissao), 0) - COALESCE((SELECT SUM(valor) FROM repasses WHERE credor_id = cr.id AND status = 'pago'), 0) > 0
      `);
      
      const credores = resultado.rows.map(cr => ({
        ...cr,
        valor_repasse: parseFloat(cr.total_recuperado) - parseFloat(cr.total_comissao) - parseFloat(cr.total_repassado)
      }));
      
      return res.json({ success: true, data: credores });
      
    } catch (err) {
      console.error('[GET /api/financeiro/repasses/calcular] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao calcular repasses.' });
    }
  });

  // =====================================================
  // POST /api/financeiro/repasses - Criar repasse
  // =====================================================
  router.post('/repasses', auth, async (req, res) => {
    try {
      const { credor_id, valor, forma_pagamento, comprovante, observacoes } = req.body || {};
      
      if (!credor_id || !valor) {
        return res.status(400).json({ success: false, message: 'Credor e valor são obrigatórios.' });
      }
      
      const resultado = await pool.query(`
        INSERT INTO repasses (
          credor_id, valor, forma_pagamento, comprovante, observacoes,
          status, data_repasse, criado_por, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'pago', NOW(), $6, NOW())
        RETURNING *
      `, [credor_id, parseFloat(valor), forma_pagamento || 'pix', comprovante, observacoes, req.user.userId]);
      
      await registrarLog(req, 'CRIAR', 'repasses', resultado.rows[0].id, { credor_id, valor });
      
      return res.status(201).json({
        success: true,
        data: resultado.rows[0],
        message: 'Repasse registrado com sucesso!'
      });
      
    } catch (err) {
      console.error('[POST /api/financeiro/repasses] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao criar repasse.' });
    }
  });

  // =====================================================
  // GET /api/financeiro/extrato - Extrato de movimentações
  // =====================================================
  router.get('/extrato', auth, async (req, res) => {
    try {
      const { credor_id, mes, ano, page = 1, limit = 50 } = req.query;
      
      // Pagamentos recebidos (entrada)
      let sqlPagamentos = `
        SELECT 
          'pagamento' as tipo,
          p.data_pagamento as data,
          p.valor_pago as valor,
          cl.nome as cliente,
          cr.nome as credor,
          cm.valor_comissao as comissao,
          p.id as referencia_id
        FROM parcelas p
        LEFT JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        LEFT JOIN comissoes cm ON cm.parcela_id = p.id
        WHERE p.status = 'pago'
      `;
      
      // Repasses (saída)
      let sqlRepasses = `
        SELECT 
          'repasse' as tipo,
          r.data_repasse as data,
          -r.valor as valor,
          NULL as cliente,
          cr.nome as credor,
          NULL as comissao,
          r.id as referencia_id
        FROM repasses r
        LEFT JOIN credores cr ON cr.id = r.credor_id
        WHERE r.status = 'pago'
      `;
      
      const params = [];
      let idx = 1;
      
      if (credor_id) {
        sqlPagamentos += ` AND a.credor_id = $${idx}`;
        sqlRepasses += ` AND r.credor_id = $${idx}`;
        params.push(credor_id);
        idx++;
      }
      
      if (mes && ano) {
        sqlPagamentos += ` AND EXTRACT(MONTH FROM p.data_pagamento) = $${idx} AND EXTRACT(YEAR FROM p.data_pagamento) = $${idx + 1}`;
        sqlRepasses += ` AND EXTRACT(MONTH FROM r.data_repasse) = $${idx} AND EXTRACT(YEAR FROM r.data_repasse) = $${idx + 1}`;
        params.push(mes, ano);
        idx += 2;
      }
      
      const sql = `
        (${sqlPagamentos})
        UNION ALL
        (${sqlRepasses})
        ORDER BY data DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `;
      
      params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
      
      const resultado = await pool.query(sql, params);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/financeiro/extrato] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar extrato.' });
    }
  });

  // =====================================================
  // GET /api/financeiro/prestacao-contas/:credor_id - Relatório
  // =====================================================
  router.get('/prestacao-contas/:credor_id', auth, async (req, res) => {
    try {
      const { credor_id } = req.params;
      const { mes, ano } = req.query;
      
      const anoAtual = ano || new Date().getFullYear();
      const mesAtual = mes || (new Date().getMonth() + 1);
      
      // Dados do credor
      const credor = await pool.query('SELECT * FROM credores WHERE id = $1', [credor_id]);
      
      if (!credor.rowCount) {
        return res.status(404).json({ success: false, message: 'Credor não encontrado.' });
      }
      
      // Pagamentos do período
      const pagamentos = await pool.query(`
        SELECT 
          p.*,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          a.numero_parcelas,
          cm.valor_comissao
        FROM parcelas p
        LEFT JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN comissoes cm ON cm.parcela_id = p.id
        WHERE a.credor_id = $1
          AND p.status = 'pago'
          AND EXTRACT(MONTH FROM p.data_pagamento) = $2
          AND EXTRACT(YEAR FROM p.data_pagamento) = $3
        ORDER BY p.data_pagamento ASC
      `, [credor_id, mesAtual, anoAtual]);
      
      // Totais
      const totalRecuperado = pagamentos.rows.reduce((sum, p) => sum + parseFloat(p.valor_pago || 0), 0);
      const totalComissao = pagamentos.rows.reduce((sum, p) => sum + parseFloat(p.valor_comissao || 0), 0);
      const valorRepasse = totalRecuperado - totalComissao;
      
      // Repasses já feitos no período
      const repassesFeitos = await pool.query(`
        SELECT COALESCE(SUM(valor), 0)::numeric as valor
        FROM repasses
        WHERE credor_id = $1
          AND status = 'pago'
          AND EXTRACT(MONTH FROM data_repasse) = $2
          AND EXTRACT(YEAR FROM data_repasse) = $3
      `, [credor_id, mesAtual, anoAtual]);
      
      const jaRepassado = parseFloat(repassesFeitos.rows[0].valor) || 0;
      const saldoARepassar = valorRepasse - jaRepassado;
      
      return res.json({
        success: true,
        data: {
          credor: credor.rows[0],
          periodo: `${mesAtual}/${anoAtual}`,
          resumo: {
            totalRecuperado,
            comissaoPercentual: credor.rows[0].comissao_percentual,
            totalComissao,
            valorRepasse,
            jaRepassado,
            saldoARepassar
          },
          pagamentos: pagamentos.rows
        }
      });
      
    } catch (err) {
      console.error('[GET /api/financeiro/prestacao-contas/:credor_id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao gerar prestação de contas.' });
    }
  });

  return router;
};
