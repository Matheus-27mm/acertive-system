// frontend/js/novo-cliente.js
(function () {
  // ===== Auth guard (mesmo padrão) =====
  const logado = localStorage.getItem('usuarioLogado');
  if (!logado) {
    window.location.href = '/login';
    return;
  }

  // ===== Toast =====
  function showToast(msg, type = 'success') {
    Toastify({
      text: msg,
      duration: 2800,
      close: true,
      gravity: 'top',
      position: 'right',
      backgroundColor: type === 'success' ? '#FFD700' : (type === 'warning' ? '#fd7e14' : '#dc3545')
    }).showToast();
  }

  // ===== Elements =====
  const btnLogout = document.getElementById('btnLogout');
  const form = document.getElementById('formCliente');
  const btnLimpar = document.getElementById('btnLimpar');

  const tipo = document.getElementById('tipo');
  const status = document.getElementById('status');
  const nome = document.getElementById('nome');
  const email = document.getElementById('email');
  const telefone = document.getElementById('telefone');
  const cpfCnpj = document.getElementById('cpfCnpj');
  const cpfCnpjLabel = document.getElementById('cpfCnpjLabel');
  const endereco = document.getElementById('endereco');
  const observacoes = document.getElementById('observacoes');

  const statusMsg = document.getElementById('statusMsg');
  const pTipo = document.getElementById('pTipo');
  const pStatus = document.getElementById('pStatus');
  const pNome = document.getElementById('pNome');
  const pEmail = document.getElementById('pEmail');
  const pTelefone = document.getElementById('pTelefone');
  const pCpfCnpj = document.getElementById('pCpfCnpj');
  const pEndereco = document.getElementById('pEndereco');
  const pObs = document.getElementById('pObs');

  // ===== Logout =====
  btnLogout.addEventListener('click', () => {
    localStorage.removeItem('usuarioLogado');
    window.location.href = '/login';
  });

  // ===== Helpers =====
  function onlyDigits(v) {
    return String(v || '').replace(/\D+/g, '');
  }

  function maskCpf(v) {
    const d = onlyDigits(v).slice(0, 11);
    const p1 = d.slice(0,3);
    const p2 = d.slice(3,6);
    const p3 = d.slice(6,9);
    const p4 = d.slice(9,11);
    let out = p1;
    if (p2) out += '.' + p2;
    if (p3) out += '.' + p3;
    if (p4) out += '-' + p4;
    return out;
  }

  function maskCnpj(v) {
    const d = onlyDigits(v).slice(0, 14);
    const p1 = d.slice(0,2);
    const p2 = d.slice(2,5);
    const p3 = d.slice(5,8);
    const p4 = d.slice(8,12);
    const p5 = d.slice(12,14);
    let out = p1;
    if (p2) out += '.' + p2;
    if (p3) out += '.' + p3;
    if (p4) out += '/' + p4;
    if (p5) out += '-' + p5;
    return out;
  }

  function maskTelefone(v) {
    const d = onlyDigits(v).slice(0, 11);
    const a = d.slice(0,2);
    const n1 = d.slice(2,7);
    const n2 = d.slice(7,11);
    if (!d) return '';
    if (d.length <= 10) {
      const p = d.slice(2,6);
      const s = d.slice(6,10);
      return a ? `(${a}) ${p}${s ? '-' + s : ''}` : d;
    }
    return a ? `(${a}) ${n1}${n2 ? '-' + n2 : ''}` : d;
  }

  function tipoLabel(v) {
    return v === 'pj' ? 'Pessoa Jurídica (PJ)' : 'Pessoa Física (PF)';
  }

  function statusLabel(v) {
    return v === 'inativo' ? 'Inativo' : 'Ativo';
  }

  function syncPreview() {
    pTipo.textContent = tipoLabel(tipo.value);
    pStatus.textContent = statusLabel(status.value);
    pNome.textContent = nome.value.trim() || '—';
    pEmail.textContent = email.value.trim() || '—';
    pTelefone.textContent = telefone.value.trim() || '—';
    pCpfCnpj.textContent = cpfCnpj.value.trim() || '—';
    pEndereco.textContent = endereco.value.trim() || '—';
    pObs.textContent = observacoes.value.trim() || '—';

    statusMsg.textContent = 'Pré-visualização pronta. Você pode salvar quando quiser.';
  }

  // ===== Tipo PF/PJ: troca label e máscara =====
  function applyTipoUI() {
    if (tipo.value === 'pj') {
      cpfCnpjLabel.textContent = 'CNPJ';
      cpfCnpj.placeholder = '00.000.000/0000-00';
      cpfCnpj.value = maskCnpj(cpfCnpj.value);
    } else {
      cpfCnpjLabel.textContent = 'CPF';
      cpfCnpj.placeholder = '000.000.000-00';
      cpfCnpj.value = maskCpf(cpfCnpj.value);
    }
    syncPreview();
  }

  tipo.addEventListener('change', applyTipoUI);

  // ===== Masks =====
  telefone.addEventListener('input', () => {
    telefone.value = maskTelefone(telefone.value);
    syncPreview();
  });

  cpfCnpj.addEventListener('input', () => {
    cpfCnpj.value = (tipo.value === 'pj') ? maskCnpj(cpfCnpj.value) : maskCpf(cpfCnpj.value);
    syncPreview();
  });

  // ===== Live preview inputs =====
  [status, nome, email, endereco, observacoes].forEach(el => {
    el.addEventListener('input', syncPreview);
    el.addEventListener('change', syncPreview);
  });

  // ===== Limpar =====
  btnLimpar.addEventListener('click', () => {
    form.reset();
    applyTipoUI();
    statusMsg.textContent = 'Preencha o formulário para visualizar o resumo.';
    showToast('Formulário limpo.', 'success');
  });

  // ===== Submit: salva no backend =====
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const payload = {
      type: tipo.value,                 // 'pf' | 'pj'
      status: status.value,             // 'ativo' | 'inativo'
      name: nome.value.trim(),
      email: email.value.trim(),
      phone: telefone.value.trim(),
      cpfCnpj: cpfCnpj.value.trim(),
      address: endereco.value.trim(),
      notes: observacoes.value.trim()
    };

    if (!payload.name || !payload.email) {
      showToast('Preencha Nome/Razão Social e E-mail.', 'error');
      return;
    }

    statusMsg.textContent = 'Salvando no servidor…';

    try {
      const resp = await fetch('/api/clientes/novo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const json = await resp.json();

      if (!resp.ok || !json.success) {
        throw new Error(json.error || json.message || 'Falha ao salvar cliente');
      }

      statusMsg.textContent = 'Cliente salvo com sucesso.';
      showToast('Cliente cadastrado.', 'success');

      // opcional: voltar para a listagem
      // window.location.href = '/clientes-ativos';

    } catch (err) {
      statusMsg.textContent = 'Falha ao salvar. Verifique o servidor e tente novamente.';
      showToast('Erro ao salvar: ' + err.message, 'error');
    }
  });

  // init
  applyTipoUI();
  syncPreview();
})();
