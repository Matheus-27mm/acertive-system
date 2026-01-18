/**
 * ROTAS DE PARCELAS - ACERTIVE
 * Gerenciamento de parcelas de acordos com integração Asaas
 * 
 * ATUALIZADO: Inclui rota para gerar cobrança individual no Asaas
 */

const express = require('express');
const router = express.Router();

module.exports = (pool, auth, registrarLog, asaasRequest) => {

  // =====================================================
  // GET /api/parcelas - Listar parcelas com filtros
  // =====================================================
  router.get('/', auth, async (req, res) => {
    try {
      const { status, periodo, credor_id, acordo_id, cliente_id } = req.query;
      const empresaId = req.user.empresa_id;
      
      let query = `
        SELECT 
          p.*,
          a.valor_acordo,
          a.valor_original,
          a.status as acordo_status,
          a.cobranca_id,
          c.nome as cliente_nome,
          c.telefone as cliente_telefone,
          c.email as cliente_email,
          cr.nome as credor_nome,
          cr.id as credor_id,
          (SELECT COUNT(*) FROM parcelas WHERE acordo_id = p.acordo_id) as total_parcelas
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        JOIN clientes c ON c.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE a.empresa_id = $1
      `;
      
      const params = [empresaId];
      let paramCount = 1;
      
      // Filtro por status
      if (status && status !== 'todas') {
        paramCount++;
        query += ` AND p.status = $${paramCount}`;
        params.push(status);
      }
      
      // Filtro por período
      if (periodo) {
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        
        if (periodo === 'hoje') {
          paramCount++;
          query += ` AND DATE(p.data_vencimento) = $${paramCount}`;
          params.push(hoje.toISOString().split('T')[0]);
        } else if (periodo === 'semana') {
          const fimSemana = new Date(hoje);
          fimSemana.setDate(fimSemana.getDate() + 7);
          paramCount++;
          query += ` AND p.data_vencimento BETWEEN $${paramCount}`;
          params.push(hoje.toISOString().split('T')[0]);
          paramCount++;
          query += ` AND $${paramCount}`;
          params.push(fimSemana.toISOString().split('T')[0]);
        } else if (periodo === 'mes') {
          const fimMes = new Date(hoje);
          fimMes.setDate(fimMes.getDate() + 30);
          paramCount++;
          query += ` AND p.data_vencimento BETWEEN $${paramCount}`;
          params.push(hoje.toISOString().split('T')[0]);
          paramCount++;
          query += ` AND $${paramCount}`;
          params.push(fimMes.toISOString().split('T')[0]);
        }
      }
      
      // Filtro por credor
      if (credor_id) {
        paramCount++;
        query += ` AND a.credor_id = $${paramCount}`;
        params.push(credor_id);
      }
      
      // Filtro por acordo
      if (acordo_id) {
        paramCount++;
        query += ` AND p.acordo_id = $${paramCount}`;
        params.push(acordo_id);
      }
      
      // Filtro por cliente
      if (cliente_id) {
        paramCount++;
        query += ` AND a.cliente_id = $${paramCount}`;
        params.push(cliente_id);
      }
      
      query += ' ORDER BY p.data_vencimento ASC';
      
      const result = await pool.query(query, params);
      res.json(result.rows);
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao listar:', err);
      res.status(500).json({ error: 'Erro ao buscar parcelas' });
    }
  });

  // =====================================================
  // GET /api/parcelas/stats - Estatísticas de parcelas
  // =====================================================
  router.get('/stats', auth, async (req, res) => {
    try {
      const empresaId = req.user.empresa_id;
      const hoje = new Date().toISOString().split('T')[0];
      
      // Início do mês atual
      const inicioMes = new Date();
      inicioMes.setDate(1);
      const inicioMesStr = inicioMes.toISOString().split('T')[0];
      
      const stats = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE DATE(p.data_vencimento) = $2 AND p.status = 'pendente') as vence_hoje,
          COALESCE(SUM(p.valor) FILTER (WHERE DATE(p.data_vencimento) = $2 AND p.status = 'pendente'), 0) as valor_hoje,
          COUNT(*) FILTER (WHERE p.data_vencimento > $2 AND p.status = 'pendente') as futuras,
          COALESCE(SUM(p.valor) FILTER (WHERE p.data_vencimento > $2 AND p.status = 'pendente'), 0) as valor_futuras,
          COUNT(*) FILTER (WHERE p.data_vencimento < $2 AND p.status = 'pendente') as vencidas,
          COALESCE(SUM(p.valor) FILTER (WHERE p.data_vencimento < $2 AND p.status = 'pendente'), 0) as valor_vencidas,
          COUNT(*) FILTER (WHERE p.status = 'pago') as pagas_total,
          COALESCE(SUM(p.valor_pago) FILTER (WHERE p.status = 'pago'), 0) as valor_pago_total,
          COUNT(*) FILTER (WHERE p.status = 'pago' AND p.data_pagamento >= $3) as pagas_mes,
          COALESCE(SUM(p.valor_pago) FILTER (WHERE p.status = 'pago' AND p.data_pagamento >= $3), 0) as valor_pago_mes
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        WHERE a.empresa_id = $1
      `, [empresaId, hoje, inicioMesStr]);
      
      res.json(stats.rows[0]);
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao buscar stats:', err);
      res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
  });

  // =====================================================
  // GET /api/parcelas/futuras - Parcelas futuras
  // =====================================================
  router.get('/futuras', auth, async (req, res) => {
    try {
      const empresaId = req.user.empresa_id;
      const hoje = new Date().toISOString().split('T')[0];
      
      const result = await pool.query(`
        SELECT 
          p.*,
          c.nome as cliente_nome,
          c.telefone as cliente_telefone,
          cr.nome as credor_nome,
          a.status as acordo_status,
          (SELECT COUNT(*) FROM parcelas WHERE acordo_id = p.acordo_id) as total_parcelas
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        JOIN clientes c ON c.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE a.empresa_id = $1
          AND p.data_vencimento > $2
          AND p.status = 'pendente'
          AND a.status = 'ativo'
        ORDER BY p.data_vencimento ASC
      `, [empresaId, hoje]);
      
      res.json(result.rows);
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao buscar futuras:', err);
      res.status(500).json({ error: 'Erro ao buscar parcelas futuras' });
    }
  });

  // =====================================================
  // GET /api/parcelas/vencidas - Parcelas vencidas
  // =====================================================
  router.get('/vencidas', auth, async (req, res) => {
    try {
      const empresaId = req.user.empresa_id;
      const hoje = new Date().toISOString().split('T')[0];
      
      const result = await pool.query(`
        SELECT 
          p.*,
          c.nome as cliente_nome,
          c.telefone as cliente_telefone,
          cr.nome as credor_nome,
          a.status as acordo_status,
          (SELECT COUNT(*) FROM parcelas WHERE acordo_id = p.acordo_id) as total_parcelas,
          ($2::date - p.data_vencimento::date) as dias_atraso
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        JOIN clientes c ON c.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE a.empresa_id = $1
          AND p.data_vencimento < $2
          AND p.status = 'pendente'
        ORDER BY p.data_vencimento ASC
      `, [empresaId, hoje]);
      
      res.json(result.rows);
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao buscar vencidas:', err);
      res.status(500).json({ error: 'Erro ao buscar parcelas vencidas' });
    }
  });

  // =====================================================
  // GET /api/parcelas/hoje - Parcelas que vencem hoje
  // =====================================================
  router.get('/hoje', auth, async (req, res) => {
    try {
      const empresaId = req.user.empresa_id;
      const hoje = new Date().toISOString().split('T')[0];
      
      const result = await pool.query(`
        SELECT 
          p.*,
          c.nome as cliente_nome,
          c.telefone as cliente_telefone,
          cr.nome as credor_nome,
          a.status as acordo_status,
          (SELECT COUNT(*) FROM parcelas WHERE acordo_id = p.acordo_id) as total_parcelas
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        JOIN clientes c ON c.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE a.empresa_id = $1
          AND DATE(p.data_vencimento) = $2
          AND p.status = 'pendente'
        ORDER BY p.data_vencimento ASC
      `, [empresaId, hoje]);
      
      res.json(result.rows);
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao buscar hoje:', err);
      res.status(500).json({ error: 'Erro ao buscar parcelas de hoje' });
    }
  });

  // =====================================================
  // GET /api/parcelas/por-acordo/:acordoId - Parcelas de um acordo
  // =====================================================
  router.get('/por-acordo/:acordoId', auth, async (req, res) => {
    try {
      const { acordoId } = req.params;
      
      const result = await pool.query(`
        SELECT 
          p.*,
          c.nome as cliente_nome,
          cr.nome as credor_nome
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        JOIN clientes c ON c.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE p.acordo_id = $1
        ORDER BY p.numero_parcela ASC
      `, [acordoId]);
      
      res.json(result.rows);
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao buscar por acordo:', err);
      res.status(500).json({ error: 'Erro ao buscar parcelas do acordo' });
    }
  });

  // =====================================================
  // GET /api/parcelas/:id - Buscar parcela por ID
  // =====================================================
  router.get('/:id', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const result = await pool.query(`
        SELECT 
          p.*,
          a.valor_acordo,
          a.valor_original,
          a.status as acordo_status,
          a.cobranca_id,
          c.nome as cliente_nome,
          c.telefone as cliente_telefone,
          c.email as cliente_email,
          cr.nome as credor_nome,
          (SELECT COUNT(*) FROM parcelas WHERE acordo_id = p.acordo_id) as total_parcelas
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        JOIN clientes c ON c.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE p.id = $1
      `, [id]);
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Parcela não encontrada' });
      }
      
      res.json(result.rows[0]);
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao buscar:', err);
      res.status(500).json({ error: 'Erro ao buscar parcela' });
    }
  });

  // =====================================================
  // POST /api/parcelas/:id/pagar - Registrar pagamento
  // =====================================================
  router.post('/:id/pagar', auth, async (req, res) => {
    try {
      const { id } = req.params;
      const { valor_pago, data_pagamento, forma_pagamento, observacao } = req.body;
      
      // Buscar parcela
      const parcelaResult = await pool.query(`
        SELECT p.*, a.id as acordo_id, a.cobranca_id, a.credor_id, a.cliente_id
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        WHERE p.id = $1
      `, [id]);
      
      if (parcelaResult.rowCount === 0) {
        return res.status(404).json({ error: 'Parcela não encontrada' });
      }
      
      const parcela = parcelaResult.rows[0];
      
      // Atualizar parcela
      await pool.query(`
        UPDATE parcelas SET 
          status = 'pago',
          valor_pago = $1,
          data_pagamento = $2,
          forma_pagamento = $3,
          observacao = COALESCE($4, observacao),
          updated_at = NOW()
        WHERE id = $5
      `, [
        valor_pago || parcela.valor,
        data_pagamento || new Date().toISOString().split('T')[0],
        forma_pagamento || 'manual',
        observacao,
        id
      ]);
      
      // Verificar se todas as parcelas foram pagas
      const parcelasPendentes = await pool.query(`
        SELECT COUNT(*)::int as total 
        FROM parcelas 
        WHERE acordo_id = $1 AND status != 'pago'
      `, [parcela.acordo_id]);
      
      const acordoQuitado = parseInt(parcelasPendentes.rows[0].total) === 0;
      
      if (acordoQuitado) {
        // Atualizar acordo para quitado
        await pool.query(`
          UPDATE acordos SET status = 'quitado', updated_at = NOW() WHERE id = $1
        `, [parcela.acordo_id]);
        
        // Atualizar cobrança original para pago
        if (parcela.cobranca_id) {
          await pool.query(`
            UPDATE cobrancas SET 
              status = 'pago', 
              data_pagamento = $1,
              updated_at = NOW() 
            WHERE id = $2
          `, [data_pagamento || new Date().toISOString().split('T')[0], parcela.cobranca_id]);
        }
      }
      
      // Registrar comissão (se tiver credor)
      if (parcela.credor_id) {
        try {
          const credorResult = await pool.query(
            'SELECT comissao_percentual FROM credores WHERE id = $1',
            [parcela.credor_id]
          );
          
          if (credorResult.rowCount > 0) {
            const comissaoPerc = parseFloat(credorResult.rows[0].comissao_percentual) || 10;
            const valorBase = parseFloat(valor_pago || parcela.valor);
            const valorComissao = (valorBase * comissaoPerc) / 100;
            
            await pool.query(`
              INSERT INTO comissoes (
                credor_id, parcela_id, acordo_id, cliente_id,
                valor_base, percentual, valor_comissao,
                status, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente', NOW())
            `, [
              parcela.credor_id,
              id,
              parcela.acordo_id,
              parcela.cliente_id,
              valorBase,
              comissaoPerc,
              valorComissao
            ]);
          }
        } catch (comErr) {
          console.warn('[PARCELAS] Aviso ao registrar comissão:', comErr.message);
        }
      }
      
      // Registrar log
      if (registrarLog) {
        await registrarLog(
          req.user.id,
          req.user.empresa_id,
          'parcela_paga',
          'parcelas',
          id,
          { valor_pago, forma_pagamento, acordo_quitado: acordoQuitado }
        );
      }
      
      res.json({
        success: true,
        message: acordoQuitado ? 'Parcela paga! Acordo quitado!' : 'Pagamento registrado',
        acordoQuitado
      });
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao pagar:', err);
      res.status(500).json({ error: 'Erro ao registrar pagamento' });
    }
  });

  // =====================================================
  // POST /api/parcelas/pagar-massa - Pagar múltiplas parcelas
  // =====================================================
  router.post('/pagar-massa', auth, async (req, res) => {
    try {
      const { ids, data_pagamento, forma_pagamento } = req.body;
      
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'IDs das parcelas são obrigatórios' });
      }
      
      const dataPag = data_pagamento || new Date().toISOString().split('T')[0];
      const forma = forma_pagamento || 'manual';
      
      // Atualizar todas as parcelas
      await pool.query(`
        UPDATE parcelas SET 
          status = 'pago',
          valor_pago = valor,
          data_pagamento = $1,
          forma_pagamento = $2,
          updated_at = NOW()
        WHERE id = ANY($3)
      `, [dataPag, forma, ids]);
      
      // Verificar acordos que podem ter sido quitados
      const acordosAfetados = await pool.query(`
        SELECT DISTINCT acordo_id FROM parcelas WHERE id = ANY($1)
      `, [ids]);
      
      let acordosQuitados = 0;
      
      for (const row of acordosAfetados.rows) {
        const pendentes = await pool.query(`
          SELECT COUNT(*)::int as total 
          FROM parcelas 
          WHERE acordo_id = $1 AND status != 'pago'
        `, [row.acordo_id]);
        
        if (parseInt(pendentes.rows[0].total) === 0) {
          await pool.query(`
            UPDATE acordos SET status = 'quitado', updated_at = NOW() WHERE id = $1
          `, [row.acordo_id]);
          
          // Atualizar cobrança original
          const acordo = await pool.query('SELECT cobranca_id FROM acordos WHERE id = $1', [row.acordo_id]);
          if (acordo.rows[0]?.cobranca_id) {
            await pool.query(`
              UPDATE cobrancas SET status = 'pago', data_pagamento = $1, updated_at = NOW() WHERE id = $2
            `, [dataPag, acordo.rows[0].cobranca_id]);
          }
          
          acordosQuitados++;
        }
      }
      
      res.json({
        success: true,
        message: `${ids.length} parcela(s) paga(s)`,
        acordosQuitados
      });
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao pagar em massa:', err);
      res.status(500).json({ error: 'Erro ao registrar pagamentos' });
    }
  });

  // =====================================================
  // POST /api/parcelas/:id/gerar-asaas - Gerar cobrança no Asaas
  // =====================================================
  router.post('/:id/gerar-asaas', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Verificar se asaasRequest está disponível
      if (!asaasRequest) {
        return res.status(500).json({ error: 'Integração Asaas não configurada' });
      }
      
      // Buscar parcela com dados do acordo e cliente
      const parcelaResult = await pool.query(`
        SELECT 
          p.*,
          a.id as acordo_id,
          a.cliente_id,
          c.nome as cliente_nome,
          c.cpf_cnpj as cliente_documento,
          c.email as cliente_email,
          c.telefone as cliente_telefone,
          c.asaas_customer_id
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        JOIN clientes c ON c.id = a.cliente_id
        WHERE p.id = $1
      `, [id]);
      
      if (parcelaResult.rowCount === 0) {
        return res.status(404).json({ error: 'Parcela não encontrada' });
      }
      
      const parcela = parcelaResult.rows[0];
      
      // Verificar se já tem cobrança no Asaas
      if (parcela.asaas_id) {
        return res.status(400).json({ 
          error: 'Parcela já tem cobrança no Asaas',
          asaasId: parcela.asaas_id,
          invoiceUrl: parcela.asaas_invoice_url
        });
      }
      
      // Verificar se cliente tem ID no Asaas
      let customerId = parcela.asaas_customer_id;
      
      if (!customerId) {
        // Criar/sincronizar cliente no Asaas
        console.log(`[PARCELA-ASAAS] Sincronizando cliente ${parcela.cliente_nome}...`);
        
        const customerPayload = {
          name: parcela.cliente_nome,
          cpfCnpj: (parcela.cliente_documento || '').replace(/\D/g, ''),
          email: parcela.cliente_email || undefined,
          phone: parcela.cliente_telefone || undefined,
          externalReference: parcela.cliente_id
        };
        
        try {
          const customerRes = await asaasRequest('POST', '/customers', customerPayload);
          customerId = customerRes.id;
          
          // Salvar no banco
          await pool.query(
            'UPDATE clientes SET asaas_customer_id = $1 WHERE id = $2',
            [customerId, parcela.cliente_id]
          );
        } catch (custErr) {
          console.error('[PARCELA-ASAAS] Erro ao criar cliente:', custErr);
          return res.status(500).json({ error: 'Erro ao sincronizar cliente no Asaas: ' + custErr.message });
        }
      }
      
      // Criar cobrança no Asaas
      const vencimento = new Date(parcela.data_vencimento);
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      
      // Se vencimento já passou, usar data de hoje + 3 dias
      let dueDate = vencimento.toISOString().split('T')[0];
      if (vencimento < hoje) {
        const novaData = new Date();
        novaData.setDate(novaData.getDate() + 3);
        dueDate = novaData.toISOString().split('T')[0];
      }
      
      const cobrancaPayload = {
        customer: customerId,
        billingType: 'UNDEFINED', // Cliente escolhe PIX ou Boleto
        value: parseFloat(parcela.valor),
        dueDate: dueDate,
        description: `Parcela ${parcela.numero_parcela} - Acordo #${(parcela.acordo_id || '').substring(0, 8)}`,
        externalReference: `PARCELA:${parcela.id}`
      };
      
      console.log(`[PARCELA-ASAAS] Criando cobrança:`, cobrancaPayload);
      
      const asaasRes = await asaasRequest('POST', '/payments', cobrancaPayload);
      
      // Atualizar parcela com dados do Asaas
      await pool.query(`
        UPDATE parcelas SET 
          asaas_id = $1,
          asaas_invoice_url = $2,
          updated_at = NOW()
        WHERE id = $3
      `, [asaasRes.id, asaasRes.invoiceUrl, id]);
      
      console.log(`[PARCELA-ASAAS] ✅ Cobrança criada: ${asaasRes.id}`);
      
      // Registrar log
      if (registrarLog) {
        await registrarLog(
          req.user.id,
          req.user.empresa_id,
          'parcela_asaas_gerada',
          'parcelas',
          id,
          { asaas_id: asaasRes.id }
        );
      }
      
      res.json({
        success: true,
        message: 'Cobrança criada no Asaas',
        asaasId: asaasRes.id,
        invoiceUrl: asaasRes.invoiceUrl,
        bankSlipUrl: asaasRes.bankSlipUrl,
        pixQrCode: asaasRes.pixQrCodeUrl
      });
      
    } catch (err) {
      console.error('[PARCELA-ASAAS] Erro:', err);
      res.status(500).json({ error: err.message || 'Erro ao gerar cobrança' });
    }
  });

  // =====================================================
  // PUT /api/parcelas/:id/reagendar - Reagendar parcela
  // =====================================================
  router.put('/:id/reagendar', auth, async (req, res) => {
    try {
      const { id } = req.params;
      const { nova_data, motivo } = req.body;
      
      if (!nova_data) {
        return res.status(400).json({ error: 'Nova data é obrigatória' });
      }
      
      // Buscar parcela atual
      const parcelaResult = await pool.query('SELECT * FROM parcelas WHERE id = $1', [id]);
      
      if (parcelaResult.rowCount === 0) {
        return res.status(404).json({ error: 'Parcela não encontrada' });
      }
      
      const parcela = parcelaResult.rows[0];
      const dataAnterior = parcela.data_vencimento;
      
      // Atualizar parcela
      await pool.query(`
        UPDATE parcelas SET 
          data_vencimento = $1,
          observacao = COALESCE(observacao, '') || $2,
          updated_at = NOW()
        WHERE id = $3
      `, [
        nova_data,
        `\n[Reagendada de ${new Date(dataAnterior).toLocaleDateString('pt-BR')} para ${new Date(nova_data).toLocaleDateString('pt-BR')}${motivo ? ': ' + motivo : ''}]`,
        id
      ]);
      
      // Se tiver cobrança no Asaas, atualizar lá também
      if (parcela.asaas_id && asaasRequest) {
        try {
          await asaasRequest('POST', `/payments/${parcela.asaas_id}`, {
            dueDate: nova_data
          });
          console.log(`[PARCELA] Atualizada no Asaas: ${parcela.asaas_id}`);
        } catch (asaasErr) {
          console.warn('[PARCELA] Não foi possível atualizar no Asaas:', asaasErr.message);
        }
      }
      
      // Registrar log
      if (registrarLog) {
        await registrarLog(
          req.user.id,
          req.user.empresa_id,
          'parcela_reagendada',
          'parcelas',
          id,
          { data_anterior: dataAnterior, nova_data, motivo }
        );
      }
      
      res.json({ 
        success: true, 
        message: 'Parcela reagendada',
        data_anterior: dataAnterior,
        nova_data
      });
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao reagendar:', err);
      res.status(500).json({ error: 'Erro ao reagendar parcela' });
    }
  });

  // =====================================================
  // PUT /api/parcelas/:id/cancelar - Cancelar parcela
  // =====================================================
  router.put('/:id/cancelar', auth, async (req, res) => {
    try {
      const { id } = req.params;
      const { motivo } = req.body;
      
      // Buscar parcela
      const parcelaResult = await pool.query('SELECT * FROM parcelas WHERE id = $1', [id]);
      
      if (parcelaResult.rowCount === 0) {
        return res.status(404).json({ error: 'Parcela não encontrada' });
      }
      
      const parcela = parcelaResult.rows[0];
      
      // Atualizar parcela
      await pool.query(`
        UPDATE parcelas SET 
          status = 'cancelado',
          observacao = COALESCE(observacao, '') || $1,
          updated_at = NOW()
        WHERE id = $2
      `, [
        `\n[Cancelada${motivo ? ': ' + motivo : ''}]`,
        id
      ]);
      
      // Se tiver cobrança no Asaas, cancelar lá também
      if (parcela.asaas_id && asaasRequest) {
        try {
          await asaasRequest('DELETE', `/payments/${parcela.asaas_id}`);
          console.log(`[PARCELA] Cancelada no Asaas: ${parcela.asaas_id}`);
        } catch (asaasErr) {
          console.warn('[PARCELA] Não foi possível cancelar no Asaas:', asaasErr.message);
        }
      }
      
      // Registrar log
      if (registrarLog) {
        await registrarLog(
          req.user.id,
          req.user.empresa_id,
          'parcela_cancelada',
          'parcelas',
          id,
          { motivo }
        );
      }
      
      res.json({ success: true, message: 'Parcela cancelada' });
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao cancelar:', err);
      res.status(500).json({ error: 'Erro ao cancelar parcela' });
    }
  });

  // =====================================================
  // GET /api/parcelas/:id/whatsapp - Gerar link WhatsApp
  // =====================================================
  router.get('/:id/whatsapp', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const result = await pool.query(`
        SELECT 
          p.*,
          c.nome as cliente_nome,
          c.telefone as cliente_telefone,
          a.id as acordo_id
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        JOIN clientes c ON c.id = a.cliente_id
        WHERE p.id = $1
      `, [id]);
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Parcela não encontrada' });
      }
      
      const parcela = result.rows[0];
      const telefone = (parcela.cliente_telefone || '').replace(/\D/g, '');
      
      if (!telefone) {
        return res.status(400).json({ error: 'Cliente sem telefone cadastrado' });
      }
      
      const valor = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(parcela.valor);
      const vencimento = new Date(parcela.data_vencimento).toLocaleDateString('pt-BR');
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const venc = new Date(parcela.data_vencimento);
      venc.setHours(0, 0, 0, 0);
      const vencida = venc < hoje;
      
      let mensagem;
      if (vencida) {
        mensagem = `Olá ${parcela.cliente_nome}! 👋\n\nIdentificamos que a parcela ${parcela.numero_parcela} no valor de ${valor} com vencimento em ${vencimento} está em aberto.\n\n`;
        if (parcela.asaas_invoice_url) {
          mensagem += `Para regularizar, acesse o link abaixo:\n${parcela.asaas_invoice_url}\n\n`;
        }
        mensagem += `Qualquer dúvida, estamos à disposição! 🙏`;
      } else {
        mensagem = `Olá ${parcela.cliente_nome}! 👋\n\nSegue o lembrete da parcela ${parcela.numero_parcela}:\n\n💰 Valor: ${valor}\n📅 Vencimento: ${vencimento}\n\n`;
        if (parcela.asaas_invoice_url) {
          mensagem += `🔗 Link para pagamento:\n${parcela.asaas_invoice_url}\n\n`;
        }
        mensagem += `Qualquer dúvida, estamos à disposição! 🙏`;
      }
      
      const url = `https://wa.me/55${telefone}?text=${encodeURIComponent(mensagem)}`;
      
      res.json({ 
        url, 
        telefone, 
        mensagem,
        vencida
      });
      
    } catch (err) {
      console.error('[PARCELAS] Erro ao gerar WhatsApp:', err);
      res.status(500).json({ error: 'Erro ao gerar link WhatsApp' });
    }
  });

  return router;
};