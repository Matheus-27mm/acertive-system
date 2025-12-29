// frontend/js/cobrancas.js — completo (corrigido: botões não navegam + cliente aparece)
(function () {
  if (!localStorage.getItem("usuarioLogado") || !localStorage.getItem("token")) {
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
      style: { background: type === "success" ? "#FFD700" : "#dc3545" },
      stopOnFocus: true,
    }).showToast();
  }

  function moedaBR(v) {
    const n = Number(v || 0);
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function dataBR(iso) {
    if (!iso) return "—";
    const d = new Date(String(iso).slice(0, 10) + "T00:00:00");
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

        const safeCliente = esc(c.cliente || "—");
        const atualizado = Number(c.valorAtualizado ?? 0);

        return `
          <tr data-cobranca-id="${c.id}">
            <td style="font-weight:900;color:rgba(255,215,0,.95)">${safeCliente}</td>
            <td>${dataBR(c.vencimento)}</td>
            <td>${moedaBR(c.valorOriginal)}</td>
            <td>${moedaBR(c.juros)}</td>
            <td>${moedaBR(c.multa)}</td>
            <td style="font-weight:900">${moedaBR(atualizado)}</td>
            <td>${badge(status)}</td>
            <td>
              <div class="actions">
                <button type="button" class="iconBtn" data-act="pago" data-id="${c.id}">
                  <i class="fa-solid fa-check"></i> Pago
                </button>
                <button type="button" class="iconBtn" data-act="pendente" data-id="${c.id}">
                  <i class="fa-regular fa-clock"></i> Pendente
                </button>
                <button type="button" class="iconBtn" data-act="vencido" data-id="${c.id}">
                  <i class="fa-solid fa-triangle-exclamation"></i> Vencido
                </button>
                <button type="button" class="iconBtn danger" data-act="delete" data-id="${c.id}">
                  <i class="fa-solid fa-trash"></i> Excluir
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function parseResponseSafely(resp) {
    const text = await resp.text().catch(() => "");
    if (!text) return { text: "", json: null };
    try {
      return { text, json: JSON.parse(text) };
    } catch {
      return { text, json: null };
    }
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
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });

      const { text, json } = await parseResponseSafely(resp);

      if (!resp.ok) {
        const serverMsg = (json && (json.message || json.error)) || text || `HTTP ${resp.status}`;
        throw new Error(serverMsg || "Falha ao carregar");
      }

      const payload = json ?? {};
      if (!payload.success) throw new Error(payload.message || "Falha ao carregar");

      cobrancas = Array.isArray(payload.data) ? payload.data : [];
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token")}`,
        Accept: "application/json, text/plain, */*",
      },
      body: JSON.stringify({ status }),
    });

    const { text, json } = await parseResponseSafely(resp);

    if (!resp.ok) {
      const serverMsg = (json && (json.message || json.error)) || text || `HTTP ${resp.status}`;
      if (resp.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("usuarioLogado");
        localStorage.removeItem("isLoggedIn");
        showToast("Sessão inválida. Faça login novamente.", "error");
        setTimeout(() => (window.location.href = "/login"), 900);
      }
      throw new Error(serverMsg || "Falha ao atualizar status");
    }

    const payload = json ?? {};
    if (!payload.success) throw new Error(payload.message || "Falha ao atualizar status");
    return payload.data;
  }

  async function removeCobranca(id) {
    const resp = await fetch(`/api/cobrancas/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("token")}`,
        Accept: "application/json, text/plain, */*",
      },
    });

    const { text, json } = await parseResponseSafely(resp);

    if (resp.status === 204 || resp.status === 200) {
      if (json && json.success === false) {
        throw new Error(json.message || json.error || text || `HTTP ${resp.status}`);
      }
      return json?.data ?? null;
    }

    const serverMsg = (json && (json.message || json.error)) || text || `HTTP ${resp.status}`;

    if (resp.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("usuarioLogado");
      localStorage.removeItem("isLoggedIn");
      showToast("Sessão inválida. Faça login novamente.", "error");
      setTimeout(() => (window.location.href = "/login"), 900);
    }

    throw new Error(serverMsg || "Falha ao remover cobrança");
  }

  function removerLinhaTabela(id) {
    const row = document.querySelector(`[data-cobranca-id="${id}"]`);
    if (row) row.remove();
    cobrancas = cobrancas.filter((c) => String(c.id) !== String(id));
    setCount(cobrancas.length);
    if (!cobrancas.length && empty) empty.style.display = "block";
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
        c.valorAtualizado ?? 0,
        c.status || "pendente",
        c.createdAt || "",
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

  if (btnVoltar) btnVoltar.addEventListener("click", () => (window.location.href = "/dashboard"));
  if (btnExportar) btnExportar.addEventListener("click", exportCSV);

  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("usuarioLogado");
      localStorage.removeItem("token");
      localStorage.removeItem("isLoggedIn");
      window.location.href = "/login";
    });
  }

  if (searchInput) searchInput.addEventListener("input", () => load());
  if (statusFilter) statusFilter.addEventListener("change", () => load());

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act][data-id]");
    if (!btn) return;

    e.preventDefault(); // garante que não vai “navegar”
    const id = btn.getAttribute("data-id");
    const act = btn.getAttribute("data-act");

    try {
      if (act === "delete") {
        if (!confirm("Deseja excluir esta cobrança?")) return;
        await removeCobranca(id);
        showToast("Cobrança excluída.", "success");
        removerLinhaTabela(id);
        return;
      }

      await updateStatus(id, act);
      showToast("Status atualizado.", "success");
      await load();
    } catch (err) {
      showToast("Erro: " + err.message, "error");
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    load();
  });
})();
