/**
 * ROTAS DE PARCELAS - ACERTIVE v2.2
 * Controle de pagamentos dos acordos
 * 
 * ATUALIZADO: Adicionada rota para gerar cobrança no Asaas
 */

const express = require('express');
const router = express.Router();

module.exports = (pool, auth, registrarLog, asaasRequest) => {

  // =====================================================
  // GET /api/parcelas - Listar parcelas (com filtros avançados)
  // =====================================================
  router.get('/', auth, async (req, res) => {
    try {
      const { status, periodo, credor_id, acordo_id, cliente_id, page = 1, limit = 50 } = req.query;
      
      let sql = `
        SELECT 
          p.*,
          a.id as acordo_id,
          a.valor_acordo,
          a.numero_parcelas as total_parcelas,
          a.status as acordo_status,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          cl.telefone as cliente_telefone,
          cl.email as cliente_email,
          cr.nome as credor_nome,
          cr.id as credor_id
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE a.status IN ('ativo', 'quitado')
      `;
      
      const params = [];
      let idx = 1;
      
      // Filtro por status da parcela
      if (status) {
        sql += ` AND p.status = $${idx}`;
        params.push(status);
        idx++;
      }
      
      // Filtro por credor
      if (credor_id) {
        sql += ` AND a.credor_id = $${idx}`;
        params.push(credor_id);
        idx++;
      }
      
      // Filtro por acordo específico
      if (acordo_id) {
        sql += ` AND p.acordo_id = $${idx}`;
        params.push(acordo_id);
        idx++;
      }
      
      // Filtro por cliente
      if (cliente_id) {
        sql += ` AND a.cliente_id = $${idx}`;
        params.push(cliente_id);
        idx++;
      }
      
      // Filtros de período
      if (periodo === 'hoje') {
        sql += ` AND DATE(p.data_vencimento) = CURRENT_DATE AND p.status = 'pendente'`;
      } else if (periodo === 'semana') {
        sql += ` AND p.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND p.status = 'pendente'`;
      } else if (periodo === 'vencidas') {
        sql += ` AND p.data_vencimento < CURRENT_DATE AND p.status = 'pendente'`;
      } else if (periodo === 'futuras') {
        sql += ` AND p.data_vencimento > CURRENT_DATE AND p.status = 'pendente'`;
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
          -- Vencendo hoje
          COUNT(CASE WHEN DATE(p.data_vencimento) = CURRENT_DATE AND p.status = 'pendente' THEN 1 END)::int as vencendo_hoje,
          COALESCE(SUM(CASE WHEN DATE(p.data_vencimento) = CURRENT_DATE AND p.status = 'pendente' THEN p.valor ELSE 0 END), 0)::numeric as valor_hoje,
          
          -- Vencendo na semana
          COUNT(CASE WHEN p.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND p.status = 'pendente' THEN 1 END)::int as vencendo_semana,
          COALESCE(SUM(CASE WHEN p.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND p.status = 'pendente' THEN p.valor ELSE 0 END), 0)::numeric as valor_semana,
          
          -- Futuras (após hoje)
          COUNT(CASE WHEN p.data_vencimento > CURRENT_DATE AND p.status = 'pendente' THEN 1 END)::int as futuras,
          COALESCE(SUM(CASE WHEN p.data_vencimento > CURRENT_DATE AND p.status = 'pendente' THEN p.valor ELSE 0 END), 0)::numeric as valor_futuras,
          
          -- Vencidas
          COUNT(CASE WHEN p.data_vencimento < CURRENT_DATE AND p.status = 'pendente' THEN 1 END)::int as vencidas,
          COALESCE(SUM(CASE WHEN p.data_vencimento < CURRENT_DATE AND p.status = 'pendente' THEN p.valor ELSE 0 END), 0)::numeric as valor_vencidas,
          
          -- Pagas no mês
          COUNT(CASE WHEN p.status = 'pago' AND EXTRACT(MONTH FROM p.data_pagamento) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM p.data_pagamento) = EXTRACT(YEAR FROM CURRENT_DATE) THEN 1 END)::int as pagas_mes,
          COALESCE(SUM(CASE WHEN p.status = 'pago' AND EXTRACT(MONTH FROM p.data_pagamento) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM p.data_pagamento) = EXTRACT(YEAR FROM CURRENT_DATE) THEN COALESCE(p.valor_pago, p.valor) ELSE 0 END), 0)::numeric as valor_pago_mes,
          
          -- Total pagas (geral)
          COUNT(CASE WHEN p.status = 'pago' THEN 1 END)::int as total_pagas,
          COALESCE(SUM(CASE WHEN p.status = 'pago' THEN COALESCE(p.valor_pago, p.valor) ELSE 0 END), 0)::numeric as valor_total_pago
          
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        WHERE a.status IN ('ativo', 'quitado')
      `);
      
      const row = stats.rows[0];
      
      // Taxa de pagamento
      const totalParcelas = await pool.query(`
        SELECT COUNT(*)::int as total 
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        WHERE p.data_vencimento <= CURRENT_DATE AND a.status IN ('ativo', 'quitado')
      `);
      
      const taxaPagamento = totalParcelas.rows[0].total > 0
        ? ((row.total_pagas / totalParcelas.rows[0].total) * 100).toFixed(1)
        : 0;
      
      return res.json({
        success: true,
        data: {
          vencendoHoje: { quantidade: row.vencendo_hoje, valor: parseFloat(row.valor_hoje) },
          vencendoSemana: { quantidade: row.vencendo_semana, valor: parseFloat(row.valor_semana) },
          futuras: { quantidade: row.futuras, valor: parseFloat(row.valor_futuras) },
          vencidas: { quantidade: row.vencidas, valor: parseFloat(row.valor_vencidas) },
          pagasMes: { quantidade: row.pagas_mes, valor: parseFloat(row.valor_pago_mes) },
          totalPagas: { quantidade: row.total_pagas, valor: parseFloat(row.valor_total_pago) },
          taxaPagamento: parseFloat(taxaPagamento)
        }
      });
      
    } catch (err) {
      console.error('[GET /api/parcelas/stats] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar estatísticas.' });
    }
  });

  // =====================================================
  // GET /api/parcelas/futuras - Listar parcelas futuras
  // =====================================================
  router.get('/futuras', auth, async (req, res) => {
    try {
      const { limit = 100 } = req.query;
      
      const resultado = await pool.query(`
        SELECT 
          p.*,
          a.id as acordo_id,
          a.valor_acordo,
          a.numero_parcelas as total_parcelas,
          a.status as acordo_status,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          cl.telefone as cliente_telefone,
          cr.nome as credor_nome
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE p.status = 'pendente'
          AND p.data_vencimento > CURRENT_DATE
          AND a.status = 'ativo'
        ORDER BY p.data_vencimento ASC
        LIMIT $1
      `, [parseInt(limit)]);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/parcelas/futuras] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar parcelas futuras.' });
    }
  });

  // =====================================================
  // GET /api/parcelas/vencidas - Listar parcelas vencidas
  // =====================================================
  router.get('/vencidas', auth, async (req, res) => {
    try {
      const { limit = 100 } = req.query;
      
      const resultado = await pool.query(`
        SELECT 
          p.*,
          a.id as acordo_id,
          a.valor_acordo,
          a.numero_parcelas as total_parcelas,
          a.status as acordo_status,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          cl.telefone as cliente_telefone,
          cr.nome as credor_nome,
          CURRENT_DATE - DATE(p.data_vencimento) as dias_atraso
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE p.status = 'pendente'
          AND p.data_vencimento < CURRENT_DATE
          AND a.status = 'ativo'
        ORDER BY p.data_vencimento ASC
        LIMIT $1
      `, [parseInt(limit)]);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/parcelas/vencidas] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar parcelas vencidas.' });
    }
  });

  // =====================================================
  // GET /api/parcelas/hoje - Listar parcelas vencendo hoje
  // =====================================================
  router.get('/hoje', auth, async (req, res) => {
    try {
      const resultado = await pool.query(`
        SELECT 
          p.*,
          a.id as acordo_id,
          a.valor_acordo,
          a.numero_parcelas as total_parcelas,
          a.status as acordo_status,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          cl.telefone as cliente_telefone,
          cl.email as cliente_email,
          cr.nome as credor_nome
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
        WHERE p.status = 'pendente'
          AND DATE(p.data_vencimento) = CURRENT_DATE
          AND a.status = 'ativo'
        ORDER BY cl.nome ASC
      `);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/parcelas/hoje] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar parcelas de hoje.' });
    }
  });

  // =====================================================
  // GET /api/parcelas/por-acordo/:acordoId - Parcelas de um acordo
  // (DEVE VIR ANTES DE /:id para não conflitar)
  // =====================================================
  router.get('/por-acordo/:acordoId', auth, async (req, res) => {
    try {
      const { acordoId } = req.params;
      
      const resultado = await pool.query(`
        SELECT 
          p.*,
          a.valor_acordo,
          a.numero_parcelas as total_parcelas,
          a.status as acordo_status
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        WHERE p.acordo_id = $1
        ORDER BY p.numero ASC
      `, [acordoId]);
      
      return res.json({ success: true, data: resultado.rows });
      
    } catch (err) {
      console.error('[GET /api/parcelas/por-acordo/:acordoId] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao buscar parcelas do acordo.' });
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
          a.id as acordo_id,
          a.valor_acordo,
          a.numero_parcelas as total_parcelas,
          a.status as acordo_status,
          a.cobranca_id,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_cpf,
          cl.telefone as cliente_telefone,
          cl.email as cliente_email,
          cr.nome as credor_nome,
          cr.id as credor_id
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
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
      
      // Buscar parcela com dados do acordo
      const parcela = await client.query(`
        SELECT p.*, a.id as acordo_id, a.credor_id, a.cobranca_id, a.cliente_id
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        WHERE p.id = $1
      `, [id]);
      
      if (!parcela.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Parcela não encontrada.' });
      }
      
      const p = parcela.rows[0];
      
      // Verificar se já está paga
      if (p.status === 'pago') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Esta parcela já está paga.' });
      }
      
      const valorPago = parseFloat(valor_pago) || p.valor;
      const dataPagamento = data_pagamento || new Date().toISOString().split('T')[0];
      const formaPag = forma_pagamento || 'pix';
      
      // Atualizar parcela
      await client.query(`
        UPDATE parcelas SET
          status = 'pago',
          valor_pago = $1,
          data_pagamento = $2,
          forma_pagamento = $3,
          observacoes = CASE 
            WHEN observacoes IS NULL OR observacoes = '' THEN $4
            ELSE CONCAT(observacoes, ' | ', $4)
          END,
          updated_at = NOW()
        WHERE id = $5
      `, [valorPago, dataPagamento, formaPag, observacoes || '', id]);
      
      // Verificar se todas as parcelas foram pagas
      const parcelasPendentes = await client.query(`
        SELECT COUNT(*)::int as total 
        FROM parcelas 
        WHERE acordo_id = $1 AND status != 'pago'
      `, [p.acordo_id]);
      
      const acordoQuitado = parseInt(parcelasPendentes.rows[0].total) === 0;
      
      if (acordoQuitado) {
        // Acordo quitado! Atualizar status
        await client.query(
          'UPDATE acordos SET status = $1, updated_at = NOW() WHERE id = $2',
          ['quitado', p.acordo_id]
        );
        
        // Atualizar cobrança original para PAGO
        if (p.cobranca_id) {
          await client.query(
            'UPDATE cobrancas SET status = $1, data_pagamento = $2, updated_at = NOW() WHERE id = $3',
            ['pago', dataPagamento, p.cobranca_id]
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
          
          try {
            await client.query(`
              INSERT INTO comissoes (
                credor_id, parcela_id, acordo_id, cliente_id,
                valor_base, percentual, valor_comissao,
                status, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente', NOW())
            `, [p.credor_id, id, p.acordo_id, p.cliente_id, valorPago, comissaoPerc, comissaoValor]);
          } catch (comissaoErr) {
            console.warn('[PARCELAS] Aviso ao registrar comissão:', comissaoErr.message);
          }
        }
      }
      
      await client.query('COMMIT');
      
      if (registrarLog) {
        await registrarLog(req, 'PAGAR', 'parcelas', id, { 
          valor_pago: valorPago, 
          forma: formaPag,
          acordo_id: p.acordo_id,
          acordo_quitado: acordoQuitado
        });
      }
      
      return res.json({
        success: true,
        message: acordoQuitado 
          ? '🎉 Pagamento registrado! Acordo QUITADO!'
          : '✅ Pagamento registrado com sucesso!',
        acordoQuitado,
        data: {
          parcela_id: id,
          acordo_id: p.acordo_id,
          valor_pago: valorPago
        }
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
  // POST /api/parcelas/:id/gerar-asaas - NOVO: Gerar cobrança no Asaas
  // =====================================================
  router.post('/:id/gerar-asaas', auth, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Verificar se asaasRequest está disponível
      if (!asaasRequest) {
        return res.status(500).json({ success: false, message: 'Integração Asaas não configurada.' });
      }
      
      // Buscar parcela com dados do acordo e cliente
      const parcelaResult = await pool.query(`
        SELECT 
          p.*,
          a.id as acordo_id,
          a.cliente_id,
          cl.nome as cliente_nome,
          cl.cpf_cnpj as cliente_documento,
          cl.email as cliente_email,
          cl.telefone as cliente_telefone,
          cl.asaas_customer_id
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        JOIN clientes cl ON cl.id = a.cliente_id
        WHERE p.id = $1
      `, [id]);
      
      if (parcelaResult.rowCount === 0) {
        return res.status(404).json({ success: false, message: 'Parcela não encontrada.' });
      }
      
      const parcela = parcelaResult.rows[0];
      
      // Verificar se já tem cobrança no Asaas
      if (parcela.asaas_id) {
        return res.status(400).json({ 
          success: false,
          message: 'Parcela já tem cobrança no Asaas.',
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
          return res.status(500).json({ success: false, message: 'Erro ao sincronizar cliente no Asaas: ' + custErr.message });
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
        description: `Parcela ${parcela.numero} - Acordo #${(parcela.acordo_id || '').toString().substring(0, 8)}`,
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
      
      if (registrarLog) {
        await registrarLog(req, 'GERAR_ASAAS', 'parcelas', id, { asaas_id: asaasRes.id });
      }
      
      return res.json({
        success: true,
        message: 'Cobrança criada no Asaas!',
        asaasId: asaasRes.id,
        invoiceUrl: asaasRes.invoiceUrl,
        bankSlipUrl: asaasRes.bankSlipUrl,
        pixQrCode: asaasRes.pixQrCodeUrl
      });
      
    } catch (err) {
      console.error('[PARCELA-ASAAS] Erro:', err);
      return res.status(500).json({ success: false, message: err.message || 'Erro ao gerar cobrança.' });
    }
  });

  // =====================================================
  // POST /api/parcelas/pagar-massa - Pagar múltiplas parcelas
  // =====================================================
  router.post('/pagar-massa', auth, async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { ids, forma_pagamento = 'pix' } = req.body || {};
      
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'Nenhuma parcela selecionada.' });
      }
      
      await client.query('BEGIN');
      
      let pagasCount = 0;
      let acordosQuitados = [];
      
      for (const id of ids) {
        const parcela = await client.query(`
          SELECT p.*, a.id as acordo_id, a.cobranca_id
          FROM parcelas p
          JOIN acordos a ON a.id = p.acordo_id
          WHERE p.id = $1 AND p.status = 'pendente'
        `, [id]);
        
        if (parcela.rowCount === 0) continue;
        
        const p = parcela.rows[0];
        
        await client.query(`
          UPDATE parcelas SET
            status = 'pago',
            valor_pago = valor,
            data_pagamento = CURRENT_DATE,
            forma_pagamento = $1,
            updated_at = NOW()
          WHERE id = $2
        `, [forma_pagamento, id]);
        
        pagasCount++;
        
        const pendentes = await client.query(`
          SELECT COUNT(*)::int as total 
          FROM parcelas 
          WHERE acordo_id = $1 AND status != 'pago'
        `, [p.acordo_id]);
        
        if (parseInt(pendentes.rows[0].total) === 0) {
          await client.query(
            'UPDATE acordos SET status = $1, updated_at = NOW() WHERE id = $2',
            ['quitado', p.acordo_id]
          );
          
          if (p.cobranca_id) {
            await client.query(
              'UPDATE cobrancas SET status = $1, data_pagamento = CURRENT_DATE, updated_at = NOW() WHERE id = $2',
              ['pago', p.cobranca_id]
            );
          }
          
          acordosQuitados.push(p.acordo_id);
        }
      }
      
      await client.query('COMMIT');
      
      if (registrarLog) {
        await registrarLog(req, 'PAGAR_MASSA', 'parcelas', null, { 
          quantidade: pagasCount,
          acordos_quitados: acordosQuitados.length
        });
      }
      
      return res.json({
        success: true,
        message: `${pagasCount} parcela(s) paga(s)${acordosQuitados.length > 0 ? `. ${acordosQuitados.length} acordo(s) quitado(s)!` : ''}`,
        pagas: pagasCount,
        acordosQuitados: acordosQuitados.length
      });
      
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[POST /api/parcelas/pagar-massa] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao registrar pagamentos.' });
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
      
      const check = await pool.query(
        'SELECT id, status FROM parcelas WHERE id = $1',
        [id]
      );
      
      if (!check.rowCount) {
        return res.status(404).json({ success: false, message: 'Parcela não encontrada.' });
      }
      
      if (check.rows[0].status === 'pago') {
        return res.status(400).json({ success: false, message: 'Não é possível reagendar parcela já paga.' });
      }
      
      const resultado = await pool.query(`
        UPDATE parcelas SET
          data_vencimento = $1,
          observacoes = CASE 
            WHEN observacoes IS NULL OR observacoes = '' THEN $2
            ELSE CONCAT(observacoes, ' | Reagendado: ', $2)
          END,
          updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [nova_data, motivo || 'Solicitação do devedor', id]);
      
      if (registrarLog) {
        await registrarLog(req, 'REAGENDAR', 'parcelas', id, { nova_data, motivo });
      }
      
      return res.json({ 
        success: true, 
        data: resultado.rows[0], 
        message: '✅ Parcela reagendada com sucesso!' 
      });
      
    } catch (err) {
      console.error('[PUT /api/parcelas/:id/reagendar] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao reagendar parcela.' });
    }
  });

  // =====================================================
  // PUT /api/parcelas/:id/cancelar - Cancelar parcela
  // =====================================================
  router.put('/:id/cancelar', auth, async (req, res) => {
    try {
      const { id } = req.params;
      const { motivo } = req.body || {};
      
      const resultado = await pool.query(`
        UPDATE parcelas SET
          status = 'cancelado',
          observacoes = CASE 
            WHEN observacoes IS NULL OR observacoes = '' THEN $1
            ELSE CONCAT(observacoes, ' | CANCELADO: ', $1)
          END,
          updated_at = NOW()
        WHERE id = $2 AND status = 'pendente'
        RETURNING *
      `, [motivo || 'Cancelado pelo operador', id]);
      
      if (!resultado.rowCount) {
        return res.status(404).json({ success: false, message: 'Parcela não encontrada ou já processada.' });
      }
      
      if (registrarLog) {
        await registrarLog(req, 'CANCELAR', 'parcelas', id, { motivo });
      }
      
      return res.json({ 
        success: true, 
        data: resultado.rows[0], 
        message: 'Parcela cancelada.' 
      });
      
    } catch (err) {
      console.error('[PUT /api/parcelas/:id/cancelar] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao cancelar parcela.' });
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
          a.numero_parcelas,
          cr.nome as credor_nome
        FROM parcelas p
        JOIN acordos a ON a.id = p.acordo_id
        LEFT JOIN clientes cl ON cl.id = a.cliente_id
        LEFT JOIN credores cr ON cr.id = a.credor_id
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
      
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const dataVenc = new Date(p.data_vencimento);
      dataVenc.setHours(0, 0, 0, 0);
      const vencida = dataVenc < hoje;
      
      let mensagem;
      
      if (vencida) {
        const diasAtraso = Math.floor((hoje - dataVenc) / (1000 * 60 * 60 * 24));
        mensagem = `Olá, *${p.cliente_nome}*! 👋\n\n⚠️ *PARCELA EM ATRASO*\n\n📌 *Parcela:* ${p.numero}/${p.numero_parcelas}\n💰 *Valor:* ${valor}\n📅 *Vencimento:* ${vencimento}\n⏰ *Dias em atraso:* ${diasAtraso} dia(s)`;
        
        if (p.asaas_invoice_url) {
          mensagem += `\n\n🔗 *Link para pagamento:*\n${p.asaas_invoice_url}`;
        }
        
        mensagem += `\n\nPor favor, regularize o quanto antes.`;
      } else {
        mensagem = `Olá, *${p.cliente_nome}*! 👋\n\n📄 *LEMBRETE DE PARCELA*\n\n📌 *Parcela:* ${p.numero}/${p.numero_parcelas}\n💰 *Valor:* ${valor}\n📅 *Vencimento:* ${vencimento}`;
        
        if (p.asaas_invoice_url) {
          mensagem += `\n\n🔗 *Link para pagamento:*\n${p.asaas_invoice_url}`;
        }
        
        mensagem += `\n\n⚠️ Evite juros! Efetue o pagamento até a data.`;
      }

      const link = `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;
      
      if (registrarLog) {
        await registrarLog(req, 'WHATSAPP', 'parcelas', id, { telefone });
      }
      
      return res.json({ success: true, link, telefone, mensagem });
      
    } catch (err) {
      console.error('[GET /api/parcelas/:id/whatsapp] erro:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao gerar link.' });
    }
  });

  return router;
};