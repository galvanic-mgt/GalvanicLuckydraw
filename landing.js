const STORE_KEY='ldraw-events-v3';
function getAll(){ try{ return JSON.parse(localStorage.getItem(STORE_KEY))||{currentId:null,events:{}}; }catch{ return {currentId:null,events:{}}; } }
function qsParam(key){ const u=new URL(location.href); return u.searchParams.get(key); }
function loadEvent(){ const all=getAll(); const eventId = qsParam('event') || all.currentId; if(!eventId || !all.events[eventId]) return {id:null, name:'', data:null}; return {id:eventId, name:all.events[eventId].name, data:all.events[eventId].data}; }
// === Guest check-in helpers ===
function eid() { return ev?.id || (qsParam('event') || ''); }

function showSeatCard(guest){
  const card = document.getElementById('seatCard');
  const info = document.getElementById('seatInfo');
  if (info) info.textContent = `桌 ${guest.table || '—'} · 座位 ${guest.seat || '—'}`;
  if (card) card.style.display = 'block';
}

const ev = loadEvent(); const state = ev.data || { people:[], eventInfo:{}, questions:[], banner:null, logo:null };
function qsAll(){ const u=new URL(location.href); return Object.fromEntries(u.searchParams.entries()); }
function getPollFromState(pollId){
  const polls = state.polls || [];
  return polls.find(p=>p.id===pollId) || null;
}
function ensurePollVotes(p){
  p.votes = p.votes || {};
  // ensure all current options have a numeric bucket
  (p.options||[]).forEach(o=>{ if(typeof p.votes[o.id] !== 'number') p.votes[o.id] = 0; });
  return p;
}
function saveEventData(data){
  const all=getAll();
  if(!all.events[ev.id]) return;
  all.events[ev.id].data = data;
  localStorage.setItem(STORE_KEY, JSON.stringify(all));
}
// device-level one-vote guard per event+poll
function votedKey(eid,pid){ return `ldraw-voted-${eid}-${pid}`; }

function t(id, val){ const e=document.getElementById(id); if(e) e.textContent=val||''; }
function initInfo(){ const b=document.getElementById('banner'); if(state.banner){ b.style.backgroundImage=`url(${state.banner})`; } if(state.logo){ const l=document.getElementById('logo'); l.src=state.logo; } t('evTitle', state.eventInfo?.title || '活動'); t('evDateTime', state.eventInfo?.dateTime || ''); t('evVenue', state.eventInfo?.venue || ''); t('evAddress', state.eventInfo?.address || ''); t('evBus', state.eventInfo?.bus || ''); t('evTrain', state.eventInfo?.train || ''); t('evParking', state.eventInfo?.parking || ''); t('evNotes', state.eventInfo?.notes || ''); const mapBtn=document.getElementById('mapBtn'); if(state.eventInfo?.mapUrl){ mapBtn.href=state.eventInfo.mapUrl; } else { mapBtn.style.display='none'; } }
function renderQuestions(){ const wrap=document.getElementById('dynamicQuestions'); wrap.innerHTML=''; (state.questions||[]).forEach(q=>{ const field=document.createElement('label'); field.className='lp-field'; const title=document.createElement('span'); title.textContent=q.text+(q.required?' *':''); field.appendChild(title); let input; if(q.type==='select'){ input=document.createElement('select'); (q.options||[]).forEach(opt=>{ const o=document.createElement('option'); o.value=opt; o.textContent=opt; input.appendChild(o); }); } else if(q.type==='boolean'){ input=document.createElement('select'); ['是','否'].forEach(opt=>{ const o=document.createElement('option'); o.value=opt; o.textContent=opt; input.appendChild(o); }); } else { input=document.createElement('input'); input.placeholder=q.placeholder||''; } input.name=q.text; if(q.required) input.required=true; field.appendChild(input); wrap.appendChild(field); }); }
function handleSignupSubmit(e){
  e.preventDefault();
  const name=document.getElementById('signupName').value.trim();
  const dept=document.getElementById('signupDept').value.trim();
  if(!name||!dept){ return; }

  const answers={};
  document.querySelectorAll('#dynamicQuestions input, #dynamicQuestions select').forEach(el=>{
    answers[el.name]=el.value;
  });

  const all=getAll();
  if(!all.events[ev.id]) return;
  const data = all.events[ev.id].data || { people:[], winners:[], remaining:[] };

  // find existing person by name+dept; mark present if found
  let person = (data.people||[]).find(p => p.name===name && (p.dept||'')===dept);
  if(person){
    person.checkedIn = true;
    person.answers = answers;
  } else {
    // add a new person (present)
    person = { name, dept, answers, checkedIn:true };
    data.people.push(person);
  }

  // rebuild remaining = checked-in & not already won
  const winnersSet = new Set((data.winners||[]).map(w => `${w.name}||${w.dept||''}`));
  data.remaining = (data.people||[]).filter(p => p.checkedIn && !winnersSet.has(`${p.name}||${p.dept||''}`));

  all.events[ev.id].data = data;
  localStorage.setItem(STORE_KEY, JSON.stringify(all));

  document.getElementById('signupMsg').innerHTML=`✅ 已提交：<strong>${name}</strong>（${dept}）`;
  e.target.reset();
}

function renderPollVote(p){
  const card = document.getElementById('pollCard');
  const voteView = document.getElementById('pollVoteView');
  const resView = document.getElementById('pollResultView');
  const title = document.getElementById('pollTitle');
  const wrap  = document.getElementById('pollOptionsWrap');
  const btn   = document.getElementById('submitVote');
  const msg   = document.getElementById('voteMsg');

  card.style.display = 'block';
  voteView.style.display = 'block';
  resView.style.display  = 'none';
  title.textContent = p.question || '投票';

  wrap.innerHTML = '';
  let selected = null;

  (p.options||[]).forEach(o=>{
    const row = document.createElement('label');
    row.className = 'lp-poll-opt';
    row.innerHTML = `<input type="radio" name="pollopt" value="${o.id}" /> <span>${o.text||''}</span>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('input[type="radio"]').forEach(r=>{
    r.onchange = ()=>{ selected = r.value; btn.disabled = !selected; };
  });

  // already voted?
  if(localStorage.getItem(votedKey(ev.id,p.id))){
    msg.textContent = '你已投票，感謝參與！';
    btn.disabled = true;
  } else {
    msg.textContent = '';
  }

  btn.onclick = ()=>{
    if(!selected) return;
    const all = getAll();
    const data = all.events[ev.id].data || state;
    const cur = (data.polls||[]).find(x=>x.id===p.id);
    if(!cur) return;

    ensurePollVotes(cur);
    cur.votes[selected] = (cur.votes[selected]||0) + 1;

    saveEventData(data);
    localStorage.setItem(votedKey(ev.id,p.id), '1');

    msg.innerHTML = '✅ 已提交，感謝你的投票！';
    btn.disabled = true;
  };
}

function renderPollResult(p){
  const card = document.getElementById('pollCard');
  const voteView = document.getElementById('pollVoteView');
  const resView = document.getElementById('pollResultView');
  const title = document.getElementById('pollTitle');
  const bars  = document.getElementById('resultBars');
  const hint  = document.getElementById('totalVotesHint');

  card.style.display = 'block';
  voteView.style.display = 'none';
  resView.style.display  = 'block';
  title.textContent = (p.question || '投票') + ' · 結果';

  // build data
  ensurePollVotes(p);
  const opts = (p.options||[]).map(o=>({
    id:o.id, text:o.text||'', votes:(p.votes[o.id]||0)
  }));

  // sort least -> most for the required animation direction
  opts.sort((a,b)=>a.votes-b.votes);

  const total = opts.reduce((a,b)=>a+b.votes,0) || 1;
  hint.textContent = `總票數：${total}`;

  bars.innerHTML = '';
  opts.forEach((o, idx)=>{
    const pct = Math.round(o.votes*100/total);
    const bar = document.createElement('div');
    bar.className = 'lp-bar';
    bar.dataset.votes = o.votes;

    const fill = document.createElement('div');
    fill.className = 'fill';
    // give each bar a distinct hue for clarity (no external deps)
    const hue = Math.floor(360 * (idx/Math.max(1,opts.length)));
    fill.style.background = `linear-gradient(90deg, hsl(${hue},90%,55%), hsl(${(hue+24)%360},90%,55%))`;

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = o.text;

    const pctEl = document.createElement('div');
    pctEl.className = 'pct';
    pctEl.textContent = `${pct}%`;

    bar.appendChild(fill);
    bar.appendChild(label);
    bar.appendChild(pctEl);
    bars.appendChild(bar);

    // stagger animation (least -> most)
    setTimeout(()=>{ fill.style.width = `${pct}%`; }, 180 * idx);
  });

  // crown on the most favourite (last item after sorting)
  const winnerBar = bars.lastElementChild;
  if (winnerBar) {
    // wait for its width animation to complete, then show crown
    const delay = 180 * (opts.length-1) + 900;
    setTimeout(()=>{ winnerBar.classList.add('crown'); }, delay);
  }
}

// keep result page live if CMS updates votes (e.g., many devices voting)
window.addEventListener('storage', (e)=>{
  const q = qsAll(); if (q.view !== 'result' || !q.poll) return;
  const fresh = loadEvent().data;
  if(!fresh) return;
  const p = (fresh.polls||[]).find(x=>x.id===q.poll);
  if(p){ renderPollResult(p); }
});


document.addEventListener('DOMContentLoaded', ()=>{
  initInfo();
  renderQuestions();
  document.getElementById('signupForm').addEventListener('submit', handleSignupSubmit);

  // === Poll boot ===
  const q = qsAll();
  let pollId = q.poll;
  let view   = (q.view || 'poll');

  // If no poll specified, default to the event's current poll
  if (!pollId && state && Array.isArray(state.polls) && state.currentPollId) {
    pollId = state.currentPollId;
  }

  if (pollId) {
    const cur = getPollFromState(pollId);
        if (cur) {
        if (view === 'result') {
  (async () => {
    // live refresh from Firebase so public screen updates
    const FB = {
      base: 'https://luckydrawpolls-default-rtdb.asia-southeast1.firebasedatabase.app', // ← replace
      get: (p) => fetch(`${FB.base}${p}.json`).then(r => r.json())
    };

    const draw = async () => {
      const fresh = await FB.get(`/events/${ev.id}/polls/${pollId}`);
      renderPollResult(fresh || cur);
    };

    await draw();
    setInterval(draw, 2000);
  })();
} else {
  renderPollVote(cur); // (kept for completeness)
}
// === Guest check-in: form submit ===
const checkinForm = document.getElementById('checkinForm');
if (checkinForm) {
  checkinForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const codeEl = document.getElementById('codeDigits');
    const msgEl  = document.getElementById('checkinMsg');
    const code   = (codeEl?.value || '').trim();
    const eventId = eid();

    if (!eventId) { if (msgEl) msgEl.textContent = '連結缺少活動參數。'; return; }
    if (!code)    { if (msgEl) msgEl.textContent = '請輸入你的碼。'; return; }

    // Reuse/extend your existing FB wrapper if already present. Otherwise:
    const FB = {
      base: 'https://luckydrawpolls-default-rtdb.asia-southeast1.firebasedatabase.app', // ← confirm/change if needed
      get:  (p) => fetch(`${FB.base}${p}.json`).then(r => r.json()),
      patch:(p,b)=> fetch(`${FB.base}${p}.json`, { method:'PATCH', body: JSON.stringify(b) }).then(r=>r.json())
    };

    // Lookup guest by "code"
    const guest = await FB.get(`/events/${eventId}/guests/${encodeURIComponent(code)}`);
    if (!guest || !guest.name) {
      if (msgEl) msgEl.textContent = '找不到你的資料，請向工作人員查詢。';
      return;
    }

    // Mark arrival + eligibility atomically
    await FB.patch(`/events/${eventId}/guests/${encodeURIComponent(code)}`, {
      arrived: true,
      eligible: true,
      checkinAt: Date.now()
    });

    // Show seat
    if (msgEl) msgEl.innerHTML = `✅ 已報到：<strong>${guest.name}</strong>${guest.dept ? `（${guest.dept}）` : ''}`;
    showSeatCard(guest);
    if (codeEl) codeEl.value = '';
  });
}


    }
  }
});


