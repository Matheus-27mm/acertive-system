// nova-cobranca.js — versão limpa para produção (PDF bonito via backend Playwright)
(function () {
  const logado = localStorage.getItem("usuarioLogado");
  const isLoggedIn = localStorage.getItem("isLoggedIn");
  if (!logado && isLoggedIn !== "true") {
    window.location.href = "/login";
    return;
  }

  (function tokenCheck() {
    const token = localStorage.getItem("token");
    if (!token) {
      if (typeof Toastify !== "undefined") {
        Toastify({
          text: "Sessão expirada. Faça login novamente.",
          duration: 3000,
          close: true,
          gravity: "top",
          position: "right",
          style: { background: "#dc3545" },
          stopOnFocus: true,
        }).showToast();
      } else {
        alert("Sessão expirada. Faça login novamente.");
      }
      setTimeout(() => (window.location.href = "/login"), 1200);
    }
  })();

  function showToast(msg, type = "success") {
    if (typeof Toastify === "undefined") return alert(msg);
    Toastify({
      text: msg,
      duration: 3500,
      close: true,
      gravity: "top",
      position: "right",
      style: { background: type === "success" ? "#28a745" : "#dc3545" },
      stopOnFocus: true,
    }).showToast();
  }

  function moedaBR(v) {
    const n = Number(v || 0);
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatarDataBR(iso) {
    if (!iso) return "—";
    const d = new Date(String(iso).slice(0, 10) + "T00:00:00");
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("pt-BR");
  }

  function normalizePercent(taxaStr) {
    const s = String(taxaStr || "").replace("%", "").replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  const TAXAS = { "8%": 0.0027, "6%": 0.002, "4%": 0.0014, "3%": 0.001, "2%": 0.0007 };
  const MULTA = 0.02;

  const btnLogout = document.getElementById("btnLogout");
  const form = document.getElementById("formCobranca");
  const btnPdf = document.getElementById("btnPdf");

  const elResultado = document.querySelector(".resultCard");
  const elStatusMsg = document.getElementById("statusMsg");

  const resCliente = document.getElementById("resCliente");
  const resOriginal = document.getElementById("resOriginal");
  const resVencimento = document.getElementById("resVencimento");
  const resPagamento = document.getElementById("resPagamento");
  const resDias = document.getElementById("resDias");
  const resJuros = document.getElementById("resJuros");
  const resMulta = document.getElementById("resMulta");
  const resAtualizado = document.getElementById("resAtualizado");

  const inputNome = document.getElementById("cliente_nome");
  const inputId = document.getElementById("cliente_id");
  const datalist = document.getElementById("listaClientes");

  let dadosCobranca = null;
  let cobrancaIdGerada = null; // <<< FIX: guarda ID real retornado do servidor
  let clientesCache = [];

  if (!form || !btnPdf) return;

  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("usuarioLogado");
      localStorage.removeItem("isLoggedIn");
      localStorage.removeItem("username");
      localStorage.removeItem("token");
      localStorage.removeItem("refreshToken");
      window.location.href = "/login";
    });
  }

  // ===============
  // Helper: download blob
  // ===============
  function baixarBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "cobranca.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ===============
  // Exportar PDF bonito (backend Playwright)
  // ===============
  async function exportarPDF() {
  // tenta pegar o id de todos os lugares possíveis
  const id =
    dadosCobranca?.id ||
    dadosCobranca?.data?.id ||
    dadosCobranca?.cobranca?.id ||
    dadosCobranca?.cobranca_id ||
    dadosCobranca?.cobrancaId ||
    btnPdf?.dataset?.cobrancaId ||
    localStorage.getItem("lastCobrancaId");

  if (!id) {
    showToast("ID inválido. Salve a cobrança antes de exportar o PDF.", "error");
    return;
  }

  try {
    btnPdf.disabled = true;

    const token = localStorage.getItem("token") || "";
    const url = `/api/cobrancas/${encodeURIComponent(id)}/pdf`;

    let resp = await fetch(url, {
      method: "GET",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });

    if (resp.status === 401) {
      const refreshed = await tentarRefresh();
      if (refreshed) {
        const token2 = localStorage.getItem("token") || "";
        resp = await fetch(url, {
          method: "GET",
          headers: { ...(token2 ? { Authorization: `Bearer ${token2}` } : {}) },
        });
      }
    }

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(t || `HTTP ${resp.status}`);
    }

    const blob = await resp.blob();
    baixarBlob(blob, `cobranca_${String(id).slice(0, 8)}.pdf`);
    showToast("PDF gerado com sucesso.", "success");
  } catch (e) {
    showToast("Erro ao gerar PDF: " + (e?.message || e), "error");
  } finally {
    btnPdf.disabled = false;
  }
}

  btnPdf.addEventListener("click", exportarPDF);

  async function tentarRefresh() {
    try {
      const refreshToken = localStorage.getItem("refreshToken");
      if (!refreshToken) return false;

      const r = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      const txt = await r.text().catch(() => "");
      let j = {};
      try {
        j = txt ? JSON.parse(txt) : {};
      } catch (e) {}

      if (!r.ok) return false;
      if (j.token) {
        localStorage.setItem("token", j.token);
        if (j.refreshToken) localStorage.setItem("refreshToken", j.refreshToken);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async function salvarCobrancaNoServidor(payload) {
    const send = async () => {
      const token = localStorage.getItem("token") || "";
      const resp = await fetch("/api/cobrancas", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      const text = await resp.text().catch(() => "");
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch (e) {}
      return { resp, text, json };
    };

    try {
      let { resp, text, json } = await send();

      if (resp.status === 401) {
        const refreshed = await tentarRefresh();
        if (refreshed) {
          ({ resp, text, json } = await send());
        } else {
          localStorage.removeItem("token");
          localStorage.removeItem("usuarioLogado");
          localStorage.removeItem("isLoggedIn");
          showToast("Sessão inválida ou expirada. Faça login novamente.", "error");
          setTimeout(() => (window.location.href = "/login"), 900);
          throw new Error(json.message || "Token inválido ou expirado");
        }
      }

      if (!resp.ok) {
        const serverMsg = json?.error || json?.message || text || `HTTP ${resp.status}`;
        showToast("Erro ao salvar no servidor: " + serverMsg, "error");
        throw new Error(serverMsg);
      }

      return json.data ?? json;
    } catch (err) {
      showToast("Erro ao salvar no servidor: " + (err.message || err), "error");
      throw err;
    }
  }

  async function carregarClientes() {
    try {
      const res = await fetch("/api/clientes-ativos");
      const json = await res.json();
      if (!json.success) throw new Error(json.message || "Falha ao carregar clientes");

      clientesCache = Array.isArray(json.data) ? json.data : [];
      datalist.innerHTML = "";
      clientesCache.forEach((cliente) => {
        const option = document.createElement("option");
        option.value = cliente.nome;
        option.dataset.id = cliente.id;
        datalist.appendChild(option);
      });

      inputNome.addEventListener("change", () => {
        const match = clientesCache.find((c) => c.nome === inputNome.value);
        inputId.value = match ? match.id : "";
      });

      inputNome.addEventListener("blur", () => {
        const match = clientesCache.find(
          (c) => c.nome.toLowerCase() === inputNome.value.trim().toLowerCase()
        );
        inputId.value = match ? match.id : "";
      });

      inputNome.addEventListener("input", () => {
        if (!clientesCache.some((c) => c.nome === inputNome.value)) {
          inputId.value = "";
        }
      });
    } catch (e) {
      showToast("Erro ao carregar clientes ativos.", "error");
    }
  }
  carregarClientes();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    let cliente_id = inputId.value;
    const cliente_nome = inputNome.value.trim();
    const valorOriginal = Number(document.getElementById("valorOriginal")?.value);
    const vencimento = document.getElementById("vencimento")?.value;
    const pagamento = document.getElementById("pagamento")?.value;
    const taxa = document.getElementById("taxa")?.value || "8%";

    if (!cliente_nome) {
      showToast("Preencha o nome do cliente.", "error");
      return;
    }

    if (!cliente_id || cliente_id.trim() === "") {
      const tentativa = clientesCache.find((c) => c.nome.toLowerCase() === cliente_nome.toLowerCase());
      if (tentativa) {
        cliente_id = tentativa.id;
        inputId.value = cliente_id;
      }
    }

    if (!cliente_id || cliente_id.trim() === "") {
      showToast("Selecione um cliente válido usando as sugestões.", "error");
      return;
    }

    if (!valorOriginal || Number.isNaN(valorOriginal) || valorOriginal <= 0) {
      showToast("Informe um valor original válido (> 0).", "error");
      return;
    }

    if (!vencimento) {
      showToast("Informe a data de vencimento.", "error");
      return;
    }

    const pagamentoRef = (pagamento || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const venc = new Date(vencimento + "T00:00:00");
    const pag = new Date(pagamentoRef + "T00:00:00");
    const diffMs = pag.getTime() - venc.getTime();
    const dias = diffMs > 0 ? Math.ceil(diffMs / (1000 * 60 * 60 * 24)) : 0;

    const txDia = TAXAS[taxa] ?? TAXAS["8%"];
    const juros = dias > 0 ? valorOriginal * txDia * dias : 0;
    const multa = dias > 0 ? valorOriginal * MULTA : 0;
    const valorAtualizado = Number((valorOriginal + juros + multa).toFixed(2));

    if (elResultado) elResultado.style.display = "block";
    if (elStatusMsg) elStatusMsg.textContent = "Calculado. Salvando no servidor…";

    if (resCliente) resCliente.textContent = cliente_nome;
    if (resOriginal) resOriginal.textContent = moedaBR(valorOriginal);
    if (resVencimento) resVencimento.textContent = formatarDataBR(vencimento);
    if (resPagamento) resPagamento.textContent = formatarDataBR(pagamentoRef);
    if (resDias) resDias.textContent = `${dias} dia(s)`;
    if (resJuros) resJuros.textContent = moedaBR(juros);
    if (resMulta) resMulta.textContent = moedaBR(multa);
    if (resAtualizado) resAtualizado.textContent = moedaBR(valorAtualizado);

    const payload = {
      cliente_id: cliente_id,
      valorOriginal,
      vencimento: vencimento.slice(0, 10),
      pagamento: pagamento ? pagamento.slice(0, 10) : "",
      taxa,
      taxaPercent: normalizePercent(taxa),
      dias,
      juros: Number(juros.toFixed(2)),
      multa: Number(multa.toFixed(2)),
      valorAtualizado: Number(valorAtualizado),
      status: pagamento ? "pago" : dias > 0 ? "pendente" : "em-dia",
    };

    try {
      const cobrancaSalva = await salvarCobrancaNoServidor(payload);

      // <<< FIX: extrai e guarda o ID de forma robusta
      cobrancaIdGerada = Number(
        cobrancaSalva?.id ??
          cobrancaSalva?.cobranca_id ??
          cobrancaSalva?.cobrancaId ??
          cobrancaSalva?.data?.id
      );

      const savedId =
  cobrancaSalva?.id ||
  cobrancaSalva?.data?.id ||
  cobrancaSalva?.cobranca?.id ||
  cobrancaSalva?.cobranca_id ||
  cobrancaSalva?.cobrancaId;

if (!savedId) {
  console.warn("[ACERTIVE] Cobrança salva, mas sem ID detectável:", cobrancaSalva);
} else {
  // garante que o botão e o storage guardem o id
  btnPdf.dataset.cobrancaId = String(savedId);
  localStorage.setItem("lastCobrancaId", String(savedId));
}

dadosCobranca = {
  id: savedId || null,
  cliente: cliente_nome,
  valorOriginal,
  vencimento,
  pagamentoRef,
  dias,
  taxa,
  juros: Number(juros.toFixed(2)),
  multa: Number(multa.toFixed(2)),
  valorAtualizado,
  ...cobrancaSalva,
};


      if (elStatusMsg) elStatusMsg.textContent = "Cobrança salva com sucesso.";
      btnPdf.disabled = false;
      showToast("Cobrança criada e salva.", "success");

      // opcional: debug no console (pode remover depois)
      if (!Number.isFinite(cobrancaIdGerada) || cobrancaIdGerada <= 0) {
        console.warn("[ACERTIVE] Cobrança salva sem ID detectável:", cobrancaSalva);
      }
    } catch (err) {
      // mesmo se falhar, não libera PDF bonito (sem ID do banco)
      cobrancaIdGerada = null;

      dadosCobranca = {
        cliente: cliente_nome,
        valorOriginal,
        vencimento,
        pagamentoRef,
        dias,
        taxa,
        juros: Number(juros.toFixed(2)),
        multa: Number(multa.toFixed(2)),
        valorAtualizado,
      };

      if (elStatusMsg) elStatusMsg.textContent = "Calculado, mas não foi possível salvar no servidor.";
      btnPdf.disabled = true; // <<< FIX: sem salvar no banco, não existe ID para PDF bonito
    }
  });
})();
