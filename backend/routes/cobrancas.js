/**
 * ROTAS DE COBRANÇAS - ACERTIVE
 * CRUD de cobranças - CORRIGIDO COM credor_id (UUID)
 * ATUALIZADO: Formato de resposta compatível com frontend
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/cobrancas - Listar cobranças
    router.get('/', auth, async (req, res) => {
        try {
            const { 
                status, 
                credor_id,
                empresa_id,
                cliente_id,
                data_inicio, 
                data_fim,
                busca,
                page = 1,
                limit = 50
            } = req.query;

            let query = `
                SELECT c.*, 
                       cl.nome as cliente,
                       cl.cpf_cnpj as cliente_documento,
                       cl.telefone as cliente_telefone,
                       cl.email as cliente_email,
                       cr.nome as credor_nome,
                       emp.nome as empresa_nome,
                       c.data_vencimento as vencimento,
                       c.valor as valor_original
                FROM cobrancas c
                LEFT JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN empresas emp ON c.empresa_id = emp.id
                WHERE c.arquivado = false OR c.arquivado IS NULL
            `;
            const params = [];
            let paramIndex = 1;

            if (status && status !== 'todos') {
                query += ` AND c.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            // Filtro por credor (UUID)
            if (credor_id) {
                query += ` AND c.credor_id = $${paramIndex}::uuid`;
                params.push(credor_id);
                paramIndex++;
            }

            // Filtro por empresa (UUID)
            if (empresa_id) {
                query += ` AND c.empresa_id = $${paramIndex}::uuid`;
                params.push(empresa_id);
                paramIndex++;
            }

            // Filtro por cliente (UUID)
            if (cliente_id) {
                query += ` AND c.cliente_id = $${paramIndex}::uuid`;
                params.push(cliente_id);
                paramIndex++;
            }

            if (data_inicio) {
                query += ` AND c.data_vencimento >= $${paramIndex}`;
                params.push(data_inicio);
                paramIndex++;
            }

            if (data_fim) {
                query += ` AND c.data_vencimento <= $${paramIndex}`;
                params.push(data_fim);
                paramIndex++;
            }

            if (busca) {
                query += ` AND (cl.nome ILIKE $${paramIndex} OR c.descricao ILIKE $${paramIndex} OR cl.cpf_cnpj ILIKE $${paramIndex})`;
                params.push(`%${busca}%`);
                paramIndex++;
            }

            query += ' ORDER BY c.data_vencimento DESC';

            // Paginação
            const offset = (parseInt(page) - 1) * parseInt(limit);
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), offset);

            console.log('[COBRANCAS] Query:', query);
            console.log('[COBRANCAS] Params:', params);

            const result = await pool.query(query, params);

            // Contar total para paginação
            let countQuery = `
                SELECT COUNT(*) FROM cobrancas c
                LEFT JOIN clientes cl ON c.cliente_id = cl.id
                WHERE (c.arquivado = false OR c.arquivado IS NULL)
            `;
            const countParams = [];
            let countIndex = 1;

            if (status && status !== 'todos') {
                countQuery += ` AND c.status = $${countIndex}`;
                countParams.push(status);
                countIndex++;
            }

            if (credor_id) {
                countQuery += ` AND c.credor_id = $${countIndex}::uuid`;
                countParams.push(credor_id);
                countIndex++;
            }

            if (empresa_id) {
                countQuery += ` AND c.empresa_id = $${countIndex}::uuid`;
                countParams.push(empresa_id);
                countIndex++;
            }

            if (cliente_id) {
                countQuery += ` AND c.cliente_id = $${countIndex}::uuid`;
                countParams.push(cliente_id);
                countIndex++;
            }

            const countResult = await pool.query(countQuery, countParams);
            const total = parseInt(countResult.rows[0].count);

            // FORMATO COMPATÍVEL COM FRONTEND
            res.json({
                success: true,
                data: result.rows,
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            });

        } catch (error) {
            console.error('Erro ao listar cobranças:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar cobranças' });
        }
    });

    // GET /api/cobrancas/arquivadas - Listar cobranças arquivadas
    router.get('/arquivadas', auth, async (req, res) => {
        try {
            const { page = 1, limit = 50 } = req.query;

            const query = `
                SELECT c.*, 
                       cl.nome as cliente,
                       cl.cpf_cnpj as cliente_documento,
                       cl.telefone as cliente_telefone,
                       cl.email as cliente_email,
                       cr.nome as credor_nome,
                       emp.nome as empresa_nome,
                       c.data_vencimento as vencimento,
                       c.valor as valor_original
                FROM cobrancas c
                LEFT JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN empresas emp ON c.empresa_id = emp.id
                WHERE c.arquivado = true
                ORDER BY c.updated_at DESC
                LIMIT $1 OFFSET $2
            `;

            const offset = (parseInt(page) - 1) * parseInt(limit);
            const result = await pool.query(query, [parseInt(limit), offset]);

            const countResult = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE arquivado = true');
            const total = parseInt(countResult.rows[0].count);

            res.json({
                success: true,
                data: result.rows,
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            });

        } catch (error) {
            console.error('Erro ao listar arquivadas:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar cobranças arquivadas' });
        }
    });

    // POST /api/cobrancas/arquivar-massa - Arquivar múltiplas cobranças
    router.post('/arquivar-massa', auth, async (req, res) => {
        try {
            const { ids } = req.body;

            if (!ids || !Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, error: 'IDs são obrigatórios' });
            }

            const result = await pool.query(`
                UPDATE cobrancas 
                SET arquivado = true, updated_at = NOW()
                WHERE id = ANY($1::uuid[])
                RETURNING id
            `, [ids]);

            res.json({ 
                success: true, 
                message: `${result.rowCount} cobrança(s) arquivada(s)`,
                arquivadas: result.rowCount 
            });

        } catch (error) {
            console.error('Erro ao arquivar cobranças:', error);
            res.status(500).json({ success: false, error: 'Erro ao arquivar cobranças' });
        }
    });

    // POST /api/cobrancas/desarquivar-massa - Desarquivar múltiplas cobranças
    router.post('/desarquivar-massa', auth, async (req, res) => {
        try {
            const { ids } = req.body;

            if (!ids || !Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, error: 'IDs são obrigatórios' });
            }

            const result = await pool.query(`
                UPDATE cobrancas 
                SET arquivado = false, updated_at = NOW()
                WHERE id = ANY($1::uuid[])
                RETURNING id
            `, [ids]);

            res.json({ 
                success: true, 
                message: `${result.rowCount} cobrança(s) desarquivada(s)`,
                desarquivadas: result.rowCount 
            });

        } catch (error) {
            console.error('Erro ao desarquivar cobranças:', error);
            res.status(500).json({ success: false, error: 'Erro ao desarquivar cobranças' });
        }
    });

    // POST /api/cobrancas/arquivar-todas - Arquivar todas as cobranças filtradas
    router.post('/arquivar-todas', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                UPDATE cobrancas 
                SET arquivado = true, updated_at = NOW()
                WHERE arquivado = false OR arquivado IS NULL
                RETURNING id
            `);

            res.json({ 
                success: true, 
                message: `${result.rowCount} cobrança(s) arquivada(s)`,
                arquivadas: result.rowCount 
            });

        } catch (error) {
            console.error('Erro ao arquivar todas:', error);
            res.status(500).json({ success: false, error: 'Erro ao arquivar cobranças' });
        }
    });

    // GET /api/cobrancas/estatisticas - Estatísticas de cobranças
    router.get('/estatisticas', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE (arquivado = false OR arquivado IS NULL)) as total,
                    COUNT(*) FILTER (WHERE status = 'pendente' AND data_vencimento >= CURRENT_DATE AND (arquivado = false OR arquivado IS NULL)) as pendentes,
                    COUNT(*) FILTER (WHERE status = 'pago' AND (arquivado = false OR arquivado IS NULL)) as pagas,
                    COUNT(*) FILTER (WHERE (status = 'vencido' OR (status = 'pendente' AND data_vencimento < CURRENT_DATE)) AND (arquivado = false OR arquivado IS NULL)) as vencidas,
                    COUNT(*) FILTER (WHERE status = 'acordo' AND (arquivado = false OR arquivado IS NULL)) as acordo,
                    COUNT(*) FILTER (WHERE arquivado = true) as arquivadas,
                    COALESCE(SUM(valor) FILTER (WHERE (arquivado = false OR arquivado IS NULL)), 0) as valor_total,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pendente' AND (arquivado = false OR arquivado IS NULL)), 0) as valor_pendente,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pago' AND (arquivado = false OR arquivado IS NULL)), 0) as valor_pago
                FROM cobrancas
            `);

            res.json({
                success: true,
                data: result.rows[0]
            });

        } catch (error) {
            console.error('Erro ao buscar estatísticas:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/cobrancas/estatisticas-completas - Estatísticas detalhadas
    // FORMATO COMPATÍVEL COM FRONTEND
    router.get('/estatisticas-completas', auth, async (req, res) => {
        try {
            // Estatísticas gerais - CORRIGIDO para calcular vencidas corretamente
            const result = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE (arquivado = false OR arquivado IS NULL)) as total,
                    COUNT(*) FILTER (WHERE status = 'pendente' AND data_vencimento >= CURRENT_DATE AND (arquivado = false OR arquivado IS NULL)) as pendentes,
                    COUNT(*) FILTER (WHERE status = 'pago' AND (arquivado = false OR arquivado IS NULL)) as pagas,
                    COUNT(*) FILTER (WHERE (status = 'vencido' OR (status = 'pendente' AND data_vencimento < CURRENT_DATE)) AND (arquivado = false OR arquivado IS NULL)) as vencidas,
                    COUNT(*) FILTER (WHERE status = 'acordo' AND (arquivado = false OR arquivado IS NULL)) as em_acordo,
                    COUNT(*) FILTER (WHERE arquivado = true) as arquivadas,
                    COALESCE(SUM(valor) FILTER (WHERE (arquivado = false OR arquivado IS NULL)), 0) as valor_total,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pendente' AND (arquivado = false OR arquivado IS NULL)), 0) as valor_pendente,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pago' AND (arquivado = false OR arquivado IS NULL)), 0) as valor_pago
                FROM cobrancas
            `);

            const stats = result.rows[0];

            // FORMATO QUE O FRONTEND ESPERA (camelCase)
            res.json({
                success: true,
                data: {
                    total: parseInt(stats.total) || 0,
                    pendentes: parseInt(stats.pendentes) || 0,
                    vencidas: parseInt(stats.vencidas) || 0,
                    pagas: parseInt(stats.pagas) || 0,
                    emAcordo: parseInt(stats.em_acordo) || 0,
                    arquivadas: parseInt(stats.arquivadas) || 0,
                    valorTotal: parseFloat(stats.valor_total) || 0,
                    valorPendente: parseFloat(stats.valor_pendente) || 0,
                    valorPago: parseFloat(stats.valor_pago) || 0
                }
            });

        } catch (error) {
            console.error('Erro ao buscar estatísticas completas:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/cobrancas/:id - Buscar cobrança específica
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Evitar conflito com outras rotas
            if (['estatisticas', 'estatisticas-completas', 'arquivadas'].includes(id)) {
                return;
            }

            const result = await pool.query(`
                SELECT c.*, 
                       cl.nome as cliente,
                       cl.cpf_cnpj as cliente_documento,
                       cl.telefone as cliente_telefone,
                       cl.email as cliente_email,
                       cr.nome as credor_nome,
                       emp.nome as empresa_nome
                FROM cobrancas c
                LEFT JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN empresas emp ON c.empresa_id = emp.id
                WHERE c.id = $1::uuid
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });
            }

            res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error('Erro ao buscar cobrança:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar cobrança' });
        }
    });

    // POST /api/cobrancas - Criar cobrança
    router.post('/', auth, async (req, res) => {
        try {
            const {
                cliente_id,
                credor_id,
                empresa_id,
                descricao,
                valor,
                data_vencimento,
                numero_contrato,
                observacoes,
                status = 'pendente'
            } = req.body;

            if (!cliente_id || !valor || !data_vencimento) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Cliente, valor e data de vencimento são obrigatórios' 
                });
            }

            const result = await pool.query(`
                INSERT INTO cobrancas (
                    cliente_id, credor_id, empresa_id, descricao, valor,
                    data_vencimento, numero_contrato, observacoes, status,
                    arquivado, created_at, updated_at
                )
                VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, false, NOW(), NOW())
                RETURNING *
            `, [
                cliente_id,
                credor_id || null,
                empresa_id || null,
                descricao || '',
                parseFloat(valor),
                data_vencimento,
                numero_contrato || null,
                observacoes || null,
                status
            ]);

            await registrarLog(req.user?.id, 'COBRANCA_CRIADA', 'cobrancas', result.rows[0].id, {
                valor,
                cliente_id
            });

            res.status(201).json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error('Erro ao criar cobrança:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar cobrança: ' + error.message });
        }
    });

    // PUT /api/cobrancas/:id - Atualizar cobrança
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const {
                cliente_id,
                credor_id,
                empresa_id,
                descricao,
                valor,
                data_vencimento,
                numero_contrato,
                observacoes,
                status
            } = req.body;

            const updateFields = [];
            const params = [id];
            let paramIndex = 2;

            if (cliente_id !== undefined) {
                updateFields.push(`cliente_id = $${paramIndex}::uuid`);
                params.push(cliente_id);
                paramIndex++;
            }

            if (credor_id !== undefined) {
                updateFields.push(`credor_id = $${paramIndex}::uuid`);
                params.push(credor_id);
                paramIndex++;
            }

            if (empresa_id !== undefined) {
                updateFields.push(`empresa_id = $${paramIndex}::uuid`);
                params.push(empresa_id);
                paramIndex++;
            }

            if (descricao !== undefined) {
                updateFields.push(`descricao = $${paramIndex}`);
                params.push(descricao);
                paramIndex++;
            }

            if (valor !== undefined) {
                updateFields.push(`valor = $${paramIndex}`);
                params.push(parseFloat(valor));
                paramIndex++;
            }

            if (data_vencimento !== undefined) {
                updateFields.push(`data_vencimento = $${paramIndex}`);
                params.push(data_vencimento);
                paramIndex++;
            }

            if (numero_contrato !== undefined) {
                updateFields.push(`numero_contrato = $${paramIndex}`);
                params.push(numero_contrato);
                paramIndex++;
            }

            if (observacoes !== undefined) {
                updateFields.push(`observacoes = $${paramIndex}`);
                params.push(observacoes);
                paramIndex++;
            }

            if (status !== undefined) {
                updateFields.push(`status = $${paramIndex}`);
                params.push(status);
                paramIndex++;
            }

            if (updateFields.length === 0) {
                return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
            }

            updateFields.push('updated_at = NOW()');

            const result = await pool.query(`
                UPDATE cobrancas SET ${updateFields.join(', ')}
                WHERE id = $1::uuid
                RETURNING *
            `, params);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });
            }

            await registrarLog(req.user?.id, 'COBRANCA_ATUALIZADA', 'cobrancas', id, {});

            res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error('Erro ao atualizar cobrança:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar cobrança' });
        }
    });

    // PUT /api/cobrancas/:id/status - Atualizar status
    router.put('/:id/status', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { status, data_pagamento } = req.body;

            let query = 'UPDATE cobrancas SET status = $2, updated_at = NOW()';
            const params = [id, status];

            if (status === 'pago' && data_pagamento) {
                query += ', data_pagamento = $3';
                params.push(data_pagamento);
            } else if (status === 'pago') {
                query += ', data_pagamento = NOW()';
            }

            query += ' WHERE id = $1::uuid RETURNING *';

            const result = await pool.query(query, params);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });
            }

            await registrarLog(req.user?.id, 'COBRANCA_STATUS', 'cobrancas', id, { status });

            res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error('Erro ao atualizar status:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar status' });
        }
    });

    // POST /api/cobrancas/marcar-pagas - Marcar múltiplas como pagas
    router.post('/marcar-pagas', auth, async (req, res) => {
        try {
            const { ids } = req.body;

            if (!ids || !Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, error: 'IDs são obrigatórios' });
            }

            const result = await pool.query(`
                UPDATE cobrancas 
                SET status = 'pago', data_pagamento = NOW(), updated_at = NOW()
                WHERE id = ANY($1::uuid[])
                RETURNING id
            `, [ids]);

            await registrarLog(req.user?.id, 'COBRANCAS_MARCADAS_PAGAS', 'cobrancas', null, {
                ids,
                quantidade: result.rowCount
            });

            res.json({ 
                success: true, 
                message: `${result.rowCount} cobrança(s) marcada(s) como paga(s)`,
                atualizadas: result.rowCount 
            });

        } catch (error) {
            console.error('Erro ao marcar cobranças como pagas:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar cobranças' });
        }
    });

    // DELETE /api/cobrancas/:id - Remover cobrança
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query('DELETE FROM cobrancas WHERE id = $1::uuid RETURNING id', [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });
            }

            await registrarLog(req.user?.id, 'COBRANCA_REMOVIDA', 'cobrancas', id, {});

            res.json({ success: true, message: 'Cobrança removida' });

        } catch (error) {
            console.error('Erro ao remover cobrança:', error);
            res.status(500).json({ success: false, error: 'Erro ao remover cobrança' });
        }
    });

    // GET /api/cobrancas/:id/whatsapp - Gerar link WhatsApp
    router.get('/:id/whatsapp', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT c.*, 
                       cl.nome as cliente_nome, 
                       cl.telefone as cliente_telefone,
                       cr.nome as credor_nome
                FROM cobrancas c
                LEFT JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.id = $1::uuid
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Cobrança não encontrada' });
            }

            const cobranca = result.rows[0];

            if (!cobranca.cliente_telefone) {
                return res.status(400).json({ success: false, error: 'Cliente não possui telefone cadastrado' });
            }

            // Formatar telefone
            let telefone = cobranca.cliente_telefone.replace(/\D/g, '');
            if (telefone.length <= 11) {
                telefone = '55' + telefone;
            }

            // Formatar valor
            const valor = parseFloat(cobranca.valor).toLocaleString('pt-BR', {
                style: 'currency',
                currency: 'BRL'
            });

            // Formatar vencimento
            const vencimento = new Date(cobranca.data_vencimento).toLocaleDateString('pt-BR');

            // Montar mensagem
            const mensagem = `Olá ${cobranca.cliente_nome}!

Identificamos uma pendência em seu nome:

📋 *Credor:* ${cobranca.credor_nome || 'Não informado'}
📝 *Descrição:* ${cobranca.descricao}
💰 *Valor:* ${valor}
📅 *Vencimento:* ${vencimento}

Entre em contato conosco para regularizar sua situação!

_ACERTIVE - Sistema de Cobranças_`;

            const link = `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;

            res.json({
                success: true,
                link,
                telefone,
                mensagem
            });

        } catch (error) {
            console.error('Erro ao gerar link WhatsApp:', error);
            res.status(500).json({ success: false, error: 'Erro ao gerar link' });
        }
    });

    return router;
};