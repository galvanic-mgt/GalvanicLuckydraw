// ===== LOGIN (local only) =====
(function initLocalLogin(){
  const USERS_KEY = 'ldraw-users-v1';       // local storage key for users
  const AUTH_KEY  = 'ldraw-auth-v1';        // who is logged in

  // helpers
  const getUsers = () => {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; }
    catch { return []; }
  };
  const saveUsers = (arr) => localStorage.setItem(USERS_KEY, JSON.stringify(arr));
  const setAuth  = (u)   => localStorage.setItem(AUTH_KEY, JSON.stringify(u || null));
  const getAuth  = () => {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; }
  };

  // ensure a default admin/admin if none
  (function ensureDefaultAdmin(){
    let users = getUsers();
    if (!Array.isArray(users) || users.length === 0 || !users.some(u => u.username === 'admin')) {
      users = users.filter(Boolean);
      users.push({ username:'admin', password:'admin', role:'admin', events:[] });
      saveUsers(users);
    }
  })();

  // DOM
  const gate   = document.getElementById('loginGate');
  const form   = document.getElementById('loginForm');
  const uEl    = document.getElementById('loginUser');
  const pEl    = document.getElementById('loginPass');
  const btn    = document.getElementById('btnLogin');

  // guard: if any of these are missing, do nothing (won't break the app)
  if (!gate || !form || !uEl || !pEl || !btn) return;

  function applyRoleUI(role){
    // role === 'client' can only see 名單 (pageRoster). Hide other nav items.
    const navItems = document.querySelectorAll('#cmsNav .nav-item');
    navItems.forEach(item => {
      const target = item.getAttribute('data-target');
      if (role === 'client') {
        const visible = (target === 'pageRoster');  // only 名單
        item.style.display = visible ? '' : 'none';
        if (!visible) {
          const sec = document.getElementById(target);
          if (sec) sec.style.display = 'none';
        }
      } else {
        item.style.display = '';
      }
    });

    if (role === 'client') {
      document.getElementById('cmsView')?.setAttribute('style','');
      const rosterBtn = document.querySelector('#cmsNav .nav-item[data-target="pageRoster"]');
      if (rosterBtn) {
        document.querySelectorAll('#cmsNav .nav-item').forEach(b => b.classList.remove('active'));
        rosterBtn.classList.add('active');
        document.querySelectorAll('.subpage').forEach(s => s.style.display = 'none');
        document.getElementById('pageRoster').style.display = 'block';
      }
    }
  }

  function login(username, password){
    const users = getUsers();
    const u = users.find(x => x && x.username === username && x.password === password);
    if (!u) return false;
    setAuth({ username:u.username, role:u.role, events:u.events || [] });
    applyRoleUI(u.role || 'admin');
    gate.classList.remove('show');
    gate.style.display = 'none';
    if (typeof renderAll === 'function') renderAll();
    return true;
  }

  // auto-restore session
  (function restoreSession(){
    const me = getAuth();
    if (me && me.username) {
      applyRoleUI(me.role || 'admin');
      gate.classList.remove('show');
      gate.style.display = 'none';
      return;
    }
    gate.classList.add('show');
    gate.style.display = 'flex';
  })();

  // handle submit (click or Enter)
  form.addEventListener('submit', (e)=>{
    e.preventDefault();
    const ok = login((uEl.value||'').trim(), (pEl.value||'').trim());
    if (!ok) {
      btn.disabled = false;
      btn.textContent = '登入失敗，重試';
      setTimeout(()=> btn.textContent = '登入', 1200);
    }
  });
})();
