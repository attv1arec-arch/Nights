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
  db.version = 6;
  db.users ||= {};
  db.sessions ||= {};
  db.activeActivities ||= {};
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
  if (walks.length > 25000 || landmarks.length > 12000 || visits.length > 120000 || photos.length > 40000) throw Object.assign(new Error('Dataset too large'),{status:400});
  return {version:6,walks,landmarks,visits,photos};
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
        const user={id,username,displayName:displayName||username,walkColor,salt,passwordHash:await passwordHash(password,salt),inviteCode:freshInviteCode(),partnerId:null,createdAt:Date.now(),snapshot:{version:6,walks:[],landmarks:[],visits:[],photos:[]},snapshotUpdatedAt:0};
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
      return send(res,200,{user:publicUser(user,true),partner:partner?publicUser(partner):null,snapshotUpdatedAt:user.snapshotUpdatedAt||0},headers);
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
      await queuedWrite(async()=>{const d=await readDB();d.activeActivities[user.id]={hostId:user.id,partnerId:user.partnerId,activityUid,type,startedAt:Date.now(),photos:[]};await writeDB(d);});
      return send(res,200,{ok:true,activityUid,type},headers);
    }

    if(url.pathname==='/api/shared-activity' && req.method==='GET') {
      let session=db.activeActivities[user.id], role='host';
      if(!session && user.partnerId){session=db.activeActivities[user.partnerId];role='partner';}
      if(!session) return send(res,200,{active:false},headers);
      return send(res,200,{active:true,role,activityUid:session.activityUid,type:session.type,startedAt:session.startedAt,host:publicUser(db.users[session.hostId]),photoCount:(session.photos||[]).length},headers);
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
        await writeDB(d);
      });
      return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/shared-activity/finish' && req.method==='POST') {
      let photos=[];
      await queuedWrite(async()=>{const d=await readDB(); const session=d.activeActivities[user.id]; if(session){photos=session.photos||[]; delete d.activeActivities[user.id]; await writeDB(d);}});
      return send(res,200,{ok:true,photos},headers);
    }

    if(url.pathname==='/api/shared-activity/cancel' && req.method==='POST') {
      await queuedWrite(async()=>{const d=await readDB(); if(d.activeActivities[user.id]){delete d.activeActivities[user.id];await writeDB(d);}});
      return send(res,200,{ok:true},headers);
    }

    if(url.pathname==='/api/snapshot' && req.method==='GET') {
      return send(res,200,{data:user.snapshot||{version:6,walks:[],landmarks:[],visits:[],photos:[]},updatedAt:user.snapshotUpdatedAt||0},headers);
    }
    if(url.pathname==='/api/snapshot' && req.method==='POST') {
      const body=await readJson(req); const snap=sanitizeSnapshot(body.data); const updatedAt=Date.now();
      await queuedWrite(async()=>{const d=await readDB(); const u=d.users[user.id]; u.snapshot=snap; u.snapshotUpdatedAt=updatedAt; await writeDB(d);});
      return send(res,200,{ok:true,updatedAt},headers);
    }

    if(url.pathname==='/api/partner-snapshot' && req.method==='GET') {
      if(!user.partnerId || !db.users[user.partnerId]) return send(res,404,{error:'No partner linked.'},headers);
      const p=db.users[user.partnerId];
      return send(res,200,{partner:publicUser(p),data:p.snapshot||{version:6,walks:[],landmarks:[],visits:[],photos:[]},updatedAt:p.snapshotUpdatedAt||0},headers);
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

server.listen(PORT,HOST,()=>console.log(`Nights v6 running on http://${HOST}:${PORT}`));
