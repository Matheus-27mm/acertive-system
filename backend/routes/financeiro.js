/**
 * ========================================
 * ACERTIVE - Módulo Financeiro
 * routes/financeiro.js
 * ========================================
 * Unifica: financeiro, comissoes, repasses, relatorios
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // DASHBOARD FINANCEIRO
    // ═══════════════════════════════════════════════════════════════

    // GET /api/financeiro/resumo
    router.get('/resumo', auth, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesAtual = mes || (new Date().getMonth() + 1);
            const anoAtual = ano || new Date().getFullYear();

            const recuperado = await pool.query(`
                SELECT COUNT(*)::int as quantidade, COALESCE(SUM(valor_pago), 0)::numeric as valor
                FROM cobrancas WHERE status = 'pago' AND EXTRACT(MONTH FROM data_pagamento) = $1 AND EXTRACT(YEAR FROM data_pagamento) = $2
            `, [mesAtual, anoAtual]);

            const repasses = await pool.query(`
                SELECT COALESCE(SUM(valor), 0)::numeric as total
                FROM repasses WHERE status = 'pago' AND EXTRACT(MONTH FROM data_repasse) = $1 AND EXTRACT(YEAR FROM data_repasse) = $2
            `, [mesAtual, anoAtual]);

            res.json({
                success: true,
                data: {
                    periodo: `${mesAtual}/${anoAtual}`,
                    recuperado: { quantidade: recuperado.rows[0].quantidade, valor: parseFloat(recuperado.rows[0].valor) },
                    repassado: parseFloat(repasses.rows[0].total)
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar resumo' });
        }
    });

    // GET /api/financeiro/resumo-credores
    router.get('/resumo-credores', auth, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesAtual = mes || (new Date().getMonth() + 1);
            const anoAtual = ano || new Date().getFullYear();

            const resultado = await pool.query(`
                SELECT cr.id, cr.nome, cr.cnpj, cr.comissao_percentual, cr.comissao_meta, cr.comissao_bonus,
                       cr.banco, cr.agencia, cr.conta, cr.pix_tipo, cr.pix_chave,
                       COALESCE(SUM(CASE WHEN c.status = 'pago' AND EXTRACT(MONTH FROM c.data_pagamento) = $1 AND EXTRACT(YEAR FROM c.data_pagamento) = $2 THEN c.valor_pago ELSE 0 END), 0)::numeric as valor_recuperado
                FROM credores cr LEFT JOIN cobrancas c ON c.credor_id = cr.id
                WHERE cr.status = 'ativo' GROUP BY cr.id ORDER BY cr.nome
            `, [mesAtual, anoAtual]);

            const repasses = await pool.query(`
                SELECT credor_id, COALESCE(SUM(valor), 0)::numeric as total_repassado
                FROM repasses WHERE status = 'pago' AND EXTRACT(MONTH FROM data_repasse) = $1 AND EXTRACT(YEAR FROM data_repasse) = $2
                GROUP BY credor_id
            `, [mesAtual, anoAtual]);

            const repassesMap = {};
            repasses.rows.forEach(r => { repassesMap[r.credor_id] = parseFloat(r.total_repassado) || 0; });

            let totalRecuperado = 0, totalComissao = 0, totalARepassar = 0, totalJaRepassado = 0;

            const credores = resultado.rows.map(cr => {
                const recuperado = parseFloat(cr.valor_recuperado) || 0;
                const comissaoPerc = parseFloat(cr.comissao_percentual) || 10;
                let comissao = (recuperado * comissaoPerc) / 100;

                // Verificar meta e bônus
                if (cr.comissao_meta && recuperado >= parseFloat(cr.comissao_meta) && cr.comissao_bonus) {
                    comissao += parseFloat(cr.comissao_bonus);
                }

                const jaRepassado = repassesMap[cr.id] || 0;
                const aRepassar = Math.max(0, recuperado - comissao - jaRepassado);

                totalRecuperado += recuperado;
                totalComissao += comissao;
                totalARepassar += aRepassar;
                totalJaRepassado += jaRepassado;

                return {
                    id: cr.id, nome: cr.nome, cnpj: cr.cnpj,
                    comissao_percentual: comissaoPerc,
                    valor_recuperado: recuperado,
                    comissao: Math.round(comissao * 100) / 100,
                    ja_repassado: jaRepassado,
                    a_repassar: Math.round(aRepassar * 100) / 100,
                    dados_bancarios: { banco: cr.banco, agencia: cr.agencia, conta: cr.conta, pix_tipo: cr.pix_tipo, pix_chave: cr.pix_chave }
                };
            });

            res.json({
                success: true,
                data: {
                    periodo: `${mesAtual}/${anoAtual}`,
                    credores,
                    totais: {
                        recuperado: Math.round(totalRecuperado * 100) / 100,
                        comissao: Math.round(totalComissao * 100) / 100,
                        ja_repassado: Math.round(totalJaRepassado * 100) / 100,
                        a_repassar: Math.round(totalARepassar * 100) / 100
                    }
                }
            });
        } catch (error) {
            console.error('[FINANCEIRO] Erro:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar resumo por credores' });
        }
    });

    // GET /api/financeiro/prestacao-contas/:credor_id
    router.get('/prestacao-contas/:credor_id', auth, async (req, res) => {
        try {
            const { credor_id } = req.params;
            const { mes, ano } = req.query;
            const mesAtual = mes || (new Date().getMonth() + 1);
            const anoAtual = ano || new Date().getFullYear();

            const credor = await pool.query('SELECT * FROM credores WHERE id = $1', [credor_id]);
            if (!credor.rowCount) return res.status(404).json({ success: false, error: 'Credor não encontrado' });

            const cobrancasPagas = await pool.query(`
                SELECT c.*, cl.nome as cliente_nome, cl.cpf_cnpj as cliente_cpf
                FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id
                WHERE c.credor_id = $1 AND c.status = 'pago'
                  AND EXTRACT(MONTH FROM c.data_pagamento) = $2 AND EXTRACT(YEAR FROM c.data_pagamento) = $3
                ORDER BY c.data_pagamento
            `, [credor_id, mesAtual, anoAtual]);

            const repasses = await pool.query(`
                SELECT * FROM repasses WHERE credor_id = $1
                  AND EXTRACT(MONTH FROM data_repasse) = $2 AND EXTRACT(YEAR FROM data_repasse) = $3
                ORDER BY data_repasse
            `, [credor_id, mesAtual, anoAtual]);

            const totalRecuperado = cobrancasPagas.rows.reduce((sum, c) => sum + parseFloat(c.valor_pago || 0), 0);
            const comissaoPerc = parseFloat(credor.rows[0].comissao_percentual) || 10;
            const comissao = (totalRecuperado * comissaoPerc) / 100;
            const totalRepassado = repasses.rows.reduce((sum, r) => sum + parseFloat(r.valor || 0), 0);
            const saldoDevedor = totalRecuperado - comissao - totalRepassado;

            res.json({
                success: true,
                data: {
                    credor: credor.rows[0],
                    periodo: `${mesAtual}/${anoAtual}`,
                    cobrancas_pagas: cobrancasPagas.rows,
                    repasses: repasses.rows,
                    resumo: {
                        total_recuperado: Math.round(totalRecuperado * 100) / 100,
                        comissao_percentual: comissaoPerc,
                        comissao_valor: Math.round(comissao * 100) / 100,
                        total_repassado: Math.round(totalRepassado * 100) / 100,
                        saldo_devedor: Math.round(saldoDevedor * 100) / 100
                    }
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar prestação de contas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // COMISSÕES
    // ═══════════════════════════════════════════════════════════════

    // GET /api/financeiro/comissoes
    router.get('/comissoes', auth, async (req, res) => {
        try {
            const { credor_id, status, mes, ano } = req.query;

            let query = `SELECT cm.*, cr.nome as credor_nome FROM comissoes cm LEFT JOIN credores cr ON cr.id = cm.credor_id WHERE 1=1`;
            const params = [];
            let idx = 1;

            if (credor_id) { query += ` AND cm.credor_id = $${idx}`; params.push(credor_id); idx++; }
            if (status) { query += ` AND cm.status = $${idx}`; params.push(status); idx++; }
            if (mes) { query += ` AND cm.mes = $${idx}`; params.push(mes); idx++; }
            if (ano) { query += ` AND cm.ano = $${idx}`; params.push(ano); idx++; }

            query += ' ORDER BY cm.ano DESC, cm.mes DESC';

            const result = await pool.query(query, params);
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar comissões' });
        }
    });

    // GET /api/financeiro/comissoes/estatisticas
    router.get('/comissoes/estatisticas', auth, async (req, res) => {
        try {
            const mesAtual = new Date().getMonth() + 1;
            const anoAtual = new Date().getFullYear();

            const stats = await pool.query(`
                SELECT 
                    COALESCE(SUM(CASE WHEN mes = $1 AND ano = $2 THEN valor ELSE 0 END), 0)::numeric as total_mes,
                    COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor ELSE 0 END), 0)::numeric as pendente,
                    COALESCE(SUM(CASE WHEN status = 'pago' THEN valor ELSE 0 END), 0)::numeric as pago
                FROM comissoes
            `, [mesAtual, anoAtual]);

            res.json({ success: true, data: stats.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // POST /api/financeiro/comissoes
    router.post('/comissoes', auth, async (req, res) => {
        try {
            const { credor_id, valor, mes, ano, percentual, observacoes } = req.body;

            if (!credor_id || !valor) return res.status(400).json({ success: false, error: 'Credor e valor são obrigatórios' });

            const result = await pool.query(`
                INSERT INTO comissoes (credor_id, valor, mes, ano, percentual, observacoes, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW()) RETURNING *
            `, [credor_id, valor, mes || new Date().getMonth() + 1, ano || new Date().getFullYear(), percentual, observacoes]);

            await registrarLog(req.user?.id, 'COMISSAO_CRIADA', 'comissoes', result.rows[0].id, { valor });
            res.status(201).json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao criar comissão' });
        }
    });

    // POST /api/financeiro/comissoes/:id/pagar
    router.post('/comissoes/:id/pagar', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { data_pagamento } = req.body;

            const result = await pool.query(`
                UPDATE comissoes SET status = 'pago', data_pagamento = $2, updated_at = NOW()
                WHERE id = $1 RETURNING *
            `, [id, data_pagamento || new Date()]);

            if (!result.rowCount) return res.status(404).json({ success: false, error: 'Comissão não encontrada' });

            await registrarLog(req.user?.id, 'COMISSAO_PAGA', 'comissoes', id, {});
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao pagar comissão' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // REPASSES
    // ═══════════════════════════════════════════════════════════════

    // GET /api/financeiro/repasses/calcular
    router.get('/repasses/calcular', auth, async (req, res) => {
        try {
            const resultado = await pool.query(`
                SELECT cr.id, cr.nome, cr.cnpj, cr.comissao_percentual,
                       cr.banco, cr.agencia, cr.conta, cr.pix_tipo, cr.pix_chave,
                       COALESCE(SUM(CASE WHEN c.status = 'pago' THEN c.valor_pago ELSE 0 END), 0)::numeric as total_recuperado,
                       COALESCE((SELECT SUM(valor) FROM repasses WHERE credor_id = cr.id AND status = 'pago'), 0)::numeric as total_repassado
                FROM credores cr LEFT JOIN cobrancas c ON c.credor_id = cr.id
                WHERE cr.status = 'ativo' GROUP BY cr.id ORDER BY cr.nome
            `);

            const credores = resultado.rows.map(cr => {
                const recuperado = parseFloat(cr.total_recuperado) || 0;
                const comissao = (recuperado * (parseFloat(cr.comissao_percentual) || 10)) / 100;
                const repassado = parseFloat(cr.total_repassado) || 0;
                const pendente = Math.max(0, recuperado - comissao - repassado);

                return {
                    id: cr.id, nome: cr.nome, cnpj: cr.cnpj,
                    total_recuperado: recuperado,
                    comissao,
                    total_repassado: repassado,
                    valor_pendente: Math.round(pendente * 100) / 100,
                    dados_bancarios: { banco: cr.banco, agencia: cr.agencia, conta: cr.conta, pix_tipo: cr.pix_tipo, pix_chave: cr.pix_chave }
                };
            }).filter(cr => cr.valor_pendente > 0);

            res.json({ success: true, data: credores });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao calcular repasses' });
        }
    });

    // GET /api/financeiro/repasses
    router.get('/repasses', auth, async (req, res) => {
        try {
            const { credor_id, status, page = 1, limit = 50 } = req.query;

            let query = `SELECT r.*, cr.nome as credor_nome FROM repasses r LEFT JOIN credores cr ON cr.id = r.credor_id WHERE 1=1`;
            const params = [];
            let idx = 1;

            if (credor_id) { query += ` AND r.credor_id = $${idx}`; params.push(credor_id); idx++; }
            if (status) { query += ` AND r.status = $${idx}`; params.push(status); idx++; }

            query += ' ORDER BY r.created_at DESC';
            const offset = (parseInt(page) - 1) * parseInt(limit);
            query += ` LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), offset);

            const result = await pool.query(query, params);
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar repasses' });
        }
    });

    // GET /api/financeiro/repasses/estatisticas
    router.get('/repasses/estatisticas', auth, async (req, res) => {
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(*)::int as total,
                    COUNT(CASE WHEN status = 'pendente' THEN 1 END)::int as pendentes,
                    COUNT(CASE WHEN status = 'pago' THEN 1 END)::int as pagos,
                    COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor ELSE 0 END), 0)::numeric as valor_pendente,
                    COALESCE(SUM(CASE WHEN status = 'pago' THEN valor ELSE 0 END), 0)::numeric as valor_pago
                FROM repasses
            `);
            res.json({ success: true, data: stats.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // POST /api/financeiro/repasses
    router.post('/repasses', auth, async (req, res) => {
        try {
            const { credor_id, valor, data_repasse, forma_pagamento, comprovante, observacoes } = req.body;

            if (!credor_id || !valor) return res.status(400).json({ success: false, error: 'Credor e valor são obrigatórios' });

            const result = await pool.query(`
                INSERT INTO repasses (credor_id, valor, data_repasse, forma_pagamento, comprovante, observacoes, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, 'pago', NOW()) RETURNING *
            `, [credor_id, valor, data_repasse || new Date(), forma_pagamento || 'pix', comprovante, observacoes]);

            await registrarLog(req.user?.id, 'REPASSE_CRIADO', 'repasses', result.rows[0].id, { credor_id, valor });
            res.status(201).json({ success: true, data: result.rows[0], message: 'Repasse registrado!' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao criar repasse' });
        }
    });

    // DELETE /api/financeiro/repasses/:id
    router.delete('/repasses/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            await pool.query('DELETE FROM repasses WHERE id = $1', [id]);
            await registrarLog(req.user?.id, 'REPASSE_EXCLUIDO', 'repasses', id, {});
            res.json({ success: true, message: 'Repasse excluído' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao excluir repasse' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // RELATÓRIOS
    // ═══════════════════════════════════════════════════════════════

    // GET /api/financeiro/relatorios/cobrancas-csv
    router.get('/relatorios/cobrancas-csv', auth, async (req, res) => {
        try {
            const { status, credor_id, data_inicio, data_fim } = req.query;

            let query = `
                SELECT c.id, cl.nome as cliente, cl.cpf_cnpj, c.descricao, c.valor, c.data_vencimento, c.status, c.data_pagamento, cr.nome as credor
                FROM cobrancas c LEFT JOIN clientes cl ON cl.id = c.cliente_id LEFT JOIN credores cr ON cr.id = c.credor_id WHERE 1=1
            `;
            const params = [];
            let idx = 1;

            if (status) { query += ` AND c.status = $${idx}`; params.push(status); idx++; }
            if (credor_id) { query += ` AND c.credor_id = $${idx}`; params.push(credor_id); idx++; }
            if (data_inicio) { query += ` AND c.data_vencimento >= $${idx}`; params.push(data_inicio); idx++; }
            if (data_fim) { query += ` AND c.data_vencimento <= $${idx}`; params.push(data_fim); idx++; }

            query += ' ORDER BY c.data_vencimento DESC';

            const result = await pool.query(query, params);

            let csv = 'ID,Cliente,CPF/CNPJ,Descrição,Valor,Vencimento,Status,Data Pagamento,Credor\n';
            result.rows.forEach(r => {
                csv += `${r.id},"${r.cliente || ''}","${r.cpf_cnpj || ''}","${r.descricao || ''}",${r.valor},${r.data_vencimento || ''},${r.status},${r.data_pagamento || ''},"${r.credor || ''}"\n`;
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=cobrancas.csv');
            res.send('\ufeff' + csv);
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar relatório' });
        }
    });

    // GET /api/financeiro/relatorios/clientes-csv
    router.get('/relatorios/clientes-csv', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT c.id, c.nome, c.cpf_cnpj, c.telefone, c.email, c.cidade, c.estado, c.status,
                       COUNT(cb.id) as total_cobrancas, COALESCE(SUM(cb.valor), 0) as valor_total
                FROM clientes c LEFT JOIN cobrancas cb ON cb.cliente_id = c.id
                GROUP BY c.id ORDER BY c.nome
            `);

            let csv = 'ID,Nome,CPF/CNPJ,Telefone,Email,Cidade,Estado,Status,Total Cobranças,Valor Total\n';
            result.rows.forEach(r => {
                csv += `${r.id},"${r.nome || ''}","${r.cpf_cnpj || ''}","${r.telefone || ''}","${r.email || ''}","${r.cidade || ''}","${r.estado || ''}",${r.status},${r.total_cobrancas},${r.valor_total}\n`;
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=clientes.csv');
            res.send('\ufeff' + csv);
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar relatório' });
        }
    });

    // GET /api/financeiro/relatorios/acordos-csv
    router.get('/relatorios/acordos-csv', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT a.id, cl.nome as cliente, cl.cpf_cnpj, cr.nome as credor, a.valor_original, a.valor_acordo, a.desconto_percentual, a.numero_parcelas, a.status, a.created_at
                FROM acordos a LEFT JOIN clientes cl ON cl.id = a.cliente_id LEFT JOIN credores cr ON cr.id = a.credor_id
                ORDER BY a.created_at DESC
            `);

            let csv = 'ID,Cliente,CPF/CNPJ,Credor,Valor Original,Valor Acordo,Desconto %,Parcelas,Status,Data Criação\n';
            result.rows.forEach(r => {
                csv += `${r.id},"${r.cliente || ''}","${r.cpf_cnpj || ''}","${r.credor || ''}",${r.valor_original},${r.valor_acordo},${r.desconto_percentual},${r.numero_parcelas},${r.status},${r.created_at}\n`;
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=acordos.csv');
            res.send('\ufeff' + csv);
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar relatório' });
        }
    });

    // GET /api/financeiro/relatorios/financeiro
    router.get('/relatorios/financeiro', auth, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesAtual = mes || (new Date().getMonth() + 1);
            const anoAtual = ano || new Date().getFullYear();

            const recebimentos = await pool.query(`
                SELECT cr.id as credor_id, cr.nome as credor_nome,
                       COUNT(c.id)::int as quantidade, COALESCE(SUM(c.valor_pago), 0)::numeric as valor
                FROM credores cr LEFT JOIN cobrancas c ON c.credor_id = cr.id AND c.status = 'pago'
                    AND EXTRACT(MONTH FROM c.data_pagamento) = $1 AND EXTRACT(YEAR FROM c.data_pagamento) = $2
                GROUP BY cr.id ORDER BY cr.nome
            `, [mesAtual, anoAtual]);

            const parcelasPagas = await pool.query(`
                SELECT COUNT(*)::int as quantidade, COALESCE(SUM(valor_pago), 0)::numeric as valor
                FROM parcelas WHERE status = 'pago'
                  AND EXTRACT(MONTH FROM data_pagamento) = $1 AND EXTRACT(YEAR FROM data_pagamento) = $2
            `, [mesAtual, anoAtual]);

            res.json({
                success: true,
                data: {
                    periodo: `${mesAtual}/${anoAtual}`,
                    recebimentos_por_credor: recebimentos.rows,
                    parcelas_pagas: parcelasPagas.rows[0]
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar relatório' });
        }
    });

    // GET /api/financeiro/relatorios/inadimplencia
    router.get('/relatorios/inadimplencia', auth, async (req, res) => {
        try {
            const faixas = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE data_vencimento >= CURRENT_DATE - 7 AND data_vencimento < CURRENT_DATE)::int as vencido_7_dias,
                    COUNT(*) FILTER (WHERE data_vencimento >= CURRENT_DATE - 30 AND data_vencimento < CURRENT_DATE - 7)::int as vencido_30_dias,
                    COUNT(*) FILTER (WHERE data_vencimento >= CURRENT_DATE - 90 AND data_vencimento < CURRENT_DATE - 30)::int as vencido_90_dias,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE - 90)::int as vencido_mais_90
                FROM cobrancas WHERE status IN ('pendente', 'vencido')
            `);

            const topDevedores = await pool.query(`
                SELECT cl.id, cl.nome, cl.cpf_cnpj, COUNT(c.id)::int as total_cobrancas, COALESCE(SUM(c.valor), 0)::numeric as valor_total
                FROM clientes cl JOIN cobrancas c ON c.cliente_id = cl.id
                WHERE c.status IN ('pendente', 'vencido') AND c.data_vencimento < CURRENT_DATE
                GROUP BY cl.id ORDER BY valor_total DESC LIMIT 10
            `);

            res.json({ success: true, data: { faixas_atraso: faixas.rows[0], top_devedores: topDevedores.rows } });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar relatório' });
        }
    });

    // GET /api/financeiro/relatorios/produtividade
    router.get('/relatorios/produtividade', auth, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesAtual = mes || (new Date().getMonth() + 1);
            const anoAtual = ano || new Date().getFullYear();

            const acordos = await pool.query(`
                SELECT COUNT(*)::int as total, COALESCE(SUM(valor_acordo), 0)::numeric as valor
                FROM acordos WHERE EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(YEAR FROM created_at) = $2
            `, [mesAtual, anoAtual]);

            const cobrancasPagas = await pool.query(`
                SELECT COUNT(*)::int as total, COALESCE(SUM(valor_pago), 0)::numeric as valor
                FROM cobrancas WHERE status = 'pago'
                  AND EXTRACT(MONTH FROM data_pagamento) = $1 AND EXTRACT(YEAR FROM data_pagamento) = $2
            `, [mesAtual, anoAtual]);

            res.json({
                success: true,
                data: {
                    periodo: `${mesAtual}/${anoAtual}`,
                    acordos: acordos.rows[0],
                    cobrancas_pagas: cobrancasPagas.rows[0]
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao gerar relatório' });
        }
    });

    return router;
};