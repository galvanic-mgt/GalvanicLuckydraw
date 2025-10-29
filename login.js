// ===== LOGIN (Firebase-backed with local fallback) =====
// REST wrapper (match app.js base)
const FB = {
  base: 'https://luckydrawpolls-default-rtdb.asia-southeast1.firebasedatabase.app',
  get:   (p)   => fetch(`${FB.base}${p}.json`).then(r=>r.json()),
  put:   (p,b) => fetch(`${FB.base}${p}.json`, {method:'PUT',   body:JSON.stringify(b)}).then(r=>r.json()),
  patch: (p,b) => fetch(`${FB.base}${p}.json`, {method:'PATCH', body:JSON.stringify(b)}).then(r=>r.json())
};

(function initLogin(){
  // Local fallback keys
  const USERS_KEY = 'ldraw-users-v1';
  const AUTH_KEY  = 'ldraw-auth-v1';

  // Helpers (local)
  const getLocalUsers = () => {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; }
    catch { return []; }
  };
  const saveLocalUsers = (arr) => localStorage.setItem(USERS_KEY, JSON.stringify(arr));
  const setAuth  = (u)   => localStorage.setItem(AUTH_KEY, JSON.stringify(u || null));
  const getAuth  = () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; } };

  const hasFirebase = true; // we will always use REST RTDB
  const usersPath   = '/users'; // { id, email, password, role, events?[] }

  // Ensure a default admin if no users exist (FB or local)
  async function ensureDefaultAdmin(){
  const map = await FB.get(usersPath) || {};
  const any = Object.values(map).some(u => u && u.email);
  if (!any) {
    const id = btoa('admin').replace(/=+$/,'');
    await FB.put(`${usersPath}/${id}`, {
      id, email:'admin', password:'admin', role:'super', events:[]
    });
  }
}


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

  // Hide "+ 新活動" form on the left sidebar for clients, but keep 活動清單 visible
  const sbForm = document.querySelector('.sidebar-form');
  if (sbForm) sbForm.style.display = (role === 'client') ? 'none' : '';

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



  function restrictClientEvents(){
  const me = getAuth && getAuth();
  const allowed = (me && Array.isArray(me.events)) ? me.events : [];
  const list = document.querySelector('.event-list'); // container
  const items = document.querySelectorAll('.event-item'); // each event row

  // Hide any event the client is not allowed to see
  items.forEach(el=>{
    const id = el.getAttribute('data-id') || el.dataset.id || el.dataset.eid || '';
    el.style.display = (!allowed.length || allowed.includes(id)) ? '' : 'none';
  });

  // If the current selection is hidden, switch to first allowed event (if any)
  const active = document.querySelector('.event-item.active');
  if (active && active.style.display === 'none') {
    const firstAllowed = Array.from(items).find(el => el.style.display !== 'none');
    if (firstAllowed) firstAllowed.click();
  }

  // Prevent clicks on disallowed events
  list?.addEventListener('click', (e)=>{
    const el = e.target.closest('.event-item');
    if (!el) return;
    const id = el.getAttribute('data-id') || el.dataset.id || el.dataset.eid || '';
    if (allowed.length && !allowed.includes(id)) {
      e.stopPropagation();
      e.preventDefault();
      alert('此帳號無權限訪問該活動');
    }
  }, { once:true });

  // Re-apply if the list is dynamically rebuilt later
  const mo = new MutationObserver(()=> restrictClientEvents());
  if (list) mo.observe(list, { childList:true, subtree:true });
}

  // Credentials check (FB or local)
  async function checkLogin(user, pass){
  // REST: pull all users then check
  const map = await FB.get(usersPath) || {};
  const all = Object.values(map);
  const found = all.find(u => (u.email || '') === user && (u.password || '') === pass);
  if (!found) return null;
  return { username: found.email, role: found.role || 'client', events: found.events || [], _id: found.id };
}

  // DOM
  const gate   = document.getElementById('loginGate');
  const form   = document.getElementById('loginForm');
  const uEl    = document.getElementById('loginUser');
  const pEl    = document.getElementById('loginPass');
  const btn    = document.getElementById('btnLogin');
  const btnLogout = document.getElementById('btnLogout');


  // If page has no login gate (e.g. public page), bail
  if (!gate || !form || !uEl || !pEl || !btn) return;

  // Boot
  (async function boot(){
    await ensureDefaultAdmin();

    // restore session if any
    const me = getAuth();
    if (me && me.username) {
      applyRoleUI(me.role || 'super');
      if ((me.role || 'super') === 'client') restrictClientEvents();
      gate.classList.remove('show');
      gate.style.display = 'none';
      return;
    }

    gate.classList.add('show');
    gate.style.display = 'flex';
  })();

    if (btnLogout) {
      btnLogout.addEventListener('click', () => {
        // clear local session
        try { localStorage.setItem('ldraw-auth-v1', JSON.stringify(null)); } catch {}

        // show the login gate
        gate.classList.add('show');
        gate.style.display = 'flex';

        // hide CMS subpages until login again
        document.querySelectorAll('.subpage').forEach(s => s.style.display = 'none');
        document.querySelectorAll('#cmsNav .nav-item').forEach(b => b.classList.remove('active'));
      });
    }

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    btn.disabled = true; btn.textContent = '登入中…';
    const cred = await checkLogin((uEl.value||'').trim(), (pEl.value||'').trim());
    if (!cred) {
      btn.disabled = false;
      btn.textContent = '登入失敗，重試';
      setTimeout(()=> btn.textContent = '登入', 1200);
      return;
    }
    setAuth(cred);
    applyRoleUI(cred.role || 'super');
    if ((cred.role || 'super') === 'client') restrictClientEvents();
    gate.classList.remove('show');
    gate.style.display = 'none';
    if (typeof renderAll === 'function') renderAll();
  });
})();
// ===== END LOGIN =====