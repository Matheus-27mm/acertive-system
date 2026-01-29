/**
 * ========================================
 * ACERTIVE - Módulo de Importação em Massa
 * routes/importacao.js
 * ========================================
 * Importa carteira completa (clientes + cobranças)
 * Agrupa por CPF para evitar duplicatas
 */

const express = require('express');
const XLSX = require('xlsx');

module.exports = function(pool, auth, upload, registrarLog) {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // POST /api/importacao/preview - Preview dos dados antes de importar
    // ═══════════════════════════════════════════════════════════════
    router.post('/preview', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'Arquivo é obrigatório' });
            }

            const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
            const sheetName = workbook.SheetNames[0];
            const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: false });

            if (data.length === 0) {
                return res.status(400).json({ success: false, error: 'Arquivo vazio' });
            }

            // Mapear colunas (flexível para diferentes formatos)
            const mapearLinha = (row) => {
                return {
                    cpf_cnpj: row.cnpj_cpf || row.cpf_cnpj || row.cpf || row.cnpj || row.CPF || row.CNPJ || row.documento || '',
                    nome: row.NOMECLI || row.nomecli || row.nome || row.Nome || row.NOME || row.cliente || row.Cliente || '',
                    telefone: row.telefone || row.Telefone || row.TELEFONE || row.fone || row.celular || '',
                    telefone2: row.telefone2 || row.Telefone2 || row.TELEFONE2 || '',
                    email: row.email || row.Email || row.EMAIL || row.e_mail || '',
                    numero_documento: row['Número do Documento'] || row.numero_documento || row.documento || row.titulo || row.CHAVE || '',
                    data_vencimento: row['Data Vencimento'] || row.data_vencimento || row.vencimento || row.Vencimento || '',
                    valor: row.valor || row.Valor || row.VALOR || row['Valor Líquido'] || 0,
                    descricao: row['Histórico'] || row.historico || row.descricao || row.Descricao || 'Importado'
                };
            };

            // Agrupar por CPF/CNPJ
            const clientesMap = new Map();
            let linhasIgnoradas = 0;

            data.forEach((row, index) => {
                const dados = mapearLinha(row);
                
                // Limpar CPF
                let cpf = String(dados.cpf_cnpj || '').replace(/\D/g, '');
                
                // Ignorar linhas sem CPF ou sem nome
                if (!cpf || !dados.nome) {
                    linhasIgnoradas++;
                    return;
                }

                // Formatar CPF para exibição
                const cpfFormatado = cpf.length === 11 
                    ? cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
                    : cpf.length === 14 
                        ? cpf.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
                        : cpf;

                // Parsear valor
                let valor = 0;
                if (dados.valor) {
                    valor = typeof dados.valor === 'string' 
                        ? parseFloat(dados.valor.replace(/[^\d,.-]/g, '').replace(',', '.')) 
                        : parseFloat(dados.valor);
                }
                if (isNaN(valor)) valor = 0;

                // Parsear data
                let dataVenc = null;
                if (dados.data_vencimento) {
                    if (dados.data_vencimento instanceof Date) {
                        dataVenc = dados.data_vencimento;
                    } else if (typeof dados.data_vencimento === 'string') {
                        // Tentar diferentes formatos
                        const dateStr = dados.data_vencimento.split(' ')[0]; // Remove hora se tiver
                        dataVenc = new Date(dateStr);
                        if (isNaN(dataVenc.getTime())) {
                            // Tentar formato DD/MM/YYYY
                            const parts = dateStr.split('/');
                            if (parts.length === 3) {
                                dataVenc = new Date(parts[2], parts[1] - 1, parts[0]);
                            }
                        }
                    } else if (typeof dados.data_vencimento === 'number') {
                        // Excel serial date
                        dataVenc = new Date((dados.data_vencimento - 25569) * 86400 * 1000);
                    }
                }

                // Calcular dias de atraso
                let diasAtraso = 0;
                if (dataVenc && !isNaN(dataVenc.getTime())) {
                    const hoje = new Date();
                    hoje.setHours(0, 0, 0, 0);
                    dataVenc.setHours(0, 0, 0, 0);
                    diasAtraso = Math.floor((hoje - dataVenc) / (1000 * 60 * 60 * 24));
                }

                // Criar ou atualizar cliente no map
                if (!clientesMap.has(cpf)) {
                    clientesMap.set(cpf, {
                        cpf_cnpj: cpf,
                        cpf_formatado: cpfFormatado,
                        nome: dados.nome.trim(),
                        telefone: dados.telefone ? String(dados.telefone).replace(/\D/g, '') : '',
                        telefone2: dados.telefone2 ? String(dados.telefone2).replace(/\D/g, '') : '',
                        email: dados.email || '',
                        dividas: [],
                        total_valor: 0,
                        total_dividas: 0,
                        maior_atraso: 0
                    });
                }

                const cliente = clientesMap.get(cpf);
                
                // Adicionar dívida
                if (valor > 0) {
                    cliente.dividas.push({
                        numero_documento: dados.numero_documento,
                        data_vencimento: dataVenc && !isNaN(dataVenc.getTime()) ? dataVenc.toISOString().split('T')[0] : null,
                        valor: valor,
                        descricao: dados.descricao,
                        dias_atraso: diasAtraso > 0 ? diasAtraso : 0
                    });
                    cliente.total_valor += valor;
                    cliente.total_dividas++;
                    if (diasAtraso > cliente.maior_atraso) {
                        cliente.maior_atraso = diasAtraso;
                    }
                }
            });

            // Converter map para array e ordenar por maior atraso
            const clientes = Array.from(clientesMap.values())
                .filter(c => c.total_dividas > 0)
                .sort((a, b) => b.maior_atraso - a.maior_atraso);

            // Estatísticas
            const stats = {
                total_linhas: data.length,
                linhas_ignoradas: linhasIgnoradas,
                total_clientes: clientes.length,
                total_dividas: clientes.reduce((sum, c) => sum + c.total_dividas, 0),
                valor_total: clientes.reduce((sum, c) => sum + c.total_valor, 0),
                clientes_com_atraso: clientes.filter(c => c.maior_atraso > 0).length
            };

            res.json({
                success: true,
                stats,
                clientes,
                colunas_detectadas: Object.keys(data[0] || {})
            });

        } catch (error) {
            console.error('[IMPORTACAO] Erro no preview:', error);
            res.status(500).json({ success: false, error: 'Erro ao processar arquivo: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/importacao/executar - Executar importação
    // ═══════════════════════════════════════════════════════════════
    router.post('/executar', auth, async (req, res) => {
        try {
            const { clientes, credor_nome } = req.body;

            if (!clientes || !Array.isArray(clientes) || clientes.length === 0) {
                return res.status(400).json({ success: false, error: 'Dados de clientes são obrigatórios' });
            }

            const nomeCredor = credor_nome || 'Carteira Geral';

            // Criar ou buscar credor
            let credorId = null;
            const credorExiste = await pool.query(
                'SELECT id FROM credores WHERE nome ILIKE $1 LIMIT 1',
                [nomeCredor]
            );

            if (credorExiste.rows.length > 0) {
                credorId = credorExiste.rows[0].id;
            } else {
                const novoCredor = await pool.query(
                    `INSERT INTO credores (nome, status, created_at) VALUES ($1, 'ativo', NOW()) RETURNING id`,
                    [nomeCredor]
                );
                credorId = novoCredor.rows[0].id;
            }

            let clientesCriados = 0;
            let clientesAtualizados = 0;
            let cobrancasCriadas = 0;
            let erros = [];

            // Processar cada cliente
            for (const cliente of clientes) {
                try {
                    const cpfLimpo = String(cliente.cpf_cnpj).replace(/\D/g, '');
                    
                    if (!cpfLimpo) continue;

                    // Verificar se cliente já existe
                    let clienteId = null;
                    const clienteExiste = await pool.query(
                        'SELECT id FROM clientes WHERE cpf_cnpj = $1 LIMIT 1',
                        [cpfLimpo]
                    );

                    if (clienteExiste.rows.length > 0) {
                        clienteId = clienteExiste.rows[0].id;
                        
                        // Atualizar dados do cliente se necessário
                        await pool.query(`
                            UPDATE clientes SET
                                telefone = COALESCE(NULLIF($2, ''), telefone),
                                telefone2 = COALESCE(NULLIF($3, ''), telefone2),
                                email = COALESCE(NULLIF($4, ''), email),
                                updated_at = NOW()
                            WHERE id = $1
                        `, [clienteId, cliente.telefone, cliente.telefone2, cliente.email]);
                        
                        clientesAtualizados++;
                    } else {
                        // Criar novo cliente
                        const novoCliente = await pool.query(`
                            INSERT INTO clientes (
                                nome, cpf_cnpj, telefone, telefone2, email, 
                                status, status_cobranca, created_at
                            ) VALUES ($1, $2, $3, $4, $5, 'ativo', 'novo', NOW())
                            RETURNING id
                        `, [
                            cliente.nome,
                            cpfLimpo,
                            cliente.telefone || null,
                            cliente.telefone2 || null,
                            cliente.email || null
                        ]);
                        clienteId = novoCliente.rows[0].id;
                        clientesCriados++;
                    }

                    // Criar cobranças
                    for (const divida of cliente.dividas) {
                        try {
                            // Verificar se cobrança já existe (pelo número do documento)
                            if (divida.numero_documento) {
                                const cobrancaExiste = await pool.query(
                                    'SELECT id FROM cobrancas WHERE cliente_id = $1 AND numero_documento = $2 LIMIT 1',
                                    [clienteId, divida.numero_documento]
                                );
                                
                                if (cobrancaExiste.rows.length > 0) {
                                    // Já existe, pular
                                    continue;
                                }
                            }

                            // Determinar status
                            let status = 'pendente';
                            if (divida.dias_atraso > 0) {
                                status = 'vencido';
                            }

                            await pool.query(`
                                INSERT INTO cobrancas (
                                    cliente_id, credor_id, numero_documento,
                                    valor, valor_original, valor_atualizado,
                                    data_vencimento, vencimento,
                                    descricao, status, created_at
                                ) VALUES (
                                    $1, $2, $3,
                                    $4, $4, $4,
                                    $5, $5,
                                    $6, $7, NOW()
                                )
                            `, [
                                clienteId,
                                credorId,
                                divida.numero_documento || null,
                                divida.valor,
                                divida.data_vencimento || null,
                                divida.descricao || 'Importado',
                                status
                            ]);
                            
                            cobrancasCriadas++;
                        } catch (errDivida) {
                            erros.push({
                                cliente: cliente.nome,
                                documento: divida.numero_documento,
                                erro: errDivida.message
                            });
                        }
                    }

                } catch (errCliente) {
                    erros.push({
                        cliente: cliente.nome,
                        erro: errCliente.message
                    });
                }
            }

            // Registrar log
            if (registrarLog) {
                await registrarLog(req.user?.id, 'IMPORTACAO_MASSA', 'importacao', null, {
                    credor: nomeCredor,
                    clientes_criados: clientesCriados,
                    clientes_atualizados: clientesAtualizados,
                    cobrancas_criadas: cobrancasCriadas,
                    erros: erros.length
                });
            }

            res.json({
                success: true,
                message: 'Importação concluída!',
                resultado: {
                    credor_id: credorId,
                    credor_nome: nomeCredor,
                    clientes_criados: clientesCriados,
                    clientes_atualizados: clientesAtualizados,
                    cobrancas_criadas: cobrancasCriadas,
                    erros: erros.length > 0 ? erros.slice(0, 10) : [] // Limitar erros retornados
                }
            });

        } catch (error) {
            console.error('[IMPORTACAO] Erro ao executar:', error);
            res.status(500).json({ success: false, error: 'Erro ao executar importação: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/importacao/credores - Lista credores para seleção
    // ═══════════════════════════════════════════════════════════════
    router.get('/credores', auth, async (req, res) => {
        try {
            const result = await pool.query(
                "SELECT id, nome FROM credores WHERE status = 'ativo' ORDER BY nome"
            );
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar credores' });
        }
    });

    return router;
};