// eventData.js — Canonical cloud data layer (Firebase RTDB only)
// Replaces any localStorage usage for event details across the app.

(function () {
  // --- RTDB REST helpers (same base used across the project) ---
  const FB = {
    base: 'https://luckydrawpolls-default-rtdb.asia-southeast1.firebasedatabase.app',
    url: (p) => `${FB.base}${p}.json`,
    get:   (p)   => fetch(FB.url(p)).then(r => r.json()),
    put:   (p,b) => fetch(FB.url(p), { method:'PUT',   headers:{'Content-Type':'application/json'}, body: JSON.stringify(b) }).then(r => r.json()),
    patch: (p,b) => fetch(FB.url(p), { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b) }).then(r => r.json()),
    del:   (p)   => fetch(FB.url(p), { method:'DELETE' }).then(r => r.json())
  };

  // A minimal "base state" to seed a brand-new event in the cloud
  function baseData(){
    return {
      people: [],               // roster (checkedIn computed client-side)
      remaining: [],            // UI working set (optional; can be recomputed)
      winners: [],
      bg: null, logo: null, banner: null,
      pageSize: 50, rosterPage: 1, pages: [{id:1}], currentPage: 1,
      lastConfirmed: null, lastPick: null, currentBatch: [],
      prizes: [], currentPollId: null,
      eventInfo: { title:'', client:'', dateTime:'', venue:'', address:'', mapUrl:'', bus:'', train:'', parking:'', notes:'' },
      questions: [],
      rerolls: [],
      polls: []                 // [{id, question, options:[{id,text}], votes:{[optId]:number}}]
    };
  }

  // --- Event-level primitives (meta + data) ---
  async function listEvents(){
    // Returns [{ id, name, client, listed:true|false }] from /events
    const obj = await FB.get(`/events`) || {};
    return Object.keys(obj).map(id => ({
      id,
      name:   obj[id]?.name   || '',
      client: obj[id]?.client || '',
      listed: (obj[id]?.listed !== false)
    }));
  }

  async function createEvent(name='新活動', client=''){
    // Generates an id, creates /events/<id> with {meta + data}, returns {id}
    const id = genId();
    const payload = { name, client, listed:true, data: baseData() };
    await FB.put(`/events/${encodeURIComponent(id)}`, payload);
    return { id };
  }

  async function deleteEvent(eventId){
    if (!eventId) throw new Error('deleteEvent: missing eventId');
    return FB.del(`/events/${encodeURIComponent(eventId)}`);
  }

  async function readEvent(eventId){
    if (!eventId) return null;
    const node = await FB.get(`/events/${encodeURIComponent(eventId)}`);
    if (!node) return null;
    const name = node.name || '';
    const data = (node.data && typeof node.data === 'object') ? node.data : node;
    return { id: eventId, name, data };
  }

  async function writeEvent(eventId, dataObject){
    if (!eventId) throw new Error('writeEvent: missing eventId');
    return FB.put(`/events/${encodeURIComponent(eventId)}/data`, dataObject || {});
  }

  async function patchEventData(eventId, partial){
    if (!eventId) throw new Error('patchEventData: missing eventId');
    return FB.patch(`/events/${encodeURIComponent(eventId)}/data`, partial || {});
  }

  async function readEventMeta(eventId){
    if (!eventId) throw new Error('readEventMeta: missing eventId');
    const node = await FB.get(`/events/${encodeURIComponent(eventId)}`);
    return { name: node?.name || '', client: node?.client || '', listed: (node?.listed !== false) };
  }

  async function patchEventMeta(eventId, partialMeta){
    if (!eventId) throw new Error('patchEventMeta: missing eventId');
    const allowed = {};
    if (typeof partialMeta?.name   === 'string') allowed.name   = partialMeta.name;
    if (typeof partialMeta?.client === 'string') allowed.client = partialMeta.client;
    if (typeof partialMeta?.listed === 'boolean') allowed.listed = partialMeta.listed;
    if (Object.keys(allowed).length === 0) return null;
    return FB.patch(`/events/${encodeURIComponent(eventId)}`, allowed);
  }

  // --- Field-level helpers (operate inside /events/<id>/data/*) ---
  async function readField(eventId, field){
    if (!eventId || !field) throw new Error('readField: missing args');
    return FB.get(`/events/${encodeURIComponent(eventId)}/data/${field}`);
  }

  async function writeField(eventId, field, value){
    if (!eventId || !field) throw new Error('writeField: missing args');
    return FB.put(`/events/${encodeURIComponent(eventId)}/data/${field}`, value);
  }

  async function patchField(eventId, field, partial){
    if (!eventId || !field) throw new Error('patchField: missing args');
    return FB.patch(`/events/${encodeURIComponent(eventId)}/data/${field}`, partial);
  }

  // --- Guests & polls convenience (these were already partly cloud-backed elsewhere) ---
  async function upsertGuests(eventId, guestsByKey){
    // guestsByKey: { [guestKey]: {name, dept, table, seat, arrived, eligible, receivedGift, gift? } }
    if (!eventId) throw new Error('upsertGuests: missing eventId');
    return FB.patch(`/events/${encodeURIComponent(eventId)}/guests`, guestsByKey || {});
  }

  async function getGuests(eventId){
    if (!eventId) throw new Error('getGuests: missing eventId');
    return (await FB.get(`/events/${encodeURIComponent(eventId)}/guests`)) || {};
  }

  async function putPoll(eventId, poll){
    // poll: { id, question, options, votes?{} }
    if (!eventId || !poll?.id) throw new Error('putPoll: missing args');
    return FB.put(`/events/${encodeURIComponent(eventId)}/polls/${poll.id}`, {
      id: poll.id, question: poll.question || '', options: poll.options || [], votes: poll.votes || {}
    });
  }

  async function setCurrentPoll(eventId, pollId){
    if (!eventId) throw new Error('setCurrentPoll: missing eventId');
    return FB.put(`/events/${encodeURIComponent(eventId)}/currentPollId`, pollId || null);
  }

  // --- ID generator (compatible with your existing pattern) ---
  function genId(){
    // 8–10 char base36-ish id
    return Math.random().toString(36).slice(2, 10);
  }

  // Expose on window (no modules)
  window.EventData = {
    // meta & lifecycle
    listEvents, createEvent, deleteEvent,
    readEvent, writeEvent, patchEventData,
    readEventMeta, patchEventMeta,

    // field-level
    readField, writeField, patchField,

    // guests & polls conveniences
    upsertGuests, getGuests, putPoll, setCurrentPoll,

    // low-level handle (used by landing/vote already)
    _fb: FB
  };
})();
