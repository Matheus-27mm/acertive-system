// frontend/js/novo-cliente.js — criação, import, editar e excluir clientes (versão corrigida)
(function () {
  // ===== Guard de autenticação =====
  if (!localStorage.getItem("usuarioLogado") || !localStorage.getItem("token")) {
    window.location.href = "/login";
    return;
  }

  // ===== Utils =====
  function showToast(msg, type = "success") {
    if (typeof Toastify === "undefined") return alert(msg);
    Toastify({
      text: msg,
      duration: 3200,
      close: true,
      gravity: "top",
      position: "right",
      style: { background: type === "success" ? "#28a745" : "#dc3545" },
      stopOnFocus: true,
    }).showToast();
  }

  async function parseResponseSafely(resp) {
    const text = await resp.text().catch(() => "");
    if (!text) return { text: "", json: null };
    try {
      const json = JSON.parse(text);
      return { text, json };
    } catch (e) {
      return { text, json: null };
    }
  }

  function esc(s) {
    return String(s || "").replace(/[<>&"]/g, (m) => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[m]));
  }

  // ===== Elementos =====
  const form = document.getElementById("formNovoCliente"); // form de cadastro
  const inputNome = document.getElementById("cliente_nome_input");
  const inputEmail = document.getElementById("cliente_email_input");
  const inputTelefone = document.getElementById("cliente_telefone_input");
  const inputCpfCnpj = document.getElementById("cliente_cpf_cnpj_input"); // opcional no HTML
  const btnImport = document.getElementById("btnImport"); // botão do form de import
  const fileInput = document.getElementById("fileImport"); // input type=file
  const datalist = document.getElementById("listaClientes"); // datalist usado por nova-cobranca
  const clientesTbody = document.getElementById("clientesTbody"); // tabela de clientes
  const empty = document.getElementById("clientesEmpty");
  const statusBar = document.getElementById("clientesStatus");
  const btnReload = document.getElementById("btnReloadClientes");

  // ===== Estado local =====
  let clientesCache = [];
  let submitting = false;

  // ===== API helpers =====
  function authHeaders(extra = {}) {
    const token = localStorage.getItem("token");
    return Object.assign(
      {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      extra
    );
  }

  async function apiCreateCliente(payload) {
    const resp = await fetch("/api/clientes", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify(payload),
    });
    const { text, json } = await parseResponseSafely(resp);
    if (!resp.ok) {
      // se 401, redireciona para login
      if (resp.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("usuarioLogado");
        window.location.href = "/login";
        throw new Error("Não autorizado. Faça login novamente.");
      }
      const msg = (json && (json.message || json.error)) || text || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return json?.data ?? null;
  }

  async function apiImportClientes(formData) {
    const resp = await fetch("/api/clientes/import", {
      method: "POST",
      headers: authHeaders(), // don't set Content-Type; browser sets multipart boundary
      body: formData,
    });
    const { text, json } = await parseResponseSafely(resp);
    if (!resp.ok) {
      const msg = (json && (json.message || json.error)) || text || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return json ?? {};
  }

  async function apiUpdateCliente(id, payload) {
    const resp = await fetch(`/api/clientes/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify(payload),
    });
    const { text, json } = await parseResponseSafely(resp);
    if (!resp.ok) {
      if (resp.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("usuarioLogado");
        window.location.href = "/login";
        throw new Error("Não autorizado. Faça login novamente.");
      }
      const msg = (json && (json.message || json.error)) || text || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return json?.data ?? null;
  }

  async function apiDeleteCliente(id) {
    const resp = await fetch(`/api/clientes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const { text, json } = await parseResponseSafely(resp);
    if (!resp.ok) {
      if (resp.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("usuarioLogado");
        window.location.href = "/login";
        throw new Error("Não autorizado. Faça login novamente.");
      }
      const msg = (json && (json.message || json.error)) || text || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return json?.data ?? null;
  }

  // ===== Carregar clientes (datalist + tabela) =====
  async function carregarClientes() {
    try {
      if (statusBar) statusBar.textContent = "Carregando clientes…";
      const resp = await fetch("/api/clientes-ativos", { headers: authHeaders() });
      const { text, json } = await parseResponseSafely(resp);

      if (!resp.ok) {
        const serverMsg = (json && (json.message || json.error)) || text || `HTTP ${resp.status}`;
        throw new Error(serverMsg);
      }

      const payload = json ?? {};
      if (!payload.success) throw new Error(payload.message || "Falha ao carregar clientes");

      clientesCache = Array.isArray(payload.data) ? payload.data : [];

      // datalist
      if (datalist) {
        datalist.innerHTML = "";
        clientesCache.forEach((c) => {
          const option = document.createElement("option");
          option.value = c.nome || "";
          option.dataset.id = c.id || "";
          datalist.appendChild(option);
        });
      }

      // tabela
      renderTabelaClientes(clientesCache);

      if (statusBar) statusBar.textContent = "";
    } catch (err) {
      if (statusBar) statusBar.textContent = "Erro ao carregar clientes.";
      showToast("Erro ao carregar clientes: " + (err.message || err), "error");
      clientesCache = [];
      renderTabelaClientes([]);
    }
  }

  function renderTabelaClientes(list) {
    if (!clientesTbody) return;
    if (!list.length) {
      clientesTbody.innerHTML = "";
      if (empty) empty.style.display = "block";
      return;
    }
    if (empty) empty.style.display = "none";

    clientesTbody.innerHTML = list
      .map((c) => {
        const nome = esc(c.nome || "");
        const email = esc(c.email || "");
        const telefone = esc(c.telefone || "");
        // usar campo status (padronizado no servidor)
        const statusText = (c.status === 'inativo' || c.status === 'inativo') ? "Inativo" : "Ativo";
        return `
          <tr data-cliente-id="${c.id}">
            <td style="font-weight:700">${nome}</td>
            <td>${email}</td>
            <td>${telefone}</td>
            <td>${statusText}</td>
            <td>
              <div class="actions">
                <button class="iconBtn" data-act="edit" data-id="${c.id}"><i class="fa-solid fa-pen"></i> Editar</button>
                <button class="iconBtn danger" data-act="delete" data-id="${c.id}"><i class="fa-solid fa-trash"></i> Excluir</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  // ===== Handlers =====
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submitting) return;
      const nome = (inputNome?.value || "").trim();
      const email = (inputEmail?.value || "").trim();
      const telefone = (inputTelefone?.value || "").trim();
      const cpf_cnpj = (inputCpfCnpj?.value || "").trim();

      if (!nome) {
        showToast("Preencha o nome do cliente.", "error");
        return;
      }

      submitting = true;
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const payload = { nome, email: email || null, telefone: telefone || null, cpf_cnpj: cpf_cnpj || null, status: 'ativo' };
        const created = await apiCreateCliente(payload);
        showToast("Cliente criado com sucesso.", "success");
        // limpa form somente após sucesso
        form.reset();
        // atualiza lista/datalist
        await carregarClientes();
      } catch (err) {
        console.error("[novo-cliente] erro ao criar:", err);
        showToast("Erro ao criar cliente: " + (err.message || err), "error");
      } finally {
        submitting = false;
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // Importação de planilha (CSV/XLSX)
  if (btnImport && fileInput) {
    btnImport.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!fileInput.files || !fileInput.files.length) {
        showToast("Selecione um arquivo para importar.", "error");
        return;
      }

      const file = fileInput.files[0];
      const fd = new FormData();
      fd.append("file", file);

      try {
        const result = await apiImportClientes(fd);
        const imported = result.imported ?? result.count ?? 0;
        showToast(`Importação concluída. ${imported} clientes importados.`, "success");
        fileInput.value = "";
        await carregarClientes();
      } catch (err) {
        console.error("[novo-cliente] erro import:", err);
        showToast("Erro na importação: " + (err.message || err), "error");
      }
    });
  }

  // Delegação de eventos para editar/excluir na tabela
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest && ev.target.closest("button[data-act][data-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    const act = btn.getAttribute("data-act");

    if (!id) return;

    if (act === "delete") {
      if (!confirm("Deseja excluir este cliente? Esta ação pode ser revertida pelo administrador.")) return;
      try {
        await apiDeleteCliente(id);
        showToast("Cliente excluído.", "success");
        // remove linha localmente
        const row = document.querySelector(`[data-cliente-id="${id}"]`);
        if (row) row.remove();
        // atualizar cache e datalist
        clientesCache = clientesCache.filter((c) => String(c.id) !== String(id));
        if (datalist) {
          const opt = [...datalist.options].find((o) => o.dataset.id === id);
          if (opt) opt.remove();
        }
      } catch (err) {
        console.error("[novo-cliente] erro ao excluir:", err);
        showToast("Erro ao excluir cliente: " + (err.message || err), "error");
      }
      return;
    }

    if (act === "edit") {
      const cliente = clientesCache.find((c) => String(c.id) === String(id));
      if (!cliente) {
        showToast("Cliente não encontrado localmente. Recarregando...", "error");
        await carregarClientes();
        return;
      }

      const novoNome = prompt("Nome do cliente:", cliente.nome || "");
      if (novoNome === null) return; // cancelou
      const novoEmail = prompt("Email do cliente:", cliente.email || "");
      if (novoEmail === null) return;
      const novoTelefone = prompt("Telefone do cliente:", cliente.telefone || "");
      if (novoTelefone === null) return;

      try {
        await apiUpdateCliente(id, {
          nome: novoNome.trim(),
          email: novoEmail.trim(),
          telefone: novoTelefone.trim(),
        });
        showToast("Cliente atualizado.", "success");
        await carregarClientes();
      } catch (err) {
        console.error("[novo-cliente] erro ao atualizar:", err);
        showToast("Erro ao atualizar cliente: " + (err.message || err), "error");
      }
      return;
    }
  });

  // reload manual
  if (btnReload) btnReload.addEventListener("click", () => carregarClientes());

  // Expor função global para nova-cobranca.js (se necessário)
  window.carregarClientes = carregarClientes;

  // Init
  document.addEventListener("DOMContentLoaded", () => {
    carregarClientes();
  });
})();
