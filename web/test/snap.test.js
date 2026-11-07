// 吸附：头部落点抖动时，选中的按钮要稳；真想换到别的按钮时，又要换得过去。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Snapper, rectDist } from '../public/core/snap.js';
import { mulberry32 } from '../public/core/sim.js';

const DT = 20;
const btn = (cx, cy, w = 24, h = 24) => ({ x: cx - w / 2, y: cy - h / 2, w, h });
const gaussian = (seed) => {
  const rnd = mulberry32(seed);
  return () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
};

test('点到矩形的距离', () => {
  const r = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(rectDist({ x: 5, y: 5 }, r), 0);
  assert.equal(rectDist({ x: 13, y: 14 }, r), 5);
});

test('落点在两个按钮分界附近抖动：选中项基本不跳，光标停在按钮中心不动', () => {
  const a = btn(100, 100);
  const b = btn(140, 100);
  const s = new Snapper();
  s.setTargets([a, b]);
  const g = gaussian(3);
  let nearestFlips = 0;
  let lastNearest = null;
  const points = new Set();
  for (let t = 0; t < 10_000; t += DT) {
    // 分界线在 x = 120，落点在 117 附近抖 8 点
    const p = { x: 117 + 8 * g(), y: 100 + 8 * g() };
    const r = s.update(t, p);
    points.add(`${r.point.x},${r.point.y}`);
    const nearest = rectDist(p, a) <= rectDist(p, b) ? a : b;
    if (nearest !== lastNearest) nearestFlips += 1;
    lastNearest = nearest;
  }
  assert.ok(nearestFlips > 50, `只看最近会跳 ${nearestFlips} 次`);
  assert.ok(s.switches <= 3, `加滞回后换了 ${s.switches} 次`);
  assert.ok(points.size <= 3);
});

test('真想换：头移到另一个按钮上，很快就换过去', () => {
  const a = btn(100, 100);
  const b = btn(200, 100);
  const s = new Snapper();
  s.setTargets([a, b]);
  for (let t = 0; t < 500; t += DT) s.update(t, { x: 100, y: 100 });
  assert.equal(s.current, a);
  let switchedAt = null;
  for (let t = 500; t < 1500; t += DT) {
    const x = Math.min(100 + (t - 500) * 0.4, 200); // 250 ms 移过去
    if (s.update(t, { x, y: 100 }).target === b && switchedAt == null) switchedAt = t;
  }
  assert.ok(switchedAt != null && switchedAt < 500 + 250 + 200, `${switchedAt} ms 换过去`);
});

test('离所有元素都远：不吸附；大元素里光标留在落点；嵌套时选里层的按钮', () => {
  const field = { x: 0, y: 0, w: 400, h: 200 };
  const inner = btn(380, 20, 20, 20);
  const s = new Snapper();
  s.setTargets([field, inner]);
  assert.deepEqual(s.update(0, { x: 150, y: 90 }).point, { x: 150, y: 90 });
  s.clear();
  assert.equal(s.update(0, { x: 381, y: 21 }).target, inner);
  s.setTargets([btn(100, 100)]);
  assert.equal(s.update(100, { x: 400, y: 400 }).target, null);
});

test('模拟：落点抖 10 点、按钮 24 点、间距 60 点，吸附后几乎一直在要点的按钮上', () => {
  const items = [];
  for (let i = 0; i < 7; i++) for (let j = 0; j < 5; j++) items.push(btn(100 + i * 60, 100 + j * 60));
  const g = gaussian(11);
  let rawHit = 0;
  let snapHit = 0;
  let n = 0;
  for (const goal of items) {
    const s = new Snapper();
    s.setTargets(items);
    const c = { x: goal.x + goal.w / 2, y: goal.y + goal.h / 2 };
    for (let t = 0; t < 3000; t += DT) {
      const p = { x: c.x + 10 * g(), y: c.y + 10 * g() };
      const r = s.update(t, p);
      if (t < 500) continue; // 刚到的半秒不算
      n += 1;
      if (rectDist(p, goal) === 0) rawHit += 1;
      if (r.target === goal) snapHit += 1;
    }
  }
  const raw = rawHit / n;
  const snap = snapHit / n;
  assert.ok(raw < 0.6, `不吸附时落在按钮上的时间 ${(raw * 100).toFixed(0)}%`);
  assert.ok(snap > 0.97, `吸附后选中正确按钮的时间 ${(snap * 100).toFixed(0)}%`);
});
