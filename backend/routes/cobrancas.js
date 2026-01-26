/**
 * ========================================
 * ACERTIVE - Módulo de Cobranças
 * routes/cobrancas.js
 * ========================================
 * ATUALIZADO: Rotas /stats e /pagar adicionadas
 */

const express = require('express');
const XLSX = require('xlsx');

module.exports = function(pool, auth, upload, registrarLog, asaasService = null) {
    const router = express.Router();

    // Helper para log seguro
    const logSeguro = async (userId, acao, tabela, registroId, dados) => {
        try {
            if (registrarLog && typeof registrarLog === 'function') {
                await registrarLog(userId, acao, tabela, registroId, dados);
            }
        } catch (e) {
            console.error('[LOG] Erro:', e.message);
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas/stats - ESTATÍSTICAS (NOVA ROTA)
    // ═══════════════════════════════════════════════════════════════
    router.get('/stats', auth, async (req, res) => {
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE status = 'pendente' AND (COALESCE(data_vencimento, vencimento) >= CURRENT_DATE OR (data_vencimento IS NULL AND vencimento IS NULL)))::int as pendentes,
                    COUNT(*) FILTER (WHERE (status = 'pendente' OR status = 'vencido') AND COALESCE(data_vencimento, vencimento) < CURRENT_DATE)::int as vencidas,
                    COUNT(*) FILTER (WHERE status = 'pago')::int as pagas,
                    COALESCE(SUM(COALESCE(valor, valor_original, 0)) FILTER (WHERE status = 'pendente' OR status = 'vencido'), 0)::numeric as total_pendente,
                    COALESCE(SUM(COALESCE(valor, valor_original, 0)) FILTER (WHERE status = 'pago' AND EXTRACT(MONTH FROM COALESCE(data_pagamento, updated_at)) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM COALESCE(data_pagamento, updated_at)) = EXTRACT(YEAR FROM CURRENT_DATE)), 0)::numeric as recebido_mes
                FROM cobrancas 
                WHERE (arquivado = false OR arquivado IS NULL)
                  AND status != 'acordo'
            `);
            
            const row = stats.rows[0];
            res.json({
                success: true,
                data: {
                    pendentes: row.pendentes || 0,
                    vencidas: row.vencidas || 0,
                    pagas: row.pagas || 0,
                    totalPendente: parseFloat(row.total_pendente) || 0,
                    recebidoMes: parseFloat(row.recebido_mes) || 0
                }
            });
        } catch (error) {
            console.error('[COBRANCAS] Erro stats:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas - Listar cobranças
    // ═══════════════════════════════════════════════════════════════
    router.get('/', auth, async (req, res) => {
        try {
            const { status, credor_id, empresa_id, cliente_id, categoria, data_inicio, data_fim, busca, q, page = 1, limit = 50 } = req.query;

            let query = `
                SELECT c.*, 
                       cl.nome as cliente_nome, cl.cpf_cnpj as cliente_cpf, cl.telefone as cliente_telefone, cl.email as cliente_email,
                       cr.nome as credor_nome, emp.nome as empresa_nome
                FROM cobrancas c
                LEFT JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN empresas emp ON c.empresa_id = emp.id
                WHERE (c.arquivado = false OR c.arquivado IS NULL)
                  AND c.status != 'acordo'
            `;
            const params = [];
            let idx = 1;

            if (status && status !== 'todos') { query += ` AND c.status = $${idx}`; params.push(status); idx++; }
            if (credor_id) { query += ` AND c.credor_id = $${idx}::uuid`; params.push(credor_id); idx++; }
            if (empresa_id) { query += ` AND c.empresa_id = $${idx}::uuid`; params.push(empresa_id); idx++; }
            if (cliente_id) { query += ` AND c.cliente_id = $${idx}::uuid`; params.push(cliente_id); idx++; }
            if (categoria) { query += ` AND c.categoria = $${idx}`; params.push(categoria); idx++; }
            if (data_inicio) { query += ` AND COALESCE(c.data_vencimento, c.vencimento) >= $${idx}`; params.push(data_inicio); idx++; }
            if (data_fim) { query += ` AND COALESCE(c.data_vencimento, c.vencimento) <= $${idx}`; params.push(data_fim); idx++; }
            
            const termoBusca = busca || q;
            if (termoBusca) { 
                query += ` AND (cl.nome ILIKE $${idx} OR c.descricao ILIKE $${idx} OR cl.cpf_cnpj ILIKE $${idx} OR c.referencia ILIKE $${idx})`; 
                params.push(`%${termoBusca}%`); 
                idx++; 
            }

            query += ' ORDER BY COALESCE(c.data_vencimento, c.vencimento) ASC NULLS LAST';
            const offset = (parseInt(page) - 1) * parseInt(limit);
            query += ` LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), offset);

            const result = await pool.query(query, params);

            // Normalizar dados
            const cobrancas = result.rows.map(c => ({
                ...c,
                vencimento: c.data_vencimento || c.vencimento,
                valor: c.valor || c.valor_original
            }));

            const countResult = await pool.query(`
                SELECT COUNT(*) FROM cobrancas 
                WHERE (arquivado = false OR arquivado IS NULL) AND status != 'acordo'
            `);
            const total = parseInt(countResult.rows[0].count);

            res.json({ success: true, data: cobrancas, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });

        } catch (error) {
            console.error('[COBRANCAS] Erro ao listar:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar cobranças' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas/estatisticas (mantém compatibilidade)
    // ═══════════════════════════════════════════════════════════════
    router.get('/estatisticas', auth, async (req, res) => {
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
                    COUNT(*) FILTER (WHERE status = 'pago') as pagas,
                    COUNT(*) FILTER (WHERE status = 'vencido' OR (status = 'pendente' AND COALESCE(data_vencimento, vencimento) < CURRENT_DATE)) as vencidas,
                    COUNT(*) FILTER (WHERE COALESCE(data_vencimento, vencimento) = CURRENT_DATE AND status = 'pendente') as vence_hoje,
                    COALESCE(SUM(COALESCE(valor, valor_original, 0)), 0) as valor_total,
                    COALESCE(SUM(COALESCE(valor, valor_original, 0)) FILTER (WHERE status = 'pendente'), 0) as valor_pendente,
                    COALESCE(SUM(COALESCE(valor, valor_original, 0)) FILTER (WHERE status = 'pago'), 0) as valor_pago,
                    COALESCE(SUM(COALESCE(valor, valor_original, 0)) FILTER (WHERE status = 'pago' AND EXTRACT(MONTH FROM data_pagamento) = EXTRACT(MONTH FROM CURRENT_DATE)), 0) as valor_pago_mes
                FROM cobrancas WHERE (arquivado = false OR arquivado IS NULL) AND status != 'acordo'
            `);
            res.json({ success: true, data: stats.rows[0] });
        } catch (error) {
            console.error('[COBRANCAS] Erro estatisticas:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas/arquivadas
    // ═══════════════════════════════════════════════════════════════
    router.get('/arquivadas', auth, async (req, res) => {
        try {
            const { page = 1, limit = 50 } = req.query;
            const offset = (parseInt(page) - 1) * parseInt(limit);
            
            const result = await pool.query(`
                SELECT c.*, cl.nome as cliente_nome, cr.nome as credor_nome
                FROM cobrancas c LEFT JOIN clientes cl ON c.cliente_id = cl.id LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.arquivado = true ORDER BY c.updated_at DESC LIMIT $1 OFFSET $2
            `, [parseInt(limit), offset]);

            const countResult = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE arquivado = true');
            res.json({ success: true, data: result.rows, total: parseInt(countResult.rows[0].count), page: parseInt(page) });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar arquivadas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas/:id
    // ═══════════════════════════════════════════════════════════════
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            if (['stats', 'estatisticas', 'arquivadas', 'importar'].includes(id)) return;

            const result = await pool.query(`
                SELECT c.*, cl.nome as cliente_nome, cl.cpf_cnpj as cliente_documento, cl.telefone as cliente_telefone, cl.email as cliente_email, cr.nome as credor_nome
                FROM cobrancas c LEFT JOIN clientes cl ON c.cliente_id = cl.id LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.id = $1::uuid
            `, [id]);

            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar cobrança' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/cobrancas - CRIAR COBRANÇA (SIMPLIFICADO)
    // ═══════════════════════════════════════════════════════════════
    router.post('/', auth, async (req, res) => {
        try {
            const { 
                cliente_id, 
                credor_id, 
                empresa_id, 
                descricao, 
                valor,
                valor_original,
                data_vencimento,
                vencimento,
                numero_contrato,
                observacoes,
                categoria = 'outros',
                referencia,
                status = 'pendente'
            } = req.body;

            const valorFinal = parseFloat(valor || valor_original);
            const dataVencFinal = data_vencimento || vencimento;

            if (!cliente_id) {
                return res.status(400).json({ success: false, error: 'Cliente é obrigatório' });
            }
            if (!valorFinal || valorFinal <= 0) {
                return res.status(400).json({ success: false, error: 'Valor é obrigatório e deve ser maior que zero' });
            }
            if (!dataVencFinal) {
                return res.status(400).json({ success: false, error: 'Data de vencimento é obrigatória' });
            }

            // Verificar se cliente existe
            const clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1::uuid', [cliente_id]);
            if (clienteResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            }

            const result = await pool.query(`
                INSERT INTO cobrancas (
                    cliente_id, credor_id, empresa_id, descricao, 
                    valor, valor_original, valor_atualizado, 
                    vencimento, data_vencimento, 
                    numero_contrato, observacoes, categoria, referencia,
                    status, created_at
                ) VALUES (
                    $1::uuid, $2::uuid, $3::uuid, $4, 
                    $5, $5, $5, 
                    $6, $6, 
                    $7, $8, $9, $10,
                    $11, NOW()
                ) RETURNING *
            `, [
                cliente_id, 
                credor_id || null, 
                empresa_id || null, 
                descricao,
                valorFinal,
                dataVencFinal,
                numero_contrato || null,
                observacoes || null,
                categoria,
                referencia || null,
                status
            ]);

            await logSeguro(req.user?.id, 'COBRANCA_CRIADA', 'cobrancas', result.rows[0].id, { valor: valorFinal, descricao });

            res.status(201).json({ 
                success: true, 
                message: 'Cobrança criada com sucesso!',
                data: result.rows[0]
            });

        } catch (error) {
            console.error('[COBRANCAS] Erro ao criar:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar cobrança: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/cobrancas/:id/pagar - REGISTRAR PAGAMENTO (NOVA ROTA)
    // ═══════════════════════════════════════════════════════════════
    router.put('/:id/pagar', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { data_pagamento, forma_pagamento, valor_pago } = req.body || {};

            const result = await pool.query(`
                UPDATE cobrancas 
                SET status = 'pago', 
                    data_pagamento = $2,
                    forma_pagamento = $3,
                    valor_pago = COALESCE($4, valor, valor_original),
                    updated_at = NOW()
                WHERE id = $1::uuid 
                RETURNING *
            `, [id, data_pagamento || new Date(), forma_pagamento || 'pix', valor_pago || null]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });
            }

            await logSeguro(req.user?.id, 'COBRANCA_PAGA', 'cobrancas', id, { forma_pagamento });

            res.json({ 
                success: true, 
                message: 'Pagamento registrado!',
                data: result.rows[0] 
            });
        } catch (error) {
            console.error('[COBRANCAS] Erro ao pagar:', error);
            res.status(500).json({ success: false, error: 'Erro ao registrar pagamento: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/cobrancas/:id - Atualizar cobrança
    // ═══════════════════════════════════════════════════════════════
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { 
                cliente_id, credor_id, descricao, valor, data_vencimento, vencimento,
                numero_contrato, observacoes, status,
                categoria, referencia, tipo_cobranca, multa, juros, correcao
            } = req.body;

            let updates = ['updated_at = NOW()'];
            let params = [id];
            let idx = 2;

            if (cliente_id !== undefined) { updates.push(`cliente_id = $${idx}::uuid`); params.push(cliente_id); idx++; }
            if (credor_id !== undefined) { updates.push(`credor_id = $${idx}::uuid`); params.push(credor_id); idx++; }
            if (descricao !== undefined) { updates.push(`descricao = $${idx}`); params.push(descricao); idx++; }
            if (valor !== undefined) { updates.push(`valor = $${idx}`); params.push(parseFloat(valor)); idx++; }
            if (data_vencimento !== undefined || vencimento !== undefined) { 
                const dataVenc = data_vencimento || vencimento;
                updates.push(`data_vencimento = $${idx}`); 
                updates.push(`vencimento = $${idx}`); 
                params.push(dataVenc); 
                idx++; 
            }
            if (numero_contrato !== undefined) { updates.push(`numero_contrato = $${idx}`); params.push(numero_contrato); idx++; }
            if (observacoes !== undefined) { updates.push(`observacoes = $${idx}`); params.push(observacoes); idx++; }
            if (status !== undefined) { updates.push(`status = $${idx}`); params.push(status); idx++; }
            if (categoria !== undefined) { updates.push(`categoria = $${idx}`); params.push(categoria); idx++; }
            if (referencia !== undefined) { updates.push(`referencia = $${idx}`); params.push(referencia); idx++; }
            if (tipo_cobranca !== undefined) { updates.push(`tipo_cobranca = $${idx}`); params.push(tipo_cobranca); idx++; }
            if (multa !== undefined) { updates.push(`multa = $${idx}`); params.push(multa); idx++; }
            if (juros !== undefined) { updates.push(`juros = $${idx}`); params.push(juros); idx++; }
            if (correcao !== undefined) { updates.push(`correcao = $${idx}`); params.push(correcao); idx++; }

            const result = await pool.query(`UPDATE cobrancas SET ${updates.join(', ')} WHERE id = $1::uuid RETURNING *`, params);
            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            await logSeguro(req.user?.id, 'COBRANCA_ATUALIZADA', 'cobrancas', id, {});
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('[COBRANCAS] Erro ao atualizar:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar cobrança' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/cobrancas/:id/status
    // ═══════════════════════════════════════════════════════════════
    router.put('/:id/status', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { status, data_pagamento } = req.body;

            let query = 'UPDATE cobrancas SET status = $2, updated_at = NOW()';
            const params = [id, status];

            if (status === 'pago') {
                query += data_pagamento ? ', data_pagamento = $3' : ', data_pagamento = NOW()';
                if (data_pagamento) params.push(data_pagamento);
            }
            query += ' WHERE id = $1::uuid RETURNING *';

            const result = await pool.query(query, params);
            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            await logSeguro(req.user?.id, 'COBRANCA_STATUS', 'cobrancas', id, { status });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao atualizar status' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/cobrancas/:id/whatsapp
    // ═══════════════════════════════════════════════════════════════
    router.get('/:id/whatsapp', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query(`
                SELECT c.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone, cr.nome as credor_nome
                FROM cobrancas c LEFT JOIN clientes cl ON c.cliente_id = cl.id LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.id = $1::uuid
            `, [id]);

            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            const cob = result.rows[0];
            if (!cob.cliente_telefone) return res.status(400).json({ success: false, error: 'Cliente sem telefone' });

            let telefone = cob.cliente_telefone.replace(/\D/g, '');
            if (telefone.length <= 11) telefone = '55' + telefone;

            const valor = parseFloat(cob.valor || cob.valor_original || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const dataVenc = cob.data_vencimento || cob.vencimento;
            const vencimento = dataVenc ? new Date(dataVenc).toLocaleDateString('pt-BR') : '-';

            let mensagem = `Olá ${cob.cliente_nome}!\n\n📄 *Cobrança Pendente*\n\n`;
            if (cob.credor_nome) mensagem += `📋 *Credor:* ${cob.credor_nome}\n`;
            mensagem += `📝 *Descrição:* ${cob.descricao || '-'}\n`;
            mensagem += `💰 *Valor:* ${valor}\n`;
            mensagem += `📅 *Vencimento:* ${vencimento}\n`;
            
            if (cob.asaas_invoice_url) {
                mensagem += `\n🔗 *Link para pagamento:*\n${cob.asaas_invoice_url}\n`;
            }
            
            mensagem += `\nEntre em contato para regularizar!\n\n_ACERTIVE Cobranças_`;

            res.json({ success: true, link: `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`, telefone, mensagem });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar link' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/cobrancas/arquivar-massa
    // ═══════════════════════════════════════════════════════════════
    router.post('/arquivar-massa', auth, async (req, res) => {
        try {
            const { ids } = req.body;
            if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: 'IDs são obrigatórios' });

            const result = await pool.query('UPDATE cobrancas SET arquivado = true, updated_at = NOW() WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);
            res.json({ success: true, message: `${result.rowCount} arquivada(s)`, arquivadas: result.rowCount });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao arquivar' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/cobrancas/marcar-pagas
    // ═══════════════════════════════════════════════════════════════
    router.post('/marcar-pagas', auth, async (req, res) => {
        try {
            const { ids } = req.body;
            if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: 'IDs são obrigatórios' });

            const result = await pool.query('UPDATE cobrancas SET status = \'pago\', data_pagamento = NOW(), updated_at = NOW() WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);
            await logSeguro(req.user?.id, 'COBRANCAS_MARCADAS_PAGAS', 'cobrancas', null, { quantidade: result.rowCount });
            res.json({ success: true, message: `${result.rowCount} marcada(s) como paga(s)` });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao marcar pagas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DELETE /api/cobrancas/:id
    // ═══════════════════════════════════════════════════════════════
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('DELETE FROM cobrancas WHERE id = $1::uuid RETURNING id', [id]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });

            await logSeguro(req.user?.id, 'COBRANCA_REMOVIDA', 'cobrancas', id, {});
            res.json({ success: true, message: 'Cobrança removida' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao remover' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // IMPORTAÇÃO (mantido do original)
    // ═══════════════════════════════════════════════════════════════

    router.post('/importar/clientes', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo é obrigatório' });

            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

            if (data.length === 0) return res.status(400).json({ success: false, error: 'Arquivo vazio' });

            let importados = 0, erros = [];

            for (const row of data) {
                try {
                    const nome = row.nome || row.Nome || row.cliente || row.Cliente;
                    const cpfCnpj = row.cpf_cnpj || row.cpf || row.cnpj || row.documento;
                    const telefone = row.telefone || row.Telefone;
                    const email = row.email || row.Email;

                    if (!nome) { erros.push({ linha: importados + 2, erro: 'Nome não encontrado' }); continue; }

                    if (cpfCnpj) {
                        const existe = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpfCnpj]);
                        if (existe.rows.length > 0) { erros.push({ linha: importados + 2, erro: `CPF/CNPJ já existe` }); continue; }
                    }

                    await pool.query('INSERT INTO clientes (nome, cpf_cnpj, telefone, email, status, created_at) VALUES ($1, $2, $3, $4, \'ativo\', NOW())', [nome, cpfCnpj, telefone, email]);
                    importados++;
                } catch (err) { erros.push({ linha: importados + 2, erro: err.message }); }
            }

            await logSeguro(req.user?.id, 'IMPORTACAO_CLIENTES', 'clientes', null, { total: data.length, importados });
            res.json({ success: true, total: data.length, importados, erros });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao importar' });
        }
    });

    router.post('/importar/cobrancas', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo é obrigatório' });

            const { credor_id } = req.body;
            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

            if (data.length === 0) return res.status(400).json({ success: false, error: 'Arquivo vazio' });

            let importados = 0, clientesCriados = 0, erros = [];

            for (let i = 0; i < data.length; i++) {
                const row = data[i];
                try {
                    const clienteNome = row.cliente || row.Cliente || row.nome || row.Nome;
                    const cpfCnpj = row.cpf_cnpj || row.cpf || row.cnpj;
                    const telefone = row.telefone || row.Telefone;
                    const email = row.email || row.Email;
                    const descricao = row.descricao || row.Descricao || 'Importado';
                    const valor = row.valor || row.Valor || 0;
                    const vencimento = row.vencimento || row.Vencimento || row.data_vencimento;
                    const categoria = row.categoria || row.Categoria || 'outros';
                    const referencia = row.referencia || row.Referencia || row.contrato;

                    if (!clienteNome) { erros.push({ linha: i + 2, erro: 'Nome não encontrado' }); continue; }
                    if (!valor || parseFloat(valor) <= 0) { erros.push({ linha: i + 2, erro: 'Valor inválido' }); continue; }

                    let clienteId;
                    if (cpfCnpj) {
                        const existe = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpfCnpj]);
                        if (existe.rows.length > 0) clienteId = existe.rows[0].id;
                    }

                    if (!clienteId) {
                        const porNome = await pool.query('SELECT id FROM clientes WHERE nome ILIKE $1', [clienteNome]);
                        if (porNome.rows.length > 0) {
                            clienteId = porNome.rows[0].id;
                        } else {
                            const novo = await pool.query('INSERT INTO clientes (nome, cpf_cnpj, telefone, email, status, created_at) VALUES ($1, $2, $3, $4, \'ativo\', NOW()) RETURNING id', [clienteNome, cpfCnpj, telefone, email]);
                            clienteId = novo.rows[0].id;
                            clientesCriados++;
                        }
                    }

                    let dataVenc = new Date();
                    if (vencimento) {
                        dataVenc = typeof vencimento === 'number' ? new Date(new Date(1899, 11, 30).getTime() + vencimento * 86400000) : new Date(vencimento);
                    }

                    await pool.query(`
                        INSERT INTO cobrancas (cliente_id, credor_id, descricao, valor, valor_original, vencimento, data_vencimento, categoria, referencia, status, created_at) 
                        VALUES ($1, $2, $3, $4, $4, $5, $5, $6, $7, 'pendente', NOW())
                    `, [clienteId, credor_id || null, descricao, parseFloat(valor), dataVenc, categoria, referencia]);
                    importados++;
                } catch (err) { erros.push({ linha: i + 2, erro: err.message }); }
            }

            await logSeguro(req.user?.id, 'IMPORTACAO_COBRANCAS', 'cobrancas', null, { total: data.length, importados, clientesCriados });
            res.json({ success: true, total: data.length, importados, clientes_criados: clientesCriados, erros });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao importar' });
        }
    });

    router.get('/importar/template/:tipo', auth, async (req, res) => {
        try {
            const { tipo } = req.params;
            let dados = [], nomeArquivo = 'template.xlsx';

            if (tipo === 'clientes') {
                dados = [{ nome: 'João Silva', cpf_cnpj: '12345678901', telefone: '92999999999', email: 'joao@email.com' }];
                nomeArquivo = 'template_clientes.xlsx';
            } else if (tipo === 'cobrancas') {
                dados = [{ cliente: 'João Silva', cpf_cnpj: '12345678901', descricao: 'Mensalidade', valor: 150.00, vencimento: '2025-01-15', categoria: 'mensalidade', referencia: 'CONT-001' }];
                nomeArquivo = 'template_cobrancas.xlsx';
            } else {
                return res.status(400).json({ success: false, error: 'Tipo inválido' });
            }

            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(dados), 'Dados');
            const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=${nomeArquivo}`);
            res.send(buffer);
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar template' });
        }
    });

    return router;
};