/**
 * ========================================
 * ACERTIVE - Módulo de Relatórios
 * routes/relatorios.js
 * ========================================
 * Exportação de relatórios em PDF e Excel
 */

const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

module.exports = function(pool, auth) {
    const router = express.Router();

    function fmtMoeda(v) { return (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    function fmtData(d) { if (!d) return '-'; return new Date(d + 'T12:00:00').toLocaleDateString('pt-BR'); }
    function fmtDataHora(d) { if (!d) return '-'; return new Date(d).toLocaleString('pt-BR'); }

    // Cores padrão
    const CORES = {
        primaria: '1A1A2E',
        gold: 'C9A84C',
        goldClaro: 'F0D98A',
        verde: '3ECF8E',
        vermelho: 'E05C5C',
        cinzaClaro: 'F5F5F5',
        cinzaMedio: 'E0E0E0',
        texto: '333333',
        branco: 'FFFFFF'
    };

    // ═══════════════════════════════════════════════════════════════
    // EXCEL: CARTEIRA COMPLETA
    // ═══════════════════════════════════════════════════════════════
    router.get('/excel/carteira', auth, async (req, res) => {
        try {
            const { credor_id, status, data_inicio, data_fim } = req.query;

            let sql = `
                SELECT
                    c.nome as cliente, c.cpf_cnpj, c.telefone,
                    cob.descricao, cob.valor, cob.data_vencimento, cob.status,
                    cob.data_pagamento, cob.valor_pago,
                    cr.nome as credor,
                    CASE WHEN cob.data_vencimento < CURRENT_DATE AND cob.status NOT IN ('pago','cancelado')
                         THEN (CURRENT_DATE - cob.data_vencimento)::int ELSE 0 END as dias_atraso
                FROM cobrancas cob
                JOIN clientes c ON c.id = cob.cliente_id
                LEFT JOIN credores cr ON cr.id = cob.credor_id
                WHERE 1=1
            `;
            const params = [];
            let idx = 1;
            if (credor_id) { sql += ` AND cob.credor_id = $${idx}`; params.push(credor_id); idx++; }
            if (status) { sql += ` AND cob.status = $${idx}`; params.push(status); idx++; }
            if (data_inicio) { sql += ` AND cob.data_vencimento >= $${idx}`; params.push(data_inicio); idx++; }
            if (data_fim) { sql += ` AND cob.data_vencimento <= $${idx}`; params.push(data_fim); idx++; }
            sql += ' ORDER BY cob.data_vencimento DESC';

            const result = await pool.query(sql, params);

            const wb = new ExcelJS.Workbook();
            wb.creator = 'ACERTIVE';
            wb.created = new Date();

            const ws = wb.addWorksheet('Carteira', { pageSetup: { orientation: 'landscape' } });

            // Cabeçalho visual
            ws.mergeCells('A1:K1');
            ws.getCell('A1').value = 'ACERTIVE - Relatório de Carteira';
            ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF' + CORES.gold } };
            ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + CORES.primaria } };
            ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
            ws.getRow(1).height = 36;

            ws.mergeCells('A2:K2');
            ws.getCell('A2').value = `Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${result.rowCount} registros`;
            ws.getCell('A2').font = { size: 10, color: { argb: 'FF666666' } };
            ws.getCell('A2').alignment = { horizontal: 'center' };
            ws.getRow(2).height = 20;

            // Colunas
            ws.columns = [
                { key: 'cliente', width: 30 },
                { key: 'cpf_cnpj', width: 18 },
                { key: 'telefone', width: 16 },
                { key: 'credor', width: 22 },
                { key: 'descricao', width: 28 },
                { key: 'valor', width: 14 },
                { key: 'data_vencimento', width: 16 },
                { key: 'dias_atraso', width: 14 },
                { key: 'status', width: 14 },
                { key: 'data_pagamento', width: 16 },
                { key: 'valor_pago', width: 14 }
            ];

            // Header row
            const headerRow = ws.addRow(['Cliente', 'CPF/CNPJ', 'Telefone', 'Credor', 'Descrição', 'Valor', 'Vencimento', 'Dias Atraso', 'Status', 'Dt. Pagamento', 'Valor Pago']);
            headerRow.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FF' + CORES.branco }, size: 11 };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + CORES.primaria } };
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
                cell.border = { bottom: { style: 'thin', color: { argb: 'FF' + CORES.gold } } };
            });
            headerRow.height = 28;

            const statusColors = {
                'pago': 'FF' + CORES.verde,
                'vencido': 'FF' + CORES.vermelho,
                'pendente': 'FFFFBB00',
                'acordo': 'FF5C8EE0',
                'cancelado': 'FF999999'
            };

            // Dados
            result.rows.forEach((row, i) => {
                const dr = ws.addRow([
                    row.cliente, row.cpf_cnpj, row.telefone, row.credor,
                    row.descricao, parseFloat(row.valor) || 0,
                    row.data_vencimento ? fmtData(row.data_vencimento) : '-',
                    row.dias_atraso || 0,
                    row.status,
                    row.data_pagamento ? fmtData(row.data_pagamento) : '-',
                    parseFloat(row.valor_pago) || 0
                ]);

                // Fundo alternado
                const bg = i % 2 === 0 ? 'FFFAFAFA' : 'FFFFFFFF';
                dr.eachCell(cell => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
                    cell.alignment = { vertical: 'middle' };
                });

                // Formatar moeda
                dr.getCell(6).numFmt = '"R$"#,##0.00';
                dr.getCell(11).numFmt = '"R$"#,##0.00';

                // Cor status
                const statusCell = dr.getCell(9);
                if (statusColors[row.status]) {
                    statusCell.font = { bold: true, color: { argb: statusColors[row.status] } };
                }

                // Destacar atraso
                if (row.dias_atraso > 0) {
                    dr.getCell(8).font = { bold: true, color: { argb: 'FF' + CORES.vermelho } };
                }
            });

            // Linha de totais
            const totalRow = ws.addRow(['TOTAL', '', '', '', '', { formula: `SUM(F4:F${result.rowCount + 3})` }, '', '', '', '', { formula: `SUM(K4:K${result.rowCount + 3})` }]);
            totalRow.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FF' + CORES.branco } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + CORES.primaria } };
            });
            totalRow.getCell(6).numFmt = '"R$"#,##0.00';
            totalRow.getCell(11).numFmt = '"R$"#,##0.00';

            // Filtro automático
            ws.autoFilter = { from: 'A3', to: 'K3' };

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=carteira_${new Date().toISOString().split('T')[0]}.xlsx`);
            await wb.xlsx.write(res);
            res.end();

        } catch (error) {
            console.error('[RELATORIO] Erro excel carteira:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // EXCEL: ACORDOS
    // ═══════════════════════════════════════════════════════════════
    router.get('/excel/acordos', auth, async (req, res) => {
        try {
            const { status, data_inicio, data_fim } = req.query;

            let sql = `
                SELECT
                    c.nome as cliente, c.cpf_cnpj, c.telefone,
                    cr.nome as credor,
                    a.valor_original, a.valor_acordo, a.desconto_percentual,
                    a.numero_parcelas, a.valor_parcela,
                    a.status, a.created_at,
                    (SELECT COUNT(*) FROM parcelas_acordo pa WHERE pa.acordo_id = a.id AND pa.status = 'pago') as parcelas_pagas,
                    (SELECT COALESCE(SUM(pa.valor),0) FROM parcelas_acordo pa WHERE pa.acordo_id = a.id AND pa.status = 'pago') as total_pago
                FROM acordos a
                JOIN clientes c ON c.id = a.cliente_id
                LEFT JOIN credores cr ON cr.id = a.credor_id
                WHERE 1=1
            `;
            const params = [];
            let idx = 1;
            if (status) { sql += ` AND a.status = $${idx}`; params.push(status); idx++; }
            if (data_inicio) { sql += ` AND DATE(a.created_at) >= $${idx}`; params.push(data_inicio); idx++; }
            if (data_fim) { sql += ` AND DATE(a.created_at) <= $${idx}`; params.push(data_fim); idx++; }
            sql += ' ORDER BY a.created_at DESC';

            const result = await pool.query(sql, params);

            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Acordos');

            ws.mergeCells('A1:L1');
            ws.getCell('A1').value = 'ACERTIVE - Relatório de Acordos';
            ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF' + CORES.gold } };
            ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + CORES.primaria } };
            ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
            ws.getRow(1).height = 36;

            ws.columns = [
                { key: 'cliente', width: 30 }, { key: 'cpf', width: 18 }, { key: 'telefone', width: 16 },
                { key: 'credor', width: 22 }, { key: 'valor_original', width: 15 }, { key: 'valor_acordo', width: 15 },
                { key: 'desconto', width: 12 }, { key: 'parcelas', width: 10 }, { key: 'valor_parcela', width: 15 },
                { key: 'pagas', width: 10 }, { key: 'total_pago', width: 15 }, { key: 'status', width: 12 }
            ];

            const hr = ws.addRow(['Cliente', 'CPF/CNPJ', 'Telefone', 'Credor', 'Val. Original', 'Val. Acordo', 'Desconto %', 'Parcelas', 'Val. Parcela', 'Pagas', 'Total Pago', 'Status']);
            hr.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + CORES.primaria } };
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
            });
            hr.height = 28;

            result.rows.forEach((row, i) => {
                const dr = ws.addRow([
                    row.cliente, row.cpf_cnpj, row.telefone, row.credor,
                    parseFloat(row.valor_original) || 0, parseFloat(row.valor_acordo) || 0,
                    parseFloat(row.desconto_percentual) || 0,
                    row.numero_parcelas, parseFloat(row.valor_parcela) || 0,
                    row.parcelas_pagas, parseFloat(row.total_pago) || 0, row.status
                ]);

                const bg = i % 2 === 0 ? 'FFFAFAFA' : 'FFFFFFFF';
                dr.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }; });
                [5, 6, 9, 11].forEach(col => { dr.getCell(col).numFmt = '"R$"#,##0.00'; });
                dr.getCell(7).numFmt = '0.0"%"';
            });

            ws.autoFilter = { from: 'A2', to: 'L2' };

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=acordos_${new Date().toISOString().split('T')[0]}.xlsx`);
            await wb.xlsx.write(res);
            res.end();

        } catch (error) {
            console.error('[RELATORIO] Erro excel acordos:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PDF: RELATÓRIO GERENCIAL
    // ═══════════════════════════════════════════════════════════════
    router.get('/pdf/gerencial', auth, async (req, res) => {
        try {
            const { periodo = '30' } = req.query;
            const dias = parseInt(periodo) || 30;

            // Buscar dados
            const [kpisResult, credoresResult, acordosResult, operacaoResult] = await Promise.all([
                pool.query(`
                    SELECT
                        COUNT(*)::int as total_cobrancas,
                        COUNT(CASE WHEN status IN ('pendente','vencido') THEN 1 END)::int as pendentes,
                        COUNT(CASE WHEN status = 'pago' THEN 1 END)::int as pagas,
                        COALESCE(SUM(CASE WHEN status IN ('pendente','vencido') THEN valor END),0) as valor_pendente,
                        COALESCE(SUM(CASE WHEN status = 'pago' AND data_pagamento >= CURRENT_DATE - $1 THEN valor_pago END),0) as recuperado_periodo
                    FROM cobrancas
                `, [dias]),
                pool.query(`
                    SELECT cr.nome, COUNT(cob.id)::int as qtd, COALESCE(SUM(cob.valor),0) as valor
                    FROM credores cr
                    LEFT JOIN cobrancas cob ON cob.credor_id = cr.id AND cob.status IN ('pendente','vencido')
                    WHERE cr.status = 'ativo'
                    GROUP BY cr.id, cr.nome
                    ORDER BY valor DESC LIMIT 10
                `),
                pool.query(`
                    SELECT COUNT(*)::int as total, COUNT(CASE WHEN status='ativo' THEN 1 END)::int as ativos,
                    COUNT(CASE WHEN status='quitado' THEN 1 END)::int as quitados,
                    COALESCE(SUM(valor_acordo),0) as valor_total
                    FROM acordos WHERE created_at >= CURRENT_DATE - $1
                `, [dias]),
                pool.query(`
                    SELECT COUNT(*)::int as contatos,
                    COUNT(CASE WHEN resultado='gerou_acordo' THEN 1 END)::int as acordos_gerados,
                    COUNT(CASE WHEN resultado='atendeu' THEN 1 END)::int as atenderam
                    FROM registros_operacao WHERE data_contato >= CURRENT_DATE - $1
                `, [dias]).catch(() => ({ rows: [{ contatos: 0, acordos_gerados: 0, atenderam: 0 }] }))
            ]);

            const kpis = kpisResult.rows[0];
            const credores = credoresResult.rows;
            const acordos = acordosResult.rows[0];
            const operacao = operacaoResult.rows[0];

            // Gerar PDF
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=relatorio_gerencial_${new Date().toISOString().split('T')[0]}.pdf`);
            doc.pipe(res);

            // ── Cabeçalho ──
            doc.rect(0, 0, doc.page.width, 80).fill('#1A1A2E');
            doc.fillColor('#C9A84C').font('Helvetica-Bold').fontSize(24).text('ACERTIVE', 50, 20);
            doc.fillColor('#9CA3AF').font('Helvetica').fontSize(11).text('Sistema de Cobrança — Relatório Gerencial', 50, 50);
            doc.fillColor('#6B7280').fontSize(10).text(`Período: últimos ${dias} dias | Gerado em: ${new Date().toLocaleString('pt-BR')}`, 50, 65);

            doc.y = 100;

            // ── Linha dourada ──
            doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#C9A84C').lineWidth(1).stroke();
            doc.y += 16;

            // ── KPIs ──
            doc.fillColor('#1A1A2E').font('Helvetica-Bold').fontSize(14).text('Resumo da Carteira', 50, doc.y);
            doc.y += 20;

            const kpiData = [
                { label: 'Total Pendente', value: fmtMoeda(kpis.valor_pendente), color: '#E05C5C' },
                { label: `Recuperado (${dias}d)`, value: fmtMoeda(kpis.recuperado_periodo), color: '#3ECF8E' },
                { label: 'Cobranças Vencidas', value: kpis.pendentes.toString(), color: '#E0943E' },
                { label: 'Cobranças Pagas', value: kpis.pagas.toString(), color: '#3ECF8E' }
            ];

            const kpiW = (doc.page.width - 100) / 4;
            kpiData.forEach((k, i) => {
                const x = 50 + i * kpiW;
                doc.rect(x, doc.y, kpiW - 10, 60).fill('#F8F9FA').stroke('#E0E0E0');
                doc.fillColor(k.color).font('Helvetica-Bold').fontSize(18).text(k.value, x + 5, doc.y + 8, { width: kpiW - 20, align: 'center' });
                doc.fillColor('#666666').font('Helvetica').fontSize(9).text(k.label, x + 5, doc.y + 38, { width: kpiW - 20, align: 'center' });
            });
            doc.y += 80;

            // ── Acordos ──
            doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#E0E0E0').lineWidth(0.5).stroke();
            doc.y += 16;
            doc.fillColor('#1A1A2E').font('Helvetica-Bold').fontSize(14).text(`Acordos — últimos ${dias} dias`, 50, doc.y);
            doc.y += 16;

            const acordoData = [
                { label: 'Total gerados', value: acordos.total.toString() },
                { label: 'Ativos', value: acordos.ativos.toString() },
                { label: 'Quitados', value: acordos.quitados.toString() },
                { label: 'Valor total', value: fmtMoeda(acordos.valor_total) }
            ];

            acordoData.forEach((a, i) => {
                const x = 50 + i * kpiW;
                doc.rect(x, doc.y, kpiW - 10, 50).fill('#F0F9FF').stroke('#BFD7F0');
                doc.fillColor('#1A1A2E').font('Helvetica-Bold').fontSize(16).text(a.value, x + 5, doc.y + 6, { width: kpiW - 20, align: 'center' });
                doc.fillColor('#666666').font('Helvetica').fontSize(9).text(a.label, x + 5, doc.y + 30, { width: kpiW - 20, align: 'center' });
            });
            doc.y += 70;

            // ── Operação ──
            doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#E0E0E0').lineWidth(0.5).stroke();
            doc.y += 16;
            doc.fillColor('#1A1A2E').font('Helvetica-Bold').fontSize(14).text(`Operação — últimos ${dias} dias`, 50, doc.y);
            doc.y += 16;

            const taxaAtend = operacao.contatos > 0 ? ((operacao.atenderam / operacao.contatos) * 100).toFixed(1) : '0';
            const taxaConv = operacao.atenderam > 0 ? ((operacao.acordos_gerados / operacao.atenderam) * 100).toFixed(1) : '0';

            const opData = [
                { label: 'Total Contatos', value: operacao.contatos.toString() },
                { label: 'Atendimentos', value: operacao.atenderam.toString() },
                { label: 'Taxa Atendimento', value: taxaAtend + '%' },
                { label: 'Taxa Conversão', value: taxaConv + '%' }
            ];

            opData.forEach((o, i) => {
                const x = 50 + i * kpiW;
                doc.rect(x, doc.y, kpiW - 10, 50).fill('#F0FFF4').stroke('#BBF7D0');
                doc.fillColor('#1A1A2E').font('Helvetica-Bold').fontSize(16).text(o.value, x + 5, doc.y + 6, { width: kpiW - 20, align: 'center' });
                doc.fillColor('#666666').font('Helvetica').fontSize(9).text(o.label, x + 5, doc.y + 30, { width: kpiW - 20, align: 'center' });
            });
            doc.y += 70;

            // ── Por Credor ──
            if (credores.length > 0) {
                doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#E0E0E0').lineWidth(0.5).stroke();
                doc.y += 16;
                doc.fillColor('#1A1A2E').font('Helvetica-Bold').fontSize(14).text('Carteira por Credor', 50, doc.y);
                doc.y += 16;

                // Tabela header
                doc.rect(50, doc.y, doc.page.width - 100, 24).fill('#1A1A2E');
                doc.fillColor('#C9A84C').font('Helvetica-Bold').fontSize(10);
                doc.text('Credor', 60, doc.y + 7);
                doc.text('Cobranças', 280, doc.y + 7);
                doc.text('Valor Pendente', 380, doc.y + 7);
                doc.y += 24;

                credores.forEach((cr, i) => {
                    const bg = i % 2 === 0 ? '#FAFAFA' : '#FFFFFF';
                    doc.rect(50, doc.y, doc.page.width - 100, 22).fill(bg);
                    doc.fillColor('#333333').font('Helvetica').fontSize(10);
                    doc.text(cr.nome || '-', 60, doc.y + 6, { width: 200 });
                    doc.text(cr.qtd.toString(), 280, doc.y + 6);
                    doc.text(fmtMoeda(cr.valor), 380, doc.y + 6);
                    doc.y += 22;
                });
            }

            // ── Rodapé ──
            doc.y = doc.page.height - 60;
            doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#C9A84C').lineWidth(0.5).stroke();
            doc.y += 8;
            doc.fillColor('#999999').font('Helvetica').fontSize(8)
                .text('ACERTIVE — Documento gerado automaticamente. Uso interno e confidencial.', 50, doc.y, { align: 'center', width: doc.page.width - 100 });

            doc.end();

        } catch (error) {
            console.error('[RELATORIO] Erro pdf gerencial:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PDF: EXTRATO DO CREDOR
    // ═══════════════════════════════════════════════════════════════
    router.get('/pdf/credor/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const [credorResult, cobResult, acordosResult] = await Promise.all([
                pool.query('SELECT * FROM credores WHERE id = $1', [id]),
                pool.query(`
                    SELECT cob.*, c.nome as cliente, c.cpf_cnpj,
                    (CURRENT_DATE - cob.data_vencimento)::int as dias_atraso
                    FROM cobrancas cob
                    JOIN clientes c ON c.id = cob.cliente_id
                    WHERE cob.credor_id = $1
                    ORDER BY cob.status, cob.data_vencimento DESC
                    LIMIT 100
                `, [id]),
                pool.query(`
                    SELECT COUNT(*)::int as total, COUNT(CASE WHEN status='quitado' THEN 1 END)::int as quitados,
                    COALESCE(SUM(valor_acordo),0) as valor_total
                    FROM acordos WHERE credor_id = $1
                `, [id])
            ]);

            if (!credorResult.rowCount) return res.status(404).json({ error: 'Credor não encontrado' });

            const credor = credorResult.rows[0];
            const cobrancas = cobResult.rows;
            const acordos = acordosResult.rows[0];

            const pendentes = cobrancas.filter(c => ['pendente', 'vencido'].includes(c.status));
            const pagas = cobrancas.filter(c => c.status === 'pago');
            const valorPendente = pendentes.reduce((s, c) => s + parseFloat(c.valor), 0);
            const valorRecuperado = pagas.reduce((s, c) => s + parseFloat(c.valor_pago || c.valor), 0);

            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=extrato_${credor.nome.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`);
            doc.pipe(res);

            // Cabeçalho
            doc.rect(0, 0, doc.page.width, 80).fill('#1A1A2E');
            doc.fillColor('#C9A84C').font('Helvetica-Bold').fontSize(22).text('ACERTIVE', 50, 18);
            doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(14).text(`Extrato — ${credor.nome}`, 50, 45);
            doc.fillColor('#9CA3AF').font('Helvetica').fontSize(9).text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`, 50, 65);

            doc.y = 100;

            // Resumo
            doc.fillColor('#1A1A2E').font('Helvetica-Bold').fontSize(13).text('Resumo', 50, doc.y);
            doc.y += 14;

            const kpiW = (doc.page.width - 100) / 3;
            [
                { label: 'Valor Pendente', value: fmtMoeda(valorPendente), color: '#E05C5C' },
                { label: 'Valor Recuperado', value: fmtMoeda(valorRecuperado), color: '#3ECF8E' },
                { label: 'Acordos Firmados', value: acordos.total.toString(), color: '#5C8EE0' }
            ].forEach((k, i) => {
                const x = 50 + i * kpiW;
                doc.rect(x, doc.y, kpiW - 10, 55).fill('#F8F9FA').stroke('#E0E0E0');
                doc.fillColor(k.color).font('Helvetica-Bold').fontSize(16).text(k.value, x + 5, doc.y + 8, { width: kpiW - 20, align: 'center' });
                doc.fillColor('#666').font('Helvetica').fontSize(9).text(k.label, x + 5, doc.y + 34, { width: kpiW - 20, align: 'center' });
            });
            doc.y += 75;

            // Tabela de cobranças
            doc.fillColor('#1A1A2E').font('Helvetica-Bold').fontSize(13).text('Cobranças', 50, doc.y);
            doc.y += 14;

            doc.rect(50, doc.y, doc.page.width - 100, 22).fill('#1A1A2E');
            doc.fillColor('#C9A84C').font('Helvetica-Bold').fontSize(9);
            doc.text('Cliente', 60, doc.y + 7);
            doc.text('CPF/CNPJ', 200, doc.y + 7);
            doc.text('Valor', 310, doc.y + 7);
            doc.text('Vencimento', 380, doc.y + 7);
            doc.text('Status', 460, doc.y + 7);
            doc.y += 22;

            cobrancas.slice(0, 40).forEach((cob, i) => {
                const bg = i % 2 === 0 ? '#FAFAFA' : '#FFFFFF';
                doc.rect(50, doc.y, doc.page.width - 100, 20).fill(bg);
                doc.fillColor('#333').font('Helvetica').fontSize(8);
                doc.text((cob.cliente || '').slice(0, 22), 60, doc.y + 5, { width: 130 });
                doc.text(cob.cpf_cnpj || '-', 200, doc.y + 5, { width: 100 });
                doc.text(fmtMoeda(cob.valor), 310, doc.y + 5, { width: 65 });
                doc.text(fmtData(cob.data_vencimento), 380, doc.y + 5, { width: 70 });

                const statusColors2 = { pago: '#3ECF8E', vencido: '#E05C5C', pendente: '#E0943E', acordo: '#5C8EE0' };
                doc.fillColor(statusColors2[cob.status] || '#666').font('Helvetica-Bold').fontSize(8);
                doc.text((cob.status || '').toUpperCase(), 460, doc.y + 5, { width: 60 });
                doc.y += 20;

                if (doc.y > doc.page.height - 80) { doc.addPage(); doc.y = 50; }
            });

            if (cobrancas.length > 40) {
                doc.fillColor('#999').font('Helvetica').fontSize(9)
                    .text(`... e mais ${cobrancas.length - 40} registros`, 50, doc.y + 5);
            }

            doc.end();

        } catch (error) {
            console.error('[RELATORIO] Erro pdf credor:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // EXCEL: OPERAÇÃO (KPIs operacionais)
    // ═══════════════════════════════════════════════════════════════
    router.get('/excel/operacao', auth, async (req, res) => {
        try {
            const { data_inicio, data_fim, operador_id } = req.query;

            let sql = `
                SELECT r.data_contato, r.resultado, r.canal, r.observacao,
                       c.nome as cliente, c.cpf_cnpj,
                       u.nome as operador
                FROM registros_operacao r
                LEFT JOIN clientes c ON c.id = r.cliente_id
                LEFT JOIN usuarios u ON u.id = r.operador_id
                WHERE 1=1
            `;
            const params = [];
            let idx = 1;
            if (data_inicio) { sql += ` AND r.data_contato >= $${idx}`; params.push(data_inicio); idx++; }
            if (data_fim) { sql += ` AND r.data_contato <= $${idx}`; params.push(data_fim); idx++; }
            if (operador_id) { sql += ` AND r.operador_id = $${idx}`; params.push(operador_id); idx++; }
            sql += ' ORDER BY r.data_contato DESC, r.created_at DESC';

            const result = await pool.query(sql, params);

            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Operação');

            ws.mergeCells('A1:G1');
            ws.getCell('A1').value = 'ACERTIVE - Relatório de Operação';
            ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF' + CORES.gold } };
            ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + CORES.primaria } };
            ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
            ws.getRow(1).height = 36;

            ws.columns = [
                { key: 'data', width: 14 }, { key: 'operador', width: 22 }, { key: 'cliente', width: 30 },
                { key: 'cpf', width: 18 }, { key: 'resultado', width: 20 }, { key: 'canal', width: 14 }, { key: 'obs', width: 40 }
            ];

            const hr = ws.addRow(['Data', 'Operador', 'Cliente', 'CPF/CNPJ', 'Resultado', 'Canal', 'Observação']);
            hr.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + CORES.primaria } };
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
            });
            hr.height = 26;

            const labels = { atendeu: 'Atendeu', nao_atendeu: 'Não atendeu', gerou_acordo: 'Gerou acordo', retorno_agendado: 'Retorno agendado', recusou: 'Recusou', numero_errado: 'Número errado' };

            result.rows.forEach((row, i) => {
                const dr = ws.addRow([
                    row.data_contato ? fmtData(row.data_contato) : '-',
                    row.operador || '-', row.cliente || '-', row.cpf_cnpj || '-',
                    labels[row.resultado] || row.resultado, row.canal || '-', row.observacao || ''
                ]);
                const bg = i % 2 === 0 ? 'FFFAFAFA' : 'FFFFFFFF';
                dr.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }; });
            });

            ws.autoFilter = { from: 'A2', to: 'G2' };

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=operacao_${new Date().toISOString().split('T')[0]}.xlsx`);
            await wb.xlsx.write(res);
            res.end();

        } catch (error) {
            console.error('[RELATORIO] Erro excel operacao:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    return router;
};