// frontend/js/novo-cliente.js — versão melhorada com validações visuais e feedback
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
    localStorage.removeItem("usuarioLogado");
    localStorage.removeItem("usuariologado");
    window.location.href = "/login";
  }

  // ===== Field Validation =====
  function validateField(input, condition, errorMsg) {
    const field = input.closest('.field');
    if (!field) return condition;
    
    if (!condition) {
      field.classList.add('error');
      field.classList.remove('filled');
      const errorElement = field.querySelector('.error-message');
      if (errorElement && errorMsg) {
        errorElement.textContent = errorMsg;
      }
      return false;
    } else {
      field.classList.remove('error');
      if (input.value.trim()) {
        field.classList.add('filled');
      }
      return true;
    }
  }

  function clearFieldError(input) {
    const field = input.closest('.field');
    if (field) {
      field.classList.remove('error');
      if (input.value.trim()) {
        field.classList.add('filled');
      } else {
        field.classList.remove('filled');
      }
    }
  }

  function validateEmail(email) {
    if (!email) return true; // optional field
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  // ===== Elementos =====
  const form = document.getElementById("formNovoCliente");
  const inputNome = document.getElementById("cliente_nome_input");
  const inputEmail = document.getElementById("cliente_email_input");
  const inputTelefone = document.getElementById("cliente_telefone_input");
  const inputCpfCnpj = document.getElementById("cliente_cpf_cnpj_input");
  const inputEndereco = document.getElementById("endereco");
  const inputObs = document.getElementById("observacoes");
  const inputTipo = document.getElementById("tipo");
  const inputStatus = document.getElementById("status");

  const btnSalvar = document.getElementById("btnSalvar");
  const successMessage = document.getElementById("successMessage");

  // ===== Estado local =====
  let submitting = false;

  // ===== Headers =====
  function authHeaders(extra = {}) {
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

  // ===== Add real-time validation =====
  const inputs = form ? form.querySelectorAll('input, select, textarea') : [];
  inputs.forEach(input => {
    input.addEventListener('blur', () => {
      if (input.hasAttribute('required') && !input.value.trim()) {
        validateField(input, false, 'Campo obrigatório');
      } else if (input.type === 'email' && input.value.trim()) {
        validateField(input, validateEmail(input.value), 'E-mail inválido');
      }
    });

    input.addEventListener('input', () => {
      clearFieldError(input);
    });

    input.addEventListener('change', () => {
      clearFieldError(input);
    });
  });

  // ===== Form Submit Handler =====
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submitting) return;

      const nome = (inputNome?.value || "").trim();
      const email = (inputEmail?.value || "").trim();
      const telefone = (inputTelefone?.value || "").trim();
      const cpf_cnpj = (inputCpfCnpj?.value || "").trim();
      const endereco = (inputEndereco?.value || "").trim();
      const observacoes = (inputObs?.value || "").trim();
      const tipo = inputTipo?.value || "pf";
      const status = inputStatus?.value || "ativo";

      // Validations
      let isValid = true;

      isValid = validateField(inputNome, nome !== "", "Nome é obrigatório") && isValid;
      
      if (email) {
        isValid = validateField(inputEmail, validateEmail(email), "E-mail inválido") && isValid;
      }

      if (!isValid) {
        showToast("❌ Corrija os erros no formulário antes de salvar.", "error");
        return;
      }

      submitting = true;
      if (btnSalvar) {
        btnSalvar.disabled = true;
        btnSalvar.classList.add('loading');
        btnSalvar.innerHTML = '<i class="fa-solid fa-spinner"></i> Salvando...';
      }

      try {
        const payload = {
          nome,
          email: email || null,
          telefone: telefone || null,
          cpf_cnpj: cpf_cnpj || null,
          endereco: endereco || null,
          observacoes: observacoes || null,
          tipo,
          status,
        };

        await apiCreateCliente(payload);
        
        // Show success message
        if (successMessage) {
          successMessage.classList.add('show');
          setTimeout(() => {
            successMessage.classList.remove('show');
          }, 3000);
        }

        showToast("✅ Cliente cadastrado com sucesso!", "success");
        
        // Reset form with animation
        setTimeout(() => {
          form.reset();
          
          // Clear all field states
          document.querySelectorAll('.field').forEach(field => {
            field.classList.remove('filled', 'error');
          });
          
          // Clear all kvItem states
          document.querySelectorAll('.kvItem').forEach(item => {
            item.classList.remove('filled');
          });
          
          // Update preview
          const updateEvent = new Event('input');
          form.dispatchEvent(updateEvent);
        }, 1000);

        // Reload clients list if function exists
        if (typeof window.carregarClientes === 'function') {
          await window.carregarClientes();
        }

        // Dispatch event for dashboard update
        try {
          window.dispatchEvent(new CustomEvent('clientes:atualizados', { 
            detail: { action: 'created' } 
          }));
        } catch (e) {
          console.warn('dispatch event failed', e);
        }

      } catch (err) {
        console.error("[novo-cliente] erro ao criar:", err);
        showToast("❌ Erro ao criar cliente: " + (err.message || err), "error");
      } finally {
        submitting = false;
        if (btnSalvar) {
          btnSalvar.disabled = false;
          btnSalvar.classList.remove('loading');
          btnSalvar.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar Cliente';
        }
      }
    });
  }

  // ===== Logout =====
  const btnLogout = document.getElementById("btnLogout");
  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("token");
      localStorage.removeItem("usuarioLogado");
      localStorage.removeItem("isLoggedIn");
      window.location.href = "/login";
    });
  }

  // ===== Phone Mask (optional) =====
  if (inputTelefone) {
    inputTelefone.addEventListener('input', (e) => {
      let value = e.target.value.replace(/\D/g, '');
      
      if (value.length <= 11) {
        if (value.length > 10) {
          // (99) 99999-9999
          value = value.replace(/^(\d{2})(\d{5})(\d{4}).*/, '($1) $2-$3');
        } else if (value.length > 6) {
          // (99) 9999-9999
          value = value.replace(/^(\d{2})(\d{4})(\d{0,4}).*/, '($1) $2-$3');
        } else if (value.length > 2) {
          // (99) 9999
          value = value.replace(/^(\d{2})(\d{0,5})/, '($1) $2');
        } else {
          // (99
          value = value.replace(/^(\d*)/, '($1');
        }
      }
      
      e.target.value = value;
    });
  }

  // ===== CPF/CNPJ Mask (optional) =====
  if (inputCpfCnpj) {
    inputCpfCnpj.addEventListener('input', (e) => {
      let value = e.target.value.replace(/\D/g, '');
      
      if (value.length <= 11) {
        // CPF: 000.000.000-00
        value = value.replace(/(\d{3})(\d)/, '$1.$2');
        value = value.replace(/(\d{3})(\d)/, '$1.$2');
        value = value.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
      } else {
        // CNPJ: 00.000.000/0000-00
        value = value.replace(/^(\d{2})(\d)/, '$1.$2');
        value = value.replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3');
        value = value.replace(/\.(\d{3})(\d)/, '.$1/$2');
        value = value.replace(/(\d{4})(\d)/, '$1-$2');
      }
      
      e.target.value = value;
    });
  }

  // ===== Expose carregarClientes (if needed) =====
  if (typeof window.carregarClientes !== 'function') {
    window.carregarClientes = async function() {
      console.log('[novo-cliente] carregarClientes called but not implemented');
    };
  }

  // ===== Initial state =====
  document.addEventListener("DOMContentLoaded", () => {
    // Set initial states
    if (inputTipo) inputTipo.closest('.field')?.classList.add('filled');
    if (inputStatus) inputStatus.closest('.field')?.classList.add('filled');
  });
})();