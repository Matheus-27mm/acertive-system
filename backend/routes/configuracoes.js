/**
 * ROTAS DE CONFIGURAÇÕES - ACERTIVE
 * Configurações gerais do sistema
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/configuracoes - Buscar configurações
    router.get('/', auth, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
            
            if (result.rows.length === 0) {
                // Criar configuração padrão
                const nova = await pool.query(`
                    INSERT INTO configuracoes (id, created_at) VALUES (1, NOW())
                    RETURNING *
                `);
                return res.json(nova.rows[0]);
            }
            
            // Remover dados sensíveis antes de enviar
            const config = result.rows[0];
            delete config.smtp_pass;
            delete config.asaas_api_key;
            
            res.json(config);
        } catch (error) {
            console.error('Erro ao buscar configurações:', error);
            res.status(500).json({ error: 'Erro ao buscar configurações' });
        }
    });

    // PUT /api/configuracoes - Atualizar configurações
    router.put('/', auth, async (req, res) => {
        try {
            const {
                // Email
                smtp_host,
                smtp_port,
                smtp_user,
                smtp_pass,
                email_remetente,
                
                // Asaas
                asaas_api_key,
                asaas_ambiente, // 'sandbox' ou 'producao'
                
                // Gerais
                nome_empresa,
                percentual_comissao_padrao,
                dias_aviso_vencimento,
                
                // IA
                openai_api_key,
                ia_ativa
            } = req.body;

            // Verificar se existe configuração
            const existe = await pool.query('SELECT id FROM configuracoes WHERE id = 1');
            
            if (existe.rows.length === 0) {
                await pool.query('INSERT INTO configuracoes (id) VALUES (1)');
            }

            // Montar update dinâmico
            const updates = [];
            const params = [];
            let paramIndex = 1;

            const campos = {
                smtp_host, smtp_port, smtp_user, smtp_pass, email_remetente,
                asaas_api_key, asaas_ambiente,
                nome_empresa, percentual_comissao_padrao, dias_aviso_vencimento,
                openai_api_key, ia_ativa
            };

            for (const [campo, valor] of Object.entries(campos)) {
                if (valor !== undefined) {
                    updates.push(`${campo} = $${paramIndex}`);
                    params.push(valor);
                    paramIndex++;
                }
            }

            if (updates.length > 0) {
                updates.push('updated_at = NOW()');
                
                await pool.query(`
                    UPDATE configuracoes SET ${updates.join(', ')} WHERE id = 1
                `);
            }

            await registrarLog(req.user?.id, 'CONFIGURACOES_ATUALIZADAS', 'configuracoes', 1, {
                campos: Object.keys(campos).filter(k => campos[k] !== undefined)
            });

            // Retornar configurações atualizadas (sem dados sensíveis)
            const result = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
            const config = result.rows[0];
            delete config.smtp_pass;
            delete config.asaas_api_key;
            delete config.openai_api_key;
            
            res.json(config);

        } catch (error) {
            console.error('Erro ao atualizar configurações:', error);
            res.status(500).json({ error: 'Erro ao atualizar configurações' });
        }
    });

    // GET /api/configuracoes/ia-status - Verificar status da IA
    router.get('/ia-status', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT ia_ativa, openai_api_key IS NOT NULL as tem_chave
                FROM configuracoes WHERE id = 1
            `);

            if (result.rows.length === 0) {
                return res.json({ ativa: false, configurada: false });
            }

            res.json({
                ativa: result.rows[0].ia_ativa || false,
                configurada: result.rows[0].tem_chave || false
            });
        } catch (error) {
            console.error('Erro ao verificar status IA:', error);
            res.status(500).json({ error: 'Erro ao verificar status' });
        }
    });

    // POST /api/configuracoes/testar-email - Testar configuração de email
    router.post('/testar-email', auth, async (req, res) => {
        try {
            const { destinatario } = req.body;

            if (!destinatario) {
                return res.status(400).json({ error: 'Destinatário é obrigatório' });
            }

            // Buscar configurações
            const config = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
            
            if (config.rows.length === 0 || !config.rows[0].smtp_host) {
                return res.status(400).json({ error: 'SMTP não configurado' });
            }

            const cfg = config.rows[0];

            // Tentar enviar email de teste
            const nodemailer = require('nodemailer');
            
            const transporter = nodemailer.createTransport({
                host: cfg.smtp_host,
                port: cfg.smtp_port || 587,
                secure: false,
                auth: {
                    user: cfg.smtp_user,
                    pass: cfg.smtp_pass
                }
            });

            await transporter.sendMail({
                from: cfg.email_remetente || cfg.smtp_user,
                to: destinatario,
                subject: 'Teste ACERTIVE - Configuração de Email',
                html: '<h1>Teste de Email</h1><p>Se você recebeu este email, a configuração está correta!</p>'
            });

            res.json({ success: true, message: 'Email de teste enviado com sucesso' });

        } catch (error) {
            console.error('Erro ao testar email:', error);
            res.status(500).json({ error: 'Erro ao enviar email: ' + error.message });
        }
    });

    // POST /api/configuracoes/testar-asaas - Testar conexão com Asaas
    router.post('/testar-asaas', auth, async (req, res) => {
        try {
            const config = await pool.query('SELECT asaas_api_key, asaas_ambiente FROM configuracoes WHERE id = 1');
            
            if (config.rows.length === 0 || !config.rows[0].asaas_api_key) {
                return res.status(400).json({ error: 'Chave API Asaas não configurada' });
            }

            const cfg = config.rows[0];
            const baseUrl = cfg.asaas_ambiente === 'producao' 
                ? 'https://www.asaas.com/api/v3'
                : 'https://sandbox.asaas.com/api/v3';

            const response = await fetch(`${baseUrl}/finance/balance`, {
                headers: {
                    'access_token': cfg.asaas_api_key
                }
            });

            const data = await response.json();

            if (response.ok) {
                res.json({ 
                    success: true, 
                    message: 'Conexão com Asaas OK',
                    saldo: data.balance
                });
            } else {
                res.status(400).json({ 
                    error: 'Erro na conexão com Asaas', 
                    details: data 
                });
            }

        } catch (error) {
            console.error('Erro ao testar Asaas:', error);
            res.status(500).json({ error: 'Erro ao testar conexão: ' + error.message });
        }
    });

    return router;
};
