/**
 * ROTAS DO DASHBOARD - ACERTIVE
 * Estatísticas e gráficos
 */

const express = require('express');

module.exports = function(pool, auth) {
    const router = express.Router();

    // GET /api/dashboard - Estatísticas gerais
    router.get('/', auth, async (req, res) => {
        try {
            // Estatísticas de cobranças
            const cobrancas = await pool.query(`
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

            // Total de clientes
            const clientes = await pool.query('SELECT COUNT(*) FROM clientes');

            // Total de credores
            const credores = await pool.query('SELECT COUNT(*) FROM credores');

            // Acordos do mês
            const acordosMes = await pool.query(`
                SELECT COUNT(*), COALESCE(SUM(valor_total), 0) as valor
                FROM acordos
                WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE)
                  AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)
            `);

            res.json({
                cobrancas: cobrancas.rows[0],
                clientes: parseInt(clientes.rows[0].count),
                credores: parseInt(credores.rows[0].count),
                acordos_mes: acordosMes.rows[0]
            });

        } catch (error) {
            console.error('Erro ao buscar estatísticas:', error);
            res.status(500).json({ error: 'Erro ao buscar estatísticas' });
        }
    });

    // GET /api/dashboard/graficos - Dados para gráficos
    router.get('/graficos', auth, async (req, res) => {
        try {
            // Cobranças por mês (últimos 6 meses)
            const porMes = await pool.query(`
                SELECT 
                    TO_CHAR(data_vencimento, 'YYYY-MM') as mes,
                    COUNT(*) as total,
                    COALESCE(SUM(valor), 0) as valor,
                    COUNT(*) FILTER (WHERE status = 'pago') as pagas,
                    COUNT(*) FILTER (WHERE status = 'pendente') as pendentes
                FROM cobrancas
                WHERE data_vencimento >= CURRENT_DATE - INTERVAL '6 months'
                GROUP BY TO_CHAR(data_vencimento, 'YYYY-MM')
                ORDER BY mes
            `);

            // Por credor
            const porCredor = await pool.query(`
                SELECT 
                    COALESCE(cr.nome, 'Sem credor') as credor,
                    COUNT(*) as total,
                    COALESCE(SUM(c.valor), 0) as valor
                FROM cobrancas c
                LEFT JOIN credores cr ON c.credor_id = cr.id
                GROUP BY cr.id, cr.nome
                ORDER BY valor DESC
                LIMIT 10
            `);

            // Por status
            const porStatus = await pool.query(`
                SELECT 
                    status,
                    COUNT(*) as total,
                    COALESCE(SUM(valor), 0) as valor
                FROM cobrancas
                GROUP BY status
            `);

            // Vencimentos próximos (7 dias)
            const vencimentosProximos = await pool.query(`
                SELECT 
                    data_vencimento::date as data,
                    COUNT(*) as total,
                    COALESCE(SUM(valor), 0) as valor
                FROM cobrancas
                WHERE status = 'pendente'
                  AND data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
                GROUP BY data_vencimento::date
                ORDER BY data
            `);

            res.json({
                por_mes: porMes.rows,
                por_credor: porCredor.rows,
                por_status: porStatus.rows,
                vencimentos_proximos: vencimentosProximos.rows
            });

        } catch (error) {
            console.error('Erro ao buscar dados dos gráficos:', error);
            res.status(500).json({ error: 'Erro ao buscar dados' });
        }
    });

    // GET /api/dashboard/alertas - Alertas e notificações
    router.get('/alertas', auth, async (req, res) => {
        try {
            // Cobranças vencendo hoje
            const venceHoje = await pool.query(`
                SELECT COUNT(*) FROM cobrancas
                WHERE status = 'pendente' AND data_vencimento = CURRENT_DATE
            `);

            // Cobranças vencidas
            const vencidas = await pool.query(`
                SELECT COUNT(*) FROM cobrancas
                WHERE status = 'pendente' AND data_vencimento < CURRENT_DATE
            `);

            // Agendamentos de hoje
            const agendamentosHoje = await pool.query(`
                SELECT COUNT(*) FROM agendamentos
                WHERE data_agendamento = CURRENT_DATE AND status = 'pendente'
            `);

            // Parcelas vencendo hoje
            const parcelasHoje = await pool.query(`
                SELECT COUNT(*) FROM parcelas
                WHERE status = 'pendente' AND data_vencimento = CURRENT_DATE
            `);

            res.json({
                vence_hoje: parseInt(venceHoje.rows[0].count),
                vencidas: parseInt(vencidas.rows[0].count),
                agendamentos_hoje: parseInt(agendamentosHoje.rows[0].count),
                parcelas_hoje: parseInt(parcelasHoje.rows[0].count)
            });

        } catch (error) {
            console.error('Erro ao buscar alertas:', error);
            res.status(500).json({ error: 'Erro ao buscar alertas' });
        }
    });

    // GET /api/alertas/contador - Contador para badge
    router.get('/alertas/contador', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    (SELECT COUNT(*) FROM cobrancas WHERE status = 'pendente' AND data_vencimento <= CURRENT_DATE) +
                    (SELECT COUNT(*) FROM agendamentos WHERE data_agendamento = CURRENT_DATE AND status = 'pendente') +
                    (SELECT COUNT(*) FROM parcelas WHERE status = 'pendente' AND data_vencimento <= CURRENT_DATE)
                as total
            `);

            res.json({ total: parseInt(result.rows[0].total) });

        } catch (error) {
            console.error('Erro ao contar alertas:', error);
            res.status(500).json({ error: 'Erro ao contar alertas' });
        }
    });

    return router;
};
