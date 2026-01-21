/**
 * ROTAS DE RELATÓRIOS - ACERTIVE
 * Exportação de dados e geração de relatórios
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/relatorios/cobrancas-csv - Exportar cobranças para CSV
    router.get('/cobrancas-csv', auth, async (req, res) => {
        try {
            const { data_inicio, data_fim, status, credor_id } = req.query;

            let query = `
                SELECT 
                    c.id,
                    cl.nome as cliente,
                    cl.cpf_cnpj as documento,
                    cl.telefone,
                    cl.email,
                    cr.nome as credor,
                    c.descricao,
                    c.valor,
                    c.data_vencimento,
                    c.status,
                    c.data_pagamento,
                    c.created_at as data_cadastro
                FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE 1=1
            `;
            const params = [];
            let paramIndex = 1;

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

            if (status) {
                query += ` AND c.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (credor_id) {
                query += ` AND c.credor_id = $${paramIndex}`;
                params.push(credor_id);
                paramIndex++;
            }

            query += ' ORDER BY c.data_vencimento DESC';

            const result = await pool.query(query, params);

            // Gerar CSV
            const headers = ['ID', 'Cliente', 'Documento', 'Telefone', 'Email', 'Credor', 'Descrição', 'Valor', 'Vencimento', 'Status', 'Data Pagamento', 'Data Cadastro'];
            
            let csv = headers.join(';') + '\n';
            
            result.rows.forEach(row => {
                csv += [
                    row.id,
                    `"${row.cliente || ''}"`,
                    `"${row.documento || ''}"`,
                    `"${row.telefone || ''}"`,
                    `"${row.email || ''}"`,
                    `"${row.credor || ''}"`,
                    `"${row.descricao || ''}"`,
                    row.valor ? row.valor.toString().replace('.', ',') : '0',
                    row.data_vencimento ? new Date(row.data_vencimento).toLocaleDateString('pt-BR') : '',
                    row.status || '',
                    row.data_pagamento ? new Date(row.data_pagamento).toLocaleDateString('pt-BR') : '',
                    row.data_cadastro ? new Date(row.data_cadastro).toLocaleDateString('pt-BR') : ''
                ].join(';') + '\n';
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=cobrancas.csv');
            res.send('\uFEFF' + csv); // BOM para Excel reconhecer UTF-8

        } catch (error) {
            console.error('Erro ao exportar CSV:', error);
            res.status(500).json({ error: 'Erro ao exportar' });
        }
    });

    // GET /api/relatorios/clientes-csv - Exportar clientes para CSV
    router.get('/clientes-csv', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    c.id,
                    c.nome,
                    c.cpf_cnpj,
                    c.telefone,
                    c.email,
                    c.endereco,
                    c.status,
                    c.created_at,
                    COUNT(cb.id) as total_cobrancas,
                    SUM(CASE WHEN cb.status = 'pendente' THEN cb.valor ELSE 0 END) as divida_pendente
                FROM clientes c
                LEFT JOIN cobrancas cb ON c.id = cb.cliente_id
                GROUP BY c.id
                ORDER BY c.nome
            `);

            const headers = ['ID', 'Nome', 'CPF/CNPJ', 'Telefone', 'Email', 'Endereço', 'Status', 'Data Cadastro', 'Total Cobranças', 'Dívida Pendente'];
            
            let csv = headers.join(';') + '\n';
            
            result.rows.forEach(row => {
                csv += [
                    row.id,
                    `"${row.nome || ''}"`,
                    `"${row.cpf_cnpj || ''}"`,
                    `"${row.telefone || ''}"`,
                    `"${row.email || ''}"`,
                    `"${row.endereco || ''}"`,
                    row.status || '',
                    row.created_at ? new Date(row.created_at).toLocaleDateString('pt-BR') : '',
                    row.total_cobrancas || 0,
                    row.divida_pendente ? row.divida_pendente.toString().replace('.', ',') : '0'
                ].join(';') + '\n';
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=clientes.csv');
            res.send('\uFEFF' + csv);

        } catch (error) {
            console.error('Erro ao exportar clientes:', error);
            res.status(500).json({ error: 'Erro ao exportar' });
        }
    });

    // GET /api/relatorios/acordos-csv - Exportar acordos para CSV
    router.get('/acordos-csv', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    a.id,
                    cl.nome as cliente,
                    cr.nome as credor,
                    a.valor_original,
                    a.desconto,
                    a.valor_total,
                    a.num_parcelas,
                    a.valor_parcela,
                    a.data_primeiro_vencimento,
                    a.status,
                    a.created_at
                FROM acordos a
                JOIN clientes cl ON a.cliente_id = cl.id
                LEFT JOIN credores cr ON a.credor_id = cr.id
                ORDER BY a.created_at DESC
            `);

            const headers = ['ID', 'Cliente', 'Credor', 'Valor Original', 'Desconto', 'Valor Total', 'Parcelas', 'Valor Parcela', 'Primeiro Vencimento', 'Status', 'Data Acordo'];
            
            let csv = headers.join(';') + '\n';
            
            result.rows.forEach(row => {
                csv += [
                    row.id,
                    `"${row.cliente || ''}"`,
                    `"${row.credor || ''}"`,
                    row.valor_original ? row.valor_original.toString().replace('.', ',') : '0',
                    row.desconto ? row.desconto.toString().replace('.', ',') : '0',
                    row.valor_total ? row.valor_total.toString().replace('.', ',') : '0',
                    row.num_parcelas || 0,
                    row.valor_parcela ? row.valor_parcela.toString().replace('.', ',') : '0',
                    row.data_primeiro_vencimento ? new Date(row.data_primeiro_vencimento).toLocaleDateString('pt-BR') : '',
                    row.status || '',
                    row.created_at ? new Date(row.created_at).toLocaleDateString('pt-BR') : ''
                ].join(';') + '\n';
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=acordos.csv');
            res.send('\uFEFF' + csv);

        } catch (error) {
            console.error('Erro ao exportar acordos:', error);
            res.status(500).json({ error: 'Erro ao exportar' });
        }
    });

    // GET /api/relatorios/financeiro - Relatório financeiro
    router.get('/financeiro', auth, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesAtual = mes || new Date().getMonth() + 1;
            const anoAtual = ano || new Date().getFullYear();

            // Recebimentos do mês
            const recebimentos = await pool.query(`
                SELECT 
                    SUM(valor) as total,
                    COUNT(*) as quantidade
                FROM cobrancas
                WHERE status = 'pago'
                  AND EXTRACT(MONTH FROM data_pagamento) = $1
                  AND EXTRACT(YEAR FROM data_pagamento) = $2
            `, [mesAtual, anoAtual]);

            // Parcelas recebidas
            const parcelasRecebidas = await pool.query(`
                SELECT 
                    SUM(valor) as total,
                    COUNT(*) as quantidade
                FROM parcelas
                WHERE status = 'pago'
                  AND EXTRACT(MONTH FROM data_pagamento) = $1
                  AND EXTRACT(YEAR FROM data_pagamento) = $2
            `, [mesAtual, anoAtual]);

            // Comissões do mês
            const comissoes = await pool.query(`
                SELECT 
                    SUM(valor_comissao) as total,
                    COUNT(*) as quantidade
                FROM comissoes
                WHERE EXTRACT(MONTH FROM created_at) = $1
                  AND EXTRACT(YEAR FROM created_at) = $2
            `, [mesAtual, anoAtual]);

            // Por credor
            const porCredor = await pool.query(`
                SELECT 
                    cr.nome as credor,
                    SUM(c.valor) as total_recebido,
                    COUNT(*) as quantidade
                FROM cobrancas c
                JOIN credores cr ON c.credor_id = cr.id
                WHERE c.status = 'pago'
                  AND EXTRACT(MONTH FROM c.data_pagamento) = $1
                  AND EXTRACT(YEAR FROM c.data_pagamento) = $2
                GROUP BY cr.id, cr.nome
                ORDER BY total_recebido DESC
            `, [mesAtual, anoAtual]);

            res.json({
                periodo: { mes: mesAtual, ano: anoAtual },
                recebimentos: {
                    cobrancas: recebimentos.rows[0],
                    parcelas: parcelasRecebidas.rows[0],
                    comissoes: comissoes.rows[0]
                },
                por_credor: porCredor.rows
            });

        } catch (error) {
            console.error('Erro ao gerar relatório financeiro:', error);
            res.status(500).json({ error: 'Erro ao gerar relatório' });
        }
    });

    // GET /api/relatorios/inadimplencia - Relatório de inadimplência
    router.get('/inadimplencia', auth, async (req, res) => {
        try {
            // Total de dívidas por faixa de atraso
            const faixas = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE data_vencimento >= CURRENT_DATE) as em_dia,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE 
                                     AND data_vencimento >= CURRENT_DATE - INTERVAL '30 days') as atraso_30,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE - INTERVAL '30 days'
                                     AND data_vencimento >= CURRENT_DATE - INTERVAL '60 days') as atraso_60,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE - INTERVAL '60 days'
                                     AND data_vencimento >= CURRENT_DATE - INTERVAL '90 days') as atraso_90,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE - INTERVAL '90 days') as atraso_mais_90,
                    SUM(valor) FILTER (WHERE data_vencimento >= CURRENT_DATE) as valor_em_dia,
                    SUM(valor) FILTER (WHERE data_vencimento < CURRENT_DATE) as valor_atrasado
                FROM cobrancas
                WHERE status = 'pendente'
            `);

            // Top devedores
            const topDevedores = await pool.query(`
                SELECT 
                    cl.nome,
                    cl.cpf_cnpj,
                    COUNT(c.id) as total_dividas,
                    SUM(c.valor) as valor_total,
                    MIN(c.data_vencimento) as divida_mais_antiga
                FROM clientes cl
                JOIN cobrancas c ON cl.id = c.cliente_id
                WHERE c.status = 'pendente'
                GROUP BY cl.id, cl.nome, cl.cpf_cnpj
                ORDER BY valor_total DESC
                LIMIT 20
            `);

            res.json({
                faixas_atraso: faixas.rows[0],
                top_devedores: topDevedores.rows
            });

        } catch (error) {
            console.error('Erro ao gerar relatório de inadimplência:', error);
            res.status(500).json({ error: 'Erro ao gerar relatório' });
        }
    });

    // GET /api/relatorios/produtividade - Relatório de produtividade
    router.get('/produtividade', auth, async (req, res) => {
        try {
            const { data_inicio, data_fim } = req.query;
            
            const inicio = data_inicio || new Date(new Date().setDate(1)).toISOString().split('T')[0];
            const fim = data_fim || new Date().toISOString().split('T')[0];

            // Acordos fechados no período
            const acordos = await pool.query(`
                SELECT 
                    COUNT(*) as total,
                    SUM(valor_total) as valor_total,
                    AVG(desconto) as desconto_medio
                FROM acordos
                WHERE created_at BETWEEN $1 AND $2
            `, [inicio, fim]);

            // Cobranças pagas no período
            const cobrancas = await pool.query(`
                SELECT 
                    COUNT(*) as total,
                    SUM(valor) as valor_total
                FROM cobrancas
                WHERE status = 'pago'
                  AND data_pagamento BETWEEN $1 AND $2
            `, [inicio, fim]);

            // Contatos realizados
            const contatos = await pool.query(`
                SELECT 
                    COUNT(*) as total
                FROM historico
                WHERE acao IN ('WHATSAPP_CONTATO', 'EMAIL_ENVIADO', 'LIGACAO')
                  AND created_at BETWEEN $1 AND $2
            `, [inicio, fim]);

            res.json({
                periodo: { inicio, fim },
                acordos: acordos.rows[0],
                cobrancas_pagas: cobrancas.rows[0],
                contatos: contatos.rows[0]
            });

        } catch (error) {
            console.error('Erro ao gerar relatório de produtividade:', error);
            res.status(500).json({ error: 'Erro ao gerar relatório' });
        }
    });

    return router;
};
