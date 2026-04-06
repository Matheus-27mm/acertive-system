/**
 * ========================================
 * ACERTIVE - Templates de Disparo
 * routes/templates-disparo.js
 * ========================================
 * CRUD de templates com variáveis dinâmicas
 * Variáveis suportadas:
 *   {{nome}}        → primeiro nome do devedor
 *   {{nome_completo}} → nome completo
 *   {{valor}}       → valor atualizado formatado
 *   {{valor_original}} → valor original
 *   {{vencimento}}  → data do vencimento mais próximo
 *   {{dias_atraso}} → dias em atraso
 *   {{credor}}      → nome do credor
 *   {{cpf}}         → CPF/CNPJ mascarado
 */

const express = require('express');

module.exports = function(pool, auth) {
    const router = express.Router();

    // Templates padrão do sistema (não editáveis, mas copiáveis)
    const TEMPLATES_PADRAO = [
        {
            id: 'padrao_lembrete',
            nome: 'Lembrete Padrão',
            categoria: 'cobranca',
            mensagem:
                `📋 *ACERTIVE - Assessoria e Cobrança*\n\n` +
                `Olá *{{nome}}*, tudo bem?\n\n` +
                `Identificamos uma pendência financeira em seu nome no valor de *{{valor}}*` +
                ` referente a *{{credor}}*.\n\n` +
                `Responda esta mensagem e um de nossos atendentes entrará em contato para negociar. 💬\n\n` +
                `🕐 _Atendimento: Segunda a Quinta, 8h às 17h30._`,
            variaveis: ['nome', 'valor', 'credor']
        },
        {
            id: 'padrao_urgente',
            nome: 'Urgente — Muitos dias em atraso',
            categoria: 'cobranca',
            mensagem:
                `⚠️ *AVISO IMPORTANTE - ACERTIVE*\n\n` +
                `*{{nome_completo}}*, sua dívida está há *{{dias_atraso}} dias* em atraso.\n\n` +
                `💰 Valor atualizado: *{{valor}}*\n` +
                `🏢 Credor: {{credor}}\n\n` +
                `Entre em contato *HOJE* para evitar medidas administrativas.\n\n` +
                `Responda esta mensagem. 👇`,
            variaveis: ['nome_completo', 'dias_atraso', 'valor', 'credor']
        },
        {
            id: 'padrao_acordo',
            nome: 'Oferta de Acordo',
            categoria: 'negociacao',
            mensagem:
                `🤝 *PROPOSTA DE ACORDO - ACERTIVE*\n\n` +
                `Olá *{{nome}}*!\n\n` +
                `Temos uma proposta especial para regularizar sua dívida de *{{valor}}* com {{credor}}.\n\n` +
                `📞 Entre em contato agora e descubra as condições.\n\n` +
                `_Oportunidade por tempo limitado._`,
            variaveis: ['nome', 'valor', 'credor']
        },
        {
            id: 'padrao_parcela',
            nome: 'Lembrete de Parcela',
            categoria: 'parcela',
            mensagem:
                `📅 *LEMBRETE DE PARCELA - ACERTIVE*\n\n` +
                `Olá *{{nome}}*! Sua parcela vence em breve.\n\n` +
                `💰 Valor: *{{valor}}*\n` +
                `📆 Vencimento: *{{vencimento}}*\n\n` +
                `Pague em dia e evite juros! 🙏\n\n` +
                `_Dúvidas? Responda esta mensagem._`,
            variaveis: ['nome', 'valor', 'vencimento']
        }
    ];

    function fmtMoeda(v) { return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    function fmtData(d) { if (!d) return '-'; return new Date(d + 'T12:00:00').toLocaleDateString('pt-BR'); }

    // ── Processar variáveis no template ─────────────────────────
    function processarTemplate(mensagem, dados) {
        return mensagem
            .replace(/\{\{nome\}\}/g, (dados.nome || 'Cliente').split(' ')[0])
            .replace(/\{\{nome_completo\}\}/g, dados.nome || 'Cliente')
            .replace(/\{\{valor\}\}/g, fmtMoeda(dados.valor_atualizado || dados.valor || 0))
            .replace(/\{\{valor_original\}\}/g, fmtMoeda(dados.valor_original || 0))
            .replace(/\{\{vencimento\}\}/g, dados.data_vencimento ? fmtData(dados.data_vencimento) : '-')
            .replace(/\{\{dias_atraso\}\}/g, (dados.dias_atraso || 0).toString())
            .replace(/\{\{credor\}\}/g, dados.credor_nome || 'Credor')
            .replace(/\{\{cpf\}\}/g, dados.cpf_cnpj ? dados.cpf_cnpj.replace(/(\d{3})\d{3}(\d{3})(\d{2})/, '$1.***.$2-$3') : '');
    }

    // ═══════════════════════════════════════════════════════════════
    // GET /api/templates/list — listar templates
    // ═══════════════════════════════════════════════════════════════
    router.get('/list', auth, async (req, res) => {
        try {
            const customResult = await pool.query(
                'SELECT * FROM templates_mensagem ORDER BY created_at DESC'
            ).catch(() => ({ rows: [] }));

            res.json({
                success: true,
                padrao: TEMPLATES_PADRAO,
                custom: customResult.rows
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/templates — criar template customizado
    // ═══════════════════════════════════════════════════════════════
    router.post('/', auth, async (req, res) => {
        try {
            const { nome, categoria, mensagem } = req.body;
            if (!nome || !mensagem) return res.status(400).json({ success: false, error: 'Nome e mensagem são obrigatórios' });

            // Detectar variáveis usadas automaticamente
            const variaveis = [];
            const matches = mensagem.match(/\{\{(\w+)\}\}/g) || [];
            matches.forEach(m => {
                const v = m.replace('{{', '').replace('}}', '');
                if (!variaveis.includes(v)) variaveis.push(v);
            });

            const result = await pool.query(
                'INSERT INTO templates_mensagem (nome, categoria, mensagem, variaveis, criado_por, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
                [nome, categoria || 'cobranca', mensagem, JSON.stringify(variaveis), req.user?.id]
            ).catch(async () => {
                // Se a tabela não existe, cria e tenta de novo
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS templates_mensagem (
                        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                        nome VARCHAR(200) NOT NULL,
                        categoria VARCHAR(50) DEFAULT 'cobranca',
                        mensagem TEXT NOT NULL,
                        variaveis JSONB DEFAULT '[]',
                        criado_por UUID,
                        ativo BOOLEAN DEFAULT true,
                        created_at TIMESTAMP DEFAULT NOW()
                    )
                `);
                return pool.query(
                    'INSERT INTO templates_mensagem (nome, categoria, mensagem, variaveis, criado_por, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
                    [nome, categoria || 'cobranca', mensagem, JSON.stringify(variaveis), req.user?.id]
                );
            });

            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/templates/:id
    // ═══════════════════════════════════════════════════════════════
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { nome, mensagem, categoria } = req.body;

            const variaveis = [];
            const matches = (mensagem || '').match(/\{\{(\w+)\}\}/g) || [];
            matches.forEach(m => {
                const v = m.replace('{{', '').replace('}}', '');
                if (!variaveis.includes(v)) variaveis.push(v);
            });

            const result = await pool.query(
                'UPDATE templates_mensagem SET nome = $1, mensagem = $2, categoria = $3, variaveis = $4 WHERE id = $5 RETURNING *',
                [nome, mensagem, categoria, JSON.stringify(variaveis), id]
            );

            if (!result.rowCount) return res.status(404).json({ success: false, error: 'Template não encontrado' });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DELETE /api/templates/:id
    // ═══════════════════════════════════════════════════════════════
    router.delete('/:id', auth, async (req, res) => {
        try {
            await pool.query('DELETE FROM templates_mensagem WHERE id = $1', [req.params.id]);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/templates/preview — preview com dados reais do cliente
    // ═══════════════════════════════════════════════════════════════
    router.post('/preview', auth, async (req, res) => {
        try {
            const { mensagem, cliente_id } = req.body;
            if (!mensagem) return res.status(400).json({ success: false, error: 'Mensagem obrigatória' });

            let dados = {
                nome: 'João Silva',
                valor_atualizado: 1500.00,
                valor_original: 1200.00,
                dias_atraso: 45,
                credor_nome: 'Transbyshop',
                data_vencimento: new Date().toISOString().split('T')[0],
                cpf_cnpj: '123.456.789-00'
            };

            if (cliente_id) {
                const r = await pool.query(
                    `SELECT c.*, cr.nome as credor_nome,
                     SUM(cob.valor) as valor_total,
                     MAX(CURRENT_DATE - cob.data_vencimento) as dias_atraso,
                     MIN(cob.data_vencimento) as proxima_vencimento
                     FROM clientes c
                     LEFT JOIN cobrancas cob ON cob.cliente_id = c.id AND cob.status IN ('pendente','vencido')
                     LEFT JOIN credores cr ON cr.id = cob.credor_id
                     WHERE c.id = $1 GROUP BY c.id, cr.nome LIMIT 1`,
                    [cliente_id]
                );
                if (r.rowCount > 0) {
                    dados = {
                        nome: r.rows[0].nome,
                        valor_atualizado: parseFloat(r.rows[0].valor_total) || 0,
                        valor_original: parseFloat(r.rows[0].valor_total) || 0,
                        dias_atraso: parseInt(r.rows[0].dias_atraso) || 0,
                        credor_nome: r.rows[0].credor_nome || 'Credor',
                        data_vencimento: r.rows[0].proxima_vencimento,
                        cpf_cnpj: r.rows[0].cpf_cnpj
                    };
                }
            }

            const preview = processarTemplate(mensagem, dados);
            res.json({ success: true, preview, dados_usados: dados });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/templates/disparo — disparo em massa com template
    // ═══════════════════════════════════════════════════════════════
    router.post('/disparo', auth, async (req, res) => {
        try {
            const {
                template_id,        // ID do template (padrao_* ou UUID custom)
                mensagem_custom,    // Ou mensagem direta com variáveis
                filtros = {},       // { credor_id, atraso_min, atraso_max, limite }
                canais = ['whatsapp']
            } = req.body;

            // Buscar mensagem base
            let mensagemBase = mensagem_custom;
            if (!mensagemBase && template_id) {
                const padrao = TEMPLATES_PADRAO.find(t => t.id === template_id);
                if (padrao) {
                    mensagemBase = padrao.mensagem;
                } else {
                    const custom = await pool.query('SELECT mensagem FROM templates_mensagem WHERE id = $1', [template_id]).catch(() => ({ rows: [] }));
                    if (custom.rows.length > 0) mensagemBase = custom.rows[0].mensagem;
                }
            }

            if (!mensagemBase) return res.status(400).json({ success: false, error: 'Template ou mensagem obrigatório' });

            // Buscar clientes elegíveis
            let sql = `
                SELECT c.id, c.nome, c.telefone, c.celular, c.email, c.cpf_cnpj,
                    COALESCE(SUM(cob.valor),0) as valor_total,
                    MAX(CURRENT_DATE - cob.data_vencimento)::int as dias_atraso,
                    MIN(cob.data_vencimento)::text as data_vencimento,
                    MAX(cr.nome) as credor_nome, MAX(cob.credor_id::text) as credor_id
                FROM clientes c
                JOIN cobrancas cob ON cob.cliente_id = c.id AND cob.status IN ('pendente','vencido')
                LEFT JOIN credores cr ON cr.id = cob.credor_id
                WHERE c.ativo = true
                AND c.status_cobranca NOT IN ('acordo','incobravel','juridico','quitado')
                AND (c.telefone IS NOT NULL OR c.celular IS NOT NULL OR c.email IS NOT NULL)
            `;
            const params = [];
            let idx = 1;

            if (filtros.credor_id) { sql += ` AND cob.credor_id = $${idx}`; params.push(filtros.credor_id); idx++; }

            sql += ` GROUP BY c.id`;

            if (filtros.atraso_min !== undefined || filtros.atraso_max !== undefined) {
                const min = filtros.atraso_min || 0;
                const max = filtros.atraso_max || 9999;
                sql += ` HAVING MAX(CURRENT_DATE - cob.data_vencimento) BETWEEN ${min} AND ${max}`;
            }

            sql += ` ORDER BY MAX(CURRENT_DATE - cob.data_vencimento) DESC`;
            sql += ` LIMIT ${Math.min(filtros.limite || 50, 200)}`;

            const clientesResult = await pool.query(sql, params);

            // Buscar config Suri
            const suriConfig = await pool.query('SELECT suri_token, suri_endpoint FROM configuracoes WHERE id = 1').catch(() => ({ rows: [] }));
            const suri = suriConfig.rows[0] || {};

            const resultados = { enviados: 0, falhas: 0, detalhes: [] };

            for (const cliente of clientesResult.rows) {
                const dadosCliente = {
                    nome: cliente.nome,
                    valor_atualizado: parseFloat(cliente.valor_total),
                    valor_original: parseFloat(cliente.valor_total),
                    dias_atraso: cliente.dias_atraso,
                    credor_nome: cliente.credor_nome,
                    data_vencimento: cliente.data_vencimento,
                    cpf_cnpj: cliente.cpf_cnpj
                };

                const mensagemFinal = processarTemplate(mensagemBase, dadosCliente);

                let enviou = false;

                if (canais.includes('whatsapp') && suri.suri_token) {
                    const telefone = formatarTelefone(cliente.telefone || cliente.celular);
                    if (telefone) {
                        const r = await enviarWhatsAppSimples(telefone, mensagemFinal, suri);
                        if (r.success) {
                            enviou = true;
                            resultados.enviados++;
                            await pool.query(
                                "INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1,$2,'whatsapp','suri','enviado',$3,NOW())",
                                [cliente.id, req.user?.id, 'Disparo template: ' + mensagemFinal.slice(0, 100)]
                            ).catch(() => {});
                        } else {
                            resultados.falhas++;
                        }
                    }
                }

                resultados.detalhes.push({
                    cliente: cliente.nome,
                    telefone: cliente.telefone || cliente.celular,
                    status: enviou ? 'enviado' : 'falha',
                    mensagem_preview: mensagemFinal.slice(0, 80) + '...'
                });

                await new Promise(r => setTimeout(r, 2000));
            }

            res.json({
                success: true,
                total_clientes: clientesResult.rowCount,
                ...resultados
            });

        } catch (error) {
            console.error('[TEMPLATES] Erro disparo:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ─── Helpers ──────────────────────────────────────────────────
    function formatarTelefone(telefone) {
        if (!telefone) return null;
        const n = telefone.replace(/\D/g, '');
        if (n.length === 11) return '55' + n;
        if (n.length === 10) return '55' + n;
        if (n.length === 13 && n.startsWith('55')) return n;
        return null;
    }

    async function enviarWhatsAppSimples(telefone, mensagem, config) {
        const headers = { 'Authorization': 'Bearer ' + config.suri_token, 'Content-Type': 'application/json' };
        const endpoint = config.suri_endpoint || 'https://cbm-wap-babysuri-cb126955962.azurewebsites.net';

        try {
            const r = await fetch(endpoint + '/api/messages/send-text', {
                method: 'POST', headers,
                body: JSON.stringify({ phone: telefone, message: mensagem, channelId: 'wp946373665229352' })
            });
            if (r.ok) return { success: true };
        } catch (e) {}

        try {
            const r2 = await fetch(endpoint + '/api/messages/send', {
                method: 'POST', headers,
                body: JSON.stringify({ user: { phone: telefone, channelId: 'wp946373665229352', channelType: 1 }, message: { text: mensagem } })
            });
            if (r2.ok) return { success: true };
        } catch (e) {}

        return { success: false };
    }

    return router;
};