/**
 * ROTAS DE WHATSAPP - ACERTIVE
 * Geração de links e mensagens para WhatsApp
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/whatsapp/cobranca/:id - Gerar link WhatsApp para cobrança
    router.get('/cobranca/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT c.*, 
                       cl.nome as cliente_nome, 
                       cl.telefone as cliente_telefone,
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

            if (!cobranca.cliente_telefone) {
                return res.status(400).json({ error: 'Cliente não possui telefone cadastrado' });
            }

            // Formatar telefone (remover caracteres especiais)
            let telefone = cobranca.cliente_telefone.replace(/\D/g, '');
            
            // Adicionar código do país se não tiver
            if (telefone.length === 11) {
                telefone = '55' + telefone;
            } else if (telefone.length === 10) {
                telefone = '55' + telefone;
            }

            // Formatar valor
            const valor = parseFloat(cobranca.valor).toLocaleString('pt-BR', {
                style: 'currency',
                currency: 'BRL'
            });

            // Formatar vencimento
            const vencimento = new Date(cobranca.data_vencimento).toLocaleDateString('pt-BR');

            // Montar mensagem
            const mensagem = `Olá ${cobranca.cliente_nome}!

Identificamos uma pendência em seu nome:

📋 *Credor:* ${cobranca.credor_nome || 'Não informado'}
📝 *Descrição:* ${cobranca.descricao}
💰 *Valor:* ${valor}
📅 *Vencimento:* ${vencimento}

Entre em contato conosco para regularizar sua situação. Estamos à disposição para negociar!

_ACERTIVE - Sistema de Cobranças_`;

            // Criar link do WhatsApp
            const link = `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;

            res.json({
                success: true,
                link,
                telefone,
                mensagem
            });

        } catch (error) {
            console.error('Erro ao gerar link WhatsApp:', error);
            res.status(500).json({ error: 'Erro ao gerar link' });
        }
    });

    // GET /api/whatsapp/acordo/:id - Gerar link WhatsApp para acordo
    router.get('/acordo/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT a.*, 
                       cl.nome as cliente_nome, 
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

            if (!acordo.cliente_telefone) {
                return res.status(400).json({ error: 'Cliente não possui telefone cadastrado' });
            }

            let telefone = acordo.cliente_telefone.replace(/\D/g, '');
            if (telefone.length <= 11) {
                telefone = '55' + telefone;
            }

            const valorTotal = parseFloat(acordo.valor_total).toLocaleString('pt-BR', {
                style: 'currency',
                currency: 'BRL'
            });

            const valorParcela = parseFloat(acordo.valor_parcela).toLocaleString('pt-BR', {
                style: 'currency',
                currency: 'BRL'
            });

            const mensagem = `Olá ${acordo.cliente_nome}!

Segue o resumo do seu acordo:

📋 *Credor:* ${acordo.credor_nome || 'Não informado'}
💰 *Valor Total:* ${valorTotal}
📊 *Parcelas:* ${acordo.num_parcelas}x de ${valorParcela}
📅 *Primeiro Vencimento:* ${new Date(acordo.data_primeiro_vencimento).toLocaleDateString('pt-BR')}

Em caso de dúvidas, estamos à disposição!

_ACERTIVE - Sistema de Cobranças_`;

            const link = `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;

            res.json({
                success: true,
                link,
                telefone,
                mensagem
            });

        } catch (error) {
            console.error('Erro ao gerar link WhatsApp:', error);
            res.status(500).json({ error: 'Erro ao gerar link' });
        }
    });

    // POST /api/whatsapp/mensagem-personalizada - Gerar link com mensagem personalizada
    router.post('/mensagem-personalizada', auth, async (req, res) => {
        try {
            const { telefone, mensagem } = req.body;

            if (!telefone || !mensagem) {
                return res.status(400).json({ error: 'Telefone e mensagem são obrigatórios' });
            }

            let tel = telefone.replace(/\D/g, '');
            if (tel.length <= 11) {
                tel = '55' + tel;
            }

            const link = `https://wa.me/${tel}?text=${encodeURIComponent(mensagem)}`;

            res.json({
                success: true,
                link,
                telefone: tel
            });

        } catch (error) {
            console.error('Erro ao gerar link WhatsApp:', error);
            res.status(500).json({ error: 'Erro ao gerar link' });
        }
    });

    // POST /api/whatsapp/registrar-contato/:cobrancaId - Registrar que houve contato
    router.post('/registrar-contato/:cobrancaId', auth, async (req, res) => {
        try {
            const { cobrancaId } = req.params;
            const { observacao } = req.body;

            await pool.query(`
                UPDATE cobrancas 
                SET ultimo_contato = NOW(),
                    observacoes = COALESCE(observacoes, '') || E'\n[' || TO_CHAR(NOW(), 'DD/MM/YYYY HH24:MI') || '] WhatsApp: ' || $2
                WHERE id = $1
            `, [cobrancaId, observacao || 'Contato realizado']);

            await registrarLog(req.user?.id, 'WHATSAPP_CONTATO', 'cobrancas', cobrancaId, {
                observacao
            });

            res.json({ success: true, message: 'Contato registrado' });

        } catch (error) {
            console.error('Erro ao registrar contato:', error);
            res.status(500).json({ error: 'Erro ao registrar contato' });
        }
    });

    return router;
};
