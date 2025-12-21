// nova-cobranca.js (ACERTIVE) — compatível com server.js padronizado
(function () {
  // ===== Guard de login =====
  const logado = localStorage.getItem("usuarioLogado");
  const isLoggedIn = localStorage.getItem("isLoggedIn");
  if (!logado && isLoggedIn !== "true") {
    window.location.href = "/login";
    return;
  }

  // ===== Utils =====
  function showToast(msg, type = "success") {
    if (typeof Toastify === "undefined") return alert(msg);
    Toastify({
      text: msg,
      duration: 3000,
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

  function formatarDataBR(iso) {
    if (!iso) return "—";
    const d = new Date(String(iso).slice(0, 10) + "T00:00:00");
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("pt-BR");
  }

  function normalizePercent(taxaStr) {
    const s = String(taxaStr || "").replace("%", "").replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  // Regras do cálculo (front)
  const TAXAS = { "8%": 0.0027, "6%": 0.002, "4%": 0.0014, "3%": 0.001, "2%": 0.0007 };
  const MULTA = 0.02;

  // ===== Elementos =====
  const btnLogout = document.getElementById("btnLogout");
  const form = document.getElementById("formCobranca");
  const btnPdf = document.getElementById("btnPdf");

  const elResultado = document.getElementById("resultado");
  const elStatusMsg = document.getElementById("statusMsg");

  const resCliente = document.getElementById("resCliente");
  const resOriginal = document.getElementById("resOriginal");
  const resVencimento = document.getElementById("resVencimento");
  const resPagamento = document.getElementById("resPagamento");
  const resDias = document.getElementById("resDias");
  const resJuros = document.getElementById("resJuros");
  const resMulta = document.getElementById("resMulta");
  const resAtualizado = document.getElementById("resAtualizado");

  let dadosCobranca = null;

  if (!form || !btnPdf || !elResultado) return;

  // ===== Logout =====
  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("usuarioLogado");
      localStorage.removeItem("isLoggedIn");
      localStorage.removeItem("username");
      window.location.href = "/login";
    });
  }

  // ===== PDF =====
  function exportarPDF() {
    if (!dadosCobranca) return;

    const jsPDF = window?.jspdf?.jsPDF;
    if (!jsPDF) {
      showToast("jsPDF não carregou. Verifique o <script> no HTML.", "error");
      return;
    }

    const doc = new jsPDF();

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("ACERTIVE - COBRANÇA", 105, 18, { align: "center" });

    doc.setLineWidth(0.5);
    doc.line(18, 24, 192, 24);

    doc.setFontSize(12);
    doc.setFont("helvetica", "normal");

    let y = 34;
    const lines = [
      `Cliente: ${dadosCobranca.cliente}`,
      `Valor Original: ${moedaBR(dadosCobranca.valorOriginal)}`,
      `Vencimento: ${formatarDataBR(dadosCobranca.vencimento)}`,
      `Pagamento (referência): ${formatarDataBR(dadosCobranca.pagamentoRef)}`,
      `Dias em atraso: ${dadosCobranca.dias} dia(s)`,
      `Taxa: ${dadosCobranca.taxa}`,
      `Juros: ${moedaBR(dadosCobranca.juros)}`,
      `Multa (2%): ${moedaBR(dadosCobranca.multa)}`,
      `Valor Atualizado: ${moedaBR(dadosCobranca.valorAtualizado)}`,
    ];

    for (const line of lines) {
      doc.text(line, 18, y);
      y += 8;
    }

    doc.setLineWidth(0.5);
    doc.line(18, y + 2, 192, y + 2);

    doc.setFontSize(10);
    doc.text("Documento gerado em: " + new Date().toLocaleDateString("pt-BR"), 105, 285, { align: "center" });

    const safeName = String(dadosCobranca.cliente || "cliente").replace(/[^\w\-]+/g, "_");
    doc.save(`cobranca_${safeName}.pdf`);
  }

  btnPdf.addEventListener("click", exportarPDF);

  // ===== API =====
  async function salvarCobrancaNoServidor(payload) {
    const resp = await fetch("/api/cobrancas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) throw new Error(json.message || "Falha ao salvar cobrança");
    return json.data;
  }

  // ===== Submit =====
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const cliente = document.getElementById("cliente")?.value?.trim();
    const valorOriginal = Number(document.getElementById("valorOriginal")?.value);
    const vencimento = document.getElementById("vencimento")?.value;
    const pagamento = document.getElementById("pagamento")?.value; // opcional
    const taxa = document.getElementById("taxa")?.value || "8%";

    if (!cliente || !valorOriginal || !vencimento) {
      showToast("Preencha cliente, valor e vencimento.", "error");
      return;
    }

    const pagamentoRef = (pagamento || new Date().toISOString().slice(0, 10)).slice(0, 10);

    // Cálculo visual (front)
    const venc = new Date(vencimento + "T00:00:00");
    const pag = new Date(pagamentoRef + "T00:00:00");
    const diffMs = pag.getTime() - venc.getTime();
    const dias = diffMs > 0 ? Math.ceil(diffMs / (1000 * 60 * 60 * 24)) : 0;

    const txDia = TAXAS[taxa] ?? TAXAS["8%"];
    const juros = dias > 0 ? valorOriginal * txDia * dias : 0;
    const multa = dias > 0 ? valorOriginal * MULTA : 0;
    const valorAtualizado = Number((valorOriginal + juros + multa).toFixed(2));

    // UI
    elResultado.style.display = "block";
    if (elStatusMsg) elStatusMsg.textContent = "Calculado. Salvando no servidor…";

    if (resCliente) resCliente.textContent = cliente;
    if (resOriginal) resOriginal.textContent = moedaBR(valorOriginal);
    if (resVencimento) resVencimento.textContent = formatarDataBR(vencimento);
    if (resPagamento) resPagamento.textContent = formatarDataBR(pagamentoRef);
    if (resDias) resDias.textContent = `${dias} dia(s)`;
    if (resJuros) resJuros.textContent = moedaBR(juros);
    if (resMulta) resMulta.textContent = moedaBR(multa);
    if (resAtualizado) resAtualizado.textContent = moedaBR(valorAtualizado);

    // Salvar no backend (compatível com server.js)
    try {
      const taxaPercent = normalizePercent(taxa);
      const status = pagamento ? "pago" : (dias > 0 ? "pendente" : "em-dia");

      const cobrancaSalva = await salvarCobrancaNoServidor({
        cliente,
        valorOriginal,
        vencimento,
        pagamento: pagamento ? pagamento.slice(0, 10) : "",
        taxa,         // string "8%"
        taxaPercent,  // opcional (número)
        dias,         // ✅ padronizado
        juros: Number(juros.toFixed(2)),
        multa: Number(multa.toFixed(2)),
        valorAtualizado, // ✅ padronizado
        status,
      });

      dadosCobranca = {
        ...cobrancaSalva,
        pagamentoRef,
      };

      if (elStatusMsg) elStatusMsg.textContent = "Cobrança salva com sucesso.";
      btnPdf.disabled = false;
      showToast("Cobrança criada e salva.", "success");
    } catch (err) {
      // Mesmo com erro de API, libera PDF do cálculo local
      dadosCobranca = {
        cliente,
        valorOriginal,
        vencimento,
        taxa,
        juros: Number(juros.toFixed(2)),
        multa: Number(multa.toFixed(2)),
        valorAtualizado,
        dias,
        pagamentoRef,
      };

      if (elStatusMsg) elStatusMsg.textContent = "Calculado, mas não foi possível salvar no servidor.";
      btnPdf.disabled = false;
      showToast("Erro ao salvar no servidor: " + err.message, "error");
    }
  });
})();
