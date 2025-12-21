// frontend/js/dashboard.js — ACERTIVE (padronizado + compatível com seu backend)

(function () {
  // =====================
  // Helpers
  // =====================
  const $ = (id) => document.getElementById(id);

  function showToast(msg, type = "success") {
    if (typeof Toastify === "undefined") return;

    Toastify({
      text: msg,
      duration: 2800,
      close: true,
      gravity: "top",
      position: "right",
      backgroundColor: type === "success" ? "#FFD700" : "#dc3545",
      stopOnFocus: true,
    }).showToast();
  }

  function moedaBR(v) {
    const n = Number(v || 0);
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  async function fetchComTimeout(url, ms = 7000, options = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);

    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      return resp;
    } finally {
      clearTimeout(t);
    }
  }

  // =====================
  // Auth Guard (PADRÃO ÚNICO)
  // =====================
  function getUsuarioLogado() {
    const raw = localStorage.getItem("usuarioLogado");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  const usuario = getUsuarioLogado();
  if (!usuario) {
    localStorage.removeItem("usuarioLogado");
    window.location.href = "/login";
    return;
  }

  // Exibir nome (se existir no HTML)
  const userNameEl = $("userName");
  if (userNameEl) userNameEl.textContent = usuario?.nome || "Usuário";

  // Logout global (caso use onclick em algum lugar)
  window.logout = function logout() {
    localStorage.removeItem("usuarioLogado");
    localStorage.removeItem("isLoggedIn");
    localStorage.removeItem("username");
    localStorage.removeItem("keepLoggedIn");
    window.location.href = "/login";
  };

  // =====================
  // Dashboard API
  // =====================
  async function carregarDashboard() {
    const statusBar = $("statusBar");
    if (statusBar) statusBar.textContent = "Atualizando indicadores…";

    try {
      const resp = await fetchComTimeout("/api/dashboard", 7000, { method: "GET" });
      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        throw new Error(data?.message || "Falha ao carregar /api/dashboard");
      }

      // IDs do dashboard (confere com sua imagem)
      if ($("totalRecebido")) $("totalRecebido").textContent = moedaBR(data.totalRecebido);
      if ($("totalPendentes")) $("totalPendentes").textContent = moedaBR(data.totalPendente);
      if ($("totalClientes")) $("totalClientes").textContent = String(data.clientesAtivos ?? 0);
      if ($("totalTitulos")) $("totalTitulos").textContent = String(data.totalCobrancas ?? 0);

      if (statusBar) statusBar.textContent = "";
    } catch (err) {
      if (statusBar) statusBar.textContent = "Sem dados no momento (servidor offline ou rota indisponível).";
      showToast("Não consegui carregar os dados do dashboard.", "error");

      // Fallback visual seguro
      if ($("totalRecebido")) $("totalRecebido").textContent = "R$ 0,00";
      if ($("totalPendentes")) $("totalPendentes").textContent = "R$ 0,00";
      if ($("totalClientes")) $("totalClientes").textContent = "0";
      if ($("totalTitulos")) $("totalTitulos").textContent = "0";

      console.error("[ACERTIVE] Erro dashboard:", err);
    }
  }

  // =====================
  // Ações
  // =====================
  function bindActions() {
    const btnLogout = $("btnLogout");
    if (btnLogout) btnLogout.addEventListener("click", () => window.logout());

    const btnExportar = $("btnExportar");
    if (btnExportar) {
      btnExportar.addEventListener("click", (e) => {
        e.preventDefault();
        showToast("Exportação em desenvolvimento", "success");
      });
    }

    const btnNovaCobranca = $("btnNovaCobranca");
    if (btnNovaCobranca) btnNovaCobranca.addEventListener("click", () => (window.location.href = "/nova-cobranca"));

    const btnNovoCliente = $("btnNovoCliente");
    if (btnNovoCliente) btnNovoCliente.addEventListener("click", () => (window.location.href = "/novo-cliente"));

    const btnVerCobrancas = $("btnVerCobrancas");
    if (btnVerCobrancas) btnVerCobrancas.addEventListener("click", () => (window.location.href = "/cobrancas"));
  }

  // =====================
  // Init
  // =====================
  document.addEventListener("DOMContentLoaded", () => {
    bindActions();
    carregarDashboard();
  });
})();
