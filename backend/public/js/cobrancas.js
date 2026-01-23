// frontend/js/cobrancas.js — versão com E-mail e WhatsApp
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
      style: { background: type === "success" ? "#4CAF50" : "#F44336" },
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
  const loadingOverlay = document.getElementById("loadingOverlay");

  let cobrancas = [];
  let searchTimeout;

  function hideLoadingOverlay() {
    if (loadingOverlay) {
      setTimeout(() => {
        loadingOverlay.classList.add("hidden");
        setTimeout(() => loadingOverlay.remove(), 300);
      }, 500);
    }
  }

  function updateStatusBar(message, type = 'neutral') {
    if (!statusBar) return;
    
    statusBar.className = `${type}`;
    statusBar.textContent = message;
    
    if (type === 'success' || type === 'error') {
      setTimeout(() => {
        if (statusBar.textContent === message) {
          statusBar.textContent = '';
          statusBar.className = '';
        }
      }, 5000);
    }
  }

  function setCount(n) {
    if (countEl) {
      countEl.style.transform = 'scale(1.1)';
      setTimeout(() => {
        countEl.style.transform = 'scale(1)';
      }, 200);
      countEl.textContent = `${n} cobrança${n !== 1 ? "s" : ""}`;
    }
  }

  function badge(status) {
    const s = String(status || "pendente").toLowerCase();
    
    const configs = {
      pago: { label: "Pago", icon: "fa-circle-check" },
      vencido: { label: "Vencido", icon: "fa-circle-xmark" },
      pendente: { label: "Pendente", icon: "fa-circle" }
    };
    
    const config = configs[s] || configs.pendente;
    
    return `<span class="badge ${s}"><i class="fa-solid ${config.icon}"></i> ${config.label}</span>`;
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
      .map((c, index) => {
        const status = String(c.status || "pendente").toLowerCase();
        const safeCliente = esc(c.cliente || "—");
        const atualizado = Number(c.valorAtualizado ?? 0);
        const temEmail = c.cliente_email && c.cliente_email.trim() !== "";
        const temTelefone = c.cliente_telefone && c.cliente_telefone.trim() !== "";

        return `
          <tr data-cobranca-id="${c.id}" style="animation-delay: ${index * 0.05}s">
            <td style="font-weight:900;color:var(--gold)">${safeCliente}</td>
            <td>${dataBR(c.vencimento)}</td>
            <td>${moedaBR(c.valorOriginal)}</td>
            <td style="color:${c.juros > 0 ? 'var(--orange)' : 'inherit'}">${moedaBR(c.juros)}</td>
            <td style="color:${c.multa > 0 ? 'var(--red)' : 'inherit'}">${moedaBR(c.multa)}</td>
            <td style="font-weight:900;font-size:15px">${moedaBR(atualizado)}</td>
            <td>${badge(status)}</td>
            <td>
              <div class="actions">
                <!-- Botões de Status -->
                <button type="button" class="iconBtn" data-act="pago" data-id="${c.id}" title="Marcar como pago">
                  <i class="fa-solid fa-check"></i> Pago
                </button>
                <button type="button" class="iconBtn" data-act="pendente" data-id="${c.id}" title="Marcar como pendente">
                  <i class="fa-regular fa-clock"></i> Pendente
                </button>
                <button type="button" class="iconBtn" data-act="vencido" data-id="${c.id}" title="Marcar como vencido">
                  <i class="fa-solid fa-triangle-exclamation"></i> Vencido
                </button>
                
                <!-- Botões de Comunicação -->
                <button type="button" class="iconBtn email ${temEmail ? '' : 'disabled'}" data-act="email" data-id="${c.id}" title="${temEmail ? 'Enviar por E-mail' : 'Cliente sem e-mail cadastrado'}" ${temEmail ? '' : 'disabled'}>
                  <i class="fa-solid fa-envelope"></i> E-mail
                </button>
                <button type="button" class="iconBtn whatsapp ${temTelefone ? '' : 'disabled'}" data-act="whatsapp" data-id="${c.id}" title="${temTelefone ? 'Enviar por WhatsApp' : 'Cliente sem telefone cadastrado'}" ${temTelefone ? '' : 'disabled'}>
                  <i class="fa-brands fa-whatsapp"></i> WhatsApp
                </button>
                
                <!-- Botão PDF -->
                <button type="button" class="iconBtn pdf" data-act="pdf" data-id="${c.id}" title="Baixar PDF">
                  <i class="fa-solid fa-file-pdf"></i> PDF
                </button>
                
                <!-- Botão Excluir -->
                <button type="button" class="iconBtn danger" data-act="delete" data-id="${c.id}" title="Excluir cobrança">
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
      updateStatusBar("Carregando cobranças…", "loading");

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

      updateStatusBar("", "");
      hideLoadingOverlay();
    } catch (e) {
      updateStatusBar("Erro ao carregar cobranças", "error");
      showToast("❌ Erro: " + e.message, "error");
      cobrancas = [];
      render([]);
      hideLoadingOverlay();
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
        showToast("⚠️ Sessão inválida. Faça login novamente.", "error");
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
      showToast("⚠️ Sessão inválida. Faça login novamente.", "error");
      setTimeout(() => (window.location.href = "/login"), 900);
    }

    throw new Error(serverMsg || "Falha ao remover cobrança");
  }

  // =====================================================
  // ENVIAR E-MAIL
  // =====================================================
  async function enviarEmail(id) {
    const cobranca = cobrancas.find(c => String(c.id) === String(id));
    const clienteNome = cobranca ? cobranca.cliente : "este cliente";
    const clienteEmail = cobranca ? cobranca.cliente_email : "";

    if (!clienteEmail) {
      showToast("❌ Cliente não possui e-mail cadastrado.", "error");
      return;
    }

    if (!confirm(`Enviar cobrança por e-mail para ${clienteNome} (${clienteEmail})?`)) {
      return;
    }

    const resp = await fetch(`/api/cobrancas/${encodeURIComponent(id)}/enviar-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
    });

    const { json } = await parseResponseSafely(resp);

    if (!resp.ok) {
      throw new Error(json?.message || "Falha ao enviar e-mail");
    }

    if (!json?.success) {
      throw new Error(json?.message || "Falha ao enviar e-mail");
    }

    return json;
  }

  // =====================================================
  // ABRIR WHATSAPP
  // =====================================================
  async function abrirWhatsApp(id) {
    const cobranca = cobrancas.find(c => String(c.id) === String(id));
    const clienteTelefone = cobranca ? cobranca.cliente_telefone : "";

    if (!clienteTelefone) {
      showToast("❌ Cliente não possui telefone cadastrado.", "error");
      return;
    }

    const resp = await fetch(`/api/cobrancas/${encodeURIComponent(id)}/whatsapp`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
    });

    const { json } = await parseResponseSafely(resp);

    if (!resp.ok || !json?.success) {
      throw new Error(json?.message || "Falha ao gerar link do WhatsApp");
    }

    // Abre o WhatsApp em nova aba
    window.open(json.link, '_blank');
    return json;
  }

  // =====================================================
  // BAIXAR PDF
  // =====================================================
  async function baixarPDF(id) {
    const cobranca = cobrancas.find(c => String(c.id) === String(id));
    const clienteNome = cobranca ? cobranca.cliente : "cobranca";

    const resp = await fetch(`/api/cobrancas/${encodeURIComponent(id)}/pdf`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
    });

    if (!resp.ok) {
      const { json } = await parseResponseSafely(resp);
      throw new Error(json?.message || "Falha ao gerar PDF");
    }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cobranca-${clienteNome.replace(/[^a-zA-Z0-9]/g, '_')}-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function removerLinhaTabela(id) {
    const row = document.querySelector(`[data-cobranca-id="${id}"]`);
    if (row) {
      row.style.opacity = '0';
      row.style.transform = 'translateX(-100%)';
      setTimeout(() => row.remove(), 300);
    }
    
    cobrancas = cobrancas.filter((c) => String(c.id) !== String(id));
    
    setTimeout(() => {
      setCount(cobrancas.length);
      if (!cobrancas.length && empty) empty.style.display = "block";
    }, 300);
  }

  function exportCSV() {
    if (!cobrancas.length) {
      showToast("❌ Não há cobranças para exportar.", "error");
      return;
    }

    try {
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
      a.download = `cobrancas-acertive-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast("✅ CSV exportado com sucesso!", "success");
    } catch (e) {
      showToast("❌ Erro ao exportar CSV: " + e.message, "error");
    }
  }

  // Event Listeners
  if (btnVoltar) btnVoltar.addEventListener("click", () => (window.location.href = "/dashboard"));
  
  if (btnExportar) {
    btnExportar.addEventListener("click", () => {
      btnExportar.disabled = true;
      btnExportar.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Exportando...';
      
      setTimeout(() => {
        exportCSV();
        btnExportar.disabled = false;
        btnExportar.innerHTML = '<i class="fa-solid fa-download"></i> Exportar CSV';
      }, 300);
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("usuarioLogado");
      localStorage.removeItem("token");
      localStorage.removeItem("isLoggedIn");
      window.location.href = "/login";
    });
  }

  // Debounced search
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(load, 300);
    });
  }
  
  if (statusFilter) statusFilter.addEventListener("change", () => load());

  // Delegated event handler for action buttons
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act][data-id]");
    if (!btn) return;

    e.preventDefault();
    const id = btn.getAttribute("data-id");
    const act = btn.getAttribute("data-act");

    // Visual feedback
    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
      // =====================================================
      // AÇÃO: ENVIAR E-MAIL
      // =====================================================
      if (act === "email") {
        await enviarEmail(id);
        showToast("✅ E-mail enviado com sucesso!", "success");
        btn.disabled = false;
        btn.innerHTML = originalHTML;
        return;
      }

      // =====================================================
      // AÇÃO: WHATSAPP
      // =====================================================
      if (act === "whatsapp") {
        await abrirWhatsApp(id);
        showToast("✅ WhatsApp aberto!", "success");
        btn.disabled = false;
        btn.innerHTML = originalHTML;
        return;
      }

      // =====================================================
      // AÇÃO: PDF
      // =====================================================
      if (act === "pdf") {
        await baixarPDF(id);
        showToast("✅ PDF baixado com sucesso!", "success");
        btn.disabled = false;
        btn.innerHTML = originalHTML;
        return;
      }

      // =====================================================
      // AÇÃO: EXCLUIR
      // =====================================================
      if (act === "delete") {
        const cobranca = cobrancas.find(c => String(c.id) === String(id));
        const clienteNome = cobranca ? cobranca.cliente : "esta cobrança";
        
        if (!confirm(`Tem certeza que deseja excluir a cobrança de ${clienteNome}?`)) {
          btn.disabled = false;
          btn.innerHTML = originalHTML;
          return;
        }
        
        await removeCobranca(id);
        showToast("✅ Cobrança excluída com sucesso.", "success");
        removerLinhaTabela(id);
        
        try {
          window.dispatchEvent(new CustomEvent('cobrancas:atualizadas', { 
            detail: { action: 'deleted' } 
          }));
        } catch (e) {
          console.warn('dispatch event failed', e);
        }
        
        return;
      }

      // =====================================================
      // AÇÃO: MUDAR STATUS
      // =====================================================
      await updateStatus(id, act);
      
      const statusLabels = {
        pago: "paga",
        pendente: "pendente",
        vencido: "vencida"
      };
      
      showToast(`✅ Cobrança marcada como ${statusLabels[act] || act}.`, "success");
      await load();
      
      try {
        window.dispatchEvent(new CustomEvent('cobrancas:atualizadas', { 
          detail: { action: 'status_changed', status: act } 
        }));
      } catch (e) {
        console.warn('dispatch event failed', e);
      }
      
    } catch (err) {
      showToast("❌ Erro: " + err.message, "error");
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    load();
  });
})();