/**
 * ========================================
 * ACERTIVE - Integração SURI (Chatbot Maker)
 * routes/suri.js
 * ========================================
 * 
 * Funcionalidades:
 * - Enviar mensagens via WhatsApp (template)
 * - Receber webhooks (mensagens recebidas)
 * - CHATBOT AUTOMÁTICO DE COBRANÇA (tipo Claro)
 * - Negociação automática com parcelamento
 * - Registrar acionamentos automaticamente
 */

var express = require('express');

module.exports = function(pool, auth, registrarLog) {
    var router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // CONFIGURAÇÕES DA SURI
    // ═══════════════════════════════════════════════════════════════
    
    var SURI_CONFIG = {
        endpoint: 'https://cbm-wap-babysuri-cb126955962.azurewebsites.net',
        token: 'c79ce62a-eb6c-495a-b102-0e780b5d2047',
        identificador: 'cb126955962',
        channelId: 'wp946373665229352',
        channelType: 1,
        templateId: '1182587867397343'
    };

    // ═══════════════════════════════════════════════════════════════
    // CONTROLE DE SESSÕES DO CHATBOT
    // ═══════════════════════════════════════════════════════════════
    
    var sessoes = {};

    // Limpar sessões antigas (mais de 24h)
    setInterval(function() {
        var agora = Date.now();
        var chaves = Object.keys(sessoes);
        for (var i = 0; i < chaves.length; i++) {
            if (agora - sessoes[chaves[i]].timestamp > 24 * 60 * 60 * 1000) {
                delete sessoes[chaves[i]];
            }
        }
    }, 60 * 60 * 1000);

    function getSuriHeaders() {
        return {
            'Authorization': 'Bearer ' + SURI_CONFIG.token,
            'Content-Type': 'application/json'
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // FUNÇÕES AUXILIARES
    // ═══════════════════════════════════════════════════════════════

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
    // ENVIAR TEMPLATE COM IMPORT
    // ═══════════════════════════════════════════════════════════════

    async function enviarTemplateComImport(cliente, telefone, templateId, bodyParams) {
        try {
            var body = {
                user: {
                    name: cliente.nome || 'Cliente',
                    phone: telefone,
                    email: cliente.email || '',
                    gender: 0,
                    channelId: SURI_CONFIG.channelId,
                    channelType: SURI_CONFIG.channelType,
                    defaultDepartmentId: null
                },
                message: {
                    templateId: templateId,
                    BodyParameters: bodyParams || [],
                    ButtonsParameters: []
                }
            };

            console.log('[SURI] Enviando template para', telefone);

            var response = await fetch(SURI_CONFIG.endpoint + '/api/messages/send', {
                method: 'POST',
                headers: getSuriHeaders(),
                body: JSON.stringify(body)
            });

            var respText = await response.text();
            console.log('[SURI] Resposta template:', response.status, respText);

            if (response.ok) {
                var data = respText ? JSON.parse(respText) : {};
                return { success: true, data: data };
            }
            return { success: false, error: 'Status ' + response.status + ': ' + respText };
        } catch (error) {
            console.error('[SURI] Erro ao enviar template:', error);
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ENVIAR MENSAGEM DE TEXTO (resposta do chatbot)
    // Tenta múltiplos formatos até funcionar
    // Quando encontrar o que funciona, loga o método
    // ═══════════════════════════════════════════════════════════════

    async function enviarMensagemTexto(telefone, texto, contactId) {
        var tentativas = [];

        // Tentativa 1: /api/messages/send-text com phone
        try {
            var body1 = { phone: telefone, message: texto, channelId: SURI_CONFIG.channelId };
            var r1 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send-text', {
                method: 'POST', headers: getSuriHeaders(), body: JSON.stringify(body1)
            });
            var t1 = await r1.text();
            tentativas.push({ metodo: 'send-text/phone', status: r1.status, ok: r1.ok, resp: t1.substring(0, 300) });
            if (r1.ok) { console.log('[SURI BOT] ✅ Enviado via send-text/phone'); return { success: true, metodo: 'send-text/phone' }; }
        } catch (e) { tentativas.push({ metodo: 'send-text/phone', error: e.message }); }

        // Tentativa 2: /api/messages/send-text com to
        try {
            var body2 = { to: telefone, text: texto, channelId: SURI_CONFIG.channelId, channelType: SURI_CONFIG.channelType };
            var r2 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send-text', {
                method: 'POST', headers: getSuriHeaders(), body: JSON.stringify(body2)
            });
            var t2 = await r2.text();
            tentativas.push({ metodo: 'send-text/to', status: r2.status, ok: r2.ok, resp: t2.substring(0, 300) });
            if (r2.ok) { console.log('[SURI BOT] ✅ Enviado via send-text/to'); return { success: true, metodo: 'send-text/to' }; }
        } catch (e) { tentativas.push({ metodo: 'send-text/to', error: e.message }); }

        // Tentativa 3: /api/messages/send com user + message.text
        try {
            var body3 = {
                user: { phone: telefone, channelId: SURI_CONFIG.channelId, channelType: SURI_CONFIG.channelType },
                message: { text: texto }
            };
            var r3 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send', {
                method: 'POST', headers: getSuriHeaders(), body: JSON.stringify(body3)
            });
            var t3 = await r3.text();
            tentativas.push({ metodo: 'send/user-text', status: r3.status, ok: r3.ok, resp: t3.substring(0, 300) });
            if (r3.ok) { console.log('[SURI BOT] ✅ Enviado via send/user-text'); return { success: true, metodo: 'send/user-text' }; }
        } catch (e) { tentativas.push({ metodo: 'send/user-text', error: e.message }); }

        // Tentativa 4: /api/messages/send com user + message.body
        try {
            var body4 = {
                user: { phone: telefone, channelId: SURI_CONFIG.channelId, channelType: SURI_CONFIG.channelType },
                message: { body: texto }
            };
            var r4 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send', {
                method: 'POST', headers: getSuriHeaders(), body: JSON.stringify(body4)
            });
            var t4 = await r4.text();
            tentativas.push({ metodo: 'send/user-body', status: r4.status, ok: r4.ok, resp: t4.substring(0, 300) });
            if (r4.ok) { console.log('[SURI BOT] ✅ Enviado via send/user-body'); return { success: true, metodo: 'send/user-body' }; }
        } catch (e) { tentativas.push({ metodo: 'send/user-body', error: e.message }); }

        // Tentativa 5: /api/messages/send-text-message
        try {
            var body5 = { phone: telefone, message: texto, channelId: SURI_CONFIG.channelId, channelType: SURI_CONFIG.channelType };
            var r5 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send-text-message', {
                method: 'POST', headers: getSuriHeaders(), body: JSON.stringify(body5)
            });
            var t5 = await r5.text();
            tentativas.push({ metodo: 'send-text-message', status: r5.status, ok: r5.ok, resp: t5.substring(0, 300) });
            if (r5.ok) { console.log('[SURI BOT] ✅ Enviado via send-text-message'); return { success: true, metodo: 'send-text-message' }; }
        } catch (e) { tentativas.push({ metodo: 'send-text-message', error: e.message }); }

        // Tentativa 6: com contactId se disponível
        if (contactId) {
            try {
                var body6 = { contactId: contactId, message: texto, channelId: SURI_CONFIG.channelId };
                var r6 = await fetch(SURI_CONFIG.endpoint + '/api/messages/send-text', {
                    method: 'POST', headers: getSuriHeaders(), body: JSON.stringify(body6)
                });
                var t6 = await r6.text();
                tentativas.push({ metodo: 'send-text/contactId', status: r6.status, ok: r6.ok, resp: t6.substring(0, 300) });
                if (r6.ok) { console.log('[SURI BOT] ✅ Enviado via send-text/contactId'); return { success: true, metodo: 'send-text/contactId' }; }
            } catch (e) { tentativas.push({ metodo: 'send-text/contactId', error: e.message }); }
        }

        console.error('[SURI BOT] ❌ TODAS tentativas falharam:', JSON.stringify(tentativas, null, 2));
        return { success: false, error: 'Todas as tentativas falharam', tentativas: tentativas };
    }

    // ═══════════════════════════════════════════════════════════════
    // BUSCAR CLIENTE POR TELEFONE
    // ═══════════════════════════════════════════════════════════════

    async function buscarClientePorTelefone(telefone) {
        var telefoneNumeros = limparTelefone(telefone);
        if (!telefoneNumeros || telefoneNumeros.length < 10) return null;

        // Tentar busca com diferentes formatos
        var result = await pool.query(
            "SELECT c.*, " +
            "(SELECT COALESCE(SUM(cob.valor), 0) FROM cobrancas cob WHERE cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')) as valor_total, " +
            "(SELECT COUNT(*) FROM cobrancas cob WHERE cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')) as qtd_cobrancas, " +
            "(SELECT MAX(CURRENT_DATE - cob.data_vencimento) FROM cobrancas cob WHERE cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')) as maior_atraso, " +
            "(SELECT string_agg(DISTINCT cr.nome, ', ') FROM cobrancas cob JOIN credores cr ON cr.id = cob.credor_id WHERE cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido')) as credores_nomes " +
            "FROM clientes c " +
            "WHERE REPLACE(REPLACE(REPLACE(REPLACE(c.telefone, '(', ''), ')', ''), '-', ''), ' ', '') LIKE $1 " +
            "OR REPLACE(REPLACE(REPLACE(REPLACE(c.celular, '(', ''), ')', ''), '-', ''), ' ', '') LIKE $1 " +
            "LIMIT 1",
            ['%' + telefoneNumeros]
        );

        return result.rowCount > 0 ? result.rows[0] : null;
    }

    // ═══════════════════════════════════════════════════════════════
    // BUSCAR COBRANÇAS DETALHADAS DO CLIENTE
    // ═══════════════════════════════════════════════════════════════

    async function buscarCobrancasCliente(cliente_id) {
        var result = await pool.query(
            "SELECT cob.*, cr.nome as credor_nome " +
            "FROM cobrancas cob " +
            "LEFT JOIN credores cr ON cr.id = cob.credor_id " +
            "WHERE cob.cliente_id = $1 AND cob.status IN ('pendente', 'vencido') " +
            "ORDER BY cob.data_vencimento ASC",
            [cliente_id]
        );
        return result.rows;
    }

    // ═══════════════════════════════════════════════════════════════
    // CHATBOT: PROCESSAR RESPOSTA DO DEVEDOR
    // ═══════════════════════════════════════════════════════════════

    async function processarChatbot(telefone, texto, cliente, contactId) {
        var telefoneKey = limparTelefone(telefone);
        var sessao = sessoes[telefoneKey];
        var textoLimpo = texto.trim().toLowerCase();

        // Se não tem sessão, criar uma nova
        if (!sessao) {
            return await iniciarSessao(telefoneKey, telefone, cliente, contactId);
        }

        // Atualizar timestamp e contactId
        sessao.timestamp = Date.now();
        if (contactId) sessao.contactId = contactId;

        // Verificar se quer voltar ao início
        if (textoLimpo === 'menu' || textoLimpo === 'inicio' || textoLimpo === 'voltar' || textoLimpo === '0') {
            delete sessoes[telefoneKey];
            return await iniciarSessao(telefoneKey, telefone, cliente, contactId);
        }

        // Processar baseado na etapa atual
        switch (sessao.etapa) {
            case 'menu_principal':
                return await processarMenuPrincipal(telefoneKey, telefone, textoLimpo, sessao);
            case 'parcelamento':
                return await processarParcelamento(telefoneKey, telefone, textoLimpo, sessao);
            case 'confirmacao':
                return await processarConfirmacao(telefoneKey, telefone, textoLimpo, sessao);
            case 'atendente':
                return null; // Não processar, deixar pro humano
            default:
                return await iniciarSessao(telefoneKey, telefone, cliente, contactId);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHATBOT: INICIAR SESSÃO
    // ═══════════════════════════════════════════════════════════════

    async function iniciarSessao(telefoneKey, telefone, cliente, contactId) {
        var cobrancas = await buscarCobrancasCliente(cliente.id);
        var valorTotal = parseFloat(cliente.valor_total) || 0;
        var maiorAtraso = parseInt(cliente.maior_atraso) || 0;
        var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];

        sessoes[telefoneKey] = {
            cliente_id: cliente.id,
            etapa: 'menu_principal',
            valor_total: valorTotal,
            cobrancas: cobrancas,
            nome: primeiroNome,
            credores: cliente.credores_nomes || '',
            desconto: 0,
            parcelas: 1,
            contactId: contactId || null,
            timestamp: Date.now()
        };

        var msg = '📋 *ACERTIVE - Assessoria e Cobrança*\n\n';
        msg += 'Olá *' + primeiroNome + '*, identificamos pendências em seu nome:\n\n';

        for (var i = 0; i < cobrancas.length && i < 5; i++) {
            var c = cobrancas[i];
            var venc = c.data_vencimento ? new Date(c.data_vencimento).toLocaleDateString('pt-BR') : '-';
            var atraso = Math.max(0, Math.floor((new Date() - new Date(c.data_vencimento)) / (1000*60*60*24)));
            msg += '▸ ' + (c.credor_nome || c.descricao || 'Cobrança') + '\n';
            msg += '   Valor: *' + formatarMoeda(c.valor) + '* | Venc: ' + venc;
            if (atraso > 0) msg += ' (' + atraso + ' dias)';
            msg += '\n\n';
        }
        if (cobrancas.length > 5) msg += '... e mais ' + (cobrancas.length - 5) + ' cobranças\n\n';

        msg += '━━━━━━━━━━━━━━━━━━━━\n';
        msg += '💰 *TOTAL: ' + formatarMoeda(valorTotal) + '*\n';
        msg += '━━━━━━━━━━━━━━━━━━━━\n\n';
        msg += 'Como deseja resolver?\n\n';
        msg += '*1️⃣* - Pagar à vista (10% desconto)\n';
        msg += '*2️⃣* - Parcelar o débito\n';
        msg += '*3️⃣* - Já realizei o pagamento\n';
        msg += '*4️⃣* - Falar com um atendente\n\n';
        msg += '_Digite o número da opção desejada_';

        var resultado = await enviarMensagemTexto(telefone, msg, contactId);
        console.log('[SURI BOT] Menu enviado:', resultado.success ? 'OK' : 'FALHOU');
        return 'menu_enviado';
    }

    // ═══════════════════════════════════════════════════════════════
    // CHATBOT: PROCESSAR MENU PRINCIPAL
    // ═══════════════════════════════════════════════════════════════

    async function processarMenuPrincipal(telefoneKey, telefone, texto, sessao) {
        var opcao = texto.replace(/[^0-9]/g, '');
        var cId = sessao.contactId;

        if (opcao === '1') {
            // PAGAR À VISTA COM DESCONTO
            var valorComDesconto = sessao.valor_total * 0.90;
            sessao.desconto = 10;
            sessao.parcelas = 1;
            sessao.valor_final = valorComDesconto;
            sessao.etapa = 'confirmacao';

            var msg = '✅ *PAGAMENTO À VISTA*\n\n';
            msg += '💰 Valor original: ~' + formatarMoeda(sessao.valor_total) + '~\n';
            msg += '🏷️ Desconto à vista: *10%*\n';
            msg += '✨ *Valor com desconto: ' + formatarMoeda(valorComDesconto) + '*\n\n';
            msg += 'Deseja confirmar este acordo?\n\n';
            msg += '*1️⃣* - ✅ Sim, confirmar\n';
            msg += '*2️⃣* - ↩️ Voltar ao menu\n';

            await enviarMensagemTexto(telefone, msg, cId);
            return 'pix_opcao';

        } else if (opcao === '2') {
            // PARCELAR
            sessao.etapa = 'parcelamento';
            
            var msg = '📊 *OPÇÕES DE PARCELAMENTO*\n\n';
            msg += 'Valor total: *' + formatarMoeda(sessao.valor_total) + '*\n\n';

            var opcoes = [
                { parcelas: 2, desconto: 5 },
                { parcelas: 3, desconto: 3 },
                { parcelas: 4, desconto: 0 },
                { parcelas: 6, desconto: 0 },
                { parcelas: 10, desconto: 0 },
                { parcelas: 12, desconto: 0 }
            ];

            for (var i = 0; i < opcoes.length; i++) {
                var op = opcoes[i];
                var valorDesc = sessao.valor_total * (1 - op.desconto/100);
                var valorParcela = valorDesc / op.parcelas;
                msg += '*' + (i + 1) + '️⃣* - ' + op.parcelas + 'x de *' + formatarMoeda(valorParcela) + '*';
                if (op.desconto > 0) msg += ' (' + op.desconto + '% desc.)';
                msg += '\n';
            }
            msg += '\n*7️⃣* - ↩️ Voltar ao menu\n\n_Digite o número da opção_';

            await enviarMensagemTexto(telefone, msg, cId);
            return 'parcelamento_opcao';

        } else if (opcao === '3') {
            // JÁ PAGUEI
            sessao.etapa = 'atendente';
            var msg = '🔍 *VERIFICAÇÃO DE PAGAMENTO*\n\n';
            msg += 'Obrigado por informar, ' + sessao.nome + '!\n\n';
            msg += 'Um atendente verificará o pagamento em até *24 horas úteis*.\n\n';
            msg += 'Se tiver o comprovante, pode enviar aqui que agilizamos a baixa! 📄\n\n';
            msg += '🕐 Aguarde nosso retorno.';

            await enviarMensagemTexto(telefone, msg, cId);

            try {
                await pool.query(
                    "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'info_pagamento', 'Cliente informou que já pagou via chatbot - Verificar comprovante', NOW())",
                    [sessao.cliente_id]
                );
            } catch(e) { console.error('[SURI BOT] Erro registrar:', e); }
            return 'ja_paguei';

        } else if (opcao === '4') {
            // FALAR COM ATENDENTE
            sessao.etapa = 'atendente';
            var msg = '👤 *ATENDIMENTO HUMANO*\n\n';
            msg += 'Certo, ' + sessao.nome + '! Vou transferir para um atendente.\n\n';
            msg += '🕐 Horário de atendimento:\n';
            msg += 'Segunda a Quinta, 8h às 17h30\n\n';
            msg += 'Fora do horário, retornaremos assim que possível. 🙏';

            await enviarMensagemTexto(telefone, msg, cId);
            return 'atendente';

        } else {
            var msg = '⚠️ Opção inválida. Por favor, digite o *número*:\n\n';
            msg += '*1️⃣* - Pagar à vista (10% desc.)\n';
            msg += '*2️⃣* - Parcelar\n';
            msg += '*3️⃣* - Já paguei\n';
            msg += '*4️⃣* - Falar com atendente';

            await enviarMensagemTexto(telefone, msg, cId);
            return 'opcao_invalida';
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CHATBOT: PROCESSAR PARCELAMENTO
    // ═══════════════════════════════════════════════════════════════

    async function processarParcelamento(telefoneKey, telefone, texto, sessao) {
        var opcao = texto.replace(/[^0-9]/g, '');
        var cId = sessao.contactId;

        var opcoes = [
            { parcelas: 2, desconto: 5 },
            { parcelas: 3, desconto: 3 },
            { parcelas: 4, desconto: 0 },
            { parcelas: 6, desconto: 0 },
            { parcelas: 10, desconto: 0 },
            { parcelas: 12, desconto: 0 }
        ];

        if (opcao === '7') {
            sessao.etapa = 'menu_principal';
            var cliente = await buscarClientePorTelefone(telefone);
            if (cliente) return await iniciarSessao(telefoneKey, telefone, cliente, cId);
            return 'voltar_menu';
        }

        var idx = parseInt(opcao) - 1;
        if (idx >= 0 && idx < opcoes.length) {
            var escolha = opcoes[idx];
            var valorDesc = sessao.valor_total * (1 - escolha.desconto/100);
            var valorParcela = valorDesc / escolha.parcelas;

            sessao.desconto = escolha.desconto;
            sessao.parcelas = escolha.parcelas;
            sessao.valor_final = valorDesc;
            sessao.etapa = 'confirmacao';

            var msg = '✅ *CONFIRMAÇÃO DE PARCELAMENTO*\n\n';
            msg += '💰 Valor original: ' + formatarMoeda(sessao.valor_total) + '\n';
            if (escolha.desconto > 0) msg += '🏷️ Desconto: *' + escolha.desconto + '%*\n';
            msg += '📋 *' + escolha.parcelas + 'x de ' + formatarMoeda(valorParcela) + '*\n';
            msg += '✨ Total: *' + formatarMoeda(valorDesc) + '*\n\n';
            msg += 'Confirma este acordo?\n\n*1️⃣* - ✅ Sim, confirmar\n*2️⃣* - ↩️ Voltar';

            await enviarMensagemTexto(telefone, msg, cId);
            return 'confirmacao_parcelamento';
        }

        await enviarMensagemTexto(telefone, '⚠️ Opção inválida. Digite *1 a 6* ou *7* para voltar.', cId);
        return 'opcao_invalida';
    }

    // ═══════════════════════════════════════════════════════════════
    // CHATBOT: PROCESSAR CONFIRMAÇÃO
    // ═══════════════════════════════════════════════════════════════

    async function processarConfirmacao(telefoneKey, telefone, texto, sessao) {
        var opcao = texto.replace(/[^0-9]/g, '');
        var cId = sessao.contactId;

        if (opcao === '1') {
            // CONFIRMAR ACORDO
            var valorParcela = sessao.valor_final / sessao.parcelas;
            var msg = '';

            if (sessao.parcelas === 1) {
                msg = '🎉 *ACORDO CONFIRMADO!*\n\n';
                msg += '💳 *Pagamento à vista*\n';
                msg += 'Valor: *' + formatarMoeda(sessao.valor_final) + '*\n\n';
                msg += 'Um atendente enviará os dados para pagamento (PIX/boleto) em breve!\n\n';
                msg += '⚠️ Validade do acordo: *48 horas*\n\n';
                msg += 'Obrigado por regularizar sua situação, ' + sessao.nome + '! 🙏';
            } else {
                msg = '🎉 *ACORDO CONFIRMADO!*\n\n';
                msg += '📋 *Resumo do acordo*\n';
                msg += '━━━━━━━━━━━━━━━━━━━━\n';
                msg += 'Parcelas: *' + sessao.parcelas + 'x de ' + formatarMoeda(valorParcela) + '*\n';
                msg += 'Total: *' + formatarMoeda(sessao.valor_final) + '*\n';
                msg += '━━━━━━━━━━━━━━━━━━━━\n\n';
                msg += 'Um atendente entrará em contato para:\n';
                msg += '✅ Confirmar datas de vencimento\n';
                msg += '✅ Enviar boletos/PIX das parcelas\n';
                msg += '✅ Formalizar o acordo\n\n';
                msg += 'Obrigado por regularizar, ' + sessao.nome + '! 🙏';
            }

            sessao.etapa = 'atendente';
            await enviarMensagemTexto(telefone, msg, cId);

            // Registrar acordo no banco
            try {
                var descAcordo = 'Acordo via chatbot: ' + sessao.parcelas + 'x de ' + formatarMoeda(valorParcela) + ' (desc ' + sessao.desconto + '%) - Total: ' + formatarMoeda(sessao.valor_final);
                await pool.query(
                    "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'acordo_chatbot', $2, NOW())",
                    [sessao.cliente_id, descAcordo]
                );
                await pool.query(
                    "UPDATE clientes SET status_cobranca = 'negociando', updated_at = NOW() WHERE id = $1",
                    [sessao.cliente_id]
                );
                console.log('[SURI BOT] ✅ Acordo registrado:', descAcordo);
            } catch (e) { console.error('[SURI BOT] Erro ao registrar acordo:', e); }

            return 'acordo_confirmado';

        } else if (opcao === '2') {
            // VOLTAR AO MENU
            delete sessoes[telefoneKey];
            var cliente = await buscarClientePorTelefone(telefone);
            if (cliente) return await iniciarSessao(telefoneKey, telefone, cliente, cId);
            return 'voltar_menu';
        }

        await enviarMensagemTexto(telefone, '⚠️ Digite *1* para confirmar ou *2* para voltar.', cId);
        return 'opcao_invalida';
    }

    // ═══════════════════════════════════════════════════════════════
    // API: ENVIAR MENSAGEM (Template)
    // ═══════════════════════════════════════════════════════════════

    router.post('/enviar-mensagem', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            var assunto = req.body.assunto || 'uma pendência financeira';
            if (!cliente_id) return res.status(400).json({ success: false, error: 'Cliente é obrigatório' });

            var clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
            if (clienteResult.rowCount === 0) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

            var cliente = clienteResult.rows[0];
            var telefone = formatarTelefone(cliente.telefone || cliente.celular);
            if (!telefone) return res.status(400).json({ success: false, error: 'Cliente sem telefone' });

            var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];
            var resultado = await enviarTemplateComImport(cliente, telefone, SURI_CONFIG.templateId, [primeiroNome, assunto]);

            if (resultado.success) {
                var telefoneKey = limparTelefone(telefone);
                delete sessoes[telefoneKey];
                await pool.query('INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())', [cliente_id, req.user.id, 'whatsapp', 'suri', 'enviado', 'Mensagem Suri - Assunto: ' + assunto]);
                await pool.query('UPDATE clientes SET data_ultimo_contato = NOW(), updated_at = NOW() WHERE id = $1', [cliente_id]);
                res.json({ success: true, message: 'Mensagem enviada!', data: resultado.data });
            } else {
                res.status(500).json({ success: false, error: resultado.error || 'Erro ao enviar' });
            }
        } catch (error) {
            console.error('[SURI] Erro:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // API: ENVIAR COBRANÇA (usado pela Fila de Trabalho)
    // ═══════════════════════════════════════════════════════════════

    router.post('/enviar-cobranca', auth, async function(req, res) {
        try {
            var cliente_id = req.body.cliente_id;
            var tipo_mensagem = req.body.tipo_mensagem || 'lembrete';
            if (!cliente_id) return res.status(400).json({ success: false, error: 'Cliente é obrigatório' });

            var clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
            if (clienteResult.rowCount === 0) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

            var cliente = clienteResult.rows[0];
            var telefone = formatarTelefone(cliente.telefone || cliente.celular);
            if (!telefone) return res.status(400).json({ success: false, error: 'Cliente sem telefone' });

            var cobrancasResult = await pool.query("SELECT SUM(valor) as total FROM cobrancas WHERE cliente_id = $1 AND status IN ('pendente', 'vencido')", [cliente_id]);
            var valorTotal = parseFloat(cobrancasResult.rows[0].total) || 0;
            var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];

            var assuntos = { lembrete: 'sua pendência financeira', urgente: 'um débito urgente em seu nome', negociacao: 'uma proposta de negociação', acordo: 'uma oportunidade de acordo' };
            var assunto = valorTotal > 0 ? 'seu débito de ' + formatarMoeda(valorTotal) : assuntos[tipo_mensagem] || assuntos.lembrete;

            var resultado = await enviarTemplateComImport(cliente, telefone, SURI_CONFIG.templateId, [primeiroNome, assunto]);

            if (resultado.success) {
                var telefoneKey = limparTelefone(telefone);
                delete sessoes[telefoneKey];
                await pool.query('INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())', [cliente_id, req.user.id, 'whatsapp', 'suri', 'enviado', 'Cobrança: ' + tipo_mensagem]);
                await pool.query('UPDATE clientes SET data_ultimo_contato = NOW(), updated_at = NOW() WHERE id = $1', [cliente_id]);
                res.json({ success: true, message: 'Cobrança enviada!', tipo: tipo_mensagem, assunto: assunto });
            } else {
                res.status(500).json({ success: false, error: resultado.error || 'Erro ao enviar' });
            }
        } catch (error) {
            console.error('[SURI] Erro cobrança:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // WEBHOOK: RECEBER EVENTOS DA SURI
    // ═══════════════════════════════════════════════════════════════

    router.post('/webhook', async function(req, res) {
        try {
            var evento = req.body;
            console.log('[SURI WEBHOOK] ═══════════════════════════════════════');
            console.log('[SURI WEBHOOK] Tipo:', evento.type || evento.event || 'unknown');
            console.log('[SURI WEBHOOK] Dados:', JSON.stringify(evento).substring(0, 1500));
            console.log('[SURI WEBHOOK] ═══════════════════════════════════════');

            var tipo = evento.type || evento.event || 'unknown';

            switch (tipo) {
                case 'new-contact':
                    await processarNovoContato(evento);
                    break;
                case 'message-received':
                    await processarMensagemRecebida(evento);
                    break;
                case 'change-queue':
                    console.log('[SURI WEBHOOK] Mudança de fila');
                    break;
                case 'finish-attendance':
                    await processarFinalizacaoAtendimento(evento);
                    break;
                default:
                    console.log('[SURI WEBHOOK] Tipo não tratado:', tipo);
            }

            res.json({ success: true });
        } catch (error) {
            console.error('[SURI WEBHOOK] Erro:', error);
            res.status(200).json({ success: true }); // Sempre 200 pra Suri não reenviar
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // WEBHOOK: DEBUG - Ver logs e sessões
    // ═══════════════════════════════════════════════════════════════

    router.get('/webhook-logs', auth, async function(req, res) {
        res.json({
            success: true,
            sessoes_ativas: Object.keys(sessoes).length,
            sessoes: sessoes,
            config: {
                endpoint: SURI_CONFIG.endpoint,
                channelId: SURI_CONFIG.channelId,
                templateId: SURI_CONFIG.templateId,
                webhook_url: 'https://acertivecobranca.com.br/api/suri/webhook'
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // TESTE: Enviar mensagem de texto para testar endpoint
    // ═══════════════════════════════════════════════════════════════

    router.post('/teste-texto', auth, async function(req, res) {
        try {
            var telefone = req.body.telefone;
            var texto = req.body.texto || 'Teste de mensagem ACERTIVE';
            if (!telefone) return res.status(400).json({ success: false, error: 'Telefone obrigatório' });

            var telFormatado = formatarTelefone(telefone);
            console.log('[SURI TESTE] Enviando texto para:', telFormatado);

            var resultado = await enviarMensagemTexto(telFormatado, texto, null);
            res.json({ success: resultado.success, metodo: resultado.metodo || null, error: resultado.error || null, tentativas: resultado.tentativas || null });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Processar novo contato
    async function processarNovoContato(evento) {
        try {
            var contato = evento.contact || evento.data || evento;
            var telefone = contato.phone || contato.telefone;
            if (!telefone) return;

            var cliente = await buscarClientePorTelefone(telefone);
            if (cliente) {
                console.log('[SURI] Novo contato identificado:', cliente.nome);
                await pool.query(
                    "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'novo_contato', 'Cliente iniciou contato via WhatsApp', NOW())",
                    [cliente.id]
                );
            }
        } catch (error) { console.error('[SURI] Erro novo contato:', error); }
    }

    // ═══════════════════════════════════════════════════════════════
    // PROCESSAR MENSAGEM RECEBIDA (CORAÇÃO DO CHATBOT)
    // ═══════════════════════════════════════════════════════════════

    async function processarMensagemRecebida(evento) {
        try {
            console.log('[SURI BOT] ────────────────────────────────────');
            console.log('[SURI BOT] MENSAGEM RECEBIDA');
            
            // Extrair dados - testar várias estruturas possíveis
            var mensagem = evento.message || evento.data || evento;
            var contato = mensagem.contact || evento.contact || {};

            console.log('[SURI BOT] Keys evento:', Object.keys(evento));
            if (mensagem !== evento) console.log('[SURI BOT] Keys mensagem:', Object.keys(mensagem));
            console.log('[SURI BOT] Keys contato:', Object.keys(contato));

            var telefone = contato.phone || contato.telefone || mensagem.from || mensagem.phone || evento.phone;
            var texto = mensagem.text || mensagem.body || mensagem.message || mensagem.content || evento.text || '';
            var contactId = contato.id || contato._id || mensagem.contactId || evento.contactId;

            console.log('[SURI BOT] Telefone:', telefone);
            console.log('[SURI BOT] Texto:', texto);
            console.log('[SURI BOT] ContactId:', contactId);
            console.log('[SURI BOT] ────────────────────────────────────');

            if (!telefone || !texto) {
                console.log('[SURI BOT] Sem telefone ou texto - ignorando');
                return;
            }

            // Ignorar mensagens do próprio bot/sistema
            if (mensagem.fromMe === true || mensagem.direction === 'sent' || mensagem.isFromMe === true) {
                console.log('[SURI BOT] Mensagem enviada por nós - ignorando');
                return;
            }

            // Buscar cliente no banco
            var cliente = await buscarClientePorTelefone(telefone);

            if (!cliente) {
                console.log('[SURI BOT] Cliente NÃO encontrado para:', telefone);
                return;
            }

            console.log('[SURI BOT] ✅ Cliente:', cliente.nome, '| Valor:', cliente.valor_total, '| Cobranças:', cliente.qtd_cobrancas);

            var valorTotal = parseFloat(cliente.valor_total) || 0;
            if (valorTotal <= 0) {
                console.log('[SURI BOT] Cliente sem cobranças pendentes - ignorando');
                return;
            }

            // Registrar mensagem recebida
            try {
                await pool.query(
                    "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'resposta_recebida', $2, NOW())",
                    [cliente.id, 'WhatsApp: ' + texto.substring(0, 500)]
                );
            } catch(e) { /* ignora erro de log */ }

            // PROCESSAR NO CHATBOT
            var resultado = await processarChatbot(telefone, texto, cliente, contactId);
            console.log('[SURI BOT] Resultado chatbot:', resultado);

        } catch (error) {
            console.error('[SURI BOT] ❌ Erro ao processar:', error);
        }
    }

    // Processar finalização de atendimento
    async function processarFinalizacaoAtendimento(evento) {
        try {
            var atendimento = evento.attendance || evento.data || evento;
            var contato = atendimento.contact || {};
            var telefone = contato.phone || contato.telefone;
            if (!telefone) return;

            var telefoneKey = limparTelefone(telefone);
            delete sessoes[telefoneKey];
            console.log('[SURI] Sessão limpa para:', telefoneKey);

            var cliente = await buscarClientePorTelefone(telefone);
            if (cliente) {
                await pool.query(
                    "INSERT INTO acionamentos (cliente_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, 'whatsapp', 'suri', 'atendimento_finalizado', 'Atendimento WhatsApp finalizado', NOW())",
                    [cliente.id]
                );
            }
        } catch (error) { console.error('[SURI] Erro finalização:', error); }
    }

    // ═══════════════════════════════════════════════════════════════
    // API: DISPARO EM MASSA
    // ═══════════════════════════════════════════════════════════════

    router.post('/disparo-massa', auth, async function(req, res) {
        try {
            var tipo_mensagem = req.body.tipo_mensagem || 'lembrete';
            var filtro_atraso_min = req.body.filtro_atraso_min || 0;
            var filtro_atraso_max = req.body.filtro_atraso_max || 9999;
            var limite = req.body.limite || 50;

            var query = "SELECT c.id, c.nome, c.telefone, c.celular, c.cpf_cnpj, c.email, " +
                "SUM(cob.valor) as valor_total, COUNT(cob.id) as qtd_cobrancas " +
                "FROM clientes c " +
                "JOIN cobrancas cob ON cob.cliente_id = c.id AND cob.status IN ('pendente', 'vencido') " +
                "WHERE c.ativo = true AND (c.telefone IS NOT NULL OR c.celular IS NOT NULL) " +
                "AND c.status_cobranca NOT IN ('acordo', 'incobravel', 'juridico') " +
                "GROUP BY c.id " +
                "HAVING MAX(CURRENT_DATE - cob.data_vencimento) BETWEEN $1 AND $2 " +
                "ORDER BY MAX(CURRENT_DATE - cob.data_vencimento) DESC LIMIT $3";

            var result = await pool.query(query, [filtro_atraso_min, filtro_atraso_max, limite]);
            var clientes = result.rows;
            var enviados = 0;
            var erros = [];

            var assuntos = { lembrete: 'sua pendência financeira', urgente: 'um débito urgente em seu nome', negociacao: 'uma proposta de negociação', acordo: 'uma oportunidade de acordo' };

            for (var i = 0; i < clientes.length; i++) {
                var cliente = clientes[i];
                try {
                    var telefone = formatarTelefone(cliente.telefone || cliente.celular);
                    if (!telefone) continue;
                    var primeiroNome = (cliente.nome || 'Cliente').split(' ')[0];
                    var valorTotal = parseFloat(cliente.valor_total) || 0;
                    var assunto = valorTotal > 0 ? 'seu débito de ' + formatarMoeda(valorTotal) : assuntos[tipo_mensagem] || assuntos.lembrete;

                    var telefoneKey = limparTelefone(telefone);
                    delete sessoes[telefoneKey];

                    var resultado = await enviarTemplateComImport(cliente, telefone, SURI_CONFIG.templateId, [primeiroNome, assunto]);
                    if (resultado.success) {
                        enviados++;
                        await pool.query("INSERT INTO acionamentos (cliente_id, operador_id, tipo, canal, resultado, descricao, created_at) VALUES ($1, $2, 'whatsapp', 'suri', 'enviado', $3, NOW())", [cliente.id, req.user.id, 'Disparo: ' + tipo_mensagem]);
                    } else {
                        erros.push({ cliente_id: cliente.id, nome: cliente.nome, erro: resultado.error });
                    }
                    // Delay de 2s entre mensagens
                    await new Promise(function(resolve) { setTimeout(resolve, 2000); });
                } catch (err) { erros.push({ cliente_id: cliente.id, nome: cliente.nome, erro: err.message }); }
            }

            res.json({ success: true, message: 'Disparo concluído!', data: { total: clientes.length, enviados: enviados, erros: erros.length, detalhes: erros } });
        } catch (error) {
            console.error('[SURI] Erro disparo:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // API: STATUS DA INTEGRAÇÃO
    // ═══════════════════════════════════════════════════════════════

    router.get('/status', auth, async function(req, res) {
        try {
            var statsResult = await pool.query(
                "SELECT COUNT(*) FILTER (WHERE tipo = 'whatsapp' AND canal = 'suri' AND DATE(created_at) = CURRENT_DATE) as mensagens_hoje, " +
                "COUNT(*) FILTER (WHERE tipo = 'whatsapp' AND canal = 'suri' AND created_at >= NOW() - INTERVAL '7 days') as mensagens_semana, " +
                "COUNT(*) FILTER (WHERE resultado = 'acordo_chatbot') as acordos_chatbot " +
                "FROM acionamentos"
            );

            res.json({
                success: true,
                data: {
                    conectado: true,
                    endpoint: SURI_CONFIG.endpoint,
                    chatbot_ativo: true,
                    sessoes_ativas: Object.keys(sessoes).length,
                    estatisticas: statsResult.rows[0]
                }
            });
        } catch (error) {
            res.json({ success: false, data: { conectado: false, erro: error.message } });
        }
    });

    return router;
};