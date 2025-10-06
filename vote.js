// vote.js
// -------- CONFIG: paste your Firebase RTDB URL (no trailing slash)
const FB = {
  base: 'https://luckydrawpolls-default-rtdb.asia-southeast1.firebasedatabase.app', // ← ← replace with your RTDB URL
  get:   (p) => fetch(`${FB.base}${p}.json`).then(r=>r.json()),
  put:   (p,b) => fetch(`${FB.base}${p}.json`, {method:'PUT',   body:JSON.stringify(b)}).then(r=>r.json()),
  patch: (p,b) => fetch(`${FB.base}${p}.json`, {method:'PATCH', body:JSON.stringify(b)}).then(r=>r.json())
};

// --- utils
function qsAll(){ const u = new URL(location.href); return Object.fromEntries(u.searchParams.entries()); }
function votedKey(eid,pid){ return `ldraw-voted-${eid}-${pid}`; }

const els = {
  title: document.getElementById('pollTitle'),
  subtitle: document.getElementById('pollSubtitle'),
  wrap: document.getElementById('pollOptionsWrap'),
  btn: document.getElementById('submitVote'),
  msg: document.getElementById('voteMsg'),
  card: document.getElementById('pollCard'),
  thanks: document.getElementById('thanksCard'),
};

let eid = '', pid = '', selected = null;

// simple render
function renderPoll(p){
  els.title.textContent = p.question || '投票';
  els.wrap.innerHTML = '';
  selected = null; els.btn.disabled = true; els.msg.textContent = '';

  (p.options||[]).forEach(o=>{
    const line = document.createElement('label');
    line.className = 'lp-poll-opt';
    line.innerHTML = `<input type="radio" name="pollopt" value="${o.id}" /> <span>${o.text||''}</span>`;
    els.wrap.appendChild(line);
  });
  els.wrap.querySelectorAll('input[type="radio"]').forEach(r=>{
    r.onchange = ()=>{ selected = r.value; els.btn.disabled = !selected; };
  });

  if (localStorage.getItem(votedKey(eid, pid))) {
    els.msg.textContent = '你已投票，感謝參與！';
    els.btn.disabled = true;
  }
}

async function boot(){
  const q = qsAll();
  eid = q.event || '';
  pid = q.poll || '';

  if (!eid || !pid) {
    els.title.textContent = '找不到投票';
    els.subtitle.textContent = '連結缺少參數';
    els.btn.style.display = 'none';
    return;
  }

  const p = await FB.get(`/events/${eid}/polls/${pid}`);
  if (!p) {
    els.title.textContent = '投票未就緒';
    els.subtitle.textContent = '請稍後再試';
    els.btn.style.display = 'none';
    return;
  }
  renderPoll(p);

  els.btn.onclick = async ()=>{
    if(!selected) return;
    // atomic-ish increment (PUT new value after a read)
    const cur = await FB.get(`/events/${eid}/polls/${pid}/votes/${selected}`);
    const next = (typeof cur === 'number' ? cur : 0) + 1;
    await FB.put(`/events/${eid}/polls/${pid}/votes/${selected}`, next);

    localStorage.setItem(votedKey(eid, pid), '1');
    els.card.style.display = 'none';
    els.thanks.style.display = 'block';
  };
}

document.addEventListener('DOMContentLoaded', boot);
