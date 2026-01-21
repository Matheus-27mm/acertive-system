/**
 * ROTAS RÉGUA DE COBRANÇA - ACERTIVE
 * Configuração e execução da régua automática de cobrança
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/regua - Listar configurações da régua
    router.get('/', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT * FROM regua_cobranca 
                ORDER BY dias_antes_vencimento DESC, dias_apos_vencimento ASC
            `);
            res.json(result.rows);
        } catch (error) {
            console.error('Erro ao buscar régua:', error);
            res.status(500).json({ error: 'Erro ao buscar configurações' });
        }
    });

    // POST /api/regua - Criar nova etapa da régua
    router.post('/', auth, async (req, res) => {
        try {
            const { 
                nome, 
                dias_antes_vencimento, 
                dias_apos_vencimento,
                tipo_acao,  // 'email', 'whatsapp', 'sms', 'ligacao'
                template_mensagem,
                ativo = true
            } = req.body;

            const result = await pool.query(`
                INSERT INTO regua_cobranca (
                    nome, dias_antes_vencimento, dias_apos_vencimento,
                    tipo_acao, template_mensagem, ativo, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
                RETURNING *
            `, [nome, dias_antes_vencimento, dias_apos_vencimento, tipo_acao, template_mensagem, ativo]);

            await registrarLog(req.user?.id, 'REGUA_CRIADA', 'regua_cobranca', result.rows[0].id, {
                nome
            });

            res.status(201).json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao criar etapa da régua:', error);
            res.status(500).json({ error: 'Erro ao criar configuração' });
        }
    });

    // PUT /api/regua/:id - Atualizar etapa
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { 
                nome, 
                dias_antes_vencimento, 
                dias_apos_vencimento,
                tipo_acao,
                template_mensagem,
                ativo
            } = req.body;

            const result = await pool.query(`
                UPDATE regua_cobranca SET
                    nome = COALESCE($2, nome),
                    dias_antes_vencimento = COALESCE($3, dias_antes_vencimento),
                    dias_apos_vencimento = COALESCE($4, dias_apos_vencimento),
                    tipo_acao = COALESCE($5, tipo_acao),
                    template_mensagem = COALESCE($6, template_mensagem),
                    ativo = COALESCE($7, ativo),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `, [id, nome, dias_antes_vencimento, dias_apos_vencimento, tipo_acao, template_mensagem, ativo]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Etapa não encontrada' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('Erro ao atualizar etapa:', error);
            res.status(500).json({ error: 'Erro ao atualizar' });
        }
    });

    // DELETE /api/regua/:id - Remover etapa
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            await pool.query('DELETE FROM regua_cobranca WHERE id = $1', [id]);
            res.json({ success: true });
        } catch (error) {
            console.error('Erro ao deletar etapa:', error);
            res.status(500).json({ error: 'Erro ao deletar' });
        }
    });

    // POST /api/regua/executar - Executar régua manualmente
    router.post('/executar', auth, async (req, res) => {
        try {
            const resultados = await executarRegua(pool, registrarLog);
            res.json(resultados);
        } catch (error) {
            console.error('Erro ao executar régua:', error);
            res.status(500).json({ error: 'Erro ao executar régua' });
        }
    });

    // GET /api/regua/fila - Ver fila de cobranças pendentes
    router.get('/fila', auth, async (req, res) => {
        try {
            const hoje = new Date().toISOString().split('T')[0];

            // Cobranças que vencem nos próximos 30 dias ou venceram nos últimos 90
            const result = await pool.query(`
                SELECT c.*, 
                       cl.nome as cliente_nome,
                       cl.telefone as cliente_telefone,
                       cl.email as cliente_email,
                       cr.nome as credor_nome,
                       CASE 
                           WHEN c.data_vencimento < CURRENT_DATE THEN 
                               EXTRACT(DAY FROM CURRENT_DATE - c.data_vencimento)::int
                           ELSE 
                               -EXTRACT(DAY FROM c.data_vencimento - CURRENT_DATE)::int
                       END as dias_vencimento
                FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.status = 'pendente'
                  AND c.data_vencimento BETWEEN CURRENT_DATE - INTERVAL '90 days' 
                                            AND CURRENT_DATE + INTERVAL '30 days'
                ORDER BY c.data_vencimento ASC
            `);

            res.json(result.rows);

        } catch (error) {
            console.error('Erro ao buscar fila:', error);
            res.status(500).json({ error: 'Erro ao buscar fila' });
        }
    });

    // GET /api/regua/estatisticas - Estatísticas da régua
    router.get('/estatisticas', auth, async (req, res) => {
        try {
            // Cobranças por status de vencimento
            const vencimentos = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE data_vencimento > CURRENT_DATE) as a_vencer,
                    COUNT(*) FILTER (WHERE data_vencimento = CURRENT_DATE) as vence_hoje,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE 
                                     AND data_vencimento >= CURRENT_DATE - INTERVAL '7 days') as vencido_7dias,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE - INTERVAL '7 days'
                                     AND data_vencimento >= CURRENT_DATE - INTERVAL '30 days') as vencido_30dias,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE - INTERVAL '30 days') as vencido_mais_30
                FROM cobrancas
                WHERE status = 'pendente'
            `);

            // Últimas ações da régua
            const acoes = await pool.query(`
                SELECT * FROM historico 
                WHERE acao LIKE 'REGUA_%'
                ORDER BY created_at DESC
                LIMIT 20
            `);

            res.json({
                vencimentos: vencimentos.rows[0],
                ultimas_acoes: acoes.rows
            });

        } catch (error) {
            console.error('Erro ao buscar estatísticas:', error);
            res.status(500).json({ error: 'Erro ao buscar estatísticas' });
        }
    });

    return router;
};

// Função para executar a régua (pode ser chamada por cron)
async function executarRegua(pool, registrarLog) {
    const resultados = {
        processados: 0,
        emails_enviados: 0,
        whatsapp_gerados: 0,
        erros: []
    };

    try {
        // Buscar etapas ativas da régua
        const etapas = await pool.query(`
            SELECT * FROM regua_cobranca WHERE ativo = true
        `);

        for (const etapa of etapas.rows) {
            // Calcular data alvo baseada na etapa
            let dataQuery = '';
            
            if (etapa.dias_antes_vencimento > 0) {
                // Cobranças que vencem daqui a X dias
                dataQuery = `data_vencimento = CURRENT_DATE + INTERVAL '${etapa.dias_antes_vencimento} days'`;
            } else if (etapa.dias_apos_vencimento > 0) {
                // Cobranças vencidas há X dias
                dataQuery = `data_vencimento = CURRENT_DATE - INTERVAL '${etapa.dias_apos_vencimento} days'`;
            }

            if (!dataQuery) continue;

            // Buscar cobranças que se encaixam nesta etapa
            const cobrancas = await pool.query(`
                SELECT c.*, 
                       cl.nome as cliente_nome,
                       cl.telefone as cliente_telefone,
                       cl.email as cliente_email
                FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                WHERE c.status = 'pendente'
                  AND ${dataQuery}
            `);

            for (const cobranca of cobrancas.rows) {
                resultados.processados++;

                // Preparar mensagem substituindo variáveis
                let mensagem = etapa.template_mensagem || '';
                mensagem = mensagem.replace('{cliente_nome}', cobranca.cliente_nome);
                mensagem = mensagem.replace('{valor}', parseFloat(cobranca.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
                mensagem = mensagem.replace('{vencimento}', new Date(cobranca.data_vencimento).toLocaleDateString('pt-BR'));
                mensagem = mensagem.replace('{descricao}', cobranca.descricao);

                // Executar ação baseada no tipo
                switch (etapa.tipo_acao) {
                    case 'email':
                        // Lógica de envio de email seria aqui
                        resultados.emails_enviados++;
                        break;
                    case 'whatsapp':
                        // Gerar link de WhatsApp
                        resultados.whatsapp_gerados++;
                        break;
                }

                // Registrar ação
                await pool.query(`
                    UPDATE cobrancas 
                    SET observacoes = COALESCE(observacoes, '') || E'\n[RÉGUA] ' || $2 || ' - ' || NOW()
                    WHERE id = $1
                `, [cobranca.id, etapa.nome]);

                await registrarLog(null, 'REGUA_EXECUTADA', 'cobrancas', cobranca.id, {
                    etapa: etapa.nome,
                    tipo_acao: etapa.tipo_acao
                });
            }
        }

    } catch (error) {
        resultados.erros.push(error.message);
    }

    return resultados;
}

module.exports.executarRegua = executarRegua;
