// 假的数据源：按协议发送缓慢画圈的头部姿态，用来在没有耳机时测试中继和网页的“实时”通路。
// 用法：node tools/fake-source.js [ws://localhost:8787/ws?role=source] [频率 Hz]

import WebSocket from 'ws';

const url = process.argv[2] ?? 'ws://localhost:8787/ws?role=source';
const rateHz = Number(process.argv[3]) || 25;
const ws = new WebSocket(url);
const start = Date.now();

ws.on('open', () => {
  console.log(`已连接 ${url}，以 ${rateHz} Hz 发送`);
  ws.send(JSON.stringify({ type: 'hello', device: 'fake-source', rateHz }));
  setInterval(() => {
    const t = (Date.now() - start) / 1000;
    ws.send(JSON.stringify({
      type: 'motion',
      t,
      yaw: 0.15 * Math.sin((2 * Math.PI * t) / 6),
      pitch: 0.08 * Math.cos((2 * Math.PI * t) / 6),
      roll: 0,
    }));
  }, 1000 / rateHz);
});
ws.on('close', () => process.exit(0));
ws.on('error', (err) => {
  console.error(`连接失败：${err.message}（中继服务启动了吗？）`);
  process.exit(1);
});
