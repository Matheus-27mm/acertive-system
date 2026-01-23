/**
 * ========================================
 * ACERTIVE - Módulo de Acionamentos
 * routes/acionamentos.js
 * ========================================
 * Unifica: regua, agendamentos, historico
 */

const express = require('express');

module.exports = function(pool, auth, authAdmin, registrarLog) {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // RÉGUA DE COBRANÇA
    // ═══════════════════════════════════════════════════════════════

    // GET /api/acionamentos/regua - Listar configurações da régua
    router.get('/regua', auth, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM regua_cobranca ORDER BY dias_antes_vencimento DESC, dias_apos_vencimento ASC');
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar régua' });
        }
    });

    // POST /api/acionamentos/regua - Criar etapa
    router.post('/regua', auth, async (req, res) => {
        try {
            const { nome, dias_antes_vencimento, dias_apos_vencimento, tipo_acao, template_mensagem, ativo = true } = req.body;

            const result = await pool.query(`
                INSERT INTO regua_cobranca (nome, dias_antes_vencimento, dias_apos_vencimento, tipo_acao, template_mensagem, ativo, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *
            `, [nome, dias_antes_vencimento, dias_apos_vencimento, tipo_acao, template_mensagem, ativo]);

            await registrarLog(req.user?.id, 'REGUA_CRIADA', 'regua_cobranca', result.rows[0].id, { nome });
            res.status(201).json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao criar etapa' });
        }
    });

    // PUT /api/acionamentos/regua/:id - Atualizar etapa
    router.put('/regua/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { nome, dias_antes_vencimento, dias_apos_vencimento, tipo_acao, template_mensagem, ativo } = req.body;

            const result = await pool.query(`
                UPDATE regua_cobranca SET
                    nome = COALESCE($2, nome), dias_antes_vencimento = COALESCE($3, dias_antes_vencimento),
                    dias_apos_vencimento = COALESCE($4, dias_apos_vencimento), tipo_acao = COALESCE($5, tipo_acao),
                    template_mensagem = COALESCE($6, template_mensagem), ativo = COALESCE($7, ativo), updated_at = NOW()
                WHERE id = $1 RETURNING *
            `, [id, nome, dias_antes_vencimento, dias_apos_vencimento, tipo_acao, template_mensagem, ativo]);

            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Etapa não encontrada' });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao atualizar etapa' });
        }
    });

    // DELETE /api/acionamentos/regua/:id
    router.delete('/regua/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            await pool.query('DELETE FROM regua_cobranca WHERE id = $1', [id]);
            res.json({ success: true, message: 'Etapa removida' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao deletar etapa' });
        }
    });

    // POST /api/acionamentos/regua/executar - Executar régua manualmente
    router.post('/regua/executar', auth, async (req, res) => {
        try {
            const resultados = { processados: 0, emails_enviados: 0, whatsapp_gerados: 0, erros: [] };

            const etapas = await pool.query('SELECT * FROM regua_cobranca WHERE ativo = true');

            for (const etapa of etapas.rows) {
                let dataQuery = '';
                
                if (etapa.dias_antes_vencimento > 0) {
                    dataQuery = `data_vencimento = CURRENT_DATE + INTERVAL '${etapa.dias_antes_vencimento} days'`;
                } else if (etapa.dias_apos_vencimento > 0) {
                    dataQuery = `data_vencimento = CURRENT_DATE - INTERVAL '${etapa.dias_apos_vencimento} days'`;
                }

                if (!dataQuery) continue;

                const cobrancas = await pool.query(`
                    SELECT c.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone, cl.email as cliente_email
                    FROM cobrancas c
                    JOIN clientes cl ON c.cliente_id = cl.id
                    WHERE c.status = 'pendente' AND ${dataQuery}
                `);

                for (const cobranca of cobrancas.rows) {
                    resultados.processados++;

                    let mensagem = etapa.template_mensagem || '';
                    mensagem = mensagem.replace('{cliente_nome}', cobranca.cliente_nome);
                    mensagem = mensagem.replace('{valor}', parseFloat(cobranca.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
                    mensagem = mensagem.replace('{vencimento}', new Date(cobranca.data_vencimento).toLocaleDateString('pt-BR'));
                    mensagem = mensagem.replace('{descricao}', cobranca.descricao);

                    if (etapa.tipo_acao === 'email') resultados.emails_enviados++;
                    else if (etapa.tipo_acao === 'whatsapp') resultados.whatsapp_gerados++;

                    await pool.query(`UPDATE cobrancas SET observacoes = CONCAT(observacoes, '\n[RÉGUA] ', $2, ' - ', NOW()) WHERE id = $1`, [cobranca.id, etapa.nome]);
                    await registrarLog(null, 'REGUA_EXECUTADA', 'cobrancas', cobranca.id, { etapa: etapa.nome, tipo_acao: etapa.tipo_acao });
                }
            }

            res.json({ success: true, data: resultados });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao executar régua' });
        }
    });

    // GET /api/acionamentos/fila - Fila de cobranças
    router.get('/fila', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT c.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone, cl.email as cliente_email, cr.nome as credor_nome,
                       CASE 
                           WHEN c.data_vencimento < CURRENT_DATE THEN EXTRACT(DAY FROM CURRENT_DATE - c.data_vencimento)::int
                           ELSE -EXTRACT(DAY FROM c.data_vencimento - CURRENT_DATE)::int
                       END as dias_vencimento
                FROM cobrancas c
                JOIN clientes cl ON c.cliente_id = cl.id
                LEFT JOIN credores cr ON c.credor_id = cr.id
                WHERE c.status = 'pendente'
                  AND c.data_vencimento BETWEEN CURRENT_DATE - INTERVAL '90 days' AND CURRENT_DATE + INTERVAL '30 days'
                ORDER BY c.data_vencimento ASC
            `);

            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar fila' });
        }
    });

    // GET /api/acionamentos/regua/estatisticas
    router.get('/regua/estatisticas', auth, async (req, res) => {
        try {
            const vencimentos = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE data_vencimento > CURRENT_DATE) as a_vencer,
                    COUNT(*) FILTER (WHERE data_vencimento = CURRENT_DATE) as vence_hoje,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE AND data_vencimento >= CURRENT_DATE - 7) as vencido_7dias,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE - 7 AND data_vencimento >= CURRENT_DATE - 30) as vencido_30dias,
                    COUNT(*) FILTER (WHERE data_vencimento < CURRENT_DATE - 30) as vencido_mais_30
                FROM cobrancas WHERE status = 'pendente'
            `);

            const acoes = await pool.query(`SELECT * FROM historico WHERE acao LIKE 'REGUA_%' ORDER BY created_at DESC LIMIT 20`);

            res.json({ success: true, data: { vencimentos: vencimentos.rows[0], ultimas_acoes: acoes.rows } });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // AGENDAMENTOS
    // ═══════════════════════════════════════════════════════════════

    // GET /api/acionamentos/agendamentos - Listar agendamentos
    router.get('/agendamentos', auth, async (req, res) => {
        try {
            const { data_inicio, data_fim, status, cliente_id } = req.query;

            let query = `
                SELECT a.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone
                FROM agendamentos a
                LEFT JOIN clientes cl ON a.cliente_id = cl.id
                WHERE 1=1
            `;
            const params = [];
            let idx = 1;

            if (data_inicio) { query += ` AND a.data_agendamento >= $${idx}`; params.push(data_inicio); idx++; }
            if (data_fim) { query += ` AND a.data_agendamento <= $${idx}`; params.push(data_fim); idx++; }
            if (status) { query += ` AND a.status = $${idx}`; params.push(status); idx++; }
            if (cliente_id) { query += ` AND a.cliente_id = $${idx}`; params.push(cliente_id); idx++; }

            query += ' ORDER BY a.data_agendamento ASC, a.hora ASC';

            const result = await pool.query(query, params);
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar agendamentos' });
        }
    });

    // GET /api/acionamentos/agendamentos/hoje
    router.get('/agendamentos/hoje', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT a.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone
                FROM agendamentos a
                LEFT JOIN clientes cl ON a.cliente_id = cl.id
                WHERE a.data_agendamento = CURRENT_DATE AND a.status = 'pendente'
                ORDER BY a.hora ASC
            `);
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar' });
        }
    });

    // GET /api/acionamentos/agendamentos/semana
    router.get('/agendamentos/semana', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT a.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone
                FROM agendamentos a
                LEFT JOIN clientes cl ON a.cliente_id = cl.id
                WHERE a.data_agendamento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND a.status = 'pendente'
                ORDER BY a.data_agendamento ASC, a.hora ASC
            `);
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar' });
        }
    });

    // GET /api/acionamentos/agendamentos/:id
    router.get('/agendamentos/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            if (['hoje', 'semana'].includes(id)) return;

            const result = await pool.query(`
                SELECT a.*, cl.nome as cliente_nome, cl.telefone as cliente_telefone
                FROM agendamentos a
                LEFT JOIN clientes cl ON a.cliente_id = cl.id
                WHERE a.id = $1
            `, [id]);

            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar' });
        }
    });

    // POST /api/acionamentos/agendamentos
    router.post('/agendamentos', auth, async (req, res) => {
        try {
            const { cliente_id, data_agendamento, hora, tipo, descricao, cobranca_id } = req.body;

            if (!data_agendamento) return res.status(400).json({ success: false, error: 'Data é obrigatória' });

            const result = await pool.query(`
                INSERT INTO agendamentos (cliente_id, data_agendamento, hora, tipo, descricao, cobranca_id, status, usuario_id, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7, NOW()) RETURNING *
            `, [cliente_id, data_agendamento, hora, tipo, descricao, cobranca_id, req.user?.id]);

            await registrarLog(req.user?.id, 'AGENDAMENTO_CRIADO', 'agendamentos', result.rows[0].id, { data: data_agendamento, tipo });
            res.status(201).json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao criar agendamento' });
        }
    });

    // PUT /api/acionamentos/agendamentos/:id
    router.put('/agendamentos/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { data_agendamento, hora, tipo, descricao, status } = req.body;

            const result = await pool.query(`
                UPDATE agendamentos SET
                    data_agendamento = COALESCE($2, data_agendamento), hora = COALESCE($3, hora),
                    tipo = COALESCE($4, tipo), descricao = COALESCE($5, descricao), status = COALESCE($6, status), updated_at = NOW()
                WHERE id = $1 RETURNING *
            `, [id, data_agendamento, hora, tipo, descricao, status]);

            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Não encontrado' });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao atualizar' });
        }
    });

    // PUT /api/acionamentos/agendamentos/:id/concluir
    router.put('/agendamentos/:id/concluir', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { observacao } = req.body;

            const result = await pool.query(`
                UPDATE agendamentos SET status = 'concluido', observacao = $2, data_conclusao = NOW(), updated_at = NOW()
                WHERE id = $1 RETURNING *
            `, [id, observacao]);

            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Não encontrado' });

            await registrarLog(req.user?.id, 'AGENDAMENTO_CONCLUIDO', 'agendamentos', id, { observacao });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao concluir' });
        }
    });

    // DELETE /api/acionamentos/agendamentos/:id
    router.delete('/agendamentos/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            await pool.query('DELETE FROM agendamentos WHERE id = $1', [id]);
            res.json({ success: true, message: 'Agendamento removido' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao remover' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // HISTÓRICO
    // ═══════════════════════════════════════════════════════════════

    // GET /api/acionamentos/historico
    router.get('/historico', auth, async (req, res) => {
        try {
            const { usuario_id, acao, tabela, data_inicio, data_fim, page = 1, limit = 50 } = req.query;

            let query = `SELECT h.*, u.nome as usuario_nome FROM historico h LEFT JOIN usuarios u ON h.usuario_id = u.id WHERE 1=1`;
            const params = [];
            let idx = 1;

            if (usuario_id) { query += ` AND h.usuario_id = $${idx}`; params.push(usuario_id); idx++; }
            if (acao) { query += ` AND h.acao = $${idx}`; params.push(acao); idx++; }
            if (tabela) { query += ` AND h.tabela = $${idx}`; params.push(tabela); idx++; }
            if (data_inicio) { query += ` AND h.created_at >= $${idx}`; params.push(data_inicio); idx++; }
            if (data_fim) { query += ` AND h.created_at <= $${idx}`; params.push(data_fim); idx++; }

            query += ' ORDER BY h.created_at DESC';

            const offset = (parseInt(page) - 1) * parseInt(limit);
            query += ` LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), offset);

            const result = await pool.query(query, params);

            const countResult = await pool.query('SELECT COUNT(*) FROM historico');
            const total = parseInt(countResult.rows[0].count);

            res.json({ success: true, data: result.rows, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar histórico' });
        }
    });

    // GET /api/acionamentos/historico/acoes
    router.get('/historico/acoes', auth, async (req, res) => {
        try {
            const result = await pool.query('SELECT DISTINCT acao, COUNT(*) as total FROM historico GROUP BY acao ORDER BY total DESC');
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar ações' });
        }
    });

    // GET /api/acionamentos/historico/registro/:tabela/:id
    router.get('/historico/registro/:tabela/:id', auth, async (req, res) => {
        try {
            const { tabela, id } = req.params;

            const result = await pool.query(`
                SELECT h.*, u.nome as usuario_nome
                FROM historico h LEFT JOIN usuarios u ON h.usuario_id = u.id
                WHERE h.tabela = $1 AND h.registro_id = $2
                ORDER BY h.created_at DESC
            `, [tabela, id]);

            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao buscar histórico' });
        }
    });

    // DELETE /api/acionamentos/historico/limpar - Admin only
    router.delete('/historico/limpar', authAdmin, async (req, res) => {
        try {
            const { dias = 90 } = req.query;

            const result = await pool.query(`DELETE FROM historico WHERE created_at < NOW() - INTERVAL '${parseInt(dias)} days' RETURNING id`);

            res.json({ success: true, registros_removidos: result.rowCount });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao limpar histórico' });
        }
    });

    return router;
};