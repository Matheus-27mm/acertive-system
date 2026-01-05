// frontend/js/dashboard.js — KPIs + Gráficos Chart.js + sincronização
(function () {
  const $ = (id) => document.getElementById(id);

  // ========== VARIÁVEIS GLOBAIS DOS GRÁFICOS ==========
  let chartFaturamento = null;
  let chartStatus = null;

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
  const btnLogout = document.getElementById("btnLogout") || document.getElementById("btnSair");
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
    
    if (type === 'success') {
      setTimeout(() => {
        if (statusBar.textContent === message) {
          statusBar.textContent = '';
          statusBar.className = 'statusBar';
        }
      }, 3500);
    }
  }

  // ========== GRÁFICOS ==========

  // Cores do tema ACERTIVE
  const COLORS = {
    gold: '#F6C84C',
    goldLight: 'rgba(246, 200, 76, 0.2)',
    green: '#4CAF50',
    greenLight: 'rgba(76, 175, 80, 0.2)',
    orange: '#FF9800',
    orangeLight: 'rgba(255, 152, 0, 0.2)',
    red: '#F44336',
    redLight: 'rgba(244, 67, 54, 0.2)',
    text: '#EAEAEA',
    muted: '#A7A7A7',
    grid: 'rgba(246, 200, 76, 0.1)'
  };

  // Configuração global do Chart.js
  function setupChartDefaults() {
    if (typeof Chart === 'undefined') return;
    
    Chart.defaults.color = COLORS.muted;
    Chart.defaults.font.family = "'Montserrat', sans-serif";
    Chart.defaults.font.weight = 600;
  }

  // Cria gráfico de linha (Faturamento Mensal)
  function createFaturamentoChart(data) {
    const canvas = $('chartFaturamento');
    const container = $('chartFaturamentoContainer');
    if (!canvas || !container) return;

    // Remove loading
    const loading = container.querySelector('.chart-loading');
    if (loading) loading.style.display = 'none';

    // Verifica se tem dados
    if (!data || !data.meses || data.meses.length === 0) {
      canvas.style.display = 'none';
      container.innerHTML = `
        <div class="chart-empty">
          <i class="fa-solid fa-chart-line"></i>
          <span>Sem dados de faturamento</span>
        </div>
      `;
      return;
    }

    canvas.style.display = 'block';

    // Destroi gráfico anterior se existir
    if (chartFaturamento) {
      chartFaturamento.destroy();
    }

    const ctx = canvas.getContext('2d');

    // Gradiente para área
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, 'rgba(246, 200, 76, 0.4)');
    gradient.addColorStop(1, 'rgba(246, 200, 76, 0.02)');

    chartFaturamento = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.meses,
        datasets: [{
          label: 'Recebido',
          data: data.recebido,
          borderColor: COLORS.green,
          backgroundColor: 'rgba(76, 175, 80, 0.1)',
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: COLORS.green,
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointHoverRadius: 6
        }, {
          label: 'Total Cobrado',
          data: data.total,
          borderColor: COLORS.gold,
          backgroundColor: gradient,
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: COLORS.gold,
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: 'index'
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              boxWidth: 12,
              boxHeight: 12,
              borderRadius: 6,
              useBorderRadius: true,
              padding: 15,
              font: {
                size: 11,
                weight: 700
              }
            }
          },
          tooltip: {
            backgroundColor: 'rgba(17, 17, 20, 0.95)',
            titleColor: COLORS.gold,
            bodyColor: COLORS.text,
            borderColor: COLORS.gold,
            borderWidth: 1,
            cornerRadius: 10,
            padding: 12,
            displayColors: true,
            callbacks: {
              label: function(context) {
                return context.dataset.label + ': ' + moedaBR(context.raw);
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: COLORS.grid,
              drawBorder: false
            },
            ticks: {
              font: {
                size: 11,
                weight: 600
              }
            }
          },
          y: {
            grid: {
              color: COLORS.grid,
              drawBorder: false
            },
            ticks: {
              font: {
                size: 10,
                weight: 600
              },
              callback: function(value) {
                if (value >= 1000) {
                  return 'R$ ' + (value / 1000).toFixed(0) + 'k';
                }
                return 'R$ ' + value;
              }
            },
            beginAtZero: true
          }
        }
      }
    });
  }

  // Cria gráfico donut (Status das Cobranças)
  function createStatusChart(data) {
    const canvas = $('chartStatus');
    const container = $('chartStatusContainer');
    if (!canvas || !container) return;

    // Remove loading
    const loading = container.querySelector('.chart-loading');
    if (loading) loading.style.display = 'none';

    const total = (data?.pago || 0) + (data?.pendente || 0) + (data?.vencido || 0);

    // Verifica se tem dados
    if (total === 0) {
      canvas.style.display = 'none';
      container.innerHTML = `
        <div class="chart-empty">
          <i class="fa-solid fa-chart-pie"></i>
          <span>Sem cobranças cadastradas</span>
        </div>
      `;
      return;
    }

    canvas.style.display = 'block';

    // Destroi gráfico anterior se existir
    if (chartStatus) {
      chartStatus.destroy();
    }

    const ctx = canvas.getContext('2d');

    chartStatus = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Pago', 'Pendente', 'Vencido'],
        datasets: [{
          data: [data.pago || 0, data.pendente || 0, data.vencido || 0],
          backgroundColor: [COLORS.green, COLORS.orange, COLORS.red],
          borderColor: ['rgba(76,175,80,0.3)', 'rgba(255,152,0,0.3)', 'rgba(244,67,54,0.3)'],
          borderWidth: 2,
          hoverOffset: 8,
          hoverBorderWidth: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: {
            display: false // Usamos legenda custom no HTML
          },
          tooltip: {
            backgroundColor: 'rgba(17, 17, 20, 0.95)',
            titleColor: COLORS.gold,
            bodyColor: COLORS.text,
            borderColor: COLORS.gold,
            borderWidth: 1,
            cornerRadius: 10,
            padding: 12,
            callbacks: {
              label: function(context) {
                const value = context.raw;
                const percentage = ((value / total) * 100).toFixed(1);
                return `${context.label}: ${value} (${percentage}%)`;
              }
            }
          }
        }
      },
      plugins: [{
        // Plugin para mostrar total no centro
        id: 'centerText',
        beforeDraw: function(chart) {
          const { width, height, ctx } = chart;
          ctx.restore();
          
          // Texto "Total"
          ctx.font = '600 12px Montserrat';
          ctx.fillStyle = COLORS.muted;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('Total', width / 2, height / 2 - 12);
          
          // Número
          ctx.font = '800 24px Montserrat';
          ctx.fillStyle = COLORS.text;
          ctx.fillText(total.toString(), width / 2, height / 2 + 12);
          
          ctx.save();
        }
      }]
    });
  }

  // Carrega dados dos gráficos
  async function carregarGraficos() {
    try {
      const resp = await fetch("/api/dashboard/graficos", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (!resp.ok) {
        throw new Error("Erro ao carregar gráficos");
      }

      const data = await resp.json();

      if (data.success) {
        // Gráfico de faturamento mensal
        createFaturamentoChart(data.faturamentoMensal);
        
        // Gráfico de status (donut)
        createStatusChart(data.statusCobrancas);
      }
    } catch (err) {
      console.error("[ACERTIVE] Erro ao carregar gráficos:", err);
      
      // Mostra estado vazio nos gráficos
      const faturamentoContainer = $('chartFaturamentoContainer');
      const statusContainer = $('chartStatusContainer');
      
      if (faturamentoContainer) {
        faturamentoContainer.innerHTML = `
          <div class="chart-empty">
            <i class="fa-solid fa-chart-line"></i>
            <span>Erro ao carregar dados</span>
          </div>
        `;
      }
      
      if (statusContainer) {
        statusContainer.innerHTML = `
          <div class="chart-empty">
            <i class="fa-solid fa-chart-pie"></i>
            <span>Erro ao carregar dados</span>
          </div>
        `;
      }
    }
  }

  // ========== KPIs ==========

  function aplicarKpisDashboard(data) {
    const totalRecebido = Number(data.totalRecebido ?? data.total_pago ?? 0);
    const totalPendente = Number(data.totalPendente ?? data.totalPendentes ?? 0);
    const totalVencido = Number(data.totalVencido ?? data.totalVencidos ?? 0);
    const totalCobrancas = Number(data.totalCobrancas ?? data.cobrancasEmitidas ?? 0);
    const clientesAtivos = Number(data.clientesAtivos ?? 0);

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
      // KPIs principais
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

      // Fallback clientes ativos
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

      // Carregar gráficos
      await carregarGraficos();

      updateStatusBar("Dados atualizados com sucesso.", "success");
      hideLoadingOverlay();
    } catch (err) {
      updateStatusBar("Falha ao carregar dados.", "error");
      showToast("Erro ao carregar o dashboard.", "error");
      console.error("[ACERTIVE] Falha no dashboard:", err);
      hideLoadingOverlay();
    }
  }

  // Atualiza apenas o KPI de clientes
  function atualizarKpiClientes(total) {
    const clientesEl = $("totalClientes") || $("clientCount");
    if (clientesEl) {
      const current = parseInt(clientesEl.textContent) || 0;
      animateValue(clientesEl, current, Number(total || 0), 1000);
      updateBadge('badgeClientes', total > 0 ? 'neutral' : 'neutral', total > 0 ? `${total} ativos` : 'Sem dados');
    }
  }

  // Eventos
  window.addEventListener("clientes:atualizados", (ev) => {
    const total = ev?.detail?.total;
    if (typeof total === "number") {
      atualizarKpiClientes(total);
      updateStatusBar("Contador de clientes atualizado", "success");
    } else {
      carregarDashboard();
    }
  });

  window.addEventListener("cobrancas:atualizadas", (ev) => {
    const d = ev?.detail || {};
    aplicarKpisDashboard({
      success: true,
      totalRecebido: d.totalRecebido,
      totalPendente: d.totalPendente,
      totalVencido: d.totalVencido,
      totalCobrancas: d.totalCobrancas,
      clientesAtivos: d.clientesAtivos,
    });
    // Recarrega gráficos
    carregarGraficos();
    updateStatusBar("Indicadores de cobranças atualizados", "success");
  });

  // Exportar relatório
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

  // Expor função para atualização manual
  window.atualizarDashboard = carregarDashboard;

  // Inicialização
  document.addEventListener("DOMContentLoaded", () => {
    setupChartDefaults();
    carregarDashboard();
  });
})();