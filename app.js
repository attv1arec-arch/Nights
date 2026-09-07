const DB = 'WalkMemory';
const VER = 2;
const SETTINGS_KEY = 'walkMemoryV3Settings';

let db;
let map, routeLayer, landmarkLayer, meMarker, liveLine;
let walkModalMap, walkModalLayer;
let watchId = null, nativeWatchId = null, timer = null;
let startAt = 0, meters = 0, points = [], lastPoint = null, currentWalkUid = null;
let editingLandmarkId = null, editingPhotos = [];
let sharedSnapshot = null, syncTimer = null;
let settings = loadSettings();
let viewerMode = false;
let viewerRoom = '';
let viewerApiBase = '';


const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const now = () => Date.now();

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function safeImageSrc(value) {
  const s = String(value || '');
  if (/^data:image\//i.test(s) || /^https?:\/\//i.test(s)) return s.replace(/"/g, '&quot;');
  return '';
}
function dist(a, b) {
  const R = 6371000, p = Math.PI / 180;
  const d1 = (b.lat - a.lat) * p, d2 = (b.lon - a.lon) * p;
  const q = Math.sin(d1/2)**2 + Math.cos(a.lat*p) * Math.cos(b.lat*p) * Math.sin(d2/2)**2;
  return 2 * R * Math.asin(Math.sqrt(q));
}
function ft(ms) {
  let s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600);
  s %= 3600; const m = Math.floor(s / 60); s %= 60;
  return [h,m,s].map(x => String(x).padStart(2,'0')).join(':');
}
function mi(m) { return (Number(m || 0) / 1609.344).toFixed(2); }
function formatDate(ts) { return ts ? new Date(ts).toLocaleString() : 'Unknown date'; }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      ['walks','landmarks','visits'].forEach(store => {
        if (!d.objectStoreNames.contains(store)) d.createObjectStore(store, {keyPath:'id', autoIncrement:true});
      });
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}
const store = (name, mode='readonly') => db.transaction(name, mode).objectStore(name);
const all = name => new Promise((resolve,reject) => { const r=store(name).getAll(); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
const get = (name,id) => new Promise((resolve,reject) => { const r=store(name).get(id); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
const put = (name,value) => new Promise((resolve,reject) => { const r=store(name,'readwrite').put(value); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
const remove = (name,id) => new Promise((resolve,reject) => { const r=store(name,'readwrite').delete(id); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); });
const clearStore = name => new Promise((resolve,reject) => { const r=store(name,'readwrite').clear(); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); });

async function migrateData() {
  const walks = await all('walks');
  const landmarks = await all('landmarks');
  const walkById = new Map();
  const landmarkById = new Map();
  for (const w of walks) {
    let dirty = false;
    if (!w.uid) { w.uid = uid(); dirty = true; }
    if (!w.updatedAt) { w.updatedAt = w.date || now(); dirty = true; }
    if (!Array.isArray(w.points)) { w.points = []; dirty = true; }
    walkById.set(w.id, w.uid);
    if (dirty) await put('walks', w);
  }
  for (const l of landmarks) {
    let dirty = false;
    if (!l.uid) { l.uid = uid(); dirty = true; }
    if (!l.updatedAt) { l.updatedAt = now(); dirty = true; }
    if (!Array.isArray(l.photos)) { l.photos = l.photo ? [l.photo] : []; dirty = true; }
    if (!l.photo && l.photos[0]) { l.photo = l.photos[0]; dirty = true; }
    landmarkById.set(l.id, l.uid);
    if (dirty) await put('landmarks', l);
  }
  for (const v of await all('visits')) {
    let dirty = false;
    if (!v.uid) { v.uid = uid(); dirty = true; }
    if (!v.landmarkUid && v.landmarkId != null && landmarkById.has(v.landmarkId)) { v.landmarkUid = landmarkById.get(v.landmarkId); dirty = true; }
    if (!v.walkUid && v.walkId && walkById.has(v.walkId)) { v.walkUid = walkById.get(v.walkId); dirty = true; }
    if (!v.updatedAt) { v.updatedAt = v.date || now(); dirty = true; }
    if (dirty) await put('visits', v);
  }
}

async function localSnapshot() {
  return {version:3, walks:await all('walks'), landmarks:await all('landmarks'), visits:await all('visits')};
}
async function displaySnapshot() {
  return viewerMode ? (sharedSnapshot || {walks:[],landmarks:[],visits:[]}) : await localSnapshot();
}

async function initMap() {
  map = L.map('mapbox').setView([42.59,-72.60], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'© OpenStreetMap contributors', maxZoom:19}).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  landmarkLayer = L.layerGroup().addTo(map);
  await renderMap();
}

async function renderMap() {
  if (!map) return;
  routeLayer.clearLayers(); landmarkLayer.clearLayers();
  const data = await displaySnapshot();
  for (const w of data.walks || []) {
    if ((w.points || []).length > 1) {
      const line = L.polyline(w.points.map(p => [p.lat,p.lon]), {weight:4, opacity:.72}).addTo(routeLayer);
      line.bindTooltip(esc(w.title || 'Walk'));
    }
  }
  for (const l of data.landmarks || []) {
    const src = safeImageSrc(l.photo || (l.photos || [])[0]);
    const html = src ? `<img src="${src}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid white;box-shadow:0 2px 8px #0008">` : '<div style="font-size:28px">⭐</div>';
    const icon = L.divIcon({html, className:'', iconSize:[44,44], iconAnchor:[22,22]});
    L.marker([l.lat,l.lon], {icon})
      .bindPopup(`<b>${esc(l.name)}</b><br>${esc(l.desc || '')}<br><small>Radius ${Number(l.radius || 50)} m</small>`)
      .addTo(landmarkLayer);
  }
}

function tick() {
  const duration = startAt ? now() - startAt : 0;
  $('duration').textContent = ft(duration);
  $('distance').textContent = `${mi(meters)} mi`;
  $('pace').textContent = meters > 0 ? `${((duration/60000)/(meters/1609.344)).toFixed(1)} min/mi` : '—';
}

function renderLive() {
  if (!lastPoint || !map) return;
  if (!meMarker) meMarker = L.circleMarker([lastPoint.lat,lastPoint.lon], {radius:7}).addTo(map);
  meMarker.setLatLng([lastPoint.lat,lastPoint.lon]);
  if (liveLine) map.removeLayer(liveLine);
  if (points.length > 1) liveLine = L.polyline(points.map(p => [p.lat,p.lon]), {weight:5}).addTo(map);
}

async function checkLandmarks(p, walkUid) {
  const landmarks = await all('landmarks');
  const visits = await all('visits');
  for (const l of landmarks) {
    if (dist(p,l) <= Number(l.radius || 50)) {
      const recent = visits.some(v => v.landmarkUid === l.uid && now() - Number(v.date || 0) < 3600000);
      if (!recent) await put('visits', {uid:uid(), landmarkUid:l.uid, walkUid, date:now(), updatedAt:now()});
    }
  }
}

async function acceptPosition(coords, timestamp=now()) {
  const accuracy = Number(coords.accuracy ?? 9999);
  $('gpsDetail').textContent = Number.isFinite(accuracy) ? `GPS accuracy: ±${Math.round(accuracy)} m` : 'GPS active';
  if (accuracy > 80) {
    $('state').textContent = `Waiting for a better GPS fix (±${Math.round(accuracy)} m)…`;
    return;
  }
  const p = {
    lat:Number(coords.latitude), lon:Number(coords.longitude), t:Number(timestamp || now()),
    accuracy, altitude:coords.altitude == null ? null : Number(coords.altitude),
    speed:coords.speed == null ? null : Number(coords.speed)
  };
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
  if (lastPoint) {
    const d = dist(lastPoint,p);
    const seconds = Math.max(.001,(p.t-lastPoint.t)/1000);
    const calculatedSpeed = d/seconds;
    const minMovement = Math.max(2, Math.min(8,(accuracy + Number(lastPoint.accuracy || accuracy)) * .06));
    if (d < minMovement) return;
    if (calculatedSpeed > 12 && (p.speed == null || p.speed > 12)) return;
    meters += d;
  }
  points.push(p); lastPoint = p;
  $('state').textContent = 'Tracking GPS…';
  renderLive(); tick();
  await checkLandmarks(p, currentWalkUid);
}

function nativeBridgeAvailable() {
  try { return !!(window.WalkMemoryNative && window.WalkMemoryNative.isAvailable && window.WalkMemoryNative.isAvailable()); }
  catch { return false; }
}

async function startTracking() {
  if (viewerMode) return alert('Shared links are read-only. Exit shared view to record your own walk.');
  meters=0; points=[]; lastPoint=null; startAt=now(); currentWalkUid=uid();
  $('start').disabled=true; $('stop').disabled=false; $('state').textContent='Starting GPS…'; tick();
  timer=setInterval(tick,1000);

  if (nativeBridgeAvailable()) {
    $('backgroundNote').textContent='Native background GPS is active. Tracking can continue while the app is backgrounded or the screen is locked, subject to phone permission/battery settings.';
    $('backgroundNote').classList.remove('hidden');
    try {
      nativeWatchId = await window.WalkMemoryNative.start(
        loc => acceptPosition({latitude:loc.latitude,longitude:loc.longitude,accuracy:loc.accuracy,altitude:loc.altitude,speed:loc.speed}, loc.time),
        err => { $('state').textContent=`GPS: ${err?.message || err}`; }
      );
      return;
    } catch (err) {
      $('backgroundNote').textContent='Native background tracker failed; using browser GPS instead.';
    }
  }

  if (!navigator.geolocation) { resetTrackingUI(); return alert('GPS is unavailable in this browser.'); }
  $('backgroundNote').textContent='Browser/PWA mode: high-accuracy GPS is enabled, but mobile browsers may pause location updates when the screen is locked or the app is fully backgrounded. Use the included native wrapper for reliable background tracking.';
  $('backgroundNote').classList.remove('hidden');
  watchId = navigator.geolocation.watchPosition(
    pos => acceptPosition(pos.coords,pos.timestamp),
    err => { $('state').textContent=`GPS: ${err.message}`; },
    {enableHighAccuracy:true, maximumAge:0, timeout:20000}
  );
}

async function stopTracking() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId=null; }
  if (nativeWatchId !== null && window.WalkMemoryNative?.stop) {
    try { await window.WalkMemoryNative.stop(nativeWatchId); } catch {}
    nativeWatchId=null;
  }
  clearInterval(timer); timer=null;
  if (points.length < 2) { resetTrackingUI(); return alert('Not enough accurate GPS points to save this walk.'); }
  const title = prompt('Name this walk:', `Walk ${new Date(startAt).toLocaleDateString()}`) || 'Walk';
  await put('walks', {uid:currentWalkUid, date:startAt, duration:now()-startAt, distance:meters, title, points:[...points], updatedAt:now()});
  $('state').textContent='Saved!';
  resetTrackingUI();
  await refreshAll();
  scheduleSync();
}

function resetTrackingUI() {
  $('start').disabled=viewerMode; $('stop').disabled=true;
  $('distance').textContent='0.00 mi'; $('duration').textContent='00:00:00'; $('pace').textContent='—';
  points=[]; lastPoint=null; meters=0; startAt=0; currentWalkUid=null;
  if (liveLine && map) { map.removeLayer(liveLine); liveLine=null; }
}

async function locateMe() {
  if (!navigator.geolocation) return alert('GPS unavailable.');
  navigator.geolocation.getCurrentPosition(
    p => map.setView([p.coords.latitude,p.coords.longitude],16),
    e => alert(e.message),
    {enableHighAccuracy:true,maximumAge:0,timeout:15000}
  );
}

function closeModal(id) { $(id).classList.add('hidden'); }

async function openNewLandmark() {
  if (viewerMode) return alert('Shared links are read-only.');
  const open = (lat,lon) => openLandmarkEditor({lat,lon,name:'',desc:'',radius:50,photos:[]}, null);
  if(!navigator.geolocation){const lat=prompt('Latitude?'),lon=prompt('Longitude?');if(lat&&lon&&Number.isFinite(+lat)&&Number.isFinite(+lon))open(+lat,+lon);return;}
  navigator.geolocation.getCurrentPosition(
    p => open(p.coords.latitude,p.coords.longitude),
    () => {
      const lat = prompt('Latitude?'), lon = prompt('Longitude?');
      if (lat && lon && Number.isFinite(+lat) && Number.isFinite(+lon)) open(+lat,+lon);
    },
    {enableHighAccuracy:true,maximumAge:0,timeout:12000}
  );
}

async function openLandmarkById(id) {
  if (viewerMode) return;
  const l = await get('landmarks', Number(id));
  if (l) openLandmarkEditor(l,l.id);
}

function openLandmarkEditor(l,id) {
  editingLandmarkId=id; editingPhotos=[...(l.photos || (l.photo ? [l.photo] : []))];
  $('lmTitle').textContent=id ? 'Edit landmark' : 'Add landmark';
  $('lmName').value=l.name || ''; $('lmDesc').value=l.desc || ''; $('lmRadius').value=String(l.radius || 50);
  $('lmLat').value=l.lat; $('lmLon').value=l.lon; $('lmId').value=id || '';
  $('lmPhotos').value=''; $('deleteLandmark').classList.toggle('hidden',!id);
  renderPhotoGallery(); $('landmarkModal').classList.remove('hidden');
}

function renderPhotoGallery() {
  $('photoGallery').innerHTML = editingPhotos.length ? editingPhotos.map((src,i)=>`<div class="photo-item"><img src="${safeImageSrc(src)}" alt="Landmark photo"><button type="button" data-photo-remove="${i}" aria-label="Remove photo">×</button></div>`).join('') : '<div class="muted">No photos yet.</div>';
  document.querySelectorAll('[data-photo-remove]').forEach(b => b.onclick=()=>{ editingPhotos.splice(Number(b.dataset.photoRemove),1); renderPhotoGallery(); });
}

function readPhoto(file) {
  return new Promise((resolve,reject) => {
    const fr=new FileReader();
    fr.onerror=()=>reject(fr.error); fr.onload=()=>{
      const img=new Image();
      img.onerror=()=>resolve(fr.result);
      img.onload=()=>{
        const max=1280, scale=Math.min(1,max/Math.max(img.width,img.height));
        const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.round(img.width*scale)); canvas.height=Math.max(1,Math.round(img.height*scale));
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        resolve(canvas.toDataURL('image/jpeg',.84));
      };
      img.src=fr.result;
    };
    fr.readAsDataURL(file);
  });
}

async function addSelectedPhotos() {
  for (const file of [...$('lmPhotos').files]) {
    if (!file.type.startsWith('image/')) continue;
    try { editingPhotos.push(await readPhoto(file)); } catch {}
  }
  $('lmPhotos').value=''; renderPhotoGallery();
}

async function saveLandmark(e) {
  e.preventDefault();
  const existing = editingLandmarkId ? await get('landmarks',editingLandmarkId) : null;
  const record = {
    ...(existing || {}), uid:existing?.uid || uid(), name:$('lmName').value.trim(), desc:$('lmDesc').value.trim(),
    radius:Number($('lmRadius').value), lat:Number($('lmLat').value), lon:Number($('lmLon').value),
    photos:[...editingPhotos], photo:editingPhotos[0] || '', updatedAt:now()
  };
  if (editingLandmarkId) record.id=editingLandmarkId;
  await put('landmarks',record); closeModal('landmarkModal');
  await refreshAll(); scheduleSync();
}

async function deleteCurrentLandmark() {
  if (!editingLandmarkId) return;
  const l=await get('landmarks',editingLandmarkId); if(!l) return;
  if (!confirm(`Delete “${l.name}” and its visit history?`)) return;
  await remove('landmarks',editingLandmarkId);
  for (const v of await all('visits')) if (v.landmarkUid===l.uid || v.landmarkId===l.id) await remove('visits',v.id);
  closeModal('landmarkModal'); await refreshAll(); scheduleSync();
}

async function renderLists() {
  const data=await displaySnapshot();
  const ls=[...(data.landmarks||[])], ws=[...(data.walks||[])], vs=[...(data.visits||[])];
  ls.sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  $('landmarkList').innerHTML = ls.length ? ls.map(l=>{
    const src=safeImageSrc(l.photo || (l.photos||[])[0]);
    const media=src?`<img src="${src}" alt="">`:'<div class="placeholder">⭐</div>';
    const count=vs.filter(v=>v.landmarkUid===l.uid || (v.landmarkId!=null&&v.landmarkId===l.id)).length;
    const idAttr = viewerMode ? '' : ` data-landmark-id="${l.id}"`;
    return `<div class="card landmark ${viewerMode?'viewer-only':'clickable'}"${idAttr}>${media}<div class="landmark-body"><div class="landmark-title">${esc(l.name)}${viewerMode?'<span class="shared-tag">shared</span>':''}</div><div>${esc(l.desc||'')}</div><small>${count} visits · ${Number(l.radius||50)} m radius · ${(l.photos||[]).length} photo${(l.photos||[]).length===1?'':'s'}</small></div></div>`;
  }).join('') : '<div class="empty">No landmarks yet.</div>';
  document.querySelectorAll('[data-landmark-id]').forEach(el=>el.onclick=()=>openLandmarkById(el.dataset.landmarkId));

  const total=ws.reduce((a,w)=>a+Number(w.distance||0),0), longest=Math.max(0,...ws.map(w=>Number(w.distance||0)));
  $('statsGrid').innerHTML=[['Walks',ws.length],['Miles',mi(total)],['Longest',`${mi(longest)} mi`],['Landmark visits',vs.length]].map(([label,value])=>`<div class="card"><div class="stat">${value}</div><div class="muted">${label}</div></div>`).join('');
  ws.sort((a,b)=>Number(b.date||0)-Number(a.date||0));
  $('walkList').innerHTML=ws.length?ws.map(w=>`<div class="card clickable" data-walk-uid="${esc(w.uid)}"><div class="walk-row"><div><b>${esc(w.title||'Walk')}</b>${viewerMode?'<span class="shared-tag">shared</span>':''}<br>${mi(w.distance)} mi · ${ft(w.duration)}</div><div class="muted">${esc(formatDate(w.date))}<br>${(w.points||[]).length} GPS points</div></div></div>`).join(''):'<div class="empty">No saved walks yet.</div>';
  document.querySelectorAll('[data-walk-uid]').forEach(el=>el.onclick=()=>openWalk(el.dataset.walkUid));
}

async function openWalk(walkUid) {
  const data=await displaySnapshot(); const w=(data.walks||[]).find(x=>x.uid===walkUid); if(!w) return;
  $('walkModalTitle').textContent=w.title||'Walk';
  $('walkMeta').textContent=`${mi(w.distance)} mi · ${ft(w.duration)} · ${formatDate(w.date)} · ${(w.points||[]).length} GPS points`;
  $('walkModal').classList.remove('hidden');
  setTimeout(()=>{
    if (!walkModalMap) {
      walkModalMap=L.map('walkMap').setView([42.59,-72.60],13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors',maxZoom:19}).addTo(walkModalMap);
      walkModalLayer=L.layerGroup().addTo(walkModalMap);
    }
    walkModalLayer.clearLayers(); walkModalMap.invalidateSize();
    const coords=(w.points||[]).filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))).map(p=>[Number(p.lat),Number(p.lon)]);
    if(coords.length){
      const line=L.polyline(coords,{weight:5}).addTo(walkModalLayer);
      L.circleMarker(coords[0],{radius:6}).bindTooltip('Start').addTo(walkModalLayer);
      if(coords.length>1)L.circleMarker(coords[coords.length-1],{radius:6}).bindTooltip('End').addTo(walkModalLayer);
      walkModalMap.fitBounds(line.getBounds(),{padding:[24,24],maxZoom:18});
    }
  },60);
}

function downloadJSON(data, filename) {
  const a=document.createElement('a'); const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function exportFull() {
  const d=await localSnapshot(); downloadJSON({...d,type:'full',exported:new Date().toISOString()},`walk-memory-full-${new Date().toISOString().slice(0,10)}.json`);
}
async function exportWalks() {
  downloadJSON({version:3,type:'walks',exported:new Date().toISOString(),walks:await all('walks')},`walk-memory-walks-${new Date().toISOString().slice(0,10)}.json`);
}
async function exportLandmarks() {
  const landmarks=await all('landmarks'), landmarkUids=new Set(landmarks.map(l=>l.uid));
  const visits=(await all('visits')).filter(v=>landmarkUids.has(v.landmarkUid));
  downloadJSON({version:3,type:'landmarks',exported:new Date().toISOString(),landmarks,visits},`walk-memory-landmarks-${new Date().toISOString().slice(0,10)}.json`);
}

async function upsertImported(storeName, record) {
  const clean={...record}; delete clean.id;
  if(!clean.uid) clean.uid=uid(); clean.updatedAt=clean.updatedAt||now();
  const existing=(await all(storeName)).find(x=>x.uid===clean.uid);
  if(existing) clean.id=existing.id;
  return put(storeName,clean);
}

async function importFile(file, kind) {
  if(!file)return;
  try{
    const d=JSON.parse(await file.text());
    const walkIdToUid=new Map(), landmarkIdToUid=new Map();
    const importWalkSet=async records=>{
      for(const original of records||[]){
        const x={...original};
        if(!x.uid)x.uid=uid();
        if(original.id!=null)walkIdToUid.set(original.id,x.uid);
        await upsertImported('walks',x);
      }
    };
    const importLandmarkSet=async records=>{
      for(const original of records||[]){
        const x={...original};
        if(!x.uid)x.uid=uid();
        if(original.id!=null)landmarkIdToUid.set(original.id,x.uid);
        if(!Array.isArray(x.photos))x.photos=x.photo?[x.photo]:[];
        x.photo=x.photos[0]||x.photo||'';
        await upsertImported('landmarks',x);
      }
    };
    const importVisitSet=async records=>{
      for(const original of records||[]){
        const x={...original};
        if(!x.uid)x.uid=uid();
        if(!x.landmarkUid && x.landmarkId!=null && landmarkIdToUid.has(x.landmarkId))x.landmarkUid=landmarkIdToUid.get(x.landmarkId);
        if(!x.walkUid && x.walkId!=null && walkIdToUid.has(x.walkId))x.walkUid=walkIdToUid.get(x.walkId);
        await upsertImported('visits',x);
      }
    };
    if(kind==='walks'){
      if(!Array.isArray(d.walks))throw new Error('No walks array');
      await importWalkSet(d.walks);
    }else if(kind==='landmarks'){
      if(!Array.isArray(d.landmarks))throw new Error('No landmarks array');
      await importLandmarkSet(d.landmarks);
      await importVisitSet(d.visits);
    }else{
      if(!Array.isArray(d.walks)&&!Array.isArray(d.landmarks))throw new Error('Not a Walk Memory backup');
      await importWalkSet(d.walks);
      await importLandmarkSet(d.landmarks);
      await importVisitSet(d.visits);
    }
    await migrateData(); await refreshAll(); scheduleSync(); alert('Import complete. Existing matching records were updated instead of duplicated.');
  }catch(err){alert(`Could not import file: ${err.message}`);}
}

function apiBase() {
  if(viewerMode && viewerApiBase)return viewerApiBase.replace(/\/$/,'');
  const custom=String(settings.apiBase||'').trim().replace(/\/$/,'');
  return custom || (location.protocol==='http:'||location.protocol==='https:' ? location.origin : '');
}

function apiPath(path) { const b=apiBase(); if(!b) throw new Error('No sync server URL is configured.'); return b+path; }
function roomPath(room){ return `/api/room/${encodeURIComponent(room)}`; }

async function pushShared() {
  if(viewerMode || !settings.room || !settings.ownerKey) return;
  setShareStatus('Syncing…');
  try{
    const snap=await localSnapshot();
    const res=await fetch(apiPath(roomPath(settings.room)),{method:'POST',headers:{'content-type':'application/json','x-owner-key':settings.ownerKey},body:JSON.stringify({data:snap})});
    if(!res.ok)throw new Error((await res.json().catch(()=>({}))).error||`HTTP ${res.status}`);
    setShareStatus(`Synced ${new Date().toLocaleTimeString()}`,true);
  }catch(err){setShareStatus(`Sync failed: ${err.message}`,false,true);}
}

async function loadShared(room) {
  try{
    const res=await fetch(apiPath(roomPath(room)),{cache:'no-store'});
    if(!res.ok)throw new Error(res.status===404?'Shared room not found.':`HTTP ${res.status}`);
    const payload=await res.json(); sharedSnapshot=payload.data||{walks:[],landmarks:[],visits:[]};
    $('sharedBanner').textContent=`Viewing shared Walk Memory room ${room} · read-only · updated ${payload.updatedAt?new Date(payload.updatedAt).toLocaleString():'recently'}`;
    $('sharedBanner').classList.remove('hidden');
    await refreshAll();
  }catch(err){
    $('sharedBanner').textContent=`Could not load shared room: ${err.message}`; $('sharedBanner').classList.remove('hidden');
  }
}

function scheduleSync(){ if(viewerMode||!settings.room||!settings.ownerKey)return; clearTimeout(syncTimer); syncTimer=setTimeout(pushShared,800); }
function randomRoom(){return crypto.getRandomValues(new Uint32Array(3)).reduce((s,n)=>s+n.toString(36),'wm-');}
function randomSecret(){const a=new Uint8Array(24);crypto.getRandomValues(a);return [...a].map(x=>x.toString(16).padStart(2,'0')).join('');}

async function enableSharing(){
  if(viewerMode)return;
  settings.apiBase=$('apiBase').value.trim();
  if(!settings.room){settings.room=randomRoom();settings.ownerKey=randomSecret();}
  saveSettings(); updateSharingUI(); await pushShared();
}
async function disableSharing(){
  if(viewerMode||!settings.room)return;
  if(!confirm('Turn off sharing and delete the server copy of this shared room? Your local walks stay on this device.'))return;
  try{
    const res=await fetch(apiPath(roomPath(settings.room)),{method:'DELETE',headers:{'x-owner-key':settings.ownerKey}});
    if(!res.ok && res.status!==404)throw new Error(`HTTP ${res.status}`);
    delete settings.room; delete settings.ownerKey; saveSettings(); updateSharingUI();
  }catch(err){setShareStatus(`Could not disable sharing: ${err.message}`,false,true);}
}
function shareLink(){
  if(!settings.room)return '';
  const custom=String(settings.apiBase||'').trim().replace(/\/$/,'');
  const pageIsWeb=location.protocol==='http:'||location.protocol==='https:';
  const u=new URL(pageIsWeb ? location.href : (custom || location.href));
  u.search='';u.hash='';u.searchParams.set('room',settings.room);u.searchParams.set('view','1');
  if(pageIsWeb && custom && new URL(custom,location.href).origin!==location.origin)u.searchParams.set('api',custom);
  return u.toString();
}
function setShareStatus(text,ok=false,error=false){const el=$('shareStatus');el.textContent=text;el.classList.toggle('status-ok',ok);el.classList.toggle('status-error',error);}
function updateSharingUI(){
  $('apiBase').value=settings.apiBase||''; $('shareLink').value=shareLink();
  $('enableSharing').textContent=settings.room?'Sharing enabled':'Enable sharing';
  $('syncNow').disabled=!settings.room; $('disableSharing').disabled=!settings.room;
  if(settings.room)setShareStatus(`Room ${settings.room} is enabled.`);
  else setShareStatus('Sharing is off.');
}
async function copyShareLink(){
  const v=$('shareLink').value;if(!v)return alert('Enable sharing first.');
  try{await navigator.clipboard.writeText(v);setShareStatus('Share link copied.',true);}catch{prompt('Copy this link:',v);}
}
function exitSharedView(){const u=new URL(location.href);u.searchParams.delete('room');u.searchParams.delete('view');location.href=u.toString();}

async function wipeLocal(){
  if(viewerMode)return;
  if(!confirm('Delete ALL local walks, landmarks, visits, and photos from this device?'))return;
  for(const s of ['walks','landmarks','visits'])await clearStore(s);
  await refreshAll(); scheduleSync();
}

async function refreshAll(){await renderLists();await renderMap();}

function configureViewerFromURL(){
  const p=new URLSearchParams(location.search); const room=p.get('room');
  if(room && p.get('view')==='1'){
    viewerMode=true;viewerRoom=room;viewerApiBase=String(p.get('api')||'').trim();
    $('addLandmark').disabled=true;$('start').disabled=true;
    $('shareOwnerControls').classList.add('hidden');$('shareViewerControls').classList.remove('hidden');
    $('viewerRoomInfo').textContent=`Read-only shared room: ${room}`;
  }
}

function bindUI(){
  document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('.page').forEach(x=>x.classList.remove('active')); $(b.dataset.page).classList.add('active');
    if(b.dataset.page==='map')setTimeout(()=>map?.invalidateSize(),50);
  });
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeModal(b.dataset.close));
  document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModal(m.id)}));
  $('start').onclick=startTracking;$('stop').onclick=stopTracking;$('locate').onclick=locateMe;
  $('addLandmark').onclick=openNewLandmark;$('lmPhotos').onchange=addSelectedPhotos;$('lmForm').onsubmit=saveLandmark;$('deleteLandmark').onclick=deleteCurrentLandmark;
  $('exportFull').onclick=exportFull;$('exportWalks').onclick=exportWalks;$('exportLandmarks').onclick=exportLandmarks;
  $('importFull').onchange=e=>importFile(e.target.files[0],'full');$('importWalks').onchange=e=>importFile(e.target.files[0],'walks');$('importLandmarks').onchange=e=>importFile(e.target.files[0],'landmarks');
  $('enableSharing').onclick=enableSharing;$('syncNow').onclick=()=>viewerMode?loadShared(viewerRoom):pushShared();$('disableSharing').onclick=disableSharing;$('copyShareLink').onclick=copyShareLink;$('exitSharedView').onclick=exitSharedView;$('wipe').onclick=wipeLocal;
  $('apiBase').onchange=()=>{settings.apiBase=$('apiBase').value.trim();saveSettings();updateSharingUI();};
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden || !startAt || nativeBridgeAvailable())return;
    $('state').textContent='Tracking requested; browser may pause GPS in background.';
  });
}

async function boot(){
  bindUI();configureViewerFromURL();await openDB();await migrateData();await initMap();await renderLists();updateSharingUI();
  if(viewerMode){await loadShared(viewerRoom);setInterval(()=>loadShared(viewerRoom),30000);}
  if('serviceWorker' in navigator && location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

boot().catch(err=>{console.error(err);alert(`Walk Memory failed to start: ${err.message}`);});
