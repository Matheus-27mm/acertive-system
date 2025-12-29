// frontend/js/dashboard.js — KPIs + sincronização (clientes + cobranças)
(function () {
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

  // Formata valores em moeda BR
  function moedaBR(v) {
    const n = Number(v || 0);
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  // Set com fallback de ids (caso o HTML tenha mudado)
  function setTextByIds(ids, text) {
    for (const id of ids) {
      const el = $(id);
      if (el) {
        el.textContent = text;
        return true;
      }
    }
    return false;
  }

  // Autenticação usando token
  const token = localStorage.getItem("token");
  if (!token) {
    localStorage.removeItem("usuarioLogado");
    window.location.href = "/login";
    return;
  }

  const usuario = JSON.parse(localStorage.getItem("usuarioLogado") || "{}");
  const userNameEl = $("userName");
  if (userNameEl) userNameEl.textContent = usuario?.nome || "Usuário";

  // Logout
  const btnLogout = $("btnLogout");
  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("token");
      localStorage.removeItem("usuarioLogado");
      window.location.href = "/login";
    });
  }

  function aplicarKpisDashboard(data) {
    // Backend pode devolver com nomes levemente diferentes
    const totalRecebido = Number(data.totalRecebido ?? data.total_pago ?? 0);
    const totalPendente = Number(data.totalPendente ?? data.totalPendentes ?? 0);
    const totalVencido = Number(data.totalVencido ?? data.totalVencidos ?? 0);

    const totalCobrancas = Number(data.totalCobrancas ?? data.cobrancasEmitidas ?? 0);
    const clientesAtivos = Number(data.clientesAtivos ?? 0);

    // IDs mais prováveis no seu layout
    setTextByIds(["totalRecebido"], moedaBR(totalRecebido));
    setTextByIds(["totalPendentes", "totalPendente"], moedaBR(totalPendente));

    // Se existir card de vencidos no HTML, ele será atualizado (se não existir, não quebra)
    setTextByIds(["totalVencidos", "totalVencido"], moedaBR(totalVencido));

    setTextByIds(["totalTitulos", "totalCobrancas", "cobrancasEmitidas"], String(totalCobrancas));
    setTextByIds(["totalClientes", "clientCount"], String(Number.isFinite(clientesAtivos) ? clientesAtivos : 0));
  }

  // Carregar indicadores do dashboard
  async function carregarDashboard() {
    const statusBar = $("statusBar");
    if (statusBar) statusBar.textContent = "Atualizando indicadores…";

    try {
      // 1) KPIs principais via /api/dashboard
      const resp = await fetch("/api/dashboard", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.success) {
        throw new Error(data.message || "Erro na API do Dashboard");
      }

      aplicarKpisDashboard(data);

      // 2) Clientes ativos: fallback em /api/clientes-ativos se vier 0/NaN
      let totalClientesAtivos = Number(data.clientesAtivos || 0);

      if (!Number.isFinite(totalClientesAtivos) || totalClientesAtivos === 0) {
        const r2 = await fetch("/api/clientes-ativos", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });

        const j2 = await r2.json().catch(() => ({}));
        if (r2.ok && j2 && j2.success && Array.isArray(j2.data)) {
          totalClientesAtivos = j2.data.length;
          setTextByIds(["totalClientes", "clientCount"], String(totalClientesAtivos));
        }
      }

      if (statusBar) statusBar.textContent = "Dados atualizados com sucesso.";
    } catch (err) {
      if (statusBar) statusBar.textContent = "Falha ao carregar dados.";
      showToast("Erro ao carregar o dashboard.", "error");
      console.error("[ACERTIVE] Falha no dashboard:", err);
    }
  }

  // Atualiza apenas o KPI de clientes quando receber evento
  function atualizarKpiClientes(total) {
    setTextByIds(["totalClientes", "clientCount"], String(Number(total || 0)));
  }

  // Evento disparado por clientes-ativos.js após import/alteração
  window.addEventListener("clientes:atualizados", (ev) => {
    const total = ev?.detail?.total;
    if (typeof total === "number") {
      atualizarKpiClientes(total);
      const statusBar = $("statusBar");
      if (statusBar) {
        statusBar.textContent = "Contador de clientes atualizado";
        setTimeout(() => {
          if (statusBar) statusBar.textContent = "";
        }, 3500);
      }
    } else {
      carregarDashboard();
    }
  });

  // NOVO: Evento para quando status de cobranças muda (vamos disparar no cobrancas.js)
  // Espera algo como:
  // window.dispatchEvent(new CustomEvent("cobrancas:atualizadas", { detail: { totalRecebido, totalPendente, totalVencido, totalCobrancas } }))
  window.addEventListener("cobrancas:atualizadas", (ev) => {
    const d = ev?.detail || {};
    // Atualiza o que vier
    aplicarKpisDashboard({
      success: true,
      totalRecebido: d.totalRecebido,
      totalPendente: d.totalPendente,
      totalVencido: d.totalVencido,
      totalCobrancas: d.totalCobrancas,
      clientesAtivos: d.clientesAtivos, // opcional
    });

    const statusBar = $("statusBar");
    if (statusBar) {
      statusBar.textContent = "Indicadores de cobranças atualizados";
      setTimeout(() => {
        if (statusBar) statusBar.textContent = "";
      }, 3500);
    }
  });

  // Exportar relatório (PDF bonito)
  const btnExportar = document.getElementById("btnExportar");
  if (btnExportar) {
    btnExportar.addEventListener("click", async () => {
      try {
        const token = localStorage.getItem("token");
        const resp = await fetch("/api/relatorios/export-pdf", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!resp.ok) throw new Error("Falha ao exportar PDF.");

        const blob = await resp.blob();
        const url = window.URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "relatorio-acertive.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();

        window.URL.revokeObjectURL(url);
      } catch (e) {
        console.error(e);
        alert("Não foi possível baixar o relatório em PDF.");
      }
    });
  }

  // Expor função para forçar atualização manual (útil para debug)
  window.atualizarDashboard = carregarDashboard;

  // Inicialização
  document.addEventListener("DOMContentLoaded", carregarDashboard);
})();
