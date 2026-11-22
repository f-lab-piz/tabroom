import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const [profile, extensionId] = process.argv.slice(2);
const origin = 'chrome-extension://' + extensionId;
let connection, endpoint, pending, sequence = 0;
let previous = new Map(), total = 0, generation = randomUUID();

async function connect(port, route) {
  const url = 'ws://127.0.0.1:' + port + route;
  if (connection?.readyState === WebSocket.OPEN && endpoint === url) return connection;
  if (endpoint !== url) {
    previous = new Map();
    total = 0;
    generation = randomUUID();
  }
  connection?.close();
  endpoint = url;
  const socket = new WebSocket(url);
  connection = socket;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(Error('Connection timeout')); socket.close(); }, 1800);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(Error('Browser unavailable')); };
  });
  return socket;
}

async function sample() {
  const [port, route] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const socket = await connect(port, route);
  const id = ++sequence;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Sampling timeout')), 1800);
    socket.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.id !== id) return;
      clearTimeout(timer);
      if (data.error) reject(Error('Process counters unavailable')); else resolve(data.result.processInfo);
    };
    socket.send(JSON.stringify({id, method:'SystemInfo.getProcessInfo'}));
  });
  const now = performance.now();
  const next = new Map();
  for (const {id, cpuTime} of result) {
    next.set(id, cpuTime);
    if (previous.size) total += Math.max(0, cpuTime - (previous.get(id) ?? 0));
  }
  previous = next;
  return {time:now, cpuSeconds:total, generation, processes:result.length};
}

http.createServer(async (req, res) => {
  if (req.headers.host !== '127.0.0.1:18838') return res.writeHead(403).end();
  if (req.url === '/health' && !req.headers.origin) return res.end('tabroom-cpu-v1');
  if (req.url !== '/cpu' || (req.headers.origin && req.headers.origin !== origin)) return res.writeHead(403).end();
  if (req.method === 'OPTIONS' && req.headers.origin === origin) {
    return res.writeHead(204, {'Access-Control-Allow-Origin':origin, 'Access-Control-Allow-Methods':'GET', 'Access-Control-Allow-Headers':'X-Tabroom-Client'}).end();
  }
  if (req.method !== 'GET' || req.headers['x-tabroom-client'] !== extensionId) return res.writeHead(403).end();
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type','application/json');
  try {
    pending ??= sample().finally(() => { pending = null; });
    res.end(JSON.stringify(await pending));
  } catch { res.writeHead(503).end('{"error":"browser unavailable"}'); }
}).listen(18838,'127.0.0.1');
