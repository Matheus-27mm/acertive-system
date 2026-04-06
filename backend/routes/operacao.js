/**
 * ========================================
 * ACERTIVE - Módulo de Operação
 * routes/operacao.js
 * ========================================
 * Registro diário de contatos, resultados e retornos
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // POST /api/operacao/registrar - Registrar contato
    // ═══════════════════════════════════════════════════════════════
    router.post('/registrar', auth, async (req, res) => {
        try {
            const { cliente_id, resultado, data_retorno, observacao, canal, acordo_id } = req.body;

            if (!cliente_id) return res.status(400).json({ success: false, error: 'Cliente é obrigatório' });
            if (!resultado) return res.status(400).json({ success: false, error: 'Resultado é obrigatório' });

            const resultados_validos = ['atendeu', 'nao_atendeu', 'gerou_acordo', 'retorno_agendado', 'numero_errado', 'recusou'];
            if (!resultados_validos.includes(resultado)) {
                return res.status(400).json({ success: false, error: 'Resultado inválido' });
            }

            if (resultado === 'retorno_agendado' && !data_retorno) {
                return res.status(400).json({ success: false, error: 'Data de retorno é obrigatória para retorno agendado' });
            }

            const reg = await pool.query(`
                INSERT INTO registros_operacao (operador_id, cliente_id, resultado, data_retorno, observacao, canal, acordo_id, data_contato, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, NOW())
                RETURNING *
            `, [
                req.user?.id, cliente_id, resultado,
                data_retorno || null, observacao || null,
                canal || 'whatsapp', acordo_id || null
            ]);

            // Atualizar data_ultimo_contato no cliente
            await pool.query('UPDATE clientes SET data_ultimo_contato = CURRENT_DATE WHERE id = $1', [cliente_id]);

            if (registrarLog) {
                await registrarLog(req.user?.id, 'CONTATO_REGISTRADO', 'registros_operacao', reg.rows[0].id, { resultado, canal });
            }

            res.json({ success: true, data: reg.rows[0], message: 'Contato registrado com sucesso!' });
        } catch (error) {
            console.error('[OPERACAO] Erro ao registrar:', error);
            res.status(500).json({ success: false, error: 'Erro ao registrar contato: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/operacao/dashboard - KPIs gerenciais
    // ═══════════════════════════════════════════════════════════════
    router.get('/dashboard', auth, async (req, res) => {
        try {
            const { periodo = '7' } = req.query; // dias
            const dias = parseInt(periodo) || 7;

            // KPIs gerais do período
            const kpis = await pool.query(`
                SELECT
                    COUNT(*)::int as total_contatos,
                    COUNT(CASE WHEN resultado = 'atendeu' THEN 1 END)::int as atenderam,
                    COUNT(CASE WHEN resultado = 'nao_atendeu' THEN 1 END)::int as nao_atenderam,
                    COUNT(CASE WHEN resultado = 'gerou_acordo' THEN 1 END)::int as acordos_gerados,
                    COUNT(CASE WHEN resultado = 'retorno_agendado' THEN 1 END)::int as retornos_agendados,
                    COUNT(CASE WHEN resultado = 'recusou' THEN 1 END)::int as recusaram,
                    COUNT(CASE WHEN resultado = 'numero_errado' THEN 1 END)::int as numero_errado,
                    COUNT(DISTINCT cliente_id)::int as clientes_abordados,
                    COUNT(DISTINCT operador_id)::int as operadores_ativos
                FROM registros_operacao
                WHERE data_contato >= CURRENT_DATE - $1::int
            `, [dias]);

            // Ticket médio dos acordos gerados no período
            const ticket = await pool.query(`
                SELECT COALESCE(AVG(a.valor_acordo), 0)::numeric as ticket_medio,
                       COALESCE(SUM(a.valor_acordo), 0)::numeric as valor_total_acordos
                FROM registros_operacao r
                JOIN acordos a ON a.id = r.acordo_id
                WHERE r.data_contato >= CURRENT_DATE - $1::int
                AND r.resultado = 'gerou_acordo'
            `, [dias]);

            // Retornos pendentes para hoje e atrasados
            const retornos = await pool.query(`
                SELECT
                    COUNT(CASE WHEN data_retorno = CURRENT_DATE THEN 1 END)::int as retornos_hoje,
                    COUNT(CASE WHEN data_retorno < CURRENT_DATE THEN 1 END)::int as retornos_atrasados,
                    COUNT(CASE WHEN data_retorno > CURRENT_DATE THEN 1 END)::int as retornos_futuros
                FROM registros_operacao
                WHERE resultado = 'retorno_agendado'
                AND data_retorno IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM registros_operacao r2
                    WHERE r2.cliente_id = registros_operacao.cliente_id
                    AND r2.created_at > registros_operacao.created_at
                )
            `);

            // Evolução diária (últimos N dias)
            const evolucao = await pool.query(`
                SELECT
                    data_contato::text as data,
                    COUNT(*)::int as total,
                    COUNT(CASE WHEN resultado = 'atendeu' THEN 1 END)::int as atenderam,
                    COUNT(CASE WHEN resultado = 'gerou_acordo' THEN 1 END)::int as acordos,
                    COUNT(CASE WHEN resultado = 'nao_atendeu' THEN 1 END)::int as nao_atenderam
                FROM registros_operacao
                WHERE data_contato >= CURRENT_DATE - $1::int
                GROUP BY data_contato
                ORDER BY data_contato ASC
            `, [dias]);

            // Ranking de operadores
            const ranking = await pool.query(`
                SELECT
                    u.nome as operador,
                    COUNT(r.id)::int as total_contatos,
                    COUNT(CASE WHEN r.resultado = 'atendeu' THEN 1 END)::int as atendimentos,
                    COUNT(CASE WHEN r.resultado = 'gerou_acordo' THEN 1 END)::int as acordos,
                    ROUND(
                        CASE WHEN COUNT(*) > 0
                        THEN COUNT(CASE WHEN r.resultado = 'gerou_acordo' THEN 1 END)::numeric / COUNT(*)::numeric * 100
                        ELSE 0 END, 1
                    ) as taxa_conversao
                FROM registros_operacao r
                LEFT JOIN usuarios u ON u.id = r.operador_id
                WHERE r.data_contato >= CURRENT_DATE - $1::int
                GROUP BY u.id, u.nome
                ORDER BY acordos DESC, total_contatos DESC
            `, [dias]);

            // Distribuição por resultado
            const distribuicao = await pool.query(`
                SELECT resultado, COUNT(*)::int as quantidade
                FROM registros_operacao
                WHERE data_contato >= CURRENT_DATE - $1::int
                GROUP BY resultado
                ORDER BY quantidade DESC
            `, [dias]);

            const k = kpis.rows[0];
            const t = ticket.rows[0];
            const r = retornos.rows[0];

            const taxaAtendimento = k.total_contatos > 0
                ? ((k.atenderam / k.total_contatos) * 100).toFixed(1)
                : 0;
            const taxaConversao = k.atenderam > 0
                ? ((k.acordos_gerados / k.atenderam) * 100).toFixed(1)
                : 0;

            res.json({
                success: true,
                data: {
                    periodo: dias,
                    kpis: {
                        ...k,
                        taxa_atendimento: parseFloat(taxaAtendimento),
                        taxa_conversao: parseFloat(taxaConversao),
                        ticket_medio: parseFloat(t.ticket_medio) || 0,
                        valor_total_acordos: parseFloat(t.valor_total_acordos) || 0
                    },
                    retornos: r,
                    evolucao: evolucao.rows,
                    ranking: ranking.rows,
                    distribuicao: distribuicao.rows
                }
            });
        } catch (error) {
            console.error('[OPERACAO] Erro dashboard:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar dashboard: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/operacao/fila-retorno - Clientes para retornar
    // ═══════════════════════════════════════════════════════════════
    router.get('/fila-retorno', auth, async (req, res) => {
        try {
            const { page = 1, limit = 50 } = req.query;

            const resultado = await pool.query(`
                SELECT DISTINCT ON (r.cliente_id)
                    r.id, r.cliente_id, r.data_retorno, r.observacao, r.canal,
                    r.created_at as data_agendamento,
                    r.operador_id,
                    u.nome as operador_nome,
                    cl.nome as cliente_nome,
                    cl.telefone as cliente_telefone,
                    cl.cpf_cnpj as cliente_cpf,
                    CASE
                        WHEN r.data_retorno < CURRENT_DATE THEN 'atrasado'
                        WHEN r.data_retorno = CURRENT_DATE THEN 'hoje'
                        ELSE 'futuro'
                    END as situacao,
                    (CURRENT_DATE - r.data_retorno)::int as dias_atraso
                FROM registros_operacao r
                LEFT JOIN clientes cl ON cl.id = r.cliente_id
                LEFT JOIN usuarios u ON u.id = r.operador_id
                WHERE r.resultado = 'retorno_agendado'
                AND r.data_retorno IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM registros_operacao r2
                    WHERE r2.cliente_id = r.cliente_id
                    AND r2.created_at > r.created_at
                    AND r2.resultado != 'retorno_agendado'
                )
                ORDER BY r.cliente_id, r.created_at DESC
            `);

            // Filtrar e ordenar: atrasados primeiro, depois hoje, depois futuros
            const fila = resultado.rows.sort((a, b) => {
                const ordem = { atrasado: 0, hoje: 1, futuro: 2 };
                if (ordem[a.situacao] !== ordem[b.situacao]) return ordem[a.situacao] - ordem[b.situacao];
                return new Date(a.data_retorno) - new Date(b.data_retorno);
            });

            res.json({
                success: true,
                data: fila,
                total: fila.length,
                atrasados: fila.filter(f => f.situacao === 'atrasado').length,
                hoje: fila.filter(f => f.situacao === 'hoje').length
            });
        } catch (error) {
            console.error('[OPERACAO] Erro fila retorno:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar fila: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/operacao/historico - Histórico de registros
    // ═══════════════════════════════════════════════════════════════
    router.get('/historico', auth, async (req, res) => {
        try {
            const { page = 1, limit = 50, operador_id, resultado, data_inicio, data_fim } = req.query;

            let sql = `
                SELECT r.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone,
                       cl.cpf_cnpj as cliente_cpf, u.nome as operador_nome
                FROM registros_operacao r
                LEFT JOIN clientes cl ON cl.id = r.cliente_id
                LEFT JOIN usuarios u ON u.id = r.operador_id
                WHERE 1=1
            `;
            const params = [];
            let idx = 1;

            if (operador_id) { sql += ` AND r.operador_id = $${idx}`; params.push(operador_id); idx++; }
            if (resultado) { sql += ` AND r.resultado = $${idx}`; params.push(resultado); idx++; }
            if (data_inicio) { sql += ` AND r.data_contato >= $${idx}`; params.push(data_inicio); idx++; }
            if (data_fim) { sql += ` AND r.data_contato <= $${idx}`; params.push(data_fim); idx++; }

            sql += ` ORDER BY r.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

            const resultado_query = await pool.query(sql, params);
            res.json({ success: true, data: resultado_query.rows });
        } catch (error) {
            console.error('[OPERACAO] Erro histórico:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar histórico: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/operacao/cliente/:id - Histórico de um cliente
    // ═══════════════════════════════════════════════════════════════
    router.get('/cliente/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const resultado = await pool.query(`
                SELECT r.*, u.nome as operador_nome
                FROM registros_operacao r
                LEFT JOIN usuarios u ON u.id = r.operador_id
                WHERE r.cliente_id = $1
                ORDER BY r.created_at DESC
            `, [id]);
            res.json({ success: true, data: resultado.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar histórico do cliente' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DELETE /api/operacao/:id - Excluir registro (admin)
    // ═══════════════════════════════════════════════════════════════
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            await pool.query('DELETE FROM registros_operacao WHERE id = $1', [id]);
            res.json({ success: true, message: 'Registro excluído' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao excluir registro' });
        }
    });

    return router;
};