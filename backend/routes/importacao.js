/**
 * ========================================
 * ACERTIVE - Módulo de Importação em Massa
 * routes/importacao.js
 * ========================================
 * Parser inteligente - detecta colunas automaticamente
 * Suporta qualquer formato de planilha
 * Importação via arquivo direto (sem limite de payload)
 */

const express = require('express');
const XLSX    = require('xlsx');

module.exports = function(pool, auth, upload, registrarLog) {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // DETECTOR DE COLUNAS INTELIGENTE
    // ═══════════════════════════════════════════════════════════════
    function normalizarChave(str) {
        return String(str || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/g, '');
    }

    const CAMPO_ALIASES = {
        nome: [
            'nome','nomecli','nomecliente','paciente','cliente','devedor',
            'razaosocial','razao','nomefantasia','proprietario','titular',
            'nomedo','nomecompleto','name','fullname'
        ],
        cpf_cnpj: [
            'cpf','cnpj','cpfcnpj','cnpjcpf','cpfoucnpj','documento',
            'doc','cpfcliente','cnpjcliente','cadastro','numcpf',
            'numerocpf','numerocnpj','identificacao','codcliente'
        ],
        telefone: [
            'telefone','fone','celular','tel','telefone1','fone1','celular1','tel1',
            'whatsapp','contato','telefoneprincipal','telefonecompleto',
            'numerodofone','numerodetelefone','mobile','phone',
            'telefoneum','telefonedo','foneresidencial','fonecelular','telefone01'
        ],
        telefone2: [
            'telefone2','fone2','celular2','tel2','outrotelefone',
            'telefoneadicional','telefonedois','contatoalternativo',
            'telefonealternativo','phone2','secondphone','telefone02'
        ],
        email: [
            'email','correioeletronico','mail','emailcliente',
            'enderecoeletronico','emaildo','emaildocliente','emai','email01','emailum'
        ],
        valor: [
            'valor','valororiginal','valordevido','valoremaberto','valoraberto',
            'saldo','saldodevedor','valordadivida','divida','montante',
            'valortotal','totaldevido','valorliquido','valordotratamento',
            'valorliquidoa','vl','vlr','amount','balance','debt',
            'valorincluso','valorinclusonospc','valornospc','valorspc'
        ],
        data_vencimento: [
            'datavencimento','vencimento','data','datadevencimento',
            'datadevcobr','datavc','datadevida','datadivida',
            'datadeinclusao','datainclusao','datainclusa','dtvenc',
            'dtvc','dtdevida','duedate','dataoperacao','datadocredito',
            'datadeemissao','dtemisvencimento','datavenc','datadevenc','dtvencto'
        ],
        numero_documento: [
            'numerodocumento','documento','numdoc','nrdocumento',
            'numerotitulo','titulo','contrato','numcontrato',
            'numerocontrato','chave','referencia','nf','nota',
            'numeronf','invoice','protocolo','numprotocolo',
            'pedido','numpedido','parcela','numeroparcela','doc','notafiscal'
        ],
        descricao: [
            'descricao','historico','observacao','obs','descr',
            'memo','comentario','detalhes','tipo','produto',
            'servico','description','note','discriminacao','texto'
        ]
    };

    // Mapa exato por nome de coluna (prioridade máxima)
    const MAPA_EXATO = {
        'Nome':                  'nome',
        'NOMECLI':               'nome',
        'PACIENTE':              'nome',
        'CNPJ/CPF':              'cpf_cnpj',
        'CPF':                   'cpf_cnpj',
        'cnpj_cpf':              'cpf_cnpj',
        'Montante':              'valor',
        'VALOR INCLUSO NO SPC':  'valor',
        'valor':                 'valor',
        'Dt.Vencto.':            'data_vencimento',
        'Data Vencimento':       'data_vencimento',
        'DATA DEVIDA':           'data_vencimento',
        'Telefone 01':           'telefone',
        'TELEFONE 1':            'telefone',
        'telefone':              'telefone',
        'Telefone 02':           'telefone2',
        'TELEFONE 2':            'telefone2',
        'telefone2':             'telefone2',
        'E-mail 01':             'email',
        'E-MAIL':                'email',
        'email':                 'email',
        'Texto':                 'descricao',
        'Histórico':             'descricao',
        'Nota Fiscal':           'numero_documento',
        'Número do Documento':   'numero_documento',
    };

    function detectarColunas(primeiraLinha) {
        const mapeamento = {};
        const colunasDisponiveis = Object.keys(primeiraLinha);

        colunasDisponiveis.forEach(coluna => {
            // 1. Mapa exato
            if (MAPA_EXATO[coluna]) {
                const campo = MAPA_EXATO[coluna];
                if (!mapeamento[campo]) { mapeamento[campo] = coluna; return; }
            }
            // 2. Palavras-chave normalizadas
            const colunaNorm = normalizarChave(coluna);
            for (const [campo, aliases] of Object.entries(CAMPO_ALIASES)) {
                if (mapeamento[campo] && campo !== 'telefone2') continue;
                if (aliases.includes(colunaNorm)) {
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
            nome:             pegar('nome'),
            cpf_cnpj:         pegar('cpf_cnpj'),
            telefone:         pegar('telefone'),
            telefone2:        pegar('telefone2'),
            email:            pegar('email'),
            valor:            pegar('valor'),
            data_vencimento:  pegar('data_vencimento'),
            numero_documento: pegar('numero_documento'),
            descricao:        pegar('descricao')
        };
    }

    function parsearValor(raw) {
        if (!raw && raw !== 0) return 0;
        if (typeof raw === 'number') return isNaN(raw) ? 0 : parseFloat(raw.toFixed(2));
        if (typeof raw === 'string' && raw.startsWith('=')) {
            try {
                const r = eval(raw.slice(1)); // eslint-disable-line no-eval
                return isNaN(r) ? 0 : parseFloat(parseFloat(r).toFixed(2));
            } catch { return 0; }
        }
        let s = String(raw).trim().replace(/R\$\s*/g, '');
        const temPonto   = s.includes('.');
        const temVirgula = s.includes(',');
        if (temPonto && temVirgula) {
            const ultPonto   = s.lastIndexOf('.');
            const ultVirgula = s.lastIndexOf(',');
            s = ultVirgula > ultPonto
                ? s.replace(/\./g, '').replace(',', '.')   // BR: 1.807.664,00
                : s.replace(/,/g, '');                      // US: 18,076.64
        } else if (temVirgula && !temPonto) {
            const partes = s.split(',');
            s = (partes.length === 2 && partes[1].length <= 2)
                ? s.replace(',', '.')   // decimal BR: 18076,64
                : s.replace(/,/g, ''); // milhar: 18,076
        }
        s = s.replace(/[^0-9.]/g, '');
        const val = parseFloat(s);
        return isNaN(val) ? 0 : val;
    }

    function parsearData(raw) {
        if (!raw) return null;
        if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
        if (typeof raw === 'number') {
            const d = new Date((raw - 25569) * 86400 * 1000);
            return isNaN(d.getTime()) ? null : d;
        }
        if (typeof raw === 'string') {
            const s = raw.trim().split(' ')[0];
            // DD.MM.YYYY (formato Fogas)
            if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) {
                const [d, m, y] = s.split('.');
                return new Date(y, m - 1, d);
            }
            // DD/MM/YYYY
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
                const [d, m, y] = s.split('/');
                return new Date(y, m - 1, d);
            }
            // YYYY-MM-DD
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s);
            // DD-MM-YYYY
            if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
                const [d, m, y] = s.split('-');
                return new Date(y, m - 1, d);
            }
            const t = new Date(s);
            return isNaN(t.getTime()) ? null : t;
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // Agrupa linhas brutas em clientes com array de dívidas
    // ═══════════════════════════════════════════════════════════════
    function agruparClientes(rows, mapeamento, nomeCredor) {
        const clientesMap = new Map();
        let linhasIgnoradas = 0;

        rows.forEach(row => {
            const dados = mapearLinha(row, mapeamento);
            const cpf   = String(dados.cpf_cnpj || '').replace(/\D/g, '');
            const nome  = String(dados.nome || '').trim();

            if (!cpf && !nome) { linhasIgnoradas++; return; }

            const chave = cpf || ('nome_' + nome.toLowerCase().replace(/\s+/g, '_'));

            const cpfFmt = cpf.length === 11
                ? cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
                : cpf.length === 14
                    ? cpf.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
                    : cpf;

            if (!clientesMap.has(chave)) {
                clientesMap.set(chave, {
                    cpf_cnpj:      cpf,
                    cpf_formatado: cpfFmt,
                    nome,
                    telefone:  dados.telefone  ? String(dados.telefone).replace(/\D/g, '')  : '',
                    telefone2: dados.telefone2 ? String(dados.telefone2).replace(/\D/g, '') : '',
                    email:     dados.email || '',
                    dividas:   [],
                    total_valor:  0,
                    total_dividas: 0,
                    maior_atraso: 0
                });
            }

            const cli       = clientesMap.get(chave);
            const valor     = parsearValor(dados.valor);
            const dataVenc  = parsearData(dados.data_vencimento);
            const diasAtraso = dataVenc
                ? Math.max(0, Math.floor((Date.now() - dataVenc.getTime()) / 86400000))
                : 0;

            if (valor > 0) {
                cli.dividas.push({
                    numero_documento: String(dados.numero_documento || '').trim() || null,
                    data_vencimento:  dataVenc ? dataVenc.toISOString().split('T')[0] : null,
                    valor,
                    descricao:   String(dados.descricao || '').trim() || `Importado ${nomeCredor}`,
                    dias_atraso: diasAtraso
                });
                cli.total_valor   += valor;
                cli.total_dividas += 1;
                if (diasAtraso > cli.maior_atraso) cli.maior_atraso = diasAtraso;
            }
        });

        return {
            clientes: Array.from(clientesMap.values()).filter(c => c.nome),
            linhasIgnoradas
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // Lê o arquivo e retorna linhas brutas (rows)
    // ═══════════════════════════════════════════════════════════════
    function lerArquivo(buffer, originalname) {
        const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });

        // Pegar aba com mais dados
        let melhorRows = [];
        for (const sheetName of workbook.SheetNames) {
            const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false });
            if (rows.length > melhorRows.length) melhorRows = rows;
        }
        return melhorRows;
    }

    // ═══════════════════════════════════════════════════════════════
    // POST /api/importacao/preview
    // ═══════════════════════════════════════════════════════════════
    router.post('/preview', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'Arquivo é obrigatório' });
            }

            const rows = lerArquivo(req.file.buffer, req.file.originalname);

            if (!rows.length) {
                return res.status(400).json({ success: false, error: 'Arquivo vazio' });
            }

            const mapeamento = detectarColunas(rows[0]);

            if (!mapeamento.nome && !mapeamento.cpf_cnpj) {
                return res.status(400).json({
                    success: false,
                    error: 'Não foi possível identificar colunas de Nome ou CPF. Colunas encontradas: ' + Object.keys(rows[0]).join(', ')
                });
            }

            const { clientes, linhasIgnoradas } = agruparClientes(rows, mapeamento, 'Importado');

            const stats = {
                total_linhas:        rows.length,
                linhas_ignoradas:    linhasIgnoradas,
                total_clientes:      clientes.length,
                total_dividas:       clientes.reduce((s, c) => s + c.total_dividas, 0),
                valor_total:         clientes.reduce((s, c) => s + c.total_valor, 0),
                clientes_com_atraso: clientes.filter(c => c.maior_atraso > 0).length
            };

            res.json({
                success: true,
                stats,
                clientes: clientes.sort((a, b) => b.maior_atraso - a.maior_atraso),
                mapeamento_detectado: mapeamento,
                colunas_detectadas:   Object.keys(rows[0] || {}).filter(Boolean)
            });

        } catch (error) {
            console.error('[IMPORTACAO] Erro no preview:', error);
            res.status(500).json({ success: false, error: 'Erro ao processar arquivo: ' + error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/importacao/executar
    // Aceita multipart (arquivo direto) ou JSON (clientes agrupados)
    // Usa transação única — rollback automático em caso de erro
    // ═══════════════════════════════════════════════════════════════
    router.post('/executar', auth, upload.single('file'), async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const nomeCredor = req.body.credor_nome || 'Carteira Geral';
            let credorId     = req.body.credor_id   || null;

            // Buscar ou criar credor
            if (!credorId) {
                const credorExiste = await client.query(
                    'SELECT id FROM credores WHERE nome ILIKE $1 LIMIT 1', [nomeCredor]
                );
                if (credorExiste.rows.length > 0) {
                    credorId = credorExiste.rows[0].id;
                } else {
                    const novo = await client.query(
                        `INSERT INTO credores (nome, created_at) VALUES ($1, NOW()) RETURNING id`,
                        [nomeCredor]
                    );
                    credorId = novo.rows[0].id;
                }
            }

            // ── Montar lista de clientes para importar ──────────────
            let clientesParaImportar = [];

            if (req.file) {
                // MODO ARQUIVO: lê e processa tudo no backend
                console.log(`[IMPORTACAO] Arquivo recebido: ${req.file.originalname} (${req.file.size} bytes)`);

                const rows = lerArquivo(req.file.buffer, req.file.originalname);

                if (!rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, error: 'Arquivo vazio' });
                }

                // Usar mapeamento enviado pelo frontend (já validado pelo usuário)
                // ou detectar automaticamente como fallback
                let mapeamento;
                try {
                    mapeamento = req.body.mapeamento
                        ? JSON.parse(req.body.mapeamento)
                        : detectarColunas(rows[0]);
                } catch(e) {
                    mapeamento = detectarColunas(rows[0]);
                }

                // Converter mapeamento do frontend { campo: coluna } para usar na leitura
                // O frontend envia { campo_sistema: coluna_planilha }
                const { clientes } = agruparClientes(rows, mapeamento, nomeCredor);
                clientesParaImportar = clientes.filter(c => c.nome && c.dividas.length > 0);

                console.log(`[IMPORTACAO] ${rows.length} linhas → ${clientesParaImportar.length} clientes únicos`);

            } else {
                // MODO JSON: clientes já agrupados pelo frontend
                clientesParaImportar = req.body.clientes || [];
            }

            if (!clientesParaImportar.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'Nenhum registro válido para importar' });
            }

            // ── Importar em transação única ─────────────────────────
            let clientesCriados     = 0;
            let clientesAtualizados = 0;
            let cobrancasCriadas    = 0;
            const erros             = [];

            for (const cli of clientesParaImportar) {
                try {
                    const cpfLimpo = String(cli.cpf_cnpj || '').replace(/\D/g, '');
                    let clienteId  = null;

                    // Buscar cliente existente pelo CPF
                    if (cpfLimpo) {
                        const existe = await client.query(
                            `SELECT id FROM clientes
                             WHERE REGEXP_REPLACE(cpf_cnpj, '[^0-9]', '', 'g') = $1 LIMIT 1`,
                            [cpfLimpo]
                        );
                        if (existe.rows.length > 0) {
                            clienteId = existe.rows[0].id;
                            await client.query(`
                                UPDATE clientes SET
                                    telefone   = COALESCE(NULLIF($2, ''), telefone),
                                    celular    = COALESCE(NULLIF($3, ''), celular),
                                    email      = COALESCE(NULLIF($4, ''), email),
                                    updated_at = NOW()
                                WHERE id = $1
                            `, [clienteId, cli.telefone || '', cli.telefone2 || '', cli.email || '']);
                            clientesAtualizados++;
                        }
                    }

                    // Criar cliente se não existe
                    if (!clienteId) {
                        const cpfFmt = cli.cpf_formatado || (cpfLimpo.length === 11
                            ? cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
                            : cpfLimpo.length === 14
                                ? cpfLimpo.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
                                : cpfLimpo);

                        const novo = await client.query(`
                            INSERT INTO clientes (
                                nome, cpf_cnpj, telefone, celular, email,
                                status, status_cobranca, portal_ativo, created_at, updated_at
                            ) VALUES ($1, $2, $3, $4, $5, 'ativo', 'novo', true, NOW(), NOW())
                            ON CONFLICT (cpf_cnpj) DO UPDATE SET
                                nome       = EXCLUDED.nome,
                                telefone   = COALESCE(NULLIF(EXCLUDED.telefone, ''), clientes.telefone),
                                updated_at = NOW()
                            RETURNING id
                        `, [
                            cli.nome,
                            cpfFmt || null,
                            cli.telefone  || null,
                            cli.telefone2 || null,
                            cli.email     || null
                        ]);
                        clienteId = novo.rows[0].id;
                        clientesCriados++;
                    }

                    // Inserir cobranças
                    for (const div of (cli.dividas || [])) {
                        try {
                            // Evitar duplicata por numero_documento + credor
                            if (div.numero_documento) {
                                const dup = await client.query(
                                    `SELECT id FROM cobrancas
                                     WHERE cliente_id = $1 AND credor_id = $2 AND numero_documento = $3 LIMIT 1`,
                                    [clienteId, credorId, div.numero_documento]
                                );
                                if (dup.rows.length > 0) continue;
                            }

                            const status = (div.dias_atraso || 0) > 0 ? 'vencido' : 'pendente';

                            await client.query(`
                                INSERT INTO cobrancas (
                                    cliente_id, credor_id, numero_documento,
                                    valor, valor_original, valor_atualizado,
                                    data_vencimento, vencimento,
                                    descricao, status, created_at, updated_at
                                ) VALUES ($1, $2, $3, $4, $4, $4, $5, $5, $6, $7, NOW(), NOW())
                            `, [
                                clienteId,
                                credorId,
                                div.numero_documento || null,
                                parseFloat(div.valor) || 0,
                                div.data_vencimento  || null,
                                String(div.descricao || `Importado ${nomeCredor}`).substring(0, 500),
                                status
                            ]);
                            cobrancasCriadas++;
                        } catch (errDiv) {
                            erros.push({ cliente: cli.nome, doc: div.numero_documento, erro: errDiv.message });
                        }
                    }

                } catch (errCli) {
                    erros.push({ cliente: cli.nome, erro: errCli.message });
                }
            }

            await client.query('COMMIT');

            console.log(`[IMPORTACAO] Concluído: ${clientesCriados} criados, ${clientesAtualizados} atualizados, ${cobrancasCriadas} cobranças, ${erros.length} erros`);

            if (registrarLog) {
                await registrarLog(req.user?.id, 'IMPORTACAO_MASSA', 'importacao', null, {
                    credor: nomeCredor, modo: req.file ? 'arquivo' : 'json',
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
                    credor_id:            credorId,
                    credor_nome:          nomeCredor,
                    clientes_criados:     clientesCriados,
                    clientes_atualizados: clientesAtualizados,
                    cobrancas_criadas:    cobrancasCriadas,
                    total_processados:    clientesParaImportar.length,
                    erros:                erros.slice(0, 20)
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[IMPORTACAO] Erro ao executar:', error);
            res.status(500).json({ success: false, error: 'Erro ao executar importação: ' + error.message });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/importacao/credores
    // ═══════════════════════════════════════════════════════════════
    router.get('/credores', auth, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT id, nome FROM credores ORDER BY nome'
            );
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Erro ao listar credores' });
        }
    });

    return router;
};