/**
 * ROTAS FINANCEIRO - ACERTIVE
 * Comissões e Repasses aos Credores
 * COM CÁLCULO DE META E BONIFICAÇÃO
 */

const express = require('express');
const router = express.Router();

module.exports = (pool, auth, registrarLog) => {

  // =====================================================
  // GET /api/financeiro/resumo-credores - Resumo por credor
  // =====================================================
  router.get('/resumo-credores', auth, async (req, res) => {
    try {
      const { mes, ano } = req.query;
      
      const mesAtual = mes || (new Date().getMonth() + 1);
      const anoAtual = ano || new Date().getFullYear();
      
      // Buscar credores com valores recuperados no período
      const resultado = await pool.query(`
        SELECT 
          cr.id,
          cr.nome,
          cr.cnpj,
          cr.comissao_percentual,
          cr.comissao_meta,
          cr.comissao_bonus,
          cr.banco,
          cr.agencia,
          cr.conta,
          cr.tipo_conta,
          cr.pix_tipo,
          cr.pix_chave,
          COALESCE(SUM(CASE 
            WHEN c.status = 'pago' 
            AND EXTRACT(MONTH FROM c.data_pagamento) = $1 
            AND EXTRACT(YEAR FROM c.data_pagamento) = $2 
            THEN c.valor_pago ELSE 0 
          END), 0)::numeric as valor_recuperado
        FROM credores cr
        LEFT JOIN cobrancas c ON c.empresa_id = cr.id
        WHERE cr.status = 'ativo'
        GROUP BY cr.id
        ORDER BY cr.nome
      `, [mesAtual, anoAtual]);
      
      // Buscar repasses já feitos no período
      const repasses = await pool.query(`
        SELECT 
          credor_id,
          COALESCE(SUM(valor_repasse), 0)::numeric as total_repassado
        FROM repasses
        WHERE status = 'pago'
          AND EXTRACT(MONTH FROM data_repasse) = $1
          AND EXTRACT(YEAR FROM data_repasse) = $2
        GROUP BY credor_id
      `, [mesAtual, anoAtual]);
      
      const repassesMap = {};
      repasses.rows.forEach(r => { repassesMap[r.credor_id] = parseFloat(r.total_repassado) || 0; });
      
      let totalRecuperado = 0;
      let totalComissao = 0;
      let totalARepassar = 0;
      let totalJaRepassado = 0;
      
      const credores = resultado.rows.map(cr => {
        const recuperado = parseFloat(cr.valor_recuperado) || 0;
        const meta = parseFloat(cr.comissao_meta) || 0;
        const comissaoBase = parseFloat(cr.comissao_percentual) || 10;
        const bonus = parseFloat(cr.comissao_bonus) || 0;
        
        // Verificar se atingiu a meta
        const atingiuMeta = meta > 0 && recuperado >= meta;
        
        // Calcular comissão (base + bônus se atingiu meta)
        const percentualComissao = atingiuMeta ? (comissaoBase + bonus) : comissaoBase;
        const valorComissao = (recuperado * percentualComissao) / 100;
        
        // Valor a repassar = recuperado - comissão - já repassado
        const jaRepassado = repassesMap[cr.id] || 0;
        const valorARepassar = Math.max(0, recuperado - valorComissao - jaRepassado);
        
        totalRecuperado += recuperado;
        totalComissao += valorComissao;
        totalARepassar += valorARepassar;
        totalJaRepassado += jaRepassado;
        
        return {
          id: cr.id,
          nome: cr.nome,
          cnpj: cr.cnpj,
          comissao_percentual: comissaoBase,
          comissao_meta: meta,
          comissao_bonus: bonus,
          atingiu_meta: atingiuMeta,
          valor_recuperado: recuperado,
          valor_comissao: valorComissao,
          valor_a_repassar: valorARepassar,
          valor_ja_repassado: jaRepassado,
          banco: cr.banco,
          agencia: cr.agencia,
          conta: cr.conta,
          tipo_conta: cr.tipo_conta,
          pix_tipo: cr.pix_tipo,
          pix_chave: cr.pix_chave
        };
      });
      
      return res.json({
        success: true,
        data: {
          periodo: `${mesAtual}/${anoAtual}`,
          totais: {
            recuperado: totalRecuperado,
            comissao: totalComissao,
            aRepassar: totalARepassar,
            jaRepassado: totalJaRepassado
          },
          credores
        }
      });
      
    } catch (err) {
      console.error('[GET /api/financeiro/resumo-credores] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar resumo.' });
    }
  });

  // =====================================================
  // GET /api/financeiro/repasses - Listar repasses
  // =====================================================
  router.get('/repasses', auth, async (req, res) => {
    try {
      const { mes, ano, status, credor_id } = req.query;
      
      let sql = `
        SELECT 
          r.*,
          cr.nome as credor_nome,
          cr.cnpj as credor_cnpj
        FROM repasses r
        LEFT JOIN credores cr ON cr.id = r.credor_id
        WHERE 1=1
      `;
      
      const params = [];
      let idx = 1;
      
      if (mes && ano) {
        sql += ` AND EXTRACT(MONTH FROM r.data_repasse) = $${idx} AND EXTRACT(YEAR FROM r.data_repasse) = $${idx + 1}`;
        params.push(mes, ano);
        idx += 2;
      }
      
      if (status) {
        sql += ` AND r.status = $${idx}`;
        params.push(status);
        idx++;
      }
      
      if (credor_id) {
        sql += ` AND r.credor_id = $${idx}`;
        params.push(credor_id);
        idx++;
      }
      
      sql += ' ORDER BY r.data_repasse DESC, r.created_at DESC';
      
      const resultado = await pool.query(sql, params);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/financeiro/repasses] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar repasses.' });
    }
  });

  // =====================================================
  // POST /api/financeiro/repasses - Criar repasse
  // =====================================================
  router.post('/repasses', auth, async (req, res) => {
    try {
      const { credor_id, valor, data_repasse, comprovante, observacoes } = req.body || {};
      
      if (!credor_id || !valor) {
        return res.status(400).json({ success: false, message: 'Credor e valor são obrigatórios.' });
      }
      
      const resultado = await pool.query(`
        INSERT INTO repasses (
          credor_id, valor_repasse, data_repasse, comprovante_url, observacoes,
          status, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'pago', NOW())
        RETURNING *
      `, [
        credor_id, 
        parseFloat(valor), 
        data_repasse || new Date(),
        comprovante || null,
        observacoes || null
      ]);
      
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
  // GET /api/financeiro/resumo - Resumo financeiro geral
  // =====================================================
  router.get('/resumo', auth, async (req, res) => {
    try {
      const { mes, ano } = req.query;
      
      const mesAtual = mes || (new Date().getMonth() + 1);
      const anoAtual = ano || new Date().getFullYear();
      
      // Total recuperado no período
      const recuperado = await pool.query(`
        SELECT 
          COUNT(*)::int as quantidade,
          COALESCE(SUM(valor_pago), 0)::numeric as valor
        FROM cobrancas
        WHERE status = 'pago'
          AND EXTRACT(MONTH FROM data_pagamento) = $1
          AND EXTRACT(YEAR FROM data_pagamento) = $2
      `, [mesAtual, anoAtual]);
      
      // Repasses do período
      const repasses = await pool.query(`
        SELECT 
          COALESCE(SUM(valor_repasse), 0)::numeric as total
        FROM repasses
        WHERE status = 'pago'
          AND EXTRACT(MONTH FROM data_repasse) = $1
          AND EXTRACT(YEAR FROM data_repasse) = $2
      `, [mesAtual, anoAtual]);
      
      const valorRecuperado = parseFloat(recuperado.rows[0].valor) || 0;
      const valorRepassado = parseFloat(repasses.rows[0].total) || 0;
      
      return res.json({
        success: true,
        data: {
          periodo: `${mesAtual}/${anoAtual}`,
          recuperado: {
            quantidade: recuperado.rows[0].quantidade,
            valor: valorRecuperado
          },
          repassado: valorRepassado
        }
      });
      
    } catch (err) {
      console.error('[GET /api/financeiro/resumo] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar resumo.' });
    }
  });

  // =====================================================
  // GET /api/financeiro/prestacao-contas/:credor_id
  // =====================================================
  router.get('/prestacao-contas/:credor_id', auth, async (req, res) => {
    try {
      const { credor_id } = req.params;
      const { mes, ano } = req.query;
      
      const mesAtual = mes || (new Date().getMonth() + 1);
      const anoAtual = ano || new Date().getFullYear();
      
      // Dados do credor
      const credor = await pool.query('SELECT * FROM credores WHERE id = $1', [credor_id]);
      
      if (!credor.rowCount) {
        return res.status(404).json({ success: false, message: 'Credor não encontrado.' });
      }
      
      const dadosCredor = credor.rows[0];
      
      // Cobranças pagas no período
      const cobrancas = await pool.query(`
        SELECT 
          c.*,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf
        FROM cobrancas c
        LEFT JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.empresa_id = $1
          AND c.status = 'pago'
          AND EXTRACT(MONTH FROM c.data_pagamento) = $2
          AND EXTRACT(YEAR FROM c.data_pagamento) = $3
        ORDER BY c.data_pagamento ASC
      `, [credor_id, mesAtual, anoAtual]);
      
      // Calcular totais
      const totalRecuperado = cobrancas.rows.reduce((sum, c) => sum + parseFloat(c.valor_pago || 0), 0);
      
      const meta = parseFloat(dadosCredor.comissao_meta) || 0;
      const comissaoBase = parseFloat(dadosCredor.comissao_percentual) || 10;
      const bonus = parseFloat(dadosCredor.comissao_bonus) || 0;
      const atingiuMeta = meta > 0 && totalRecuperado >= meta;
      const percentualComissao = atingiuMeta ? (comissaoBase + bonus) : comissaoBase;
      const totalComissao = (totalRecuperado * percentualComissao) / 100;
      const valorRepasse = totalRecuperado - totalComissao;
      
      // Repasses já feitos no período
      const repassesFeitos = await pool.query(`
        SELECT COALESCE(SUM(valor_repasse), 0)::numeric as valor
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
          credor: dadosCredor,
          periodo: `${mesAtual}/${anoAtual}`,
          resumo: {
            totalRecuperado,
            meta,
            atingiuMeta,
            comissaoPercentual: percentualComissao,
            comissaoBase,
            bonus: atingiuMeta ? bonus : 0,
            totalComissao,
            valorRepasse,
            jaRepassado,
            saldoARepassar
          },
          cobrancas: cobrancas.rows
        }
      });
      
    } catch (err) {
      console.error('[GET /api/financeiro/prestacao-contas/:credor_id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao gerar prestação de contas.' });
    }
  });

  // =====================================================
  // DELETE /api/financeiro/repasses/:id - Cancelar repasse
  // =====================================================
  router.delete('/repasses/:id', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const resultado = await pool.query(
        'DELETE FROM repasses WHERE id = $1 RETURNING *',
        [id]
      );
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Repasse não encontrado.' });
      }
      
      await registrarLog(req, 'EXCLUIR', 'repasses', id, null);
      
      return res.json({ success: true, message: 'Repasse removido.' });
      
    } catch (err) {
      console.error('[DELETE /api/financeiro/repasses/:id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao remover repasse.' });
    }
  });

  return router;
};
