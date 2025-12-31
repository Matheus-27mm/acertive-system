// frontend/js/dashboard.js — KPIs + sincronização (clientes + cobranças) + Animações
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

  // Animação de contagem progressiva para números
  function animateValue(element, start, end, duration = 1000) {
    if (!element) return;
    
    const startTime = performance.now();
    const isNumber = typeof end === 'number';
    
    function update(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Easing function (easeOutCubic)
      const easeProgress = 1 - Math.pow(1 - progress, 3);
      
      if (isNumber) {
        const current = start + (end - start) * easeProgress;
        element.textContent = Math.floor(current);
      } else {
        // Para valores monetários
        const currentValue = start + (end - start) * easeProgress;
        element.textContent = moedaBR(currentValue);
      }
      
      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        element.textContent = isNumber ? end : moedaBR(end);
      }
    }
    
    requestAnimationFrame(update);
  }

  // Atualiza badge de status com animação
  function updateBadge(badgeId, status = 'neutral', text = 'Sem dados') {
    const badge = $(badgeId);
    if (!badge) return;
    
    badge.className = `kpiBadge ${status}`;
    
    const icons = {
      up: 'fa-arrow-up',
      down: 'fa-arrow-down',
      neutral: 'fa-minus'
    };
    
    badge.innerHTML = `<i class="fa-solid ${icons[status] || icons.neutral}"></i> ${text}`;
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

  // Logout (robusto)
  const btnLogout =
    document.getElementById("btnLogout") ||
    document.getElementById("btnSair") ||
    document.querySelector('[data-action="logout"]');

  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("token");
      localStorage.removeItem("usuarioLogado");
      localStorage.removeItem("isLoggedIn");
      window.location.href = "/login";
    });
  }

  // Esconde o loading overlay
  function hideLoadingOverlay() {
    const overlay = $("loadingOverlay");
    if (overlay) {
      setTimeout(() => {
        overlay.classList.add("hidden");
        setTimeout(() => overlay.remove(), 300);
      }, 500);
    }
  }

  // Atualiza status bar com feedback visual
  function updateStatusBar(message, type = 'neutral') {
    const statusBar = $("statusBar");
    if (!statusBar) return;
    
    statusBar.className = `statusBar ${type}`;
    statusBar.textContent = message;
    
    // Limpa mensagens de sucesso após 3.5s
    if (type === 'success') {
      setTimeout(() => {
        if (statusBar.textContent === message) {
          statusBar.textContent = '';
          statusBar.className = 'statusBar';
        }
      }, 3500);
    }
  }

  function aplicarKpisDashboard(data) {
    // Backend pode devolver com nomes levemente diferentes
    const totalRecebido = Number(data.totalRecebido ?? data.total_pago ?? 0);
    const totalPendente = Number(data.totalPendente ?? data.totalPendentes ?? 0);
    const totalVencido = Number(data.totalVencido ?? data.totalVencidos ?? 0);

    const totalCobrancas = Number(data.totalCobrancas ?? data.cobrancasEmitidas ?? 0);
    const clientesAtivos = Number(data.clientesAtivos ?? 0);

    // Animar valores ao invés de só setar
    const recebidoEl = $("totalRecebido");
    const pendenteEl = $("totalPendentes") || $("totalPendente");
    const vencidoEl = $("totalVencidos") || $("totalVencido");
    const titulosEl = $("totalTitulos") || $("totalCobrancas") || $("cobrancasEmitidas");
    const clientesEl = $("totalClientes") || $("clientCount");

    if (recebidoEl) {
      const current = parseFloat(recebidoEl.textContent.replace(/[^\d,.-]/g, '').replace(',', '.')) || 0;
      animateValue(recebidoEl, current, totalRecebido, 1200);
      updateBadge('badgeRecebido', totalRecebido > 0 ? 'up' : 'neutral', totalRecebido > 0 ? 'Recebido' : 'Sem dados');
    }

    if (pendenteEl) {
      const current = parseFloat(pendenteEl.textContent.replace(/[^\d,.-]/g, '').replace(',', '.')) || 0;
      animateValue(pendenteEl, current, totalPendente, 1200);
      updateBadge('badgePendentes', totalPendente > 0 ? 'down' : 'neutral', totalPendente > 0 ? 'A receber' : 'Sem dados');
    }

    if (vencidoEl) {
      const current = parseFloat(vencidoEl.textContent.replace(/[^\d,.-]/g, '').replace(',', '.')) || 0;
      animateValue(vencidoEl, current, totalVencido, 1200);
      updateBadge('badgeVencidos', totalVencido > 0 ? 'down' : 'neutral', totalVencido > 0 ? 'Em atraso' : 'Sem dados');
    }

    if (titulosEl) {
      const current = parseInt(titulosEl.textContent) || 0;
      animateValue(titulosEl, current, totalCobrancas, 1000);
      updateBadge('badgeTitulos', totalCobrancas > 0 ? 'neutral' : 'neutral', totalCobrancas > 0 ? `${totalCobrancas} títulos` : 'Sem dados');
    }

    if (clientesEl) {
      const current = parseInt(clientesEl.textContent) || 0;
      animateValue(clientesEl, current, Number.isFinite(clientesAtivos) ? clientesAtivos : 0, 1000);
      updateBadge('badgeClientes', clientesAtivos > 0 ? 'neutral' : 'neutral', clientesAtivos > 0 ? `${clientesAtivos} ativos` : 'Sem dados');
    }
  }

  // Carregar indicadores do dashboard
  async function carregarDashboard() {
    updateStatusBar("Atualizando indicadores…", "loading");

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
          const clientesEl = $("totalClientes") || $("clientCount");
          if (clientesEl) {
            const current = parseInt(clientesEl.textContent) || 0;
            animateValue(clientesEl, current, totalClientesAtivos, 1000);
            updateBadge('badgeClientes', totalClientesAtivos > 0 ? 'neutral' : 'neutral', totalClientesAtivos > 0 ? `${totalClientesAtivos} ativos` : 'Sem dados');
          }
        }
      }

      updateStatusBar("Dados atualizados com sucesso.", "success");
      hideLoadingOverlay();
    } catch (err) {
      updateStatusBar("Falha ao carregar dados.", "error");
      showToast("Erro ao carregar o dashboard.", "error");
      console.error("[ACERTIVE] Falha no dashboard:", err);
      hideLoadingOverlay();
    }
  }

  // Atualiza apenas o KPI de clientes quando receber evento
  function atualizarKpiClientes(total) {
    const clientesEl = $("totalClientes") || $("clientCount");
    if (clientesEl) {
      const current = parseInt(clientesEl.textContent) || 0;
      animateValue(clientesEl, current, Number(total || 0), 1000);
      updateBadge('badgeClientes', total > 0 ? 'neutral' : 'neutral', total > 0 ? `${total} ativos` : 'Sem dados');
    }
  }

  // Evento disparado por clientes-ativos.js após import/alteração
  window.addEventListener("clientes:atualizados", (ev) => {
    const total = ev?.detail?.total;
    if (typeof total === "number") {
      atualizarKpiClientes(total);
      updateStatusBar("Contador de clientes atualizado", "success");
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

    updateStatusBar("Indicadores de cobranças atualizados", "success");
  });

  // Exportar relatório (PDF bonito)
  const btnExportar = document.getElementById("btnExportar");
  if (btnExportar) {
    btnExportar.addEventListener("click", async () => {
      try {
        btnExportar.disabled = true;
        btnExportar.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando...';
        
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
        a.download = `relatorio-acertive-${new Date().toISOString().split('T')[0]}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();

        window.URL.revokeObjectURL(url);
        showToast("Relatório exportado com sucesso!", "success");
      } catch (e) {
        console.error(e);
        showToast("Não foi possível baixar o relatório em PDF.", "error");
      } finally {
        btnExportar.disabled = false;
        btnExportar.innerHTML = '<i class="fa-solid fa-download"></i> Exportar Relatório';
      }
    });
  }

  // Expor função para forçar atualização manual (útil para debug)
  window.atualizarDashboard = carregarDashboard;

  // Inicialização
  document.addEventListener("DOMContentLoaded", carregarDashboard);
})();