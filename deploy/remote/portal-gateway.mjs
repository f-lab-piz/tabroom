import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer,request} from 'node:http';
import {dirname,join} from 'node:path';
import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import {WebSocketServer,WebSocket} from 'ws';

const [configuration, sourceDir, publicOrigin] = process.argv.slice(2);
const {password,profileKey,signingKey,accountProfile,hostSecret}=JSON.parse(readFileSync(configuration,'utf8'));
const agentPath=join(dirname(dirname(configuration)),'agent.sock');
const extensionOrigin='chrome-extension://hmngikndankgldefcihbegdepaomgnlb';
const portal=new URL('http://127.0.0.1:18840');
const listen='127.0.0.1';
const gatewayPort=18847;
const limit=8*1024*1024;
const assets=new Set(['/', '/portal.html','/app.js','/styles.css','/monitor.js','/native-cpu.js',
  '/streams.js','/agent-ui.js','/composer.js','/site-picker.js','/interactive-ui/styles.css','/interactive-ui/protocol.js',
  '/interactive-ui/references.js','/interactive-ui/markdown.js','/interactive-ui/chart.js','/interactive-ui/render.js',
  '/favicon.ico','/downloads/tabroom-extension.zip']);
const portalFile=join(sourceDir,'portal.html');
const browserSockets=new WebSocketServer({noServer:true,maxPayload:limit,perMessageDeflate:false});
const macSockets=new WebSocketServer({noServer:true,maxPayload:limit,perMessageDeflate:false});
const macViewers=new Map();
let macHost;
const tickets=new Map();
const attempts=new Map();

function equal(left,right) {
  if (typeof left!=='string' || typeof right!=='string') return false;
  const a=Buffer.from(left);
  const b=Buffer.from(right);
  return a.length===b.length && timingSafeEqual(a,b);
}
function signed(time) {
  return createHmac('sha256',signingKey).update(time).digest('base64url');
}
function authorised(req) {
  const match=req.headers.cookie?.match(/(?:^|;\s*)__Host-tabroom=([0-9]{10})\.([A-Za-z0-9_-]{43})(?:;|$)/);
  if (!match) return false;
  const remaining=Number(match[1])-Math.floor(Date.now()/1000);
  return remaining>0 && remaining<=86400 && equal(match[2],signed(match[1]));
}
function output(res, status, data='', type='text/plain; charset=utf-8') {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  res.end(data);
}
function login(res,error='') {
  output(res,error?401:200,`<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>탭룸</title>
<style>body{margin:0;background:#f1f5fa;color:#16253a;font:16px system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}main{width:min(320px,76vw);padding:32px;background:#fff;border:1px solid #dde6f3;border-radius:17px}h1{margin:0 0 20px}label,input,button{box-sizing:border-box;width:100%;font:inherit}input,button{padding:11px;margin-top:9px;border-radius:8px;border:1px solid #bdcee3}button{background:#285d9f;color:white;border:0;margin-top:15px}p{color:#9b2c3d}</style>
<main><h1>탭룸</h1><form method="post" action="/login"><label>접속 코드<input name="password" type="password" autocomplete="current-password" required maxlength="140"></label><button>접속</button>${error ? '<p role="alert">접속 코드가 맞지 않아요.</p>' : ''}</form></main></html>`,'text/html; charset=utf-8');
}

function proxy(req,res) {
  const headers={'Host': portal.host};
  if (req.headers['content-type']) headers['Content-Type']=req.headers['content-type'];
  if (req.headers['content-length']) headers['Content-Length']=req.headers['content-length'];
  if (req.headers.range) headers.Range=req.headers.range;
  const upstream=request(portal.origin+req.url,{method:req.method,headers},(response)=>{
    const safeHeaders={...response.headers,'cache-control':'no-store','x-content-type-options':'nosniff'};
    delete safeHeaders.server;
    res.writeHead(response.statusCode,safeHeaders);
    response.pipe(res);
  });
  upstream.on('error',()=>output(res,502,'탭룸 포털에 연결할 수 없어요.'));
  req.pipe(upstream);
}

const gateway=createServer(async (req,res)=>{
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) return output(res,400);
  const path=new URL(req.url,publicOrigin).pathname;
  if (req.method==='POST' && path==='/login') {
    if (req.headers.origin!==publicOrigin || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return output(res,403);
    const source=req.headers['x-forwarded-for']?.split(',').at(-1).trim() || req.socket.remoteAddress;
    const now=Date.now();
    for (const [key,item] of attempts) if (now-item.since>600000) attempts.delete(key);
    const item=attempts.get(source) || {count:0,since:now};
    const recentFailures=[...attempts.values()].reduce((total,entry)=>total+entry.count,0);
    if (item.count>=6 || recentFailures>=30) return output(res,429,'잠시 뒤 다시 접속해 주세요.');
    const chunks=[];
    let length=0;
    try {
      for await (const chunk of req) {
        length+=chunk.length;
        if (length>512) return output(res,413);
        chunks.push(chunk);
      }
    } catch { return; }
    if (!equal(new URLSearchParams(Buffer.concat(chunks).toString()).get('password'),password)) {
      item.count++;
      attempts.set(source,item);
      return login(res,true);
    }
    attempts.delete(source);
    const time=String(Math.floor(Date.now()/1000)+86400);
    res.writeHead(303,{'Location':'/','Set-Cookie':`__Host-tabroom=${time}.${signed(time)}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Strict`,
      'Cache-Control':'no-store'});
    return res.end();
  }
  if (!authorised(req)) {
    if (req.method==='GET' && (path==='/' || path==='/login')) return login(res);
    return output(res,401);
  }
  if (req.method==='GET' && path==='/mac-status') {
    return output(res,macHost?.readyState===WebSocket.OPEN ? 204 : 503);
  }
  if (req.method==='POST' && path==='/browser/connect') {
    if (req.headers.origin!==publicOrigin) return output(res,403);
    const now=Date.now();
    for (const [ticket,expires] of tickets) if (expires<=now) tickets.delete(ticket);
    if (tickets.size>=64) return output(res,429);
    const ticket=randomBytes(32).toString('base64url');
    tickets.set(ticket,now+30000);
    return output(res,200,JSON.stringify({ticket}),'application/json; charset=utf-8');
  }
  if (req.method==='POST' && path==='/api/deeplinks') {
    if (req.headers.origin!==publicOrigin) return output(res,403);
    const length=Number(req.headers['content-length']);
    if (!Number.isInteger(length) || length<1 || length>4096) return output(res,413);
    return proxy(req,res);
  }
  if (!['GET','HEAD'].includes(req.method)) return output(res,405);
  if (path==='/' || path==='/portal.html') {
    const html=readFileSync(portalFile,'utf8').replace('<body class="portal">','<body class="portal" data-remote="true">');
    return output(res,200,html,'text/html; charset=utf-8');
  }
  if (!assets.has(path) && !/^\/deeplinks\/[a-z0-9-]+\.jpg$/.test(path)) return output(res,404);
  return proxy(req,res);
});

function reject(socket,status) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function send(socket, message) {
  if (socket?.readyState!==WebSocket.OPEN) return;
  if (socket.bufferedAmount>limit*2) return socket.close(1013);
  socket.send(JSON.stringify(message));
}
function decode(socket,data) {
  try {
    const result=JSON.parse(data.toString());
    if (result && typeof result==='object' && !Array.isArray(result)) return result;
  } catch {}
  socket.close(1007);
}
function remoteProfile(device) {
  const hex=createHmac('sha256',profileKey).update(device).digest('hex');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20,32)].join('-');
}

function connectMacViewer(req,socket,head) {
  if (!authorised(req) || req.headers.origin!==publicOrigin) return reject(socket,'403 Forbidden');
  if (macHost?.readyState!==WebSocket.OPEN) return reject(socket,'503 Service Unavailable');
  if (macViewers.size>=4) return reject(socket,'429 Too Many Requests');
  macSockets.handleUpgrade(req,socket,head,connection=>{
    const id=randomBytes(16).toString('hex');
    const host=macHost;
    macViewers.set(id,connection);
    send(host,{type:'open',id});
    let alive=true;
    const heartbeat=setInterval(()=>{
      if (!authorised(req) || !alive) return connection.terminate();
      alive=false;
      connection.ping();
    },25000);
    connection.on('pong',()=>{alive=true;});
    connection.on('error',()=>connection.terminate());
    connection.on('close',()=>{
      clearInterval(heartbeat);
      macViewers.delete(id);
      send(host,{type:'close',id});
    });
    connection.on('message',raw=>{
      const message=decode(connection,raw);
      if (message) send(host,{type:'message',id,message});
    });
  });
}

const macGateway=createServer((req,res)=>output(res,404));
macGateway.on('upgrade',(req,socket,head)=>{
  if (req.url!=='/host' || req.headers.origin!==portal.origin || !hostSecret) return reject(socket,'403 Forbidden');
  if (macSockets.clients.size>=6) return reject(socket,'429 Too Many Requests');
  macSockets.handleUpgrade(req,socket,head,connection=>{
    const timer=setTimeout(()=>connection.close(1008),3000);
    connection.on('error',()=>connection.terminate());
    connection.on('close',()=>{
      clearTimeout(timer);
      if (macHost!==connection) return;
      macHost=undefined;
      for (const viewer of macViewers.values()) viewer.close(1011);
    });
    connection.on('message',raw=>{
      const packet=decode(connection,raw);
      if (!packet) return;
      if (macHost!==connection) {
        if (!equal(packet.secret,hostSecret) || macHost) return connection.close(1008);
        macHost=connection;
        clearTimeout(timer);
        send(connection,{type:'ready'});
        return;
      }
      const viewer=macViewers.get(packet.id);
      if (packet.type==='message' && packet.message && typeof packet.message==='object') send(viewer,packet.message);
      if (packet.type==='close') viewer?.close(1011);
    });
  });
});

gateway.on('upgrade',(req,socket,head)=>{
  if (req.url==='/mac-viewer') return connectMacViewer(req,socket,head);
  if (req.url!=='/browser-agent' || req.headers.origin!==extensionOrigin) return reject(socket,'403 Forbidden');
  if (browserSockets.clients.size>=24) return reject(socket,'429 Too Many Requests');
  browserSockets.handleUpgrade(req,socket,head,(connection)=>{
    let agent;
    let ready=false;
    const timer=setTimeout(()=>connection.close(1008),3500);
    connection.on('error',()=>connection.close());
    connection.on('close',()=>{
      clearTimeout(timer);
      agent?.destroy();
    });
    connection.on('message',(raw)=>{
      const packet=decode(connection,raw);
      if (!packet) return;
      if (!agent) {
        const {device,ticket}=packet;
        const expiry=tickets.get(ticket);
        if (!expiry || expiry<=Date.now() || typeof device!=='string' || !/^[a-f0-9-]{36}$/.test(device)) return connection.close(1008);
        tickets.delete(ticket);
        const profile=remoteProfile(device);
        agent=createConnection(agentPath);
        agent.on('error',()=>connection.close(1011));
        agent.on('close',()=>connection.close(1011));
        agent.once('connect',()=>{
          if (connection.readyState!==WebSocket.OPEN) return agent.destroy();
          agent.write(JSON.stringify({type:'hello',profile,accountProfile})+'\n');
          ready=true;
          clearTimeout(timer);
          send(connection,{type:'ready',profile});
        });
        createInterface({input:agent,crlfDelay:Infinity}).on('line',(line)=>{
          if (Buffer.byteLength(line)>limit) return connection.close(1009);
          const packet=decode(connection,line);
          if (packet) send(connection,packet);
        });
        return;
      }
      if (!ready) return connection.close(1008);
      if (packet.type==='keepalive') return;
      if (!['api','reply','event'].includes(packet.type)) return connection.close(1008);
      if (agent.writableLength>limit) return connection.close(1013);
      agent.write(JSON.stringify(packet)+'\n');
    });
  });
});

macGateway.listen(18846,listen);
gateway.listen(gatewayPort,listen);
