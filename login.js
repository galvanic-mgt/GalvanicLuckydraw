// ===== LOGIN (Firebase-backed with local fallback) =====
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

  const hasFirebase = !!(window.rtdb && window.firebase);
  const usersPath   = '/users'; // { id, email, password, role, events?[] }

  // Ensure a default admin if no users exist (FB or local)
  async function ensureDefaultAdmin(){
    if (hasFirebase) {
      const snap = await rtdb.ref(usersPath).once('value');
      const obj = snap.val() || {};
      const any = Object.values(obj).some(u => u && u.email);
      if (!any) {
        const id = rtdb.ref(usersPath).push().key;
        await rtdb.ref(`${usersPath}/${id}`).set({
          id, email:'admin', password:'admin', role:'super', events:[]
        });
      }
    } else {
      let users = getLocalUsers();
      if (!Array.isArray(users) || users.length === 0 || !users.some(u => u && u.username === 'admin')) {
        users = users.filter(Boolean);
        users.push({ username:'admin', password:'admin', role:'super', events:[] });
        saveLocalUsers(users);
      }
    }
  }

  // UI role application (unchanged)
  function applyRoleUI(role){
    const navItems = document.querySelectorAll('#cmsNav .nav-item');
    navItems.forEach(item => {
      const target = item.getAttribute('data-target');
      if (role === 'client') {
        const visible = (target === 'pageRoster');  // clients: roster only
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

  // Credentials check (FB or local)
  async function checkLogin(user, pass){
    if (hasFirebase) {
      const snap = await rtdb.ref(usersPath).once('value');
      const obj = snap.val() || {};
      const all = Object.values(obj);
      const found = all.find(u => (u.email || '') === user && (u.password || '') === pass);
      if (!found) return null;
      return { username: found.email, role: found.role || 'client', events: found.events || [], _id: found.id };
    } else {
      const users = getLocalUsers();
      const u = users.find(x => x && (x.username === user || x.email === user) && x.password === pass);
      if (!u) return null;
      return { username: u.username || u.email, role: u.role || 'super', events: u.events || [] };
    }
  }

  // DOM
  const gate   = document.getElementById('loginGate');
  const form   = document.getElementById('loginForm');
  const uEl    = document.getElementById('loginUser');
  const pEl    = document.getElementById('loginPass');
  const btn    = document.getElementById('btnLogin');

  // If page has no login gate (e.g. public page), bail
  if (!gate || !form || !uEl || !pEl || !btn) return;

  // Boot
  (async function boot(){
    await ensureDefaultAdmin();

    // restore session if any
    const me = getAuth();
    if (me && me.username) {
      applyRoleUI(me.role || 'super');
      gate.classList.remove('show');
      gate.style.display = 'none';
      return;
    }
    gate.classList.add('show');
    gate.style.display = 'flex';
  })();

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
    gate.classList.remove('show');
    gate.style.display = 'none';
    if (typeof renderAll === 'function') renderAll();
  });
})();
// ===== END LOGIN =====