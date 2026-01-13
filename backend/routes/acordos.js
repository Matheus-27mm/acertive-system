/**
 * ROTAS DE ACORDOS - ACERTIVE
 * Negociações fechadas com devedores (parcelamento/desconto)
 */

const express = require('express');
const router = express.Router();

module.exports = (pool, auth, registrarLog) => {

  // =====================================================
  // GET /api/acordos - Listar acordos
  // =====================================================
  router.get('/', auth, async (req, res) => {
    try {
      const { status, credor_id, cliente_id, page = 1, limit = 50 } = req.query;
      
      let sql = `
        SELECT 
          a.*,
          c.descricao as cobranca_descricao,
          c.valor_original as divida_original,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          cl.telefone as cliente_telefone,
          cr.nome as credor_nome,
          (SELECT COUNT(*)::int FROM parcelas WHERE acordo_id = a.id) as total_parcelas,
          (SELECT COUNT(*)::int FROM parcelas WHERE acordo_id = a.id AND status = 'pago') as parcelas_pagas,
          (SELECT MIN(data_vencimento) FROM parcelas WHERE acordo_id = a.id AND status = 'pendente') as proxima_parcela
        FROM acordos a
        LEFT JOIN cobrancas c ON c.id = a.cobranca_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE 1=1
      `;
      
      const params = [];
      let idx = 1;
      
      if (status) {
        sql += ` AND a.status = $${idx}`;
        params.push(status);
        idx++;
      }
      
      if (credor_id) {
        sql += ` AND a.credor_id = $${idx}`;
        params.push(credor_id);
        idx++;
      }
      
      if (cliente_id) {
        sql += ` AND a.cliente_id = $${idx}`;
        params.push(cliente_id);
        idx++;
      }
      
      sql += ` ORDER BY a.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
      params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
      
      const resultado = await pool.query(sql, params);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/acordos] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao listar acordos.' });
    }
  });

  // =====================================================
  // GET /api/acordos/stats - Estatísticas de acordos
  // =====================================================
  router.get('/stats', auth, async (req, res) => {
    try {
      const stats = await pool.query(`
        SELECT 
          COUNT(*)::int as total_acordos,
          COUNT(CASE WHEN status = 'ativo' THEN 1 END)::int as acordos_ativos,
          COUNT(CASE WHEN status = 'quitado' THEN 1 END)::int as acordos_quitados,
          COUNT(CASE WHEN status = 'quebrado' THEN 1 END)::int as acordos_quebrados,
          COALESCE(SUM(valor_acordo), 0)::numeric as valor_total_acordos,
          COALESCE(SUM(CASE WHEN status = 'ativo' THEN valor_acordo ELSE 0 END), 0)::numeric as valor_acordos_ativos,
          COALESCE(AVG(desconto_percentual), 0)::numeric as desconto_medio
        FROM acordos
      `);
      
      const row = stats.rows[0];
      const taxaQuitacao = row.total_acordos > 0
        ? ((row.acordos_quitados / row.total_acordos) * 100).toFixed(1)
        : 0;
      
      return res.json({
        success: true,
        data: {
          totalAcordos: row.total_acordos,
          acordosAtivos: row.acordos_ativos,
          acordosQuitados: row.acordos_quitados,
          acordosQuebrados: row.acordos_quebrados,
          valorTotalAcordos: parseFloat(row.valor_total_acordos),
          valorAcordosAtivos: parseFloat(row.valor_acordos_ativos),
          descontoMedio: parseFloat(row.desconto_medio).toFixed(1),
          taxaQuitacao: parseFloat(taxaQuitacao)
        }
      });
      
    } catch (err) {
      console.error('[GET /api/acordos/stats] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar estatísticas.' });
    }
  });

  // =====================================================
  // GET /api/acordos/:id - Buscar acordo por ID
  // =====================================================
  router.get('/:id', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const acordo = await pool.query(`
        SELECT 
          a.*,
          c.descricao as cobranca_descricao,
          c.valor_original as divida_original,
          c.vencimento as divida_vencimento,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          cl.telefone as cliente_telefone,
          cl.email as cliente_email,
          cr.nome as credor_nome,
          cr.comissao_percentual as credor_comissao
        FROM acordos a
        LEFT JOIN cobrancas c ON c.id = a.cobranca_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE a.id = $1
      `, [id]);
      
      if (!acordo.rowCount) {
        return res.status(404).json({ success: false, message: 'Acordo não encontrado.' });
      }
      
      // Buscar parcelas
      const parcelas = await pool.query(`
        SELECT * FROM parcelas 
        WHERE acordo_id = $1 
        ORDER BY numero ASC
      `, [id]);
      
      return res.json({
        success: true,
        data: {
          ...acordo.rows[0],
          parcelas: parcelas.rows
        }
      });
      
    } catch (err) {
      console.error('[GET /api/acordos/:id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar acordo.' });
    }
  });

  // =====================================================
  // POST /api/acordos - Criar novo acordo
  // =====================================================
  router.post('/', auth, async (req, res) => {
    const client = await pool.connect();
    
    try {
      const b = req.body || {};
      
      // Validações
      if (!b.cobranca_id && !b.cliente_id) {
        return res.status(400).json({ success: false, message: 'Cobrança ou cliente é obrigatório.' });
      }
      
      if (!b.valor_acordo || parseFloat(b.valor_acordo) <= 0) {
        return res.status(400).json({ success: false, message: 'Valor do acordo é obrigatório.' });
      }
      
      if (!b.numero_parcelas || parseInt(b.numero_parcelas) < 1) {
        return res.status(400).json({ success: false, message: 'Número de parcelas é obrigatório.' });
      }
      
      await client.query('BEGIN');
      
      // Se tem cobrança, buscar dados dela
      let cobrancaInfo = null;
      let clienteId = b.cliente_id;
      let credorId = b.credor_id;
      let valorOriginal = b.valor_original || b.valor_acordo;
      
      if (b.cobranca_id) {
        const cobranca = await client.query(
          'SELECT cliente_id, credor_id, valor_atualizado FROM cobrancas WHERE id = $1',
          [b.cobranca_id]
        );
        if (cobranca.rowCount > 0) {
          cobrancaInfo = cobranca.rows[0];
          clienteId = clienteId || cobrancaInfo.cliente_id;
          credorId = credorId || cobrancaInfo.credor_id;
          valorOriginal = cobrancaInfo.valor_atualizado;
        }
      }
      
      const valorAcordo = parseFloat(b.valor_acordo);
      const valorEntrada = parseFloat(b.valor_entrada) || 0;
      const numeroParcelas = parseInt(b.numero_parcelas);
      const descontoValor = valorOriginal - valorAcordo;
      const descontoPercentual = valorOriginal > 0 ? ((descontoValor / valorOriginal) * 100) : 0;
      const valorParcela = numeroParcelas > 0 ? ((valorAcordo - valorEntrada) / numeroParcelas) : 0;
      
      // Criar acordo
      const novoAcordo = await client.query(`
        INSERT INTO acordos (
          cobranca_id, cliente_id, credor_id,
          valor_original, desconto_percentual, desconto_valor, valor_acordo,
          valor_entrada, numero_parcelas, valor_parcela,
          data_primeiro_vencimento, forma_pagamento,
          observacoes, status, criado_por, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW()
        ) RETURNING *
      `, [
        b.cobranca_id || null,
        clienteId,
        credorId || null,
        valorOriginal,
        descontoPercentual,
        descontoValor,
        valorAcordo,
        valorEntrada,
        numeroParcelas,
        valorParcela,
        b.data_primeiro_vencimento || new Date().toISOString().split('T')[0],
        b.forma_pagamento || 'boleto',
        b.observacoes || null,
        b.status || 'ativo',
        req.user.userId
      ]);
      
      const acordoId = novoAcordo.rows[0].id;
      
      // Criar parcelas
      let dataVencimento = new Date(b.data_primeiro_vencimento || new Date());
      
      for (let i = 1; i <= numeroParcelas; i++) {
        await client.query(`
          INSERT INTO parcelas (
            acordo_id, numero, valor, data_vencimento, status, created_at
          ) VALUES ($1, $2, $3, $4, 'pendente', NOW())
        `, [acordoId, i, valorParcela, dataVencimento.toISOString().split('T')[0]]);
        
        // Próximo mês
        dataVencimento.setMonth(dataVencimento.getMonth() + 1);
      }
      
      // Atualizar status da cobrança original
      if (b.cobranca_id) {
        await client.query(
          'UPDATE cobrancas SET status = $1, updated_at = NOW() WHERE id = $2',
          ['negociando', b.cobranca_id]
        );
      }
      
      await client.query('COMMIT');
      
      await registrarLog(req, 'CRIAR', 'acordos', acordoId, {
        cliente_id: clienteId,
        valor_acordo: valorAcordo,
        parcelas: numeroParcelas
      });
      
      return res.status(201).json({
        success: true,
        data: novoAcordo.rows[0],
        message: `Acordo criado com ${numeroParcelas} parcela(s)!`
      });
      
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[POST /api/acordos] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao criar acordo.' });
    } finally {
      client.release();
    }
  });

  // =====================================================
  // PUT /api/acordos/:id - Atualizar acordo
  // =====================================================
  router.put('/:id', auth, async (req, res) => {
    try {
      const { id } = req.params;
      const b = req.body || {};
      
      const resultado = await pool.query(`
        UPDATE acordos SET
          observacoes = COALESCE($1, observacoes),
          status = COALESCE($2, status),
          updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [b.observacoes, b.status, id]);
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Acordo não encontrado.' });
      }
      
      await registrarLog(req, 'ATUALIZAR', 'acordos', id, b);
      
      return res.json({ success: true, data: resultado.rows[0] });
      
    } catch (err) {
      console.error('[PUT /api/acordos/:id] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao atualizar acordo.' });
    }
  });

  // =====================================================
  // PUT /api/acordos/:id/quebrar - Quebrar acordo
  // =====================================================
  router.put('/:id/quebrar', auth, async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      const { motivo } = req.body || {};
      
      await client.query('BEGIN');
      
      // Atualizar acordo
      const acordo = await client.query(`
        UPDATE acordos SET status = 'quebrado', observacoes = CONCAT(observacoes, ' | QUEBRADO: ', $1), updated_at = NOW()
        WHERE id = $2 RETURNING cobranca_id
      `, [motivo || 'Não informado', id]);
      
      if (!acordo.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Acordo não encontrado.' });
      }
      
      // Voltar cobrança para vencido
      if (acordo.rows[0].cobranca_id) {
        await client.query(
          'UPDATE cobrancas SET status = $1, updated_at = NOW() WHERE id = $2',
          ['vencido', acordo.rows[0].cobranca_id]
        );
      }
      
      // Cancelar parcelas pendentes
      await client.query(
        'UPDATE parcelas SET status = $1, updated_at = NOW() WHERE acordo_id = $2 AND status = $3',
        ['cancelado', id, 'pendente']
      );
      
      await client.query('COMMIT');
      
      await registrarLog(req, 'QUEBRAR', 'acordos', id, { motivo });
      
      return res.json({ success: true, message: 'Acordo quebrado. Cobrança voltou para status vencido.' });
      
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[PUT /api/acordos/:id/quebrar] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao quebrar acordo.' });
    } finally {
      client.release();
    }
  });

  // =====================================================
  // POST /api/acordos/simular - Simular acordo
  // =====================================================
  router.post('/simular', auth, async (req, res) => {
    try {
      const { valor_divida, desconto_percentual, numero_parcelas, valor_entrada } = req.body || {};
      
      const valorDivida = parseFloat(valor_divida) || 0;
      const desconto = parseFloat(desconto_percentual) || 0;
      const parcelas = parseInt(numero_parcelas) || 1;
      const entrada = parseFloat(valor_entrada) || 0;
      
      if (valorDivida <= 0) {
        return res.status(400).json({ success: false, message: 'Valor da dívida é obrigatório.' });
      }
      
      const descontoValor = (valorDivida * desconto) / 100;
      const valorAcordo = valorDivida - descontoValor;
      const valorAPagar = valorAcordo - entrada;
      const valorParcela = parcelas > 0 ? (valorAPagar / parcelas) : 0;
      
      // Gerar prévia das parcelas
      const previewParcelas = [];
      let dataVencimento = new Date();
      dataVencimento.setMonth(dataVencimento.getMonth() + 1);
      
      for (let i = 1; i <= parcelas; i++) {
        previewParcelas.push({
          numero: i,
          valor: Math.round(valorParcela * 100) / 100,
          vencimento: dataVencimento.toISOString().split('T')[0]
        });
        dataVencimento.setMonth(dataVencimento.getMonth() + 1);
      }
      
      return res.json({
        success: true,
        simulacao: {
          valorDivida,
          descontoPercentual: desconto,
          descontoValor: Math.round(descontoValor * 100) / 100,
          valorAcordo: Math.round(valorAcordo * 100) / 100,
          valorEntrada: entrada,
          valorAPagar: Math.round(valorAPagar * 100) / 100,
          numeroParcelas: parcelas,
          valorParcela: Math.round(valorParcela * 100) / 100,
          parcelas: previewParcelas
        }
      });
      
    } catch (err) {
      console.error('[POST /api/acordos/simular] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao simular acordo.' });
    }
  });

  return router;
};
