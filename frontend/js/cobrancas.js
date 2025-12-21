(function () {
  // Guard
  if (!localStorage.getItem("usuarioLogado")) {
    window.location.href = "/login";
    return;
  }

  function showToast(msg, type = "success") {
    if (typeof Toastify === "undefined") return alert(msg);
    Toastify({
      text: msg,
      duration: 2800,
      close: true,
      gravity: "top",
      position: "right",
      backgroundColor: type === "success" ? "#FFD700" : "#dc3545",
    }).showToast();
  }

  function moedaBR(v) {
    const n = Number(v || 0);
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function dataBR(iso) {
    if (!iso) return "—";
    const d = new Date(String(iso) + "T00:00:00");
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("pt-BR");
  }

  const tbody = document.getElementById("tbody");
  const empty = document.getElementById("empty");
  const statusBar = document.getElementById("statusBar");
  const countEl = document.getElementById("count");
  const searchInput = document.getElementById("searchInput");
  const statusFilter = document.getElementById("statusFilter");

  const btnVoltar = document.getElementById("btnVoltar");
  const btnExportar = document.getElementById("btnExportar");
  const btnLogout = document.getElementById("btnLogout");

  let cobrancas = [];

  function setCount(n) {
    if (countEl) countEl.textContent = `${n} cobrança${n !== 1 ? "s" : ""}`;
  }

  function badge(status) {
    const s = String(status || "pendente").toLowerCase();
    const label = s === "pago" ? "Pago" : s === "vencido" ? "Vencido" : "Pendente";
    return `<span class="badge ${s}"><i class="fa-solid fa-circle"></i> ${label}</span>`;
  }

  function esc(s) {
    return String(s || "").replace(/[<>&"]/g, (m) => ({
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
    }[m]));
  }

  function render(list) {
    if (!tbody) return;

    if (!list.length) {
      tbody.innerHTML = "";
      if (empty) empty.style.display = "block";
      setCount(0);
      return;
    }

    if (empty) empty.style.display = "none";
    setCount(list.length);

    tbody.innerHTML = list
      .map((c) => {
        const status = String(c.status || "pendente").toLowerCase();
        const safeCliente = esc(c.cliente);

        // ✅ compatibilidade: backend novo usa valorAtualizado; backend antigo usava "valor"
        const atualizado = Number(c.valorAtualizado ?? c.valor ?? 0);

        return `
          <tr>
            <td style="font-weight:900;color:rgba(255,215,0,.95)">${safeCliente}</td>
            <td>${dataBR(c.vencimento)}</td>
            <td>${moedaBR(c.valorOriginal)}</td>
            <td>${moedaBR(c.juros)}</td>
            <td>${moedaBR(c.multa)}</td>
            <td style="font-weight:900">${moedaBR(atualizado)}</td>
            <td>${badge(status)}</td>
            <td>
              <div class="actions">
                <button class="iconBtn" data-act="pago" data-id="${c.id}">
                  <i class="fa-solid fa-check"></i> Pago
                </button>
                <button class="iconBtn" data-act="pendente" data-id="${c.id}">
                  <i class="fa-regular fa-clock"></i> Pendente
                </button>
                <button class="iconBtn" data-act="vencido" data-id="${c.id}">
                  <i class="fa-solid fa-triangle-exclamation"></i> Vencido
                </button>
                <button class="iconBtn danger" data-act="delete" data-id="${c.id}">
                  <i class="fa-solid fa-trash"></i> Excluir
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function applyFilters() {
    const q = String(searchInput?.value || "").toLowerCase().trim();
    const st = String(statusFilter?.value || "").toLowerCase().trim();

    let list = [...cobrancas];

    if (st) list = list.filter((c) => String(c.status || "").toLowerCase() === st);
    if (q) list = list.filter((c) => String(c.cliente || "").toLowerCase().includes(q));

    render(list);
  }

  async function load() {
    try {
      if (statusBar) statusBar.textContent = "Carregando cobranças…";

      const qs = [];
      const st = String(statusFilter?.value || "").trim();
      const q = String(searchInput?.value || "").trim();
      if (st) qs.push(`status=${encodeURIComponent(st)}`);
      if (q) qs.push(`q=${encodeURIComponent(q)}`);

      const url = "/api/cobrancas" + (qs.length ? `?${qs.join("&")}` : "");
      const resp = await fetch(url);
      const json = await resp.json();

      if (!resp.ok || !json.success) throw new Error(json.message || "Falha ao carregar");

      cobrancas = Array.isArray(json.data) ? json.data : [];
      render(cobrancas);

      if (statusBar) statusBar.textContent = "";
    } catch (e) {
      if (statusBar) statusBar.textContent = "Não foi possível carregar as cobranças.";
      showToast("Erro: " + e.message, "error");
      cobrancas = [];
      render([]);
    }
  }

  async function updateStatus(id, status) {
    const resp = await fetch(`/api/cobrancas/${encodeURIComponent(id)}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const json = await resp.json();
    if (!resp.ok || !json.success) throw new Error(json.message || "Falha ao atualizar status");
    return json.data;
  }

  async function removeCobranca(id) {
    const resp = await fetch(`/api/cobrancas/${encodeURIComponent(id)}`, { method: "DELETE" });
    const json = await resp.json();
    if (!resp.ok || !json.success) throw new Error(json.message || "Falha ao remover cobrança");
    return json.data;
  }

  function exportCSV() {
    if (!cobrancas.length) {
      showToast("Não há cobranças para exportar.", "error");
      return;
    }

    const rows = [
      ["Cliente", "Vencimento", "Valor Original", "Juros", "Multa", "Valor Atualizado", "Status", "Data Criação"],
      ...cobrancas.map((c) => [
        c.cliente || "",
        c.vencimento || "",
        c.valorOriginal ?? 0,
        c.juros ?? 0,
        c.multa ?? 0,
        c.valorAtualizado ?? c.valor ?? 0,
        c.status || "pendente",
        c.createdAt || c.dataCriacao || "",
      ]),
    ];

    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cobrancas_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast("CSV exportado com sucesso.", "success");
  }

  // Eventos
  if (btnVoltar) btnVoltar.addEventListener("click", () => (window.location.href = "/dashboard"));
  if (btnExportar) btnExportar.addEventListener("click", exportCSV);

  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("usuarioLogado");
      window.location.href = "/login";
    });
  }

  if (searchInput) searchInput.addEventListener("input", () => applyFilters());
  if (statusFilter) statusFilter.addEventListener("change", async () => load());

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act][data-id]");
    if (!btn) return;

    const id = btn.getAttribute("data-id");
    const act = btn.getAttribute("data-act");

    try {
      if (act === "delete") {
        if (!confirm("Deseja excluir esta cobrança?")) return;
        await removeCobranca(id);
        showToast("Cobrança excluída.", "success");
        await load();
        return;
      }

      await updateStatus(id, act);
      showToast("Status atualizado.", "success");
      await load();
    } catch (err) {
      showToast("Erro: " + err.message, "error");
    }
  });

  // Init
  document.addEventListener("DOMContentLoaded", () => {
    load();
  });
})();
