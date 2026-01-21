/**
 * ROTAS DE EMAIL - ACERTIVE
 * Envio de emails de cobrança
 */

const express = require('express');
const nodemailer = require('nodemailer');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // Configuração do transporter (será pego das configurações do banco)
    async function getTransporter() {
        const config = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
        const cfg = config.rows[0] || {};
        
        return nodemailer.createTransport({
            host: cfg.smtp_host || 'smtp.gmail.com',
            port: cfg.smtp_port || 587,
            secure: false,
            auth: {
                user: cfg.smtp_user || process.env.EMAIL_USER,
                pass: cfg.smtp_pass || process.env.EMAIL_PASS
            }
        });
    }

    // POST /api/email/enviar-cobranca/:id - Enviar email de cobrança
    router.post('/enviar-cobranca/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            
            // Buscar cobrança com dados do cliente
            const result = await pool.query(`
                SELECT c.*, 
                       cl.nome as cliente_nome, 
                       cl.email as cliente_email,
                       cr.nome as credor_nome
                FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Cobrança não encontrada' });
            }

            const cobranca = result.rows[0];

            if (!cobranca.cliente_email) {
                return res.status(400).json({ error: 'Cliente não possui email cadastrado' });
            }

            const transporter = await getTransporter();

            const valor = parseFloat(cobranca.valor).toLocaleString('pt-BR', {
                style: 'currency',
                currency: 'BRL'
            });

            const vencimento = new Date(cobranca.data_vencimento).toLocaleDateString('pt-BR');

            // Email HTML
            const htmlContent = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: #1e3a5f; color: white; padding: 20px; text-align: center;">
                        <h1 style="margin: 0;">ACERTIVE</h1>
                        <p style="margin: 5px 0 0 0;">Sistema de Cobranças</p>
                    </div>
                    
                    <div style="padding: 20px; background: #f9f9f9;">
                        <p>Prezado(a) <strong>${cobranca.cliente_nome}</strong>,</p>
                        
                        <p>Informamos que existe uma pendência financeira em seu nome:</p>
                        
                        <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
                            <table style="width: 100%;">
                                <tr>
                                    <td><strong>Credor:</strong></td>
                                    <td>${cobranca.credor_nome || 'Não informado'}</td>
                                </tr>
                                <tr>
                                    <td><strong>Descrição:</strong></td>
                                    <td>${cobranca.descricao}</td>
                                </tr>
                                <tr>
                                    <td><strong>Valor:</strong></td>
                                    <td style="color: #e74c3c; font-weight: bold;">${valor}</td>
                                </tr>
                                <tr>
                                    <td><strong>Vencimento:</strong></td>
                                    <td>${vencimento}</td>
                                </tr>
                            </table>
                        </div>
                        
                        <p>Por favor, entre em contato conosco para regularizar sua situação.</p>
                        
                        <p style="margin-top: 30px; font-size: 12px; color: #666;">
                            Este é um email automático. Por favor, não responda.
                        </p>
                    </div>
                </div>
            `;

            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: cobranca.cliente_email,
                subject: `Cobrança - ${cobranca.descricao}`,
                html: htmlContent
            });

            // Registrar envio
            await pool.query(`
                UPDATE cobrancas 
                SET ultimo_contato = NOW(),
                    observacoes = COALESCE(observacoes, '') || E'\n[' || NOW() || '] Email enviado'
                WHERE id = $1
            `, [id]);

            await registrarLog(req.user?.id, 'EMAIL_ENVIADO', 'cobrancas', id, {
                destinatario: cobranca.cliente_email
            });

            res.json({ success: true, message: 'Email enviado com sucesso' });

        } catch (error) {
            console.error('Erro ao enviar email:', error);
            res.status(500).json({ error: 'Erro ao enviar email: ' + error.message });
        }
    });

    // POST /api/email/teste - Enviar email de teste
    router.post('/teste', auth, async (req, res) => {
        try {
            const { destinatario } = req.body;
            
            if (!destinatario) {
                return res.status(400).json({ error: 'Destinatário é obrigatório' });
            }

            const transporter = await getTransporter();

            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: destinatario,
                subject: 'Teste ACERTIVE',
                html: '<h1>Teste de Email</h1><p>Se você recebeu este email, a configuração está correta!</p>'
            });

            res.json({ success: true, message: 'Email de teste enviado' });

        } catch (error) {
            console.error('Erro ao enviar email de teste:', error);
            res.status(500).json({ error: 'Erro ao enviar email: ' + error.message });
        }
    });

    return router;
};
