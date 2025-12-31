// frontend/js/login.js — versão melhorada com validações e animações
(function () {
  const LOGIN_REDIRECT = "/dashboard";

  function showToast(msg, type = "success") {
    if (typeof Toastify === "undefined") {
      alert(msg);
      return;
    }
    Toastify({
      text: msg,
      duration: 3000,
      close: true,
      gravity: "top",
      position: "right",
      backgroundColor: type === "success" ? "#4CAF50" : "#F44336",
      stopOnFocus: true,
    }).showToast();
  }

  function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  function validateField(field, isValid, errorMsg) {
    if (!field) return isValid;
    
    if (!isValid) {
      field.classList.add('error');
      field.classList.remove('filled');
      const errorElement = field.querySelector('.error-message');
      if (errorElement && errorMsg) {
        errorElement.textContent = errorMsg;
      }
      return false;
    } else {
      field.classList.remove('error');
      return true;
    }
  }

  const form = document.getElementById("loginForm");
  const emailInput = document.getElementById("email");
  const senhaInput = document.getElementById("senha");
  const card = document.querySelector(".card");
  const btn = form?.querySelector(".btn");

  if (!form || !emailInput || !senhaInput) return;

  // Clear error on input
  emailInput.addEventListener('input', () => {
    const field = emailInput.closest('.field');
    if (field) {
      field.classList.remove('error');
      if (emailInput.value.trim()) {
        field.classList.add('filled');
      } else {
        field.classList.remove('filled');
      }
    }
  });

  senhaInput.addEventListener('input', () => {
    const field = senhaInput.closest('.field');
    if (field) {
      field.classList.remove('error');
      if (senhaInput.value.trim()) {
        field.classList.add('filled');
      } else {
        field.classList.remove('filled');
      }
    }
  });

  // Enviar login
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = emailInput.value.trim();
    const senha = senhaInput.value.trim();

    // Validations
    let isValid = true;

    const emailField = emailInput.closest('.field');
    const senhaField = senhaInput.closest('.field');

    if (!email) {
      isValid = validateField(emailField, false, "E-mail é obrigatório") && isValid;
    } else if (!validateEmail(email)) {
      isValid = validateField(emailField, false, "E-mail inválido") && isValid;
    } else {
      validateField(emailField, true);
    }

    if (!senha) {
      isValid = validateField(senhaField, false, "Senha é obrigatória") && isValid;
    } else if (senha.length < 3) {
      isValid = validateField(senhaField, false, "Senha muito curta") && isValid;
    } else {
      validateField(senhaField, true);
    }

    if (!isValid) {
      showToast("❌ Corrija os erros no formulário.", "error");
      return;
    }

    // Loading state
    if (btn) {
      btn.disabled = true;
      btn.classList.add("loading");
      btn.innerHTML = '<i class="fa-solid fa-circle-notch"></i> Entrando...';
    }

    try {
      const resp = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, senha }),
      });

      const data = await resp.json();

      if (!resp.ok || !data.success) {
        // Error feedback
        if (resp.status === 401 || resp.status === 403) {
          validateField(emailField, false, "Credenciais inválidas");
          validateField(senhaField, false, "Credenciais inválidas");
        }
        
        showToast(data.message || "❌ Falha no login. Verifique suas credenciais.", "error");
        
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("loading");
          btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Entrar';
        }
        return;
      }

      // Success animation
      if (card) {
        card.classList.add('success');
      }

      // Salva token no localStorage
      localStorage.setItem("token", data.token);
      localStorage.setItem(
        "usuarioLogado",
        JSON.stringify({ nome: data.user.nome, email: data.user.email })
      );
      localStorage.setItem("isLoggedIn", "true");

      showToast("✅ Login realizado com sucesso!", "success");

      // Keep loading state and redirect
      if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Sucesso!';
      }

      setTimeout(() => {
        window.location.href = LOGIN_REDIRECT;
      }, 600);

    } catch (err) {
      console.error('[Login] Erro:', err);
      showToast("❌ Erro de conexão com o servidor. Tente novamente.", "error");
      
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Entrar';
      }
    }
  });

  // Check if already logged in
  const token = localStorage.getItem("token");
  const isLoggedIn = localStorage.getItem("isLoggedIn");
  
  if (token && isLoggedIn === "true") {
    // Verify token is still valid
    fetch("/api/verify-token", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    })
    .then(resp => {
      if (resp.ok) {
        // Already logged in, redirect
        window.location.href = LOGIN_REDIRECT;
      }
    })
    .catch(() => {
      // Token invalid, clear storage
      localStorage.removeItem("token");
      localStorage.removeItem("usuarioLogado");
      localStorage.removeItem("isLoggedIn");
    });
  }
})();