// === Persistent storage per-event ===
const STORE_KEY='ldraw-events-v3';
const SNAP_KEY='ldraw-snapshots-v1'; // for saved snapshots

function genId(){ return 'e'+Math.floor(Date.now()+Math.random()*1e6).toString(36); }
function loadAll(){ try{ return JSON.parse(localStorage.getItem(STORE_KEY))||{currentId:null,events:{}}; }catch{ return {currentId:null,events:{}}; } }
function saveAll(o){ localStorage.setItem(STORE_KEY, JSON.stringify(o)); }
function baseState(){
  return {
    people:[], remaining:[], winners:[],
    bg:null, logo:null, banner:null,
    pageSize:50, rosterPage:1, pages:[{id:1}], currentPage:1,
    lastConfirmed:null, lastPick:null, currentBatch:[],
    prizes:[], currentPrizeId:null,
    eventInfo:{title:'',client:'',dateTime:'',venue:'',address:'',mapUrl:'',bus:'',train:'',parking:'',notes:''},
    questions:[], rerolls:[],
    // NEW ↓
    polls: [
      { id:'p1', question:'今晚最期待哪個環節？',
        options:[{id:'o1',text:'抽獎'},{id:'o2',text:'表演'},{id:'o3',text:'美食'}],
        votes:{} }
    ],
    currentPollId: 'p1'
  };
}

function ensureInit(){
  const all = loadAll();
  if(!all.currentId){
    const id = genId();
    all.events[id] = { name: '預設活動', client: '', listed: true, data: baseState() };
    all.currentId = id;
    saveAll(all);
  }
}

// --- Event management helpers ---
function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }
function createEvent(name, client){
  const id = store.create(name, client);
  return id;
}
function cloneCurrentEvent(newName){
  const curMeta = store.current();
  const all = JSON.parse(localStorage.getItem('ldraw-events-v3')) || { currentId:null, events:{} };
  const curData = all.events[curMeta.id]?.data || baseState();
  const newId = genId();

  const meta = {
    name:   newName || (curMeta.name + '（副本）'),
    client: curMeta.client || '',
    listed: (all.events[curMeta.id]?.listed !== false)
  };

  // write locally (keeps existing callers/UI flow intact)
  all.events[newId] = { ...meta, data: deepClone(curData) };
  all.currentId = newId;
  localStorage.setItem('ldraw-events-v3', JSON.stringify(all));

  // fire-and-forget: write to Firebase in background (no await)
  try {
    if (typeof CLOUD !== 'undefined') {
      CLOUD.writeMeta(newId, meta).catch(()=>{});
      CLOUD.writeData(newId, all.events[newId].data).catch(()=>{});
    }
  } catch {}

  return newId; // still synchronous
}


// ===== Firebase (REST) tiny wrapper =====
const FB = {
  base: 'https://luckydrawpolls-default-rtdb.asia-southeast1.firebasedatabase.app', // ← same URL as vote.js
  get:   (p) => fetch(`${FB.base}${p}.json`).then(r=>r.json()),
  put:   (p,b) => fetch(`${FB.base}${p}.json`, {method:'PUT',   body:JSON.stringify(b)}).then(r=>r.json()),
  patch: (p,b) => fetch(`${FB.base}${p}.json`, {method:'PATCH', body:JSON.stringify(b)}).then(r=>r.json())
};

// ---- Cloud index + helpers (events metadata + per-event state) ----
const CLOUD = {
  // Meta list lives under /eventsIndex/{id} -> { name, client, listed }
  async listEvents() {
    const map = await FB.get(`/eventsIndex`) || {};
    return Object.entries(map).map(([id, meta]) => ({
      id, name: meta?.name || '（未命名）',
      client: meta?.client || '', listed: meta?.listed !== false
    }));
  },
  async writeMeta(id, meta) {
    await FB.patch(`/eventsIndex/${id}`, {
      name: meta.name || '（未命名）',
      client: meta.client || '',
      listed: meta.listed !== false
    });
  },
  async writeData(id, data) {
    // Whole event state under /events/{id}/data
    await FB.put(`/events/${id}/data`, data);
  },
  async readData(id) {
    const data = await FB.get(`/events/${id}/data`);
    return data || null;
  }
};

function rebuildRemainingFromPeople(){
  const winnersSet = new Set(state.winners.map(w => `${w.name}||${w.dept||''}`));
  state.remaining = (state.people || []).filter(p => p.checkedIn && !winnersSet.has(`${p.name}||${p.dept||''}`));
}


function fireAtElement(el, engine, count=180) {
  if (!el || !engine) return;
  const r = el.getBoundingClientRect();
  let x = r.left + r.width / 2;
  let y = r.top  + r.height / 2;

  if (engine === confettiPublic) {
    x += scrollX; 
    y += scrollY;     // viewport-sized
  } else if (engine === confettiStage) {
    const stageEl = document.querySelector('#pageStage .stage'); // use stage as origin
    if (stageEl) {
      const sr = stageEl.getBoundingClientRect();
      x -= sr.left;
      y -= sr.top;    // element-sized canvas local coords
    }
  }
  engine.fire(x, y, count);
}


// Convenience: fire on all winner cards in a container
function fireOnCards(container, engine, perCount=160) {
  if (!container || !engine) return;
  const cards = container.querySelectorAll('.winner-card');
  const count = Math.max(60, Math.floor(perCount / Math.max(1, cards.length))); // smaller if many
  cards.forEach(card => fireAtElement(card, engine, count));
}

const store={
  load(){ ensureInit(); const all=loadAll(); return all.events[all.currentId].data||baseState(); },
  save(s){ const all=loadAll(); all.events[all.currentId].data=s; saveAll(all); },
  list(){ ensureInit(); const all=loadAll();
  return Object.entries(all.events).map(([id,v])=>({
    id, name:v.name, client:v.client||'', listed: (v.listed !== false)
  }));
},

  current(){ const all=loadAll(); const meta=all.events[all.currentId]||{name:'',client:''}; return {id:all.currentId,name:meta.name,client:meta.client}; },
  switch(id){
    const all = loadAll();
    if (!all.events[id]) return false;

    // set current locally (keeps existing callers working)
    all.currentId = id;
    saveAll(all);

    // background: pull latest from cloud into local cache (non-blocking)
    try {
      CLOUD.readData(id).then(cloud=>{
        if (!cloud) return;
        const all2 = loadAll();
        if (all2.events[id]) {
          all2.events[id].data = cloud;
          saveAll(all2);
          // optional: re-render when cloud state arrives
          if (typeof renderAll === 'function') renderAll();
        }
      }).catch(()=>{});
    } catch {}

    return true;
  },

create(name, client){
    const all = loadAll();
    const id = genId();
    all.events[id] = {
      name: name || ('活動 ' + (Object.keys(all.events).length + 1)),
      client: client || '',
      listed: true,
      data: baseState()
    };
    all.currentId = id; saveAll(all); return id;
  },

renameCurrent(name, client){
  const all = loadAll();
  const id = all.currentId;
  if (all.events[id]) {
    if (name) all.events[id].name = name;
    if (client !== undefined) all.events[id].client = client;
    saveAll(all);
    CLOUD.writeMeta(id, {
      name: all.events[id].name,
      client: all.events[id].client,
      listed: all.events[id].listed !== false
    }).catch(()=>{});
  }
}
};

// ===== Sync layer (same-device, multi-tab/window) =====
let bc;
try { bc = new BroadcastChannel('ldraw-sync-v1'); } catch { bc = null; }

function broadcastTick(reason=''){
  // Fast ping; receivers will reload from localStorage for consistency.
  try { bc && bc.postMessage({type:'TICK', reason, ts: Date.now()}); } catch {}
}

function broadcastCelebrate(){
  try { bc && bc.postMessage({ type:'CELEBRATE', ts: Date.now() }); } catch {}
}

const _storeSave = store.save.bind(store);
let _lastBC = 0;
store.save = (s)=>{
  _storeSave(s);  // keep local cache for existing synchronous code

  // write-through to cloud (fire-and-forget; UI stays snappy)
  try {
    const cur = store.current();
    if (cur && cur.id) CLOUD.writeData(cur.id, s);
  } catch {}

  // broadcast to other tabs (same device)
  const now = Date.now();
  if (now - _lastBC > 200) {
    _lastBC = now;
    broadcastTick('store.save');
  }
};


// Also listen to other tabs and storage changes.
if (bc) {
  bc.onmessage = (evt)=>{
    const d = evt?.data;
    if (!d) return;

    if (d.type === 'TICK') {
      state = store.load();
      renderAll();

    } else if (d.type === 'CELEBRATE') {
      if (document.body.classList.contains('public-mode') || (publicView && publicView.style.display !== 'none')) {
        fireConfetti();
      }

      } else if (d.type === 'SHOW_DRAW') {
  const isPublicHere = document.body.classList.contains('public-mode') ||
                       (publicView && publicView.style.display !== 'none');
      if (isPublicHere) {
        // Ensure we’re on the public tab
        $('tabPublic')?.click();

        // 1) Stop the poll-results auto-refresh
        try {
          if (pollReveal && pollReveal.timer) clearInterval(pollReveal.timer);
        } catch {}
        // 2) Reset reveal/session state so it won’t re-appear
        pollReveal = { eid:null, pid:null, order:[], reveal:-1, timer:null };

        // 3) Hide the results board and its mode flag
        document.body.classList.remove('public-result');
        const rb = $('pollResultBoard');
        if (rb) { rb.style.display = 'none'; }

        // 4) Also stop “QR-only” mode (we’re going back to the stage)
        document.body.classList.remove('poll-only');

        // 5) Refresh the stage UI
        updatePublicPanel();
      }


    } else if (d.type === 'REROLL_BURST') {
  const idx = d.at || 0;

  // Public stage
  const pubCards = document.querySelectorAll('#currentBatch .winner-card');
  if (pubCards[idx] && typeof confettiPublic !== 'undefined' && confettiPublic) {
    fireAtElement(pubCards[idx], confettiPublic, 140);
  }

  // CMS embedded stage
  const cmsCards = document.querySelectorAll('#currentBatch2 .winner-card');
  if (cmsCards[idx] && typeof confettiStage !== 'undefined' && confettiStage) {
    fireAtElement(cmsCards[idx], confettiStage, 140);
  }

  // Tablet stage
  const tbCards = document.querySelectorAll('#currentBatch3 .winner-card');
  if (tbCards[idx] && typeof confettiTablet !== 'undefined' && confettiTablet) {
    fireAtElement(tbCards[idx], confettiTablet, 140);
  }


  } else if (d.type === 'DRAW_BURST') {
    // Public stage
    setTimeout(()=>{ 
      const el = document.getElementById('currentBatch'); 
      if (el && typeof confettiPublic !== 'undefined' && confettiPublic) {
        fireOnCards(el, confettiPublic); 
      }
    }, 10);

    // CMS embedded stage
    setTimeout(()=>{ 
      const el = document.getElementById('currentBatch2'); 
      if (el && typeof confettiStage !== 'undefined' && confettiStage) {
        fireOnCards(el, confettiStage); 
      }
    }, 10);

    // Tablet stage
    setTimeout(()=>{ 
      const el = document.getElementById('currentBatch3'); 
      if (el && typeof confettiTablet !== 'undefined' && confettiTablet) {
        fireOnCards(el, confettiTablet); 
      }
    }, 10);


      } else if (d.type === 'SHOW_POLL_RESULT') {
  // Only the Public screen should respond
  const isPublicHere = document.body.classList.contains('public-mode') ||
                       (publicView && publicView.style.display !== 'none');
  if (isPublicHere) {
    // switch to Public tab (just in case)
    $('tabPublic')?.click();

    // stop QR-only layout, then start results
    document.body.classList.remove('poll-only');   // hide centered QR
    state.showPollOnly = false; store.save(state);

    startPublicPollResults(d.eid, d.pid);          // begins draw+click-to-reveal
  }


        } else if (d.type === 'COUNTDOWN') {
      const { from=3, step=700, goAt } = d;

      // Show the synced countdown on every surface that exists
      const jobs = [];
      if (document.getElementById('overlay'))  jobs.push(showCountdownOverlayAligned(from, step, goAt, 'public'));
      if (document.getElementById('overlay2')) jobs.push(showCountdownOverlayAligned(from, step, goAt, 'cms'));
      if (document.getElementById('overlay3')) jobs.push(showCountdownOverlayAligned(from, step, goAt, 'tablet'));

      Promise.all(jobs).then(()=>{
        // After countdown completes, pop confetti on all surfaces that exist
        setTimeout(()=>{
          const pub = document.getElementById('currentBatch');
          if (pub && typeof confettiPublic !== 'undefined' && confettiPublic) {
            fireOnCards(pub, confettiPublic);
          }
        }, 30);

        setTimeout(()=>{
          const cms = document.getElementById('currentBatch2');
          if (cms && typeof confettiStage !== 'undefined' && confettiStage) {
            fireOnCards(cms, confettiStage);
          }
        }, 30);

        setTimeout(()=>{
          const tab = document.getElementById('currentBatch3');
          if (tab && typeof confettiTablet !== 'undefined' && confettiTablet) {
            fireOnCards(tab, confettiTablet);
          }
        }, 30);
      });
    }

  };
}


window.addEventListener('storage', (e)=>{
  if (e.key && e.key.includes('ldraw-')) {
    state = store.load();
    renderAll();
  }
});

// Optional hook for cross-device sync in the future (Firebase/WebSocket).
// Call remotePublish() after store.save, and remoteSubscribe(renderAll) on boot.
function remotePublish(){ /* no-op (add backend later) */ }
function remoteSubscribe(onRemoteUpdate){ /* no-op */ }


// --- Utilities ---
const $ = id => document.getElementById(id);
const wait = ms=>new Promise(r=>setTimeout(r,ms));
function safe(s){ return (s||'').replaceAll('"','""'); }
function sampleAndRemove(arr){ const idx=Math.floor(Math.random()*arr.length); const v=arr[idx]; arr.splice(idx,1); return v; }

async function showCountdownOverlayAligned(from=3, step=700, goAt, scope='auto'){
  let ov, cnt;

  if (scope === 'public') { ov = $('overlay');  cnt = $('count');  }
  else if (scope === 'cms') { ov = $('overlay2'); cnt = $('count2'); }
  else if (scope === 'tablet') { ov = $('overlay3'); cnt = $('count3'); }
  else {
    const isTablet = document.body.classList.contains('tablet-mode');
    const publicVisible = document.body.classList.contains('public-mode')
      || (publicView && publicView.style.display !== 'none');
    if (isTablet)      { ov=$('overlay3'); cnt=$('count3'); }
    else if (publicVisible) { ov=$('overlay');  cnt=$('count');  }
    else               { ov=$('overlay2'); cnt=$('count2'); }
  }

  if(!ov || !cnt) return;
  ov.classList.add('show');

  while (true){
  const msLeft = Math.max(0, goAt - Date.now());
  // off-by-one safe: when msLeft is exactly a multiple of step, keep it at "from"
  const n = Math.max(1, Math.floor((msLeft - 1) / step) + 1);
  cnt.textContent = n;
  if (msLeft <= 0) break;
  await wait(Math.min(step, msLeft));
}


  ov.classList.remove('show');
}



function celebrateAtElement(el){
  if (!el) return fireConfetti();
  const r = el.getBoundingClientRect();
  // For public (viewport) we already use window coords; for embedded, translate to canvas space:
  if (confettiStage) {
    confettiStage.fire(r.width/2, r.height/2, 180);
  }
  if (confettiPublic) {
    confettiPublic.fire(); // fullscreen window
  }
}



// --- CSV / XLSX ---
function splitCSVLine(line){ const out=[]; let cur=''; let q=false; for(let i=0;i<line.length;i++){ const c=line[i]; if(c==='"'){ if(q && line[i+1]==='"'){ cur+='"'; i++; } else { q=!q; } } else if(c===',' && !q){ out.push(cur); cur=''; } else { cur+=c; } } out.push(cur); return out; }
function parseCSV(text){
  const lines=text.split(/\r?\n/).filter(l=>l.trim().length);
  if(!lines.length) return [];
  const header=splitCSVLine(lines[0]).map(h=>h.trim().toLowerCase());
  const rows=[];
  for(let i=1;i<lines.length;i++){
    const parts=splitCSVLine(lines[i]); const row={};
    header.forEach((h,idx)=> row[h] = (parts[idx]||'').trim());
    rows.push(row);
  }
  return rows;
}

async function parsePrizeFile(file){
  const name=(file?.name||'').toLowerCase();
  if(name.endsWith('.csv')){
    const txt = await file.text();
    return parseCSV(txt).map(r=>({name:r.name||r['獎品']||'', quota:Number(r.quota||r['名額']||1)||1})).filter(p=>p.name);
  } else if(name.endsWith('.xlsx')){
    if(!window.XLSX){ alert('需要 xlsx 解析器。請保留 index.html 中的 <script src="xlsx.full.min.js"> 或改用 CSV。'); return []; }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const arr = XLSX.utils.sheet_to_json(ws, {defval:''}); // [{name, quota}]
    return arr.map(r=>({name:r.name||r['獎品']||'', quota:Number(r.quota||r['名額']||1)||1})).filter(p=>p.name);
  } else {
    alert('只支援 .csv 或 .xlsx 檔案');
    return [];
  }
}

function makeConfettiEngine(canvas, hostEl=null){
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const particles = [];

  function resize(){
    if (hostEl) {
      const r = hostEl.getBoundingClientRect();
      canvas.width  = Math.max(1, Math.floor(r.width));
      canvas.height = Math.max(1, Math.floor(r.height));
      // Ensure it fills the stage box
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
    } else {
      canvas.width  = innerWidth;
      canvas.height = innerHeight;
    }
  }

  function fire(x = (hostEl ? canvas.width/2 : innerWidth/2),
               y = (hostEl ? canvas.height/3 : innerHeight/3),
               count = 220){
    for (let i=0;i<count;i++){
      particles.push({
        x, y,
        vx: (Math.random()-0.5)*10,
        vy: Math.random()*-7-5,
        g: 0.22 + Math.random()*0.12,
        s: 3 + Math.random()*4,
        life: 140 + Math.random()*80,
        hue: Math.floor(Math.random()*360)
      });
    }
  }

  function tick(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    particles.forEach(p=>{
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.life--;
      ctx.save();
      ctx.translate(p.x,p.y);
      ctx.rotate((p.x+p.y)/80);
      ctx.fillStyle = `hsl(${p.hue},95%,60%)`;
      ctx.fillRect(-p.s/2,-p.s/2,p.s,p.s);
      ctx.restore();
    });
    for (let i=particles.length-1;i>=0;i--){
      if (particles[i].life<=0 || particles[i].y > (canvas.height + 60)) particles.splice(i,1);
    }
    requestAnimationFrame(tick);
  }

  resize();
  if (hostEl) {
    // Resize when the stage box changes size
    window.addEventListener('resize', resize);
    // Also observe container resizes (sidebar toggles, etc.)
    try {
      const ro = new ResizeObserver(resize);
      ro.observe(hostEl);
    } catch {}
  } else {
    window.addEventListener('resize', resize);
  }
  requestAnimationFrame(tick);

  return { fire, resize };
}

let confettiPublic = null;
let confettiStage  = null;

// Fix the typo and unify celebration:
function celebrateAt(rectLike=null){
  if (rectLike){
    const x = rectLike.left + rectLike.width/2 + scrollX;
    const y = rectLike.top  + rectLike.height/2 + scrollY;
    confettiPublic && confettiPublic.fire(x,y,180);
    confettiStage  && confettiStage.fire(x,y,180);
  } else {
    confettiPublic && confettiPublic.fire();
    confettiStage  && confettiStage.fire();
  }
}

// Provide a simple helper actually used by draw flows:
function fireConfetti(){
  confettiPublic && confettiPublic.fire();
  confettiStage  && confettiStage.fire();
}

// --- State & DOM refs ---
let state;
let publicView, cmsView, overlay, countEl, publicPrizeEl, statsRemain, statsWinners, statsPrizeLeft, batchGrid, winnersChips;
let bgEl, logoEl, bannerEl;

// Embedded stage refs (pageStage)
let publicPrize2, batchGrid2, winnersChips2, bgEl2, logoEl2, bannerEl2, confetti2, ctx2, confettiParticles2=[];

let eventList, newEventName, newClientName, addEventBtn;
let evTitle, evClient, evDateTime, evVenue, evAddress, evMapUrl, evBus, evTrain, evParking, evNotes;
let currentEventName, currentClient, currentIdLabel;

// Events Manage tab refs
let emNewName, emNewClient, emCreate;
let emCloneName, emClone;
let emSearch, emTable;

// roster
let csvInput, btnPreset, btnExportCheckin, btnExportSession, importSessionInput, tiles, pageSelect, searchInput, pageSize2;

// prizes
let prizeRows, prizeSearch, newPrizeName, newPrizeQuota, prizeFile, importPrizesBtn;

// draw
let batchCount, btnDraw, btnCountdown, btnConfirm, btnUndo, btnExportWinners;

// questions
let newQText, newQType, newQOptions, newQRequired, questionsTable;

// storage
let saveSnapshotBtn, exportCurrentEventBtn, snapshotsTable;

let landingURL, copyURL, openLanding, qrBox, downloadQR, landingLink, openFullStageLink;

function currentPrize(){ return state.prizes.find(p=>p.id===state.currentPrizeId)||null; }
function prizeLeft(p){ return Math.max(0,(p?.quota||0)-(p?.won?.length||0)); }

function renderBG(){ [bgEl,bgEl2].forEach(el=>{ if(el) el.style.backgroundImage=state.bg?`url(${state.bg})`:''; }); }
function renderLogo(){ [logoEl,logoEl2].forEach(el=>{ if(!el) return; if(state.logo){ el.src=state.logo; el.style.display='block'; } else { el.style.display='none'; } }); }
function renderBanner(){ [bannerEl,bannerEl2].forEach(el=>{ if(el) el.style.backgroundImage=state.banner?`url(${state.banner})`:'none'; }); }

function renderBatchTargets(targetGrid){
  targetGrid.innerHTML='';
  (state.currentBatch||[]).forEach((w,i)=>{
    const card=document.createElement('div'); 
    card.className='winner-card';

    const n=document.createElement('div'); 
    n.className='name'; 
    n.textContent=w.name;

    const d=document.createElement('div'); 
    d.className='dept'; 
    d.textContent=w.dept||'';

    // Reroll button (kept for CMS/Public)
    const rer=document.createElement('button'); 
    rer.textContent='缺席重抽'; 
    rer.className='btn primary reroll-btn'; 
    rer.style.position='absolute'; 
    rer.style.bottom='8px'; 
    rer.style.right='8px';
    rer.onclick=()=>rerollAt(i);

    card.append(n,d);


    card.appendChild(rer);
    targetGrid.appendChild(card);
  });
}
// --- role helper (block client from event mgmt even if they unhide UI) ---
function _isClient(){
  try { const a = JSON.parse(localStorage.getItem('ldraw-auth-v1')); return a && a.role === 'client'; }
  catch { return false; }
}

function updatePublicPanel(){
  const p = currentPrize();

  // ——— Prize title (Public + CMS)
  [publicPrizeEl, publicPrize2].forEach(el=>{
    if (el) el.textContent = p ? `現正抽獎：${p.name}（名額 ${p.quota}）` : '—';
  });

  const remainText  = `剩餘：${state.remaining.length}`;
  const winnersText = `已得獎：${state.winners.length}`;

  // ——— Stats (Public + CMS)
  [document.getElementById('statsRemain'),
   document.getElementById('statsRemain2')].forEach(el => { if (el) el.textContent = remainText; });

  [document.getElementById('statsWinners'),
   document.getElementById('statsWinners2')].forEach(el => { if (el) el.textContent = winnersText; });

  const leftText = `此獎尚餘：${p ? prizeLeft(p) : 0}`;
  // Update both the new inline badges and (if you keep it) the old bottom stat
  [document.getElementById('prizeLeftInline'),
   document.getElementById('prizeLeftInline2'),
   statsPrizeLeft].forEach(el => { if (el) el.textContent = leftText; });

  // ===== ADD: Tablet mirrors (title + stats) =====
  const publicPrize3 = document.getElementById('publicPrize3');
  if (publicPrize3) publicPrize3.textContent = p ? `現正抽獎：${p.name}（名額 ${p.quota}）` : '—';

  const sr3 = document.getElementById('statsRemain3');
  if (sr3) sr3.textContent = remainText;

  const sw3 = document.getElementById('statsWinners3');
  if (sw3) sw3.textContent = winnersText;

  const pl3 = document.getElementById('prizeLeftInline3');
  if (pl3) pl3.textContent = leftText;
  // ===== END tablet mirrors =====

  const html = p ? p.won.slice(-16).map(w=>`<div class="chip">${w.name} · ${w.dept||''}</div>`).join('') : '';
  // no bottom chips needed
  if (winnersChips)  winnersChips.innerHTML  = '';
  if (winnersChips2) winnersChips2.innerHTML = '';
  // ===== ADD: clear tablet chips too (keep consistent) =====
  const winnersChips3 = document.getElementById('winnersChips3');
  if (winnersChips3) winnersChips3.innerHTML = '';
  // =====

  // Branding / visuals
  renderBanner();

  // Winner cards (grids)
  if (batchGrid)  renderBatchTargets(batchGrid);
  if (batchGrid2) renderBatchTargets(batchGrid2);
  
  // ===== ADD: render tablet grid =====
  const batchGrid3 = document.getElementById('currentBatch3');
  if (batchGrid3) renderBatchTargets(batchGrid3);
  // =====

  // show/refresh the current poll’s QR on the public stage
  renderActivePollQR();

  // Center Public view on the poll QR when requested
  document.body.classList.toggle('poll-only',
    !!(document.body.classList.contains('public-mode') && state.showPollOnly)
  );
}


// roster
function filterBySearch(list){ const q=(searchInput?.value||'').trim().toLowerCase(); if(!q) return list; return list.filter(p=> (p.name||'').toLowerCase().includes(q) || (p.dept||'').toLowerCase().includes(q)); }
function paginateRemaining(){ const size=Number(state.pageSize)||12; const list=filterBySearch(state.remaining); const pages=[]; for(let i=0;i<list.length;i+=size){ pages.push(list.slice(i,i+size)); } return pages; }
function rebuildPagesSelect(){ if(!pageSelect) return; pageSelect.innerHTML=''; state.pages.forEach(p=>{ const o=document.createElement('option'); o.value=p.id; o.textContent=`第 ${p.id} 頁`; if(p.id===state.currentPage) o.selected=true; pageSelect.appendChild(o); }); }
function renderTiles(){ if(!tiles) return; tiles.innerHTML=''; const pages=paginateRemaining(); const i=Math.max(0,state.currentPage-1); const entries=pages[i]||[]; entries.forEach(p=>{ const d=document.createElement('div'); d.className='card'; d.innerHTML=`<div style="font-weight:800;font-size:16px">${p.name}</div><div class="pill">${p.dept||''}</div>`; const act=document.createElement('button'); act.className='btn'; act.textContent='選此人'; act.onclick=()=>selectCandidate(p); d.appendChild(act); tiles.appendChild(d); }); }

// prizes
function renderPrizes(){
  if(!prizeRows) return;
  prizeRows.innerHTML='';
  const q=(prizeSearch?.value||'').trim().toLowerCase();
  state.prizes.forEach(pr=>{
    if(q && !(pr.name||'').toLowerCase().includes(q)) return;
    const tr=document.createElement('tr');
    const tdUse=document.createElement('td'); const rb=document.createElement('input'); rb.type='radio'; rb.name='usePrize'; rb.checked=pr.id===state.currentPrizeId; rb.onchange=()=>{ state.currentPrizeId=pr.id; store.save(state); renderAll(); }; tdUse.appendChild(rb);
    const tdName=document.createElement('td'); const inpName=document.createElement('input'); inpName.value=pr.name; inpName.oninput=()=>{ pr.name=inpName.value; store.save(state); updatePublicPanel(); }; tdName.appendChild(inpName);
    const tdQuota=document.createElement('td'); const inpQuota=document.createElement('input'); inpQuota.type='number'; inpQuota.min=1; inpQuota.value=pr.quota; inpQuota.onchange=()=>{ pr.quota=Math.max(1, Number(inpQuota.value)||1); if(prizeLeft(pr)<0){ pr.quota=pr.won.length; inpQuota.value=pr.quota; } store.save(state); updatePublicPanel(); }; tdQuota.appendChild(inpQuota);
    const tdWon=document.createElement('td'); tdWon.textContent=pr.won.length;
    const tdOps=document.createElement('td'); const btnDel=document.createElement('button'); btnDel.className='btn danger'; btnDel.textContent='刪除'; btnDel.onclick=()=>{ if(confirm('確定刪除此獎品？（不會刪除已抽中的人）')){ state.prizes=state.prizes.filter(x=>x.id!==pr.id); if(state.currentPrizeId===pr.id) state.currentPrizeId=state.prizes[0]?.id||null; store.save(state); renderAll(); } }; tdOps.appendChild(btnDel);
    tr.append(tdUse,tdName,tdQuota,tdWon,tdOps); prizeRows.appendChild(tr);
  });
}

// draw
let currentPick=null;
function addWinnerRecords(prize, person){
  // existing local writes
  state.winners.push({...person, prizeId:prize.id, prizeName:prize.name, time:new Date().toISOString()});
  prize.won.push(person);

  // Update local person
  const me = (state.people||[]).find(p => p.name===person.name && (p.dept||'')===(person.dept||''));
  if (me) {
    me.receivedGift = true;
    me.gift = { id:String(prize.id), name:prize.name, awardedAt: Date.now() };
  }

  // Cloud mirror (if code known)
  const code = me?.code || person.code || '';
  const eventId = store.current().id;
  if (code) {
    FB.patch(`/events/${eventId}/guests/${encodeURIComponent(code)}`, {
      receivedGift: true,
      gift: { id:String(prize.id), name:prize.name, awardedAt: Date.now() }
    }).catch(()=>{ /* non-blocking */ });
  }
}
function removeWinnerRecords(prize, person){
  for(let i=state.winners.length-1;i>=0;i--){ const w=state.winners[i]; if(w.name===person.name && w.prizeId===prize.id){ state.winners.splice(i,1); break; } }
  for(let i=prize.won.length-1;i>=0;i--){ const w=prize.won[i]; if(w.name===person.name){ prize.won.splice(i,1); break; } }
}
function selectCandidate(p){ currentPick=p; state.currentBatch=[p]; btnConfirm && (btnConfirm.disabled=false); store.save(state); updatePublicPanel(); }
function drawOne(){ if(state.remaining.length===0) return null; const person=sampleAndRemove(state.remaining); const prize=currentPrize(); if(!prize){ alert('請先選擇使用中的獎品'); return; } addWinnerRecords(prize, person); state.currentBatch=[person]; state.lastConfirmed=person; state.lastPick={prizeId:prize.id,people:[person]}; rebuildRemainingFromPeople(); store.save(state); renderAll();
// burst on the cards (CMS embedded)
fireOnCards(document.getElementById('currentBatch2'), confettiStage);
// ask the public window to burst on its cards
try { bc && bc.postMessage({ type:'DRAW_BURST', ts: Date.now() }); } catch {}
fireOnCards(document.getElementById('currentBatch3'), (typeof confettiTablet!=='undefined'?confettiTablet:null));
return person;
}
function drawBatch(n){
  const prize=currentPrize(); if(!prize){ alert('請先選擇使用中的獎品'); return; }
  const can=Math.min(n, prizeLeft(prize), state.remaining.length); if(can<=0){ alert('名額已滿或沒有剩餘名單'); return; }
  const picks=[]; for(let i=0;i<can;i++){ const person=sampleAndRemove(state.remaining); addWinnerRecords(prize, person); picks.push(person); }
  state.currentBatch=picks.slice(); state.lastConfirmed=picks[picks.length-1]||null; state.lastPick={prizeId:prize.id,people:picks}; rebuildRemainingFromPeople();
store.save(state); renderAll();
// burst on the cards (CMS embedded)
fireOnCards(document.getElementById('currentBatch2'), confettiStage);
// ask the public window to burst on its cards
try { bc && bc.postMessage({ type:'DRAW_BURST', ts: Date.now() }); } catch {}
fireOnCards(document.getElementById('currentBatch3'), (typeof confettiTablet!=='undefined'?confettiTablet:null));
}

function rerollAt(index){
  const prize=currentPrize(); if(!prize) return;
  if(!state.currentBatch[index]) return;
  if(state.remaining.length===0){ alert('沒有剩餘名單'); return; }
  const old=state.currentBatch[index]; removeWinnerRecords(prize, old); state.remaining.push(old);
  let newPerson=sampleAndRemove(state.remaining); let safety=0;
  while(state.currentBatch.some(w=>w.name===newPerson.name && w.dept===newPerson.dept) && safety++<500){
    state.remaining.push(newPerson); newPerson=sampleAndRemove(state.remaining);
  }
  addWinnerRecords(prize, newPerson); state.currentBatch[index]=newPerson; rebuildRemainingFromPeople(); store.save(state); renderAll();

  // CMS embedded
const cmsCards = document.querySelectorAll('#currentBatch2 .winner-card');
fireAtElement(cmsCards[index], confettiStage, 140);

// Also tell any other window (e.g., the public fullscreen) to pop on that card
try { 
  bc && bc.postMessage({ type:'REROLL_BURST', at:index, ts: Date.now() }); 
} catch {}

// Tablet stage confetti (if the tablet stage is present)
const tbCards = document.querySelectorAll('#currentBatch3 .winner-card');
if (tbCards[index] && typeof confettiTablet !== 'undefined' && confettiTablet) {
  fireAtElement(tbCards[index], confettiTablet, 140);
}

// --- LOG this reroll ---
state.rerolls = state.rerolls || [];
const log = {
  id: 'rr' + Math.floor(Date.now()+Math.random()*1e6).toString(36),
  prizeId: prize.id,
  prizeName: prize.name,
  index,                       // card index within currentBatch at that time
  oldPerson: old,
  newPerson: newPerson,
  time: new Date().toISOString()
};
state.rerolls.unshift(log);
store.save(state);
renderRerollList();


}
// Synced countdown: both CMS and Public aim at the same goAt timestamp
async function countdown(from=3, step=700){
  const duration = from * step;
  const goAt = Date.now() + duration; // tiny cushion for paint/jitter

  // Always broadcast so the public window locks to the same schedule
  try { bc && bc.postMessage({ type:'COUNTDOWN', from, step, goAt, ts: Date.now() }); } catch {}

  // Show local overlay (CMS or Public) but align to goAt
  await showCountdownOverlayAligned(from, step, goAt);
}



// snapshots
function loadSnaps(){ try{ return JSON.parse(localStorage.getItem(SNAP_KEY))||[]; }catch{ return []; } }
function saveSnaps(list){ localStorage.setItem(SNAP_KEY, JSON.stringify(list)); }
function addSnapshot(){
  const cur=store.current(); const s=store.load();
  const snap={ id: cur.id, name: cur.name, client: cur.client||'', when: new Date().toISOString(), data: s };
  const list=loadSnaps(); list.unshift(snap); saveSnaps(list); renderSnapshots();
}
function renderSnapshots(){
  if(!snapshotsTable) return;
  const list=loadSnaps();
  snapshotsTable.innerHTML='';
  list.forEach((sn, idx)=>{
    const tr=document.createElement('tr');
    const tdWhen=document.createElement('td'); tdWhen.textContent=new Date(sn.when).toLocaleString();
    const tdName=document.createElement('td'); tdName.textContent=sn.name;
    const tdClient=document.createElement('td'); tdClient.textContent=sn.client||'—';
    const tdOps=document.createElement('td');
    const bOpen=document.createElement('button'); bOpen.className='btn'; bOpen.textContent='載入到當前活動'; bOpen.onclick=()=>{ store.save(sn.data); state=store.load(); renderAll(); };
    const bDL=document.createElement('button'); bDL.className='btn'; bDL.textContent='下載 JSON'; bDL.onclick=()=>{ const blob=new Blob([JSON.stringify(sn.data,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`snapshot_${idx}.json`; a.click(); URL.revokeObjectURL(url); };
    const bDel=document.createElement('button'); bDel.className='btn danger'; bDel.textContent='刪除'; bDel.onclick=()=>{ const list=loadSnaps(); list.splice(idx,1); saveSnaps(list); renderSnapshots(); };
    tdOps.append(bOpen,bDL,bDel);
    tr.append(tdWhen,tdName,tdClient,tdOps);
    snapshotsTable.appendChild(tr);
  });
}

// QR
function currentLandingURL(){ const cur=store.current().id; const base = location.origin + location.pathname.replace(/index\.html?$/,''); return `${base}landing.html?event=${encodeURIComponent(cur)}`; }

function renderActivePollQR(){
  const box = $('pollPublicQR');
  const row = $('pollPublicRow');
  if(!box || !row) return;

  const cur = (state.polls||[]).find(p=>p.id===state.currentPollId);

  // Only show on public when "poll focus" is on
  if (!cur || !state.showPollOnly) {
    row.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  row.style.display = '';
  box.innerHTML = '';
  try {
    new QRCode(box, { text: pollURL(cur.id, 'poll'), width: 160, height: 160, correctLevel: window.QRCode?.CorrectLevel?.M || 0 });
  } catch {}
}

function genPollId(){ return 'p' + Math.random().toString(36).slice(2,8); }
function genOptId(){ return 'o' + Math.random().toString(36).slice(2,8); }

function renderQR(){
  const url=currentLandingURL();
  landingURL && (landingURL.value=url);
  if(qrBox){ qrBox.innerHTML=''; try{ new QRCode(qrBox, { text:url, width:220, height:220, correctLevel: window.QRCode?.CorrectLevel?.M || 0 }); }catch{} }
}
function copyLandingURL(){ landingURL?.select?.(); document.execCommand && document.execCommand('copy'); navigator.clipboard && navigator.clipboard.writeText(landingURL.value); }
function downloadQRCanvas(){
  if(!qrBox) return; const canvas = qrBox.querySelector('canvas'); if(!canvas) return;
  const a=document.createElement('a'); a.href=canvas.toDataURL('image/png'); a.download='event-qr.png'; a.click();
}
function updateLandingLink(){ const cur=store.current().id; landingLink && (landingLink.href=`landing.html?event=${encodeURIComponent(cur)}`); }
function updateFullStageLink(){ const cur=store.current().id; if(openFullStageLink){ const url = location.href.replace(/#.*$/,'') + '#public'; openFullStageLink.href = url; }}

// view = 'poll' | 'result'
function pollURL(pollId, view = 'poll'){
  // Derive base path from where index.html lives (works for Netlify, Vercel AND GitHub Pages subpaths)
  const base = (()=>{
    const m = location.pathname.match(/^(.*\/)(?:index\.html?)?$/);
    return (location.origin + (m ? m[1] : '/'));  // e.g. https://site.com/ or https://user.github.io/repo/
  })();

  const eid = (store.current().id || '');

  if (view === 'result') {
    const u = new URL(base + 'index.html');
    u.searchParams.set('event', eid);
    u.searchParams.set('poll',  pollId);
    u.searchParams.set('view',  'result');
    u.hash = '#public';
    return u.toString();
  } else {
    const u = new URL(base + 'vote.html');
    u.searchParams.set('event', eid);
    u.searchParams.set('poll',  pollId);
    return u.toString();
  }
}

function ensurePollVotes(p){ p.votes = p.votes || {}; return p; }

// ===== Poll Results (Public) =====
const urlParams = ()=> Object.fromEntries(new URL(location.href).searchParams.entries());
let pollReveal = { eid:null, pid:null, order:[], reveal:-1, timer:null }; // reveal=-1 => only title shown

function buildOrderByVotes(p){
  // least -> most (ties stable)
  const opts = (p.options||[]).map((o,i)=>({i, id:o.id, text:o.text||'', votes:(p.votes?.[o.id]||0)}));
  opts.sort((a,b)=> a.votes - b.votes || a.i - b.i);
  return opts;
}

function renderPublicPollBoard(p){
  const board = $('pollResultBoard');
  const bars  = $('prBars');
  const title = $('prTitle');
  const hint  = $('prHint');
  if (!board || !bars) return;

  // show board, hide other stage bits via body class
  document.body.classList.add('public-result');
  board.style.display = 'block';

  // title (always visible)
  title.textContent = p.question || '投票結果';

  // compute order (least -> most)
  const order = buildOrderByVotes(p);
  pollReveal.order = order;

  const total = Math.max(1, order.reduce((a,b)=>a+b.votes,0));
  hint.textContent = `總票數：${total} · 點按舞台逐一顯示（由低至高）`;

  // (Re)build columns if count changed
  bars.innerHTML = '';
  order.forEach((o, idx)=>{
    const col = document.createElement('div'); col.className = 'vbar'; col.dataset.idx = String(idx);

    const shaft = document.createElement('div'); shaft.className = 'shaft';
    const fill  = document.createElement('div'); fill.className  = 'fill';
    const pct   = document.createElement('div'); pct.className   = 'pct';
    const label = document.createElement('div'); label.className = 'label';

    // colourful columns
    const hue = Math.floor(360 * (idx/Math.max(1,order.length)));
    fill.style.background = `linear-gradient(180deg, hsl(${hue},90%,60%), hsl(${(hue+26)%360},90%,55%))`;

    pct.textContent = `${Math.round(o.votes*100/total)}%`;
    label.textContent = o.text;

    shaft.appendChild(fill);
    col.append(shaft, pct, label);
    bars.appendChild(col);
  });

  // apply reveal heights according to current reveal index
  applyRevealHeights();
}

function applyRevealHeights(){
  const bars = $('prBars'); if (!bars) return;
  const total = Math.max(1, pollReveal.order.reduce((a,b)=>a+b.votes,0));
  bars.querySelectorAll('.vbar').forEach((col)=>{
    const idx  = Number(col.dataset.idx||0);
    const o    = pollReveal.order[idx];
    const fill = col.querySelector('.fill');
    const pct  = col.querySelector('.pct');

    // reset crown
    const oldCrown = col.querySelector('.crown'); if (oldCrown) oldCrown.remove();

    if (idx <= pollReveal.reveal){
      // revealed: animate to target height
      const h = Math.round(o.votes*100/total);
      fill.style.height = `${h}%`;
      pct.style.opacity = '1';
    } else {
      // hidden
      fill.style.height = '0%';
      pct.style.opacity = '0';
    }
  });

  // If the last (winner) was just revealed, drop the crown
  if (pollReveal.reveal === pollReveal.order.length - 1){
    const winnerCol = $('prBars').lastElementChild;
    if (winnerCol){
      const crown = document.createElement('div');
      crown.className = 'crown';
      crown.textContent = '👑';
      winnerCol.appendChild(crown);
    }
  }
}

function startPublicPollResults(eid, pid){
  pollReveal.eid = eid; pollReveal.pid = pid; pollReveal.reveal = -1;

  // click anywhere in the board to advance one column at a time
  const board = $('pollResultBoard');
  if (board && !board._wired){
    board._wired = true;
    board.addEventListener('click', ()=>{
      if (!pollReveal.order.length) return;
      if (pollReveal.reveal < pollReveal.order.length - 1){
        pollReveal.reveal++;
        applyRevealHeights();
      }
    });
  }

  // live refresh from Firebase every 2s
  const draw = async ()=>{
    try{
      const p = await FB.get(`/events/${pollReveal.eid}/polls/${pollReveal.pid}`);
      if (!p) return;
      ensurePollVotes(p);
      renderPublicPollBoard(p);
    }catch{}
  };

  clearInterval(pollReveal.timer);
  draw();
  pollReveal.timer = setInterval(draw, 2000);
}


// NAV subpages
function setActivePage(targetId){
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.subpage').forEach(p=>p.style.display='none');
  const btn = Array.from(document.querySelectorAll('.nav-item')).find(b=>b.dataset.target===targetId);
  btn && btn.classList.add('active');
  $(targetId).style.display='block';
}

document.addEventListener('DOMContentLoaded', ()=>{
  const tabPublic = $('tabPublic');
  const tabCMS    = $('tabCMS');

  if (location.hash === '#public') {
  // Switch to Public mode automatically
  $('tabPublic').click();
}

  publicView=$('publicView'); cmsView=$('cmsView');
  overlay=$('overlay'); countEl=$('count');
  publicPrizeEl=$('publicPrize'); statsRemain=$('statsRemain'); statsWinners=$('statsWinners'); statsPrizeLeft=$('statsPrizeLeft');
  batchGrid=$('currentBatch'); winnersChips=$('winnersChips');
  bgEl=$('bgEl'); logoEl=$('logoEl'); bannerEl=$('banner');

  // Embedded stage refs
  publicPrize2=$('publicPrize2'); batchGrid2=$('currentBatch2'); winnersChips2=$('winnersChips2');
  bgEl2=$('bgEl2'); logoEl2=$('logoEl2'); bannerEl2=$('banner2');
  openFullStageLink=$('openFullStage');

    // Tablet stage refs
  const publicPrize3 = $('publicPrize3');
  const batchGrid3   = $('currentBatch3');
  const winnersChips3= $('winnersChips3');
  const bgEl3        = $('bgEl3');
  const logoEl3      = $('logoEl3');
  const bannerEl3    = $('banner3');

  // Build a confetti engine for the tablet stage (hosted/sized to the stage)
  const tabletStageEl = document.getElementById('tabletStage');
  const confettiTablet = makeConfettiEngine($('confetti3'), tabletStageEl);

  // Tablet fullscreen toggle
  $('tabletFullscreen')?.addEventListener('click', ()=>{
    const d=document.documentElement; d.requestFullscreen && d.requestFullscreen();
  });

  // Ensure the public confetti canvas sits at <body> level (not inside .stage)
const publicConfettiEl = $('confetti');
if (publicConfettiEl && publicConfettiEl.parentElement !== document.body) {
  document.body.appendChild(publicConfettiEl);
}

// Now initialize engines (after moving the node)
// Public full-screen canvas stays viewport-sized
confettiPublic = makeConfettiEngine($('confetti'));

// Embedded stage in CMS: size to the stage card bounds
const embeddedStageEl = document.querySelector('#pageStage .stage');
confettiStage = makeConfettiEngine($('confetti2'), embeddedStageEl);


  // sidebar + events
  eventList=$('eventList'); newEventName=$('newEventName'); newClientName=$('newClientName'); addEventBtn=$('addEvent');
  // Clients cannot create events
try {
  const me = JSON.parse(localStorage.getItem('ldraw-auth-v1'));
  if (me && me.role === 'client' && addEventBtn) {
    addEventBtn.disabled = true;
    addEventBtn.title = '此帳號無權限建立活動';
    const sbForm = document.querySelector('.sidebar-form');
    if (sbForm) sbForm.style.display = 'none';
  }
} catch {}

  evTitle=$('evTitle'); evClient=$('evClient'); evDateTime=$('evDateTime'); evVenue=$('evVenue'); evAddress=$('evAddress'); evMapUrl=$('evMapUrl'); evBus=$('evBus'); evTrain=$('evTrain'); evParking=$('evParking'); evNotes=$('evNotes');
  currentEventName=$('currentEventName'); currentClient=$('currentClient'); currentIdLabel=$('currentIdLabel');

  // roster
  csvInput=$('csv'); btnPreset=$('preset'); btnExportCheckin=$('exportCheckin'); btnExportSession=$('exportSession'); importSessionInput=$('importSession');
  pageSelect=$('pageSelect'); searchInput=$('search'); pageSize2=$('pageSize2');

  // roster pager
  const prevPageBtn = $('prevPage');
  const nextPageBtn = $('nextPage');
  const pageHint    = $('pageHint');
  const rosterCount = $('rosterCount');

  const addName = $('addName'), addDept = $('addDept'), addPresent = $('addPresent'), addPersonBtn = $('addPerson');

  addPersonBtn.addEventListener('click', ()=>{
  const name = (addName.value||'').trim();
  const dept = (addDept.value||'').trim();
  if(!name){ alert('請輸入姓名'); return; }
  const person = { name, dept, checkedIn: !!addPresent.checked };
  state.people = state.people || [];
  // avoid duplicate (same name+dept)
  if(!state.people.some(p=>p.name===person.name && (p.dept||'')===(person.dept||''))){
    state.people.push(person);
  }
  rebuildRemainingFromPeople();
  store.save(state);
  addName.value=''; addDept.value=''; addPresent.checked=false;
  renderRosterList(); updatePublicPanel();
});

searchInput.addEventListener('input', ()=>{
  state.rosterPage = 1;
  store.save(state);
  renderRosterList();
});


  // prizes
  prizeRows=$('prizeRows'); prizeSearch=$('prizeSearch'); newPrizeName=$('newPrizeName'); newPrizeQuota=$('newPrizeQuota'); prizeFile=$('prizeFile'); importPrizesBtn=$('importPrizes');

  // draw
  batchCount=$('batchCount'); btnDraw=$('draw'); btnCountdown=$('countdownDraw'); btnConfirm=$('confirm'); btnUndo=$('undo'); btnExportWinners=$('exportWinners');

  // questions
  newQText=$('newQText'); newQType=$('newQType'); newQOptions=$('newQOptions'); newQRequired=$('newQRequired'); questionsTable=$('questionsTable');

  // storage
  saveSnapshotBtn=$('saveSnapshot'); exportCurrentEventBtn=$('exportCurrentEvent'); snapshotsTable=$('snapshotsTable');

  // QR
  landingURL=$('landingURL'); copyURL=$('copyURL'); openLanding=$('openLanding'); qrBox=$('qrBox'); downloadQR=$('downloadQR'); landingLink=$('landingLink');
  

  state = store.load();

  // Events Manage tab elements
  emNewName = $('emNewName');
  emNewClient = $('emNewClient');
  emCreate = $('emCreate');
  emCloneName = $('emCloneName');
  emClone = $('emClone');
  emSearch = $('emSearch');
  emTable = $('emTable');

  emCreate.addEventListener('click', ()=>{
    const name = (emNewName.value || '新活動').trim();
    const client = (emNewClient.value || '').trim();
    createEvent(name, client);
    state = store.load();
    emNewName.value = ''; emNewClient.value = '';
    renderAll();
    setActivePage('pageEventsManage');
});

// === Merge cloud guests into local state (multi-device sync) ===
(async ()=>{
  try {
    const eventId = store.current().id;
    const cloud = await FB.get(`/events/${eventId}/guests`) || {};
    const mapKey = (x)=> `${(x.name||'').trim()}||${(x.dept||'').trim()}`;
    const localMap = new Map((state.people||[]).map(p=>[mapKey(p), p]));

    Object.entries(cloud).forEach(([code, g])=>{
      const k = mapKey(g);
      const p = localMap.get(k);
      if (p) {
        p.code = code;
        p.table = g.table || p.table;
        p.seat  = g.seat  || p.seat;
        p.checkedIn   = !!g.arrived;
        p.receivedGift= !!g.receivedGift;
        p.gift = g.gift || p.gift || { id:null, name:null, awardedAt:null };
      } else {
        (state.people = state.people || []).push({
          name: g.name, dept: g.dept || '',
          code, table: g.table || '', seat: g.seat || '',
          checkedIn: !!g.arrived,
          receivedGift: !!g.receivedGift,
          gift: g.gift || { id:null, name:null, awardedAt:null }
        });
      }
    });

    // If your app uses remaining/winners lists, rebuild and rerender
    if (typeof rebuildRemainingFromPeople === 'function') rebuildRemainingFromPeople();
    store.save(state);
    if (typeof renderAll === 'function') renderAll();
  } catch (e) {
    console.warn('Pull cloud guests failed', e);
  }
})();


emClone.addEventListener('click', ()=>{
  const proposed = (emCloneName.value || '').trim();
  const finalName = proposed || (`${store.current().name || '活動'}（副本）`);
  cloneCurrentEvent(finalName);
  state = store.load();
  emCloneName.value = '';
  renderAll();
  setActivePage('pageEventsManage');
});

emSearch.addEventListener('input', renderEventsTable);


  // top tabs
  tabPublic.addEventListener('click', ()=>{ tabPublic.classList.add('active'); tabCMS.classList.remove('active','primary'); cmsView.style.display='none'; publicView.style.display='block'; document.body.classList.add('public-mode'); });
  tabCMS.addEventListener('click', ()=>{ tabCMS.classList.add('active','primary'); tabPublic.classList.remove('active'); publicView.style.display='none'; cmsView.style.display='block'; document.body.classList.remove('public-mode'); });

  const tabTablet = $('tabTablet');
const tabletView = $('tabletView');

if (tabTablet) {
  tabTablet.addEventListener('click', ()=>{
    // 類似公眾頁：不讓用戶看到 CMS
    document.body.classList.add('tablet-mode');
    // 顯示平板頁、隱藏其它
    tabletView.style.display = 'block';
    cmsView.style.display = 'none';
    publicView.style.display = 'none';
  });
}

// 支援 URL 直接進入：index.html#tablet
if (location.hash === '#tablet') {
  $('tabTablet')?.click();
}

// 綁定平板上的按鈕
const tabletBatch = $('tabletBatch');
$('tabletDraw')?.addEventListener('click', ()=>{
  state.showPollOnly = false; store.save(state); updatePublicPanel();
  const n = Math.max(1, Number(tabletBatch?.value)||1);
  n===1 ? drawOne() : drawBatch(n);
});
$('tabletCountdown')?.addEventListener('click', async ()=>{
  state.showPollOnly = false; store.save(state); updatePublicPanel();
  const n = Math.max(1, Number(tabletBatch?.value)||1);
  await countdown(3, 700);
  n===1 ? drawOne() : drawBatch(n);
});
$('tabletCountdownBig')?.addEventListener('click', async ()=>{
  state.showPollOnly = false; store.save(state); updatePublicPanel();
  const n = Math.max(1, Number(tabletBatch?.value)||1);
  await countdown(3, 700);
  n===1 ? drawOne() : drawBatch(n);
});



  // left nav subpages
  document.querySelectorAll('.nav-item').forEach(b=>{
    b.addEventListener('click', ()=> setActivePage(b.dataset.target));
  });

  // events sidebar
  addEventBtn.addEventListener('click', ()=>{ const name=(newEventName.value||'新活動').trim(); const client=(newClientName.value||'').trim(); store.create(name, client); state=store.load(); newEventName.value=''; newClientName.value=''; renderAll(); });
  $('saveEventInfo').addEventListener('click', ()=>{
    store.renameCurrent(evTitle.value||store.current().name, evClient.value||'');
    state.eventInfo = {
      title: evTitle.value||'',
      client: evClient.value||'',
      dateTime: evDateTime.value||'',
      venue: evVenue.value||'',
      address: evAddress.value||'',
      mapUrl: evMapUrl.value||'',
      bus: evBus.value||'',
      train: evTrain.value||'',
      parking: evParking.value||'',
      notes: evNotes.value||'',
    };
    store.save(state); renderAll(); alert('已儲存活動資訊');
  });

  // assets
  $('bg').addEventListener('change', e=>{ const f=e.target.files?.[0]; if(f){ const r=new FileReader(); r.onload=()=>{ state.bg=String(r.result); store.save(state); renderBG(); }; r.readAsDataURL(f); } });
  $('logo').addEventListener('change', e=>{ const f=e.target.files?.[0]; if(f){ const r=new FileReader(); r.onload=()=>{ state.logo=String(r.result); store.save(state); renderLogo(); }; r.readAsDataURL(f); } });
  $('bannerInput').addEventListener('change', e=>{ const f=e.target.files?.[0]; if(f){ const r=new FileReader(); r.onload=()=>{ state.banner=String(r.result); store.save(state); renderBanner(); }; r.readAsDataURL(f); } });

  // roster
  csvInput.addEventListener('change', async e=>{
    const f=e.target.files?.[0]; if(!f) return;
    const txt = await f.text(); const header = parseCSV(txt)[0] ? null : null; // noop
    const people = parseCSV(txt).map(r=>({
      name:  r.name || r['姓名'] || '',
      dept:  r.dept || r['部門'] || r['department'] || '',
      code: (r.code || r['碼'] || r['code'] || '').toString().trim(),
      table: r.table || r['桌'] || r['table'] || '',
      seat:  r.seat  || r['座位'] || r['seat']  || ''
    })).filter(p=>p.name);
    // Guarantee each person has a 4-digit code if not provided/invalid
    // Guarantee each person has a 4-digit code if not provided/invalid
    people.forEach(p=>{
      if (!/^\d{3,8}$/.test(p.code)) {
        p.code = String(Math.floor(1000 + Math.random()*9000)); // 4 digits
      }
    });

    if(!people.length){ alert('CSV 內容有問題（需包含 name 或 姓名 欄）。'); return; }
    
    // imported people default to absent; they'll be present after QR check-in or manual toggle
    state.people = people.map(p => ({...p, checkedIn:false}));
    state.winners = [];
    state.remaining = []; // only checked-in people belong here
    state.pages=[{id:1}]; state.currentPage=1; state.lastConfirmed=null; state.currentBatch=[];
    // Cloud-sync guests to RTDB for this event
      try {
        const eventId = store.current().id;
        const payload = {};
        people.forEach(p=>{
          payload[p.code] = {
            name: p.name,
            dept: p.dept,
            table: p.table,
            seat:  p.seat,
            arrived: false,
            eligible: false,
            receivedGift: false,
            gift: { id:null, name:null, awardedAt:null }
          };
        });
        await FB.patch(`/events/${eventId}/guests`, payload);
        console.log(`Synced ${people.length} guests to cloud.`);
      } catch (e) {
        console.warn('Cloud guest sync failed', e);
      }
    store.save(state); renderAll();

  });
  btnPreset.addEventListener('click', ()=> csvInput.click());
  btnExportCheckin.addEventListener('click', ()=>{
    const header='name,dept\n';
    const rows=state.people.map(p=>`${safe(p.name)},${safe(p.dept)}`);
    const blob=new Blob([header+rows.join('\n')],{type:'text/csv'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download='checkin.csv'; a.click(); URL.revokeObjectURL(url);
  });
  btnExportSession.addEventListener('click', ()=>{
    const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download='lucky-draw-session.json'; a.click(); URL.revokeObjectURL(url);
  });
  importSessionInput.addEventListener('change', e=>{
    const f=e.target.files?.[0]; if(!f) return;
    const r=new FileReader(); r.onload=()=>{ try{ const obj=JSON.parse(String(r.result)); state=Object.assign(baseState(), obj); store.save(state); renderAll(); }catch{ alert('JSON 格式錯誤'); } }; r.readAsText(f,'utf-8');
  });
  $('newPage').addEventListener('click', ()=>{ const maxId=state.pages.reduce((m,p)=>Math.max(m,p.id),1); state.pages.push({id:maxId+1}); state.currentPage=maxId+1; store.save(state); renderAll(); });
  pageSelect.addEventListener('change', ()=>{ state.currentPage=Number(pageSelect.value)||1; store.save(state); renderTiles(); });
    pageSize2.addEventListener('input', e=>{
    const val = Number(e.target.value) || 50;
    state.pageSize   = Math.min(100, Math.max(10, val));
    state.rosterPage = 1; // reset to first page whenever page size changes
    store.save(state);
    renderRosterList();
  });

    prevPageBtn?.addEventListener('click', ()=>{
    const size = Number(state.pageSize) || 50;
    const total = (state.people || []).filter(p=>{
      const q=(searchInput?.value||'').trim().toLowerCase();
      return !q || (p.name||'').toLowerCase().includes(q) || (p.dept||'').toLowerCase().includes(q);
    }).length;
    const pages = Math.max(1, Math.ceil(total / size));
    state.rosterPage = Math.max(1, (state.rosterPage || 1) - 1);
    store.save(state);
    renderRosterList();
  });

  nextPageBtn?.addEventListener('click', ()=>{
    const size = Number(state.pageSize) || 50;
    const total = (state.people || []).filter(p=>{
      const q=(searchInput?.value||'').trim().toLowerCase();
      return !q || (p.name||'').toLowerCase().includes(q) || (p.dept||'').toLowerCase().includes(q);
    }).length;
    const pages = Math.max(1, Math.ceil(total / size));
    state.rosterPage = Math.min(pages, (state.rosterPage || 1) + 1);
    store.save(state);
    renderRosterList();
  });

  searchInput.addEventListener('input', renderTiles);

  // prizes
  $('addPrize').addEventListener('click', ()=>{
    const name=newPrizeName.value.trim()||'未命名獎品'; const quota=Math.max(1, Number(newPrizeQuota.value)||1);
    const id=Date.now()+Math.random(); state.prizes.push({id,name,quota,won:[]});
    if(!state.currentPrizeId) state.currentPrizeId=id; newPrizeName.value=''; newPrizeQuota.value='1'; store.save(state); renderAll();
  });
  prizeSearch.addEventListener('input', renderPrizes);
  importPrizesBtn.addEventListener('click', async ()=>{
    const f=prizeFile.files?.[0]; if(!f){ alert('請選擇 CSV 或 XLSX 檔。'); return; }
    const items = await parsePrizeFile(f);
    if(!items.length){ alert('未讀取到有效獎品。'); return; }
    items.forEach(it=> state.prizes.push({id:Date.now()+Math.random(), name:it.name, quota:it.quota||1, won:[]}));
    if(!state.currentPrizeId && state.prizes[0]) state.currentPrizeId = state.prizes[0].id;
    store.save(state); renderAll(); alert(`已匯入 ${items.length} 項獎品`);
  });

    // draw
  btnDraw.addEventListener('click', ()=>{
    state.showPollOnly = false; store.save(state); updatePublicPanel();  // ← ADD
    const n=Math.max(1, Number(batchCount.value)||1);
    n===1 ? drawOne() : drawBatch(n);
  });
  btnCountdown.addEventListener('click', async ()=>{
    state.showPollOnly = false; store.save(state); updatePublicPanel();  // ← ADD
    const n=Math.max(1, Number(batchCount.value)||1);
    await countdown();
    n===1 ? drawOne() : drawBatch(n);
  });
  btnConfirm.addEventListener('click', ()=>{
    if(!currentPick){ return; }
    const prize = currentPrize();
    if(!prize){ alert('請選擇獎品'); return; }

    // persist winner
    state.remaining = state.remaining.filter(x => !(x.name===currentPick.name && x.dept===currentPick.dept));
    addWinnerRecords(prize, currentPick);
    state.lastConfirmed = currentPick;
    state.lastPick = { prizeId: prize.id, people: [currentPick] };
    state.currentBatch = [currentPick];

    // finalize + re-render
    currentPick = null;
    rebuildRemainingFromPeople();
    store.save(state);
    renderAll();

    // --- CONFETTI: CMS embedded stage
    const cmsGrid = document.getElementById('currentBatch2');
    if (cmsGrid && typeof confettiStage !== 'undefined' && confettiStage) {
      fireOnCards(cmsGrid, confettiStage);
    }

    // --- CONFETTI: Tablet stage
    const tbGrid = document.getElementById('currentBatch3');
    if (tbGrid && typeof confettiTablet !== 'undefined' && confettiTablet) {
      fireOnCards(tbGrid, confettiTablet);
    }

    // --- NOTIFY: Public/fullscreen windows to burst too
    try {
      bc && bc.postMessage({ type:'DRAW_BURST', ts: Date.now() });
    } catch {}
  });

  btnUndo.addEventListener('click', ()=>{
    const lp=state.lastPick; if(!lp) return;
    const prize=state.prizes.find(x=>x.id===lp.prizeId); if(!prize) return;
    lp.people.forEach(person=>{ removeWinnerRecords(prize, person); state.remaining.push(person); });
    state.currentBatch=[]; state.lastPick=null; state.lastConfirmed=null; rebuildRemainingFromPeople(); store.save(state); renderAll();
  });
  btnExportWinners.addEventListener('click', ()=>{
    const header='name,dept,prize,time\n';
    const rows=state.winners.map(w=>`${safe(w.name)},${safe(w.dept)},${safe(w.prizeName||'')},${w.time}`);
    const blob=new Blob([header+rows.join('\n')],{type:'text/csv'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download='winners.csv'; a.click(); URL.revokeObjectURL(url);
  });

  $('clearStage').addEventListener('click', ()=>{
  // 清掉當前舞台卡片（下一輪抽之前讓舞台乾淨）
  state.currentBatch = [];
  state.lastConfirmed = null;      // 可選：一併清掉最後確認
  store.save(state);
  renderAll();

  // 告知其他視窗（如公眾頁）立即刷新
  try { bc && bc.postMessage({ type:'TICK', reason:'clearStage', ts: Date.now() }); } catch {}
});

  // storage
  saveSnapshotBtn.addEventListener('click', addSnapshot);
  exportCurrentEventBtn.addEventListener('click', ()=>{
    const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download='current-event.json'; a.click(); URL.revokeObjectURL(url);
  });

  // QR
  $('copyURL')?.addEventListener('click', ()=> copyLandingURL());
  $('openLanding')?.addEventListener('click', ()=> window.open(currentLandingURL(), '_blank'));
  $('downloadQR')?.addEventListener('click', ()=> downloadQRCanvas());

  $('fullscreen').addEventListener('click', ()=>{ const d=document.documentElement; d.requestFullscreen && d.requestFullscreen(); });

  renderAll();
});

function renderEventList(){

    // --- CLOUD→LOCAL refresh (non-blocking, no async/await, keeps your render code unchanged)
  if (!renderEventList._cloudHooked) {
    renderEventList._cloudHooked = true;
    try {
      CLOUD.listEvents().then(function(cloudList){
        cloudList = Array.isArray(cloudList) ? cloudList : [];
        // merge cloud meta into local cache then repaint via your own function
        var all = loadAll(); all.events = all.events || {};
        cloudList.forEach(function(m){
          if (!all.events[m.id]) {
            all.events[m.id] = { name:m.name, client:m.client, listed:m.listed, data: baseState() };
          } else {
            all.events[m.id].name   = m.name;
            all.events[m.id].client = m.client;
            all.events[m.id].listed = (m.listed!==false);
          }
        });
        saveAll(all);
        // repaint using your existing local-based renderer
        setTimeout(function(){ try{ renderEventList(); }catch(e){} }, 0);
      }).catch(function(){});
    } catch(e){}
  }

  if (!eventList) return;
  eventList.innerHTML = '載入中…';

  // who is logged in? (written by login.js)
  var isClient = false, allowed = null;
  try {
    var me = JSON.parse(localStorage.getItem('ldraw-auth-v1'));
    isClient = !!(me && me.role === 'client');
    allowed = Array.isArray(me && me.events) ? me.events : null;
  } catch(e){}

  // 1) show what we have locally right away (keeps UI snappy)
  var localList = store.list().filter(function(it){ return it.listed; });
  // apply client filter to local paint too
  if (isClient && allowed && allowed.length) {
    localList = localList.filter(function(it){ return allowed.indexOf(it.id) !== -1; });
  }
  eventList.innerHTML = '';
  localList.forEach(function(it){
    var item = document.createElement('div');
    item.className = 'event-item' + (it.id === store.current().id ? ' active' : '');
    item.setAttribute('data-id', it.id);
    item.innerHTML =
      '<div class="event-name">' + (it.name || '（未命名）') + '</div>' +
      '<div class="event-meta">客戶：' + (it.client || '—') + '</div>' +
      '<div class="event-meta">ID: ' + it.id + '</div>';
    item.onclick = function(){
      if (isClient && allowed && allowed.length && allowed.indexOf(it.id) === -1) {
        alert('此帳號無權限訪問該活動'); return;
      }
      if (it.id === store.current().id) return;
      if (confirm('切換至另一活動？未儲存的修改將遺失。')) {
        // keep synchronous behavior
        store.switch(it.id);
        state = store.load();
        renderAll();
      }
    };
    eventList.appendChild(item);
  });

  // 2) background refresh from cloud, repaint when it arrives
  if (typeof CLOUD !== 'undefined' && CLOUD.listEvents) {
    CLOUD.listEvents().then(function(allCloud){
      if (!Array.isArray(allCloud)) allCloud = [];
      // client filter
      if (isClient && allowed && allowed.length) {
        allCloud = allCloud.filter(function(it){ return allowed.indexOf(it.id) !== -1; });
      } else {
        allCloud = allCloud.filter(function(it){ return it.listed; });
      }

      // if nothing changed, we can skip repaint; otherwise repaint from cloud
      eventList.innerHTML = '';
      allCloud.forEach(function(it){
        var item = document.createElement('div');
        item.className = 'event-item' + (it.id === store.current().id ? ' active' : '');
        item.setAttribute('data-id', it.id);
        item.innerHTML =
          '<div class="event-name">' + (it.name || '（未命名）') + '</div>' +
          '<div class="event-meta">客戶：' + (it.client || '—') + '</div>' +
          '<div class="event-meta">ID: ' + it.id + '</div>';
        item.onclick = function(){
          if (isClient && allowed && allowed.length && allowed.indexOf(it.id) === -1) {
            alert('此帳號無權限訪問該活動'); return;
          }
          if (it.id === store.current().id) return;
          if (confirm('切換至另一活動？未儲存的修改將遺失。')) {
            store.switch(it.id);      // still sync
            state = store.load();     // sync
            renderAll();
          }
        };
        eventList.appendChild(item);
      });

      // If client’s current event is not allowed anymore, auto-jump to first allowed
      if (isClient && allowed && allowed.length) {
        var cur = store.current();
        var ok = allCloud.some(function(e){ return e.id === cur.id; });
        if (!ok && allCloud[0]) {
          store.switch(allCloud[0].id);
          state = store.load();
          renderAll();
        }
      }
    }).catch(function(){ /* ignore cloud errors for now */ });
  }
}



    function renderRerollList(){
  const tbody = document.getElementById('rerollRows');
  if (!tbody) return;
  const list = (state.rerolls || []);
  tbody.innerHTML = '';

  list.forEach((rr, i)=>{
    const tr = document.createElement('tr');

    const tdTime = document.createElement('td');
    tdTime.textContent = new Date(rr.time).toLocaleString();

    const tdPrize = document.createElement('td');
    tdPrize.textContent = rr.prizeName || '—';

    const tdSwap = document.createElement('td');
    tdSwap.className = 'swap';
    tdSwap.innerHTML =
      `<span class="old">${(rr.oldPerson?.name||'') + (rr.oldPerson?.dept? '（' + rr.oldPerson.dept + '）':'' )}</span>` +
      `<span class="arrow">→</span>` +
      `<span class="new">${(rr.newPerson?.name||'') + (rr.newPerson?.dept? '（' + rr.newPerson.dept + '）':'' )}</span>`;

    const tdOps = document.createElement('td');
    const btnUndo = document.createElement('button');
    btnUndo.className = 'btn';
    btnUndo.textContent = '↩️ 還原';
    btnUndo.onclick = ()=> undoReroll(rr.id);

    const btnDel = document.createElement('button');
    btnDel.className = 'btn danger';
    btnDel.textContent = '🗑 刪除';
    btnDel.onclick = ()=> deleteReroll(rr.id);

    tdOps.append(btnUndo, btnDel);

    tr.append(tdTime, tdPrize, tdSwap, tdOps);
    tbody.appendChild(tr);
  });
}
    function undoReroll(rrId){
  state.rerolls = state.rerolls || [];
  const idx = state.rerolls.findIndex(x=>x.id === rrId);
  if (idx < 0) return;
  const rr = state.rerolls[idx];

  const prize = state.prizes.find(p=>p.id === rr.prizeId);
  if (!prize) return;

  // 1) remove NEW winner (add back to remaining)
  removeWinnerRecords(prize, rr.newPerson);
  state.remaining.push(rr.newPerson);

  // 2) ensure OLD is not in remaining, then add back as winner
  state.remaining = state.remaining.filter(p=> !(p.name===rr.oldPerson.name && p.dept===rr.oldPerson.dept));
  addWinnerRecords(prize, rr.oldPerson);

  // 3) put OLD back onto the current batch card if it exists
  if (Array.isArray(state.currentBatch) && state.currentBatch[rr.index]) {
    state.currentBatch[rr.index] = rr.oldPerson;
  }

  // 4) remove the log entry
  state.rerolls.splice(idx,1);

  store.save(state);
  renderAll();
  renderRerollList();

  // Pop confetti on restored card (CMS + public)
  const cmsCards = document.querySelectorAll('#currentBatch2 .winner-card');
  if (cmsCards[rr.index]) fireAtElement(cmsCards[rr.index], confettiStage, 140);
  try { bc && bc.postMessage({ type:'REROLL_BURST', at:rr.index, ts: Date.now() }); } catch {}
}

function deleteReroll(rrId){
  state.rerolls = state.rerolls || [];
  const idx = state.rerolls.findIndex(x=>x.id === rrId);
  if (idx < 0) return;
  state.rerolls.splice(idx,1);
  store.save(state);
  renderRerollList();
};

function renderRosterList(){
  const tbody = document.getElementById('rosterRows');
  const pageHint = document.getElementById('pageHint');
  const rosterCount = document.getElementById('rosterCount');
  const prevPageBtn = document.getElementById('prevPage');
  const nextPageBtn = document.getElementById('nextPage');

  if (!tbody) return;
  tbody.innerHTML = '';

  const q = (searchInput?.value || '').trim().toLowerCase();
  const all = (state.people || []);
  const filtered = all.filter(p =>
    (!q) ||
    (p.name||'').toLowerCase().includes(q) ||
    (p.dept||'').toLowerCase().includes(q)
  );

  const size  = Number(state.pageSize) || 50;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  state.rosterPage = Math.min(Math.max(1, state.rosterPage || 1), pages);

  const start = (state.rosterPage - 1) * size;
  const end   = Math.min(filtered.length, start + size);
  const pageItems = filtered.slice(start, end);

  const eventId = store.current().id;

  // ---- rows for current page
  pageItems.forEach((p)=>{
    const tr = document.createElement('tr');

    // --- code
    const tdCode = document.createElement('td');
    const codeIn = document.createElement('input');
    codeIn.placeholder = '碼';
    codeIn.value = p.code || '';
    codeIn.onchange = ()=>{
      p.code = (codeIn.value || '').trim();
      store.save(state);
      if (p.code) {
        FB.patch(`/events/${eventId}/guests/${encodeURIComponent(p.code)}`, {
          name: p.name || '',
          dept: p.dept || '',
          table: p.table || '',
          seat: p.seat || '',
          arrived: !!p.checkedIn,
          eligible: !!p.checkedIn
        }).catch(()=>{});
      }
    };
    tdCode.appendChild(codeIn);

    // --- name
    const tdName = document.createElement('td');
    const inName = document.createElement('input');
    inName.value = p.name || '';
    inName.onchange = ()=>{
      p.name = inName.value.trim();
      store.save(state);
      rebuildRemainingFromPeople();
      renderRosterList();
    };
    tdName.appendChild(inName);

    // --- dept
    const tdDept = document.createElement('td');
    const inDept = document.createElement('input');
    inDept.value = p.dept || '';
    inDept.onchange = ()=>{
      p.dept = inDept.value.trim();
      store.save(state);
      rebuildRemainingFromPeople();
      renderRosterList();
    };
    tdDept.appendChild(inDept);

    // --- table
    const tdTable = document.createElement('td');
    const tableIn = document.createElement('input');
    tableIn.placeholder = '桌';
    tableIn.value = p.table || '';
    tableIn.onchange = ()=>{
      p.table = (tableIn.value || '').trim();
      store.save(state);
      if (p.code) FB.patch(`/events/${eventId}/guests/${encodeURIComponent(p.code)}`, { table: p.table }).catch(()=>{});
    };
    tdTable.appendChild(tableIn);

    // --- seat
    const tdSeat = document.createElement('td');
    const seatIn = document.createElement('input');
    seatIn.placeholder = '座';
    seatIn.value = p.seat || '';
    seatIn.onchange = ()=>{
      p.seat = (seatIn.value || '').trim();
      store.save(state);
      if (p.code) FB.patch(`/events/${eventId}/guests/${encodeURIComponent(p.code)}`, { seat: p.seat }).catch(()=>{});
    };
    tdSeat.appendChild(seatIn);

    // --- status + toggle
    const tdStatus = document.createElement('td');
    const tdOps = document.createElement('td');

    const badge = document.createElement('span');
    badge.className = 'badge ' + (p.checkedIn ? 'present' : 'absent');
    badge.textContent = p.checkedIn ? '已報到' : '未報到';

    const toggle = document.createElement('button');
    toggle.className = 'btn';
    toggle.textContent = p.checkedIn ? '設為未到' : '設為已到';
    toggle.onclick = ()=>{
      p.checkedIn = !p.checkedIn;
      rebuildRemainingFromPeople();
      store.save(state);
      renderRosterList();
      updatePublicPanel();
      if (p.code) {
        FB.patch(`/events/${eventId}/guests/${encodeURIComponent(p.code)}`, {
          arrived: !!p.checkedIn,
          eligible: !!p.checkedIn
        }).catch(()=>{});
      }
    };

    tdStatus.appendChild(badge);

    const quick = document.createElement('button');
    quick.className = 'btn';
    quick.textContent = p.checkedIn ? '從抽選移除' : '加入抽選';
    quick.onclick = ()=>{
      p.checkedIn = !p.checkedIn;
      rebuildRemainingFromPeople();
      store.save(state);
      renderRosterList();
      updatePublicPanel();
      if (p.code) {
        FB.patch(`/events/${eventId}/guests/${encodeURIComponent(p.code)}`, {
          arrived: !!p.checkedIn,
          eligible: !!p.checkedIn
        }).catch(()=>{});
      }
    };

    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '刪除';
    del.onclick = ()=>{
      state.people = state.people.filter(x => !(x.name===p.name && (x.dept||'')===(p.dept||'')));
      rebuildRemainingFromPeople();
      store.save(state);
      renderRosterList();
      updatePublicPanel();
      // (optional) cloud delete
      // if (p.code) FB.put(`/events/${eventId}/guests/${encodeURIComponent(p.code)}`, null).catch(()=>{});
    };

    tdOps.append(quick, toggle, del);

    tr.append(tdCode, tdName, tdDept, tdTable, tdSeat, tdStatus, tdOps);
    tbody.appendChild(tr);
  });

  // ---- pager status + buttons
  if (pageHint) pageHint.textContent = `第 ${pages === 0 ? 1 : state.rosterPage} / ${pages || 1} 頁`;
  if (rosterCount) {
    const from = filtered.length ? (start + 1) : 0;
    const to   = end;
    rosterCount.textContent = `共 ${filtered.length} 人 · 顯示 ${from}–${to}`;
  }
  if (prevPageBtn) prevPageBtn.disabled = (state.rosterPage <= 1);
  if (nextPageBtn) nextPageBtn.disabled = (state.rosterPage >= pages);
}


// === Sorting logic for roster ===
let rosterSort = { field: null, asc: true };

document.addEventListener('click', e=>{
  const btn = e.target.closest('.sortBtn');
  if (!btn) return;
  const field = btn.dataset.field;
  if (rosterSort.field === field) rosterSort.asc = !rosterSort.asc;
  else { rosterSort.field = field; rosterSort.asc = true; }

  state.people.sort((a,b)=>{
    const va = (a[field] ?? '').toString().toLowerCase();
    const vb = (b[field] ?? '').toString().toLowerCase();
    if (va < vb) return rosterSort.asc ? -1 : 1;
    if (va > vb) return rosterSort.asc ? 1 : -1;
    return 0;
  });
  store.save(state);
  renderRosterList();
});


    function renderEventsTable(){
        // --- CLOUD→LOCAL refresh for the 管理 table (non-blocking)
    // --- CLOUD→LOCAL refresh for the 管理 table (non-blocking; stays sync)
  if (!renderEventsTable._cloudRefreshing && typeof CLOUD !== 'undefined' && CLOUD.listEvents) {
    renderEventsTable._cloudRefreshing = true;
    try {
      CLOUD.listEvents().then(function(cloudList){
        cloudList = Array.isArray(cloudList) ? cloudList : [];

        // Merge cloud meta into local cache that your table already reads from
        var all = loadAll(); all.events = all.events || {};
        cloudList.forEach(function(m){
          if (!all.events[m.id]) {
            all.events[m.id] = { name:m.name, client:m.client, listed:(m.listed!==false), data: baseState() };
          } else {
            all.events[m.id].name   = m.name;
            all.events[m.id].client = m.client;
            all.events[m.id].listed = (m.listed!==false);
          }
        });
        saveAll(all);

        // repaint the table using your existing local-driven code
        renderEventsTable._cloudRefreshing = false;
        try { renderEventsTable(); } catch(_) {}
      }).catch(function(){
        renderEventsTable._cloudRefreshing = false;
      });
    } catch(_) {
      renderEventsTable._cloudRefreshing = false;
    }
  }


  if(!emTable) return;
  const q = (emSearch?.value || '').toLowerCase();
  const list = store.list().filter(it =>
    (it.name||'').toLowerCase().includes(q) || (it.client||'').toLowerCase().includes(q)
  );

  emTable.innerHTML = '';
  list.forEach(({id, name, client, listed})=>{
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.value = name || '';
    nameInput.style.minWidth = '200px';
    tdName.appendChild(nameInput);

    const tdClient = document.createElement('td');
    const clientInput = document.createElement('input');
    clientInput.value = client || '';
    clientInput.style.minWidth = '160px';
    tdClient.appendChild(clientInput);

    const tdId = document.createElement('td');
    tdId.textContent = id;

    const tdShow = document.createElement('td');
    const showCb = document.createElement('input');
    showCb.type = 'checkbox';
    showCb.checked = (listed !== false);
    showCb.title = '顯示於「活動清單」';
    showCb.onchange = ()=>{
      const all = loadAll();
      if (all.events[id]) {
        all.events[id].listed = !!showCb.checked;
        saveAll(all);
        // write-through to cloud meta
        try { CLOUD.writeMeta(id, {
          name:   all.events[id].name,
          client: all.events[id].client || '',
          listed: all.events[id].listed !== false
        }).catch(function(){}); } catch(_){}
        renderEventList();
        renderEventsTable();
      }
    };

    tdShow.appendChild(showCb);

    const tdOps = document.createElement('td');

    const switchBtn = document.createElement('button');
    switchBtn.className = 'btn';
    switchBtn.textContent = (id === store.current().id) ? '✓ 使用中' : '切換';
    switchBtn.disabled = (id === store.current().id);
    switchBtn.onclick = ()=>{
      if(id === store.current().id) return;
      store.switch(id);
      state = store.load();
      renderAll();
      setActivePage('pageEventsManage');
    };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.textContent = '💾 儲存';
    saveBtn.onclick = ()=>{
      const all = loadAll();
      if(all.events[id]){
        all.events[id].name   = nameInput.value.trim() || all.events[id].name;
        all.events[id].client = clientInput.value.trim();
        saveAll(all);
        // write-through to cloud meta
        try { CLOUD.writeMeta(id, {
          name:   all.events[id].name,
          client: all.events[id].client || '',
          listed: (all.events[id].listed !== false)
        }).catch(function(){}); } catch(_){}
        renderEventsTable();
        renderEventList();
      }
    };


    const duplicateBtn = document.createElement('button');
    duplicateBtn.className = 'btn';
    duplicateBtn.textContent = '🔁 複製';
    duplicateBtn.onclick = ()=>{
      const newId = cloneSpecificEvent(id, `${nameInput.value || '活動'}（副本）`);
      store.switch(newId);
      state = store.load();
      renderAll();
      setActivePage('pageEventsManage');
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn danger';
    deleteBtn.textContent = '刪除';
    deleteBtn.onclick = ()=>{
      if(!confirm('確定刪除此活動？（無法復原）')) return;
      const all = loadAll();
      delete all.events[id];
      const remainIds = Object.keys(all.events);
      all.currentId = remainIds[0] || null;
      saveAll(all);
      state = store.load();
      renderAll();
      setActivePage('pageEventsManage');
    };

    tdOps.append(switchBtn, saveBtn, duplicateBtn, deleteBtn);
    tr.append(tdName, tdClient, tdId, tdShow, tdOps);
    emTable.appendChild(tr);
  });
}

// === 投票（CMS）===
function renderPollAdmin(){
  // DOM refs inside the 投票 tab
  const listBox   = document.getElementById('pollList');
  const addBtn    = document.getElementById('addPoll');
  const delBtn    = document.getElementById('deletePoll');
  const qInput    = document.getElementById('pollQ');
  const optsBox   = document.getElementById('pollOptions');
  const addOptBtn = document.getElementById('addPollOpt');
  const saveBtn   = document.getElementById('savePoll');
  const setActive = document.getElementById('setActivePoll');
  const qrBox     = document.getElementById('pollQRBox');
  const openVote  = document.getElementById('openPollLanding');
  const activateRes = document.getElementById('activatePollResult'); 
  const badge     = document.getElementById('activePollBadge');
  const togglePublic = document.getElementById('togglePollPublic'); 
  const switchToDraw = document.getElementById('switchToDraw');


  if (!listBox) return; // page not visible yet

  // ensure structure
  state.polls = Array.isArray(state.polls) ? state.polls : [];
let _changed = false;
if (!state.currentPollId && state.polls[0]) { 
  state.currentPollId = state.polls[0].id; 
  _changed = true;
}
if (_changed) store.save(state);
    

  // keep a local selection (defaults to current)
  let selectedId = (renderPollAdmin._selectedId) || state.currentPollId || (state.polls[0]?.id || null);
  renderPollAdmin._selectedId = selectedId; // ← ADD

  function select(id){
    renderPollAdmin._selectedId = selectedId = id;
    drawList();
    drawEditor();
    drawQR();
  }

  function drawList(){
    listBox.innerHTML = '';
    state.polls.forEach(p=>{
      const row = document.createElement('label');
      row.className = 'bar';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';

      const left = document.createElement('div');
      left.className = 'bar';
      const rb = document.createElement('input');
      rb.type = 'radio'; rb.name = 'pollSel'; rb.checked = (p.id === selectedId);
      rb.onchange = ()=> select(p.id);
      const title = document.createElement('span');
      title.textContent = (p.question || '（未命名投票）');
      left.append(rb, title);

      const right = document.createElement('div');
      right.className = 'pill';
      right.textContent = (p.id === state.currentPollId) ? '目前投票' : '';

      row.append(left, right);
      listBox.appendChild(row);
    });
  }

  function drawEditor(){
    const cur = state.polls.find(p=>p.id===selectedId);
    // badge
    badge.textContent = (cur && cur.id === state.currentPollId) ? '目前投票' : '';

    // question
    qInput.value = cur?.question || '';

    // options
    optsBox.innerHTML = '';
    (cur?.options || []).forEach(opt=>{
      const line = document.createElement('div');
      line.className = 'bar';
      line.style.marginBottom = '6px';
      const inp = document.createElement('input');
      inp.style.minWidth = '260px';
      inp.value = opt.text || '';
      inp.oninput = ()=>{ opt.text = inp.value; };
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = '刪除';
      del.onclick = ()=>{
        cur.options = (cur.options || []).filter(o=>o.id !== opt.id);
        ensurePollVotes(cur);
        store.save(state);
        drawEditor(); drawQR();
      };
      line.append(inp, del);
      optsBox.appendChild(line);
    });

          // button states
      const enabled = !!cur;
      [delBtn, saveBtn, setActive, addOptBtn, openVote, activateRes, togglePublic].forEach(b=>{ if (b) b.disabled = !enabled; });

      // set label to reflect current show/hide state
      if (togglePublic) {
        togglePublic.textContent = state.showPollOnly ? '🔕 隱藏投票（公眾頁）' : '🔔 顯示投票（公眾頁）';
}
  }

  function drawQR(){
    const cur = state.polls.find(p=>p.id===selectedId);
    qrBox.innerHTML = '';
    if (!cur) return;
    try {
      new QRCode(qrBox, { text: pollURL(cur.id, 'poll'), width: 220, height: 220, correctLevel: window.QRCode?.CorrectLevel?.M || 0 });
    } catch {}
  }

  addBtn.onclick = ()=>{
  const p = { id: genPollId(), question: '新投票', options: [{id:genOptId(), text:'選項 1'}], votes:{} };
  state.polls.push(p);
  store.save(state);
  select(p.id);
};

  const publishNow   = document.getElementById('publishPollNow');
const pingFirebase = document.getElementById('pingFirebase');

if (pingFirebase) pingFirebase.onclick = async ()=>{
  const ts = Date.now();
  const url = `${FB.base}/__ping.json`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ts)
    });
    const out = await res.json();
    console.log('[FB ping] PUT', url, '→', res.status, out);
    alert('已寫入 Firebase：/__ping = ' + ts);
  } catch (e) {
    console.error('FB ping failed', e);
    alert('寫入失敗，請看 Console（Network 或 Console）');
  }
};


if (publishNow) publishNow.onclick = async ()=>{
  const cur = state.polls.find(p=>p.id===renderPollAdmin._selectedId);
  if (!cur) return alert('沒有選取投票');

  // ensure event id exists
  const eid = (store.current()?.id || state.id || state.eventId || '').trim();
  if (!eid) return alert('找不到 eventId，請先建立/選擇一個活動');

  // push poll + currentPollId
  await FB.put(`/events/${eid}/polls/${cur.id}`, {
    id: cur.id, question: cur.question, options: cur.options, votes: cur.votes || {}
  });
  if (state.currentPollId === cur.id) {
    await FB.put(`/events/${eid}/currentPollId`, cur.id);
  }
  alert('已發佈到雲端');
};

  delBtn.onclick = ()=>{
    const cur = state.polls.find(p=>p.id===selectedId);
    if (!cur) return;
    if (!confirm('刪除此投票？')) return;
    state.polls = state.polls.filter(p=>p.id !== cur.id);
    if (state.currentPollId === cur.id) state.currentPollId = state.polls[0]?.id || null;
    store.save(state);
    select(state.currentPollId || state.polls[0]?.id || null);
    renderActivePollQR();
  };

  addOptBtn.onclick = ()=>{
    const cur = state.polls.find(p=>p.id===selectedId);
    if (!cur) return;
    cur.options = cur.options || [];
    cur.options.push({ id: genOptId(), text: `選項 ${cur.options.length + 1}` });
    ensurePollVotes(cur);
    store.save(state);
    drawEditor(); drawQR();
  };

  if (switchToDraw) switchToDraw.onclick = ()=>{
  // Flip public screen back to lucky-draw stage (hide results and QR focus)
  try { bc && bc.postMessage({ type:'SHOW_DRAW', ts: Date.now() }); } catch {}
  state.showPollOnly = false; 
  store.save(state);
  alert('已切換回公眾頁的抽獎畫面');
};

  saveBtn.onclick = ()=>{
    const cur = state.polls.find(p=>p.id===selectedId);
    if (!cur) return;
    cur.question = qInput.value.trim() || '（未命名投票）';
    // clean empty options
    cur.options = (cur.options || []).filter(o => (o.text||'').trim().length);
    ensurePollVotes(cur);
    store.save(state);
    drawList(); drawEditor(); drawQR();
    FB.put(`/events/${store.current().id}/polls/${cur.id}`, {
      id: cur.id,
      question: cur.question,
      options: cur.options,
      votes: cur.votes || {}
    });
    alert('已儲存投票');
  };

  setActive.onclick = ()=>{
    const cur = state.polls.find(p=>p.id===selectedId);
    if (!cur) return;
    state.currentPollId = cur.id;
    state.showPollOnly = true;
    store.save(state);
    FB.put(`/events/${store.current().id}/currentPollId`, cur.id);
    FB.put(`/events/${store.current().id}/polls/${cur.id}`, {
      id: cur.id,
      question: cur.question,
      options: cur.options,
      votes: cur.votes || {}
    });
    drawList(); drawEditor(); renderActivePollQR();
    alert('已設為目前投票（公眾頁會顯示 QR）');
  };

  openVote.onclick = ()=>{
    const cur = state.polls.find(p=>p.id===selectedId);
    if (!cur) return;
    window.open(pollURL(cur.id, 'poll'), '_blank');
  };
  if (activateRes) activateRes.onclick = ()=>{
  const cur = state.polls.find(p=>p.id===selectedId);
  if (!cur) return alert('沒有選取投票');
  const eid = (store.current()?.id || '').trim();
  if (!eid) return alert('找不到 eventId，請先建立/選擇一個活動');

  // Tell the Public window to switch to results for this poll
  try { bc && bc.postMessage({ type:'SHOW_POLL_RESULT', eid, pid:cur.id, ts: Date.now() }); } catch {}

  // Optional: also flip the focus away from QR
  state.showPollOnly = false; store.save(state);

  alert('已在公眾頁啟用投票結果');
};


  if (togglePublic) {
  togglePublic.onclick = ()=>{
    state.showPollOnly = !state.showPollOnly;
    store.save(state);        // triggers BroadcastChannel -> other windows refresh
    updatePublicPanel();      // flips body 'poll-only' class + (re)draws QR row
    drawEditor();             // refresh button label
  };
}

  // initial paint
  drawList(); drawEditor(); drawQR();
}


// clone another event by id
function cloneSpecificEvent(sourceId, newName){
  const all = loadAll();
  const src = all.events[sourceId];
  if(!src){ return store.current().id; }
  const newId = genId();
  all.events[newId] = {
  name: newName || (src.name + '（副本）'),
  client: src.client || '',
  listed: (src.listed !== false),
  data: deepClone(src.data || baseState())
};
  saveAll(all);
  return newId;
}


function fillEventInfoForm(){
  const cur=store.current();
  currentEventName.textContent=cur.name||'—';
  currentClient.textContent='客戶：'+(cur.client||'—');
  currentIdLabel.textContent='ID：'+cur.id;
  evTitle.value=state.eventInfo.title||cur.name||'';
  evClient.value=cur.client||state.eventInfo.client||'';
  evDateTime.value=state.eventInfo.dateTime||'';
  evVenue.value=state.eventInfo.venue||'';
  evAddress.value=state.eventInfo.address||'';
  evMapUrl.value=state.eventInfo.mapUrl||'';
  evBus.value=state.eventInfo.bus||'';
  evTrain.value=state.eventInfo.train||'';
  evParking.value=state.eventInfo.parking||'';
  evNotes.value=state.eventInfo.notes||'';
}

function rebuildPagesSelect(){ if(!pageSelect) return; pageSelect.innerHTML=''; state.pages.forEach(p=>{ const o=document.createElement('option'); o.value=p.id; o.textContent=`第 ${p.id} 頁`; if(p.id===state.currentPage) o.selected=true; pageSelect.appendChild(o); }); }

// Failsafe: ensure the ping button is bound even if renderPollAdmin hasn't run yet
const _pfb = document.getElementById('pingFirebase');
if (_pfb && !_pfb._wired) {
  _pfb._wired = true;
  _pfb.addEventListener('click', async ()=>{
    const ts = Date.now();
    try {
      const res = await fetch(`${FB.base}/__ping.json`, {
        method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(ts)
      });
      await res.json();
      alert('已寫入 Firebase：/__ping = ' + ts);
    } catch (e) {
      console.error('FB ping (boot) failed', e);
      alert('寫入失敗，請看 Console');
    }
  });
}

// If this window is opened as the Public "results" URL, boot it now.
try{
  const q = urlParams();
  if (location.hash === '#public' && q.view === 'result' && q.event && q.poll){
  if (!pollReveal || !pollReveal.timer) {
    $('tabPublic').click();
    state.showPollOnly = false;
    store.save(state);
    startPublicPollResults(q.event, q.poll);
  }
}

}catch{}

function renderAll(){
  renderBG(); renderLogo(); renderBanner();
  renderPrizes(); /* renderTiles(); */ renderRosterList(); rebuildPagesSelect();
  updatePublicPanel(); renderEventList(); fillEventInfoForm();
  pageSize2 && (pageSize2.value = state.pageSize);
  updateLandingLink(); renderQR(); updateFullStageLink();
  renderSnapshots();  renderEventsTable();
  renderRerollList();
  renderPollAdmin();


  if(!document.querySelector('.nav-item.active')) setActivePage('pageEvent');
}

/* === Users (Firebase RTDB) : Create / List / Delete ======================== */
/* This block is self-contained and uses the Firebase compat SDK you already
   initialize in index.html (window.rtdb). It also gracefully no-ops if that
   SDK is not present. */

(function initUsersPage(){
  // Bail if Firebase isn’t available or the page section doesn’t exist
  const hasFB = !!(window.rtdb && window.firebase);
  const section = document.getElementById('pageUsers');
  if (!section) return;

  const els = {
    email: document.getElementById('newUserEmail'),
    pass:  document.getElementById('newUserPassword'),
    role:  document.getElementById('newUserRole'),
    btn:   document.getElementById('createUser'),
    table: document.getElementById('userTable')
  };

  // Hard guard: prevent using this page if Firebase is not configured
  function guardFirebase(){
    if (hasFB) return true;
    if (els.btn) {
      els.btn.disabled = true;
      els.btn.title = 'Firebase 尚未初始化（請先在 index.html 填入 Firebase 設定）';
    }
    return false;
  }

  // Render the table rows from a /users snapshot object
    function renderUsers(obj){
      if (!els.table) return;
      els.table.innerHTML = '';
      const users = Object.values(obj || {});
      if (users.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="4" class="pill">尚未建立用戶</td>`;
        els.table.appendChild(tr);
        return;
      }
      users.forEach(u=>{
        const eventsStr = Array.isArray(u.events) ? u.events.join(',') : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${u.email || ''}</td>
          <td>${u.role  || 'client'}</td>
          <td>
            <div class="bar" style="gap:6px; align-items:center">
              <span class="pill" data-evlist="${u.id || ''}">${eventsStr || '(未設定)'}</span>
              <button class="btn" data-edit-events="${u.id || ''}">編輯授權</button>
            </div>
          </td>
          <td><button class="btn danger" data-del="${u.id||''}">刪除</button></td>`;
        els.table.appendChild(tr);
      });
    }

  // Read once (or when re-entering the tab)
  async function loadUsers(){
    if (!guardFirebase()) return;
    const snap = await rtdb.ref('/users').once('value');
    renderUsers(snap.val() || {});
  }

  // Live updates (optional but nice): keep the table in sync while on the tab
  let usersListenerOn = false;
  function attachLiveListener(){
    if (!guardFirebase() || usersListenerOn) return;
    usersListenerOn = true;
    rtdb.ref('/users').on('value', (snap)=> renderUsers(snap.val() || {}));
  }
  function detachLiveListener(){
    if (!guardFirebase() || !usersListenerOn) return;
    usersListenerOn = false;
    rtdb.ref('/users').off();
  }
  // Helper: return a list of event IDs currently in the sidebar DOM (fallback to [])
  function getAllEventIdsFromUI(){
    const ids = [];
    document.querySelectorAll('.event-item').forEach(item=>{
      const id = item.getAttribute('data-id') || item.dataset.id || item.dataset.eid || '';
      if (id && !ids.includes(id)) ids.push(id);
    });
    return ids;
  }

  // Create user (stores **email, password (plain), role, events:[]**)
  async function createUser(){
    if (!guardFirebase()) return;
    const email = (els.email?.value || '').trim();
    const pass  = (els.pass?.value  || '').trim();
    const role  = (els.role?.value  || 'client');

    if (!email || !pass) { alert('請輸入帳號與密碼'); return; }

    // push-like id
    const id = rtdb.ref('/users').push().key;
    await rtdb.ref(`/users/${id}`).set({ id, email, password: pass, role, events: [] });

    // clear inputs
    if (els.email) els.email.value = '';
    if (els.pass)  els.pass.value  = '';
    if (els.role)  els.role.value  = 'client';

    // refresh (render will also run by live listener if attached)
    await loadUsers();
    alert('✅ 已建立用戶');
  }

  // Delete user
  document.addEventListener('click', async (evt)=>{
    const btn = evt.target.closest('button[data-del]');
    if (!btn) return;
    if (!guardFirebase()) return;
    const id = btn.getAttribute('data-del');
    if (!id) return;
    if (!confirm('確定刪除此用戶？')) return;
    await rtdb.ref(`/users/${id}`).set(null);
    // live listener updates table; also force refresh
    await loadUsers();
  });

  // Edit per-user allowed events
document.addEventListener('click', async (e)=>{
  const btn = e.target.closest('button[data-edit-events]');
  if (!btn) return;
  if (!guardFirebase()) return;

  const id = btn.getAttribute('data-edit-events');
  if (!id) return;

  // Read current user
  const snap = await rtdb.ref(`/users/${id}`).once('value');
  const user = snap.val() || {};
  const current = Array.isArray(user.events) ? user.events : [];

  // Build a hint string of available event IDs from the sidebar DOM
  const available = getAllEventIdsFromUI();
  const hint = available.length ? `（可用：${available.join(', ')}）` : '';

  // Prompt for comma-separated event IDs
  const nextStr = prompt(`輸入此用戶可訪問的活動ID（逗號分隔）${hint}`, current.join(','));
  if (nextStr === null) return; // cancelled

  const next = nextStr.split(',')
    .map(s=>s.trim())
    .filter(Boolean);

  await rtdb.ref(`/users/${id}/events`).set(next);
  // Update the visible text
  const pill = document.querySelector(`[data-evlist="${id}"]`);
  if (pill) pill.textContent = next.length ? next.join(',') : '(未設定)';
});

  // Wire the create button
  if (els.btn) els.btn.addEventListener('click', createUser);

  // Load users the first time this subpage becomes visible
  // Your CMS left-nav uses .nav-item[data-target], so hook that:
  const nav = document.getElementById('cmsNav');
  if (nav) {
    nav.addEventListener('click', (e)=>{
      const b = e.target.closest('.nav-item');
      if (!b) return;
      const target = b.getAttribute('data-target');
      if (target === 'pageUsers') {
        loadUsers();
        attachLiveListener();
      } else {
        // leaving the page — optional: stop listening
        detachLiveListener();
      }
    });
  }

  // If the page is already visible at load (rare), render once.
  if (section.style.display !== 'none') {
    loadUsers();
    attachLiveListener();
  }

  
})();
