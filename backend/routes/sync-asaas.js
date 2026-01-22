/**
 * ========================================
 * SINCRONIZAÇÃO ASAAS - ACERTIVE
 * Importa clientes e cobranças do Asaas
 * ========================================
 */

const express = require('express');

module.exports = function(pool, auth, registrarLog) {
    const router = express.Router();

    // Configuração Asaas
    const ASAAS_API_URL = process.env.ASAAS_ENV === 'production' 
        ? 'https://www.asaas.com/api/v3'
        : 'https://sandbox.asaas.com/api/v3';
    
    const ASAAS_API_KEY = process.env.ASAAS_ENV === 'production'
        ? process.env.ASAAS_API_KEY
        : process.env.ASAAS_API_KEY_SANDBOX;

    // Função para fazer requisições à API do Asaas
    async function asaasRequest(endpoint, method = 'GET', body = null) {
        console.log(`[ASAAS] ${method} ${endpoint}`);
        
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'access_token': ASAAS_API_KEY
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(`${ASAAS_API_URL}${endpoint}`, options);
            const data = await response.json();
            return data;
        } catch (error) {
            console.error('[ASAAS] Erro na requisição:', error);
            throw error;
        }
    }

    // =====================================================
    // GET /api/sync/status - Verificar status da sincronização
    // =====================================================
    router.get('/status', auth, async (req, res) => {
        try {
            // Contar registros locais
            const clientesLocal = await pool.query('SELECT COUNT(*) FROM clientes');
            const cobrancasLocal = await pool.query('SELECT COUNT(*) FROM cobrancas');
            const cobrancasSincronizadas = await pool.query('SELECT COUNT(*) FROM cobrancas WHERE asaas_id IS NOT NULL');

            // Testar conexão com Asaas
            let asaasStatus = { connected: false };
            try {
                const asaasTest = await asaasRequest('/customers?limit=1');
                asaasStatus = {
                    connected: true,
                    totalCustomers: asaasTest.totalCount || 0
                };
            } catch (e) {
                asaasStatus = { connected: false, error: e.message };
            }

            res.json({
                success: true,
                data: {
                    local: {
                        clientes: parseInt(clientesLocal.rows[0].count),
                        cobrancas: parseInt(cobrancasLocal.rows[0].count),
                        cobrancas_sincronizadas: parseInt(cobrancasSincronizadas.rows[0].count)
                    },
                    asaas: asaasStatus,
                    api_url: ASAAS_API_URL,
                    ambiente: process.env.ASAAS_ENV || 'sandbox'
                }
            });

        } catch (error) {
            console.error('[SYNC] Erro ao verificar status:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // =====================================================
    // POST /api/sync/clientes - Sincronizar clientes do Asaas
    // =====================================================
    router.post('/clientes', auth, async (req, res) => {
        try {
            console.log('[SYNC] Iniciando sincronização de clientes...');
            
            const { empresa_id, credor_id } = req.body;
            
            if (!empresa_id) {
                return res.status(400).json({ success: false, error: 'empresa_id é obrigatório' });
            }

            let offset = 0;
            const limit = 100;
            let totalImportados = 0;
            let totalAtualizados = 0;

            while (true) {
                const response = await asaasRequest(`/customers?offset=${offset}&limit=${limit}`);
                
                if (!response.data || response.data.length === 0) break;

                for (const customer of response.data) {
                    // Verificar se cliente já existe
                    const existe = await pool.query(
                        'SELECT id FROM clientes WHERE asaas_customer_id = $1 OR cpf_cnpj = $2',
                        [customer.id, customer.cpfCnpj]
                    );

                    if (existe.rows.length > 0) {
                        // Atualizar
                        await pool.query(`
                            UPDATE clientes SET
                                nome = COALESCE($1, nome),
                                email = COALESCE($2, email),
                                telefone = COALESCE($3, telefone),
                                celular = COALESCE($4, celular),
                                asaas_customer_id = $5,
                                asaas_sync_at = NOW(),
                                updated_at = NOW()
                            WHERE id = $6
                        `, [
                            customer.name,
                            customer.email,
                            customer.phone,
                            customer.mobilePhone,
                            customer.id,
                            existe.rows[0].id
                        ]);
                        totalAtualizados++;
                    } else {
                        // Inserir novo
                        await pool.query(`
                            INSERT INTO clientes (
                                nome, email, telefone, celular, cpf_cnpj,
                                endereco, cidade, estado, cep,
                                empresa_id, asaas_customer_id, asaas_sync_at,
                                status, ativo, created_at
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), 'ativo', true, NOW())
                        `, [
                            customer.name,
                            customer.email,
                            customer.phone,
                            customer.mobilePhone,
                            customer.cpfCnpj,
                            customer.address ? `${customer.address}, ${customer.addressNumber}` : null,
                            customer.city || customer.cityName,
                            customer.state,
                            customer.postalCode,
                            empresa_id,
                            customer.id
                        ]);
                        totalImportados++;
                    }
                }

                console.log(`[SYNC] Processados ${offset + response.data.length} clientes...`);

                if (!response.hasMore) break;
                offset += limit;
            }

            console.log(`[SYNC] Clientes: ${totalImportados} importados, ${totalAtualizados} atualizados`);

            res.json({
                success: true,
                data: {
                    importados: totalImportados,
                    atualizados: totalAtualizados,
                    total: totalImportados + totalAtualizados
                }
            });

        } catch (error) {
            console.error('[SYNC] Erro ao sincronizar clientes:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // =====================================================
    // POST /api/sync/cobrancas - Sincronizar cobranças do Asaas
    // =====================================================
    router.post('/cobrancas', auth, async (req, res) => {
        try {
            console.log('[SYNC] Iniciando sincronização de cobranças...');
            
            const { empresa_id, credor_id } = req.body;
            
            if (!empresa_id) {
                return res.status(400).json({ success: false, error: 'empresa_id é obrigatório' });
            }

            let offset = 0;
            const limit = 100;
            let totalImportados = 0;
            let totalAtualizados = 0;
            let erros = [];

            while (true) {
                const response = await asaasRequest(`/payments?offset=${offset}&limit=${limit}`);
                
                if (!response.data || response.data.length === 0) break;

                for (const payment of response.data) {
                    try {
                        // Buscar cliente pelo asaas_customer_id
                        let clienteResult = await pool.query(
                            'SELECT id FROM clientes WHERE asaas_customer_id = $1',
                            [payment.customer]
                        );

                        let cliente_id = null;

                        // Se não encontrou, buscar dados do cliente no Asaas e criar
                        if (clienteResult.rows.length === 0) {
                            const customerData = await asaasRequest(`/customers/${payment.customer}`);
                            
                            if (customerData && customerData.id) {
                                // Criar cliente
                                const novoCliente = await pool.query(`
                                    INSERT INTO clientes (
                                        nome, email, telefone, cpf_cnpj,
                                        empresa_id, asaas_customer_id, asaas_sync_at,
                                        status, ativo, created_at
                                    ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'ativo', true, NOW())
                                    RETURNING id
                                `, [
                                    customerData.name,
                                    customerData.email,
                                    customerData.phone || customerData.mobilePhone,
                                    customerData.cpfCnpj,
                                    empresa_id,
                                    customerData.id
                                ]);
                                cliente_id = novoCliente.rows[0].id;
                            }
                        } else {
                            cliente_id = clienteResult.rows[0].id;
                        }

                        if (!cliente_id) {
                            erros.push({ payment_id: payment.id, erro: 'Cliente não encontrado' });
                            continue;
                        }

                        // Mapear status do Asaas para status interno
                        const statusMap = {
                            'PENDING': 'pendente',
                            'RECEIVED': 'pago',
                            'CONFIRMED': 'pago',
                            'OVERDUE': 'vencido',
                            'REFUNDED': 'cancelado',
                            'RECEIVED_IN_CASH': 'pago',
                            'REFUND_REQUESTED': 'cancelado',
                            'CHARGEBACK_REQUESTED': 'cancelado',
                            'CHARGEBACK_DISPUTE': 'cancelado',
                            'AWAITING_CHARGEBACK_REVERSAL': 'pendente',
                            'DUNNING_REQUESTED': 'vencido',
                            'DUNNING_RECEIVED': 'pago',
                            'AWAITING_RISK_ANALYSIS': 'pendente'
                        };

                        const statusInterno = statusMap[payment.status] || 'pendente';

                        // Verificar se cobrança já existe
                        const existe = await pool.query(
                            'SELECT id FROM cobrancas WHERE asaas_id = $1',
                            [payment.id]
                        );

                        if (existe.rows.length > 0) {
                            // Atualizar cobrança existente
                            await pool.query(`
                                UPDATE cobrancas SET
                                    status = $1,
                                    valor_pago = CASE WHEN $1 = 'pago' THEN $2 ELSE valor_pago END,
                                    data_pagamento = CASE WHEN $1 = 'pago' THEN $3 ELSE data_pagamento END,
                                    asaas_invoice_url = $4,
                                    asaas_boleto_url = $5,
                                    asaas_pix_payload = $6,
                                    asaas_pix_qrcode = $7,
                                    asaas_billing_type = $8,
                                    asaas_sync_at = NOW(),
                                    updated_at = NOW()
                                WHERE id = $9
                            `, [
                                statusInterno,
                                payment.value,
                                payment.paymentDate || payment.confirmedDate,
                                payment.invoiceUrl,
                                payment.bankSlipUrl,
                                payment.pixTransaction?.payload,
                                payment.pixTransaction?.qrCodeUrl || payment.pixQrCodeUrl,
                                payment.billingType,
                                existe.rows[0].id
                            ]);
                            totalAtualizados++;
                        } else {
                            // Criar nova cobrança
                            await pool.query(`
                                INSERT INTO cobrancas (
                                    cliente_id, empresa_id, credor_id,
                                    descricao, valor_original, valor_atualizado, valor_total,
                                    vencimento, data_vencimento, status,
                                    valor_pago, data_pagamento,
                                    asaas_id, asaas_invoice_url, asaas_boleto_url,
                                    asaas_pix_payload, asaas_pix_qrcode, asaas_billing_type,
                                    asaas_sync_at, created_at
                                ) VALUES ($1, $2, $3, $4, $5, $5, $5, $6, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
                            `, [
                                cliente_id,
                                empresa_id,
                                credor_id || null,
                                payment.description || 'Cobrança importada do Asaas',
                                payment.value,
                                payment.dueDate,
                                statusInterno,
                                statusInterno === 'pago' ? payment.value : null,
                                payment.paymentDate || payment.confirmedDate,
                                payment.id,
                                payment.invoiceUrl,
                                payment.bankSlipUrl,
                                payment.pixTransaction?.payload,
                                payment.pixTransaction?.qrCodeUrl || payment.pixQrCodeUrl,
                                payment.billingType
                            ]);
                            totalImportados++;
                        }

                    } catch (err) {
                        console.error(`[SYNC] Erro ao processar payment ${payment.id}:`, err.message);
                        erros.push({ payment_id: payment.id, erro: err.message });
                    }
                }

                console.log(`[SYNC] Processadas ${offset + response.data.length} cobranças...`);

                if (!response.hasMore) break;
                offset += limit;
            }

            // Atualizar totais nos credores
            if (credor_id) {
                await atualizarTotaisCredor(pool, credor_id);
            }

            console.log(`[SYNC] Cobranças: ${totalImportados} importadas, ${totalAtualizados} atualizadas, ${erros.length} erros`);

            res.json({
                success: true,
                data: {
                    importados: totalImportados,
                    atualizados: totalAtualizados,
                    erros: erros.length,
                    detalhes_erros: erros.slice(0, 10) // Primeiros 10 erros
                }
            });

        } catch (error) {
            console.error('[SYNC] Erro ao sincronizar cobranças:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // =====================================================
    // POST /api/sync/completa - Sincronização completa
    // =====================================================
    router.post('/completa', auth, async (req, res) => {
        try {
            console.log('[SYNC] Iniciando sincronização COMPLETA...');
            
            const { empresa_id, credor_id } = req.body;
            
            if (!empresa_id) {
                return res.status(400).json({ success: false, error: 'empresa_id é obrigatório' });
            }

            const resultados = {
                clientes: { importados: 0, atualizados: 0 },
                cobrancas: { importados: 0, atualizados: 0, erros: 0 }
            };

            // 1. Sincronizar clientes
            console.log('[SYNC] Etapa 1: Clientes...');
            let offset = 0;
            const limit = 100;

            while (true) {
                const response = await asaasRequest(`/customers?offset=${offset}&limit=${limit}`);
                if (!response.data || response.data.length === 0) break;

                for (const customer of response.data) {
                    const existe = await pool.query(
                        'SELECT id FROM clientes WHERE asaas_customer_id = $1',
                        [customer.id]
                    );

                    if (existe.rows.length > 0) {
                        await pool.query(`
                            UPDATE clientes SET
                                nome = COALESCE($1, nome),
                                email = COALESCE($2, email),
                                telefone = COALESCE($3, telefone),
                                asaas_sync_at = NOW()
                            WHERE id = $4
                        `, [customer.name, customer.email, customer.phone, existe.rows[0].id]);
                        resultados.clientes.atualizados++;
                    } else {
                        await pool.query(`
                            INSERT INTO clientes (
                                nome, email, telefone, cpf_cnpj, empresa_id,
                                asaas_customer_id, asaas_sync_at, status, ativo, created_at
                            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'ativo', true, NOW())
                        `, [
                            customer.name, customer.email, customer.phone,
                            customer.cpfCnpj, empresa_id, customer.id
                        ]);
                        resultados.clientes.importados++;
                    }
                }

                if (!response.hasMore) break;
                offset += limit;
            }

            // 2. Sincronizar cobranças
            console.log('[SYNC] Etapa 2: Cobranças...');
            offset = 0;

            while (true) {
                const response = await asaasRequest(`/payments?offset=${offset}&limit=${limit}`);
                if (!response.data || response.data.length === 0) break;

                for (const payment of response.data) {
                    try {
                        const clienteResult = await pool.query(
                            'SELECT id FROM clientes WHERE asaas_customer_id = $1',
                            [payment.customer]
                        );

                        if (clienteResult.rows.length === 0) continue;

                        const cliente_id = clienteResult.rows[0].id;
                        const statusMap = {
                            'PENDING': 'pendente', 'RECEIVED': 'pago', 'CONFIRMED': 'pago',
                            'OVERDUE': 'vencido', 'REFUNDED': 'cancelado', 'RECEIVED_IN_CASH': 'pago'
                        };
                        const statusInterno = statusMap[payment.status] || 'pendente';

                        const existe = await pool.query('SELECT id FROM cobrancas WHERE asaas_id = $1', [payment.id]);

                        if (existe.rows.length > 0) {
                            await pool.query(`
                                UPDATE cobrancas SET
                                    status = $1,
                                    valor_pago = CASE WHEN $1 = 'pago' THEN $2 ELSE valor_pago END,
                                    data_pagamento = CASE WHEN $1 = 'pago' THEN $3 ELSE data_pagamento END,
                                    asaas_sync_at = NOW()
                                WHERE id = $4
                            `, [statusInterno, payment.value, payment.paymentDate, existe.rows[0].id]);
                            resultados.cobrancas.atualizados++;
                        } else {
                            await pool.query(`
                                INSERT INTO cobrancas (
                                    cliente_id, empresa_id, credor_id, descricao,
                                    valor_original, valor_atualizado, valor_total, vencimento, data_vencimento,
                                    status, valor_pago, data_pagamento,
                                    asaas_id, asaas_invoice_url, asaas_boleto_url, asaas_billing_type,
                                    asaas_sync_at, created_at
                                ) VALUES ($1, $2, $3, $4, $5, $5, $5, $6, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
                            `, [
                                cliente_id, empresa_id, credor_id,
                                payment.description || 'Cobrança Asaas',
                                payment.value, payment.dueDate, statusInterno,
                                statusInterno === 'pago' ? payment.value : null,
                                payment.paymentDate,
                                payment.id, payment.invoiceUrl, payment.bankSlipUrl, payment.billingType
                            ]);
                            resultados.cobrancas.importados++;
                        }
                    } catch (err) {
                        resultados.cobrancas.erros++;
                    }
                }

                if (!response.hasMore) break;
                offset += limit;
            }

            // 3. Atualizar totais
            if (credor_id) {
                await atualizarTotaisCredor(pool, credor_id);
            }

            console.log('[SYNC] Sincronização completa finalizada!', resultados);

            res.json({
                success: true,
                data: resultados
            });

        } catch (error) {
            console.error('[SYNC] Erro na sincronização completa:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // =====================================================
    // POST /api/sync/atualizar-status - Atualizar status de pagamentos
    // =====================================================
    router.post('/atualizar-status', auth, async (req, res) => {
        try {
            console.log('[SYNC] Atualizando status de cobranças pendentes...');

            // Buscar cobranças com asaas_id que estão pendentes
            const cobrancasPendentes = await pool.query(`
                SELECT id, asaas_id FROM cobrancas 
                WHERE asaas_id IS NOT NULL AND status IN ('pendente', 'vencido')
            `);

            let atualizadas = 0;

            for (const cobranca of cobrancasPendentes.rows) {
                try {
                    const payment = await asaasRequest(`/payments/${cobranca.asaas_id}`);
                    
                    if (payment && payment.status) {
                        const statusMap = {
                            'PENDING': 'pendente', 'RECEIVED': 'pago', 'CONFIRMED': 'pago',
                            'OVERDUE': 'vencido', 'REFUNDED': 'cancelado', 'RECEIVED_IN_CASH': 'pago'
                        };
                        const novoStatus = statusMap[payment.status] || 'pendente';

                        await pool.query(`
                            UPDATE cobrancas SET
                                status = $1,
                                valor_pago = CASE WHEN $1 = 'pago' THEN $2 ELSE valor_pago END,
                                data_pagamento = CASE WHEN $1 = 'pago' THEN $3 ELSE data_pagamento END,
                                asaas_sync_at = NOW()
                            WHERE id = $4
                        `, [novoStatus, payment.value, payment.paymentDate, cobranca.id]);

                        atualizadas++;
                    }
                } catch (err) {
                    console.error(`[SYNC] Erro ao atualizar ${cobranca.asaas_id}:`, err.message);
                }
            }

            console.log(`[SYNC] ${atualizadas} cobranças atualizadas`);

            res.json({
                success: true,
                data: { verificadas: cobrancasPendentes.rows.length, atualizadas }
            });

        } catch (error) {
            console.error('[SYNC] Erro ao atualizar status:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Função auxiliar para atualizar totais do credor
    async function atualizarTotaisCredor(pool, credor_id) {
        try {
            await pool.query(`
                UPDATE credores SET
                    total_dividas = (SELECT COUNT(*) FROM cobrancas WHERE credor_id = $1),
                    total_valor_dividas = (SELECT COALESCE(SUM(valor_original), 0) FROM cobrancas WHERE credor_id = $1),
                    total_recuperado = (SELECT COALESCE(SUM(valor_pago), 0) FROM cobrancas WHERE credor_id = $1 AND status = 'pago'),
                    updated_at = NOW()
                WHERE id = $1
            `, [credor_id]);
        } catch (err) {
            console.error('[SYNC] Erro ao atualizar totais do credor:', err);
        }
    }

    return router;
};