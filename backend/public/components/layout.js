/**
 * ACERTIVE — layout.js
 * Motor global da sidebar.
 *
 * USO em qualquer página:
 *   <div id="sidebar-mount"></div>
 *   <script src="/components/layout.js"></script>
 *
 * Garante:
 *  - Sidebar idêntica em todas as telas
 *  - Item ativo destacado automaticamente
 *  - Suri sempre visível com ponto de status
 *  - Dados do usuário logado no rodapé
 *  - Badge de fila atualizado
 *  - Comportamento mobile (toggle)
 *  - CSS injetado automaticamente (não precisa de link extra)
 */

(function () {
  'use strict';

  /* ── CONSTANTES ──────────────────────────────────────────── */
  const SIDEBAR_FILE = '/components/sidebar.html';
  const API          = window.location.origin;
  const TOKEN_KEY    = 'token';

  /* ── UTILITÁRIOS ─────────────────────────────────────────── */
  function H() {
    return {
      'Authorization': 'Bearer ' + (localStorage.getItem(TOKEN_KEY) || ''),
      'Content-Type': 'application/json'
    };
  }

  function getToken() { return localStorage.getItem(TOKEN_KEY); }

  /* ── CSS DA SIDEBAR (injetado uma única vez) ─────────────── */
  function injectCSS() {
    if (document.getElementById('acertive-sidebar-css')) return;
    const style = document.createElement('style');
    style.id = 'acertive-sidebar-css';
    style.textContent = `
      /* ── VARIÁVEIS (se a página não as tiver, herda estas) ── */
      :root {
        --sb-gold:  #c9a84c;
        --sb-gd:    #7a5e20;
        --sb-g05:   rgba(201,168,76,.05);
        --sb-g12:   rgba(201,168,76,.12);
        --sb-g20:   rgba(201,168,76,.20);
        --sb-green: #34c98a;
        --sb-red:   #e55555;
        --sb-wpp:   #25d366;
        --sb-white: #f0ede8;
        --sb-text:  #b8b4ae;
        --sb-t2:    #706c66;
        --sb-t3:    #3a3630;
        --sb-br:    rgba(255,255,255,.06);
        --sb-brh:   rgba(255,255,255,.10);
        --sb-brgold:rgba(201,168,76,.12);
        --sb-brgolh:rgba(201,168,76,.22);
        --sb-bg:    #000;
        --sb-s1:    #0a0a0a;
        --sb-s2:    #111;
        --sb-sw:    244px;
        --sb-r:     10px;
        --sb-rs:    7px;
      }

      /* ── SIDEBAR ── */
      .sidebar {
        position: fixed; left: 0; top: 0;
        width: var(--sb-sw); height: 100vh;
        background: var(--sb-s1);
        border-right: 1px solid var(--sb-br);
        display: flex; flex-direction: column;
        z-index: 200;
        transition: transform .3s ease;
      }

      .sb-top {
        padding: 18px 16px 14px;
        border-bottom: 1px solid var(--sb-br);
        display: flex; align-items: center; gap: 10px;
      }

      .sb-logo {
        height: 28px; max-width: 120px;
        object-fit: contain;
        filter: drop-shadow(0 2px 8px rgba(201,168,76,.25));
        mix-blend-mode: screen;
      }

      .sb-badge {
        margin-left: auto;
        font-size: 9px; font-weight: 700; letter-spacing: .8px;
        color: var(--sb-t2);
        border: 1px solid var(--sb-br);
        padding: 2px 8px; border-radius: 20px;
        font-family: 'DM Sans', sans-serif;
      }

      .sb-nav {
        flex: 1; overflow-y: auto;
        padding: 14px 10px;
      }

      .sb-nav::-webkit-scrollbar { width: 3px; }
      .sb-nav::-webkit-scrollbar-thumb {
        background: var(--sb-g20); border-radius: 3px;
      }

      .sb-grp { margin-bottom: 20px; }

      .sb-gl {
        font-size: 9px; font-weight: 600;
        letter-spacing: 1.8px; text-transform: uppercase;
        color: var(--sb-t3);
        padding: 0 10px; margin-bottom: 6px;
        font-family: 'DM Sans', sans-serif;
      }

      /* ── NAV LINK ── */
      .nl {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px;
        border-radius: var(--sb-rs);
        color: var(--sb-t2);
        font-size: 12.5px; font-weight: 400;
        text-decoration: none;
        transition: all .2s;
        margin-bottom: 1px;
        position: relative;
        border: 1px solid transparent;
        font-family: 'DM Sans', sans-serif;
      }

      .nl:hover {
        background: rgba(255,255,255,.03);
        color: var(--sb-white);
      }

      .nl.active {
        background: var(--sb-g05);
        color: var(--sb-white);
        border-color: var(--sb-brgold);
      }

      .nl.active::before {
        content: '';
        position: absolute; left: -1px; top: 50%;
        transform: translateY(-50%);
        width: 2px; height: 14px;
        border-radius: 0 2px 2px 0;
        background: var(--sb-gold);
      }

      .nl i {
        width: 14px; text-align: center;
        font-size: 11px; flex-shrink: 0;
        opacity: .6;
      }

      .nl.active i { opacity: 1; }

      /* ── BADGE NUMÉRICO (fila) ── */
      .nb {
        margin-left: auto;
        background: var(--sb-red); color: #fff;
        font-size: 9px; font-weight: 700;
        padding: 1px 6px; border-radius: 20px;
        font-family: 'DM Sans', sans-serif;
      }

      /* ── SURI — destaque verde ── */
      .sb-suri i { color: var(--sb-wpp) !important; opacity: 1 !important; }

      .sb-suri.active {
        background: rgba(37,211,102,.06) !important;
        border-color: rgba(37,211,102,.2) !important;
      }

      .sb-suri.active::before { background: var(--sb-wpp) !important; }

      /* Ponto de status pulsante */
      .sb-wpp-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: var(--sb-wpp);
        margin-left: auto; flex-shrink: 0;
        display: none;        /* revelado ao confirmar conexão */
        animation: sb-lp 2s ease-in-out infinite;
      }

      @keyframes sb-lp {
        0%,100% { box-shadow: 0 0 0 0 rgba(37,211,102,.4); }
        50%      { box-shadow: 0 0 0 3px rgba(37,211,102,0); }
      }

      /* ── RODAPÉ: USUÁRIO ── */
      .sb-foot {
        padding: 12px;
        border-top: 1px solid var(--sb-br);
        flex-shrink: 0;
      }

      .sb-user {
        display: flex; align-items: center; gap: 9px;
        padding: 10px 12px;
        border-radius: var(--sb-r);
        border: 1px solid var(--sb-br);
        transition: border-color .2s;
      }

      .sb-user:hover { border-color: var(--sb-brh); }

      .sb-av {
        width: 30px; height: 30px;
        border-radius: 7px; flex-shrink: 0;
        background: linear-gradient(135deg, var(--sb-gold), var(--sb-gd));
        display: flex; align-items: center; justify-content: center;
        font-weight: 800; font-size: 12px; color: #000;
        font-family: 'DM Sans', sans-serif;
      }

      .sb-un {
        font-size: 12px; font-weight: 500;
        color: var(--sb-white);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-family: 'DM Sans', sans-serif;
      }

      .sb-ur {
        font-size: 10px;
        color: var(--sb-t2);
        font-family: 'DM Sans', sans-serif;
      }

      .sb-out {
        margin-left: auto; flex-shrink: 0;
        color: var(--sb-t3);
        font-size: 12px; padding: 5px;
        border-radius: 5px;
        transition: all .18s;
        cursor: pointer;
        background: none; border: none;
      }

      .sb-out:hover {
        background: rgba(229,85,85,.08);
        color: var(--sb-red);
      }

      /* ── OVERLAY MOBILE ── */
      .sb-ov {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0,0,0,.6);
        z-index: 199;
      }

      .sb-ov.on { display: block; }

      /* ── BOTÃO MOBILE (injetado via JS) ── */
      #sb-mob-btn {
        display: none;
        position: fixed; top: 14px; left: 14px;
        z-index: 300;
        width: 38px; height: 38px;
        border-radius: var(--sb-rs);
        background: linear-gradient(135deg, var(--sb-gold), var(--sb-gd));
        color: #000; font-size: 14px;
        border: none; cursor: pointer;
        align-items: center; justify-content: center;
      }

      /* ── RESPONSIVO ── */
      @media (max-width: 900px) {
        .sidebar { transform: translateX(-100%); }
        .sidebar.open { transform: translateX(0); }
        #sb-mob-btn { display: flex; }

        /* Páginas devem ter a classe .has-sidebar para receber margin-left correto */
        body.has-sidebar .layout,
        body.has-sidebar .main-content,
        body.has-sidebar > .layout {
          margin-left: 0 !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  /* ── DETECTAR PÁGINA ATIVA ───────────────────────────────── */
  function setActiveLink() {
    const path = window.location.pathname; // ex: /devedores.html
    const page = path.split('/').pop().replace('.html', ''); // "devedores"

    document.querySelectorAll('.nl[data-page]').forEach(link => {
      link.classList.remove('active');
      if (link.dataset.page === page) {
        link.classList.add('active');
      }
    });
  }

  /* ── CARREGAR DADOS DO USUÁRIO ───────────────────────────── */
  async function loadUser() {
    if (!getToken()) return;
    try {
      const r = await fetch(API + '/api/usuarios/me', { headers: H() });
      const d = await r.json();
      if (!d.success) return;
      const u   = d.data || d;
      const nome = u.nome || 'Usuário';
      const av   = nome[0].toUpperCase();
      const role = u.perfil || 'admin';

      // ── IDs da sidebar injetada pelo layout.js ──
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };

      set('sb-user-av',   av);
      set('sb-user-nome', nome);
      set('sb-user-role', role);

      // ── IDs legados (páginas ainda não migradas) ──
      // dashboard / operacao / outras páginas com <aside> próprio
      set('userName',    nome);   // id antigo mais comum
      set('userRole',    role);
      set('userAvatar',  av);     // configuracoes, suri, etc.
      set('userAv',      av);     // dashboard, fila
      set('uNome',       nome);   // credores, disparos, importacao, relatorios
      set('uAv',         av);
      set('uRole',       role);

    } catch (e) { /* silencioso */ }
  }

  /* ── BADGE DA FILA ───────────────────────────────────────── */
  async function loadFilaBadge() {
    if (!getToken()) return;
    // Rotas possíveis dependendo da versão do backend
    const rotas = [
      '/api/acionamentos/fila/devedores?limit=1',
      '/api/acionamentos?limit=1',
      '/api/cobrancas/estatisticas',
    ];
    for (const rota of rotas) {
      try {
        const r = await fetch(API + rota, { headers: H() });
        if (!r.ok) continue; // tenta a próxima se 404
        const d = await r.json();
        const total = d.total || d.count || d.data?.total || 0;
        const badgeEl = document.getElementById('sb-fila-badge');
        if (badgeEl && total > 0) {
          badgeEl.textContent = total > 99 ? '99+' : total;
          badgeEl.style.display = '';
        }
        return; // achou — para aqui
      } catch (e) { /* tenta próxima */ }
    }
  }

  /* ── STATUS DA SURI (ponto verde) ───────────────────────── */
  async function loadSuriStatus() {
    if (!getToken()) return;
    try {
      const r = await fetch(API + '/api/suri/status', { headers: H() });
      const d = await r.json();
      const dot = document.getElementById('sb-suri-dot');
      if (dot && d.success && d.data?.conectado) {
        dot.style.display = 'block';
      }
    } catch (e) { /* silencioso */ }
  }

  /* ── COMPORTAMENTO MOBILE ────────────────────────────────── */
  function setupMobile() {
    // Injeta botão hamburguer se não existir
    if (!document.getElementById('sb-mob-btn')) {
      const btn = document.createElement('button');
      btn.id = 'sb-mob-btn';
      btn.innerHTML = '<i class="fas fa-bars"></i>';
      btn.addEventListener('click', toggleSb);
      document.body.insertBefore(btn, document.body.firstChild);
    }
  }

  function toggleSb() {
    const sb  = document.querySelector('.sidebar');
    const ov  = document.getElementById('sbOv');
    const btn = document.getElementById('sb-mob-btn');
    if (!sb) return;
    const open = sb.classList.toggle('open');
    if (ov)  ov.classList.toggle('on', open);
    if (btn) btn.querySelector('i').className = open ? 'fas fa-times' : 'fas fa-bars';
  }

  /* ── LOGOUT GLOBAL ───────────────────────────────────────── */
  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = '/login.html';
  }

  /* ── EXPOR FUNÇÕES GLOBAIS ───────────────────────────────── */
  window.__acertiveToggleSb = toggleSb;
  window.__acertiveLogout   = logout;

  /* ── INJETAR SIDEBAR ─────────────────────────────────────── */
  function mount() {
    const mountPoint = document.getElementById('sidebar-mount');
    if (!mountPoint) {
      console.warn('[ACERTIVE layout.js] Elemento #sidebar-mount não encontrado.');
      return;
    }

    injectCSS();

    fetch(SIDEBAR_FILE)
      .then(res => {
        if (!res.ok) throw new Error('sidebar.html não encontrada em ' + SIDEBAR_FILE);
        return res.text();
      })
      .then(html => {
        mountPoint.outerHTML = html; // substitui o <div> pelo <aside> real
        setActiveLink();
        setupMobile();
        loadUser();
        loadFilaBadge();
        loadSuriStatus();
        document.body.classList.add('has-sidebar');
      })
      .catch(err => {
        console.error('[ACERTIVE layout.js]', err.message);
      });
  }

  /* ── AGUARDAR DOM ────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

})();