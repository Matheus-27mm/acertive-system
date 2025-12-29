// frontend/js/novo-cliente.js — criação, import, editar e excluir clientes (versão estável)
(function () {
  // ===== Guard de autenticação (apenas token) =====
  const token = localStorage.getItem("token");
  if (!token) {
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
      return { text, json: JSON.parse(text) };
    } catch {
      return { text, json: null };
    }
  }

  function esc(s) {
    return String(s || "").replace(/[<>&"]/g, (m) => ({
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
    }[m]));
  }

  function handleUnauthorized() {
    localStorage.removeItem("token");
    // remove as duas variações, caso existam no seu projeto
    localStorage.removeItem("usuarioLogado");
    localStorage.removeItem("usuariologado");
    window.location.href = "/login";
  }

  // ===== Elementos =====
  const form = document.getElementById("formNovoCliente");
  const inputNome = document.getElementById("cliente_nome_input");
  const inputEmail = document.getElementById("cliente_email_input");
  const inputTelefone = document.getElementById("cliente_telefone_input");
  const inputCpfCnpj = document.getElementById("cliente_cpf_cnpj_input");

  const btnImport = document.getElementById("btnImport");
  const fileInput = document.getElementById("fileImport");

  const datalist = document.getElementById("listaClientes");
  const clientesTbody = document.getElementById("clientesTbody");
  const empty = document.getElementById("clientesEmpty");
  const statusBar = document.getElementById("clientesStatus");
  const btnReload = document.getElementById("btnReloadClientes");

  // ===== Estado local =====
  let clientesCache = [];
  let submitting = false;

  // ===== Headers =====
  function authHeaders(extra = {}) {
    // usa o token já validado no guard
    return Object.assign(
      { Authorization: `Bearer ${token}` },
      extra
    );
  }

  // ===== API helpers =====
  async function apiCreateCliente(payload) {
    const resp = await fetch("/api/clientes", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });

    const { text, json } = await parseResponseSafely(resp);

    if (!resp.ok) {
      if (resp.status === 401) {
        handleUnauthorized();
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
      headers: authHeaders(), // não setar Content-Type em multipart
      body: formData,
    });

    const { text, json } = await parseResponseSafely(resp);

    if (!resp.ok) {
      if (resp.status === 401) {
        handleUnauthorized();
        throw new Error("Não autorizado. Faça login novamente.");
      }
      const msg = (json && (json.message || json.error)) || text || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return json ?? {};
  }

  async function apiUpdateCliente(id, payload) {
    const resp = await fetch(`/api/clientes/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });

    const { text, json } = await parseResponseSafely(resp);

    if (!resp.ok) {
      if (resp.status === 401) {
        handleUnauthorized();
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
        handleUnauthorized();
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

      const resp = await fetch("/api/clientes-ativos", {
        headers: authHeaders(),
      });

      const { text, json } = await parseResponseSafely(resp);

      if (!resp.ok) {
        if (resp.status === 401) {
          handleUnauthorized();
          return;
        }
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
          option.dataset.id = String(c.id || "");
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

        const st = String(c.status || "ativo").toLowerCase();
        const statusText = st === "inativo" ? "Inativo" : "Ativo";

        return `
          <tr data-cliente-id="${esc(String(c.id || ""))}">
            <td style="font-weight:700">${nome}</td>
            <td>${email}</td>
            <td>${telefone}</td>
            <td>${statusText}</td>
            <td>
              <div class="actions">
                <button class="iconBtn" data-act="edit" data-id="${esc(String(c.id || ""))}">
                  <i class="fa-solid fa-pen"></i> Editar
                </button>
                <button class="iconBtn danger" data-act="delete" data-id="${esc(String(c.id || ""))}">
                  <i class="fa-solid fa-trash"></i> Excluir
                </button>
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
        const payload = {
          nome,
          email: email || null,
          telefone: telefone || null,
          cpf_cnpj: cpf_cnpj || null,
          status: "ativo",
        };

        await apiCreateCliente(payload);
        showToast("Cliente criado com sucesso.", "success");
        form.reset();
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

      const fd = new FormData();
      fd.append("file", fileInput.files[0]);

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
      if (!confirm("Deseja excluir este cliente?")) return;

      try {
        await apiDeleteCliente(id);
        showToast("Cliente excluído.", "success");

        // remove da tabela
        const row = document.querySelector(`[data-cliente-id="${CSS.escape(String(id))}"]`);
        if (row) row.remove();

        // atualiza cache e datalist
        clientesCache = clientesCache.filter((c) => String(c.id) !== String(id));
        if (datalist) {
          const opt = [...datalist.options].find((o) => o.dataset.id === String(id));
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
        showToast("Cliente não encontrado. Recarregando...", "error");
        await carregarClientes();
        return;
      }

      const novoNome = prompt("Nome do cliente:", cliente.nome || "");
      if (novoNome === null) return;

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
    }
  });

  // Reload manual
  if (btnReload) btnReload.addEventListener("click", () => carregarClientes());

  // Expor função global (se sua nova-cobranca.js usar)
  window.carregarClientes = carregarClientes;

  // Init
  document.addEventListener("DOMContentLoaded", () => {
    carregarClientes();
  });
})();
