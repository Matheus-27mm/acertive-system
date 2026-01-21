/**
 * ROTAS DE IMPORTAÇÃO - ACERTIVE
 * Importar dados de Excel/CSV
 */

const express = require('express');
const XLSX = require('xlsx');

module.exports = function(pool, auth, upload, registrarLog) {
    const router = express.Router();

    // POST /api/importacao/clientes - Importar clientes de Excel
    router.post('/clientes', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'Arquivo é obrigatório' });
            }

            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet);

            if (data.length === 0) {
                return res.status(400).json({ error: 'Arquivo vazio' });
            }

            let importados = 0;
            let erros = [];

            for (const row of data) {
                try {
                    // Mapear colunas (flexível)
                    const nome = row.nome || row.Nome || row.NOME || row.cliente || row.Cliente;
                    const cpfCnpj = row.cpf_cnpj || row.cpf || row.cnpj || row.CPF || row.CNPJ || row.documento;
                    const telefone = row.telefone || row.Telefone || row.TELEFONE || row.celular || row.Celular;
                    const email = row.email || row.Email || row.EMAIL;
                    const endereco = row.endereco || row.Endereco || row.ENDERECO;

                    if (!nome) {
                        erros.push({ linha: importados + 2, erro: 'Nome não encontrado' });
                        continue;
                    }

                    // Verificar duplicado
                    if (cpfCnpj) {
                        const existe = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpfCnpj]);
                        if (existe.rows.length > 0) {
                            erros.push({ linha: importados + 2, erro: `CPF/CNPJ ${cpfCnpj} já existe` });
                            continue;
                        }
                    }

                    await pool.query(`
                        INSERT INTO clientes (nome, cpf_cnpj, telefone, email, endereco, status, created_at)
                        VALUES ($1, $2, $3, $4, $5, 'ativo', NOW())
                    `, [nome, cpfCnpj, telefone, email, endereco]);

                    importados++;

                } catch (err) {
                    erros.push({ linha: importados + 2, erro: err.message });
                }
            }

            await registrarLog(req.user?.id, 'IMPORTACAO_CLIENTES', 'clientes', null, {
                total: data.length,
                importados,
                erros: erros.length
            });

            res.json({
                success: true,
                total: data.length,
                importados,
                erros
            });

        } catch (error) {
            console.error('Erro na importação de clientes:', error);
            res.status(500).json({ error: 'Erro ao importar clientes' });
        }
    });

    // POST /api/importacao/cobrancas - Importar cobranças de Excel
    router.post('/cobrancas', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'Arquivo é obrigatório' });
            }

            const { credor_id } = req.body;

            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet);

            if (data.length === 0) {
                return res.status(400).json({ error: 'Arquivo vazio' });
            }

            let importados = 0;
            let clientesCriados = 0;
            let erros = [];

            for (let i = 0; i < data.length; i++) {
                const row = data[i];
                try {
                    // Mapear colunas
                    const clienteNome = row.cliente || row.Cliente || row.nome || row.Nome || row.devedor || row.Devedor;
                    const cpfCnpj = row.cpf_cnpj || row.cpf || row.cnpj || row.CPF || row.CNPJ || row.documento;
                    const telefone = row.telefone || row.Telefone || row.celular;
                    const email = row.email || row.Email;
                    const descricao = row.descricao || row.Descricao || row.DESCRICAO || row.produto || row.servico || 'Importado';
                    const valor = row.valor || row.Valor || row.VALOR || 0;
                    const vencimento = row.vencimento || row.Vencimento || row.data_vencimento || row.DATA_VENCIMENTO;
                    const contrato = row.contrato || row.Contrato || row.numero_contrato;

                    if (!clienteNome) {
                        erros.push({ linha: i + 2, erro: 'Nome do cliente não encontrado' });
                        continue;
                    }

                    if (!valor || parseFloat(valor) <= 0) {
                        erros.push({ linha: i + 2, erro: 'Valor inválido' });
                        continue;
                    }

                    // Buscar ou criar cliente
                    let clienteId;
                    
                    if (cpfCnpj) {
                        const clienteExiste = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpfCnpj]);
                        if (clienteExiste.rows.length > 0) {
                            clienteId = clienteExiste.rows[0].id;
                        }
                    }

                    if (!clienteId) {
                        // Buscar por nome
                        const clientePorNome = await pool.query('SELECT id FROM clientes WHERE nome ILIKE $1', [clienteNome]);
                        if (clientePorNome.rows.length > 0) {
                            clienteId = clientePorNome.rows[0].id;
                        } else {
                            // Criar novo cliente
                            const novoCliente = await pool.query(`
                                INSERT INTO clientes (nome, cpf_cnpj, telefone, email, status, created_at)
                                VALUES ($1, $2, $3, $4, 'ativo', NOW())
                                RETURNING id
                            `, [clienteNome, cpfCnpj, telefone, email]);
                            clienteId = novoCliente.rows[0].id;
                            clientesCriados++;
                        }
                    }

                    // Formatar data de vencimento
                    let dataVencimento;
                    if (vencimento) {
                        if (typeof vencimento === 'number') {
                            // Excel date serial number
                            const excelEpoch = new Date(1899, 11, 30);
                            dataVencimento = new Date(excelEpoch.getTime() + vencimento * 86400000);
                        } else {
                            dataVencimento = new Date(vencimento);
                        }
                    } else {
                        dataVencimento = new Date();
                    }

                    // Criar cobrança
                    await pool.query(`
                        INSERT INTO cobrancas (
                            cliente_id, credor_id, descricao, valor, 
                            data_vencimento, numero_contrato, status, created_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW())
                    `, [
                        clienteId,
                        credor_id || null,
                        descricao,
                        parseFloat(valor),
                        dataVencimento,
                        contrato
                    ]);

                    importados++;

                } catch (err) {
                    erros.push({ linha: i + 2, erro: err.message });
                }
            }

            await registrarLog(req.user?.id, 'IMPORTACAO_COBRANCAS', 'cobrancas', null, {
                total: data.length,
                importados,
                clientes_criados: clientesCriados,
                erros: erros.length
            });

            res.json({
                success: true,
                total: data.length,
                importados,
                clientes_criados: clientesCriados,
                erros
            });

        } catch (error) {
            console.error('Erro na importação de cobranças:', error);
            res.status(500).json({ error: 'Erro ao importar cobranças' });
        }
    });

    // POST /api/importacao/massa - Importação em massa (clientes + cobranças)
    router.post('/massa', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'Arquivo é obrigatório' });
            }

            const { credor_id } = req.body;

            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet);

            if (data.length === 0) {
                return res.status(400).json({ error: 'Arquivo vazio' });
            }

            const resultado = {
                total: data.length,
                clientes_criados: 0,
                clientes_atualizados: 0,
                cobrancas_criadas: 0,
                erros: []
            };

            for (let i = 0; i < data.length; i++) {
                const row = data[i];
                try {
                    // Mapear dados do cliente
                    const clienteNome = row.cliente || row.Cliente || row.nome || row.Nome;
                    const cpfCnpj = row.cpf_cnpj || row.cpf || row.cnpj || row.documento;
                    const telefone = row.telefone || row.Telefone || row.celular;
                    const email = row.email || row.Email;
                    const endereco = row.endereco || row.Endereco;

                    // Mapear dados da cobrança
                    const descricao = row.descricao || row.Descricao || 'Importado';
                    const valor = row.valor || row.Valor || 0;
                    const vencimento = row.vencimento || row.Vencimento || row.data_vencimento;
                    const contrato = row.contrato || row.Contrato;

                    if (!clienteNome) {
                        resultado.erros.push({ linha: i + 2, erro: 'Nome do cliente não encontrado' });
                        continue;
                    }

                    // Buscar ou criar cliente
                    let clienteId;
                    let clienteExistente = false;

                    if (cpfCnpj) {
                        const busca = await pool.query('SELECT id FROM clientes WHERE cpf_cnpj = $1', [cpfCnpj]);
                        if (busca.rows.length > 0) {
                            clienteId = busca.rows[0].id;
                            clienteExistente = true;
                            
                            // Atualizar dados se fornecidos
                            await pool.query(`
                                UPDATE clientes SET
                                    telefone = COALESCE($2, telefone),
                                    email = COALESCE($3, email),
                                    endereco = COALESCE($4, endereco),
                                    updated_at = NOW()
                                WHERE id = $1
                            `, [clienteId, telefone, email, endereco]);
                            
                            resultado.clientes_atualizados++;
                        }
                    }

                    if (!clienteId) {
                        const novoCliente = await pool.query(`
                            INSERT INTO clientes (nome, cpf_cnpj, telefone, email, endereco, status, created_at)
                            VALUES ($1, $2, $3, $4, $5, 'ativo', NOW())
                            RETURNING id
                        `, [clienteNome, cpfCnpj, telefone, email, endereco]);
                        
                        clienteId = novoCliente.rows[0].id;
                        resultado.clientes_criados++;
                    }

                    // Criar cobrança se tiver valor
                    if (valor && parseFloat(valor) > 0) {
                        let dataVencimento = new Date();
                        
                        if (vencimento) {
                            if (typeof vencimento === 'number') {
                                const excelEpoch = new Date(1899, 11, 30);
                                dataVencimento = new Date(excelEpoch.getTime() + vencimento * 86400000);
                            } else {
                                dataVencimento = new Date(vencimento);
                            }
                        }

                        await pool.query(`
                            INSERT INTO cobrancas (
                                cliente_id, credor_id, descricao, valor,
                                data_vencimento, numero_contrato, status, created_at
                            ) VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW())
                        `, [clienteId, credor_id || null, descricao, parseFloat(valor), dataVencimento, contrato]);

                        resultado.cobrancas_criadas++;
                    }

                } catch (err) {
                    resultado.erros.push({ linha: i + 2, erro: err.message });
                }
            }

            await registrarLog(req.user?.id, 'IMPORTACAO_MASSA', 'cobrancas', null, resultado);

            res.json({
                success: true,
                ...resultado
            });

        } catch (error) {
            console.error('Erro na importação em massa:', error);
            res.status(500).json({ error: 'Erro ao importar dados' });
        }
    });

    // GET /api/importacao/template/:tipo - Baixar template Excel
    router.get('/template/:tipo', auth, async (req, res) => {
        try {
            const { tipo } = req.params;

            let dados = [];
            let nomeArquivo = 'template.xlsx';

            if (tipo === 'clientes') {
                dados = [
                    { nome: 'João da Silva', cpf_cnpj: '12345678901', telefone: '92999999999', email: 'joao@email.com', endereco: 'Rua A, 123' },
                    { nome: 'Maria Santos', cpf_cnpj: '98765432100', telefone: '92988888888', email: 'maria@email.com', endereco: 'Rua B, 456' }
                ];
                nomeArquivo = 'template_clientes.xlsx';
            } else if (tipo === 'cobrancas') {
                dados = [
                    { cliente: 'João da Silva', cpf_cnpj: '12345678901', telefone: '92999999999', descricao: 'Mensalidade Janeiro', valor: 150.00, vencimento: '2025-01-15', contrato: 'CONT-001' },
                    { cliente: 'Maria Santos', cpf_cnpj: '98765432100', telefone: '92988888888', descricao: 'Serviço X', valor: 300.50, vencimento: '2025-01-20', contrato: 'CONT-002' }
                ];
                nomeArquivo = 'template_cobrancas.xlsx';
            } else {
                return res.status(400).json({ error: 'Tipo de template inválido' });
            }

            const workbook = XLSX.utils.book_new();
            const worksheet = XLSX.utils.json_to_sheet(dados);
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Dados');

            const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=${nomeArquivo}`);
            res.send(buffer);

        } catch (error) {
            console.error('Erro ao gerar template:', error);
            res.status(500).json({ error: 'Erro ao gerar template' });
        }
    });

    return router;
};
