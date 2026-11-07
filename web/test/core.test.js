// 用模拟头部检验核心算法：已知延迟、噪声、漂移，看算法能否还原。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapDeg, circularMeanDeg } from '../public/core/angles.js';
import { makeCalibrationPath, calibrate } from '../public/core/calibration.js';
import { OneEuroFilter } from '../public/core/filter.js';
import { AbsolutePointer } from '../public/core/pointer.js';
import { makeGridTest, evaluateGrid } from '../public/core/accuracy.js';
import { SimHead, mulberry32 } from '../public/core/sim.js';

const STAGE = { w: 1400, h: 900 };
const DIAG = Math.hypot(STAGE.w, STAGE.h);
const DT = 40; // 25 Hz
const T0 = 10_000;

/** 跑一次完整校准，返回模拟头、校准结果和校准结束时间 */
function runCalibration(simOptions) {
  const sim = new SimHead({ rateHz: 25, ...simOptions });
  const path = makeCalibrationPath(STAGE.w, STAGE.h);
  const center = { x: STAGE.w / 2, y: STAGE.h / 2 };
  const samples = [];
  for (let t = T0 - 2000; t < T0 + path.duration; t += DT) {
    const s = sim.step(t, t < T0 ? center : path.at(t - T0), STAGE);
    if (t >= T0) samples.push({ t: t - T0, h: s.yaw, v: s.pitch });
  }
  return { sim, result: calibrate(samples, path), tEnd: T0 + path.duration };
}

function runGrid(sim, pointer, tStart, { rounds = 1, correctGain = 0 } = {}) {
  const grid = makeGridTest(STAGE.w, STAGE.h, { rounds });
  const records = [];
  let last = 0;
  for (let t = 0; t < grid.duration; t += DT) {
    const target = grid.at(t);
    if (target.index > last) {
      if (correctGain) pointer.correct(grid.targets[last], correctGain);
      last = target.index;
    }
    const s = sim.step(tStart + t, target, STAGE);
    const p = pointer.update(s.yaw, s.pitch, (tStart + t) / 1000);
    records.push({ t, x: p.x, y: p.y });
  }
  return evaluateGrid(grid, records);
}

test('角度回绕与圆周平均', () => {
  assert.equal(wrapDeg(190), -170);
  assert.equal(wrapDeg(-190), 170);
  assert.ok(Math.abs(wrapDeg(circularMeanDeg([179, -179]) - 180)) < 1e-9);
});

test('校准能还原已知延迟，误差远小于 1% 对角线', () => {
  const { result } = runCalibration({ lagMs: 200, tauMs: 0, noiseDeg: 0.1, yawOffset: 175, seed: 7 });
  assert.ok(Math.abs(result.lagMs - 200) <= 20, `估计延迟 ${result.lagMs} ms`);
  assert.ok(result.models.affine.rms / DIAG < 0.01, `仿射 RMS ${result.models.affine.rms.toFixed(1)} px`);
  assert.ok(result.models.quadratic.rms <= result.models.affine.rms * 1.05);
  // yawOffset = 175° 时，屏幕左右两侧跨过 ±180°，参考朝向应在 175° 附近
  assert.ok(Math.abs(wrapDeg(result.ref.h - 175)) < 1);
});

test('无漂移时 9 点误差小于 1% 对角线', () => {
  const { sim, result, tEnd } = runCalibration({ lagMs: 150, tauMs: 80, noiseDeg: 0.2, seed: 3 });
  const pointer = new AbsolutePointer(result, 'affine');
  const r = runGrid(sim, pointer, tEnd + 1000);
  assert.ok(r.meanError / DIAG < 0.01, `平均误差 ${r.meanError.toFixed(1)} px`);
});

test('点击时的漂移校正能显著降低漂移误差', () => {
  const opts = { lagMs: 150, tauMs: 80, noiseDeg: 0.2, driftYawDegPerMin: 3, driftPitchDegPerMin: -1.5, seed: 11 };
  const plain = runCalibration(opts);
  const corrected = runCalibration(opts);
  const without = runGrid(plain.sim, new AbsolutePointer(plain.result), plain.tEnd + 1000, { rounds: 3 });
  const withCorr = runGrid(corrected.sim, new AbsolutePointer(corrected.result), corrected.tEnd + 1000, {
    rounds: 3,
    correctGain: 0.5,
  });
  assert.ok(without.byRound[2] > without.byRound[0], '无校正时误差应随时间增大');
  assert.ok(withCorr.meanError < without.meanError * 0.5,
    `校正后 ${withCorr.meanError.toFixed(1)} px，未校正 ${without.meanError.toFixed(1)} px`);
});

test('One Euro 滤波降低静止抖动', () => {
  const rand = mulberry32(5);
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0.01 });
  let rawVar = 0;
  let outVar = 0;
  for (let i = 0; i < 500; i++) {
    const v = 100 + (rand() - 0.5) * 10;
    const out = f.filter(v, i * 0.04);
    if (i > 50) {
      rawVar += (v - 100) ** 2;
      outVar += (out - 100) ** 2;
    }
  }
  assert.ok(outVar < rawVar * 0.3);
});

test('灵敏度以正前方为中心缩放光标位移', () => {
  const { result } = runCalibration({ lagMs: 0, tauMs: 0, noiseDeg: 0, seed: 2 });
  const full = new AbsolutePointer(result, 'affine', {}, 1);
  const half = new AbsolutePointer(result, 'affine', {}, 0.5);
  const h = result.ref.h + 6;
  const v = result.ref.v - 3;
  const a = full.update(h, v, 0);
  const b = half.update(h, v, 0);
  const c = full.center;
  assert.ok(Math.abs((b.x - c.x) - 0.5 * (a.x - c.x)) < 1e-6);
  assert.ok(Math.abs((b.y - c.y) - 0.5 * (a.y - c.y)) < 1e-6);
});

test('多点定点校准：两块显示器的中心就能算出比例和正前方', async () => {
  const { fitCenters, predict } = await import('../public/core/calibration.js');
  const G = 2800;
  const RADS = Math.PI / 180;
  // 头在 (1000, 500) 正前方；两块屏的中心分别在 (760, 450) 和 (2500, 470)
  const at = (x, y) => ({ x, y, h: Math.atan((x - 1000) / G) / RADS, v: Math.atan((500 - y) / G) / RADS });
  const m = fitCenters([at(760, 450), at(2500, 470)]);
  assert.ok(Math.abs(m.G - G) < 1e-6, `G = ${m.G}`);
  const p = predict(m, 0, 0);
  assert.ok(Math.hypot(p.x - 1000, p.y - 500) < 1e-6);
});

test('增量模式：转头的角度换算成光标位移，并受灵敏度缩放', async () => {
  const { DeltaPointer } = await import('../public/core/pointer.js');
  const d = new DeltaPointer({ G: 2000, gain: 0.5, filter: { minCutoff: 1000, beta: 0 } });
  const bounds = { w: 4000, h: 2000 };
  d.update(0, 0, 0, bounds);
  const start = d.position;
  d.update(5, 0, 0.02, bounds);
  const expect = 0.5 * 2000 * Math.tan(5 * Math.PI / 180);
  assert.ok(Math.abs(d.position.x - start.x - expect) < 1, `位移 ${d.position.x - start.x}，应为 ${expect}`);
});
