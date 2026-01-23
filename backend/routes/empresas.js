/**
 * ROTAS DE EMPRESAS - ACERTIVE
 * CRUD de empresas/escritórios
 * CORRIGIDO: Aceita todos os campos do formulário
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // GET /api/empresas - Listar empresas
    router.get('/', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT * FROM empresas ORDER BY padrao DESC, nome ASC
            `);
            res.json({ success: true, data: result.rows });
        } catch (error) {
            console.error('Erro ao listar empresas:', error);
            res.status(500).json({ success: false, error: 'Erro ao listar empresas' });
        }
    });

    // GET /api/empresas/padrao - Buscar empresa padrão
    router.get('/padrao', auth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT * FROM empresas WHERE padrao = true LIMIT 1
            `);
            
            if (result.rows.length === 0) {
                const primeira = await pool.query('SELECT * FROM empresas ORDER BY created_at LIMIT 1');
                return res.json({ success: true, data: primeira.rows[0] || null });
            }
            
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('Erro ao buscar empresa padrão:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar empresa' });
        }
    });

    // GET /api/empresas/:id - Buscar empresa específica
    router.get('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            
            // Evitar conflito com outras rotas
            if (id === 'padrao') return;
            
            const result = await pool.query('SELECT * FROM empresas WHERE id = $1', [id]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Empresa não encontrada' });
            }
            
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('Erro ao buscar empresa:', error);
            res.status(500).json({ success: false, error: 'Erro ao buscar empresa' });
        }
    });

    // POST /api/empresas - Criar empresa
    router.post('/', auth, async (req, res) => {
        try {
            console.log('[EMPRESAS] Criando empresa:', req.body);
            
            const { 
                nome, 
                cnpj, 
                endereco, 
                telefone, 
                email, 
                logo_url,
                banco,
                agencia,
                conta,
                digito,
                tipo_conta,
                titular,
                cpf_cnpj_titular,
                tipo_chave_pix,
                chave_pix,
                padrao = false,
                ativo = true
            } = req.body;

            if (!nome) {
                return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
            }

            // Se for padrão, remover padrão das outras
            if (padrao) {
                await pool.query('UPDATE empresas SET padrao = false');
            }

            const result = await pool.query(`
                INSERT INTO empresas (
                    nome, cnpj, endereco, telefone, email, logo_url,
                    banco, agencia, conta, digito, tipo_conta,
                    titular, cpf_cnpj_titular, tipo_chave_pix, chave_pix,
                    padrao, ativo, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
                RETURNING *
            `, [
                nome, 
                cnpj || null, 
                endereco || null, 
                telefone || null, 
                email || null, 
                logo_url || null,
                banco || null,
                agencia || null,
                conta || null,
                digito || null,
                tipo_conta || null,
                titular || null,
                cpf_cnpj_titular || null,
                tipo_chave_pix || null,
                chave_pix || null,
                padrao,
                ativo
            ]);

            console.log('[EMPRESAS] Empresa criada:', result.rows[0].id);

            try {
                await registrarLog(req.user?.id, 'EMPRESA_CRIADA', 'empresas', result.rows[0].id, { nome });
            } catch (logErr) {
                console.error('[EMPRESAS] Erro ao registrar log:', logErr);
            }

            res.status(201).json({ success: true, data: result.rows[0], message: 'Empresa criada com sucesso!' });

        } catch (error) {
            console.error('[EMPRESAS] Erro ao criar empresa:', error);
            res.status(500).json({ success: false, error: 'Erro ao criar empresa: ' + error.message });
        }
    });

    // PUT /api/empresas/:id - Atualizar empresa
    router.put('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;
            const { 
                nome, 
                cnpj, 
                endereco, 
                telefone, 
                email, 
                logo_url,
                banco,
                agencia,
                conta,
                digito,
                tipo_conta,
                titular,
                cpf_cnpj_titular,
                tipo_chave_pix,
                chave_pix,
                padrao,
                ativo
            } = req.body;

            // Se for definir como padrão, remover das outras
            if (padrao === true) {
                await pool.query('UPDATE empresas SET padrao = false WHERE id != $1', [id]);
            }

            const result = await pool.query(`
                UPDATE empresas SET
                    nome = COALESCE($2, nome),
                    cnpj = COALESCE($3, cnpj),
                    endereco = COALESCE($4, endereco),
                    telefone = COALESCE($5, telefone),
                    email = COALESCE($6, email),
                    logo_url = COALESCE($7, logo_url),
                    banco = COALESCE($8, banco),
                    agencia = COALESCE($9, agencia),
                    conta = COALESCE($10, conta),
                    digito = COALESCE($11, digito),
                    tipo_conta = COALESCE($12, tipo_conta),
                    titular = COALESCE($13, titular),
                    cpf_cnpj_titular = COALESCE($14, cpf_cnpj_titular),
                    tipo_chave_pix = COALESCE($15, tipo_chave_pix),
                    chave_pix = COALESCE($16, chave_pix),
                    padrao = COALESCE($17, padrao),
                    ativo = COALESCE($18, ativo),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `, [id, nome, cnpj, endereco, telefone, email, logo_url, 
                banco, agencia, conta, digito, tipo_conta, 
                titular, cpf_cnpj_titular, tipo_chave_pix, chave_pix,
                padrao, ativo]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Empresa não encontrada' });
            }

            res.json({ success: true, data: result.rows[0], message: 'Empresa atualizada!' });

        } catch (error) {
            console.error('[EMPRESAS] Erro ao atualizar empresa:', error);
            res.status(500).json({ success: false, error: 'Erro ao atualizar empresa' });
        }
    });

    // PUT /api/empresas/:id/padrao - Definir empresa como padrão
    router.put('/:id/padrao', auth, async (req, res) => {
        try {
            const { id } = req.params;

            await pool.query('UPDATE empresas SET padrao = false');
            
            const result = await pool.query(`
                UPDATE empresas SET padrao = true, updated_at = NOW() WHERE id = $1 RETURNING *
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Empresa não encontrada' });
            }

            res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error('[EMPRESAS] Erro ao definir empresa padrão:', error);
            res.status(500).json({ success: false, error: 'Erro ao definir padrão' });
        }
    });

    // DELETE /api/empresas/:id - Remover empresa
    router.delete('/:id', auth, async (req, res) => {
        try {
            const { id } = req.params;

            const count = await pool.query('SELECT COUNT(*) FROM empresas');
            if (parseInt(count.rows[0].count) <= 1) {
                return res.status(400).json({ success: false, error: 'Não é possível remover a única empresa' });
            }

            await pool.query('DELETE FROM empresas WHERE id = $1', [id]);

            try {
                await registrarLog(req.user?.id, 'EMPRESA_REMOVIDA', 'empresas', id, {});
            } catch (logErr) {}

            res.json({ success: true, message: 'Empresa removida!' });

        } catch (error) {
            console.error('[EMPRESAS] Erro ao remover empresa:', error);
            res.status(500).json({ success: false, error: 'Erro ao remover empresa' });
        }
    });

    return router;
};