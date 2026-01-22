/**
 * ========================================
 * ROTAS DE REPASSES - ACERTIVE
 * Compatível com frontend repasses.html
 * CORRIGIDO: empresa_id, respostas padronizadas
 * ========================================
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // =====================================================
    // GET /api/repasses/calcular - Calcular pendentes de TODOS credores
    // ✅ ROTA PRINCIPAL que o frontend chama
    // =====================================================
    router.get('/calcular', auth, async (req, res) => {
        try {
            console.log('[REPASSES] Calculando pendentes de todos credores...');
            
            const result = await pool.query(`
                SELECT 
                    cr.id as credor_id,
                    cr.nome as credor_nome,
                    cr.cnpj as credor_cnpj,
                    COALESCE(cr.comissao_percentual, 10) as comissao_percentual,
                    COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_recuperado_total,
                    COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado * COALESCE(cr.comissao_percentual, 10) / 100 ELSE 0 END), 0)::numeric as valor_comissao_total,
                    COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado - (c.valor_atualizado * COALESCE(cr.comissao_percentual, 10) / 100) ELSE 0 END), 0)::numeric as valor_repassar_total
                FROM credores cr
                LEFT JOIN cobrancas c ON c.empresa_id = cr.id
                WHERE cr.status = 'ativo' OR cr.status IS NULL
                GROUP BY cr.id, cr.nome, cr.cnpj, cr.comissao_percentual
                HAVING COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado ELSE 0 END), 0) > 0
                ORDER BY cr.nome ASC
            `);

            // Buscar total já repassado por credor
            const repassados = await pool.query(`
                SELECT credor_id, COALESCE(SUM(valor), 0)::numeric as total_repassado
                FROM repasses
                WHERE status = 'pago'
                GROUP BY credor_id
            `);

            const mapRepassado = {};
            repassados.rows.forEach(r => {
                mapRepassado[r.credor_id] = parseFloat(r.total_repassado);
            });

            // Calcular saldo pendente
            const credoresComSaldo = result.rows.map(cr => {
                const jaRepassado = mapRepassado[cr.credor_id] || 0;
                const valorRepassar = parseFloat(cr.valor_repassar_total) - jaRepassado;
                
                return {
                    credor_id: cr.credor_id,
                    credor_nome: cr.credor_nome,
                    credor_cnpj: cr.credor_cnpj,
                    comissao_percentual: parseFloat(cr.comissao_percentual),
                    valor_recuperado: parseFloat(cr.valor_recuperado_total),
                    valor_comissao: parseFloat(cr.valor_comissao_total),
                    valor_repassar: valorRepassar > 0 ? valorRepassar : 0,
                    ja_repassado: jaRepassado
                };
            }).filter(cr => cr.valor_repassar > 0);

            console.log(`[REPASSES] ${credoresComSaldo.length} credores com saldo pendente`);

            res.json({ 
                success: true, 
                data: credoresComSaldo 
            });

        } catch (error) {
            console.error('[REPASSES] Erro ao calcular:', error);
            res.status(500).json({ success: false, error: 'Erro ao calcular repasses pendentes' });
        }
    });

    // =====================================================
    // GET /api/repasses - Listar histórico de repasses
    // =====================================================
    router.get('/', auth, async (req, res) => {
        try {
            const { credor_id, status, mes, ano } = req.query;
            
            let query = `
                SELECT 
                    r.*,
                    cr.nome as credor_nome,
                    cr.cnpj as credor_cnpj
                FROM repasses r
                LEFT JOIN credores cr ON r.credor_id = cr.id
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;

            if (credor_id) {
                query += ` AND r.credor_id = $${paramIndex}`;
                params.push(credor_id);
                paramIndex++;
            }

            if (status) {
                query += ` AND r.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (mes && ano) {
                query += ` AND EXTRACT(MONTH FROM r.created_at) = $${paramIndex}`;
                params.push(mes);
                paramIndex++;
                query += ` AND EXTRACT(YEAR FROM r.created_at) = $${paramIndex}`;
                params.push(ano);
                paramIndex++;
            }

            query += ' ORDER BY r.created_at DESC LIMIT 100';

            const result = await pool.query(query, params);
            
            res.json({ 
                success: true, 
                data: result.rows 
            });

        } catch (error) {
            console.error('[REPASSES] Erro ao listar:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar repasses' });
        }
    });

    // =====================================================
    // GET /api/repasses/estatisticas - Estatísticas
    // =====================================================
    router.get('/estatisticas', auth, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesAtual = mes || new Date().getMonth() + 1;
            const anoAtual = ano || new Date().getFullYear();

            const stats = await pool.query(`
                SELECT 
                    COALESCE(SUM(valor), 0)::numeric as total_mes,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0)::numeric as total_pago,
                    COALESCE(SUM(valor) FILTER (WHERE status = 'pendente'), 0)::numeric as total_pendente,
                    COUNT(DISTINCT credor_id) FILTER (WHERE status = 'pendente')::int as credores_pendentes
                FROM repasses
                WHERE EXTRACT(MONTH FROM created_at) = $1
                  AND EXTRACT(YEAR FROM created_at) = $2
            `, [mesAtual, anoAtual]);

            res.json({ 
                success: true, 
                data: stats.rows[0] 
            });

        } catch (error) {
            console.error('[REPASSES] Erro estatísticas:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // =====================================================
    // GET /api/repasses/credores - Lista credores para dropdown
    // =====================================================
    router.get('/credores', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    id,
                    nome,
                    cnpj,
                    COALESCE(comissao_percentual, 10) as comissao_percentual
                FROM credores
                WHERE status = 'ativo' OR status IS NULL
                ORDER BY nome ASC
            `);

            res.json({ 
                success: true, 
                data: result.rows 
            });

        } catch (error) {
            console.error('[REPASSES] Erro ao listar credores:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar credores' });
        }
    });

    // =====================================================
    // GET /api/repasses/:id - Buscar repasse por ID
    // =====================================================
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Evitar que "calcular" ou "credores" sejam interpretados como ID
            if (id === 'calcular' || id === 'credores' || id === 'estatisticas') {
                return res.status(400).json({ success: false, error: 'Rota inválida' });
            }

            const result = await pool.query(`
                SELECT 
                    r.*,
                    cr.nome as credor_nome
                FROM repasses r
                LEFT JOIN credores cr ON r.credor_id = cr.id
                WHERE r.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Repasse não encontrado' });
            }

            res.json({ 
                success: true, 
                data: result.rows[0] 
            });

        } catch (error) {
            console.error('[REPASSES] Erro ao buscar:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar repasse' });
        }
    });

    // =====================================================
    // POST /api/repasses - Criar novo repasse
    // =====================================================
    router.post('/', auth, async (req, res) => {
        try {
            const { 
                credor_id, 
                valor, 
                valor_recuperado,
                comissao,
                forma_pagamento, 
                comprovante,
                observacao,
                status = 'pago'  // Frontend já manda como 'pago'
            } = req.body;

            console.log('[REPASSES] Criando repasse:', { credor_id, valor, forma_pagamento, status });

            if (!credor_id || !valor) {
                return res.status(400).json({ success: false, error: 'credor_id e valor são obrigatórios' });
            }

            const result = await pool.query(`
                INSERT INTO repasses (
                    credor_id, 
                    valor, 
                    valor_recuperado,
                    comissao,
                    forma_pagamento, 
                    comprovante,
                    observacao,
                    status, 
                    data_repasse,
                    created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
                RETURNING *
            `, [
                credor_id, 
                valor, 
                valor_recuperado || 0,
                comissao || 0,
                forma_pagamento || 'pix', 
                comprovante,
                observacao,
                status
            ]);

            // Registrar log
            try {
                await registrarLog(req.user?.id || 1, 'REPASSE_CRIADO', 'repasses', result.rows[0].id, { 
                    valor, 
                    credor_id,
                    forma_pagamento 
                });
            } catch (logErr) {
                console.error('[REPASSES] Erro ao registrar log:', logErr);
            }

            console.log('[REPASSES] Repasse criado com sucesso:', result.rows[0].id);

            res.status(201).json({ 
                success: true, 
                data: result.rows[0],
                message: 'Repasse registrado com sucesso!'
            });

        } catch (error) {
            console.error('[REPASSES] Erro ao criar:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar repasse' });
        }
    });

    // =====================================================
    // PUT /api/repasses/:id - Atualizar repasse
    // =====================================================
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { status, data_pagamento, comprovante, observacao } = req.body;

            const result = await pool.query(`
                UPDATE repasses 
                SET status = COALESCE($1, status),
                    data_pagamento = COALESCE($2, data_pagamento),
                    comprovante = COALESCE($3, comprovante),
                    observacao = COALESCE($4, observacao),
                    updated_at = NOW()
                WHERE id = $5
                RETURNING *
            `, [status, data_pagamento, comprovante, observacao, id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Repasse não encontrado' });
            }

            try {
                await registrarLog(req.user?.id || 1, 'REPASSE_ATUALIZADO', 'repasses', id, { status });
            } catch (logErr) {}

            res.json({ 
                success: true, 
                data: result.rows[0],
                message: 'Repasse atualizado!'
            });

        } catch (error) {
            console.error('[REPASSES] Erro ao atualizar:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar repasse' });
        }
    });

    // =====================================================
    // POST /api/repasses/:id/pagar - Marcar como pago
    // =====================================================
    router.post('/:id/pagar', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { comprovante } = req.body;

            const result = await pool.query(`
                UPDATE repasses 
                SET status = 'pago',
                    data_pagamento = NOW(),
                    data_repasse = NOW(),
                    comprovante = COALESCE($1, comprovante),
                    updated_at = NOW()
                WHERE id = $2
                RETURNING *
            `, [comprovante, id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Repasse não encontrado' });
            }

            try {
                await registrarLog(req.user?.id || 1, 'REPASSE_PAGO', 'repasses', id, {});
            } catch (logErr) {}

            res.json({ 
                success: true, 
                data: result.rows[0],
                message: 'Repasse marcado como pago!'
            });

        } catch (error) {
            console.error('[REPASSES] Erro ao pagar:', error);
            res.status(500).json({ success: false, error: 'Erro ao pagar repasse' });
        }
    });

    // =====================================================
    // DELETE /api/repasses/:id - Excluir repasse
    // =====================================================
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query('DELETE FROM repasses WHERE id = $1 RETURNING *', [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Repasse não encontrado' });
            }

            try {
                await registrarLog(req.user?.id || 1, 'REPASSE_EXCLUIDO', 'repasses', id, {});
            } catch (logErr) {}

            res.json({ 
                success: true, 
                message: 'Repasse excluído com sucesso!'
            });

        } catch (error) {
            console.error('[REPASSES] Erro ao excluir:', error);
            res.status(500).json({ success: false, error: 'Erro ao excluir repasse' });
        }
    });

    // =====================================================
    // POST /api/repasses/calcular - Versão POST (compatibilidade)
    // =====================================================
    router.post('/calcular', auth, async (req, res) => {
        try {
            const { credor_id } = req.body;

            if (!credor_id) {
                // Se não passou credor_id, retorna todos (mesmo que GET)
                return router.handle({ ...req, method: 'GET', url: '/calcular' }, res);
            }

            const result = await pool.query(`
                SELECT 
                    cr.nome as credor_nome,
                    cr.cnpj as credor_cnpj,
                    COALESCE(cr.comissao_percentual, 10) as comissao_percentual,
                    COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado ELSE 0 END), 0)::numeric as valor_recuperado,
                    COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado * COALESCE(cr.comissao_percentual, 10) / 100 ELSE 0 END), 0)::numeric as valor_comissao,
                    COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_atualizado - (c.valor_atualizado * COALESCE(cr.comissao_percentual, 10) / 100) ELSE 0 END), 0)::numeric as valor_repassar
                FROM credores cr
                LEFT JOIN cobrancas c ON c.empresa_id = cr.id
                WHERE cr.id = $1
                GROUP BY cr.id, cr.nome, cr.cnpj, cr.comissao_percentual
            `, [credor_id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Credor não encontrado' });
            }

            const repassado = await pool.query(`
                SELECT COALESCE(SUM(valor), 0)::numeric as total
                FROM repasses
                WHERE credor_id = $1 AND status = 'pago'
            `, [credor_id]);

            const dados = result.rows[0];
            const jaRepassado = parseFloat(repassado.rows[0].total);
            const saldoPendente = parseFloat(dados.valor_repassar) - jaRepassado;

            res.json({
                success: true,
                data: {
                    credor_nome: dados.credor_nome,
                    comissao_percentual: parseFloat(dados.comissao_percentual),
                    valor_recuperado: parseFloat(dados.valor_recuperado),
                    valor_comissao: parseFloat(dados.valor_comissao),
                    valor_repassar: saldoPendente > 0 ? saldoPendente : 0,
                    ja_repassado: jaRepassado
                }
            });

        } catch (error) {
            console.error('[REPASSES] Erro ao calcular (POST):', error);
            res.status(500).json({ success: false, error: 'Erro ao calcular repasse' });
        }
    });

    return router;
};