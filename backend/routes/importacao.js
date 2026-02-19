/**
 * ========================================
 * ACERTIVE - Módulo de Importação em Massa
 * routes/importacao.js
 * ========================================
 * Parser inteligente - detecta colunas automaticamente
 * Suporta qualquer formato de planilha
 */

const express = require('express');
const XLSX = require('xlsx');

module.exports = function(pool, auth, upload, registrarLog) {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // DETECTOR DE COLUNAS INTELIGENTE
    // Normaliza o nome da coluna e tenta encontrar o melhor match
    // ═══════════════════════════════════════════════════════════════
    function normalizarChave(str) {
        return String(str || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
            .replace(/[^a-z0-9]/g, ''); // remove tudo que não é letra/número
    }

    // Mapa de variações conhecidas por campo
    const CAMPO_ALIASES = {
        nome: [
            'nome', 'nomecli', 'nomecliente', 'paciente', 'cliente', 'devedor',
            'razaosocial', 'razao', 'nomefantasia', 'proprietario', 'titular',
            'nomedo', 'nomecompleto', 'name', 'fullname'
        ],
        cpf_cnpj: [
            'cpf', 'cnpj', 'cpfcnpj', 'cnpjcpf', 'cpfoucnpj', 'documento',
            'doc', 'cpfcliente', 'cnpjcliente', 'cadastro', 'numcpf',
            'numerocpf', 'numerocnpj', 'identificacao', 'codcliente'
        ],
        telefone: [
            'telefone', 'fone', 'celular', 'tel', 'telefone1', 'fone1',
            'celular1', 'tel1', 'whatsapp', 'contato', 'telefoneprincipal',
            'telefonecompleto', 'numerodofone', 'numerodetelefone', 'mobile',
            'phone', 'telefoneum', 'telefonedo', 'foneresidencial', 'fonecelular'
        ],
        telefone2: [
            'telefone2', 'fone2', 'celular2', 'tel2', 'outrotelefone',
            'telefoneadicional', 'telefonedois', 'contatoalternativo',
            'telefonealternativo', 'phone2', 'secondphone'
        ],
        email: [
            'email', 'email', 'correioeletronico', 'mail', 'emailcliente',
            'enderecoeletronico', 'emaildo', 'emaildocliente', 'emai'
        ],
        valor: [
            'valor', 'valororiginal', 'valordevido', 'valoremaberto', 'valoraberto',
            'saldo', 'saldodevedor', 'valordadivida', 'divida', 'montante',
            'valortotal', 'totaldevido', 'valorliquido', 'valordotratamento',
            'valorliquidoa', 'vl', 'vlr', 'amount', 'balance', 'debt',
            'valorincluso', 'valorinclusonospc', 'valornospc', 'valorspc'
        ],
        data_vencimento: [
            'datavencimento', 'vencimento', 'data', 'datadevencimento',
            'datadevcobr', 'datavc', 'datadevida', 'datadivida',
            'datadeinclusao', 'datainclusao', 'datainclusa', 'dtvenc',
            'dtvc', 'dtdevida', 'duedate', 'dataoperacao', 'datadocredito',
            'datadeemissao', 'dtemisvencimento', 'datavenc', 'datadevenc'
        ],
        numero_documento: [
            'numerodocumento', 'documento', 'numdoc', 'nrdocumento',
            'numerotitulo', 'titulo', 'contrato', 'numcontrato',
            'numerocontrato', 'chave', 'referencia', 'nf', 'nota',
            'numeronf', 'invoice', 'protocolo', 'numprotocolo',
            'pedido', 'numpedido', 'parcela', 'numeroparcela', 'doc'
        ],
        descricao: [
            'descricao', 'historico', 'observacao', 'obs', 'descr',
            'memo', 'comentario', 'detalhes', 'tipo', 'produto',
            'servico', 'description', 'note', 'discriminacao'
        ]
    };

    function detectarColunas(primeiraLinha) {
        const mapeamento = {};
        const colunasDisponiveis = Object.keys(primeiraLinha);

        // Para cada coluna da planilha, normaliza e tenta identificar o campo
        colunasDisponiveis.forEach(coluna => {
            const colunaNorm = normalizarChave(coluna);
            
            for (const [campo, aliases] of Object.entries(CAMPO_ALIASES)) {
                // Se já mapeou este campo, pula (primeira ocorrência ganha, exceto valor)
                if (mapeamento[campo] && campo !== 'telefone2') continue;
                
                if (aliases.includes(colunaNorm)) {
                    // Para telefone2, só mapeia se já tiver telefone mapeado
                    if (campo === 'telefone2' && !mapeamento.telefone) continue;
                    mapeamento[campo] = coluna;
                    break;
                }
            }
        });

        return mapeamento;
    }

    function mapearLinha(row, mapeamento) {
        const pegar = (campo) => {
            const coluna = mapeamento[campo];
            if (!coluna) return '';
            return row[coluna] !== undefined && row[coluna] !== null ? row[coluna] : '';
        };

        return {
            nome: pegar('nome'),
            cpf_cnpj: pegar('cpf_cnpj'),
            telefone: pegar('telefone'),
            telefone2: pegar('telefone2'),
            email: pegar('email'),
            valor: pegar('valor'),
            data_vencimento: pegar('data_vencimento'),
            numero_documento: pegar('numero_documento'),
            descricao: pegar('descricao')
        };
    }

    function parsearValor(raw) {
        if (!raw) return 0;
        if (typeof raw === 'number') return isNaN(raw) ? 0 : parseFloat(raw.toFixed(2));
        // Remover fórmulas Excel (ex: =1994+398.8)
        if (typeof raw === 'string' && raw.startsWith('=')) {
            try {
                const resultado = eval(raw.slice(1)); // eslint-disable-line no-eval
                return isNaN(resultado) ? 0 : parseFloat(parseFloat(resultado).toFixed(2));
            } catch { return 0; }
        }
        const limpo = String(raw).replace(/[^\d,.-]/g, '').replace(',', '.');
        const val = parseFloat(limpo);
        return isNaN(val) ? 0 : val;
    }

    function parsearData(raw) {
        if (!raw) return null;
        if (raw instanceof Date) {
            return isNaN(raw.getTime()) ? null : raw;
        }
        if (typeof raw === 'number') {
            // Excel serial date
            const data = new Date((raw - 25569) * 86400 * 1000);
            return isNaN(data.getTime()) ? null : data;
        }
        if (typeof raw === 'string') {
            const s = raw.trim().split(' ')[0]; // Remove hora
            // DD/MM/YYYY
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
                const [d, m, y] = s.split('/');
                return new Date(y, m - 1, d);
            }
            // YYYY-MM-DD
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
                return new Date(s);
            }
            // DD-MM-YYYY
            if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
                const [d, m, y] = s.split('-');
                return new Date(y, m - 1, d);
            }
            const tentativa = new Date(s);
            return isNaN(tentativa.getTime()) ? null : tentativa;
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // POST /api/importacao/preview
    // ═══════════════════════════════════════════════════════════════
    router.post('/preview', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'Arquivo é obrigatório' });
            }

            const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
            const sheetName = workbook.SheetNames[0];
            const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: false, defval: '' });

            if (data.length === 0) {
                return res.status(400).json({ success: false, error: 'Arquivo vazio' });
            }

            // Detectar mapeamento automático na primeira linha
            const mapeamento = detectarColunas(data[0]);
            console.log('[IMPORTACAO] Mapeamento detectado:', mapeamento);

            if (!mapeamento.nome && !mapeamento.cpf_cnpj) {
                return res.status(400).json({
                    success: false,
                    error: 'Não foi possível identificar colunas de Nome ou CPF na planilha. Colunas encontradas: ' + Object.keys(data[0]).join(', ')
                });
            }

            const clientesMap = new Map();
            let linhasIgnoradas = 0;

            data.forEach((row) => {
                const dados = mapearLinha(row, mapeamento);

                // Limpar CPF
                let cpf = String(dados.cpf_cnpj || '').replace(/\D/g, '');
                const nome = String(dados.nome || '').trim();

                // Ignorar linhas sem CPF e sem nome
                if (!cpf && !nome) { linhasIgnoradas++; return; }

                // Se não tem CPF mas tem nome, usar nome como chave temporária
                const chave = cpf || ('nome_' + nome.toLowerCase().replace(/\s+/g, '_'));

                // Formatar CPF
                const cpfFormatado = cpf.length === 11
                    ? cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
                    : cpf.length === 14
                        ? cpf.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
                        : cpf;

                const valor = parsearValor(dados.valor);
                const dataVenc = parsearData(dados.data_vencimento);

                // Calcular dias de atraso
                let diasAtraso = 0;
                if (dataVenc) {
                    const hoje = new Date();
                    hoje.setHours(0, 0, 0, 0);
                    const dv = new Date(dataVenc);
                    dv.setHours(0, 0, 0, 0);
                    diasAtraso = Math.floor((hoje - dv) / (1000 * 60 * 60 * 24));
                }

                if (!clientesMap.has(chave)) {
                    clientesMap.set(chave, {
                        cpf_cnpj: cpf,
                        cpf_formatado: cpfFormatado,
                        nome: nome,
                        telefone: dados.telefone ? String(dados.telefone).replace(/\D/g, '') : '',
                        telefone2: dados.telefone2 ? String(dados.telefone2).replace(/\D/g, '') : '',
                        email: dados.email || '',
                        dividas: [],
                        total_valor: 0,
                        total_dividas: 0,
                        maior_atraso: 0
                    });
                }

                const cliente = clientesMap.get(chave);

                if (valor > 0) {
                    cliente.dividas.push({
                        numero_documento: String(dados.numero_documento || '').trim() || null,
                        data_vencimento: dataVenc ? dataVenc.toISOString().split('T')[0] : null,
                        valor: valor,
                        descricao: String(dados.descricao || '').trim() || 'Importado',
                        dias_atraso: diasAtraso > 0 ? diasAtraso : 0
                    });
                    cliente.total_valor += valor;
                    cliente.total_dividas++;
                    if (diasAtraso > cliente.maior_atraso) cliente.maior_atraso = diasAtraso;
                } else {
                    // Cliente sem valor de dívida mas com dados válidos - ainda inclui
                    // para não perder o cadastro (pode ser que o campo valor não existe)
                    if (!mapeamento.valor && nome) {
                        cliente.total_dividas = cliente.total_dividas; // mantém sem dívida
                    }
                }
            });

            // Converter e ordenar
            const clientes = Array.from(clientesMap.values())
                .filter(c => c.nome) // pelo menos tem nome
                .sort((a, b) => b.maior_atraso - a.maior_atraso);

            const stats = {
                total_linhas: data.length,
                linhas_ignoradas: linhasIgnoradas,
                total_clientes: clientes.length,
                total_dividas: clientes.reduce((s, c) => s + c.total_dividas, 0),
                valor_total: clientes.reduce((s, c) => s + c.total_valor, 0),
                clientes_com_atraso: clientes.filter(c => c.maior_atraso > 0).length
            };

            res.json({
                success: true,
                stats,
                clientes,
                mapeamento_detectado: mapeamento,
                colunas_detectadas: Object.keys(data[0] || {}).filter(Boolean)
            });

        } catch (error) {
            console.error('[IMPORTACAO] Erro no preview:', error);
            res.status(500).json({ success: false, error: 'Erro ao processar arquivo: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/importacao/executar
    // ═══════════════════════════════════════════════════════════════
    router.post('/executar', auth, async (req, res) => {
        try {
            const { clientes, credor_nome, credor_id } = req.body;

            if (!clientes || !Array.isArray(clientes) || clientes.length === 0) {
                return res.status(400).json({ success: false, error: 'Dados de clientes são obrigatórios' });
            }

            const nomeCredor = credor_nome || 'Carteira Geral';

            // Buscar ou criar credor
            let credorId = credor_id || null;
            if (!credorId) {
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
            }

            let clientesCriados = 0;
            let clientesAtualizados = 0;
            let cobrancasCriadas = 0;
            let erros = [];

            for (const cliente of clientes) {
                try {
                    const cpfLimpo = String(cliente.cpf_cnpj || '').replace(/\D/g, '');

                    let clienteId = null;

                    if (cpfLimpo) {
                        const clienteExiste = await pool.query(
                            'SELECT id FROM clientes WHERE cpf_cnpj = $1 LIMIT 1',
                            [cpfLimpo]
                        );

                        if (clienteExiste.rows.length > 0) {
                            clienteId = clienteExiste.rows[0].id;
                            await pool.query(`
                                UPDATE clientes SET
                                    telefone = COALESCE(NULLIF($2, ''), telefone),
                                    telefone2 = COALESCE(NULLIF($3, ''), telefone2),
                                    email = COALESCE(NULLIF($4, ''), email),
                                    updated_at = NOW()
                                WHERE id = $1
                            `, [clienteId, cliente.telefone, cliente.telefone2, cliente.email]);
                            clientesAtualizados++;
                        }
                    }

                    if (!clienteId) {
                        const novoCliente = await pool.query(`
                            INSERT INTO clientes (
                                nome, cpf_cnpj, telefone, telefone2, email,
                                status, status_cobranca, created_at
                            ) VALUES ($1, $2, $3, $4, $5, 'ativo', 'novo', NOW())
                            RETURNING id
                        `, [
                            cliente.nome,
                            cpfLimpo || null,
                            cliente.telefone || null,
                            cliente.telefone2 || null,
                            cliente.email || null
                        ]);
                        clienteId = novoCliente.rows[0].id;
                        clientesCriados++;
                    }

                    // Criar cobranças
                    for (const divida of (cliente.dividas || [])) {
                        try {
                            // Verificar duplicata pelo número do documento
                            if (divida.numero_documento) {
                                const existe = await pool.query(
                                    'SELECT id FROM cobrancas WHERE cliente_id = $1 AND numero_documento = $2 LIMIT 1',
                                    [clienteId, divida.numero_documento]
                                );
                                if (existe.rows.length > 0) continue;
                            }

                            const status = divida.dias_atraso > 0 ? 'vencido' : 'pendente';

                            await pool.query(`
                                INSERT INTO cobrancas (
                                    cliente_id, credor_id, numero_documento,
                                    valor, valor_original, valor_atualizado,
                                    data_vencimento, vencimento,
                                    descricao, status, created_at
                                ) VALUES ($1, $2, $3, $4, $4, $4, $5, $5, $6, $7, NOW())
                            `, [
                                clienteId, credorId,
                                divida.numero_documento || null,
                                divida.valor,
                                divida.data_vencimento || null,
                                divida.descricao || 'Importado',
                                status
                            ]);

                            cobrancasCriadas++;
                        } catch (errDivida) {
                            erros.push({ cliente: cliente.nome, documento: divida.numero_documento, erro: errDivida.message });
                        }
                    }

                } catch (errCliente) {
                    erros.push({ cliente: cliente.nome, erro: errCliente.message });
                }
            }

            if (registrarLog) {
                await registrarLog(req.user?.id, 'IMPORTACAO_MASSA', 'importacao', null, {
                    credor: nomeCredor, clientes_criados: clientesCriados,
                    clientes_atualizados: clientesAtualizados, cobrancas_criadas: cobrancasCriadas,
                    erros: erros.length
                });
            }

            res.json({
                success: true,
                message: 'Importação concluída!',
                resultado: {
                    credor_id: credorId, credor_nome: nomeCredor,
                    clientes_criados: clientesCriados, clientes_atualizados: clientesAtualizados,
                    cobrancas_criadas: cobrancasCriadas,
                    erros: erros.slice(0, 10)
                }
            });

        } catch (error) {
            console.error('[IMPORTACAO] Erro ao executar:', error);
            res.status(500).json({ success: false, error: 'Erro ao executar importação: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/importacao/credores
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