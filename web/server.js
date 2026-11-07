// NodLink 中继服务：提供调试网页，并把数据源（耳机桥）发来的消息转发给所有网页。
// 数据源连接 ws://<Mac 的地址>:8787/ws?role=source，网页连接 /ws?role=view。
// 数据源 → 网页：姿态、事件、显示器布局；网页 → 数据源：叠加层和鼠标指令。
// 协议见 docs/protocol.md。

import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const HERE = path.dirname(fileURLToPath(import.meta.url));
// NODLINK_ROOT=dist：预览构建好的公开体验版（npm run preview:public）
const ROOT = path.resolve(HERE, process.env.NODLINK_ROOT || 'public');
// three.js 从本地 node_modules 提供，离线演示也能用
const VENDOR = {
  '/vendor/three': path.join(HERE, 'node_modules', 'three'),
  '/vendor/fonts': path.join(HERE, 'node_modules', '@fontsource-variable', 'unbounded', 'files'),
  '/vendor/sora': path.join(HERE, 'node_modules', '@fontsource-variable', 'sora'),
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/models') {
    // public/models 里的 3D 模型列表，供调试台的模型切换器使用
    const files = (await readdir(path.join(ROOT, 'models')).catch(() => [])).filter((f) => /\.(glb|gltf)$/i.test(f));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(files));
    return;
  }
  const prefix = Object.keys(VENDOR).find((p) => pathname.startsWith(`${p}/`));
  const base = prefix ? VENDOR[prefix] : ROOT;
  const rel = prefix ? pathname.slice(prefix.length) : pathname;
  const file = path.join(base, path.normalize(rel === '/' ? '/index.html' : rel));
  if (!file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
const sources = new Set();
const views = new Set();

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://localhost').searchParams.get('role') === 'source' ? 'source' : 'view';
  (role === 'source' ? sources : views).add(ws);
  console.log(`[${role}] 已连接 ${req.socket.remoteAddress}`);
  broadcastStatus();

  // 数据源的消息发给所有网页；网页的指令（叠加层、移动鼠标等）发给所有数据源
  ws.on('message', (data, isBinary) => {
    const to = role === 'source' ? views : sources;
    for (const c of to) if (c.readyState === c.OPEN) c.send(data, { binary: isBinary });
  });
  ws.on('close', () => {
    sources.delete(ws);
    views.delete(ws);
    console.log(`[${role}] 已断开`);
    broadcastStatus();
  });
});

function broadcastStatus() {
  const msg = JSON.stringify({ type: 'relay', sources: sources.size, views: views.size });
  for (const v of views) if (v.readyState === v.OPEN) v.send(msg);
}

// ws 会把 server 的监听错误转发到 wss 上，所以在 wss 上处理
wss.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`端口 ${PORT} 已被占用，可能已有一个中继在运行。`);
  console.error(`查看占用进程：lsof -nP -iTCP:${PORT} -sTCP:LISTEN；或换端口：PORT=8788 npm start`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`调试网页：http://localhost:${PORT}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`数据源地址：ws://${a.address}:${PORT}/ws?role=source`);
    }
  }
});
