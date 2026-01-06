// nova-cobranca.js — versão melhorada com máscara de moeda e validações
(function () {
  const logado = localStorage.getItem("usuarioLogado");
  const isLoggedIn = localStorage.getItem("isLoggedIn");
  if (!logado && isLoggedIn !== "true") {
    window.location.href = "/login";
    return;
  }

  (function tokenCheck() {
    const token = localStorage.getItem("token");
    if (!token) {
      if (typeof Toastify !== "undefined") {
        Toastify({
          text: "Sessão expirada. Faça login novamente.",
          duration: 3000,
          close: true,
          gravity: "top",
          position: "right",
          style: { background: "#dc3545" },
          stopOnFocus: true,
        }).showToast();
      } else {
        alert("Sessão expirada. Faça login novamente.");
      }
      setTimeout(() => (window.location.href = "/login"), 1200);
    }
  })();

  function showToast(msg, type = "success") {
    if (typeof Toastify === "undefined") return alert(msg);
    Toastify({
      text: msg,
      duration: 3500,
      close: true,
      gravity: "top",
      position: "right",
      style: { background: type === "success" ? "#28a745" : "#dc3545" },
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

  // Taxas de juros por dia (atualizado com novas opções)
  const TAXAS = { 
    "10%": 0.0033,
    "8%": 0.0027, 
    "6%": 0.002, 
    "4%": 0.0014, 
    "3%": 0.001, 
    "2%": 0.0007,
    "1%": 0.00033,
    "0%": 0
  };
  const MULTA = 0.02;

  // ===============
  // DOM Elements
  // ===============
  const btnLogout = document.getElementById("btnLogout");
  const form = document.getElementById("formCobranca");
  const btnPdf = document.getElementById("btnPdf");
  const statusBadge = document.getElementById("statusBadge");

  const inputNome = document.getElementById("cliente_nome");
  const inputId = document.getElementById("cliente_id");
  const datalist = document.getElementById("listaClientes");

  const resCliente = document.getElementById("resCliente");
  const resOriginal = document.getElementById("resOriginal");
  const resVencimento = document.getElementById("resVencimento");
  const resPagamento = document.getElementById("resPagamento");
  const resDias = document.getElementById("resDias");
  const resJuros = document.getElementById("resJuros");
  const resMulta = document.getElementById("resMulta");
  const resAtualizado = document.getElementById("resAtualizado");

  let dadosCobranca = null;
  let clientesCache = [];

  if (!form || !btnPdf) return;

  // ===============
  // Função para obter valor numérico do campo formatado
  // ===============
  function getValorOriginal() {
    // Primeiro tenta usar a função global definida no HTML
    if (typeof window.getValorOriginalNumerico === 'function') {
      return window.getValorOriginalNumerico();
    }
    
    // Fallback: tenta pegar do campo hidden
    const valorNumerico = document.getElementById("valorOriginalNumerico");
    if (valorNumerico && valorNumerico.value) {
      return parseFloat(valorNumerico.value) || 0;
    }
    
    // Último fallback: tenta converter o valor do campo texto
    const valorInput = document.getElementById("valorOriginal");
    if (valorInput) {
      const valorTexto = valorInput.value || "";
      // Remove pontos de milhar e troca vírgula por ponto
      const valorLimpo = valorTexto.replace(/\./g, '').replace(',', '.');
      return parseFloat(valorLimpo) || 0;
    }
    
    return 0;
  }

  // ===============
  // Stepper Control
  // ===============
  function updateStepper(step) {
    const steps = document.querySelectorAll('.step');
    steps.forEach((s, index) => {
      const stepNum = index + 1;
      const circle = s.querySelector('.step-circle');
      
      if (stepNum < step) {
        s.classList.add('completed');
        s.classList.remove('active');
        circle.innerHTML = '<i class="fa-solid fa-check"></i>';
      } else if (stepNum === step) {
        s.classList.add('active');
        s.classList.remove('completed');
        circle.textContent = stepNum;
      } else {
        s.classList.remove('active', 'completed');
        circle.textContent = stepNum;
      }
    });
  }

  // ===============
  // Status Badge Control
  // ===============
  function updateStatusBadge(status, text) {
    if (!statusBadge) return;
    
    statusBadge.className = `status-badge ${status}`;
    
    const icons = {
      aguardando: 'fa-clock',
      calculando: 'fa-spinner fa-spin',
      sucesso: 'fa-check-circle',
      erro: 'fa-exclamation-circle'
    };
    
    statusBadge.innerHTML = `<i class="fa-solid ${icons[status] || icons.aguardando}"></i> ${text}`;
  }

  // ===============
  // Field Validation
  // ===============
  function validateField(input, condition, errorMsg) {
    const fieldGroup = input.closest('.field-group');
    if (!fieldGroup) return condition;
    
    const errorElement = fieldGroup.querySelector('.error-message');
    
    if (!condition) {
      fieldGroup.classList.add('error');
      fieldGroup.classList.remove('filled');
      if (errorElement && errorMsg) {
        errorElement.textContent = errorMsg;
      }
      return false;
    } else {
      fieldGroup.classList.remove('error');
      if (input.value.trim()) {
        fieldGroup.classList.add('filled');
      }
      return true;
    }
  }

  function clearFieldError(input) {
    const fieldGroup = input.closest('.field-group');
    if (fieldGroup) {
      fieldGroup.classList.remove('error');
      if (input.value.trim()) {
        fieldGroup.classList.add('filled');
      } else {
        fieldGroup.classList.remove('filled');
      }
    }
  }

  // Add real-time validation (exceto para o campo de valor que tem seu próprio handler)
  const inputs = form.querySelectorAll('input:not(#valorOriginal):not(#valorOriginalNumerico), select');
  inputs.forEach(input => {
    input.addEventListener('blur', () => {
      if (input.hasAttribute('required') && !input.value.trim()) {
        validateField(input, false, 'Campo obrigatório');
      }
    });

    input.addEventListener('input', () => {
      clearFieldError(input);
    });

    input.addEventListener('change', () => {
      clearFieldError(input);
    });
  });

  // ===============
  // Update Resume Card
  // ===============
  function updateResumeField(id, value, shouldHighlight = false) {
    const kvItem = document.getElementById(id);
    if (!kvItem) return;
    
    if (value !== "—") {
      kvItem.classList.add('filled');
      if (shouldHighlight) {
        setTimeout(() => {
          kvItem.style.transform = 'scale(1.05)';
          setTimeout(() => {
            kvItem.style.transform = 'scale(1)';
          }, 200);
        }, 50);
      }
    } else {
      kvItem.classList.remove('filled');
    }
  }

  // ===============
  // Logout
  // ===============
  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("usuarioLogado");
      localStorage.removeItem("isLoggedIn");
      localStorage.removeItem("username");
      localStorage.removeItem("token");
      localStorage.removeItem("refreshToken");
      window.location.href = "/login";
    });
  }

  // ===============
  // Download Blob
  // ===============
  function baixarBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "cobranca.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ===============
  // Export PDF
  // ===============
  async function exportarPDF() {
    const id =
      dadosCobranca?.id ||
      dadosCobranca?.data?.id ||
      dadosCobranca?.cobranca?.id ||
      dadosCobranca?.cobranca_id ||
      dadosCobranca?.cobrancaId ||
      btnPdf?.dataset?.cobrancaId ||
      localStorage.getItem("lastCobrancaId");

    if (!id) {
      showToast("ID inválido. Salve a cobrança antes de exportar o PDF.", "error");
      return;
    }

    try {
      btnPdf.disabled = true;
      btnPdf.classList.add('loading');
      btnPdf.innerHTML = '<i class="fa-solid fa-spinner"></i> Gerando PDF...';

      const token = localStorage.getItem("token") || "";
      const url = `/api/cobrancas/${encodeURIComponent(id)}/pdf`;

      let resp = await fetch(url, {
        method: "GET",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });

      if (resp.status === 401) {
        const refreshed = await tentarRefresh();
        if (refreshed) {
          const token2 = localStorage.getItem("token") || "";
          resp = await fetch(url, {
            method: "GET",
            headers: { ...(token2 ? { Authorization: `Bearer ${token2}` } : {}) },
          });
        }
      }

      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(t || `HTTP ${resp.status}`);
      }

      const blob = await resp.blob();
      baixarBlob(blob, `cobranca_${String(id).slice(0, 8)}.pdf`);
      showToast("PDF gerado com sucesso!", "success");
    } catch (e) {
      showToast("Erro ao gerar PDF: " + (e?.message || e), "error");
    } finally {
      btnPdf.disabled = false;
      btnPdf.classList.remove('loading');
      btnPdf.innerHTML = '<i class="fa-solid fa-file-pdf"></i> Exportar PDF';
    }
  }

  btnPdf.addEventListener("click", exportarPDF);

  // ===============
  // Token Refresh
  // ===============
  async function tentarRefresh() {
    try {
      const refreshToken = localStorage.getItem("refreshToken");
      if (!refreshToken) return false;

      const r = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      const txt = await r.text().catch(() => "");
      let j = {};
      try {
        j = txt ? JSON.parse(txt) : {};
      } catch (e) {}

      if (!r.ok) return false;
      if (j.token) {
        localStorage.setItem("token", j.token);
        if (j.refreshToken) localStorage.setItem("refreshToken", j.refreshToken);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // ===============
  // Save to Server
  // ===============
  async function salvarCobrancaNoServidor(payload) {
    const send = async () => {
      const token = localStorage.getItem("token") || "";
      const resp = await fetch("/api/cobrancas", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      const text = await resp.text().catch(() => "");
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch (e) {}
      return { resp, text, json };
    };

    try {
      let { resp, text, json } = await send();

      if (resp.status === 401) {
        const refreshed = await tentarRefresh();
        if (refreshed) {
          ({ resp, text, json } = await send());
        } else {
          localStorage.removeItem("token");
          localStorage.removeItem("usuarioLogado");
          localStorage.removeItem("isLoggedIn");
          showToast("Sessão inválida ou expirada. Faça login novamente.", "error");
          setTimeout(() => (window.location.href = "/login"), 900);
          throw new Error(json.message || "Token inválido ou expirado");
        }
      }

      if (!resp.ok) {
        const serverMsg = json?.error || json?.message || text || `HTTP ${resp.status}`;
        showToast("Erro ao salvar no servidor: " + serverMsg, "error");
        throw new Error(serverMsg);
      }

      return json.data ?? json;
    } catch (err) {
      showToast("Erro ao salvar no servidor: " + (err.message || err), "error");
      throw err;
    }
  }

  // ===============
  // Load Clients
  // ===============
  async function carregarClientes() {
    try {
      const res = await fetch("/api/clientes-ativos");
      const json = await res.json();
      if (!json.success) throw new Error(json.message || "Falha ao carregar clientes");

      clientesCache = Array.isArray(json.data) ? json.data : [];
      datalist.innerHTML = "";
      clientesCache.forEach((cliente) => {
        const option = document.createElement("option");
        option.value = cliente.nome;
        option.dataset.id = cliente.id;
        datalist.appendChild(option);
      });

      inputNome.addEventListener("change", () => {
        const match = clientesCache.find((c) => c.nome === inputNome.value);
        inputId.value = match ? match.id : "";
        clearFieldError(inputNome);
        
        // Atualiza resumo
        if (resCliente) {
          resCliente.textContent = inputNome.value || "—";
          updateResumeField('kvCliente', inputNome.value || "—");
        }
      });

      inputNome.addEventListener("blur", () => {
        const match = clientesCache.find(
          (c) => c.nome.toLowerCase() === inputNome.value.trim().toLowerCase()
        );
        inputId.value = match ? match.id : "";
      });

      inputNome.addEventListener("input", () => {
        if (!clientesCache.some((c) => c.nome === inputNome.value)) {
          inputId.value = "";
        }
        
        // Atualiza resumo em tempo real
        if (resCliente) {
          resCliente.textContent = inputNome.value || "—";
          const kvCliente = document.getElementById('kvCliente');
          if (kvCliente) {
            if (inputNome.value) {
              kvCliente.classList.add('filled');
            } else {
              kvCliente.classList.remove('filled');
            }
          }
        }
      });
    } catch (e) {
      showToast("Erro ao carregar clientes ativos.", "error");
    }
  }
  carregarClientes();

  // ===============
  // Atualiza resumo das datas em tempo real
  // ===============
  const vencimentoInput = document.getElementById("vencimento");
  const pagamentoInput = document.getElementById("pagamento");

  if (vencimentoInput) {
    vencimentoInput.addEventListener("change", () => {
      if (resVencimento) {
        resVencimento.textContent = formatarDataBR(vencimentoInput.value);
        updateResumeField('kvVencimento', formatarDataBR(vencimentoInput.value));
      }
    });
  }

  if (pagamentoInput) {
    pagamentoInput.addEventListener("change", () => {
      if (resPagamento) {
        resPagamento.textContent = formatarDataBR(pagamentoInput.value) || "Hoje";
        updateResumeField('kvPagamento', formatarDataBR(pagamentoInput.value) || "Hoje");
      }
    });
  }

  // ===============
  // Form Submit
  // ===============
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Update stepper to calculation
    updateStepper(2);
    updateStatusBadge('calculando', 'Processando cálculo...');

    let cliente_id = inputId.value;
    const cliente_nome = inputNome.value.trim();
    
    // *** USA A NOVA FUNÇÃO PARA OBTER O VALOR ***
    const valorOriginal = getValorOriginal();
    
    const vencimento = document.getElementById("vencimento")?.value;
    const pagamento = document.getElementById("pagamento")?.value;
    const taxa = document.getElementById("taxa")?.value || "8%";

    // Validations
    let isValid = true;

    isValid = validateField(inputNome, cliente_nome !== "", "Preencha o nome do cliente") && isValid;

    if (!cliente_id || cliente_id.trim() === "") {
      const tentativa = clientesCache.find((c) => c.nome.toLowerCase() === cliente_nome.toLowerCase());
      if (tentativa) {
        cliente_id = tentativa.id;
        inputId.value = cliente_id;
      }
    }

    isValid = validateField(inputNome, cliente_id && cliente_id.trim() !== "", "Selecione um cliente válido das sugestões") && isValid;

    const valorInput = document.getElementById("valorOriginal");
    isValid = validateField(valorInput, valorOriginal && !Number.isNaN(valorOriginal) && valorOriginal > 0, "Informe um valor válido maior que zero") && isValid;

    const vencimentoInputEl = document.getElementById("vencimento");
    isValid = validateField(vencimentoInputEl, vencimento !== "", "Informe a data de vencimento") && isValid;

    if (!isValid) {
      updateStepper(1);
      updateStatusBadge('erro', 'Corrija os erros no formulário');
      return;
    }

    // Calculate
    const pagamentoRef = (pagamento || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const venc = new Date(vencimento + "T00:00:00");
    const pag = new Date(pagamentoRef + "T00:00:00");
    const diffMs = pag.getTime() - venc.getTime();
    const dias = diffMs > 0 ? Math.ceil(diffMs / (1000 * 60 * 60 * 24)) : 0;

    const txDia = TAXAS[taxa] ?? TAXAS["8%"];
    const juros = dias > 0 ? valorOriginal * txDia * dias : 0;
    const multa = dias > 0 ? valorOriginal * MULTA : 0;
    const valorAtualizado = Number((valorOriginal + juros + multa).toFixed(2));

    // Update resume with animation
    if (resCliente) {
      resCliente.textContent = cliente_nome;
      updateResumeField('kvCliente', cliente_nome);
    }
    
    if (resOriginal) {
      resOriginal.textContent = moedaBR(valorOriginal);
      updateResumeField('kvOriginal', moedaBR(valorOriginal));
    }
    
    if (resVencimento) {
      resVencimento.textContent = formatarDataBR(vencimento);
      updateResumeField('kvVencimento', formatarDataBR(vencimento));
    }
    
    if (resPagamento) {
      resPagamento.textContent = formatarDataBR(pagamentoRef);
      updateResumeField('kvPagamento', formatarDataBR(pagamentoRef));
    }
    
    if (resDias) {
      resDias.textContent = `${dias} dia(s)`;
      updateResumeField('kvDias', `${dias} dia(s)`, true);
    }
    
    if (resJuros) {
      resJuros.textContent = moedaBR(juros);
      updateResumeField('kvJuros', moedaBR(juros), true);
    }
    
    if (resMulta) {
      resMulta.textContent = moedaBR(multa);
      updateResumeField('kvMulta', moedaBR(multa), true);
    }
    
    if (resAtualizado) {
      resAtualizado.textContent = moedaBR(valorAtualizado);
      updateResumeField('kvAtualizado', moedaBR(valorAtualizado), true);
    }

    const payload = {
      cliente_id: cliente_id,
      valor_original: valorOriginal,
      valorOriginal: valorOriginal,
      vencimento: vencimento.slice(0, 10),
      pagamento: pagamento ? pagamento.slice(0, 10) : "",
      taxa,
      taxaPercent: normalizePercent(taxa),
      dias,
      juros: Number(juros.toFixed(2)),
      multa: Number(multa.toFixed(2)),
      valorAtualizado: Number(valorAtualizado),
      valor_atualizado: Number(valorAtualizado),
      status: pagamento ? "pago" : dias > 0 ? "pendente" : "em-dia",
    };

    // Update stepper to saving
    updateStepper(3);
    updateStatusBadge('calculando', 'Salvando no servidor...');

    try {
      const cobrancaSalva = await salvarCobrancaNoServidor(payload);

      const savedId =
        cobrancaSalva?.id ||
        cobrancaSalva?.data?.id ||
        cobrancaSalva?.cobranca?.id ||
        cobrancaSalva?.cobranca_id ||
        cobrancaSalva?.cobrancaId;

      if (!savedId) {
        console.warn("[ACERTIVE] Cobrança salva, mas sem ID detectável:", cobrancaSalva);
      } else {
        btnPdf.dataset.cobrancaId = String(savedId);
        localStorage.setItem("lastCobrancaId", String(savedId));
      }

      dadosCobranca = {
        id: savedId || null,
        cliente: cliente_nome,
        valorOriginal,
        vencimento,
        pagamentoRef,
        dias,
        taxa,
        juros: Number(juros.toFixed(2)),
        multa: Number(multa.toFixed(2)),
        valorAtualizado,
        ...cobrancaSalva,
      };

      updateStatusBadge('sucesso', 'Cobrança salva com sucesso!');
      btnPdf.disabled = false;
      showToast("Cobrança criada e salva com sucesso!", "success");

      // Highlight the PDF button
      setTimeout(() => {
        btnPdf.style.transform = 'scale(1.05)';
        setTimeout(() => {
          btnPdf.style.transform = 'scale(1)';
        }, 200);
      }, 500);

    } catch (err) {
      dadosCobranca = {
        cliente: cliente_nome,
        valorOriginal,
        vencimento,
        pagamentoRef,
        dias,
        taxa,
        juros: Number(juros.toFixed(2)),
        multa: Number(multa.toFixed(2)),
        valorAtualizado,
      };

      updateStatusBadge('erro', 'Falha ao salvar no servidor');
      btnPdf.disabled = true;
      updateStepper(2);
    }
  });
})();