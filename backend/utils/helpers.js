/**
 * Funções auxiliares - ACERTIVE
 */

const asStr = (v) => String(v ?? "").trim();

const num = (v, def = 0) => { 
  const n = Number(v); 
  return Number.isFinite(n) ? n : def; 
};

function round2(n) { 
  return Math.round((Number(n) || 0) * 100) / 100; 
}

function toPgDateOrNull(v) {
  const s = asStr(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

const normalizeCpfCnpjDigits = (s) => String(s || "").replace(/\D/g, "");

const normalizeEmail = (s) => String(s || "").trim().toLowerCase();

const fmtMoney = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const fmtDate = (d) => { 
  if (!d) return "—"; 
  const dt = new Date(d); 
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString("pt-BR"); 
};

const fmtDateTime = (d) => { 
  if (!d) return "—"; 
  const dt = new Date(d); 
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleString("pt-BR"); 
};

module.exports = {
  asStr,
  num,
  round2,
  toPgDateOrNull,
  normalizeCpfCnpjDigits,
  normalizeEmail,
  fmtMoney,
  fmtDate,
  fmtDateTime
};
