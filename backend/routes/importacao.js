/**
 * ========================================
 * ACERTIVE - Módulo de Importação em Massa
 * routes/importacao.js
 * ========================================
 * COPY FROM — 20x mais rápido que INSERTs individuais
 * SSE streaming — sem timeout
 */

const express = require('express');
const XLSX    = require('xlsx');
const { from: copyFrom } = require('pg-copy-streams');
const { Readable } = require('stream');

module.exports = function(pool, auth, upload, registrarLog) {
    const router = express.Router();

    function normalizarChave(str) {
        return String(str || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/g, '');
    }

    const CAMPO_ALIASES = {
        nome: ['nome','nomecli','nomecliente','paciente','cliente','devedor','razaosocial','razao','nomefantasia','proprietario','titular','nomedo','nomecompleto','name','fullname'],
        cpf_cnpj: ['cpf','cnpj','cpfcnpj','cnpjcpf','cpfoucnpj','documento','doc','cpfcliente','cnpjcliente','cadastro','numcpf','numerocpf','numerocnpj','identificacao','codcliente'],
        telefone: ['telefone','fone','celular','tel','telefone1','fone1','celular1','tel1','whatsapp','contato','telefoneprincipal','telefonecompleto','numerodofone','numerodetelefone','mobile','phone','telefoneum','telefonedo','foneresidencial','fonecelular','telefone01'],
        telefone2: ['telefone2','fone2','celular2','tel2','outrotelefone','telefoneadicional','telefonedois','contatoalternativo','telefonealternativo','phone2','secondphone','telefone02'],
        email: ['email','correioeletronico','mail','emailcliente','enderecoeletronico','emaildo','emaildocliente','emai','email01','emailum'],
        valor: ['valor','valororiginal','valordevido','valoremaberto','valoraberto','saldo','saldodevedor','valordadivida','divida','montante','valortotal','totaldevido','valorliquido','valordotratamento','valorliquidoa','vl','vlr','amount','balance','debt','valorincluso','valorinclusonospc','valornospc','valorspc'],
        data_vencimento: ['datavencimento','vencimento','data','datadevencimento','datadevcobr','datavc','datadevida','datadivida','datadeinclusao','datainclusao','datainclusa','dtvenc','dtvc','dtdevida','duedate','dataoperacao','datadocredito','datadeemissao','dtemisvencimento','datavenc','datadevenc','dtvencto'],
        numero_documento: ['numerodocumento','documento','numdoc','nrdocumento','numerotitulo','titulo','contrato','numcontrato','numerocontrato','chave','referencia','nf','nota','numeronf','invoice','protocolo','numprotocolo','pedido','numpedido','parcela','numeroparcela','doc','notafiscal'],
        descricao: ['descricao','historico','observacao','obs','descr','memo','comentario','detalhes','tipo','produto','servico','description','note','discriminacao','texto']
    };

    const MAPA_EXATO = {
        'Nome':'nome','NOMECLI':'nome','PACIENTE':'nome',
        'CNPJ/CPF':'cpf_cnpj','CPF':'cpf_cnpj','cnpj_cpf':'cpf_cnpj',
        'Montante':'valor','VALOR INCLUSO NO SPC':'valor','valor':'valor',
        'Dt.Vencto.':'data_vencimento','Data Vencimento':'data_vencimento','DATA DEVIDA':'data_vencimento',
        'Telefone 01':'telefone','TELEFONE 1':'telefone','telefone':'telefone',
        'Telefone 02':'telefone2','TELEFONE 2':'telefone2','telefone2':'telefone2',
        'E-mail 01':'email','E-MAIL':'email','email':'email',
        'Texto':'descricao','Histórico':'descricao',
        'Nota Fiscal':'numero_documento','Número do Documento':'numero_documento',
    };

    function detectarColunas(primeiraLinha) {
        const mapeamento = {};
        Object.keys(primeiraLinha).forEach(coluna => {
            if (MAPA_EXATO[coluna] && !mapeamento[MAPA_EXATO[coluna]]) {
                mapeamento[MAPA_EXATO[coluna]] = coluna; return;
            }
            const norm = normalizarChave(coluna);
            for (const [campo, aliases] of Object.entries(CAMPO_ALIASES)) {
                if (mapeamento[campo] && campo !== 'telefone2') continue;
                if (aliases.includes(norm)) {
                    if (campo === 'telefone2' && !mapeamento.telefone) continue;
                    mapeamento[campo] = coluna; break;
                }
            }
        });
        return mapeamento;
    }

    function mapearLinha(row, mapeamento) {
        const pegar = (campo) => {
            const col = mapeamento[campo];
            if (!col) return '';
            return row[col] !== undefined && row[col] !== null ? row[col] : '';
        };
        return {
            nome: pegar('nome'), cpf_cnpj: pegar('cpf_cnpj'),
            telefone: pegar('telefone'), telefone2: pegar('telefone2'),
            email: pegar('email'), valor: pegar('valor'),
            data_vencimento: pegar('data_vencimento'),
            numero_documento: pegar('numero_documento'), descricao: pegar('descricao')
        };
    }

    function parsearValor(raw) {
        if (!raw && raw !== 0) return 0;
        if (typeof raw === 'number') return isNaN(raw) ? 0 : parseFloat(raw.toFixed(2));
        if (typeof raw === 'string' && raw.startsWith('=')) {
            try { const r = eval(raw.slice(1)); return isNaN(r) ? 0 : parseFloat(parseFloat(r).toFixed(2)); } catch { return 0; }
        }
        let s = String(raw).trim().replace(/R\$\s*/g, '');
        const temPonto = s.includes('.'), temVirgula = s.includes(',');
        if (temPonto && temVirgula) {
            s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g,'').replace(',','.') : s.replace(/,/g,'');
        } else if (temVirgula && !temPonto) {
            const partes = s.split(',');
            s = (partes.length === 2 && partes[1].length <= 2) ? s.replace(',','.') : s.replace(/,/g,'');
        }
        const val = parseFloat(s.replace(/[^0-9.]/g,''));
        return isNaN(val) ? 0 : val;
    }

    function parsearData(raw) {
        if (!raw) return null;
        if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
        if (typeof raw === 'number') { const d = new Date((raw-25569)*86400*1000); return isNaN(d.getTime())?null:d; }
        if (typeof raw === 'string') {
            const s = raw.trim().split(' ')[0];
            if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) { const [d,m,y]=s.split('.'); return new Date(y,m-1,d); }
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [d,m,y]=s.split('/'); return new Date(y,m-1,d); }
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s);
            if (/^\d{2}-\d{2}-\d{4}$/.test(s)) { const [d,m,y]=s.split('-'); return new Date(y,m-1,d); }
            const t = new Date(s); return isNaN(t.getTime())?null:t;
        }
        return null;
    }

    function agruparClientes(rows, mapeamento, nomeCredor) {
        const clientesMap = new Map();
        let linhasIgnoradas = 0;
        rows.forEach(row => {
            const dados = mapearLinha(row, mapeamento);
            const cpf = String(dados.cpf_cnpj||'').replace(/\D/g,'');
            const nome = String(dados.nome||'').trim();
            if (!cpf && !nome) { linhasIgnoradas++; return; }
            const chave = cpf || ('nome_'+nome.toLowerCase().replace(/\s+/g,'_'));
            const cpfFmt = cpf.length===11 ? cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/,'$1.$2.$3-$4')
                : cpf.length===14 ? cpf.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,'$1.$2.$3/$4-$5') : cpf;
            if (!clientesMap.has(chave)) {
                clientesMap.set(chave, {
                    cpf_cnpj: cpf, cpf_formatado: cpfFmt, nome,
                    telefone: dados.telefone ? String(dados.telefone).replace(/\D/g,'') : '',
                    telefone2: dados.telefone2 ? String(dados.telefone2).replace(/\D/g,'') : '',
                    email: dados.email||'', dividas:[], total_valor:0, total_dividas:0, maior_atraso:0
                });
            }
            const cli = clientesMap.get(chave);
            const valor = parsearValor(dados.valor);
            const dataVenc = parsearData(dados.data_vencimento);
            const diasAtraso = dataVenc ? Math.max(0,Math.floor((Date.now()-dataVenc.getTime())/86400000)) : 0;
            if (valor > 0) {
                cli.dividas.push({
                    numero_documento: String(dados.numero_documento||'').trim()||null,
                    data_vencimento: dataVenc ? dataVenc.toISOString().split('T')[0] : null,
                    valor, descricao: String(dados.descricao||'').trim()||`Importado ${nomeCredor}`,
                    dias_atraso: diasAtraso
                });
                cli.total_valor += valor; cli.total_dividas++;
                if (diasAtraso > cli.maior_atraso) cli.maior_atraso = diasAtraso;
            }
        });
        return { clientes: Array.from(clientesMap.values()).filter(c=>c.nome), linhasIgnoradas };
    }

    function lerArquivo(buffer) {
        const workbook = XLSX.read(buffer, { type:'buffer', cellDates:true, raw:false });
        let melhorRows = [];
        for (const sheetName of workbook.SheetNames) {
            const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval:'', raw:false });
            if (rows.length > melhorRows.length) melhorRows = rows;
        }
        return melhorRows;
    }

    // Escapa campo para CSV do COPY
    function csvField(v) {
        if (v === null || v === undefined || v === '') return '\\N';
        const s = String(v).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\t/g,'\\t');
        return s;
    }

    // ── COPY clientes em lote ──────────────────────────────────────
    async function copiarClientes(client, clientes) {
        // Usar tabela temporária para fazer UPSERT via COPY
        await client.query(`
            CREATE TEMP TABLE tmp_clientes (
                nome TEXT, cpf_cnpj TEXT, telefone TEXT,
                celular TEXT, email TEXT
            ) ON COMMIT DROP
        `);

        // Gerar CSV para COPY
        const linhas = clientes.map(c =>
            [c.nome, c.cpf_formatado||c.cpf_cnpj, c.telefone||'', c.telefone2||'', c.email||'']
            .map(csvField).join('\t')
        ).join('\n');

        const stream = await client.query(copyFrom(
            'COPY tmp_clientes (nome, cpf_cnpj, telefone, celular, email) FROM STDIN'
        ));

        await new Promise((res, rej) => {
            const readable = Readable.from([linhas]);
            readable.pipe(stream);
            stream.on('finish', res);
            stream.on('error', rej);
            readable.on('error', rej);
        });

        // UPSERT da temp para clientes real
        await client.query(`
            INSERT INTO clientes (nome, cpf_cnpj, telefone, celular, email, status, status_cobranca, portal_ativo, created_at, updated_at)
            SELECT nome, cpf_cnpj, telefone, celular, email, 'ativo', 'novo', true, NOW(), NOW()
            FROM tmp_clientes
            WHERE cpf_cnpj IS NOT NULL AND cpf_cnpj != ''
            ON CONFLICT (cpf_cnpj) DO UPDATE SET
                nome = EXCLUDED.nome,
                telefone = COALESCE(NULLIF(EXCLUDED.telefone,''), clientes.telefone),
                updated_at = NOW()
        `);

        return clientes.length;
    }

    // ── COPY cobranças em lote ─────────────────────────────────────
    async function copiarCobrancas(client, clientes, credorId, nomeCredor) {
        // Buscar IDs dos clientes inseridos
        const cpfs = clientes.map(c => c.cpf_formatado||c.cpf_cnpj).filter(Boolean);
        if (!cpfs.length) return 0;

        const cpfMap = new Map();
        const res = await client.query(
            `SELECT id, cpf_cnpj FROM clientes WHERE cpf_cnpj = ANY($1)`,
            [cpfs]
        );
        res.rows.forEach(r => cpfMap.set(r.cpf_cnpj, r.id));

        // Também buscar por CPF limpo para casos de formatação diferente
        const cpfsLimpos = clientes.map(c => c.cpf_cnpj).filter(Boolean);
        const res2 = await client.query(
            `SELECT id, REGEXP_REPLACE(cpf_cnpj,'[^0-9]','','g') as cpf_limpo
             FROM clientes WHERE REGEXP_REPLACE(cpf_cnpj,'[^0-9]','','g') = ANY($1)`,
            [cpfsLimpos]
        );
        res2.rows.forEach(r => cpfMap.set(r.cpf_limpo, r.id));

        await client.query(`
            CREATE TEMP TABLE tmp_cobrancas (
                cliente_id UUID, credor_id UUID, numero_documento TEXT,
                valor NUMERIC, data_vencimento DATE, descricao TEXT, status TEXT
            ) ON COMMIT DROP
        `);

        const linhasCobranca = [];
        clientes.forEach(cli => {
            const clienteId = cpfMap.get(cli.cpf_formatado||cli.cpf_cnpj) || cpfMap.get(cli.cpf_cnpj);
            if (!clienteId) return;
            (cli.dividas||[]).forEach(div => {
                const status = (div.dias_atraso||0) > 0 ? 'vencido' : 'pendente';
                const desc = String(div.descricao||`Importado ${nomeCredor}`).substring(0,500);
                linhasCobranca.push([
                    clienteId, credorId,
                    div.numero_documento||'',
                    (parseFloat(div.valor)||0).toFixed(2),
                    div.data_vencimento||'',
                    desc, status
                ].map(csvField).join('\t'));
            });
        });

        if (!linhasCobranca.length) return 0;

        const csvCobrancas = linhasCobranca.join('\n');
        const stream2 = await client.query(copyFrom(
            'COPY tmp_cobrancas (cliente_id, credor_id, numero_documento, valor, data_vencimento, descricao, status) FROM STDIN'
        ));

        await new Promise((res, rej) => {
            const readable = Readable.from([csvCobrancas]);
            readable.pipe(stream2);
            stream2.on('finish', res);
            stream2.on('error', rej);
            readable.on('error', rej);
        });

        // Inserir ignorando duplicatas por numero_documento
        const result = await client.query(`
            INSERT INTO cobrancas (cliente_id, credor_id, numero_documento, valor, valor_original, valor_atualizado, data_vencimento, vencimento, descricao, status, created_at, updated_at)
            SELECT
                cliente_id, credor_id,
                NULLIF(numero_documento,''),
                valor, valor, valor,
                CASE WHEN data_vencimento != '' AND data_vencimento IS NOT NULL
                     THEN data_vencimento::date ELSE NULL END,
                CASE WHEN data_vencimento != '' AND data_vencimento IS NOT NULL
                     THEN data_vencimento::date ELSE NULL END,
                descricao, status, NOW(), NOW()
            FROM tmp_cobrancas
            ON CONFLICT DO NOTHING
        `);

        return result.rowCount || linhasCobranca.length;
    }

    // ═══════════════════════════════════════════════════════════════
    // POST /api/importacao/preview
    // ═══════════════════════════════════════════════════════════════
    router.post('/preview', auth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ success:false, error:'Arquivo é obrigatório' });
            const rows = lerArquivo(req.file.buffer);
            if (!rows.length) return res.status(400).json({ success:false, error:'Arquivo vazio' });
            const mapeamento = detectarColunas(rows[0]);
            if (!mapeamento.nome && !mapeamento.cpf_cnpj) {
                return res.status(400).json({ success:false, error:'Não foi possível identificar colunas de Nome ou CPF. Colunas: '+Object.keys(rows[0]).join(', ') });
            }
            const { clientes, linhasIgnoradas } = agruparClientes(rows, mapeamento, 'Importado');
            res.json({
                success:true,
                stats:{ total_linhas:rows.length, linhas_ignoradas:linhasIgnoradas,
                    total_clientes:clientes.length,
                    total_dividas:clientes.reduce((s,c)=>s+c.total_dividas,0),
                    valor_total:clientes.reduce((s,c)=>s+c.total_valor,0),
                    clientes_com_atraso:clientes.filter(c=>c.maior_atraso>0).length },
                clientes: clientes.sort((a,b)=>b.maior_atraso-a.maior_atraso),
                mapeamento_detectado: mapeamento,
                colunas_detectadas: Object.keys(rows[0]||{}).filter(Boolean)
            });
        } catch (error) {
            console.error('[IMPORTACAO] Erro no preview:', error);
            res.status(500).json({ success:false, error:'Erro ao processar arquivo: '+error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/importacao/executar — COPY FROM + SSE
    // ═══════════════════════════════════════════════════════════════
    router.post('/executar', auth, upload.single('file'), async (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const send = (data) => res.write('data: '+JSON.stringify(data)+'\n\n');

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const nomeCredor = req.body.credor_nome || 'Carteira Geral';
            let credorId     = req.body.credor_id   || null;

            send({ tipo:'status', msg:'Buscando credor...' });

            if (!credorId) {
                const credorExiste = await client.query('SELECT id FROM credores WHERE nome ILIKE $1 LIMIT 1',[nomeCredor]);
                credorId = credorExiste.rows.length > 0
                    ? credorExiste.rows[0].id
                    : (await client.query('INSERT INTO credores (nome,created_at) VALUES ($1,NOW()) RETURNING id',[nomeCredor])).rows[0].id;
            }

            send({ tipo:'status', msg:'Lendo e processando arquivo...' });

            let clientesParaImportar = [];
            if (req.file) {
                const rows = lerArquivo(req.file.buffer);
                if (!rows.length) {
                    send({ tipo:'erro', msg:'Arquivo vazio' });
                    await client.query('ROLLBACK'); client.release(); res.end(); return;
                }
                let mapeamento;
                try { mapeamento = req.body.mapeamento ? JSON.parse(req.body.mapeamento) : detectarColunas(rows[0]); }
                catch(e) { mapeamento = detectarColunas(rows[0]); }
                const { clientes } = agruparClientes(rows, mapeamento, nomeCredor);
                clientesParaImportar = clientes.filter(c=>c.nome&&c.dividas.length>0);
                send({ tipo:'progresso', pct:20, msg:`${rows.length} linhas → ${clientesParaImportar.length} clientes únicos` });
            } else {
                clientesParaImportar = req.body.clientes || [];
            }

            if (!clientesParaImportar.length) {
                send({ tipo:'erro', msg:'Nenhum registro válido para importar' });
                await client.query('ROLLBACK'); client.release(); res.end(); return;
            }

            // ── COPY clientes ──────────────────────────────────────
            send({ tipo:'progresso', pct:40, msg:`Importando ${clientesParaImportar.length} clientes via COPY...` });
            const clientesCriados = await copiarClientes(client, clientesParaImportar);

            // ── COPY cobranças ─────────────────────────────────────
            const totalDividas = clientesParaImportar.reduce((s,c)=>s+c.dividas.length,0);
            send({ tipo:'progresso', pct:70, msg:`Importando ${totalDividas} cobranças via COPY...` });
            const cobrancasCriadas = await copiarCobrancas(client, clientesParaImportar, credorId, nomeCredor);

            send({ tipo:'progresso', pct:95, msg:'Finalizando...' });
            await client.query('COMMIT');

            if (registrarLog) {
                await registrarLog(req.user?.id,'IMPORTACAO_MASSA','importacao',null,{
                    credor:nomeCredor, modo:'copy',
                    clientes_criados:clientesCriados,
                    cobrancas_criadas:cobrancasCriadas
                });
            }

            console.log(`[IMPORTACAO] COPY concluído: ${clientesCriados} clientes, ${cobrancasCriadas} cobranças`);

            send({ tipo:'concluido', resultado:{
                credor_id:credorId, credor_nome:nomeCredor,
                clientes_criados:clientesCriados, clientes_atualizados:0,
                cobrancas_criadas:cobrancasCriadas,
                total_processados:clientesParaImportar.length
            }});

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[IMPORTACAO] Erro:', error);
            send({ tipo:'erro', msg:'Erro na importação: '+error.message });
        } finally {
            client.release();
            res.end();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/importacao/credores
    // ═══════════════════════════════════════════════════════════════
    router.get('/credores', auth, async (req, res) => {
        try {
            const result = await pool.query('SELECT id, nome FROM credores ORDER BY nome');
            res.json({ success:true, data:result.rows });
        } catch (error) {
            res.status(500).json({ success:false, error:'Erro ao listar credores' });
        }
    });

    return router;
};