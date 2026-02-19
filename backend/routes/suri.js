/**
 * ========================================
 * ACERTIVE - Integração SURI (Chatbot Maker)
 * routes/suri.js - v3.2 FINAL
 * ========================================
 * 
 * MUDANÇAS v3.2:
 * - Juros/multa lidos da tabela `configuracoes` (tela de configurações)
 * - Chatbot simplificado: sem menu de pagamento
 * - Bot mostra cobranças + valor atualizado e transfere pro atendente
 * - Removido: PIX automático, desconto, parcelamento automático
 */

var express = require('express');

module.exports = function(pool, auth, registrarLog) {
    var router = express.Router();

    var SURI_CONFIG = {
        endpoint: 'https://cbm-wap-babysuri-cb126955962.azurewebsites.net',
        token: 'c79ce62a-eb6c-495a-b102-0e780b5d2047',
        identificador: 'cb126955962',
        channelId: 'wp946373665229352',
        channelType: 1,
        templateId: '1182587867397343'
    };

    var ASAAS_CONFIG = {
        apiKey: '$aact_hmlg_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjkxNmNkYWI4LTUxMmQtNDlmYS1iZjgzLWJiZWY2ZjExOTQyYjo6JGFhY2hfNTllZDEzNmEtYmIxZS00NGMxLTlmNDMtMGQxYjg5NjQzMzIx',
        baseUrl: 'https://sandbox.asaas.com/api/v3',
        environment: 'sandbox'
    };

    var nodemailer = null;
    var emailTransporter = null;
    var EMAIL_USER = process.env.SMTP_USER || process.env.EMAIL_USER || '';
    var EMAIL_FROM = process.env.EMAIL_FROM || ('ACERTIVE Cobranças <' + EMAIL_USER + '>');
    try {
        nodemailer = require('nodemailer');
        if (EMAIL_USER) {
            emailTransporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST || process.env.EMAIL_HOST || 'smtp.gmail.com',
                port: parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT) || 587,
                secure: false,
                auth: { user: EMAIL_USER, pass: process.env.SMTP_PASS || process.env.EMAIL_PASS || '' }
            });
            console.log('[EMAIL] ✅ Configurado:', EMAIL_USER);
        } else {
            console.log('[EMAIL] ⚠️ Sem credenciais - defina SMTP_USER e SMTP_PASS');
        }
    } catch (e) {
        console.log('[EMAIL] ⚠️ nodemailer não instalado');
    }

    function getAsaasHeaders() {
        return { 'Content-Type': 'application/json', 'access_token': ASAAS_CONFIG.apiKey };
    }

    function getSuriHeaders() {
        return { 'Authorization': 'Bearer ' + SURI_CONFIG.token, 'Content-Type': 'application/json' };
    }

    var sessoes = {};

    setInterval(function() {
        var agora = Date.now();
        var chaves = Object.keys(sessoes);
        for (var i = 0; i < chaves.length; i++) {
            if (agora - sessoes[chaves[i]].timestamp > 24 * 60 * 60 * 1000) {
                delete sessoes[chaves[i]];
            }
        }
    }, 60 * 60 * 1000);

    function formatarTelefone(telefone) {
        if (!telefone) return null;
        var numeros = telefone.replace(/\D/g, '');
        if (numeros.length === 11) return '55' + numeros;
        if (numeros.length === 10) return '55' + numeros;
        if (numeros.length === 13 && numeros.startsWith('55')) return numeros;
        return numeros;
    }

    function limparTelefone(telefone) {
        if (!telefone) return '';
        var numeros = telefone.replace(/\D/g, '');
        if (numeros.startsWith('55') && numeros.length > 11) numeros = numeros.substring(2);
        return numeros;
    }

    function formatarMoeda(valor) {
        return (valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    // ═══════════════════════════════════════════════════════════════
    // CÁLCULO DE MULTA E JUROS
    // ═══════════════════════════════════════════════════════════════

    function calcularValorAtualizado(valorOriginal, diasAtraso, credorConfig) {
        var multa_pct = parseFloat(credorConfig.multa_atraso) || 2;
        var juros_pct = parseFloat(credorConfig.juros_atraso) || 9;

        var valorMulta = 0;
        var valorJuros = 0;

        if (diasAtraso > 0) {
            valorMulta = valorOriginal * (multa_pct / 100);
            var mesesAtraso = diasAtraso / 30;
            valorJuros = valorOriginal * (juros_pct / 100) * mesesAtraso;
        }

        var valorAtualizado = valorOriginal + valorMulta + valorJuros;

        return {
            original: valorOriginal,
            multa: Math.round(valorMulta * 100) / 100,
            juros: Math.round(valorJuros * 100) / 100,
            atualizado: Math.round(valorAtualizado * 100) / 100,
            multa_pct: multa_pct,
            juros_pct: juros_pct,
            dias_atraso: diasAtraso,
            meses_atraso: Math.round((diasAtraso / 30) * 10) / 10
        };
    }

    // ✅ Busca juros/multa da tabela configuracoes (tela de configurações do sistema)
    async function buscarConfigGlobal() {
        try {
            var result = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
            if (result.rowCount > 0) {
                var cfg = result.rows[0];
                return {
                    juros_atraso: parseFloat(cfg.juros_atraso) || 9,
                    multa_atraso: parseFloat(cfg.multa_atraso) || 2
                };
            }
        } catch (e) {
            console.log('[CONFIG] Erro ao buscar configuracoes globais:', e.message);
        }
        return { juros_atraso: 9, multa_atraso: 2 };
    }

    async function buscarConfigCredor(credorId) {
        try {
            // Sempre busca a config global primeiro (tela de configurações)
            var configGlobal = await buscarConfigGlobal();

            if (!credorId) return getConfigCredorPadrao(configGlobal);

            var result = await pool.query(
                "SELECT multa_atraso, juros_atraso, permite_desconto, desconto_maximo, " +
                "permite_parcelamento, parcelas_maximo, juros_parcelamento, nome " +
                "FROM credores WHERE id = $1", [credorId]
            );
            if (result.rowCount > 0) {
                var c = result.rows[0];
                return {
                    nome: c.nome || 'Credor',
                    // Se o credor tiver config própria usa, senão usa a global
                    multa_atraso: parseFloat(c.multa_atraso) || configGlobal.multa_atraso,
                    juros_atraso: parseFloat(c.juros_atraso) || configGlobal.juros_atraso,
                    permite_desconto: false,
                    desconto_maximo: 0,
                    permite_parcelamento: false,
                    parcelas_maximo: 6,
                    juros_parcelamento: 0
                };
            }
            return getConfigCredorPadrao(configGlobal);
        } catch (e) {
            console.error('[CONFIG] Erro:', e);
            return getConfigCredorPadrao();
        }
    }

    function getConfigCredorPadrao(configGlobal) {
        var cfg = configGlobal || {};
        return {
            nome: 'Credor',
            multa_atraso: cfg.multa_atraso || 2,
            juros_atraso: cfg.juros_atraso || 9,
            permite_desconto: false,
            desconto_maximo: 0,
            permite_parcelamento: false,
            parcelas_maximo: 6,
            juros_parcelamento: 0
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // FUNÇÕES DO ASAAS
    // ═══════════════════════════════════════════════════════════════

    async function buscarOuCriarClienteAsaas(cliente) {
        try {
            var cpfCnpj = (cliente.cpf_cnpj || '').replace(/\D/g, '');
            var cpfValido = cpfCnpj.length === 11 || cpfCnpj.length === 14;
            if (!cpfValido || cpfCnpj.match(/^(\d)\1+$/)) cpfCnpj = '24971563792';
            if (cpfCnpj) {
                var buscaResp = await fetch(ASAAS_CONFIG.baseUrl + '/customers?cpfCnpj=' + cpfCnpj, { method: 'GET', headers: getAsaasHeaders() });
                var buscaData = await buscaResp.json();
                if (buscaData.data && buscaData.data.length > 0) return buscaData.data[0];
            }
            var novoCliente = {
                name: cliente.nome || 'Cliente', cpfCnpj: cpfCnpj,
                email: cliente.email || null,
                phone: (cliente.telefone || cliente.celular || '').replace(/\D/g, '').slice(-11),
                mobilePhone: (cliente.celular || cliente.telefone || '').replace(/\D/g, '').slice(-11),
                notificationDisabled: true
            };
            var criarResp = await fetch(ASAAS_CONFIG.baseUrl + '/customers', { method: 'POST', headers: getAsaasHeaders(), body: JSON.stringify(novoCliente) });
            var criarData = await criarResp.json();
            if (criarData.id) return criarData;
            return null;
        } catch (error) {
            console.error('[ASAAS] Erro:', error);
            return null;
        }
    }

    async function criarCobrancaPix(clienteAsaas, valor, descricao, externalRef) {
        try {
            var vencimento = new Date();
            vencimento.setDate(vencimento.getDate() + 2);
            var cobranca = {
                customer: clienteAsaas.id, billingType: 'PIX', value: valor,
                dueDate: vencimento.toISOString().split('T')[0],
                description: descricao || 'Acordo ACERTIVE',
                externalReference: externalRef || 'acertive_' + Date.now()
            };
            var resp = await fetch(ASAAS_CONFIG.baseUrl + '/payments', { method: 'POST', headers: getAsaasHeaders(), body: JSON.stringify(cobranca) });
            var data = await resp.json();
            if (data.id) {
                var pixResp = await fetch(ASAAS_CONFIG.baseUrl + '/payments/' + data.id + '/pixQrCode', { method: 'GET', headers: getAsaasHeaders() });
                var pixData = await pixResp.json();
                return { success: true, cobrancaId: data.id, valor: data.value, vencimento: data.dueDate, linkPagamento: data.invoiceUrl, pixCopiaECola: pixData.payload || null, externalReference: cobranca.externalReference };
            }
            return { success: false, error: data.errors ? data.errors[0].description : 'Erro desconhecido' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async function criarParcelamentoAsaas(clienteAsaas, valorTotal, numParcelas, descricao) {
        try {
            var valorParcela = Math.round((valorTotal / numParcelas) * 100) / 100;
            var parcelas = [];
            var hoje = new Date();
            for (var i = 0; i < numParcelas; i++) {
                var vencimento = new Date(hoje);
                vencimento.setMonth(vencimento.getMonth() + i);
                if (i === 0) vencimento.setDate(vencimento.getDate() + 2);
                var externalRef = 'acertive_parc_' + Date.now() + '_' + (i + 1);
                var cobranca = {
                    customer: clienteAsaas.id, billingType: 'PIX', value: valorParcela,
                    dueDate: vencimento.toISOString().split('T')[0],
                    description: (descricao || 'Acordo ACERTIVE') + ' - Parcela ' + (i + 1) + '/' + numParcelas,
                    externalReference: externalRef
                };
                var resp = await fetch(ASAAS_CONFIG.baseUrl + '/payments', { method: 'POST', headers: getAsaasHeaders(), body: JSON.stringify(cobranca) });
                var data = await resp.json();
                if (data.id) {
                    var parcelaInfo = { numero: i + 1, cobrancaId: data.id, valor: data.value, vencimento: data.dueDate, linkPagamento: data.invoiceUrl, externalReference: externalRef };
                    if (i === 0) {
                        var pixResp = await fetch(ASAAS_CONFIG.baseUrl + '/payments/' + data.id + '/pixQrCode', { method: 'GET', headers: getAsaasHeaders() });
                        var pixData = await pixResp.json();
                        parcelaInfo.pixCopiaECola = pixData.payload || null;
                    }
                    parcelas.push(parcelaInfo);
                }
                await new Promise(function(r) { setTimeout(r, 500); });
            }
            return parcelas.length === numParcelas
                ? { success: true, parcelas: parcelas }
                : { success: false, error: 'Algumas parcelas falharam', parcelas: parcelas };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ENVIAR MENSAGENS WHATSAPP (SURI)
    // ═══════════════════════════════════════════════════════════════

    async function enviarTemplateComImport(cliente, telefone, templateId, bodyParams) {
        try {
            var body = {
                user: { name: cliente.nome || 'Cliente', phone: telefone, email: cliente.email || '', gender: 0, channelId: SURI_CONFIG.channelId, channelType: SURI_CONFIG.channelType, defaultDepartmentId: null },
                message: { templateId: templateId, BodyParameters: bodyParams || [], ButtonsParameters: [] }
            };
            var response = await fetch(SURI_CONFIG.endpoint + '/api/messages/send', { method: 'POST', headers: getSuriHeaders(), body: JSON.stringify(body) });
            var respText = await response.text();
            if (response.ok) return { success: true, data: respText ? JSON.parse(respText) : {} };
            return { success: false, error: 'Status ' + response.status };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async function enviarMensagemTexto(telefone, texto, contactId) {
        try {
            var r1 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send-text', {
                method: 'POST', headers: getSuriHeaders(),
                body: JSON.stringify({ phone: telefone, message: texto, channelId: SURI_CONFIG.channelId })
            });
            if (r1.ok) { console.log('[SURI] ✅ Enviado via send-text/phone'); return { success: true }; }
        } catch (e) {}
        try {
            var r2 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send-text', {
                method: 'POST', headers: getSuriHeaders(),
                body: JSON.stringify({ to: telefone, text: texto, channelId: SURI_CONFIG.channelId, channelType: SURI_CONFIG.channelType })
            });
            if (r2.ok) { console.log('[SURI] ✅ Enviado via send-text/to'); return { success: true }; }
        } catch (e) {}
        try {
            var r3 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send', {
                method: 'POST', headers: getSuriHeaders(),
                body: JSON.stringify({ user: { phone: telefone, channelId: SURI_CONFIG.channelId, channelType: SURI_CONFIG.channelType }, message: { text: texto } })
            });
            if (r3.ok) { console.log('[SURI] ✅ Enviado via send/user-text'); return { success: true }; }
        } catch (e) {}
        try {
            var r4 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send', {
                method: 'POST', headers: getSuriHeaders(),
                body: JSON.stringify({ user: { phone: telefone, channelId: SURI_CONFIG.channelId, channelType: SURI_CONFIG.channelType }, message: { body: texto } })
            });
            if (r4.ok) { console.log('[SURI] ✅ Enviado via send/user-body'); return { success: true }; }
        } catch (e) {}
        if (contactId) {
            try {
                var r5 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send-text', {
                    method: 'POST', headers: getSuriHeaders(),
                    body: JSON.stringify({ contactId: contactId, message: texto, channelId: SURI_CONFIG.channelId })
                });
                if (r5.ok) { console.log('[SURI] ✅ Enviado via contactId'); return { success: true }; }
            } catch (e) {}
        }
        console.error('[SURI] ❌ Todas tentativas falharam para:', telefone);
        return { success: false, error: 'Todas as tentativas falharam' };
    }

    // ═══════════════════════════════════════════════════════════════
    // ENVIAR EMAIL DE COBRANÇA
    // ═══════════════════════════════════════════════════════════════

    async function enviarEmailCobranca(cliente, valorTotal, valorAtualizado, credorNome) {
        try {
            if (!emailTransporter) return { success: false, error: 'Email não configurado.' };
            if (!cliente.email) return { success: false, error: 'Cliente sem email' };
            var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];
            var valorStr = formatarMoeda(valorAtualizado || valorTotal);
            var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">';
            html += '<div style="max-width:600px;margin:0 auto;background:#fff;">';
            html += '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:30px;text-align:center;">';
            html += '<h1 style="color:#d4a853;margin:0;font-size:28px;">ACERTIVE</h1>';
            html += '<p style="color:#9ca3af;margin:5px 0 0;font-size:14px;">Assessoria e Cobrança</p></div>';
            html += '<div style="padding:30px;">';
            html += '<p style="font-size:16px;color:#333;">Prezado(a) <strong>' + primeiroNome + '</strong>,</p>';
            html += '<p style="font-size:14px;color:#666;line-height:1.6;">Identificamos uma pendência financeira em seu nome. Estamos entrando em contato para negociar.</p>';
            html += '<div style="background:#f8f9fa;border-left:4px solid #d4a853;padding:20px;margin:20px 0;border-radius:0 8px 8px 0;">';
            html += '<p style="margin:0 0 5px;font-size:12px;color:#999;text-transform:uppercase;">Valor da pendência</p>';
            html += '<p style="margin:0;font-size:28px;font-weight:bold;color:#1a1a2e;">' + valorStr + '</p>';
            html += '<p style="margin:5px 0 0;font-size:13px;color:#666;">Referente a: ' + (credorNome || 'Credor') + '</p></div>';
            html += '<div style="text-align:center;margin:30px 0;">';
            html += '<p style="font-size:14px;color:#666;">Entre em contato para negociar:</p>';
            html += '<a href="https://wa.me/5592981040145" style="display:inline-block;background:#25d366;color:white;padding:14px 30px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">💬 Negociar pelo WhatsApp</a></div>';
            html += '</div><div style="background:#1a1a2e;padding:20px;text-align:center;">';
            html += '<p style="color:#9ca3af;margin:0;font-size:12px;">ACERTIVE - Assessoria e Cobrança</p></div></div></body></html>';
            var info = await emailTransporter.sendMail({ from: EMAIL_FROM, to: cliente.email, subject: 'ACERTIVE - Pendência financeira em seu nome', html: html });
            console.log('[EMAIL] ✅ Enviado para:', cliente.email);
            return { success: true, messageId: info.messageId };
        } catch (error) {
            console.error('[EMAIL] Erro:', error);
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // MENSAGEM INICIAL — SEM desconto/parcelamento
    // ═══════════════════════════════════════════════════════════════

    function gerarMensagemInicial(cliente, valorAtualizado, credorNome) {
        var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];
        var msg = '📋 *ACERTIVE - Assessoria e Cobrança*\n\n';
        msg += 'Olá *' + primeiroNome + '*, tudo bem?\n\n';
        msg += 'Identificamos uma pendência financeira em seu nome no valor de *' + formatarMoeda(valorAtualizado) + '*';
        if (credorNome) msg += ' referente a *' + credorNome + '*';
        msg += '.\n\n';
        msg += 'Responda esta mensagem e um de nossos atendentes entrará em contato para negociar sua situação. 💬\n\n';
        msg += '🕐 _Horário de atendimento: Segunda a Quinta, 8h às 17h30._';
        return msg;
    }

    // ═══════════════════════════════════════════════════════════════
    // BUSCAR CLIENTE POR TELEFONE
    // ═══════════════════════════════════════════════════════════════

    async function buscarClientePorTelefone(telefone) {
        var telefoneNumeros = limparTelefone(telefone);
        if (!telefoneNumeros || telefoneNumeros.length < 10) return null;
        var ultimos9 = telefoneNumeros.slice(-9);
        var ultimos8 = telefoneNumeros.slice(-8);
        var result = await pool.query(
            "SELECT c.*, " +
            "(SELECT COALESCE(SUM(cob.valor), 0) FROM cobrancas cob WHERE cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')) as valor_total, " +
            "(SELECT COUNT(*) FROM cobrancas cob WHERE cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')) as qtd_cobrancas, " +
            "(SELECT MAX(CURRENT_DATE - cob.data_vencimento) FROM cobrancas cob WHERE cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')) as maior_atraso, " +
            "(SELECT string_agg(DISTINCT cr.nome, ', ') FROM cobrancas cob JOIN credores cr ON cr.id = cob.credor_id WHERE cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')) as credores_nomes, " +
            "(SELECT cob.credor_id FROM cobrancas cob WHERE cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido') ORDER BY cob.valor DESC LIMIT 1) as principal_credor_id " +
            "FROM clientes c " +
            "WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.telefone, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') LIKE $1 " +
            "OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.celular, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') LIKE $1 " +
            "OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.telefone, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') LIKE $2 " +
            "OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.celular, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') LIKE $2 " +
            "OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.telefone, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') LIKE $3 " +
            "OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.celular, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') LIKE $3 " +
            "LIMIT 1",
            ['%' + telefoneNumeros, '%' + ultimos9, '%' + ultimos8]
        );
        if (result.rowCount > 0) {
            console.log('[SURI BOT] ✅ Cliente:', result.rows[0].nome);
            return result.rows[0];
        }
        return null;
    }

    async function buscarCobrancasCliente(cliente_id) {
        var result = await pool.query(
            "SELECT cob.*, cr.nome as credor_nome, cob.credor_id " +
            "FROM cobrancas cob LEFT JOIN credores cr ON cr.id = cob.credor_id " +
            "WHERE cob.cliente_id = $1 AND cob.status IN ('pendente', 'vencido') " +
            "ORDER BY cob.data_vencimento ASC", [cliente_id]
        );
        return result.rows;
    }

    // ═══════════════════════════════════════════════════════════════
    // CHATBOT: PROCESSAR RESPOSTA DO DEVEDOR
    // ═══════════════════════════════════════════════════════════════

    async function processarChatbot(telefone, texto, cliente, contactId) {
        var telefoneKey = limparTelefone(telefone);
        var sessao = sessoes[telefoneKey];

        if (!sessao || sessao.etapa === 'atendente') {
            return await iniciarSessao(telefoneKey, telefone, cliente, contactId);
        }

        sessao.timestamp = Date.now();
        if (contactId) sessao.contactId = contactId;

        return await encaminharAtendente(telefoneKey, telefone, sessao);
    }

    // ═══════════════════════════════════════════════════════════════
    // CHATBOT: INICIAR SESSÃO — mostra cobranças + valor e encaminha
    // ═══════════════════════════════════════════════════════════════

    async function iniciarSessao(telefoneKey, telefone, cliente, contactId) {
        var cobrancas = await buscarCobrancasCliente(cliente.id);
        var valorOriginal = parseFloat(cliente.valor_total) || 0;
        var maiorAtraso = parseInt(cliente.maior_atraso) || 0;
        var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];

        var credorId = cliente.principal_credor_id || (cobrancas.length > 0 ? cobrancas[0].credor_id : null);
        var configCredor = await buscarConfigCredor(credorId);
        var calculo = calcularValorAtualizado(valorOriginal, maiorAtraso, configCredor);
        var valorAtualizado = calculo.atualizado;

        sessoes[telefoneKey] = {
            cliente_id: cliente.id,
            etapa: 'atendente',
            valor_original: valorOriginal,
            valor_total: valorAtualizado,
            calculo: calculo,
            nome: primeiroNome,
            contactId: contactId || null,
            timestamp: Date.now()
        };

        var msg = '📋 *ACERTIVE - Assessoria e Cobrança*\n\n';
        msg += 'Olá *' + primeiroNome + '*, identificamos pendências em seu nome:\n\n';

        for (var i = 0; i < cobrancas.length && i < 5; i++) {
            var c = cobrancas[i];
            var venc = c.data_vencimento ? new Date(c.data_vencimento).toLocaleDateString('pt-BR') : '-';
            var atraso = Math.max(0, Math.floor((new Date() - new Date(c.data_vencimento)) / (1000 * 60 * 60 * 24)));
            msg += '▸ ' + (c.credor_nome || c.descricao || 'Cobrança') + '\n';
            msg += '   Valor: *' + formatarMoeda(c.valor) + '* | Venc: ' + venc;
            if (atraso > 0) msg += ' (' + atraso + ' dias em atraso)';
            msg += '\n\n';
        }
        if (cobrancas.length > 5) msg += '... e mais ' + (cobrancas.length - 5) + ' cobranças\n\n';

        msg += '━━━━━━━━━━━━━━━━━━━━\n';
        msg += '💰 Valor original: ' + formatarMoeda(valorOriginal) + '\n';
        if (calculo.multa > 0) msg += '📌 Multa (' + calculo.multa_pct + '%): + ' + formatarMoeda(calculo.multa) + '\n';
        if (calculo.juros > 0) msg += '📌 Juros (' + calculo.juros_pct + '% a.m.): + ' + formatarMoeda(calculo.juros) + '\n';
        msg += '💰 *TOTAL ATUALIZADO: ' + formatarMoeda(valorAtualizado) + '*\n';
        msg += '━━━━━━━━━━━━━━━━━━━━\n\n';
        msg += '👤 Um de nossos atendentes entrará em contato em breve para negociar sua situação.\n\n';
        msg += '🕐 _Horário de atendimento: Segunda a Quinta, 8h às 17h30._';

        await enviarMensagemTexto(telefone, msg, contactId);

        try {
            await pool.query(
                "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'bot_resumo_enviado', 'Resumo de cobranças enviado via bot', NOW())",
                [cliente.id]
            );
        } catch (e) {}

        return 'resumo_enviado';
    }

    async function encaminharAtendente(telefoneKey, telefone, sessao) {
        var cId = sessao.contactId;
        var msg = '✅ Sua mensagem foi recebida!\n\n';
        msg += 'Um atendente da ACERTIVE entrará em contato em breve para negociar sua dívida.\n\n';
        msg += '🕐 _Horário: Segunda a Quinta, 8h às 17h30._\n\n';
        msg += '_Fora desse horário, retornaremos assim que possível. Obrigado!_ 🙏';

        await enviarMensagemTexto(telefone, msg, cId);

        try {
            await pool.query(
                "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'aguardando_atendente', 'Cliente respondeu e aguarda atendente', NOW())",
                [sessao.cliente_id]
            );
        } catch (e) {}

        return 'atendente_notificado';
    }

    // ═══════════════════════════════════════════════════════════════
    // WEBHOOK: RECEBER EVENTOS DA SURI
    // ═══════════════════════════════════════════════════════════════

    router.post('/webhook', async function(req, res) {
        try {
            var evento = req.body;
            var tipo = evento.type || evento.event || 'unknown';
            console.log('[SURI WEBHOOK] Tipo:', tipo);

            if (tipo === 'new-contact') {
                var payload = evento.payload || evento.data || evento;
                var user = payload.user || payload.contact || payload;
                var tel = user.Phone || user.phone;
                if (tel) {
                    var cli = await buscarClientePorTelefone(tel);
                    if (cli) await pool.query("INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'novo_contato', 'Contato via WhatsApp', NOW())", [cli.id]);
                }
            } else if (tipo === 'message-received') {
                await processarMensagemRecebida(evento);
            } else if (tipo === 'finish-attendance') {
                var payload2 = evento.payload || evento.data || evento;
                var contato = (payload2.attendance || payload2).contact || {};
                var tel2 = contato.phone || contato.telefone;
                if (tel2) delete sessoes[limparTelefone(tel2)];
            }

            res.json({ success: true });
        } catch (error) {
            console.error('[SURI WEBHOOK] Erro:', error);
            res.status(200).json({ success: true });
        }
    });

    async function processarMensagemRecebida(evento) {
        try {
            var payload = evento.payload || evento.data || evento;
            var user = payload.user || {};
            var message = payload.Message || payload.message || {};

            var telefone = user.Phone || user.phone || payload.Phone || payload.phone;
            var texto = typeof message === 'string' ? message : (message.text || message.body || message.Text || message.content || '');
            var contactId = user.Id || user.id || payload.contactId;

            if (!telefone || !texto) return;
            if (message.fromMe || message.direction === 'sent' || message.isFromMe) return;

            var cliente = await buscarClientePorTelefone(telefone);
            if (!cliente || parseFloat(cliente.valor_total) <= 0) return;

            try { await pool.query("INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'resposta_recebida', $2, NOW())", [cliente.id, 'WhatsApp: ' + texto.substring(0, 500)]); } catch (e) {}

            await processarChatbot(telefone, texto, cliente, contactId);
        } catch (error) {
            console.error('[SURI BOT] ❌ Erro:', error);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // API: ENVIAR COBRANÇA INICIAL (WhatsApp + Email)
    // ═══════════════════════════════════════════════════════════════

    router.post('/enviar-cobranca-inicial', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            var canais = req.body.canais || ['whatsapp'];
            if (!cliente_id) return res.status(400).json({ success: false, error: 'Cliente obrigatório' });

            var clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
            if (clienteResult.rowCount === 0) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
            var cliente = clienteResult.rows[0];

            var cobResult = await pool.query(
                "SELECT cob.*, cr.nome as credor_nome, cob.credor_id, (CURRENT_DATE - cob.data_vencimento) as dias_atraso " +
                "FROM cobrancas cob LEFT JOIN credores cr ON cr.id = cob.credor_id " +
                "WHERE cob.cliente_id = $1 AND cob.status IN ('pendente', 'vencido') ORDER BY cob.valor DESC", [cliente_id]
            );
            if (cobResult.rowCount === 0) return res.status(400).json({ success: false, error: 'Sem cobranças pendentes' });

            var cobrancas = cobResult.rows;
            var valorOriginal = cobrancas.reduce(function(s, c) { return s + parseFloat(c.valor); }, 0);
            var maiorAtraso = Math.max.apply(null, cobrancas.map(function(c) { return parseInt(c.dias_atraso) || 0; }));
            var config = await buscarConfigCredor(cobrancas[0].credor_id);
            var calculo = calcularValorAtualizado(valorOriginal, maiorAtraso, config);

            var resultados = {};

            if (canais.indexOf('whatsapp') !== -1) {
                var telefone = formatarTelefone(cliente.telefone || cliente.celular);
                if (telefone) {
                    var msgWhats = gerarMensagemInicial(cliente, calculo.atualizado, cobrancas[0].credor_nome);
                    var r = await enviarMensagemTexto(telefone, msgWhats, null);
                    resultados.whatsapp = r;
                    if (r.success) {
                        delete sessoes[limparTelefone(telefone)];
                        await pool.query("INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, 'whatsapp', 'suri', 'enviado', $3, NOW())", [cliente_id, req.user.id, 'Cobrança inicial - ' + formatarMoeda(calculo.atualizado)]);
                    }
                } else resultados.whatsapp = { success: false, error: 'Sem telefone' };
            }

            if (canais.indexOf('email') !== -1) {
                var emailR = await enviarEmailCobranca(cliente, valorOriginal, calculo.atualizado, cobrancas[0].credor_nome);
                resultados.email = emailR;
                if (emailR.success) {
                    await pool.query("INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, 'email', 'sistema', 'enviado', $3, NOW())", [cliente_id, req.user.id, 'Email cobrança - ' + formatarMoeda(calculo.atualizado)]);
                }
            }

            await pool.query("UPDATE clientes SET data_ultimo_contato = NOW(), updated_at = NOW() WHERE id = $1", [cliente_id]);
            res.json({ success: true, calculo: calculo, resultados: resultados });
        } catch (error) {
            console.error('[COBRANCA] Erro:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // API legado - enviar-cobranca (template Suri)
    router.post('/enviar-cobranca', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            if (!cliente_id) return res.status(400).json({ success: false, error: 'Cliente obrigatório' });
            var clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
            if (clienteResult.rowCount === 0) return res.status(404).json({ success: false, error: 'Não encontrado' });
            var cliente = clienteResult.rows[0];
            var telefone = formatarTelefone(cliente.telefone || cliente.celular);
            if (!telefone) return res.status(400).json({ success: false, error: 'Sem telefone' });
            var cobRes = await pool.query("SELECT SUM(valor) as total FROM cobrancas WHERE cliente_id = $1 AND status IN ('pendente', 'vencido')", [cliente_id]);
            var valorTotal = parseFloat(cobRes.rows[0].total) || 0;
            var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];
            var assunto = valorTotal > 0 ? 'seu débito de ' + formatarMoeda(valorTotal) : 'sua pendência financeira';
            var resultado = await enviarTemplateComImport(cliente, telefone, SURI_CONFIG.templateId, [primeiroNome, assunto]);
            if (resultado.success) {
                delete sessoes[limparTelefone(telefone)];
                await pool.query('INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())', [cliente_id, req.user.id, 'whatsapp', 'suri', 'enviado', 'Cobrança: ' + (req.body.tipo_mensagem || 'lembrete')]);
                await pool.query('UPDATE clientes SET data_ultimo_contato = NOW(), updated_at = NOW() WHERE id = $1', [cliente_id]);
                res.json({ success: true, message: 'Cobrança enviada!' });
            } else res.status(500).json({ success: false, error: resultado.error });
        } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    router.post('/enviar-mensagem', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            if (!cliente_id) return res.status(400).json({ success: false, error: 'Cliente obrigatório' });
            var clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
            if (clienteResult.rowCount === 0) return res.status(404).json({ success: false, error: 'Não encontrado' });
            var cliente = clienteResult.rows[0];
            var telefone = formatarTelefone(cliente.telefone || cliente.celular);
            if (!telefone) return res.status(400).json({ success: false, error: 'Sem telefone' });
            var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];
            var resultado = await enviarTemplateComImport(cliente, telefone, SURI_CONFIG.templateId, [primeiroNome, req.body.assunto || 'uma pendência financeira']);
            if (resultado.success) {
                delete sessoes[limparTelefone(telefone)];
                await pool.query('INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())', [cliente_id, req.user.id, 'whatsapp', 'suri', 'enviado', 'Mensagem Suri']);
                res.json({ success: true, message: 'Enviado!' });
            } else res.status(500).json({ success: false, error: resultado.error });
        } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    // ═══════════════════════════════════════════════════════════════
    // WEBHOOK ASAAS - PAGAMENTO
    // ═══════════════════════════════════════════════════════════════

    router.post('/asaas-webhook', async function(req, res) {
        try {
            var evento = req.body;
            console.log('[ASAAS-SURI] Evento:', evento.event);
            if (evento.event === 'PAYMENT_RECEIVED' || evento.event === 'PAYMENT_CONFIRMED') {
                var payment = evento.payment;
                if (payment && payment.externalReference && payment.externalReference.startsWith('acertive_')) {
                    try {
                        var parcela = null;
                        var findByPayment = await pool.query("SELECT id, acordo_id FROM parcelas_acordo WHERE asaas_payment_id = $1", [String(payment.id)]);
                        if (findByPayment.rowCount > 0) {
                            parcela = findByPayment.rows[0];
                        } else if (payment.externalReference) {
                            var findByRef = await pool.query("SELECT id, acordo_id FROM parcelas_acordo WHERE external_reference = $1", [String(payment.externalReference)]);
                            if (findByRef.rowCount > 0) parcela = findByRef.rows[0];
                        }
                        if (parcela) {
                            await pool.query("UPDATE parcelas_acordo SET status = 'pago', data_pagamento = NOW(), updated_at = NOW() WHERE id = $1", [parcela.id]);
                            var acordoId = parcela.acordo_id;
                            var pendentes = await pool.query("SELECT COUNT(*) as n FROM parcelas_acordo WHERE acordo_id = $1 AND status != 'pago'", [acordoId]);
                            if (parseInt(pendentes.rows[0].n) === 0) {
                                await pool.query("UPDATE acordos SET status = 'quitado', updated_at = NOW() WHERE id = $1", [acordoId]);
                                var cliRes = await pool.query("SELECT cliente_id FROM acordos WHERE id = $1", [acordoId]);
                                if (cliRes.rowCount > 0) await pool.query("UPDATE clientes SET status_cobranca = 'quitado', updated_at = NOW() WHERE id = $1", [cliRes.rows[0].cliente_id]);
                            }
                        }
                        await pool.query("INSERT INTO acionamentos (tipo, canal, resultado, descricao, created_at) VALUES ('pagamento', 'asaas', 'confirmado', $1, NOW())", ['Pago: ' + payment.id + ' R$ ' + payment.value]);
                    } catch (e) { console.error('[ASAAS-SURI] Erro:', e.message); }
                }
            }
            res.json({ success: true });
        } catch (error) { res.status(200).json({ success: true }); }
    });

    // ═══════════════════════════════════════════════════════════════
    // API: CRIAR ACORDO COM PIX (pelo atendente no sistema)
    // ═══════════════════════════════════════════════════════════════

    router.post('/criar-acordo-pix', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            var valor_final = parseFloat(req.body.valor_final) || 0;
            var num_parcelas = parseInt(req.body.num_parcelas) || 1;
            var desconto_pct = parseFloat(req.body.desconto_pct) || 0;
            var valor_original = parseFloat(req.body.valor_original) || valor_final;
            var enviar_whatsapp = req.body.enviar_whatsapp !== false;

            if (!cliente_id || !valor_final) return res.status(400).json({ success: false, error: 'Cliente e valor obrigatórios' });

            var clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
            if (clienteResult.rowCount === 0) return res.status(404).json({ success: false, error: 'Não encontrado' });
            var cliente = clienteResult.rows[0];

            var clienteAsaas = await buscarOuCriarClienteAsaas(cliente);
            if (!clienteAsaas) return res.status(500).json({ success: false, error: 'Erro Asaas' });

            var acordoRes = await pool.query(
                "INSERT INTO acordos (cliente_id, operador_id, valor_original, valor_atualizado, desconto_percentual, desconto_valor, valor_acordo, valor_final, numero_parcelas, num_parcelas, valor_parcela, forma_pagamento, status, created_at) VALUES ($1, $2, $3, $3, $4, $5, $6, $6, $7, $7, $8, 'pix', 'ativo', NOW()) RETURNING id",
                [cliente_id, req.user.id, valor_original, desconto_pct, valor_original * desconto_pct / 100, valor_final, num_parcelas, Math.round((valor_final / num_parcelas) * 100) / 100]
            );
            var acordoId = acordoRes.rows[0].id;
            var valor_parcela = Math.round((valor_final / num_parcelas) * 100) / 100;
            var parcelas = [];
            var hoje = new Date();

            for (var i = 0; i < num_parcelas; i++) {
                var venc = new Date(hoje);
                venc.setMonth(venc.getMonth() + i);
                if (i === 0) venc.setDate(venc.getDate() + 2);
                var extRef = 'acertive_acordo_' + acordoId + '_parc_' + (i + 1);
                var resp = await fetch(ASAAS_CONFIG.baseUrl + '/payments', {
                    method: 'POST', headers: getAsaasHeaders(),
                    body: JSON.stringify({ customer: clienteAsaas.id, billingType: 'PIX', value: valor_parcela, dueDate: venc.toISOString().split('T')[0], description: 'Acordo ACERTIVE - Parcela ' + (i+1) + '/' + num_parcelas, externalReference: extRef })
                });
                var data = await resp.json();
                if (data.id) {
                    var info = { numero: i+1, asaas_id: data.id, valor: data.value, vencimento: data.dueDate, link: data.invoiceUrl, pix: null };
                    if (i === 0) {
                        var pixR = await fetch(ASAAS_CONFIG.baseUrl + '/payments/' + data.id + '/pixQrCode', { method: 'GET', headers: getAsaasHeaders() });
                        var pixD = await pixR.json();
                        info.pix = pixD.payload || null;
                    }
                    await pool.query("INSERT INTO parcelas_acordo (acordo_id, numero, valor, data_vencimento, asaas_payment_id, external_reference, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,'pendente',NOW())", [acordoId, i+1, valor_parcela, venc, data.id, extRef]);
                    parcelas.push(info);
                }
                await new Promise(function(r) { setTimeout(r, 500); });
            }

            if (enviar_whatsapp && parcelas.length > 0) {
                var tel = formatarTelefone(cliente.telefone || cliente.celular);
                if (tel) {
                    var nome = (cliente.nome || 'Cliente').split(' ')[0];
                    var msgA = '🎉 *ACORDO REGISTRADO!*\n\nOlá *' + nome + '*, seu acordo foi criado:\n\n';
                    msgA += '📋 *' + num_parcelas + 'x de ' + formatarMoeda(valor_parcela) + '*\n💰 Total: *' + formatarMoeda(valor_final) + '*\n\n';
                    if (parcelas[0].pix) {
                        msgA += '━━━━━━━━━━━━━━━━━━━━\n📋 *PIX DA 1ª PARCELA:*\n━━━━━━━━━━━━━━━━━━━━\n\n' + parcelas[0].pix + '\n\n━━━━━━━━━━━━━━━━━━━━\n\n';
                        msgA += '👆 Copie e cole no app do seu banco!\n\n';
                    }
                    if (parcelas[0].link) msgA += '🔗 Ou acesse: ' + parcelas[0].link + '\n\n';
                    msgA += 'Obrigado por regularizar! 🙏';
                    await enviarMensagemTexto(tel, msgA, null);
                }
            }

            await pool.query("UPDATE clientes SET status_cobranca = 'acordo', updated_at = NOW() WHERE id = $1", [cliente_id]);
            await pool.query("INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1,$2,'acordo','sistema','acordo_criado',$3,NOW())", [cliente_id, req.user.id, 'Acordo: ' + num_parcelas + 'x R$' + valor_parcela.toFixed(2)]);
            res.json({ success: true, acordo_id: acordoId, parcelas: parcelas });
        } catch (error) {
            console.error('[ACORDO] Erro:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // API: Calcular acordo (preview)
    router.post('/calcular-acordo', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            if (!cliente_id) return res.status(400).json({ success: false, error: 'Cliente obrigatório' });
            var cobRes = await pool.query(
                "SELECT cob.*, cob.credor_id, (CURRENT_DATE - cob.data_vencimento) as dias_atraso " +
                "FROM cobrancas cob WHERE cob.cliente_id = $1 AND cob.status IN ('pendente', 'vencido')", [cliente_id]
            );
            if (cobRes.rowCount === 0) return res.json({ success: true, valor_original: 0 });
            var cobrancas = cobRes.rows;
            var valorOrig = cobrancas.reduce(function(s, c) { return s + parseFloat(c.valor); }, 0);
            var maiorAtraso = Math.max.apply(null, cobrancas.map(function(c) { return parseInt(c.dias_atraso) || 0; }));
            var config = await buscarConfigCredor(cobrancas[0].credor_id);
            var calculo = calcularValorAtualizado(valorOrig, maiorAtraso, config);
            res.json({ success: true, valor_original: valorOrig, calculo: calculo, config_credor: config, dias_atraso: maiorAtraso });
        } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    // API: Disparo em massa
    router.post('/disparo-massa', auth, async function(req, res) {
        try {
            var canais = req.body.canais || ['whatsapp'];
            var filtro_atraso_min = req.body.filtro_atraso_min || 0;
            var filtro_atraso_max = req.body.filtro_atraso_max || 9999;
            var credor_id = req.body.credor_id || null;
            var limite = req.body.limite || 50;

            var query = "SELECT c.id, c.nome, c.telefone, c.celular, c.email, c.cpf_cnpj, " +
                "SUM(cob.valor) as valor_total, MAX(CURRENT_DATE - cob.data_vencimento) as maior_atraso, " +
                "(SELECT cr.nome FROM credores cr WHERE cr.id = MIN(cob.credor_id)) as credor_nome, MIN(cob.credor_id) as credor_id " +
                "FROM clientes c JOIN cobrancas cob ON cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido') " +
                "WHERE c.ativo = true AND (c.telefone IS NOT NULL OR c.celular IS NOT NULL) " +
                "AND c.status_cobranca NOT IN ('acordo', 'incobravel', 'juridico', 'quitado') ";
            var params = [filtro_atraso_min, filtro_atraso_max, limite];
            if (credor_id) { query += "AND cob.credor_id = $4 "; params.push(credor_id); }
            query += "GROUP BY c.id HAVING MAX(CURRENT_DATE - cob.data_vencimento) BETWEEN $1 AND $2 ORDER BY MAX(CURRENT_DATE - cob.data_vencimento) DESC LIMIT $3";

            var result = await pool.query(query, params);
            var enviados = { whatsapp: 0, email: 0 };
            var erros = [];

            for (var i = 0; i < result.rows.length; i++) {
                var cl = result.rows[i];
                try {
                    var cfg = await buscarConfigCredor(cl.credor_id);
                    var calc = calcularValorAtualizado(parseFloat(cl.valor_total), parseInt(cl.maior_atraso) || 0, cfg);
                    if (canais.indexOf('whatsapp') !== -1) {
                        var tel = formatarTelefone(cl.telefone || cl.celular);
                        if (tel) {
                            var r = await enviarMensagemTexto(tel, gerarMensagemInicial(cl, calc.atualizado, cl.credor_nome), null);
                            if (r.success) { enviados.whatsapp++; delete sessoes[limparTelefone(tel)]; await pool.query("INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1,$2,'whatsapp','suri','enviado','Disparo massa',NOW())", [cl.id, req.user.id]); }
                        }
                    }
                    if (canais.indexOf('email') !== -1 && cl.email) {
                        var eR = await enviarEmailCobranca(cl, parseFloat(cl.valor_total), calc.atualizado, cl.credor_nome);
                        if (eR.success) { enviados.email++; await pool.query("INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1,$2,'email','sistema','enviado','Disparo massa email',NOW())", [cl.id, req.user.id]); }
                    }
                    await new Promise(function(r) { setTimeout(r, 2000); });
                } catch (e) { erros.push({ id: cl.id, erro: e.message }); }
            }
            res.json({ success: true, total: result.rows.length, enviados: enviados, erros: erros.length });
        } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    // API: Lembretes de parcela
    router.post('/enviar-lembretes', auth, async function(req, res) {
        try {
            var result = await pool.query(
                "SELECT pa.*, a.cliente_id, c.nome, c.telefone, c.celular FROM parcelas_acordo pa " +
                "JOIN acordos a ON a.id = pa.acordo_id JOIN clientes c ON c.id = a.cliente_id " +
                "WHERE pa.status = 'pendente' AND pa.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + $1 AND pa.lembrete_enviado IS NOT TRUE", [req.body.dias_antes || 3]
            );
            var enviados = 0;
            for (var i = 0; i < result.rows.length; i++) {
                var p = result.rows[i];
                var tel = formatarTelefone(p.telefone || p.celular);
                if (!tel) continue;
                try {
                    var pixR = await fetch(ASAAS_CONFIG.baseUrl + '/payments/' + p.asaas_payment_id + '/pixQrCode', { method: 'GET', headers: getAsaasHeaders() });
                    var pixD = await pixR.json();
                    if (pixD.payload) {
                        var msg = '📅 *LEMBRETE DE PARCELA*\n\nOlá ' + (p.nome||'').split(' ')[0] + '!\n\nParcela ' + p.numero + ' vence em *' + new Date(p.data_vencimento).toLocaleDateString('pt-BR') + '*\nValor: *' + formatarMoeda(p.valor) + '*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 *PIX:*\n━━━━━━━━━━━━━━━━━━━━\n\n' + pixD.payload + '\n\n━━━━━━━━━━━━━━━━━━━━\n\nEvite juros! Pague em dia. 🙏';
                        var r = await enviarMensagemTexto(tel, msg, null);
                        if (r.success) { await pool.query("UPDATE parcelas_acordo SET lembrete_enviado = true WHERE id = $1", [p.id]); enviados++; }
                    }
                    await new Promise(function(r) { setTimeout(r, 2000); });
                } catch (e) {}
            }
            res.json({ success: true, total: result.rows.length, enviados: enviados });
        } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    // API: PIX de parcela
    router.get('/parcela-pix/:parcela_id', auth, async function(req, res) {
        try {
            var r = await pool.query("SELECT * FROM parcelas_acordo WHERE id = $1", [req.params.parcela_id]);
            if (r.rowCount === 0) return res.status(404).json({ success: false, error: 'Não encontrada' });
            var p = r.rows[0];
            var pixR = await fetch(ASAAS_CONFIG.baseUrl + '/payments/' + p.asaas_payment_id + '/pixQrCode', { method: 'GET', headers: getAsaasHeaders() });
            var pixD = await pixR.json();
            res.json({ success: true, parcela: { numero: p.numero, valor: p.valor, vencimento: p.data_vencimento, status: p.status }, pix: { copiaECola: pixD.payload, qrCodeBase64: pixD.encodedImage } });
        } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    });

    // Status e debug
    router.get('/webhook-logs', auth, function(req, res) { res.json({ success: true, sessoes_ativas: Object.keys(sessoes).length, sessoes: sessoes }); });
    router.get('/status', auth, async function(req, res) {
        try {
            var s = await pool.query("SELECT COUNT(*) FILTER (WHERE tipo='whatsapp' AND canal='suri' AND DATE(created_at)=CURRENT_DATE) as msg_hoje, COUNT(*) FILTER (WHERE resultado LIKE 'acordo%') as acordos FROM acionamentos");
            var configGlobal = await buscarConfigGlobal();
            res.json({ success: true, data: { conectado: true, chatbot_ativo: true, sessoes: Object.keys(sessoes).length, stats: s.rows[0], email_ok: !!emailTransporter, juros_configurado: configGlobal.juros_atraso + '%', multa_configurada: configGlobal.multa_atraso + '%' } });
        } catch (e) { res.json({ success: false }); }
    });
    router.post('/teste-texto', auth, async function(req, res) {
        if (!req.body.telefone) return res.status(400).json({ success: false, error: 'Telefone obrigatório' });
        var r = await enviarMensagemTexto(formatarTelefone(req.body.telefone), req.body.texto || 'Teste ACERTIVE', null);
        res.json(r);
    });

    return router;
};