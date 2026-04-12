/**
 * ============================================================
 * ACERTIVE — fila.js
 * Módulo de lógica da Fila de Trabalho
 * ============================================================
 * Integra com:
 *   GET  /api/acionamentos/fila/devedores  → lista da fila
 *   GET  /api/acionamentos/cliente/:id     → histórico do cliente
 *   POST /api/acionamentos                 → registrar contato
 *   PUT  /api/acionamentos/cliente/:id/status → atualizar status
 *   POST /api/acordos                      → criar acordo
 *   GET  /api/cobrancas/:id/whatsapp       → link WhatsApp por cobrança
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────
const FilaState = {
  fila:         [],       // todos os devedores da sessão
  filaFiltrada: [],       // após filtros de credor + busca
  index:        0,        // posição atual
  atual:        null,     // devedor em foco agora
  paused:       false,

  // métricas da sessão (em memória)
  acoesHoje:    0,
  acordosHoje:  0,
  tempos:       [],       // ms por atendimento
  tInicio:      Date.now(),

  // filtros ativos
  credorAtivo:  '',
  termoBusca:   '',
};

// ─────────────────────────────────────────────────────────────
// HELPERS BÁSICOS
// ─────────────────────────────────────────────────────────────
const API = window.location.origin;

function authHeaders() {
  return {
    'Authorization': 'Bearer ' + localStorage.getItem('token'),
    'Content-Type':  'application/json',
  };
}

function fmtMoeda(v) {
  return (parseFloat(v) || 0).toLocaleString('pt-BR', {
    style: 'currency', currency: 'BRL',
  });
}

function fmtData(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit' });
}

function fmtTempo(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s/60)}m${s%60}s` : `${s}s`;
}

// ─────────────────────────────────────────────────────────────
// SCORE DE PRIORIDADE
// Baseado nos campos reais de /api/acionamentos/fila/devedores:
//   maior_atraso, valor_total, total_acionamentos, ultimo_acionamento
// ─────────────────────────────────────────────────────────────
function calcularScore(d) {
  let score = 0;

  // Dias em atraso — peso máximo (campo: maior_atraso)
  const dias = d.maior_atraso || 0;
  if      (dias > 180) score += 40;
  else if (dias > 90)  score += 32;
  else if (dias > 30)  score += 20;
  else                 score += 8;

  // Valor da dívida — peso alto (campo: valor_total, já numeric)
  const val = d.valor || 0;
  if      (val > 10000) score += 30;
  else if (val > 5000)  score += 24;
  else if (val > 1000)  score += 16;
  else                  score += 6;

  // Nunca contatado — oportunidade (campo: ultimo_acionamento)
  if (!d.ultimo_acionamento && !d.data_ultimo_contato) score += 20;

  // Muitos títulos — usa d.count (mapeado de total_cobrancas na API)
  const titulos = d.count || d.total_cobrancas || 0;
  if      (titulos > 10) score += 10;
  else if (titulos > 5)  score += 7;
  else if (titulos > 2)  score += 4;

  return Math.min(score, 100);
}

function nivelScore(score) {
  if (score >= 80) return { nivel: 'critico', label: 'CRÍTICO',  cor: 'crit' };
  if (score >= 50) return { nivel: 'alto',    label: 'ALTO',     cor: 'high' };
  if (score >= 20) return { nivel: 'medio',   label: 'MÉDIO',    cor: 'med'  };
  return               { nivel: 'baixo',   label: 'BAIXO',    cor: 'low'  };
}

// ─────────────────────────────────────────────────────────────
// PRÓXIMA MELHOR AÇÃO
// Decide qual canal tem maior chance de conversão agora
// ─────────────────────────────────────────────────────────────
function proximaAcao(d) {
  const tel        = d.telefone || d.celular || '';
  const email      = d.email || '';
  const tentativas = d.total_acionamentos || 0;
  const dias       = d.maior_atraso || 0;
  const valor      = d.valor || 0;
  const nunca      = !d.ultimo_acionamento && !d.data_ultimo_contato;

  // Sem telefone: e-mail ou nada
  if (!tel) return email ? 'email' : 'detalhes';

  // Primeiro contato: WhatsApp amigável
  if (nunca) return 'whatsapp';

  // Muitas tentativas sem sucesso: propor acordo direto
  if (tentativas >= 4) return 'acordo';

  // Dívida muito antiga ou alto valor: ligação direta
  if (dias > 180 || valor > 5000) return 'ligar';

  // Dívida moderada: WhatsApp com proposta
  if (dias > 60) return 'whatsapp';

  return 'whatsapp';
}

// ─────────────────────────────────────────────────────────────
// SCRIPT DE ABORDAGEM
// Texto sugerido para o operador
// ─────────────────────────────────────────────────────────────
function gerarScript(d) {
  const dias       = d.maior_atraso || 0;
  const valor      = d.valor || 0;
  const tentativas = d.total_acionamentos || 0;
  const nunca      = !d.ultimo_acionamento && !d.data_ultimo_contato;

  if (tentativas >= 4) {
    return `${tentativas} tentativas sem sucesso — ofereça desconto direto para fechar agora.`;
  }
  if (dias > 180 && valor > 1000) {
    return `Dívida antiga e relevante (+${dias}d). Desconto agressivo aumenta muito a chance de recuperação.`;
  }
  if (nunca) {
    return 'Primeiro contato. Seja direto e amigável — apresente a situação e já proponha solução.';
  }
  if (valor > 5000) {
    return `Alto valor (${fmtMoeda(valor)}). Priorize ligação — negociação direta converte mais.`;
  }
  if (dias > 90) {
    return `+90 dias em atraso. Proponha acordo parcelado — facilitar o pagamento aumenta a conversão.`;
  }
  if (dias > 30) {
    return 'Dívida em atraso moderado. WhatsApp com proposta de acordo costuma ter boa resposta.';
  }
  return 'Reforce a urgência e proponha parcelamento simples para fechar rápido.';
}

// ─────────────────────────────────────────────────────────────
// BADGES / ALERTAS INTELIGENTES
// ─────────────────────────────────────────────────────────────
function gerarBadges(d) {
  const badges = [];
  const dias    = d.maior_atraso || 0;
  const valor   = d.valor || 0;
  const titulos = d.total_cobrancas || 0;
  const nunca   = !d.ultimo_acionamento && !d.data_ultimo_contato;

  if (nunca) {
    badges.push({ icon: 'fa-user-plus', texto: 'Nunca contatado', cls: 'ok' });
  } else if (d.ultimo_acionamento) {
    const diasContato = Math.floor((Date.now() - new Date(d.ultimo_acionamento)) / 864e5);
    if (diasContato <= 2) {
      badges.push({ icon: 'fa-clock', texto: `Contatado há ${diasContato}d`, cls: 'warn' });
    }
  }

  if (dias > 365)  badges.push({ icon: 'fa-fire',                texto: `+${dias} dias atraso`,    cls: 'danger' });
  else if (dias > 90) badges.push({ icon: 'fa-triangle-exclamation', texto: `${dias} dias atraso`,  cls: 'warn' });

  if (valor > 10000) badges.push({ icon: 'fa-circle-dollar-to-slot', texto: 'Alto valor',           cls: 'danger' });
  else if (valor > 3000) badges.push({ icon: 'fa-circle-dollar-to-slot', texto: 'Valor relevante',  cls: 'warn' });

  if (titulos > 5) badges.push({ icon: 'fa-layer-group', texto: `${titulos} títulos`,              cls: 'info' });

  if ((d.total_acionamentos || 0) >= 4) {
    badges.push({ icon: 'fa-rotate-right', texto: `${d.total_acionamentos} tentativas`,             cls: 'warn' });
  }

  return badges;
}

// ─────────────────────────────────────────────────────────────
// API — BUSCAR FILA
// ─────────────────────────────────────────────────────────────
async function apiBuscarFila(offset = 0, limit = 200) {
  const r = await fetch(
    `${API}/api/acionamentos/fila/devedores?limit=${limit}&offset=${offset}`,
    { headers: authHeaders() }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return d.data || [];
}

async function apiBuscarHistorico(clienteId) {
  const r = await fetch(
    `${API}/api/acionamentos/cliente/${clienteId}`,
    { headers: authHeaders() }
  );
  if (!r.ok) return [];
  const d = await r.json();
  return d.data || [];
}

async function apiRegistrarContato(payload) {
  // POST /api/acionamentos
  // Campos obrigatórios: cliente_id, tipo, resultado
  const r = await fetch(`${API}/api/acionamentos`, {
    method:  'POST',
    headers: authHeaders(),
    body:    JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function apiAtualizarStatus(clienteId, statusCobranca) {
  // PUT /api/acionamentos/cliente/:id/status
  await fetch(`${API}/api/acionamentos/cliente/${clienteId}/status`, {
    method:  'PUT',
    headers: authHeaders(),
    body:    JSON.stringify({ status_cobranca: statusCobranca }),
  });
}

async function apiCriarAcordo(payload) {
  // POST /api/acordos
  const r = await fetch(`${API}/api/acordos`, {
    method:  'POST',
    headers: authHeaders(),
    body:    JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function apiWhatsAppLink(clienteId) {
  // GET /api/cobrancas/:id/whatsapp não é por cliente, é por cobrança
  // Usamos o telefone diretamente pois o campo vem da fila
  // Este endpoint existe mas precisaria do id da cobrança, não do cliente
  // → retorna null, e o caller usa o telefone diretamente
  return null;
}

// ─────────────────────────────────────────────────────────────
// CARREGAR FILA COMPLETA (paginação automática)
// ─────────────────────────────────────────────────────────────
async function carregarFila() {
  try {
    let todos = [];
    const PER_PAGE = 200;
    let offset = 0;

    while (true) {
      const batch = await apiBuscarFila(offset, PER_PAGE);
      todos = todos.concat(batch);
      if (batch.length < PER_PAGE) break;
      offset += PER_PAGE;
      if (offset > 20000) break; // segurança
    }

    // Mapear para shape interno — usar SOMENTE campos reais da API
    FilaState.fila = todos.map(d => ({
      // identificação
      id:               d.cliente_id,                                  // UUID do cliente
      nome:             d.nome             || 'Devedor',
      doc:              d.cpf_cnpj         || '—',
      telefone:         d.celular          || d.telefone || '',
      email:            d.email            || '',
      credor:           d.credor_nome      || '—',

      // financeiro — vindos PRONTOS do SQL, não recalculados
      valor:            parseFloat(d.valor_total)    || 0,             // ✅ SUM do banco
      count:            parseInt(d.total_cobrancas)  || 0,             // ✅ COUNT do banco
      maxDias:          Math.min(parseInt(d.maior_atraso) || 0, 1825), // ✅ MAX do banco (cap 5 anos)
      maior_atraso:     Math.min(parseInt(d.maior_atraso) || 0, 1825),

      // histórico
      total_acionamentos: parseInt(d.total_acionamentos) || 0,
      ultimo_acionamento: d.ultimo_acionamento || null,
      data_ultimo_contato: d.data_ultimo_contato || null,
      status_cobranca:    d.status_cobranca || 'novo',

      // processado na sessão
      _processado: false,
    })).map(d => ({
      ...d,
      score: calcularScore(d),
      acao:  proximaAcao(d),
      ...nivelScore(calcularScore(d)),
    })).sort((a, b) => b.score - a.score);

    return FilaState.fila;
  } catch (e) {
    console.error('[FILA] carregarFila:', e);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────
// APLICAR FILTROS (credor + busca)
// ─────────────────────────────────────────────────────────────
function aplicarFiltros() {
  const { credorAtivo, termoBusca, fila } = FilaState;

  FilaState.filaFiltrada = fila.filter(d => {
    if (credorAtivo && d.credor !== credorAtivo) return false;
    if (termoBusca) {
      const t = termoBusca.toLowerCase();
      return (d.nome   || '').toLowerCase().includes(t)
          || (d.doc    || '').toLowerCase().includes(t)
          || (d.telefone || '').toLowerCase().includes(t);
    }
    return true;
  });

  FilaState.index  = 0;
  FilaState.atual  = FilaState.filaFiltrada[0] || null;
}

// ─────────────────────────────────────────────────────────────
// NAVEGAÇÃO
// ─────────────────────────────────────────────────────────────
function avancar() {
  const { filaFiltrada, index } = FilaState;

  // Marcar atual como processado
  if (filaFiltrada[index]) filaFiltrada[index]._processado = true;

  // Próximo não processado com maior score (lista já ordenada)
  const prox = filaFiltrada.findIndex((d, i) => i > index && !d._processado);

  if (prox !== -1) {
    FilaState.index = prox;
  } else {
    // Verificar se ainda há algum não processado
    const qualquer = filaFiltrada.findIndex(d => !d._processado);
    if (qualquer === -1) {
      FilaState.atual = null; // fila concluída
      return false;           // sinaliza para mostrar empty state
    }
    FilaState.index = qualquer;
  }

  FilaState.atual = FilaState.filaFiltrada[FilaState.index];
  return true;
}

function anterior() {
  if (FilaState.index > 0) {
    FilaState.index--;
    FilaState.atual = FilaState.filaFiltrada[FilaState.index];
    return true;
  }
  return false;
}

function pular() {
  const { filaFiltrada, index } = FilaState;
  const dev = filaFiltrada.splice(index, 1)[0];
  filaFiltrada.push(dev);
  if (FilaState.index >= filaFiltrada.length) FilaState.index = 0;
  FilaState.atual = filaFiltrada[FilaState.index];
}

// ─────────────────────────────────────────────────────────────
// AÇÕES DE CONTATO
// ─────────────────────────────────────────────────────────────
function acaoLigar() {
  const d = FilaState.atual;
  if (!d) return;
  const tel = (d.telefone || '').replace(/\D/g, '');
  if (!tel) return { erro: 'Telefone não cadastrado' };
  window.location.href = `tel:${tel}`;
  return { ok: true, canal: 'telefone' };
}

function acaoWhatsApp() {
  const d = FilaState.atual;
  if (!d) return;
  const tel = (d.telefone || '').replace(/\D/g, '');
  if (!tel) return { erro: 'Telefone não cadastrado' };
  const num = tel.startsWith('55') ? tel : `55${tel}`;
  window.open(`https://wa.me/${num}`, '_blank');
  return { ok: true, canal: 'whatsapp' };
}

function acaoEmail() {
  const d = FilaState.atual;
  if (!d) return;
  if (!d.email) return { erro: 'E-mail não cadastrado' };
  const subject = encodeURIComponent(`Cobrança – ${d.credor}`);
  window.location.href = `mailto:${d.email}?subject=${subject}`;
  return { ok: true, canal: 'email' };
}

// ─────────────────────────────────────────────────────────────
// SALVAR CONTATO + AVANÇAR (fluxo principal)
// ─────────────────────────────────────────────────────────────
async function salvarEProximo({ canal, resultado, descricao }) {
  const d = FilaState.atual;
  if (!d) throw new Error('Nenhum devedor ativo');

  // Registrar tempo de atendimento
  FilaState.tempos.push(Date.now() - FilaState.tInicio);
  FilaState.tInicio = Date.now();

  // POST /api/acionamentos — campos validados pelo backend
  await apiRegistrarContato({
    cliente_id: d.id,
    tipo:       'contato_ativo',
    canal:      canal    || 'whatsapp',
    resultado:  resultado,           // obrigatório
    descricao:  descricao || null,
  });

  FilaState.acoesHoje++;
  return avancar();
}

// ─────────────────────────────────────────────────────────────
// SALVAR ACORDO
// ─────────────────────────────────────────────────────────────
async function salvarAcordo({ valorNegociado, parcelas, vencimento, observacao, canal }) {
  const d = FilaState.atual;
  if (!d) throw new Error('Nenhum devedor ativo');

  // Criar acordo — POST /api/acordos
  // Campos exatos conforme acordos.js:
  //   valor_acordo (obrigatório), numero_parcelas (obrigatório)
  //   data_primeiro_vencimento (opcional — backend usa +30d como default)
  await apiCriarAcordo({
    cliente_id:               d.id,
    valor_original:           d.valor,
    valor_acordo:             parseFloat(valorNegociado),  // ✅ nome correto
    numero_parcelas:          parseInt(parcelas),          // ✅ nome correto
    data_primeiro_vencimento: vencimento || null,          // ✅ nome correto
    observacoes:              observacao || null,          // ✅ plural conforme backend
  });

  // Registrar acionamento de acordo
  await apiRegistrarContato({
    cliente_id: d.id,
    tipo:       canal || 'whatsapp',
    canal:      canal || 'whatsapp',
    resultado:  'gerou_acordo',
    descricao:  `Acordo R$ ${valorNegociado} em ${parcelas}x. ${observacao || ''}`.trim(),
  });

  // Atualizar status do cliente
  await apiAtualizarStatus(d.id, 'acordo');

  FilaState.acoesHoje++;
  FilaState.acordosHoje++;
  return avancar();
}

// ─────────────────────────────────────────────────────────────
// MARCAR INCOBRÁVEL
// ─────────────────────────────────────────────────────────────
async function marcarIncobravel({ motivo, descricao, canal }) {
  const d = FilaState.atual;
  if (!d) throw new Error('Nenhum devedor ativo');

  // Atualizar status
  await apiAtualizarStatus(d.id, 'incobravel');

  // Registrar acionamento
  await apiRegistrarContato({
    cliente_id: d.id,
    tipo:       'incobravel',
    canal:      canal || 'whatsapp',
    resultado:  'recusou',
    descricao:  `[INCOBRÁVEL - ${motivo}] ${descricao || ''}`.trim(),
  });

  FilaState.acoesHoje++;
  return avancar();
}

// ─────────────────────────────────────────────────────────────
// HISTÓRICO DO DEVEDOR ATUAL
// ─────────────────────────────────────────────────────────────
async function buscarHistoricoAtual() {
  const d = FilaState.atual;
  if (!d) return [];
  const regs = await apiBuscarHistorico(d.id);

  // Atualizar metadados do devedor com dados reais do histórico
  if (regs.length > 0) {
    d.total_acionamentos = regs.length;
    d.ultimo_acionamento = regs[0].created_at;
    // Recalcular score e ação com dados mais precisos
    d.score = calcularScore(d);
    d.acao  = proximaAcao(d);
    Object.assign(d, nivelScore(d.score));
  }

  return regs;
}

// ─────────────────────────────────────────────────────────────
// STATS DA SESSÃO
// ─────────────────────────────────────────────────────────────
function getStats() {
  const { acoesHoje, acordosHoje, tempos, filaFiltrada, index } = FilaState;
  const mediaMs = tempos.length
    ? tempos.reduce((a, b) => a + b, 0) / tempos.length
    : 0;

  return {
    acoesHoje,
    acordosHoje,
    tempoMedio:    mediaMs ? fmtTempo(mediaMs) : '—',
    total:         filaFiltrada.length,
    posicao:       index + 1,
    restantes:     Math.max(0, filaFiltrada.length - index - 1),
    pct:           filaFiltrada.length
                    ? Math.round(index / filaFiltrada.length * 100)
                    : 0,
  };
}

// ─────────────────────────────────────────────────────────────
// CREDORES ÚNICOS (para popular filtro)
// ─────────────────────────────────────────────────────────────
function getCredoresUnicos() {
  return [...new Set(FilaState.fila.map(d => d.credor).filter(Boolean))].sort();
}

// ─────────────────────────────────────────────────────────────
// EXPORTAR TUDO (usado pelo fila.html via window.Fila)
// ─────────────────────────────────────────────────────────────
window.Fila = {
  // estado (read-only acesso)
  get state()        { return FilaState; },
  get atual()        { return FilaState.atual; },
  get fila()         { return FilaState.fila; },
  get filaFiltrada() { return FilaState.filaFiltrada; },
  get index()        { return FilaState.index; },

  // carregamento
  carregarFila,
  aplicarFiltros,

  // filtros
  setCreedor(v)  { FilaState.credorAtivo = v; },
  setBusca(v)    { FilaState.termoBusca  = v.trim().toLowerCase(); },

  // navegação
  avancar,
  anterior,
  pular,

  // ações de contato
  acaoLigar,
  acaoWhatsApp,
  acaoEmail,

  // fluxo principal
  salvarEProximo,
  salvarAcordo,
  marcarIncobravel,

  // histórico
  buscarHistoricoAtual,

  // inteligência
  calcularScore,
  nivelScore,
  proximaAcao,
  gerarScript,
  gerarBadges,

  // utilidades
  getStats,
  getCredoresUnicos,
  fmtMoeda,
  fmtData,
};