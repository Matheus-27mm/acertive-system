/**
 * ========================================
 * ACERTIVE - Portal do Credor
 * routes/portal.js
 * ========================================
 * Login próprio, dashboard, exportações
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function(pool, registrarLog) {
    const router = express.Router();
    const JWT_SECRET = process.env.JWT_SECRET;

    // ── Middleware de auth do credor ─────────────────────────────
    const authCredor = async (req, res, next) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) return res.status(401).json({ error: 'Token não fornecido' });
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.tipo !== 'credor') return res.status(403).json({ error: 'Acesso negado' });
            const result = await pool.query(
                'SELECT id, nome, email, credor_id, primeiro_acesso FROM credores_usuarios WHERE id = $1 AND ativo = true',
                [decoded.id]
            );
            if (!result.rowCount) return res.status(401).json({ error: 'Usuário inválido' });
            req.credor_usuario = result.rows[0];
            next();
        } catch (e) {
            if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token inválido ou expirado' });
            }
            res.status(500).json({ error: 'Erro na autenticação' });
        }
    };

    // ── Garantir que tabela existe ───────────────────────────────
    async function garantirTabela() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS credores_usuarios (
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                credor_id UUID NOT NULL REFERENCES credores(id) ON DELETE CASCADE,
                nome VARCHAR(200) NOT NULL,
                email VARCHAR(200) NOT NULL UNIQUE,
                senha TEXT NOT NULL,
                primeiro_acesso BOOLEAN DEFAULT true,
                ativo BOOLEAN DEFAULT true,
                ultimo_login TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
    }
    garantirTabela().catch(e => console.error('[PORTAL] Erro criar tabela:', e.message));

    // ═══════════════════════════════════════════════════════════════
    // POST /api/portal/login
    // ═══════════════════════════════════════════════════════════════
    router.post('/login', async (req, res) => {
        try {
            const { email, senha } = req.body;
            if (!email || !senha) return res.status(400).json({ error: 'Email e senha obrigatórios' });

            const result = await pool.query(
                `SELECT cu.*, cr.nome as credor_nome
                 FROM credores_usuarios cu
                 JOIN credores cr ON cr.id = cu.credor_id
                 WHERE cu.email = $1 AND cu.ativo = true`,
                [email.toLowerCase().trim()]
            );

            const HASH_FALSO = '$2a$10$invalidhashtopreventtimingattacksXXXXXXXXXXXXXXXX';
            const hashParaComparar = result.rows[0]?.senha || HASH_FALSO;
            let senhaCorreta = false;
            try { senhaCorreta = await bcrypt.compare(senha, hashParaComparar); } catch (e) {}

            if (!result.rowCount || !senhaCorreta) {
                return res.status(401).json({ error: 'Email ou senha incorretos' });
            }

            const usuario = result.rows[0];
            const token = jwt.sign(
                { id: usuario.id, email: usuario.email, credor_id: usuario.credor_id, tipo: 'credor' },
                JWT_SECRET,
                { expiresIn: '8h' }
            );

            pool.query('UPDATE credores_usuarios SET ultimo_login = NOW() WHERE id = $1', [usuario.id]).catch(() => {});

            res.json({
                success: true,
                token,
                usuario: {
                    id: usuario.id,
                    nome: usuario.nome,
                    email: usuario.email,
                    credor_id: usuario.credor_id,
                    credor_nome: usuario.credor_nome,
                    primeiro_acesso: usuario.primeiro_acesso
                }
            });
        } catch (e) {
            console.error('[PORTAL] Erro login:', e.message);
            res.status(500).json({ error: 'Erro interno' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/portal/trocar-senha
    // ═══════════════════════════════════════════════════════════════
    router.post('/trocar-senha', authCredor, async (req, res) => {
        try {
            const { senha_atual, nova_senha } = req.body;
            if (!senha_atual || !nova_senha) return res.status(400).json({ error: 'Campos obrigatórios' });
            if (nova_senha.length < 6) return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });

            const result = await pool.query('SELECT senha FROM credores_usuarios WHERE id = $1', [req.credor_usuario.id]);
            const ok = await bcrypt.compare(senha_atual, result.rows[0].senha);
            if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });

            const hash = await bcrypt.hash(nova_senha, 10);
            await pool.query('UPDATE credores_usuarios SET senha = $1, primeiro_acesso = false WHERE id = $2', [hash, req.credor_usuario.id]);

            res.json({ success: true, message: 'Senha alterada com sucesso' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/portal/me
    // ═══════════════════════════════════════════════════════════════
    router.get('/me', authCredor, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT cu.id, cu.nome, cu.email, cu.primeiro_acesso, cr.nome as credor_nome, cr.id as credor_id
                 FROM credores_usuarios cu
                 JOIN credores cr ON cr.id = cu.credor_id
                 WHERE cu.id = $1`,
                [req.credor_usuario.id]
            );
            res.json({ success: true, usuario: result.rows[0] });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/portal/dashboard
    // ═══════════════════════════════════════════════════════════════
    router.get('/dashboard', authCredor, async (req, res) => {
        try {
            const credorId = req.credor_usuario.credor_id;

            const [kpisResult, agingResult, acordosResult, ultimasResult] = await Promise.all([
                pool.query(`
                    SELECT
                        COUNT(*)::int as total_cobrancas,
                        COUNT(CASE WHEN status IN ('pendente','vencido') THEN 1 END)::int as pendentes,
                        COUNT(CASE WHEN status = 'pago' THEN 1 END)::int as pagas,
                        COALESCE(SUM(CASE WHEN status IN ('pendente','vencido') THEN valor END),0) as valor_pendente,
                        COALESCE(SUM(CASE WHEN status = 'pago' THEN valor_pago END),0) as valor_recuperado,
                        COUNT(DISTINCT cliente_id)::int as total_devedores
                    FROM cobrancas WHERE credor_id = $1
                `, [credorId]),

                pool.query(`
                    SELECT
                        COUNT(CASE WHEN data_vencimento >= CURRENT_DATE THEN 1 END)::int as a_vencer,
                        COUNT(CASE WHEN data_vencimento < CURRENT_DATE AND data_vencimento >= CURRENT_DATE - 30 THEN 1 END)::int as ate_30,
                        COUNT(CASE WHEN data_vencimento < CURRENT_DATE - 30 AND data_vencimento >= CURRENT_DATE - 60 THEN 1 END)::int as ate_60,
                        COUNT(CASE WHEN data_vencimento < CURRENT_DATE - 60 THEN 1 END)::int as mais_60,
                        COALESCE(SUM(CASE WHEN data_vencimento >= CURRENT_DATE THEN valor END),0) as val_a_vencer,
                        COALESCE(SUM(CASE WHEN data_vencimento < CURRENT_DATE AND data_vencimento >= CURRENT_DATE - 30 THEN valor END),0) as val_30,
                        COALESCE(SUM(CASE WHEN data_vencimento < CURRENT_DATE - 30 AND data_vencimento >= CURRENT_DATE - 60 THEN valor END),0) as val_60,
                        COALESCE(SUM(CASE WHEN data_vencimento < CURRENT_DATE - 60 THEN valor END),0) as val_mais_60
                    FROM cobrancas WHERE credor_id = $1 AND status IN ('pendente','vencido')
                `, [credorId]),

                pool.query(`
                    SELECT
                        COUNT(*)::int as total,
                        COUNT(CASE WHEN status = 'ativo' THEN 1 END)::int as ativos,
                        COUNT(CASE WHEN status = 'quitado' THEN 1 END)::int as quitados,
                        COALESCE(SUM(valor_acordo),0) as valor_total
                    FROM acordos WHERE credor_id = $1
                `, [credorId]).catch(() => ({ rows: [{ total: 0, ativos: 0, quitados: 0, valor_total: 0 }] })),

                pool.query(`
                    SELECT c.nome as cliente, cob.valor, cob.data_vencimento, cob.status,
                    (CURRENT_DATE - cob.data_vencimento)::int as dias_atraso
                    FROM cobrancas cob
                    JOIN clientes c ON c.id = cob.cliente_id
                    WHERE cob.credor_id = $1 AND cob.status IN ('pendente','vencido')
                    ORDER BY cob.data_vencimento ASC LIMIT 8
                `, [credorId])
            ]);

            res.json({
                success: true,
                data: {
                    kpis: kpisResult.rows[0],
                    aging: agingResult.rows[0],
                    acordos: acordosResult.rows[0],
                    proximas_vencer: ultimasResult.rows
                }
            });
        } catch (e) {
            console.error('[PORTAL] Erro dashboard:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/portal/carteira — lista de cobranças paginada
    // ═══════════════════════════════════════════════════════════════
    router.get('/carteira', authCredor, async (req, res) => {
        try {
            const credorId = req.credor_usuario.credor_id;
            const { status, busca, page = 1, limit = 20 } = req.query;
            const offset = (parseInt(page) - 1) * parseInt(limit);

            let sql = `
                SELECT cob.id, cob.valor, cob.data_vencimento, cob.status, cob.data_pagamento, cob.valor_pago,
                       cob.descricao, c.nome as cliente, c.cpf_cnpj,
                       (CURRENT_DATE - cob.data_vencimento)::int as dias_atraso
                FROM cobrancas cob
                JOIN clientes c ON c.id = cob.cliente_id
                WHERE cob.credor_id = $1
            `;
            const params = [credorId];
            let idx = 2;

            if (status) { sql += ` AND cob.status = $${idx}`; params.push(status); idx++; }
            if (busca) { sql += ` AND (LOWER(c.nome) LIKE $${idx} OR c.cpf_cnpj LIKE $${idx})`; params.push(`%${busca.toLowerCase()}%`); idx++; }

            // Total
            const countResult = await pool.query(sql.replace('SELECT cob.id, cob.valor, cob.data_vencimento, cob.status, cob.data_pagamento, cob.valor_pago,\n                       cob.descricao, c.nome as cliente, c.cpf_cnpj,\n                       (CURRENT_DATE - cob.data_vencimento)::int as dias_atraso', 'SELECT COUNT(*)::int as total'), params);

            sql += ` ORDER BY cob.data_vencimento DESC LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), offset);

            const result = await pool.query(sql, params);

            res.json({
                success: true,
                data: result.rows,
                total: countResult.rows[0]?.total || 0,
                page: parseInt(page),
                limit: parseInt(limit)
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/portal/acordos
    // ═══════════════════════════════════════════════════════════════
    router.get('/acordos', authCredor, async (req, res) => {
        try {
            const credorId = req.credor_usuario.credor_id;
            const result = await pool.query(`
                SELECT a.id, a.valor_original, a.valor_acordo, a.numero_parcelas,
                       a.valor_parcela, a.status, a.created_at,
                       c.nome as cliente, c.cpf_cnpj,
                       (SELECT COUNT(*) FROM parcelas_acordo pa WHERE pa.acordo_id = a.id AND pa.status = 'pago')::int as parcelas_pagas,
                       (SELECT COALESCE(SUM(valor),0) FROM parcelas_acordo pa WHERE pa.acordo_id = a.id AND pa.status = 'pago') as total_pago
                FROM acordos a
                JOIN clientes c ON c.id = a.cliente_id
                WHERE a.credor_id = $1
                ORDER BY a.created_at DESC
                LIMIT 100
            `, [credorId]);

            res.json({ success: true, data: result.rows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/portal/export/excel — exportar carteira Excel
    // ═══════════════════════════════════════════════════════════════
    router.get('/export/excel', authCredor, async (req, res) => {
        try {
            const ExcelJS = require('exceljs');
            const credorId = req.credor_usuario.credor_id;
            const { status } = req.query;

            let sql = `
                SELECT c.nome as cliente, c.cpf_cnpj, cob.descricao, cob.valor,
                       cob.data_vencimento, cob.status, cob.data_pagamento, cob.valor_pago,
                       (CURRENT_DATE - cob.data_vencimento)::int as dias_atraso
                FROM cobrancas cob
                JOIN clientes c ON c.id = cob.cliente_id
                WHERE cob.credor_id = $1
            `;
            const params = [credorId];
            if (status) { sql += ' AND cob.status = $2'; params.push(status); }
            sql += ' ORDER BY cob.data_vencimento DESC';

            const result = await pool.query(sql, params);

            // Buscar nome do credor
            const credorResult = await pool.query('SELECT nome FROM credores WHERE id = $1', [credorId]);
            const credorNome = credorResult.rows[0]?.nome || 'Credor';

            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Carteira');

            ws.mergeCells('A1:I1');
            ws.getCell('A1').value = `ACERTIVE — Extrato de Carteira: ${credorNome}`;
            ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFC9A84C' } };
            ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
            ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
            ws.getRow(1).height = 32;

            ws.mergeCells('A2:I2');
            ws.getCell('A2').value = `Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${result.rowCount} registros`;
            ws.getCell('A2').font = { size: 9, color: { argb: 'FF888888' } };
            ws.getCell('A2').alignment = { horizontal: 'center' };

            ws.columns = [
                { key: 'cliente', width: 30 }, { key: 'cpf', width: 16 }, { key: 'desc', width: 28 },
                { key: 'valor', width: 14 }, { key: 'venc', width: 14 }, { key: 'atraso', width: 12 },
                { key: 'status', width: 12 }, { key: 'dt_pag', width: 14 }, { key: 'val_pago', width: 14 }
            ];

            const hr = ws.addRow(['Cliente', 'CPF/CNPJ', 'Descrição', 'Valor', 'Vencimento', 'Dias Atraso', 'Status', 'Dt. Pagamento', 'Valor Pago']);
            hr.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
            });
            hr.height = 24;

            const statusColors = { pago: 'FF3ECF8E', vencido: 'FFE05C5C', pendente: 'FFE0943E' };

            result.rows.forEach((row, i) => {
                const fmtData = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('pt-BR') : '-';
                const dr = ws.addRow([
                    row.cliente, row.cpf_cnpj, row.descricao,
                    parseFloat(row.valor) || 0,
                    fmtData(row.data_vencimento),
                    row.dias_atraso > 0 ? row.dias_atraso : 0,
                    row.status,
                    fmtData(row.data_pagamento),
                    parseFloat(row.valor_pago) || 0
                ]);

                dr.eachCell(cell => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFFAFAFA' : 'FFFFFFFF' } };
                });
                dr.getCell(4).numFmt = '"R$"#,##0.00';
                dr.getCell(9).numFmt = '"R$"#,##0.00';
                if (statusColors[row.status]) {
                    dr.getCell(7).font = { bold: true, color: { argb: statusColors[row.status] } };
                }
            });

            ws.autoFilter = { from: 'A3', to: 'I3' };

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=carteira_${credorNome.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`);
            await wb.xlsx.write(res);
            res.end();
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/portal/export/pdf — exportar extrato PDF
    // ═══════════════════════════════════════════════════════════════
    router.get('/export/pdf', authCredor, async (req, res) => {
        try {
            const PDFDocument = require('pdfkit');
            const credorId = req.credor_usuario.credor_id;

            const [credorResult, kpisResult, cobResult] = await Promise.all([
                pool.query('SELECT * FROM credores WHERE id = $1', [credorId]),
                pool.query(`
                    SELECT
                        COUNT(CASE WHEN status IN ('pendente','vencido') THEN 1 END)::int as pendentes,
                        COUNT(CASE WHEN status = 'pago' THEN 1 END)::int as pagas,
                        COALESCE(SUM(CASE WHEN status IN ('pendente','vencido') THEN valor END),0) as valor_pendente,
                        COALESCE(SUM(CASE WHEN status = 'pago' THEN valor_pago END),0) as valor_recuperado
                    FROM cobrancas WHERE credor_id = $1
                `, [credorId]),
                pool.query(`
                    SELECT c.nome as cliente, c.cpf_cnpj, cob.valor, cob.data_vencimento, cob.status,
                    (CURRENT_DATE - cob.data_vencimento)::int as dias_atraso
                    FROM cobrancas cob
                    JOIN clientes c ON c.id = cob.cliente_id
                    WHERE cob.credor_id = $1
                    ORDER BY cob.status, cob.data_vencimento DESC LIMIT 50
                `, [credorId])
            ]);

            const credor = credorResult.rows[0];
            const kpis = kpisResult.rows[0];
            const cobrancas = cobResult.rows;

            const fmtMoeda = v => (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const fmtData = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('pt-BR') : '-';

            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=extrato_${credor.nome.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`);
            doc.pipe(res);

            // Cabeçalho
            doc.rect(0, 0, doc.page.width, 80).fill('#1A1A2E');
            doc.fillColor('#C9A84C').font('Helvetica-Bold').fontSize(22).text('ACERTIVE', 50, 18);
            doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13).text(`Extrato de Carteira — ${credor.nome}`, 50, 44);
            doc.fillColor('#9CA3AF').font('Helvetica').fontSize(9).text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`, 50, 65);

            doc.y = 100;

            // KPIs
            const kW = (doc.page.width - 100) / 4;
            [
                { label: 'Cobranças Pendentes', value: kpis.pendentes.toString(), color: '#E05C5C' },
                { label: 'Cobranças Pagas', value: kpis.pagas.toString(), color: '#3ECF8E' },
                { label: 'Valor Pendente', value: fmtMoeda(kpis.valor_pendente), color: '#E05C5C' },
                { label: 'Valor Recuperado', value: fmtMoeda(kpis.valor_recuperado), color: '#3ECF8E' }
            ].forEach((k, i) => {
                const x = 50 + i * kW;
                doc.rect(x, doc.y, kW - 8, 55).fill('#F8F9FA').stroke('#E0E0E0');
                doc.fillColor(k.color).font('Helvetica-Bold').fontSize(15).text(k.value, x + 4, doc.y + 8, { width: kW - 16, align: 'center' });
                doc.fillColor('#666').font('Helvetica').fontSize(8).text(k.label, x + 4, doc.y + 34, { width: kW - 16, align: 'center' });
            });
            doc.y += 75;

            // Tabela
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

            const sCores = { pago: '#3ECF8E', vencido: '#E05C5C', pendente: '#E0943E' };

            cobrancas.forEach((cob, i) => {
                const bg = i % 2 === 0 ? '#FAFAFA' : '#FFFFFF';
                doc.rect(50, doc.y, doc.page.width - 100, 20).fill(bg);
                doc.fillColor('#333').font('Helvetica').fontSize(8);
                doc.text((cob.cliente || '').slice(0, 22), 60, doc.y + 5, { width: 130 });
                doc.text(cob.cpf_cnpj || '-', 200, doc.y + 5, { width: 100 });
                doc.text(fmtMoeda(cob.valor), 310, doc.y + 5, { width: 65 });
                doc.text(fmtData(cob.data_vencimento), 380, doc.y + 5, { width: 70 });
                doc.fillColor(sCores[cob.status] || '#666').font('Helvetica-Bold').fontSize(8);
                doc.text((cob.status || '').toUpperCase(), 460, doc.y + 5);
                doc.y += 20;
                if (doc.y > doc.page.height - 80) { doc.addPage(); doc.y = 50; }
            });

            if (cobrancas.length >= 50) {
                doc.fillColor('#999').font('Helvetica').fontSize(9).text('* Exibindo os primeiros 50 registros. Use o relatório Excel para a lista completa.', 50, doc.y + 5);
            }

            // Rodapé
            doc.y = doc.page.height - 55;
            doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#C9A84C').lineWidth(0.5).stroke();
            doc.y += 8;
            doc.fillColor('#999').font('Helvetica').fontSize(8).text('ACERTIVE — Documento confidencial gerado para uso exclusivo do credor.', 50, doc.y, { align: 'center', width: doc.page.width - 100 });

            doc.end();
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // ADMIN: criar usuário do credor (só operadores internos)
    // ═══════════════════════════════════════════════════════════════
    router.post('/admin/criar-usuario', async (req, res) => {
        try {
            // Verificar token interno
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) return res.status(401).json({ error: 'Token não fornecido' });
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.tipo === 'credor') return res.status(403).json({ error: 'Sem permissão' });

            const { credor_id, nome, email } = req.body;
            if (!credor_id || !nome || !email) return res.status(400).json({ error: 'credor_id, nome e email obrigatórios' });

            // Verificar se credor existe
            const credorResult = await pool.query('SELECT id, nome FROM credores WHERE id = $1', [credor_id]);
            if (!credorResult.rowCount) return res.status(404).json({ error: 'Credor não encontrado' });

            // Gerar senha automática
            const senhaGerada = Math.random().toString(36).slice(-8).toUpperCase() + Math.floor(Math.random() * 100);
            const hash = await bcrypt.hash(senhaGerada, 10);

            // Verificar se já existe
            const existente = await pool.query('SELECT id FROM credores_usuarios WHERE email = $1', [email.toLowerCase().trim()]);
            if (existente.rowCount) return res.status(409).json({ error: 'Email já cadastrado' });

            await pool.query(
                'INSERT INTO credores_usuarios (credor_id, nome, email, senha, primeiro_acesso) VALUES ($1, $2, $3, $4, true)',
                [credor_id, nome, email.toLowerCase().trim(), hash]
            );

            res.json({
                success: true,
                message: 'Usuário criado',
                credenciais: {
                    email: email.toLowerCase().trim(),
                    senha_temporaria: senhaGerada,
                    url_acesso: '/portal.html',
                    observacao: 'O credor deve trocar a senha no primeiro acesso'
                }
            });
        } catch (e) {
            console.error('[PORTAL] Erro criar usuário:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ADMIN: listar usuários do portal
    router.get('/admin/usuarios', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) return res.status(401).json({ error: 'Não autorizado' });
            jwt.verify(token, JWT_SECRET);

            const result = await pool.query(`
                SELECT cu.id, cu.nome, cu.email, cu.ativo, cu.ultimo_login, cu.primeiro_acesso, cu.created_at,
                       cr.nome as credor_nome, cr.id as credor_id
                FROM credores_usuarios cu
                JOIN credores cr ON cr.id = cu.credor_id
                ORDER BY cu.created_at DESC
            `);
            res.json({ success: true, data: result.rows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ADMIN: resetar senha
    router.post('/admin/resetar-senha/:id', async (req, res) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) return res.status(401).json({ error: 'Não autorizado' });
            jwt.verify(token, JWT_SECRET);

            const novaSenha = Math.random().toString(36).slice(-8).toUpperCase() + Math.floor(Math.random() * 100);
            const hash = await bcrypt.hash(novaSenha, 10);
            await pool.query('UPDATE credores_usuarios SET senha = $1, primeiro_acesso = true WHERE id = $2', [hash, req.params.id]);

            res.json({ success: true, nova_senha: novaSenha });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};