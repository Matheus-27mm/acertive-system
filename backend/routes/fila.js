/**
 * ============================================================
 * ACERTIVE — fila.js  v2
 * Módulo de lógica da Fila de Trabalho
 * ============================================================
 * Integra com:
 *   GET  /api/acionamentos/fila/devedores       → lista da fila
 *   GET  /api/acionamentos/fila/devedor/:id     → cobranças do cliente
 *   GET  /api/acionamentos/cliente/:id          → histórico do cliente
 *   GET  /api/cobrancas?cliente_id=:id          → fallback de cobranças
 *   POST /api/acionamentos                      → registrar contato
 *   PUT  /api/acionamentos/cliente/:id/status   → atualizar status
 *   POST /api/acordos                           → criar acordo
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────
const FilaState = {
  fila:         [],
  filaFiltrada: [],
  index:        0,
  atual:        null,
  paused:       false,
  cobAtual:        [],
  cobSelecionadas: new Set(),
  acoesHoje:    0,
  acordosHoje:  0,
  tempos:       [],
  tInicio:      Date.now(),
  credorAtivo:  '',
  termoBusca:   '',
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const API = window.location.origin;
const LS_KEY = 'acertive_fila_v1';

function authHeaders() {
  return { 'Authorization': 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' };
}
function fmtMoeda(v) { return (parseFloat(v)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function fmtData(iso) { if(!iso) return '—'; const d=new Date(iso); return isNaN(d)?'—':d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'}); }
function fmtTempo(ms) { const s=Math.round(ms/1000); return s>=60?`${Math.floor(s/60)}m${s%60}s`:`${s}s`; }

// ─────────────────────────────────────────────────────────────
// PERSISTÊNCIA
// ─────────────────────────────────────────────────────────────
function salvarEstado() {
  try {
    const d = FilaState.filaFiltrada[FilaState.index];
    localStorage.setItem(LS_KEY, JSON.stringify({
      idx: FilaState.index, clienteId: d?.id||null,
      credorAtivo: FilaState.credorAtivo, termoBusca: FilaState.termoBusca,
      ts: Date.now(),
    }));
  } catch(e) {}
}

function restaurarEstado() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const st = JSON.parse(raw);
    if (Date.now() - st.ts > 8*3600*1000) { localStorage.removeItem(LS_KEY); return null; }
    return st;
  } catch(e) { return null; }
}

function limparEstado() { localStorage.removeItem(LS_KEY); }

// ─────────────────────────────────────────────────────────────
// SCORE
// ─────────────────────────────────────────────────────────────
function calcularScore(d) {
  let s = 0;
  const dias = d.maior_atraso||0, val = d.valor||0, titulos = d.count||d.total_cobrancas||0;
  if      (dias>180) s+=40; else if (dias>90) s+=32; else if (dias>30) s+=20; else s+=8;
  if      (val>10000) s+=30; else if (val>5000) s+=24; else if (val>1000) s+=16; else s+=6;
  if (!d.ultimo_acionamento && !d.data_ultimo_contato) s+=20;
  if      (titulos>10) s+=10; else if (titulos>5) s+=7; else if (titulos>2) s+=4;
  return Math.min(s,100);
}

function nivelScore(score) {
  if (score>=80) return {nivel:'critico',label:'CRÍTICO',cor:'crit'};
  if (score>=50) return {nivel:'alto',label:'ALTO',cor:'high'};
  if (score>=20) return {nivel:'medio',label:'MÉDIO',cor:'med'};
  return {nivel:'baixo',label:'BAIXO',cor:'low'};
}

// ─────────────────────────────────────────────────────────────
// PRÓXIMA AÇÃO
// ─────────────────────────────────────────────────────────────
function proximaAcao(d) {
  const tel=d.telefone||d.celular||'', email=d.email||'',
    tentativas=d.total_acionamentos||0, dias=d.maior_atraso||0, valor=d.valor||0,
    nunca=!d.ultimo_acionamento&&!d.data_ultimo_contato;
  if (!tel) return email?'email':'detalhes';
  if (nunca) return 'whatsapp';
  if (tentativas>=4) return 'acordo';
  if (dias>180||valor>5000) return 'ligar';
  if (dias>60) return 'whatsapp';
  return 'whatsapp';
}

// ─────────────────────────────────────────────────────────────
// SCRIPT DE ABORDAGEM
// ─────────────────────────────────────────────────────────────
function gerarScript(d) {
  const dias=d.maior_atraso||0, valor=d.valor||0, tent=d.total_acionamentos||0,
    nunca=!d.ultimo_acionamento&&!d.data_ultimo_contato;
  if (tent>=4)             return `${tent} tentativas sem sucesso — ofereça desconto direto para fechar agora.`;
  if (dias>180&&valor>1000) return `Dívida antiga e relevante (+${dias}d). Desconto agressivo aumenta muito a chance de recuperação.`;
  if (nunca)               return 'Primeiro contato. Seja direto e amigável — apresente a situação e já proponha solução.';
  if (valor>5000)          return `Alto valor (${fmtMoeda(valor)}). Priorize ligação — negociação direta converte mais.`;
  if (dias>90)             return `+90 dias em atraso. Proponha acordo parcelado — facilitar o pagamento aumenta a conversão.`;
  if (dias>30)             return 'Dívida em atraso moderado. WhatsApp com proposta de acordo costuma ter boa resposta.';
  return 'Reforce a urgência e proponha parcelamento simples para fechar rápido.';
}

// ─────────────────────────────────────────────────────────────
// BADGES
// ─────────────────────────────────────────────────────────────
function gerarBadges(d) {
  const badges=[], dias=d.maior_atraso||0, valor=d.valor||0, titulos=d.total_cobrancas||0,
    nunca=!d.ultimo_acionamento&&!d.data_ultimo_contato;
  if (nunca) { badges.push({icon:'fa-user-plus',texto:'Nunca contatado',cls:'ok'}); }
  else if (d.ultimo_acionamento) {
    const dc=Math.floor((Date.now()-new Date(d.ultimo_acionamento))/864e5);
    if (dc<=2) badges.push({icon:'fa-clock',texto:`Contatado há ${dc}d`,cls:'warn'});
  }
  if      (dias>365) badges.push({icon:'fa-fire',texto:`+${dias} dias atraso`,cls:'danger'});
  else if (dias>90)  badges.push({icon:'fa-triangle-exclamation',texto:`${dias} dias atraso`,cls:'warn'});
  if      (valor>10000) badges.push({icon:'fa-circle-dollar-to-slot',texto:'Alto valor',cls:'danger'});
  else if (valor>3000)  badges.push({icon:'fa-circle-dollar-to-slot',texto:'Valor relevante',cls:'warn'});
  if (titulos>5) badges.push({icon:'fa-layer-group',texto:`${titulos} títulos`,cls:'info'});
  if ((d.total_acionamentos||0)>=4) badges.push({icon:'fa-rotate-right',texto:`${d.total_acionamentos} tentativas`,cls:'warn'});
  return badges;
}

// ─────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────
async function apiBuscarFila(offset=0,limit=200) {
  const r=await fetch(`${API}/api/acionamentos/fila/devedores?limit=${limit}&offset=${offset}`,{headers:authHeaders()});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).data||[];
}

async function apiBuscarHistorico(clienteId) {
  const r=await fetch(`${API}/api/acionamentos/cliente/${clienteId}`,{headers:authHeaders()});
  if (!r.ok) return [];
  return (await r.json()).data||[];
}

async function apiBuscarCobracoes(clienteId) {
  // Tenta rota de detalhe da fila primeiro
  try {
    const r=await fetch(`${API}/api/acionamentos/fila/devedor/${clienteId}`,{headers:authHeaders()});
    const d=await r.json();
    if (d.success && Array.isArray(d.data?.cobrancas) && d.data.cobrancas.length) return d.data.cobrancas;
  } catch(e) {}
  // Fallback: rota direta
  try {
    const r=await fetch(`${API}/api/cobrancas?cliente_id=${clienteId}&limit=100`,{headers:authHeaders()});
    return (await r.json()).data||[];
  } catch(e) { return []; }
}

async function apiRegistrarContato(payload) {
  const r=await fetch(`${API}/api/acionamentos`,{method:'POST',headers:authHeaders(),body:JSON.stringify(payload)});
  if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
  return r.json();
}

async function apiAtualizarStatus(clienteId,status) {
  await fetch(`${API}/api/acionamentos/cliente/${clienteId}/status`,{method:'PUT',headers:authHeaders(),body:JSON.stringify({status_cobranca:status})});
}

async function apiCriarAcordo(payload) {
  const r=await fetch(`${API}/api/acordos`,{method:'POST',headers:authHeaders(),body:JSON.stringify(payload)});
  if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
  return r.json();
}

// ─────────────────────────────────────────────────────────────
// CARREGAR FILA
// ─────────────────────────────────────────────────────────────
async function carregarFila() {
  let todos=[]; let offset=0; const PER=200;
  while (true) {
    const batch=await apiBuscarFila(offset,PER);
    todos=todos.concat(batch);
    if (batch.length<PER) break;
    offset+=PER; if (offset>20000) break;
  }
  FilaState.fila=todos.map(d=>({
    id:d.cliente_id, nome:d.nome||'Devedor', doc:d.cpf_cnpj||'—',
    telefone:d.celular||d.telefone||'', email:d.email||'', credor:d.credor_nome||'—',
    valor:parseFloat(d.valor_total)||0, count:parseInt(d.total_cobrancas)||0,
    maxDias:Math.min(parseInt(d.maior_atraso)||0,1825),
    maior_atraso:Math.min(parseInt(d.maior_atraso)||0,1825),
    total_acionamentos:parseInt(d.total_acionamentos)||0,
    tentativas:parseInt(d.total_acionamentos)||0,
    ultimo_acionamento:d.ultimo_acionamento||null,
    ultimoContato:d.ultimo_acionamento||null,
    data_ultimo_contato:d.data_ultimo_contato||null,
    status_cobranca:d.status_cobranca||'novo',
    _processado:false,
  })).map(d=>({...d,score:calcularScore(d),acao:proximaAcao(d),...nivelScore(calcularScore(d))}))
    .sort((a,b)=>b.score-a.score);
  return FilaState.fila;
}

// ─────────────────────────────────────────────────────────────
// FILTROS
// ─────────────────────────────────────────────────────────────
function aplicarFiltros() {
  const {credorAtivo,termoBusca,fila}=FilaState;
  FilaState.filaFiltrada=fila.filter(d=>{
    if (credorAtivo&&d.credor!==credorAtivo) return false;
    if (termoBusca) {
      const t=termoBusca.toLowerCase();
      return (d.nome||'').toLowerCase().includes(t)||(d.doc||'').toLowerCase().includes(t)||(d.telefone||'').toLowerCase().includes(t);
    }
    return true;
  });
  FilaState.index=0; FilaState.atual=FilaState.filaFiltrada[0]||null;
}

// ─────────────────────────────────────────────────────────────
// COBRANÇAS
// ─────────────────────────────────────────────────────────────
async function carregarCobracoes(clienteId) {
  FilaState.cobAtual=[]; FilaState.cobSelecionadas.clear();
  const todas=await apiBuscarCobracoes(clienteId);
  FilaState.cobAtual=todas
    .filter(c=>['pendente','vencido'].includes(c.status))
    .sort((a,b)=>new Date(a.data_vencimento||'9999')-new Date(b.data_vencimento||'9999'));
  return FilaState.cobAtual;
}

function toggleCobSelecao(id) {
  FilaState.cobSelecionadas.has(id)?FilaState.cobSelecionadas.delete(id):FilaState.cobSelecionadas.add(id);
  return FilaState.cobSelecionadas.size;
}
function selecionarTodasCob() { FilaState.cobAtual.forEach(c=>FilaState.cobSelecionadas.add(c.id)); return FilaState.cobSelecionadas.size; }
function desselecionarCob()   { FilaState.cobSelecionadas.clear(); return 0; }

function descrCobSelecionadas() {
  if (!FilaState.cobSelecionadas.size) return '';
  return FilaState.cobAtual
    .filter(c=>FilaState.cobSelecionadas.has(c.id))
    .map(c=>`${c.descricao||'Cobrança'} (${fmtMoeda(c.valor)})`)
    .join(', ');
}

// ─────────────────────────────────────────────────────────────
// NAVEGAÇÃO
// ─────────────────────────────────────────────────────────────
function avancar() {
  const {filaFiltrada,index}=FilaState;
  if (filaFiltrada[index]) filaFiltrada[index]._processado=true;
  FilaState.cobSelecionadas.clear();
  const prox=filaFiltrada.findIndex((d,i)=>i>index&&!d._processado);
  if (prox!==-1) { FilaState.index=prox; }
  else {
    const q=filaFiltrada.findIndex(d=>!d._processado);
    if (q===-1) { FilaState.atual=null; limparEstado(); return false; }
    FilaState.index=q;
  }
  FilaState.atual=FilaState.filaFiltrada[FilaState.index];
  salvarEstado(); return true;
}

function anterior() {
  if (FilaState.index>0) { FilaState.index--; FilaState.atual=FilaState.filaFiltrada[FilaState.index]; salvarEstado(); return true; }
  return false;
}

function pular() {
  const {filaFiltrada,index}=FilaState;
  const dev=filaFiltrada.splice(index,1)[0]; filaFiltrada.push(dev);
  if (FilaState.index>=filaFiltrada.length) FilaState.index=0;
  FilaState.atual=filaFiltrada[FilaState.index]; salvarEstado();
}

// ─────────────────────────────────────────────────────────────
// AÇÕES DE CONTATO
// ─────────────────────────────────────────────────────────────
function acaoLigar() {
  const d=FilaState.atual; if (!d) return;
  const tel=(d.telefone||'').replace(/\D/g,'');
  if (!tel) return {erro:'Telefone não cadastrado'};
  window.location.href=`tel:${tel}`; return {ok:true,canal:'telefone'};
}
function acaoWhatsApp() {
  const d=FilaState.atual; if (!d) return;
  const tel=(d.telefone||'').replace(/\D/g,'');
  if (!tel) return {erro:'Telefone não cadastrado'};
  window.open(`https://wa.me/${tel.startsWith('55')?tel:'55'+tel}`,'_blank');
  return {ok:true,canal:'whatsapp'};
}
function acaoEmail() {
  const d=FilaState.atual; if (!d) return;
  if (!d.email) return {erro:'E-mail não cadastrado'};
  window.location.href=`mailto:${d.email}?subject=${encodeURIComponent('Cobrança – '+d.credor)}`;
  return {ok:true,canal:'email'};
}

// ─────────────────────────────────────────────────────────────
// SALVAR + AVANÇAR — inclui cobranças selecionadas na descrição
// ─────────────────────────────────────────────────────────────
async function salvarEProximo({canal,resultado,descricao}) {
  const d=FilaState.atual; if (!d) throw new Error('Nenhum devedor ativo');
  FilaState.tempos.push(Date.now()-FilaState.tInicio);
  FilaState.tInicio=Date.now();
  const cobDesc=descrCobSelecionadas();
  const descFinal=[descricao,cobDesc?`Cob: ${cobDesc}`:''].filter(Boolean).join(' | ')||null;
  await apiRegistrarContato({
    cliente_id:d.id, tipo:canal||'whatsapp', canal:canal||'whatsapp',
    resultado, descricao:descFinal,
  });
  FilaState.acoesHoje++;
  return avancar();
}

// ─────────────────────────────────────────────────────────────
// ACORDO
// ─────────────────────────────────────────────────────────────
async function salvarAcordo({valorNegociado,parcelas,vencimento,observacao,canal}) {
  const d=FilaState.atual; if (!d) throw new Error('Nenhum devedor ativo');
  await apiCriarAcordo({
    cliente_id:d.id, valor_original:d.valor,
    valor_acordo:parseFloat(valorNegociado), numero_parcelas:parseInt(parcelas),
    data_primeiro_vencimento:vencimento||null, observacoes:observacao||null,
  });
  await apiRegistrarContato({
    cliente_id:d.id, tipo:canal||'whatsapp', canal:canal||'whatsapp',
    resultado:'gerou_acordo',
    descricao:`Acordo R$ ${valorNegociado} em ${parcelas}x. ${observacao||''}`.trim(),
  });
  await apiAtualizarStatus(d.id,'acordo');
  FilaState.acoesHoje++; FilaState.acordosHoje++;
  return avancar();
}

// ─────────────────────────────────────────────────────────────
// INCOBRÁVEL
// ─────────────────────────────────────────────────────────────
async function marcarIncobravel({motivo,descricao,canal}) {
  const d=FilaState.atual; if (!d) throw new Error('Nenhum devedor ativo');
  await apiAtualizarStatus(d.id,'incobravel');
  await apiRegistrarContato({
    cliente_id:d.id, tipo:'incobravel', canal:canal||'whatsapp', resultado:'recusou',
    descricao:`[INCOBRÁVEL - ${motivo}] ${descricao||''}`.trim(),
  });
  FilaState.acoesHoje++; return avancar();
}

// ─────────────────────────────────────────────────────────────
// HISTÓRICO
// ─────────────────────────────────────────────────────────────
async function buscarHistoricoAtual() {
  const d=FilaState.atual; if (!d) return [];
  const regs=await apiBuscarHistorico(d.id);
  if (regs.length>0) {
    d.total_acionamentos=d.tentativas=regs.length;
    d.ultimo_acionamento=d.ultimoContato=regs[0].created_at;
    d.score=calcularScore(d); d.acao=proximaAcao(d);
    Object.assign(d,nivelScore(d.score));
  }
  return regs;
}

// ─────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────
function getStats() {
  const {acoesHoje,acordosHoje,tempos,filaFiltrada,index}=FilaState;
  const mediaMs=tempos.length?tempos.reduce((a,b)=>a+b,0)/tempos.length:0;
  return {
    acoesHoje, acordosHoje, tempoMedio:mediaMs?fmtTempo(mediaMs):'—',
    total:filaFiltrada.length, posicao:index+1,
    restantes:Math.max(0,filaFiltrada.length-index-1),
    pct:filaFiltrada.length?Math.round(index/filaFiltrada.length*100):0,
  };
}

function getCredoresUnicos() {
  return [...new Set(FilaState.fila.map(d=>d.credor).filter(Boolean))].sort();
}

// ─────────────────────────────────────────────────────────────
// EXPORTAR
// ─────────────────────────────────────────────────────────────
window.Fila = {
  get state()           { return FilaState; },
  get atual()           { return FilaState.atual; },
  get fila()            { return FilaState.fila; },
  get filaFiltrada()    { return FilaState.filaFiltrada; },
  get index()           { return FilaState.index; },
  get cobAtual()        { return FilaState.cobAtual; },
  get cobSelecionadas() { return FilaState.cobSelecionadas; },

  carregarFila, aplicarFiltros,
  setCreedor(v) { FilaState.credorAtivo=v; },
  setBusca(v)   { FilaState.termoBusca=v.trim().toLowerCase(); },

  salvarEstado, restaurarEstado, limparEstado,

  avancar, anterior, pular,
  acaoLigar, acaoWhatsApp, acaoEmail,
  salvarEProximo, salvarAcordo, marcarIncobravel,
  carregarCobracoes, toggleCobSelecao, selecionarTodasCob, desselecionarCob, descrCobSelecionadas,
  buscarHistoricoAtual,
  calcularScore, nivelScore, proximaAcao, gerarScript, gerarBadges,
  getStats, getCredoresUnicos, fmtMoeda, fmtData,
};