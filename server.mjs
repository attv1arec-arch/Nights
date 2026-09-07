import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.WALK_MEMORY_DATA || path.join(__dirname, 'shared-data.json');
const MAX_BODY = 30 * 1024 * 1024;

const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon'
};

let writeChain = Promise.resolve();

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function validRoom(room) { return /^[A-Za-z0-9_-]{6,120}$/.test(room); }
function send(res,status,body,headers={}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers});
  res.end(payload);
}
function apiHeaders() {
  return {
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers':'content-type,x-owner-key',
    'cache-control':'no-store'
  };
}
async function readDB() {
  try { return JSON.parse(await fs.readFile(DATA_FILE,'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {rooms:{}}; throw e; }
}
async function writeDB(data) {
  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, DATA_FILE);
}
function queuedWrite(fn) {
  writeChain = writeChain.then(fn,fn);
  return writeChain;
}
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let size=0, chunks=[];
    req.on('data',chunk=>{ size += chunk.length; if(size > MAX_BODY){ reject(new Error('Request too large')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error',reject);
  });
}
function sanitizeSnapshot(data) {
  if (!data || typeof data !== 'object') throw new Error('Missing data');
  const walks = Array.isArray(data.walks) ? data.walks : [];
  const landmarks = Array.isArray(data.landmarks) ? data.landmarks : [];
  const visits = Array.isArray(data.visits) ? data.visits : [];
  if (walks.length > 20000 || landmarks.length > 10000 || visits.length > 100000) throw new Error('Dataset too large');
  return {version:3, walks, landmarks, visits};
}

async function handleApi(req,res,url) {
  const headers=apiHeaders();
  if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return;}
  const match=url.pathname.match(/^\/api\/room\/([^/]+)$/);
  if(!match)return send(res,404,{error:'Not found'},headers);
  const room=decodeURIComponent(match[1]);
  if(!validRoom(room))return send(res,400,{error:'Invalid room id'},headers);

  if(req.method==='GET'){
    const db=await readDB(); const found=db.rooms?.[room];
    if(!found)return send(res,404,{error:'Room not found'},headers);
    return send(res,200,{room,updatedAt:found.updatedAt,data:found.data},headers);
  }

  if(req.method==='POST'){
    const ownerKey=req.headers['x-owner-key'];
    if(!ownerKey || String(ownerKey).length<16)return send(res,401,{error:'Owner key required'},headers);
    let payload;
    try{payload=JSON.parse(await readBody(req));}catch(e){return send(res,400,{error:e.message==='Request too large'?e.message:'Invalid JSON'},headers);}
    let clean;
    try{clean=sanitizeSnapshot(payload.data);}catch(e){return send(res,400,{error:e.message},headers);}
    try{
      await queuedWrite(async()=>{
        const db=await readDB(); db.rooms ||= {};
        const existing=db.rooms[room];
        if(existing && existing.ownerHash!==hash(ownerKey)){const err=new Error('Wrong owner key');err.status=403;throw err;}
        db.rooms[room]={ownerHash:existing?.ownerHash||hash(ownerKey),updatedAt:Date.now(),data:clean};
        await writeDB(db);
      });
      return send(res,200,{ok:true,room,updatedAt:Date.now()},headers);
    }catch(e){return send(res,e.status||500,{error:e.message||'Server error'},headers);}
  }

  if(req.method==='DELETE'){
    const ownerKey=req.headers['x-owner-key'];
    try{
      let existed=false;
      await queuedWrite(async()=>{
        const db=await readDB(); const existing=db.rooms?.[room];
        if(!existing)return;
        existed=true;
        if(!ownerKey || existing.ownerHash!==hash(ownerKey)){const err=new Error('Wrong owner key');err.status=403;throw err;}
        delete db.rooms[room]; await writeDB(db);
      });
      return send(res,existed?200:404,existed?{ok:true}:{error:'Room not found'},headers);
    }catch(e){return send(res,e.status||500,{error:e.message||'Server error'},headers);}
  }
  send(res,405,{error:'Method not allowed'},headers);
}

async function serveStatic(req,res,url) {
  let rel=decodeURIComponent(url.pathname);
  if(rel==='/')rel='/index.html';
  const full=path.resolve(__dirname,'.'+rel);
  if(!full.startsWith(path.resolve(__dirname)+path.sep))return send(res,403,'Forbidden');
  if(path.basename(full)==='shared-data.json' || path.basename(full)==='server.mjs')return send(res,404,'Not found');
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

server.listen(PORT,HOST,()=>console.log(`Walk Memory v3 running on http://${HOST}:${PORT}`));
