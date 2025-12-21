// clientes-ativos.js (ACERTIVE) - Importa Excel via backend e lista clientes

// =====================
// Helpers
// =====================
function $(id) {
  return document.getElementById(id);
}

function showToast(msg, type = "info") {
  if (typeof Toastify === "undefined") return;

  const colors = {
    success: "#28a745",
    error: "#dc3545",
    info: "#FFD700",
  };

  Toastify({
    text: msg,
    duration: 3200,
    close: true,
    gravity: "top",
    position: "right",
    backgroundColor: colors[type] || colors.info,
    stopOnFocus: true,
  }).showToast();
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[m]));
}

function formatDateBR(iso) {
  try {
    return iso ? new Date(iso).toLocaleDateString("pt-BR") : "-";
  } catch {
    return "-";
  }
}

// =====================
// Auth Guard (compatível com seus dois padrões)
// =====================
(function authGuard() {
  const logadoObj = localStorage.getItem("usuarioLogado");
  const isLoggedIn = localStorage.getItem("isLoggedIn");

  if (!logadoObj && isLoggedIn !== "true") {
    window.location.href = "/login";
  }
})();

// =====================
// State
// =====================
let clientes = [];

// =====================
// API
// =====================
async function apiListarClientes() {
  const resp = await fetch("/api/clientes", { method: "GET" });
  if (!resp.ok) throw new Error("Falha ao carregar /api/clientes");
  const data = await resp.json();
  return data.data || [];
}

async function apiImportarExcel(file) {
  const fd = new FormData();
  fd.append("arquivo", file);

  const resp = await fetch("/api/clientes/importar", {
    method: "POST",
    body: fd,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.success) {
    throw new Error(data.message || "Erro ao importar");
  }
  return data;
}

// =====================
// Render
// =====================
function renderTabela(lista) {
  const tbody = $("tbody");
  const empty = $("empty");

  if (!tbody) return;

  if (!lista || !lista.length) {
    tbody.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }

  if (empty) empty.style.display = "none";

  tbody.innerHTML = lista
    .map((c) => {
      const status = (c.status || "ativo").toLowerCase() === "inativo" ? "inativo" : "ativo";
      return `
      <tr>
        <td>
          <div class="nameCell">
            ${escapeHtml(c.name || "")}
            <small>${c.type === "pj" ? "Pessoa Jurídica" : "Pessoa Física"}</small>
          </div>
        </td>
        <td>${escapeHtml(c.email || "-")}</td>
        <td>${escapeHtml(c.phone || "-")}</td>
        <td>${escapeHtml(c.cpfCnpj || "-")}</td>
        <td>
          <span class="badge ${status === "inativo" ? "inativo" : ""}">
            ${status === "inativo" ? "Inativo" : "Ativo"}
          </span>
        </td>
        <td>${formatDateBR(c.createdAt)}</td>
        <td>
          <div class="actions">
            <button class="iconBtn" title="Editar (próxima etapa)" data-edit="${escapeHtml(c.id)}">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button class="iconBtn danger" title="Excluir (próxima etapa)" data-del="${escapeHtml(c.id)}">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
      `;
    })
    .join("");
}

function updateCount(n) {
  const el = $("clientCount");
  if (el) el.textContent = `${n} cliente${n !== 1 ? "s" : ""}`;
}

function setStatusBar(msg) {
  const el = $("statusBar");
  if (el) el.textContent = msg || "";
}

// =====================
// Filtros
// =====================
function aplicarFiltros() {
  const q = ($("searchInput")?.value || "").toLowerCase().trim();
  const st = ($("statusFilter")?.value || "").toLowerCase();

  let lista = [...clientes];

  if (q) {
    lista = lista.filter((c) => {
      const name = (c.name || "").toLowerCase();
      const email = (c.email || "").toLowerCase();
      const phone = (c.phone || "");
      return name.includes(q) || email.includes(q) || phone.includes(q);
    });
  }

  if (st) {
    lista = lista.filter((c) => (c.status || "ativo").toLowerCase() === st);
  }

  renderTabela(lista);
  updateCount(lista.length);
}

// =====================
// CSV Export
// =====================
function exportarCSV() {
  if (!clientes.length) return showToast("Não há clientes para exportar.", "error");

  const header = ["CODCLI", "Nome", "Email", "Telefone", "CPF/CNPJ", "Status", "Tipo", "Cadastro"];
  const rows = clientes.map((c) => [
    c.codcli || "",
    c.name || "",
    c.email || "",
    c.phone || "",
    c.cpfCnpj || "",
    c.status || "ativo",
    c.type || "pf",
    c.createdAt || "",
  ]);

  const csv = [header, ...rows]
    .map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";"))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `clientes_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
  showToast("CSV exportado com sucesso.", "success");
}

// =====================
// Init
// =====================
document.addEventListener("DOMContentLoaded", async () => {
  // Botões
  $("btnVoltar")?.addEventListener("click", () => (window.location.href = "/dashboard"));
  $("btnNovo")?.addEventListener("click", () => (window.location.href = "/novo-cliente"));

  $("btnLogout")?.addEventListener("click", () => {
    localStorage.removeItem("usuarioLogado");
    localStorage.removeItem("isLoggedIn");
    localStorage.removeItem("username");
    window.location.href = "/login";
  });

  $("btnExportar")?.addEventListener("click", exportarCSV);

  // Importar Excel -> abre seletor
  $("btnImportar")?.addEventListener("click", () => $("fileExcel")?.click());

  // Quando escolher arquivo, envia pro backend
  $("fileExcel")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatusBar("Importando planilha…");
    try {
      const result = await apiImportarExcel(file);

      showToast(
        `Importação concluída: ${result.importados} novos, ${result.duplicados} duplicados, ${result.ignorados} ignorados.`,
        "success"
      );

      clientes = await apiListarClientes();
      aplicarFiltros();
      setStatusBar("");
    } catch (err) {
      showToast(err.message || "Falha ao importar planilha.", "error");
      setStatusBar("");
    } finally {
      // permite importar o mesmo arquivo de novo (se precisar)
      $("fileExcel").value = "";
    }
  });

  // filtros
  $("searchInput")?.addEventListener("input", aplicarFiltros);
  $("statusFilter")?.addEventListener("change", aplicarFiltros);

  // carrega
  try {
    setStatusBar("Carregando clientes…");
    clientes = await apiListarClientes();
    aplicarFiltros();
    setStatusBar("");
  } catch (err) {
    showToast("Não consegui carregar clientes do servidor.", "error");
    renderTabela([]);
    updateCount(0);
    setStatusBar("Servidor indisponível ou rota /api/clientes com erro.");
  }
});
