// 精细模式：头的轻微晃动要被压下去，大幅转头照样跟得上、最后对准头指的位置。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbsolutePointer } from '../public/core/pointer.js';

const G = 3000;
const cal = { ref: { h: 0, v: 0 }, models: { affine: { kind: 'affine', cx: [960, G, 0], cy: [540, 0, -G] } } };
const make = (precise) => {
  const p = new AbsolutePointer(cal, 'affine', { minCutoff: 1, beta: 0.01, dCutoff: 1 });
  p.setPrecision(precise ? {} : null);
  return p;
};

test('精细模式：±1° 的慢晃动，光标晃动幅度小一半以上；转头 15° 后回到头指的位置附近', () => {
  const range = (p) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 6; t += 0.02) {
      const x = p.update(Math.sin(2 * Math.PI * 0.4 * t), 0, t).x;
      if (t > 2) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
    return hi - lo;
  };
  const plain = range(make(false));
  const precise = make(true);
  const fine = range(precise);
  assert.ok(fine < plain * 0.5, `晃动 ${fine.toFixed(0)} px，原样 ${plain.toFixed(0)} px`);

  // 0.3 秒转过 15°，再停 1 秒
  for (let t = 6; t < 7.3; t += 0.02) precise.update(15 * Math.min((t - 6) / 0.3, 1), 0, t);
  const err = Math.hypot(precise.position.x - precise.absolute.x, precise.position.y - precise.absolute.y);
  assert.ok(err <= 80, `转头后离头指的位置 ${err.toFixed(0)} px`);
});

// ---------- 水平漂移 ----------

import { YawDrift } from '../public/core/drift.js';
import { mulberry32 } from '../public/core/sim.js';

/** 20 分钟里在屏幕上看来看去（±15°，每处约 10 秒），耳机每分钟漂 ratePerMin°：返回 [纠正后, 不纠正] 的误差（第 5 分钟起，10 种看法取平均） */
function driftRms(ratePerMin) {
  const one = (seed) => {
    const d = new YawDrift();
    const rnd = mulberry32(seed);
    let target = 0;
    let se = 0;
    let seRaw = 0;
    let n = 0;
    for (let t = 0; t < 1200; t += 0.02) {
      if (rnd() < 0.002) target = (rnd() - 0.5) * 30;
      const truth = target + 0.3 * Math.sin(t * 3);
      const measured = truth + (ratePerMin / 60) * t; // 漂移
      const off = d.update(t, measured);
      if (t > 300) {
        se += (measured - off - truth) ** 2;
        seRaw += (measured - truth) ** 2;
        n += 1;
      }
    }
    return [Math.sqrt(se / n), Math.sqrt(seRaw / n)];
  };
  const r = Array.from({ length: 10 }, (_, i) => one(i + 1));
  return [r.reduce((a, x) => a + x[0], 0) / r.length, r.reduce((a, x) => a + x[1], 0) / r.length];
}

// 实测（耳机桥日志）漂移每分钟 0.4～2.3°，方向不变
test('水平漂移：每分钟漂 2°，纠正后的误差不到不纠正的五分之一，而且在 4° 以内', () => {
  const [fixed, raw] = driftRms(2);
  assert.ok(fixed < raw * 0.2 && fixed < 4, `纠正后 ${fixed.toFixed(1)}°，不纠正 ${raw.toFixed(1)}°`);
});

test('水平漂移：每分钟漂 0.5°，纠正后也比不纠正好', () => {
  const [fixed, raw] = driftRms(0.5);
  assert.ok(fixed < raw * 0.75, `纠正后 ${fixed.toFixed(1)}°，不纠正 ${raw.toFixed(1)}°`);
});

test('水平漂移：回中只清漂移量，学到的漂移速度留着', () => {
  const d = new YawDrift();
  for (let t = 0; t < 900; t += 0.02) d.update(t, (2 / 60) * t);
  const rate = d.rate;
  assert.ok(rate * 60 > 1, `学到 ${(rate * 60).toFixed(2)}°/分`);
  d.recenter();
  assert.equal(d.offset, 0);
  assert.equal(d.rate, rate);
  d.reset();
  assert.equal(d.rate, 0);
});

test('水平漂移：拉回很慢，正常看屏幕一侧 10 秒，光标只被挪动不到 0.7°（最快 4°/分）', () => {
  const d = new YawDrift();
  for (let t = 0; t < 10; t += 0.02) d.update(t, 12);
  assert.ok(Math.abs(d.offset) < 0.7, `挪了 ${d.offset.toFixed(2)}°`);
});
