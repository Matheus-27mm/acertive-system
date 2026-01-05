// /js/clientes-ativos.js — versão melhorada com animações e feedback visual
document.addEventListener("DOMContentLoaded", () => {
  const tbody = document.getElementById("tbody");
  const empty = document.getElementById("empty");
  const clientCount = document.getElementById("clientCount");
  const searchInput = document.getElementById("searchInput");
  const statusFilter = document.getElementById("statusFilter");
  const statusBar = document.getElementById("statusBar");
  const loadingOverlay = document.getElementById("loadingOverlay");

  if (!tbody) {
    console.error("clientes-ativos.js: tbody não encontrado (id='tbody').");
    return;
  }

  let clientes = [];
  let filteredClientes = [];

  const token = () => localStorage.getItem("token");
  function authHeaders(extra = {}) {
    const t = token();
    return Object.assign({}, t ? { Authorization: `Bearer ${t}` } : {}, extra);
  }
  
  function showToast(text, bg = "#27ae60", duration = 3500) {
    if (typeof Toastify === "undefined") return alert(text);
    Toastify({ text, duration, gravity: "top", position: "right", style: { background: bg } }).showToast();
  }
  
  function esc(s) { return String(s || ""); }

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
    
    statusBar.textContent = message;
    statusBar.style.color = type === 'success' ? 'var(--green)' : 
                           type === 'error' ? 'var(--red)' : 
                           type === 'loading' ? 'var(--blue)' : 
                           'var(--muted)';
    
    if (type === 'success' || type === 'error') {
      setTimeout(() => {
        if (statusBar.textContent === message) {
          statusBar.textContent = '';
        }
      }, 5000);
    }
  }

  function renderClientes(lista) {
    tbody.innerHTML = "";
    
    if (!Array.isArray(lista) || lista.length === 0) {
      empty && (empty.style.display = "block");
      return;
    }
    
    empty && (empty.style.display = "none");
    
    lista.forEach((cliente, index) => {
      const cadastro = cliente.created_at || cliente.data_cadastro ? 
        new Date(cliente.created_at || cliente.data_cadastro).toLocaleDateString("pt-BR") : 
        "—";
      
      const tr = document.createElement("tr");
      tr.dataset.clienteId = cliente.id;
      tr.style.animationDelay = `${index * 0.05}s`;
      
      const statusText = cliente.status === "inativo" ? "Inativo" : "Ativo";
      const statusClass = cliente.status === "inativo" ? "inativo" : "";
      const statusIcon = cliente.status === "inativo" ? 
        '<i class="fa-solid fa-circle-xmark"></i>' : 
        '<i class="fa-solid fa-circle-check"></i>';
      
      tr.innerHTML = `
        <td>
          <div class="nameCell">
            <strong>${esc(cliente.nome)}</strong>
            <div class="small">${esc(cliente.email || "-")}</div>
          </div>
        </td>
        <td>${esc(cliente.email || "-")}</td>
        <td>${esc(cliente.telefone || "-")}</td>
        <td>${esc(cliente.cpf_cnpj || "-")}</td>
        <td><span class="badge ${statusClass}">${statusIcon} ${statusText}</span></td>
        <td>${cadastro}</td>
        <td>
          <div class="actions">
            <button type="button" class="iconBtn" data-act="edit" data-id="${cliente.id}" title="Editar">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button type="button" class="iconBtn danger" data-act="delete" data-id="${cliente.id}" title="Excluir">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
    
    attachRowListeners();
  }

  function aplicarFiltros() {
    const termo = (searchInput?.value || "").toLowerCase();
    const status = (statusFilter?.value || "");
    
    const filtrados = clientes.filter(c => {
      const nome = (c.nome || "").toLowerCase();
      const email = (c.email || "").toLowerCase();
      const telefone = (c.telefone || "").toLowerCase();
      const cpf = (c.cpf_cnpj || "").toLowerCase();
      
      const matchTermo = !termo || 
        nome.includes(termo) || 
        email.includes(termo) || 
        telefone.includes(termo) ||
        cpf.includes(termo);
      
      const matchStatus = !status || 
        (status === "ativo" && (c.status === "ativo" || !c.status)) || 
        (status === "inativo" && c.status === "inativo");
      
      return matchTermo && matchStatus;
    });
    
    filteredClientes = filtrados;
    renderClientes(filtrados);
    
    // Update count with animation
    if (clientCount) {
      const total = filtrados.length;
      clientCount.style.transform = 'scale(1.1)';
      setTimeout(() => {
        clientCount.style.transform = 'scale(1)';
      }, 200);
      clientCount.textContent = `${total} cliente${total !== 1 ? 's' : ''}`;
    }
  }

  // Debounce para pesquisa
  let searchTimeout;
  searchInput && searchInput.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(aplicarFiltros, 300);
  });
  
  statusFilter && statusFilter.addEventListener("change", aplicarFiltros);

  async function apiGetClientesAtivos() {
    const resp = await fetch("/api/clientes-ativos", { headers: authHeaders() });
    const text = await resp.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!resp.ok) throw new Error((json && (json.message || json.error)) || text || `HTTP ${resp.status}`);
    if (!json || !json.success) throw new Error(json?.message || "Falha ao carregar clientes");
    return Array.isArray(json.data) ? json.data : [];
  }

  async function apiDeleteCliente(id) {
    const resp = await fetch(`/api/clientes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders()
    });
    const text = await resp.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!resp.ok) throw new Error((json && (json.message || json.error)) || text || `HTTP ${resp.status}`);
    return json?.data ?? null;
  }

  async function apiUpdateCliente(id, payload) {
    const resp = await fetch(`/api/clientes/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify(payload)
    });
    const text = await resp.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!resp.ok) throw new Error((json && (json.message || json.error)) || text || `HTTP ${resp.status}`);
    return json?.data ?? null;
  }

  // Importação
  const btnImportar = document.getElementById("btnImportar");
  const fileInput = document.getElementById("fileExcel");
  let _fileInput = fileInput;
  
  if (!_fileInput) {
    _fileInput = document.createElement("input");
    _fileInput.type = "file";
    _fileInput.accept = ".xlsx,.xls,.csv";
    _fileInput.id = "fileExcel";
    _fileInput.style.display = "none";
    document.body.appendChild(_fileInput);
  }
  
  if (btnImportar) {
    btnImportar.addEventListener("click", () => _fileInput.click());
  }

  _fileInput.addEventListener("change", async (ev) => {
    const files = ev.target.files;
    if (!files || !files.length) return;
    
    const file = files[0];
    
    try {
      updateStatusBar("Importando arquivo...", "loading");
      
      // Atualiza botão de importar
      if (btnImportar) {
        btnImportar.disabled = true;
        btnImportar.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importando...';
      }
      
      console.log("[clientes-ativos] import file:", file.name, file.size);
      
      const fd = new FormData();
      fd.append("file", file);
      const t = token();
      const headers = t ? { Authorization: `Bearer ${t}` } : {};
      const apiPath = "/api/clientes/import";
      
      console.log("[clientes-ativos] POST ->", new URL(apiPath, window.location.origin).href);
      
      const resp = await fetch(apiPath, { method: "POST", headers, body: fd });
      const text = await resp.text().catch(() => "");
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
      
      if (!resp.ok) {
        const msg = (json && (json.message || json.error)) || text || (`HTTP ${resp.status}`);
        throw new Error(msg);
      }
      
      const imported = (json && Number(json.imported)) || 0;
      const skipped = (json && Number(json.skipped)) || 0;
      const duplicates = (json && Number(json.duplicates)) || 0;
      const errors = (json && Array.isArray(json.errors)) ? json.errors : [];
      
      const summary = `Importados: ${imported} | Ignorados: ${skipped} | Duplicados: ${duplicates}${errors.length ? " | Erros: " + errors.length : ""}`;
      
      updateStatusBar(summary, "success");
      showToast(`✅ Importação concluída! ${imported} cliente${imported !== 1 ? 's' : ''} importado${imported !== 1 ? 's' : ''}.`, "#27ae60");
      
      if (errors.length) {
        console.error("[clientes-ativos] import errors:", errors);
        showToast(`⚠️ Import concluída com ${errors.length} erro(s). Veja console para detalhes.`, "#e67e22", 6000);
      }
      
      if (imported === 0 && errors.length === 0) {
        console.warn("[clientes-ativos] import result with 0 imported. response body:", json || text);
        showToast("⚠️ Import concluída com 0 clientes. Verifique cabeçalhos e mapeamento da planilha.", "#e67e22", 6000);
      }
      
      if (window.carregarClientes) await window.carregarClientes();
      
      _fileInput.value = "";
      
    } catch (err) {
      console.error("[clientes-ativos] import error", err);
      showToast("❌ Erro na importação: " + (err.message || err), "#e74c3c", 6000);
      updateStatusBar("Erro na importação", "error");
      _fileInput.value = "";
    } finally {
      if (btnImportar) {
        btnImportar.disabled = false;
        btnImportar.innerHTML = '<i class="fa-solid fa-file-import"></i> Importar Excel';
      }
    }
  });

  function attachRowListeners() {
    tbody.querySelectorAll('button[data-act="delete"]').forEach(btn => {
      btn.removeEventListener("click", onDeleteClick);
      btn.addEventListener("click", onDeleteClick);
    });
    tbody.querySelectorAll('button[data-act="edit"]').forEach(btn => {
      btn.removeEventListener("click", onEditClick);
      btn.addEventListener("click", onEditClick);
    });
  }

  async function onDeleteClick(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    const id = btn.getAttribute("data-id");
    
    if (!id) return showToast("ID do cliente ausente", "#e74c3c");
    
    const cliente = clientes.find(c => String(c.id) === String(id));
    const nomeCliente = cliente ? cliente.nome : "este cliente";
    
    if (!confirm(`Tem certeza que deseja excluir ${nomeCliente}?`)) return;
    
    try {
      // Visual feedback
      const row = btn.closest('tr');
      if (row) {
        row.style.opacity = '0.5';
        row.style.pointerEvents = 'none';
      }
      
      await apiDeleteCliente(id);
      
      // Remove com animação
      if (row) {
        row.style.transform = 'translateX(-100%)';
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 300);
      }
      
      showToast("✅ Cliente excluído com sucesso.", "#27ae60");
      clientes = clientes.filter(c => String(c.id) !== String(id));
      aplicarFiltros();
      
      // Notificar dashboard após exclusão
      try {
        const total = clientes.length;
        window.dispatchEvent(new CustomEvent('clientes:atualizados', { detail: { total } }));
        localStorage.setItem('acertive_clientes_total', String(total));
        localStorage.setItem('acertive_clientes_ts', String(Date.now()));
      } catch (e) { 
        console.warn('dispatch after delete failed', e); 
      }
    } catch (err) {
      console.error("[clientes-ativos] erro ao excluir:", err);
      showToast("❌ Erro ao excluir cliente: " + (err.message || err), "#e74c3c");
      
      // Restaura visual
      const row = btn.closest('tr');
      if (row) {
        row.style.opacity = '1';
        row.style.pointerEvents = 'auto';
      }
    }
  }

  function onEditClick(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    const id = btn.getAttribute("data-id");
    const cliente = clientes.find(c => String(c.id) === String(id));
    
    if (!cliente) {
      showToast("Cliente não encontrado localmente. Recarregando...", "#e67e22");
      carregarClientes();
      return;
    }
    
    openEditModal(cliente);
  }

  function openEditModal(cliente) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    
    const modal = document.createElement("div");
    modal.className = "modal";
    
    modal.innerHTML = `
      <h3><i class="fa-solid fa-user-pen"></i> Editar Cliente</h3>
      <input id="edit_nome" placeholder="Nome completo" value="${esc(cliente.nome)}" />
      <input id="edit_email" type="email" placeholder="Email" value="${esc(cliente.email||'')}" />
      <input id="edit_telefone" placeholder="Telefone" value="${esc(cliente.telefone||'')}" />
      <input id="edit_cpf" placeholder="CPF/CNPJ" value="${esc(cliente.cpf_cnpj||'')}" />
      <div class="modal-buttons">
        <button class="btn-cancel" id="edit_cancel">
          <i class="fa-solid fa-xmark"></i> Cancelar
        </button>
        <button class="btn-save" id="edit_save">
          <i class="fa-solid fa-floppy-disk"></i> Salvar
        </button>
      </div>
    `;
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const inNome = modal.querySelector("#edit_nome");
    const inEmail = modal.querySelector("#edit_email");
    const inTel = modal.querySelector("#edit_telefone");
    const inCpf = modal.querySelector("#edit_cpf");
    
    const closeModal = () => {
      overlay.style.opacity = '0';
      modal.style.transform = 'scale(0.9)';
      setTimeout(() => overlay.remove(), 300);
    };
    
    modal.querySelector("#edit_cancel").addEventListener("click", closeModal);
    overlay.addEventListener("click", (ev) => { 
      if (ev.target === overlay) closeModal();
    });

    modal.querySelector("#edit_save").addEventListener("click", async () => {
      const novoNome = (inNome.value || "").trim();
      const novoEmail = (inEmail.value || "").trim();
      const novoTel = (inTel.value || "").trim();
      const novoCpf = (inCpf.value || "").trim();
      
      if (!novoNome) {
        showToast("❌ Nome não pode ficar vazio.", "#e74c3c");
        inNome.focus();
        return;
      }
      
      try {
        const saveBtn = modal.querySelector("#edit_save");
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando...';
        
        await apiUpdateCliente(cliente.id, { 
          nome: novoNome, 
          email: novoEmail || null, 
          telefone: novoTel || null,
          cpf_cnpj: novoCpf || null
        });
        
        showToast("✅ Cliente atualizado com sucesso!", "#27ae60");
        closeModal();
        await carregarClientes();
      } catch (err) {
        console.error("[clientes-ativos] erro ao atualizar:", err);
        showToast("❌ Erro ao atualizar cliente: " + (err.message || err), "#e74c3c");
        
        const saveBtn = modal.querySelector("#edit_save");
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar';
      }
    });
    
    // Focus no primeiro campo
    setTimeout(() => inNome.focus(), 100);
  }

  async function carregarClientes() {
    try {
      const list = await apiGetClientesAtivos();
      clientes = list;
      aplicarFiltros();

      if (clientCount) {
        const total = Array.isArray(list) ? list.length : 0;
        clientCount.textContent = `${total} cliente${total !== 1 ? 's' : ''}`;
      }

      // DEBUG: log e dispatch
      console.log('[clientes-ativos] total obtido:', Array.isArray(list) ? list.length : 0);
      
      try {
        const total = Array.isArray(list) ? list.length : 0;
        console.log('[clientes-ativos] dispatch clientes:atualizados total=', total);
        
        if (window && typeof window.dispatchEvent === "function") {
          window.dispatchEvent(new CustomEvent('clientes:atualizados', { detail: { total } }));
        }
        
        // Fallback para abas diferentes
        localStorage.setItem('acertive_clientes_total', String(total));
        localStorage.setItem('acertive_clientes_ts', String(Date.now()));
      } catch (e) {
        console.warn('Erro ao dispatch evento clientes:atualizados', e);
      }

      hideLoadingOverlay();
      return list;
    } catch (err) {
      console.error("[clientes-ativos] erro ao carregar:", err);
      showToast("❌ Erro ao carregar clientes: " + (err.message || err), "#e74c3c");
      clientes = [];
      renderClientes([]);
      if (clientCount) clientCount.textContent = "0 clientes";
      hideLoadingOverlay();
      return [];
    }
  }

  window.carregarClientes = carregarClientes;

  // Listener storage para sincronizar entre abas (dashboard)
  window.addEventListener('storage', (ev) => {
    if (ev.key === 'acertive_clientes_ts') {
      const total = Number(localStorage.getItem('acertive_clientes_total') || 0);
      console.log('[clientes-ativos] storage event received, total=', total);
      
      // Atualiza clientCount local (na página de clientes)
      if (clientCount) {
        clientCount.textContent = `${total} cliente${total !== 1 ? 's' : ''}`;
      }
    }
  });

  carregarClientes();
});