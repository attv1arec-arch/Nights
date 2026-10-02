import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.WALK_MEMORY_DATA || path.join(__dirname, 'walk-memory-data.json');
const MAX_BODY = 35 * 1024 * 1024;
const SESSION_MS = 45 * 24 * 60 * 60 * 1000;
const scrypt = promisify(crypto.scrypt);
let firebaseMessaging=null;
try{
  if(process.env.FIREBASE_PROJECT_ID){
    const [{initializeApp,applicationDefault},{getMessaging}]=await Promise.all([import('firebase-admin/app'),import('firebase-admin/messaging')]);
    firebaseMessaging=getMessaging(initializeApp({credential:applicationDefault(),projectId:process.env.FIREBASE_PROJECT_ID}));
  }
}catch(e){console.warn('Push notifications disabled:',e.message)}

const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon'
};

let writeChain = Promise.resolve();

function send(res,status,body,headers={}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers
  });
  res.end(payload);
}
function apiHeaders() {
  return {
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers':'content-type,authorization',
    'cache-control':'no-store'
  };
}
function normalizeDB(raw) {
  const db = raw && typeof raw === 'object' ? raw : {};
  db.version = 9;
  db.users ||= {};
  db.sessions ||= {};
  db.activeActivities ||= {};
  db.sharedPlans ||= {};
  db.revisions ||= [];
  return db;
}
async function readDB() {
  try { return normalizeDB(JSON.parse(await fs.readFile(DATA_FILE,'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return normalizeDB({}); throw e; }
}
async function writeDB(data) {
  await fs.mkdir(path.dirname(DATA_FILE), {recursive:true});
  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, DATA_FILE);
}
function queuedWrite(fn) { writeChain = writeChain.then(fn,fn); return writeChain; }
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let size=0, chunks=[];
    req.on('data',chunk=>{
      size += chunk.length;
      if(size > MAX_BODY){ reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error',reject);
  });
}
async function readJson(req) {
  try { return JSON.parse(await readBody(req) || '{}'); }
  catch (e) { throw Object.assign(new Error(e.message==='Request too large'?e.message:'Invalid JSON'),{status:400}); }
}
function randomToken(bytes=32) { return crypto.randomBytes(bytes).toString('base64url'); }
function hashToken(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function normalizeUsername(v) { return String(v||'').trim().toLowerCase(); }
function validUsername(v) { return /^[a-z0-9_.-]{3,24}$/.test(v); }
function safeColor(v) { return /^#[0-9a-f]{6}$/i.test(String(v||'')) ? String(v) : '#d00000'; }
function publicUser(u, includeInvite=false) { const out={id:u.id,username:u.username,displayName:u.displayName||u.username,walkColor:safeColor(u.walkColor),partnerId:u.partnerId||null,createdAt:u.createdAt}; if(includeInvite) out.inviteCode=u.inviteCode||null; return out; }
async function pushToUser(user,title,body,data={}){
  const tokens=[...new Set(user?.pushTokens||[])].slice(-10);if(!firebaseMessaging||!tokens.length)return;
  const messages=tokens.map(token=>({token,notification:{title,body},data:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,String(v)])),android:{priority:'high',notification:{channelId:'nights_partner'}}}));
  const result=await firebaseMessaging.sendEach(messages).catch(()=>null);if(!result)return;
  user.pushTokens=tokens.filter((_,i)=>result.responses[i]?.success||!['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(result.responses[i]?.error?.code));
}
async function passwordHash(password,salt) {
  const out = await scrypt(String(password),salt,64);
  return Buffer.from(out).toString('hex');
}
async function verifyPassword(password,user) {
  const a = Buffer.from(await passwordHash(password,user.salt),'hex');
  const b = Buffer.from(user.passwordHash,'hex');
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function freshInviteCode() { return randomToken(6).replace(/[-_]/g,'').slice(0,8).toUpperCase(); }
function sanitizeSnapshot(data) {
  if (!data || typeof data !== 'object') throw Object.assign(new Error('Missing data'),{status:400});
  const walks = Array.isArray(data.walks) ? data.walks : [];
  const landmarks = Array.isArray(data.landmarks) ? data.landmarks : [];
  const visits = Array.isArray(data.visits) ? data.visits : [];
  const photos = Array.isArray(data.photos) ? data.photos : [];
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const collections = Array.isArray(data.collections) ? data.collections : [];
  const voiceNotes = Array.isArray(data.voiceNotes) ? data.voiceNotes : [];
  const pines = Array.isArray(data.pines) ? data.pines : [];
  const houses = Array.isArray(data.houses) ? data.houses : [];
  if (walks.length > 25000 || landmarks.length > 12000 || visits.length > 120000 || photos.length > 40000 || plans.length > 2000 || collections.length > 2000 || voiceNotes.length > 10000 || pines.length > 50000 || houses.length > 50000) throw Object.assign(new Error('Dataset too large'),{status:400});
  return {version:10,walks,landmarks,visits,photos,plans,collections,voiceNotes,pines,houses};
}
function sanitizePartnerLandmark(data,existing) {
  if (!data || typeof data !== 'object' || !existing) throw Object.assign(new Error('Invalid landmark.'),{status:400});
  const number=(value,fallback,min,max)=>{const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:fallback};
  const text=(value,fallback,max)=>String(value??fallback??'').trim().slice(0,max);
  const lat=number(data.lat,Number(existing.lat),-90,90),lon=number(data.lon,Number(existing.lon),-180,180);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))throw Object.assign(new Error('Landmark location is invalid.'),{status:400});
  const photos=(Array.isArray(data.photos)?data.photos:existing.photos||[]).filter(x=>typeof x==='string'&&/^data:image\//i.test(x)).slice(0,24);
  return {
    ...existing,
    uid:existing.uid,
    name:text(data.name,existing.name,120)||'Landmark',
    category:text(data.category,existing.category||'Other',60)||'Other',
    subcategory:text(data.subcategory,existing.subcategory||'',80),
    rating:Math.round(number(data.rating,Number(existing.rating)||0,0,5)),
    desc:text(data.desc,existing.desc||'',1000),
    notes:text(data.notes,existing.notes||'',4000),
    radius:number(data.radius,Number(existing.radius)||30,.3,1609344),
    lat,lon,photos,photo:photos[0]||'',
    zonesFeet:(Array.isArray(data.zonesFeet)?data.zonesFeet:existing.zonesFeet||[]).map(Number).filter(x=>Number.isFinite(x)&&x>0&&x<=5280000).slice(0,20),
    updatedAt:Date.now()
  };
}
function snapshotDistance(a,b){const rad=Math.PI/180,dLat=(Number(b.lat)-Number(a.lat))*rad,dLon=(Number(b.lon)-Number(a.lon))*rad,q=Math.sin(dLat/2)**2+Math.cos(Number(a.lat)*rad)*Math.cos(Number(b.lat)*rad)*Math.sin(dLon/2)**2;return 12742000*Math.asin(Math.sqrt(q))}
function recalculateSnapshotLandmarkVisits(snapshot,landmark){
  const visits=Array.isArray(snapshot.visits)?snapshot.visits:[],existing=visits.filter(v=>v?.landmarkUid===landmark.uid),byWalk=new Map(existing.filter(v=>v.walkUid).map(v=>[v.walkUid,v])),kept=visits.filter(v=>v?.landmarkUid!==landmark.uid||!v.walkUid),added=[];
  for(const walk of snapshot.walks||[]){let closest=null,best=Infinity;for(const point of walk.points||[]){const d=snapshotDistance(point,landmark);if(d<best){best=d;closest=point}}if(best<=Number(landmark.radius||50)){const old=byWalk.get(walk.uid);added.push(old||{uid:crypto.randomUUID(),landmarkUid:landmark.uid,walkUid:walk.uid,date:Number(closest?.t||walk.date||Date.now()),updatedAt:Date.now(),radiusCalculated:true})}}
  return[...kept,...added];
}
function mergePendingPartnerLandmarkEdits(user,snapshot) {
  const pending=Array.isArray(user.pendingPartnerLandmarkEdits)?user.pendingPartnerLandmarkEdits:[];
  if(!pending.length)return snapshot;
  const landmarks=[...(snapshot.landmarks||[])];
  for(const edit of pending){
    const i=landmarks.findIndex(x=>x?.uid===edit?.uid);
    if(i<0)landmarks.push(edit);
    else if(Number(edit.updatedAt||0)>=Number(landmarks[i]?.updatedAt||0))landmarks[i]=edit;
  }
  for(const patch of Array.isArray(user.pendingPartnerVisitPatches)?user.pendingPartnerVisitPatches:[]){snapshot={...snapshot,visits:[...(snapshot.visits||[]).filter(v=>v?.landmarkUid!==patch.landmarkUid),...(patch.visits||[])]}}
  const walkPatches=Array.isArray(user.pendingSharedWalkPatches)?user.pendingSharedWalkPatches:[];if(walkPatches.length){const walks=[...(snapshot.walks||[])];for(const patch of walkPatches){const i=walks.findIndex(w=>w?.uid===patch.uid||patch.sharedActivityUid&&w?.sharedActivityUid===patch.sharedActivityUid);if(patch.deletedAt){if(i>=0)walks.splice(i,1)}else if(i>=0&&Number(patch.updatedAt||0)>=Number(walks[i].updatedAt||0))walks[i]=patch;else if(i<0)walks.push(patch)}snapshot={...snapshot,walks};user.pendingSharedWalkPatches=[]}
  user.pendingPartnerLandmarkEdits=[];
  user.pendingPartnerVisitPatches=[];
  return {...snapshot,landmarks};
}
function findUserByName(db,username) { return Object.values(db.users).find(u=>u.username===username); }
function findUserByInvite(db,code) { return Object.values(db.users).find(u=>String(u.inviteCode||'').toUpperCase()===String(code||'').trim().toUpperCase()); }
function cleanSessions(db) {
  const t=Date.now(); for(const [k,v] of Object.entries(db.sessions)) if(!v || v.expiresAt<t || !db.users[v.userId]) delete db.sessions[k];
}
function bearer(req) {
  const h=String(req.headers.authorization||''); const m=h.match(/^Bearer\s+(.+)$/i); return m?m[1]:'';
}
function authUser(db,req) {
  cleanSessions(db);
  const token=bearer(req); if(!token) return null;
  const s=db.sessions[hashToken(token)]; if(!s || s.expiresAt<Date.now()) return null;
  return db.users[s.userId]||null;
}
function makeSession(db,userId) {
  const token=randomToken(32); db.sessions[hashToken(token)]={userId,expiresAt:Date.now()+SESSION_MS}; return token;
}

async function handleApi(req,res,url) {
  const headers=apiHeaders();
  if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return;}

  try {
    if(url.pathname==='/api/health' && req.method==='GET')return send(res,200,{ok:true,service:'Nights partner sync',version:'9.3',time:Date.now()},headers);
    if(url.pathname==='/api/auth/signup' && req.method==='POST') {
      const body=await readJson(req);
      const username=normalizeUsername(body.username), password=String(body.password||''), displayName=String(body.displayName||'').trim().slice(0,40), walkColor=safeColor(body.walkColor);
      if(!validUsername(username)) return send(res,400,{error:'Username must be 3–24 characters using letters, numbers, dot, dash, or underscore.'},headers);
      if(password.length<8) return send(res,400,{error:'Password must be at least 8 characters.'},headers);
      let result;
      await queuedWrite(async()=>{
        const db=await readDB();
        if(findUserByName(db,username)) throw Object.assign(new Error('That username is already taken.'),{status:409});
        const id=crypto.randomUUID(), salt=randomToken(18);
        const user={id,username,displayName:displayName||username,walkColor,salt,passwordHash:await passwordHash(password,salt),inviteCode:freshInviteCode(),partnerId:null,createdAt:Date.now(),snapshot:{version:9,walks:[],landmarks:[],visits:[],photos:[],plans:[],collections:[],voiceNotes:[]},snapshotUpdatedAt:0};
        db.users[id]=user; const token=makeSession(db,id); await writeDB(db); result={token,user:publicUser(user,true)};
      });
      return send(res,201,result,headers);
    }

    if(url.pathname==='/api/auth/login' && req.method==='POST') {
      const body=await readJson(req); const username=normalizeUsername(body.username), password=String(body.password||'');
      const db=await readDB(); const user=findUserByName(db,username);
      if(!user || !(await verifyPassword(password,user))) return send(res,401,{error:'Incorrect username or password.'},headers);
      const token=makeSession(db,user.id); await writeDB(db); return send(res,200,{token,user:publicUser(user,true)},headers);
    }

    if(url.pathname==='/api/auth/logout' && req.method==='POST') {
      const db=await readDB(); const token=bearer(req); if(token) delete db.sessions[hashToken(token)]; await writeDB(db); return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/auth/reset-with-partner-code' && req.method==='POST') {
      const body=await readJson(req); const username=normalizeUsername(body.username), partnerCode=String(body.partnerCode||'').trim().toUpperCase(), newPassword=String(body.newPassword||'');
      if(newPassword.length<8) return send(res,400,{error:'New password must be at least 8 characters.'},headers);
      await queuedWrite(async()=>{
        const d=await readDB(); const me=findUserByName(d,username);
        if(!me || !me.partnerId || !d.users[me.partnerId]) throw Object.assign(new Error('Account or linked partner not found.'),{status:404});
        const recoveryPartner=d.users[me.partnerId];
        if(String(recoveryPartner.inviteCode||'').toUpperCase()!==partnerCode) throw Object.assign(new Error('Partner recovery code is incorrect.'),{status:401});
        const salt=randomToken(18); me.salt=salt; me.passwordHash=await passwordHash(newPassword,salt);
        for(const [k,v] of Object.entries(d.sessions)) if(v?.userId===me.id) delete d.sessions[k];
        await writeDB(d);
      });
      return send(res,200,{ok:true},headers);
    }

    const db=await readDB(); const user=authUser(db,req);
    if(!user) return send(res,401,{error:'Please sign in.'},headers);

    if(url.pathname==='/api/me' && req.method==='GET') {
      const partner=user.partnerId?db.users[user.partnerId]:null;
      return send(res,200,{user:publicUser(user,true),partner:partner?publicUser(partner):null,sharing:user.sharing||{},snapshotUpdatedAt:user.snapshotUpdatedAt||0},headers);
    }

    if(url.pathname==='/api/devices' && req.method==='GET')return send(res,200,{devices:(user.devices||[]).map(x=>({...x}))},headers);
    if(url.pathname==='/api/device/register' && req.method==='POST'){
      const body=await readJson(req),deviceId=String(body.deviceId||'').slice(0,120),name=String(body.name||'Android device').slice(0,80);if(!deviceId)return send(res,400,{error:'Missing device id.'},headers);
      await queuedWrite(async()=>{const d=await readDB(),u=d.users[user.id],devices=Array.isArray(u.devices)?u.devices:[],i=devices.findIndex(x=>x.deviceId===deviceId),record={deviceId,name,platform:String(body.platform||'android').slice(0,30),appVersion:String(body.appVersion||'').slice(0,20),lastSeen:Date.now()};if(i>=0)devices[i]=record;else devices.push(record);u.devices=devices.slice(-12);await writeDB(d)});
      return send(res,200,{ok:true},headers);
    }
    if(url.pathname==='/api/device/remove' && req.method==='POST'){
      const body=await readJson(req),deviceId=String(body.deviceId||'');await queuedWrite(async()=>{const d=await readDB(),u=d.users[user.id];u.devices=(u.devices||[]).filter(x=>x.deviceId!==deviceId);await writeDB(d)});return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/push/register' && req.method==='POST') {
      const body=await readJson(req),token=String(body.token||'').trim();
      if(token.length<20)return send(res,400,{error:'Invalid notification token.'},headers);
      await queuedWrite(async()=>{const d=await readDB(),u=d.users[user.id];u.pushTokens=[...new Set([...(u.pushTokens||[]),token])].slice(-10);await writeDB(d)});
      return send(res,200,{ok:true,enabled:!!firebaseMessaging},headers);
    }

    if(url.pathname==='/api/account/display-name' && req.method==='POST') {
      const body=await readJson(req); const name=String(body.displayName||'').trim().slice(0,40);
      if(!name) return send(res,400,{error:'Display name cannot be empty.'},headers);
      await queuedWrite(async()=>{const d=await readDB(); const u=d.users[user.id]; u.displayName=name; await writeDB(d);});
      return send(res,200,{ok:true,displayName:name},headers);
    }


    if(url.pathname==='/api/account/walk-color' && req.method==='POST') {
      const body=await readJson(req); const walkColor=safeColor(body.walkColor);
      await queuedWrite(async()=>{const d=await readDB(); d.users[user.id].walkColor=walkColor; await writeDB(d);});
      return send(res,200,{ok:true,walkColor},headers);
    }

    if(url.pathname==='/api/account/sharing' && req.method==='POST') {
      const body=await readJson(req),sharing={routes:body.routes!==false,photos:body.photos!==false,landmarks:body.landmarks!==false,plans:body.plans!==false,landmarkApproval:body.landmarkApproval===true};
      await queuedWrite(async()=>{const d=await readDB();d.users[user.id].sharing=sharing;await writeDB(d)});
      return send(res,200,{ok:true,sharing},headers);
    }

    if(url.pathname==='/api/account/new-invite' && req.method==='POST') {
      let code='';
      await queuedWrite(async()=>{const d=await readDB(); const u=d.users[user.id]; do{code=freshInviteCode();}while(findUserByInvite(d,code)); u.inviteCode=code; await writeDB(d);});
      return send(res,200,{inviteCode:code},headers);
    }

    if(url.pathname==='/api/account/connect' && req.method==='POST') {
      const body=await readJson(req); const code=String(body.code||'').trim().toUpperCase();
      if(!code) return send(res,400,{error:'Enter an invite code.'},headers);
      let partner;
      await queuedWrite(async()=>{
        const d=await readDB(); const me=d.users[user.id]; const other=findUserByInvite(d,code);
        if(!other) throw Object.assign(new Error('Invite code not found.'),{status:404});
        if(other.id===me.id) throw Object.assign(new Error('That is your own invite code.'),{status:400});
        if(me.partnerId && me.partnerId!==other.id) throw Object.assign(new Error('Your account is already linked to a partner.'),{status:409});
        if(other.partnerId && other.partnerId!==me.id) throw Object.assign(new Error('That account is already linked to someone else.'),{status:409});
        me.partnerId=other.id; other.partnerId=me.id; me.inviteCode=freshInviteCode(); other.inviteCode=freshInviteCode(); partner=publicUser(other); await writeDB(d);
      });
      return send(res,200,{ok:true,partner},headers);
    }

    if(url.pathname==='/api/account/disconnect' && req.method==='POST') {
      await queuedWrite(async()=>{
        const d=await readDB(); const me=d.users[user.id]; const pid=me.partnerId; me.partnerId=null; me.inviteCode=freshInviteCode();
        if(pid && d.users[pid]?.partnerId===me.id){d.users[pid].partnerId=null; d.users[pid].inviteCode=freshInviteCode();}
        await writeDB(d);
      });
      return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/shared-activity/start' && req.method==='POST') {
      const body=await readJson(req);
      if(!user.partnerId || !db.users[user.partnerId]) return send(res,409,{error:'Link a partner account first.'},headers);
      const activityUid=String(body.activityUid||'').trim(); const type=body.type==='drive'?'drive':'walk';
      if(!activityUid) return send(res,400,{error:'Missing activity id.'},headers);
      await queuedWrite(async()=>{const d=await readDB();d.activeActivities[user.id]={hostId:user.id,partnerId:user.partnerId,activityUid,type,startedAt:Date.now(),updatedAt:Date.now(),photos:[],points:[],tracks:{[user.id]:[]},members:{[user.id]:'host'}};await pushToUser(d.users[user.partnerId],'Nights',`${user.displayName||user.username} invited you to a shared ${type}.`,{event:'activity-start',activityUid});await writeDB(d);});
      return send(res,200,{ok:true,activityUid,type},headers);
    }

    if(url.pathname==='/api/shared-activity' && req.method==='GET') {
      let session=db.activeActivities[user.id], role='host';
      if(!session && user.partnerId){session=db.activeActivities[user.partnerId];role='partner';}
      if(!session) return send(res,200,{active:false},headers);
      const liveTracks=Object.fromEntries(Object.entries(session.tracks||{}).map(([id,ps])=>[id,(ps||[]).slice(-500)]));
      return send(res,200,{active:true,role,activityUid:session.activityUid,type:session.type,startedAt:session.startedAt,updatedAt:session.updatedAt||session.startedAt,host:publicUser(db.users[session.hostId]),photoCount:(session.photos||[]).length,points:(session.points||[]).slice(-500),tracks:liveTracks,members:session.members||{}},headers);
    }

    if(url.pathname==='/api/shared-activity/join' && req.method==='POST') {
      await queuedWrite(async()=>{const d=await readDB(),s=d.activeActivities[user.partnerId];if(!s||s.partnerId!==user.id)throw Object.assign(new Error('No partner activity to join.'),{status:404});s.members||={};s.members[user.id]='partner';s.tracks||={};s.tracks[user.id]||=[];s.updatedAt=Date.now();await pushToUser(d.users[s.hostId],'Nights',`${user.displayName||user.username} joined your ${s.type}.`,{event:'partner-joined',activityUid:s.activityUid});await writeDB(d)});return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/shared-activity/leave' && req.method==='POST') {
      await queuedWrite(async()=>{const d=await readDB(),s=d.activeActivities[user.partnerId];if(s&&s.partnerId===user.id){s.members||={};delete s.members[user.id];s.updatedAt=Date.now();await pushToUser(d.users[s.hostId],'Nights',`${user.displayName||user.username} left your shared ${s.type}.`,{event:'partner-left',activityUid:s.activityUid});await writeDB(d)}});return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/shared-activity/location' && req.method==='POST') {
      const body=await readJson(req);await queuedWrite(async()=>{const d=await readDB(),owned=d.activeActivities[user.id],joined=user.partnerId?d.activeActivities[user.partnerId]:null,s=owned||joined;if(!s||(user.id!==s.hostId&&user.id!==s.partnerId))throw Object.assign(new Error('No active shared activity.'),{status:404});const p={lat:Number(body.lat),lon:Number(body.lon),t:Number(body.t||Date.now()),accuracy:Number(body.accuracy||0),altitude:body.altitude==null?null:Number(body.altitude),speed:body.speed==null?null:Number(body.speed),contributorId:user.id};if(Number.isFinite(p.lat)&&Number.isFinite(p.lon)){s.tracks||={};s.tracks[user.id]||=[];s.tracks[user.id].push(p);if(s.tracks[user.id].length>12000)s.tracks[user.id]=s.tracks[user.id].slice(-12000);if(user.id===s.hostId){s.points||=[];s.points.push(p);if(s.points.length>500)s.points=s.points.slice(-500)}s.updatedAt=Date.now()}await writeDB(d)});return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/shared-activity/event' && req.method==='POST') {
      const body=await readJson(req),message=String(body.message||'').trim().slice(0,140);if(!message)return send(res,400,{error:'Missing event message.'},headers);
      await queuedWrite(async()=>{const d=await readDB(),owned=d.activeActivities[user.id],joined=user.partnerId?d.activeActivities[user.partnerId]:null,s=owned||joined;if(!s)throw Object.assign(new Error('No shared activity.'),{status:404});const target=owned?s.partnerId:s.hostId;await pushToUser(d.users[target],'Nights',message,{event:String(body.event||'activity-update'),activityUid:s.activityUid});await writeDB(d)});return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/shared-activity/photo' && req.method==='POST') {
      const body=await readJson(req);
      if(!user.partnerId) return send(res,409,{error:'No linked partner.'},headers);
      await queuedWrite(async()=>{
        const d=await readDB(); const session=d.activeActivities[user.partnerId];
        if(!session || session.partnerId!==user.id) throw Object.assign(new Error('Your partner is not sharing an active walk or drive.'),{status:404});
        const image=String(body.image||''); if(!/^data:image\//i.test(image)) throw Object.assign(new Error('Invalid photo.'),{status:400});
        session.photos ||= []; session.photos.push({uid:crypto.randomUUID(),activityUid:session.activityUid,date:Number(body.date||Date.now()),lat:Number(body.lat),lon:Number(body.lon),altitude:body.altitude==null?null:Number(body.altitude),image,contributorId:user.id,contributorName:user.displayName||user.username,updatedAt:Date.now()});
        if(session.photos.length>500) session.photos=session.photos.slice(-500);
        await pushToUser(d.users[session.hostId],'Nights',`${user.displayName||user.username} added a photo to your shared activity.`,{event:'partner-photo',activityUid:session.activityUid});await writeDB(d);
      });
      return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/shared-activity/finish' && req.method==='POST') {
      let photos=[],traces=[],contributors=[],activityUid='';
      await queuedWrite(async()=>{const d=await readDB(); const session=d.activeActivities[user.id]; if(session){photos=session.photos||[];activityUid=session.activityUid;traces=Object.entries(session.tracks||{}).map(([userId,trackPoints])=>({userId,name:d.users[userId]?.displayName||d.users[userId]?.username||'Participant',points:trackPoints||[]}));contributors=[...new Set([session.hostId,...Object.keys(session.members||{})])].map(id=>({userId:id,name:d.users[id]?.displayName||d.users[id]?.username||'Participant'}));await pushToUser(d.users[session.partnerId],'Nights',`${user.displayName||user.username} finished the shared ${session.type}.`,{event:'activity-finished',activityUid:session.activityUid});delete d.activeActivities[user.id]; await writeDB(d);}});
      return send(res,200,{ok:true,activityUid,photos,traces,contributors},headers);
    }

    if(url.pathname==='/api/shared-activity/cancel' && req.method==='POST') {
      await queuedWrite(async()=>{const d=await readDB(); if(d.activeActivities[user.id]){delete d.activeActivities[user.id];await writeDB(d);}});
      return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/shared-plans' && req.method==='GET'){
      const ids=new Set([user.id,user.partnerId].filter(Boolean)),plans=Object.values(db.sharedPlans||{}).filter(p=>ids.has(p.ownerId)&&(!p.partnerId||ids.has(p.partnerId))&&!p.deletedAt);return send(res,200,{plans},headers);
    }
    if(url.pathname==='/api/shared-plan' && req.method==='POST'){
      if(!user.partnerId)return send(res,409,{error:'Link a partner first.'},headers);const body=await readJson(req),input=body.plan||{},planUid=String(input.uid||'').slice(0,120);if(!planUid)return send(res,400,{error:'Missing plan id.'},headers);let saved;
      await queuedWrite(async()=>{const d=await readDB(),old=d.sharedPlans[planUid];if(old&&old.ownerId!==user.id&&old.partnerId!==user.id)throw Object.assign(new Error('This shared plan is unavailable.'),{status:403});if(old&&body.baseRevision!=null&&Number(body.baseRevision)!==Number(old.revision||1))throw Object.assign(new Error('Your partner changed this plan. Reload it before saving.'),{status:409,current:old});const clean={uid:planUid,name:String(input.name||'Shared plan').slice(0,100),mode:input.mode==='drive'?'drive':'walk',preference:['fastest','easy','familiar'].includes(input.preference)?input.preference:'fastest',start:input.start||null,firstStopStart:!!input.firstStopStart,stops:Array.isArray(input.stops)?input.stops.slice(0,80):[],roundTrip:!!input.roundTrip,distance:Number(input.distance||0),estimatedDuration:Number(input.estimatedDuration||0),etaSource:String(input.etaSource||'both'),ownerId:old?.ownerId||user.id,partnerId:user.partnerId,contributors:[...new Set([old?.ownerId||user.id,user.partnerId])],revision:Number(old?.revision||0)+1,createdAt:Number(old?.createdAt||Date.now()),updatedAt:Date.now(),updatedBy:user.id};d.sharedPlans[planUid]=clean;d.revisions.push({kind:'shared-plan',uid:planUid,userId:user.id,date:Date.now(),before:old||null});d.revisions=d.revisions.slice(-5000);saved=clean;await pushToUser(d.users[user.partnerId],'Nights',`${user.displayName||user.username} updated the shared plan “${clean.name}”.`,{event:'shared-plan',planUid});await writeDB(d)});return send(res,200,{ok:true,plan:saved},headers);
    }
    if(url.pathname==='/api/shared-plan/delete' && req.method==='POST'){
      const body=await readJson(req),planUid=String(body.uid||'');await queuedWrite(async()=>{const d=await readDB(),p=d.sharedPlans[planUid];if(!p||(p.ownerId!==user.id&&p.partnerId!==user.id))throw Object.assign(new Error('Shared plan unavailable.'),{status:404});d.revisions.push({kind:'shared-plan-delete',uid:planUid,userId:user.id,date:Date.now(),before:p});p.deletedAt=Date.now();p.updatedBy=user.id;await pushToUser(d.users[user.partnerId],'Nights',`${user.displayName||user.username} removed the shared plan “${p.name}”.`,{event:'shared-plan-deleted',planUid});await writeDB(d)});return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/shared-memory' && req.method==='POST'){
      if(!user.partnerId)return send(res,409,{error:'Link a partner first.'},headers);const body=await readJson(req),walkUid=String(body.uid||''),sharedActivityUid=String(body.sharedActivityUid||''),action=String(body.action||'');let changed;
      await queuedWrite(async()=>{const d=await readDB(),candidateIds=[user.id,user.partnerId];let owner=null,index=-1;for(const id of candidateIds){const rows=d.users[id]?.snapshot?.walks||[],i=rows.findIndex(w=>w?.uid===walkUid||sharedActivityUid&&w?.sharedActivityUid===sharedActivityUid);if(i>=0){owner=d.users[id];index=i;break}}if(!owner)throw Object.assign(new Error('Shared memory unavailable.'),{status:404});const current=owner.snapshot.walks[index],allowed=current.sharedActivityUid&&(owner.id===user.id||(current.contributors||[]).some(c=>c.userId===user.id));if(!allowed)throw Object.assign(new Error('Only participants can change this joint memory.'),{status:403});changed={...current};if(action==='rename'){const title=String(body.title||'').trim().slice(0,100);if(!title)throw Object.assign(new Error('Enter a name.'),{status:400});changed.title=title}else if(action==='comment'){const text=String(body.text||'').trim().slice(0,500);if(!text)throw Object.assign(new Error('Enter a comment.'),{status:400});changed.comments=[...(changed.comments||[]),{uid:crypto.randomUUID(),text,date:Date.now(),by:user.displayName||user.username,userId:user.id}]}else if(action==='delete'){changed.deletedAt=Date.now()}else throw Object.assign(new Error('Unsupported memory change.'),{status:400});changed.updatedAt=Date.now();changed.updatedBy=user.id;d.revisions.push({kind:`shared-memory-${action}`,uid:changed.uid,userId:user.id,date:Date.now(),before:current});if(changed.deletedAt)owner.snapshot.walks.splice(index,1);else owner.snapshot.walks[index]=changed;owner.snapshotUpdatedAt=Date.now();owner.pendingSharedWalkPatches||=[];owner.pendingSharedWalkPatches=owner.pendingSharedWalkPatches.filter(x=>x.uid!==changed.uid);owner.pendingSharedWalkPatches.push(changed);await pushToUser(d.users[user.partnerId],'Nights',`${user.displayName||user.username} ${action==='comment'?'commented on':action==='delete'?'deleted':'renamed'} a joint memory.`,{event:'shared-memory',activityUid:changed.sharedActivityUid});d.revisions=d.revisions.slice(-5000);await writeDB(d)});return send(res,200,{ok:true,walk:changed},headers);
    }

    if(url.pathname==='/api/sync/delta' && req.method==='POST'){
      const body=await readJson(req),allowed=['walks','landmarks','visits','photos','plans','collections','voiceNotes','pines','houses'],updatedAt=Date.now();
      await queuedWrite(async()=>{const d=await readDB(),u=d.users[user.id],snap=sanitizeSnapshot(u.snapshot||{});u.tombstones||={};for(const name of allowed){const rows=[...(snap[name]||[])],incoming=Array.isArray(body.changes?.[name])?body.changes[name]:[],deleted=new Set(Array.isArray(body.deleted?.[name])?body.deleted[name].map(String):[]),byUid=new Map(rows.map(x=>[String(x.uid||''),x]));u.tombstones[name]||={};for(const x of incoming){if(!x||!x.uid)continue;const old=byUid.get(String(x.uid));if(!old||Number(x.updatedAt||0)>=Number(old.updatedAt||0))byUid.set(String(x.uid),x);delete u.tombstones[name][String(x.uid)]}for(const key of deleted){const old=byUid.get(key);if(old)d.revisions.push({kind:`${name}-delete`,uid:key,userId:user.id,date:updatedAt,before:old});byUid.delete(key);u.tombstones[name][key]=updatedAt}snap[name]=[...byUid.values()]}u.snapshot={...snap,version:10};u.snapshotUpdatedAt=updatedAt;d.revisions=d.revisions.slice(-5000);await writeDB(d)});return send(res,200,{ok:true,updatedAt},headers);
    }

    if(url.pathname==='/api/snapshot' && req.method==='GET') {
      return send(res,200,{data:user.snapshot||{version:9,walks:[],landmarks:[],visits:[],photos:[],plans:[],collections:[],voiceNotes:[]},tombstones:user.tombstones||{},updatedAt:user.snapshotUpdatedAt||0},headers);
    }
    if(url.pathname==='/api/snapshot' && req.method==='POST') {
      const body=await readJson(req); const snap=sanitizeSnapshot(body.data); const updatedAt=Date.now();
      await queuedWrite(async()=>{const d=await readDB(); const u=d.users[user.id]; u.snapshot=mergePendingPartnerLandmarkEdits(u,snap); u.snapshotUpdatedAt=updatedAt; await writeDB(d);});
      return send(res,200,{ok:true,updatedAt},headers);
    }

    if(url.pathname==='/api/partner-landmark' && req.method==='POST') {
      const body=await readJson(req),requestedUid=String(body.landmark?.uid||'');
      if(!user.partnerId)return send(res,409,{error:'No linked partner.'},headers);
      let landmark,updatedAt,landmarkVisits=[],pending=false;
      await queuedWrite(async()=>{
        const d=await readDB(),me=d.users[user.id],target=me?.partnerId?d.users[me.partnerId]:null;
        if(!target)throw Object.assign(new Error('Linked partner is unavailable.'),{status:404});
        if(target.sharing?.landmarks===false)throw Object.assign(new Error('Your partner is not sharing landmarks.'),{status:403});
        if(target.sharing?.landmarkApproval===true){target.pendingLandmarkApprovals||=[];const proposal={id:crypto.randomUUID(),fromUserId:me.id,fromName:me.displayName||me.username,landmark:body.landmark,createdAt:Date.now()};target.pendingLandmarkApprovals.push(proposal);target.pendingLandmarkApprovals=target.pendingLandmarkApprovals.slice(-100);pending=true;await pushToUser(target,'Nights',`${proposal.fromName} requested a change to “${String(body.landmark?.name||'a landmark').slice(0,80)}”.`,{event:'landmark-approval',proposalId:proposal.id});await writeDB(d);return}
        const source=target.snapshot||{version:8,walks:[],landmarks:[],visits:[],photos:[],plans:[],collections:[]},landmarks=[...(source.landmarks||[])],i=landmarks.findIndex(x=>x?.uid===requestedUid);
        if(i<0)throw Object.assign(new Error('That partner landmark no longer exists.'),{status:404});
        landmark=sanitizePartnerLandmark(body.landmark,landmarks[i]);landmarks[i]=landmark;updatedAt=Date.now();const revised={...source,version:8,landmarks};revised.visits=recalculateSnapshotLandmarkVisits(revised,landmark);landmarkVisits=revised.visits.filter(v=>v.landmarkUid===landmark.uid);
        target.snapshot=revised;target.snapshotUpdatedAt=updatedAt;
        const pendingEdits=Array.isArray(target.pendingPartnerLandmarkEdits)?target.pendingPartnerLandmarkEdits:[],pi=pendingEdits.findIndex(x=>x?.uid===landmark.uid);
        if(pi>=0)pendingEdits[pi]=landmark;else pendingEdits.push(landmark);target.pendingPartnerLandmarkEdits=pendingEdits.slice(-500);
        const visitPatches=Array.isArray(target.pendingPartnerVisitPatches)?target.pendingPartnerVisitPatches:[],vi=visitPatches.findIndex(x=>x?.landmarkUid===landmark.uid),visitPatch={landmarkUid:landmark.uid,visits:landmarkVisits,updatedAt};if(vi>=0)visitPatches[vi]=visitPatch;else visitPatches.push(visitPatch);target.pendingPartnerVisitPatches=visitPatches.slice(-500);
        await pushToUser(target,'Nights',`${me.displayName||me.username} updated your landmark “${landmark.name}”.`,{event:'partner-landmark-edited',landmarkUid:landmark.uid});
        await writeDB(d);
      });
      return send(res,200,{ok:true,pending,landmark,visits:landmarkVisits,updatedAt},headers);
    }

    if(url.pathname==='/api/landmark-approvals' && req.method==='GET')return send(res,200,{approvals:user.pendingLandmarkApprovals||[]},headers);
    if(url.pathname==='/api/landmark-approval' && req.method==='POST'){
      const body=await readJson(req),proposalId=String(body.id||''),accept=body.accept===true;let landmark=null,landmarkVisits=[],updatedAt=Date.now();
      await queuedWrite(async()=>{const d=await readDB(),u=d.users[user.id],rows=u.pendingLandmarkApprovals||[],proposal=rows.find(x=>x.id===proposalId);if(!proposal)throw Object.assign(new Error('That request is no longer available.'),{status:404});if(accept){const source=u.snapshot||{version:9,walks:[],landmarks:[],visits:[],photos:[],plans:[],collections:[],voiceNotes:[]},landmarks=[...(source.landmarks||[])],i=landmarks.findIndex(x=>x?.uid===proposal.landmark?.uid);if(i<0)throw Object.assign(new Error('That landmark no longer exists.'),{status:404});landmark=sanitizePartnerLandmark(proposal.landmark,landmarks[i]);landmarks[i]=landmark;updatedAt=Date.now();const revised={...source,version:9,landmarks};revised.visits=recalculateSnapshotLandmarkVisits(revised,landmark);landmarkVisits=revised.visits.filter(v=>v.landmarkUid===landmark.uid);u.snapshot=revised;u.snapshotUpdatedAt=updatedAt;const pending=Array.isArray(u.pendingPartnerLandmarkEdits)?u.pendingPartnerLandmarkEdits:[],pi=pending.findIndex(x=>x?.uid===landmark.uid);if(pi>=0)pending[pi]=landmark;else pending.push(landmark);u.pendingPartnerLandmarkEdits=pending.slice(-500);const visitPatches=Array.isArray(u.pendingPartnerVisitPatches)?u.pendingPartnerVisitPatches:[],vi=visitPatches.findIndex(x=>x?.landmarkUid===landmark.uid),visitPatch={landmarkUid:landmark.uid,visits:landmarkVisits,updatedAt};if(vi>=0)visitPatches[vi]=visitPatch;else visitPatches.push(visitPatch);u.pendingPartnerVisitPatches=visitPatches.slice(-500)}u.pendingLandmarkApprovals=rows.filter(x=>x.id!==proposalId);await pushToUser(d.users[proposal.fromUserId],'Nights',`${u.displayName||u.username} ${accept?'approved':'rejected'} your landmark change.`,{event:'landmark-approval-result',proposalId,accepted:accept});await writeDB(d)});return send(res,200,{ok:true,accepted:accept,landmark,visits:landmarkVisits,updatedAt},headers);
    }

    if(url.pathname==='/api/partner-snapshot' && req.method==='GET') {
      if(!user.partnerId || !db.users[user.partnerId]) return send(res,404,{error:'No partner linked.'},headers);
      const p=db.users[user.partnerId],sharing=p.sharing||{},source=p.snapshot||{version:10,walks:[],landmarks:[],visits:[],photos:[],plans:[],collections:[],voiceNotes:[],pines:[],houses:[]},data={...source,walks:sharing.routes===false?[]:source.walks||[],photos:sharing.photos===false?[]:source.photos||[],voiceNotes:sharing.photos===false?[]:source.voiceNotes||[],landmarks:sharing.landmarks===false?[]:source.landmarks||[],visits:sharing.landmarks===false?[]:source.visits||[],plans:sharing.plans===false?[]:source.plans||[],collections:sharing.plans===false?[]:source.collections||[],pines:source.pines||[],houses:(source.houses||[]).filter(h=>h.shared!==false)};
      return send(res,200,{partner:publicUser(p),data,updatedAt:p.snapshotUpdatedAt||0},headers);
    }

    return send(res,404,{error:'Not found'},headers);
  } catch(e) {
    console.error(e); return send(res,e.status||500,{error:e.message||'Server error'},headers);
  }
}

async function serveStatic(req,res,url) {
  let rel=decodeURIComponent(url.pathname); if(rel==='/')rel='/index.html';
  const full=path.resolve(__dirname,'.'+rel); const root=path.resolve(__dirname)+path.sep;
  if(!full.startsWith(root))return send(res,403,'Forbidden');
  const blocked=new Set(['walk-memory-data.json','server.mjs']); if(blocked.has(path.basename(full)))return send(res,404,'Not found');
  try{
    const stat=await fs.stat(full); if(!stat.isFile())throw Object.assign(new Error(),{code:'ENOENT'});
    const body=await fs.readFile(full); res.writeHead(200,{'content-type':mime[path.extname(full).toLowerCase()]||'application/octet-stream','cache-control':path.basename(full)==='sw.js'?'no-cache':'public, max-age=300'});res.end(body);
  }catch(e){if(e.code==='ENOENT')send(res,404,'Not found');else send(res,500,'Server error');}
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname.startsWith('/api/'))return await handleApi(req,res,url);
    return await serveStatic(req,res,url);
  }catch(e){console.error(e);send(res,500,{error:'Server error'});}
});

server.listen(PORT,HOST,()=>console.log(`Nights V9.3 running on http://${HOST}:${PORT}`));
