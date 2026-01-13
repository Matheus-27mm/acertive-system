/**
 * ROTAS DE PARCELAS - ACERTIVE
 * Controle de pagamentos dos acordos
 */

const express = require('express');
const router = express.Router();

module.exports = (pool, auth, registrarLog) => {

  // =====================================================
  // GET /api/parcelas - Listar parcelas
  // =====================================================
  router.get('/', auth, async (req, res) => {
    try {
      const { status, periodo, credor_id, acordo_id, page = 1, limit = 50 } = req.query;
      
      let sql = `
        SELECT 
          p.*,
          a.id as acordo_id,
          a.valor_acordo,
          a.numero_parcelas as total_parcelas,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          cl.telefone as cliente_telefone,
          cr.nome as credor_nome
        FROM parcelas p
        LEFT JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE 1=1
      `;
      
      const params = [];
      let idx = 1;
      
      if (status) {
        sql += ` AND p.status = $${idx}`;
        params.push(status);
        idx++;
      }
      
      if (credor_id) {
        sql += ` AND a.credor_id = $${idx}`;
        params.push(credor_id);
        idx++;
      }
      
      if (acordo_id) {
        sql += ` AND p.acordo_id = $${idx}`;
        params.push(acordo_id);
        idx++;
      }
      
      // Filtros de período
      if (periodo === 'hoje') {
        sql += ` AND DATE(p.data_vencimento) = CURRENT_DATE`;
      } else if (periodo === 'semana') {
        sql += ` AND p.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`;
      } else if (periodo === 'vencidas') {
        sql += ` AND p.data_vencimento < CURRENT_DATE AND p.status = 'pendente'`;
      } else if (periodo === 'mes') {
        sql += ` AND EXTRACT(MONTH FROM p.data_vencimento) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM p.data_vencimento) = EXTRACT(YEAR FROM CURRENT_DATE)`;
      }
      
      sql += ` ORDER BY p.data_vencimento ASC LIMIT $${idx} OFFSET $${idx + 1}`;
      params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
      
      const resultado = await pool.query(sql, params);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/parcelas] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao listar parcelas.' });
    }
  });

  // =====================================================
  // GET /api/parcelas/stats - Estatísticas de parcelas
  // =====================================================
  router.get('/stats', auth, async (req, res) => {
    try {
      const stats = await pool.query(`
        SELECT 
          COUNT(CASE WHEN DATE(data_vencimento) = CURRENT_DATE AND status = 'pendente' THEN 1 END)::int as vencendo_hoje,
          COALESCE(SUM(CASE WHEN DATE(data_vencimento) = CURRENT_DATE AND status = 'pendente' THEN valor ELSE 0 END), 0)::numeric as valor_hoje,
          
          COUNT(CASE WHEN data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND status = 'pendente' THEN 1 END)::int as vencendo_semana,
          COALESCE(SUM(CASE WHEN data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND status = 'pendente' THEN valor ELSE 0 END), 0)::numeric as valor_semana,
          
          COUNT(CASE WHEN data_vencimento < CURRENT_DATE AND status = 'pendente' THEN 1 END)::int as vencidas,
          COALESCE(SUM(CASE WHEN data_vencimento < CURRENT_DATE AND status = 'pendente' THEN valor ELSE 0 END), 0)::numeric as valor_vencidas,
          
          COUNT(CASE WHEN status = 'pago' AND EXTRACT(MONTH FROM data_pagamento) = EXTRACT(MONTH FROM CURRENT_DATE) THEN 1 END)::int as pagas_mes,
          COALESCE(SUM(CASE WHEN status = 'pago' AND EXTRACT(MONTH FROM data_pagamento) = EXTRACT(MONTH FROM CURRENT_DATE) THEN valor_pago ELSE 0 END), 0)::numeric as valor_pago_mes
        FROM parcelas
      `);
      
      const row = stats.rows[0];
      
      // Taxa de pagamento
      const totalParcelas = await pool.query(`SELECT COUNT(*)::int as total FROM parcelas WHERE data_vencimento <= CURRENT_DATE`);
      const totalPagas = await pool.query(`SELECT COUNT(*)::int as total FROM parcelas WHERE status = 'pago'`);
      
      const taxaPagamento = totalParcelas.rows[0].total > 0
        ? ((totalPagas.rows[0].total / totalParcelas.rows[0].total) * 100).toFixed(1)
        : 0;
      
      return res.json({
        success: true,
        data: {
          vencendoHoje: { quantidade: row.vencendo_hoje, valor: parseFloat(row.valor_hoje) },
          vencendoSemana: { quantidade: row.vencendo_semana, valor: parseFloat(row.valor_semana) },
          vencidas: { quantidade: row.vencidas, valor: parseFloat(row.valor_vencidas) },
          pagasMes: { quantidade: row.pagas_mes, valor: parseFloat(row.valor_pago_mes) },
          taxaPagamento: parseFloat(taxaPagamento)
        }
      });
      
    } catch (err) {
      console.error('[GET /api/parcelas/stats] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar estatísticas.' });
    }
  });

  // =====================================================
  // GET /api/parcelas/:id - Buscar parcela por ID
  // =====================================================
  router.get('/:id', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const resultado = await pool.query(`
        SELECT 
          p.*,
          a.valor_acordo,
          a.numero_parcelas as total_parcelas,
          cl.nome as cliente_nome,
          cl.telefone as cliente_telefone,
          cr.nome as credor_nome
        FROM parcelas p
        LEFT JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE p.id = $1
      `, [id]);
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Parcela não encontrada.' });
      }
      
      return res.json({ success: true, data: resultado.rows[0] });
      
    } catch (err) {
      console.error('[GET /api/parcelas/:id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar parcela.' });
    }
  });

  // =====================================================
  // POST /api/parcelas/:id/pagar - Registrar pagamento
  // =====================================================
  router.post('/:id/pagar', auth, async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      const { valor_pago, data_pagamento, forma_pagamento, observacoes } = req.body || {};
      
      await client.query('BEGIN');
      
      // Buscar parcela
      const parcela = await client.query(`
        SELECT p.*, a.id as acordo_id, a.credor_id, a.cobranca_id
        FROM parcelas p
        LEFT JOIN acordos a ON a.id = p.acordo_id
        WHERE p.id = $1
      `, [id]);
      
      if (!parcela.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Parcela não encontrada.' });
      }
      
      const p = parcela.rows[0];
      const valorPago = parseFloat(valor_pago) || p.valor;
      
      // Atualizar parcela
      await client.query(`
        UPDATE parcelas SET
          status = 'pago',
          valor_pago = $1,
          data_pagamento = $2,
          forma_pagamento = $3,
          observacoes = $4,
          updated_at = NOW()
        WHERE id = $5
      `, [valorPago, data_pagamento || new Date(), forma_pagamento || 'pix', observacoes, id]);
      
      // Verificar se todas as parcelas foram pagas
      const parcelasPendentes = await client.query(`
        SELECT COUNT(*)::int as total 
        FROM parcelas 
        WHERE acordo_id = $1 AND status != 'pago'
      `, [p.acordo_id]);
      
      if (parseInt(parcelasPendentes.rows[0].total) === 0) {
        // Acordo quitado!
        await client.query(
          'UPDATE acordos SET status = $1, updated_at = NOW() WHERE id = $2',
          ['quitado', p.acordo_id]
        );
        
        // Atualizar cobrança original
        if (p.cobranca_id) {
          await client.query(
            'UPDATE cobrancas SET status = $1, updated_at = NOW() WHERE id = $2',
            ['pago', p.cobranca_id]
          );
        }
      }
      
      // Registrar comissão (se tiver credor)
      if (p.credor_id) {
        const credor = await client.query(
          'SELECT comissao_percentual FROM credores WHERE id = $1',
          [p.credor_id]
        );
        
        if (credor.rowCount > 0) {
          const comissaoPerc = parseFloat(credor.rows[0].comissao_percentual) || 10;
          const comissaoValor = (valorPago * comissaoPerc) / 100;
          
          await client.query(`
            INSERT INTO comissoes (
              credor_id, parcela_id, acordo_id,
              valor_base, percentual, valor_comissao,
              status, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW())
          `, [p.credor_id, id, p.acordo_id, valorPago, comissaoPerc, comissaoValor]);
        }
      }
      
      await client.query('COMMIT');
      
      await registrarLog(req, 'PAGAR', 'parcelas', id, { valor_pago: valorPago, forma: forma_pagamento });
      
      const acordoQuitado = parseInt(parcelasPendentes.rows[0].total) === 0;
      
      return res.json({
        success: true,
        message: acordoQuitado 
          ? '🎉 Pagamento registrado! Acordo QUITADO!'
          : 'Pagamento registrado com sucesso!',
        acordoQuitado
      });
      
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[POST /api/parcelas/:id/pagar] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao registrar pagamento.' });
    } finally {
      client.release();
    }
  });

  // =====================================================
  // PUT /api/parcelas/:id/reagendar - Reagendar parcela
  // =====================================================
  router.put('/:id/reagendar', auth, async (req, res) => {
    try {
      const { id } = req.params;
      const { nova_data, motivo } = req.body || {};
      
      if (!nova_data) {
        return res.status(400).json({ success: false, message: 'Nova data é obrigatória.' });
      }
      
      const resultado = await pool.query(`
        UPDATE parcelas SET
          data_vencimento = $1,
          observacoes = CONCAT(COALESCE(observacoes, ''), ' | Reagendado: ', $2),
          updated_at = NOW()
        WHERE id = $3 AND status = 'pendente'
        RETURNING *
      `, [nova_data, motivo || 'Solicitação do devedor', id]);
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Parcela não encontrada ou já paga.' });
      }
      
      await registrarLog(req, 'REAGENDAR', 'parcelas', id, { nova_data, motivo });
      
      return res.json({ success: true, data: resultado.rows[0], message: 'Parcela reagendada!' });
      
    } catch (err) {
      console.error('[PUT /api/parcelas/:id/reagendar] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao reagendar parcela.' });
    }
  });

  // =====================================================
  // GET /api/parcelas/:id/whatsapp - Gerar link WhatsApp
  // =====================================================
  router.get('/:id/whatsapp', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const resultado = await pool.query(`
        SELECT 
          p.*,
          cl.nome as cliente_nome,
          cl.telefone as cliente_telefone,
          a.valor_acordo,
          a.numero_parcelas
        FROM parcelas p
        LEFT JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        WHERE p.id = $1
      `, [id]);
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Parcela não encontrada.' });
      }
      
      const p = resultado.rows[0];
      
      if (!p.cliente_telefone) {
        return res.status(400).json({ success: false, message: 'Cliente não possui telefone cadastrado.' });
      }
      
      let telefone = String(p.cliente_telefone).replace(/\D/g, '');
      if (telefone.length === 11 || telefone.length === 10) {
        telefone = '55' + telefone;
      }
      
      const valor = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(p.valor);
      const vencimento = new Date(p.data_vencimento).toLocaleDateString('pt-BR');
      
      const mensagem = `Olá, *${p.cliente_nome}*! 👋

📄 *LEMBRETE DE PARCELA*
━━━━━━━━━━━━━━━━━

📌 *Parcela:* ${p.numero}/${p.numero_parcelas}
💰 *Valor:* ${valor}
📅 *Vencimento:* ${vencimento}

⚠️ Evite juros! Efetue o pagamento até a data.

_Mensagem enviada pelo sistema ACERTIVE_`;

      const link = `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;
      
      return res.json({ success: true, link, telefone, mensagem });
      
    } catch (err) {
      console.error('[GET /api/parcelas/:id/whatsapp] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao gerar link.' });
    }
  });

  return router;
};
