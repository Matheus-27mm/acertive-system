// frontend/js/login.js
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
      backgroundColor: type === "success" ? "#FFD700" : "#dc3545",
    }).showToast();
  }

  const form = document.getElementById("loginForm");
  const emailInput = document.getElementById("email");
  const senhaInput = document.getElementById("senha");

  if (!form || !emailInput || !senhaInput) return;

  // limpa sessão antiga
  localStorage.removeItem("acertive_token");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = emailInput.value.trim();
    const senha = senhaInput.value.trim();

    if (!email || !senha) {
      showToast("Informe e-mail e senha.", "error");
      return;
    }

    try {
      const resp = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, senha }),
      });

      const data = await resp.json();

      if (!resp.ok || !data.success) {
        showToast(data.message || "Falha no login.", "error");
        return;
      }

      localStorage.setItem("acertive_token", data.token);
      showToast("Login realizado com sucesso!", "success");

      setTimeout(() => {
        window.location.href = LOGIN_REDIRECT;
      }, 400);
    } catch (err) {
      showToast("Erro de conexão com o servidor.", "error");
    }
  });
})();
