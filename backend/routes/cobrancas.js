/**
 * ROTAS DE COBRANÇAS - ACERTIVE
 * CRUD de cobranças - CORRIGIDO COM credor_id (UUID)
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
                       cl.nome as cliente_nome,
                       cl.cpf_cnpj as cliente_documento,
                       cl.telefone as cliente_telefone,
                       cl.email as cliente_email,
                       cr.nome as credor_nome,
                       emp.nome as empresa_nome
                FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN empresas emp ON c.empresa_id = emp.id
                WHERE 1=1
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

            const result = await pool.query(query, params);

            // Contar total para paginação
            let countQuery = `
                SELECT COUNT(*) FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                WHERE 1=1
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

            res.json({
                cobrancas: result.rows,
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            });

        } catch (error) {
            console.error('Erro ao listar cobranças:', error);
            res.status(500).json({ error: 'Erro ao listar cobranças' });
        }
    });

    // GET /api/cobrancas/estatisticas - Estatísticas de cobranças
    router.get('/estatisticas', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
                    COUNT(*) FILTER (WHERE status = 'pago') as pagas,
                    COUNT(*) FILTER (WHERE status = 'vencido' OR (status = 'pendente' AND data_vencimento < CURRENT_DATE)) as vencidas,
                    COALESCE(SUM(valor), 0) as valor_total,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pendente'), 0) as valor_pendente,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0) as valor_pago
                FROM cobrancas
            `);

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao buscar estatísticas:', error);
            res.status(500).json({ error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/cobrancas/estatisticas-completas - Estatísticas detalhadas
    router.get('/estatisticas-completas', auth, async (req, res) => {
        try {
            // Estatísticas gerais
            const geral = await pool.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
                    COUNT(*) FILTER (WHERE status = 'pago') as pagas,
                    COUNT(*) FILTER (WHERE status = 'vencido' OR (status = 'pendente' AND data_vencimento < CURRENT_DATE)) as vencidas,
                    COALESCE(SUM(valor), 0) as valor_total,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pendente'), 0) as valor_pendente,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0) as valor_pago
                FROM cobrancas
            `);

            // Por credor
            const porCredor = await pool.query(`
                SELECT 
                    cr.nome as credor,
                    COUNT(*) as total,
                    COALESCE(SUM(c.valor), 0) as valor_total,
                    COUNT(*) FILTER (WHERE c.status = 'pendente') as pendentes
                FROM cobrancas c
                LEFT JOIN credores cr ON c.credor_id = cr.id
                GROUP BY cr.id, cr.nome
                ORDER BY valor_total DESC
            `);

            // Por empresa
            const porEmpresa = await pool.query(`
                SELECT 
                    emp.nome as empresa,
                    COUNT(*) as total,
                    COALESCE(SUM(c.valor), 0) as valor_total,
                    COUNT(*) FILTER (WHERE c.status = 'pendente') as pendentes
                FROM cobrancas c
                LEFT JOIN empresas emp ON c.empresa_id = emp.id
                GROUP BY emp.id, emp.nome
                ORDER BY valor_total DESC
            `);

            // Vencendo hoje
            const venceHoje = await pool.query(`
                SELECT COUNT(*), COALESCE(SUM(valor), 0) as valor
                FROM cobrancas
                WHERE status = 'pendente' AND data_vencimento = CURRENT_DATE
            `);

            // Vencendo esta semana
            const venceSemana = await pool.query(`
                SELECT COUNT(*), COALESCE(SUM(valor), 0) as valor
                FROM cobrancas
                WHERE status = 'pendente' 
                  AND data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
            `);

            res.json({
                geral: geral.rows[0],
                por_credor: porCredor.rows,
                por_empresa: porEmpresa.rows,
                vence_hoje: venceHoje.rows[0],
                vence_semana: venceSemana.rows[0]
            });

        } catch (error) {
            console.error('Erro ao buscar estatísticas completas:', error);
            res.status(500).json({ error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/cobrancas/:id - Buscar cobrança específica
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT c.*, 
                       cl.nome as cliente_nome,
                       cl.cpf_cnpj as cliente_documento,
                       cl.telefone as cliente_telefone,
                       cl.email as cliente_email,
                       cr.nome as credor_nome,
                       emp.nome as empresa_nome
                FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN empresas emp ON c.empresa_id = emp.id
                WHERE c.id = $1::uuid
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Cobrança não encontrada' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao buscar cobrança:', error);
            res.status(500).json({ error: 'Erro ao buscar cobrança' });
        }
    });

    // POST /api/cobrancas - Criar cobrança
    // ✅ CORRIGIDO: Aceita tanto credor_id quanto empresa_id (ambos UUID)
    router.post('/', auth, async (req, res) => {
        try {
            const {
                cliente_id,
                credor_id,      // UUID do credor (quem contratou a cobrança)
                empresa_id,     // UUID da empresa (seu escritório)
                descricao,
                valor,
                data_vencimento,
                numero_contrato,
                observacoes,
                status = 'pendente'
            } = req.body;

            // Validações
            if (!cliente_id) {
                return res.status(400).json({ error: 'Cliente é obrigatório' });
            }

            if (!valor || parseFloat(valor) <= 0) {
                return res.status(400).json({ error: 'Valor deve ser maior que zero' });
            }

            if (!data_vencimento) {
                return res.status(400).json({ error: 'Data de vencimento é obrigatória' });
            }

            // Preparar valores UUID (pode ser null)
            const finalCredorId = credor_id || null;
            const finalEmpresaId = empresa_id || null;

            const result = await pool.query(`
                INSERT INTO cobrancas (
                    cliente_id, credor_id, empresa_id, descricao, valor, 
                    data_vencimento, numero_contrato, observacoes, 
                    status, created_at
                ) VALUES (
                    $1::uuid, 
                    $2::uuid, 
                    $3::uuid, 
                    $4, $5, $6, $7, $8, $9, NOW()
                )
                RETURNING *
            `, [
                cliente_id,
                finalCredorId,
                finalEmpresaId,
                descricao,
                parseFloat(valor),
                data_vencimento,
                numero_contrato,
                observacoes,
                status
            ]);

            // Buscar dados completos para retornar
            const cobrancaCompleta = await pool.query(`
                SELECT c.*, 
                       cl.nome as cliente_nome,
                       cr.nome as credor_nome,
                       emp.nome as empresa_nome
                FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                LEFT JOIN empresas emp ON c.empresa_id = emp.id
                WHERE c.id = $1
            `, [result.rows[0].id]);

            await registrarLog(req.user?.id, 'COBRANCA_CRIADA', 'cobrancas', result.rows[0].id, {
                cliente_id,
                credor_id: finalCredorId,
                empresa_id: finalEmpresaId,
                valor
            });

            res.status(201).json(cobrancaCompleta.rows[0]);

        } catch (error) {
            console.error('Erro ao criar cobrança:', error);
            res.status(500).json({ error: 'Erro ao criar cobrança: ' + error.message });
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

            // Construir query dinâmica
            let updateFields = [];
            let params = [id];
            let paramIndex = 2;

            if (cliente_id !== undefined) {
                updateFields.push(`cliente_id = $${paramIndex}::uuid`);
                params.push(cliente_id);
                paramIndex++;
            }

            if (credor_id !== undefined) {
                updateFields.push(`credor_id = $${paramIndex}::uuid`);
                params.push(credor_id || null);
                paramIndex++;
            }

            if (empresa_id !== undefined) {
                updateFields.push(`empresa_id = $${paramIndex}::uuid`);
                params.push(empresa_id || null);
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
                return res.status(400).json({ error: 'Nenhum campo para atualizar' });
            }

            updateFields.push('updated_at = NOW()');

            const result = await pool.query(`
                UPDATE cobrancas SET ${updateFields.join(', ')}
                WHERE id = $1::uuid
                RETURNING *
            `, params);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Cobrança não encontrada' });
            }

            await registrarLog(req.user?.id, 'COBRANCA_ATUALIZADA', 'cobrancas', id, {});

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao atualizar cobrança:', error);
            res.status(500).json({ error: 'Erro ao atualizar cobrança' });
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
                return res.status(404).json({ error: 'Cobrança não encontrada' });
            }

            await registrarLog(req.user?.id, 'COBRANCA_STATUS', 'cobrancas', id, { status });

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao atualizar status:', error);
            res.status(500).json({ error: 'Erro ao atualizar status' });
        }
    });

    // POST /api/cobrancas/marcar-pagas - Marcar múltiplas como pagas
    router.post('/marcar-pagas', auth, async (req, res) => {
        try {
            const { ids } = req.body;

            if (!ids || !Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ error: 'IDs são obrigatórios' });
            }

            // Converter array de strings para formato UUID
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

            res.json({ success: true, atualizadas: result.rowCount });

        } catch (error) {
            console.error('Erro ao marcar cobranças como pagas:', error);
            res.status(500).json({ error: 'Erro ao atualizar cobranças' });
        }
    });

    // DELETE /api/cobrancas/:id - Remover cobrança
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query('DELETE FROM cobrancas WHERE id = $1::uuid RETURNING id', [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Cobrança não encontrada' });
            }

            await registrarLog(req.user?.id, 'COBRANCA_REMOVIDA', 'cobrancas', id, {});

            res.json({ success: true });

        } catch (error) {
            console.error('Erro ao remover cobrança:', error);
            res.status(500).json({ error: 'Erro ao remover cobrança' });
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
                JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.id = $1::uuid
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Cobrança não encontrada' });
            }

            const cobranca = result.rows[0];

            if (!cobranca.cliente_telefone) {
                return res.status(400).json({ error: 'Cliente não possui telefone cadastrado' });
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
            res.status(500).json({ error: 'Erro ao gerar link' });
        }
    });

    return router;
};