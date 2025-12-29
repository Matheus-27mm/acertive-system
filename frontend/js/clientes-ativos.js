// /js/clientes-ativos.js — com dispatch, logs de debug e fallback localStorage
document.addEventListener("DOMContentLoaded", () => {
  const tbody = document.getElementById("tbody");
  const empty = document.getElementById("empty");
  const clientCount = document.getElementById("clientCount");
  const searchInput = document.getElementById("searchInput");
  const statusFilter = document.getElementById("statusFilter");
  const statusBar = document.getElementById("statusBar");

  if (!tbody) {
    console.error("clientes-ativos.js: tbody não encontrado (id='tbody').");
    return;
  }

  let clientes = [];

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

  function renderClientes(lista) {
    tbody.innerHTML = "";
    if (!Array.isArray(lista) || lista.length === 0) {
      empty && (empty.style.display = "block");
      return;
    }
    empty && (empty.style.display = "none");
    lista.forEach(cliente => {
      const cadastro = cliente.created_at || cliente.data_cadastro ? new Date(cliente.created_at || cliente.data_cadastro).toLocaleDateString("pt-BR") : "—";
      const tr = document.createElement("tr");
      tr.dataset.clienteId = cliente.id;
      const statusText = cliente.status === "inativo" ? "Inativo" : "Ativo";
      const statusClass = cliente.status === "inativo" ? "inativo" : "";
      tr.innerHTML = `
        <td class="nameCell">
          <strong>${esc(cliente.nome)}</strong>
          <div class="small">${esc(cliente.email || "-")}</div>
        </td>
        <td>${esc(cliente.telefone || "-")}</td>
        <td>${esc(cliente.cpf_cnpj || "-")}</td>
        <td><span class="badge ${statusClass}">${statusText}</span></td>
        <td>${cadastro}</td>
        <td class="actions">
          <button type="button" class="iconBtn" data-act="edit" data-id="${cliente.id}"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="iconBtn danger" data-act="delete" data-id="${cliente.id}"><i class="fa-solid fa-trash"></i></button>
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
      const matchTermo = !termo || nome.includes(termo) || email.includes(termo) || telefone.includes(termo);
      const matchStatus = !status || (status === "ativo" && (c.status === "ativo" || !c.status)) || (status === "inativo" && c.status === "inativo");
      return matchTermo && matchStatus;
    });
    renderClientes(filtrados);
  }

  searchInput && searchInput.addEventListener("input", aplicarFiltros);
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
  if (btnImportar) btnImportar.addEventListener("click", () => _fileInput.click());

  _fileInput.addEventListener("change", async (ev) => {
    const files = ev.target.files;
    if (!files || !files.length) return;
    const file = files[0];
    try {
      if (statusBar) statusBar.textContent = "Importando...";
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
      if (statusBar) statusBar.textContent = summary;
      showToast(`Importação concluída. ${imported} clientes importados.`, "#27ae60");
      if (errors.length) {
        console.error("[clientes-ativos] import errors:", errors);
        showToast(`Import concluída com ${errors.length} erro(s). Veja console para detalhes.`, "#e67e22", 6000);
      }
      if (imported === 0 && errors.length === 0) {
        console.warn("[clientes-ativos] import result with 0 imported. response body:", json || text);
        showToast("Import concluída com 0 clientes. Verifique cabeçalhos e mapeamento da planilha.", "#e67e22", 6000);
      }
      if (window.carregarClientes) await window.carregarClientes();
      _fileInput.value = "";
      if (statusBar) setTimeout(() => { statusBar.textContent = ""; }, 5000);
    } catch (err) {
      console.error("[clientes-ativos] import error", err);
      showToast("Erro na importação: " + (err.message || err), "#e74c3c", 6000);
      if (statusBar) statusBar.textContent = "";
      _fileInput.value = "";
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
    if (!confirm("Deseja excluir este cliente?")) return;
    try {
      await apiDeleteCliente(id);
      showToast("Cliente excluído com sucesso.", "#27ae60");
      clientes = clientes.filter(c => String(c.id) !== String(id));
      aplicarFiltros();
      // notificar dashboard após exclusão
      try {
        const total = clientes.length;
        window.dispatchEvent(new CustomEvent('clientes:atualizados', { detail: { total } }));
        localStorage.setItem('acertive_clientes_total', String(total));
        localStorage.setItem('acertive_clientes_ts', String(Date.now()));
      } catch (e) { console.warn('dispatch after delete failed', e); }
    } catch (err) {
      console.error("[clientes-ativos] erro ao excluir:", err);
      showToast("Erro ao excluir cliente: " + (err.message || err), "#e74c3c");
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
    overlay.style = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999";
    const modal = document.createElement("div");
    modal.style = "width:520px;max-width:94%;background:#0f0f10;padding:18px;border-radius:12px;color:#fff";
    modal.innerHTML = `
      <h3 style="margin-bottom:8px">Editar cliente</h3>
      <input id="edit_nome" placeholder="Nome" value="${esc(cliente.nome)}" style="width:100%;padding:8px;margin-bottom:8px" />
      <input id="edit_email" placeholder="Email" value="${esc(cliente.email||'')}" style="width:100%;padding:8px;margin-bottom:8px" />
      <input id="edit_telefone" placeholder="Telefone" value="${esc(cliente.telefone||'')}" style="width:100%;padding:8px;margin-bottom:8px" />
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="edit_cancel" style="padding:8px 12px">Cancelar</button>
        <button id="edit_save" style="padding:8px 12px;background:#ffd700;border:0">Salvar</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const inNome = modal.querySelector("#edit_nome");
    const inEmail = modal.querySelector("#edit_email");
    const inTel = modal.querySelector("#edit_telefone");
    modal.querySelector("#edit_cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.remove(); });

    modal.querySelector("#edit_save").addEventListener("click", async () => {
      const novoNome = (inNome.value || "").trim();
      const novoEmail = (inEmail.value || "").trim();
      const novoTel = (inTel.value || "").trim();
      if (!novoNome) return showToast("Nome não pode ficar vazio.", "#e74c3c");
      try {
        await apiUpdateCliente(cliente.id, { nome: novoNome, email: novoEmail || null, telefone: novoTel || null });
        showToast("Cliente atualizado.", "#27ae60");
        overlay.remove();
        await carregarClientes();
      } catch (err) {
        console.error("[clientes-ativos] erro ao atualizar:", err);
        showToast("Erro ao atualizar cliente: " + (err.message || err), "#e74c3c");
      }
    });
  }

  async function carregarClientes() {
    try {
      const list = await apiGetClientesAtivos();
      clientes = list;
      aplicarFiltros();

      if (clientCount) clientCount.textContent = `${Array.isArray(list) ? list.length : 0} clientes`;

      // DEBUG: log e dispatch
      console.log('[clientes-ativos] total obtido:', Array.isArray(list) ? list.length : 0);
      try {
        const total = Array.isArray(list) ? list.length : 0;
        console.log('[clientes-ativos] dispatch clientes:atualizados total=', total);
        if (window && typeof window.dispatchEvent === "function") {
          window.dispatchEvent(new CustomEvent('clientes:atualizados', { detail: { total } }));
        }
        // fallback para abas diferentes
        localStorage.setItem('acertive_clientes_total', String(total));
        localStorage.setItem('acertive_clientes_ts', String(Date.now()));
      } catch (e) {
        console.warn('Erro ao dispatch evento clientes:atualizados', e);
      }

      return list;
    } catch (err) {
      console.error("[clientes-ativos] erro ao carregar:", err);
      showToast("Erro ao carregar clientes: " + (err.message || err), "#e74c3c");
      clientes = [];
      renderClientes([]);
      if (clientCount) clientCount.textContent = "0 clientes";
      return [];
    }
  }

  window.carregarClientes = carregarClientes;

  // listener storage para sincronizar entre abas (dashboard)
  window.addEventListener('storage', (ev) => {
    if (ev.key === 'acertive_clientes_ts') {
      const total = Number(localStorage.getItem('acertive_clientes_total') || 0);
      console.log('[clientes-ativos] storage event received, total=', total);
      // atualiza clientCount local (na página de clientes)
      if (clientCount) clientCount.textContent = `${total} clientes`;
    }
  });

  carregarClientes();
});
