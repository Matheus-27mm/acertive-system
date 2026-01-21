/**
 * ROTAS DE PDF - ACERTIVE
 * Geração de PDFs de cobranças, acordos e relatórios
 */

const express = require('express');
const PDFDocument = require('pdfkit');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // Função auxiliar para formatar moeda
    const formatarMoeda = (valor) => {
        return parseFloat(valor || 0).toLocaleString('pt-BR', {
            style: 'currency',
            currency: 'BRL'
        });
    };

    // Função auxiliar para formatar data
    const formatarData = (data) => {
        if (!data) return 'Não informada';
        return new Date(data).toLocaleDateString('pt-BR');
    };

    // GET /api/pdf/cobranca/:id - PDF de cobrança individual
    router.get('/cobranca/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT c.*, 
                       cl.nome as cliente_nome, 
                       cl.cpf_cnpj as cliente_documento,
                       cl.telefone as cliente_telefone,
                       cl.email as cliente_email,
                       cl.endereco as cliente_endereco,
                       cr.nome as credor_nome,
                       cr.cnpj as credor_cnpj
                FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Cobrança não encontrada' });
            }

            const cobranca = result.rows[0];

            // Criar PDF
            const doc = new PDFDocument({ margin: 50 });

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=cobranca_${id}.pdf`);

            doc.pipe(res);

            // Cabeçalho
            doc.fontSize(20).fillColor('#1e3a5f').text('ACERTIVE', { align: 'center' });
            doc.fontSize(12).fillColor('#666').text('Sistema de Cobranças', { align: 'center' });
            doc.moveDown(2);

            // Título
            doc.fontSize(16).fillColor('#000').text('NOTIFICAÇÃO DE COBRANÇA', { align: 'center' });
            doc.moveDown();

            // Linha divisória
            doc.strokeColor('#1e3a5f').lineWidth(2)
               .moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            doc.moveDown();

            // Dados do Devedor
            doc.fontSize(14).fillColor('#1e3a5f').text('DADOS DO DEVEDOR');
            doc.fontSize(11).fillColor('#000');
            doc.text(`Nome: ${cobranca.cliente_nome}`);
            doc.text(`Documento: ${cobranca.cliente_documento || 'Não informado'}`);
            doc.text(`Telefone: ${cobranca.cliente_telefone || 'Não informado'}`);
            doc.text(`Email: ${cobranca.cliente_email || 'Não informado'}`);
            if (cobranca.cliente_endereco) {
                doc.text(`Endereço: ${cobranca.cliente_endereco}`);
            }
            doc.moveDown();

            // Dados do Credor
            if (cobranca.credor_nome) {
                doc.fontSize(14).fillColor('#1e3a5f').text('DADOS DO CREDOR');
                doc.fontSize(11).fillColor('#000');
                doc.text(`Nome: ${cobranca.credor_nome}`);
                if (cobranca.credor_cnpj) {
                    doc.text(`CNPJ: ${cobranca.credor_cnpj}`);
                }
                doc.moveDown();
            }

            // Dados da Dívida
            doc.fontSize(14).fillColor('#1e3a5f').text('DADOS DA DÍVIDA');
            doc.fontSize(11).fillColor('#000');
            doc.text(`Descrição: ${cobranca.descricao}`);
            doc.text(`Valor Original: ${formatarMoeda(cobranca.valor)}`);
            doc.text(`Vencimento: ${formatarData(cobranca.data_vencimento)}`);
            doc.text(`Status: ${cobranca.status?.toUpperCase() || 'PENDENTE'}`);
            
            if (cobranca.numero_contrato) {
                doc.text(`Contrato: ${cobranca.numero_contrato}`);
            }
            doc.moveDown(2);

            // Aviso
            doc.fontSize(10).fillColor('#666')
               .text('Este documento é uma notificação de cobrança. Entre em contato conosco para regularizar sua situação.', {
                   align: 'center'
               });

            doc.moveDown(2);

            // Rodapé
            doc.fontSize(8).fillColor('#999')
               .text(`Documento gerado em ${new Date().toLocaleString('pt-BR')}`, { align: 'center' });

            doc.end();

            await registrarLog(req.user?.id, 'PDF_GERADO', 'cobrancas', id, {});

        } catch (error) {
            console.error('Erro ao gerar PDF:', error);
            res.status(500).json({ error: 'Erro ao gerar PDF' });
        }
    });

    // GET /api/pdf/acordo/:id - PDF de acordo
    router.get('/acordo/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT a.*, 
                       cl.nome as cliente_nome, 
                       cl.cpf_cnpj as cliente_documento,
                       cl.telefone as cliente_telefone,
                       cr.nome as credor_nome
                FROM acordos a
                JOIN clientes cl ON a.cliente_id = cl.id
                LEFT JOIN credores cr ON a.credor_id = cr.id
                WHERE a.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Acordo não encontrado' });
            }

            const acordo = result.rows[0];

            // Buscar parcelas
            const parcelas = await pool.query(`
                SELECT * FROM parcelas WHERE acordo_id = $1 ORDER BY numero
            `, [id]);

            const doc = new PDFDocument({ margin: 50 });

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=acordo_${id}.pdf`);

            doc.pipe(res);

            // Cabeçalho
            doc.fontSize(20).fillColor('#1e3a5f').text('ACERTIVE', { align: 'center' });
            doc.fontSize(12).fillColor('#666').text('Sistema de Cobranças', { align: 'center' });
            doc.moveDown(2);

            // Título
            doc.fontSize(16).fillColor('#000').text('TERMO DE ACORDO', { align: 'center' });
            doc.moveDown();

            doc.strokeColor('#1e3a5f').lineWidth(2)
               .moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            doc.moveDown();

            // Dados do Acordo
            doc.fontSize(14).fillColor('#1e3a5f').text('DADOS DO ACORDO');
            doc.fontSize(11).fillColor('#000');
            doc.text(`Devedor: ${acordo.cliente_nome}`);
            doc.text(`Documento: ${acordo.cliente_documento || 'Não informado'}`);
            doc.text(`Credor: ${acordo.credor_nome || 'Não informado'}`);
            doc.moveDown();

            doc.text(`Valor Original: ${formatarMoeda(acordo.valor_original)}`);
            doc.text(`Valor Acordado: ${formatarMoeda(acordo.valor_total)}`);
            doc.text(`Desconto: ${formatarMoeda(acordo.desconto || 0)}`);
            doc.text(`Número de Parcelas: ${acordo.num_parcelas}`);
            doc.text(`Valor da Parcela: ${formatarMoeda(acordo.valor_parcela)}`);
            doc.moveDown();

            // Tabela de parcelas
            if (parcelas.rows.length > 0) {
                doc.fontSize(14).fillColor('#1e3a5f').text('PARCELAS');
                doc.moveDown(0.5);

                doc.fontSize(10).fillColor('#000');
                
                // Cabeçalho da tabela
                doc.text('Nº', 50, doc.y, { width: 40 });
                doc.text('Vencimento', 90, doc.y - 12, { width: 100 });
                doc.text('Valor', 200, doc.y - 12, { width: 100 });
                doc.text('Status', 310, doc.y - 12, { width: 100 });
                doc.moveDown();

                parcelas.rows.forEach(p => {
                    doc.text(String(p.numero), 50, doc.y, { width: 40 });
                    doc.text(formatarData(p.data_vencimento), 90, doc.y - 12, { width: 100 });
                    doc.text(formatarMoeda(p.valor), 200, doc.y - 12, { width: 100 });
                    doc.text(p.status?.toUpperCase() || 'PENDENTE', 310, doc.y - 12, { width: 100 });
                    doc.moveDown(0.5);
                });
            }

            doc.moveDown(2);

            // Assinaturas
            doc.fontSize(10).fillColor('#000');
            doc.text('_________________________________', 50, doc.y);
            doc.text('Devedor', 50);
            doc.moveDown(2);
            doc.text('_________________________________', 50);
            doc.text('Credor/Representante', 50);

            doc.moveDown(2);
            doc.fontSize(8).fillColor('#999')
               .text(`Documento gerado em ${new Date().toLocaleString('pt-BR')}`, { align: 'center' });

            doc.end();

            await registrarLog(req.user?.id, 'PDF_ACORDO_GERADO', 'acordos', id, {});

        } catch (error) {
            console.error('Erro ao gerar PDF do acordo:', error);
            res.status(500).json({ error: 'Erro ao gerar PDF' });
        }
    });

    // GET /api/pdf/cliente/:id/dividas - PDF com todas as dívidas do cliente
    router.get('/cliente/:id/dividas', auth, async (req, res) => {
        try {
            const { id } = req.params;

            // Buscar cliente
            const clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
            
            if (clienteResult.rows.length === 0) {
                return res.status(404).json({ error: 'Cliente não encontrado' });
            }

            const cliente = clienteResult.rows[0];

            // Buscar cobranças
            const cobrancas = await pool.query(`
                SELECT c.*, cr.nome as credor_nome
                FROM cobrancas c
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.cliente_id = $1
                ORDER BY c.data_vencimento DESC
            `, [id]);

            const doc = new PDFDocument({ margin: 50 });

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=dividas_cliente_${id}.pdf`);

            doc.pipe(res);

            // Cabeçalho
            doc.fontSize(20).fillColor('#1e3a5f').text('ACERTIVE', { align: 'center' });
            doc.fontSize(12).fillColor('#666').text('Extrato de Dívidas', { align: 'center' });
            doc.moveDown(2);

            // Dados do Cliente
            doc.fontSize(14).fillColor('#1e3a5f').text('DADOS DO DEVEDOR');
            doc.fontSize(11).fillColor('#000');
            doc.text(`Nome: ${cliente.nome}`);
            doc.text(`Documento: ${cliente.cpf_cnpj || 'Não informado'}`);
            doc.text(`Telefone: ${cliente.telefone || 'Não informado'}`);
            doc.moveDown();

            // Resumo
            const totalDividas = cobrancas.rows.reduce((sum, c) => sum + parseFloat(c.valor || 0), 0);
            const pendentes = cobrancas.rows.filter(c => c.status === 'pendente').length;
            const pagas = cobrancas.rows.filter(c => c.status === 'pago').length;

            doc.fontSize(14).fillColor('#1e3a5f').text('RESUMO');
            doc.fontSize(11).fillColor('#000');
            doc.text(`Total de Dívidas: ${cobrancas.rows.length}`);
            doc.text(`Pendentes: ${pendentes}`);
            doc.text(`Pagas: ${pagas}`);
            doc.text(`Valor Total: ${formatarMoeda(totalDividas)}`);
            doc.moveDown();

            // Lista de dívidas
            if (cobrancas.rows.length > 0) {
                doc.fontSize(14).fillColor('#1e3a5f').text('DÍVIDAS');
                doc.moveDown(0.5);

                cobrancas.rows.forEach((c, index) => {
                    doc.fontSize(10).fillColor('#000');
                    doc.text(`${index + 1}. ${c.descricao}`);
                    doc.text(`   Credor: ${c.credor_nome || 'Não informado'} | Valor: ${formatarMoeda(c.valor)} | Venc: ${formatarData(c.data_vencimento)} | Status: ${c.status?.toUpperCase()}`);
                    doc.moveDown(0.5);
                });
            }

            doc.moveDown(2);
            doc.fontSize(8).fillColor('#999')
               .text(`Documento gerado em ${new Date().toLocaleString('pt-BR')}`, { align: 'center' });

            doc.end();

        } catch (error) {
            console.error('Erro ao gerar PDF de dívidas:', error);
            res.status(500).json({ error: 'Erro ao gerar PDF' });
        }
    });

    return router;
};
