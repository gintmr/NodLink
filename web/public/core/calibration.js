// 校准：生成校准路径，并从“头部角度 ↔ 目标位置”样本中拟合映射模型。
// 做法：参考朝向取圆周平均；在正切空间做仿射 / 二次最小二乘；搜索 0～800 ms 的跟随延迟；剔除离群点再拟合。
// 时间单位 ms，角度单位度，坐标单位为舞台像素。

import { RAD, wrapDeg, circularMeanDeg } from './angles.js';
import { leastSquares } from './linalg.js';

export const CALIBRATION_DEFAULTS = {
  margin: 0.08,       // 目标离屏幕边缘的距离（占宽高的比例）
  centerMs: 2500,     // 看中心
  cornerMs: 2000,     // 每个角停留
  lapMs: 9000,        // 沿边走一圈
  laps: 2,
  settleMs: 500,      // 目标跳到新位置后丢弃的时长
  maxLagMs: 800,
  lagStepMs: 10,
  outlierK: 2.5,      // 残差超过 K 倍 RMS 视为离群点
  outlierRounds: 2,
};

/**
 * 路径：中心 → 四个角（左上、右上、右下、左下）→ 从左下角出发沿四边走两圈。
 * 角点之间是瞬间跳转，沿边是匀速移动，两者衔接处没有跳变。
 */
export function makeCalibrationPath(w, h, options = {}) {
  const o = { ...CALIBRATION_DEFAULTS, ...options };
  const mx = w * o.margin;
  const my = h * o.margin;
  const C = { x: w / 2, y: h / 2 };
  const TL = { x: mx, y: my };
  const TR = { x: w - mx, y: my };
  const BR = { x: w - mx, y: h - my };
  const BL = { x: mx, y: h - my };

  const segments = [];
  let t = 0;
  const hold = (p, dur, phase) => {
    segments.push({ kind: 'hold', p, t0: t, t1: t + dur, phase });
    t += dur;
  };
  const move = (a, b, dur, lap) => {
    segments.push({ kind: 'move', a, b, t0: t, t1: t + dur, phase: 'edge', lap });
    t += dur;
  };

  hold(C, o.centerMs, 'center');
  for (const p of [TL, TR, BR, BL]) hold(p, o.cornerMs, 'corner');
  const loop = [BL, TL, TR, BR, BL];
  const lens = loop.slice(1).map((p, i) => Math.hypot(p.x - loop[i].x, p.y - loop[i].y));
  const perimeter = lens.reduce((a, b) => a + b, 0);
  for (let lap = 1; lap <= o.laps; lap++) {
    lens.forEach((len, i) => move(loop[i], loop[i + 1], (o.lapMs * len) / perimeter, lap));
  }

  return {
    w,
    h,
    duration: t,
    segments,
    /** 返回 t 时刻的目标；sinceJump 为距离上次跳转的时长，移动段视为没有跳转 */
    at(tm) {
      if (tm < 0 || tm >= t) return null;
      const s = segments.find((seg) => tm < seg.t1);
      if (s.kind === 'hold') return { x: s.p.x, y: s.p.y, phase: s.phase, sinceJump: tm - s.t0 };
      const f = (tm - s.t0) / (s.t1 - s.t0);
      return {
        x: s.a.x + f * (s.b.x - s.a.x),
        y: s.a.y + f * (s.b.y - s.a.y),
        phase: s.phase,
        lap: s.lap,
        sinceJump: Infinity,
      };
    },
  };
}

/** 正切空间特征：头部指向平面屏幕时，屏幕坐标与 tan(角度) 近似线性 */
export function features(h, v, kind) {
  const th = Math.tan(h * RAD);
  const tv = Math.tan(v * RAD);
  return kind === 'quadratic' ? [1, th, tv, th * th, tv * tv, th * tv] : [1, th, tv];
}

export function predict(model, h, v) {
  const f = features(h, v, model.kind);
  let x = 0;
  let y = 0;
  for (let i = 0; i < f.length; i++) {
    x += model.cx[i] * f[i];
    y += model.cy[i] * f[i];
  }
  return { x, y };
}

/** pairs: [{ h, v, x, y }]，h/v 为相对参考朝向的角度 */
export function fitModel(pairs, kind) {
  const [cx, cy] = leastSquares(
    pairs.map((p) => features(p.h, p.v, kind)),
    [pairs.map((p) => p.x), pairs.map((p) => p.y)],
  );
  const model = { kind, cx, cy };
  model.rms = rmsError(model, pairs);
  model.n = pairs.length;
  return model;
}

function residual(model, p) {
  const q = predict(model, p.h, p.v);
  return Math.hypot(q.x - p.x, q.y - p.y);
}

function rmsError(model, pairs) {
  let s = 0;
  for (const p of pairs) s += residual(model, p) ** 2;
  return Math.sqrt(s / pairs.length);
}

/** 拟合后剔除离群点再拟合，共 outlierRounds 轮 */
export function robustFit(pairs, kind, options = {}) {
  const o = { ...CALIBRATION_DEFAULTS, ...options };
  let kept = pairs;
  let model = fitModel(kept, kind);
  for (let r = 0; r < o.outlierRounds; r++) {
    const limit = o.outlierK * model.rms;
    kept = kept.filter((p) => residual(model, p) <= limit);
    model = fitModel(kept, kind);
  }
  model.rejected = pairs.length - kept.length;
  return model;
}

/**
 * samples: [{ t, h, v }]，t 为相对校准开始的 ms，h/v 为映射后的绝对角度（度）。
 * 返回参考朝向、估计的跟随延迟、延迟-残差曲线，以及仿射和二次两个模型。
 */
export function calibrate(samples, path, options = {}) {
  const o = { ...CALIBRATION_DEFAULTS, ...options };

  // 1. 参考朝向：中心阶段（跳过开头 settleMs）的圆周平均
  const centerEnd = path.segments[0].t1;
  const refSamples = samples.filter((s) => s.t >= o.settleMs && s.t < centerEnd);
  if (refSamples.length < 5) throw new Error('看中心阶段的样本太少，检查数据源是否在发数据');
  const ref = {
    h: circularMeanDeg(refSamples.map((s) => s.h)),
    v: circularMeanDeg(refSamples.map((s) => s.v)),
  };
  const rel = samples.map((s) => ({ t: s.t, h: wrapDeg(s.h - ref.h), v: wrapDeg(s.v - ref.v) }));

  // 2. 把每个样本和 lag 毫秒之前的目标配对，丢掉跳转后 settleMs 内的样本
  const pairsAt = (lag) => {
    const out = [];
    for (const s of rel) {
      const p = path.at(s.t - lag);
      if (p && p.sinceJump >= o.settleMs) out.push({ h: s.h, v: s.v, x: p.x, y: p.y });
    }
    return out;
  };

  // 3. 延迟搜索：取仿射拟合残差最小的延迟
  const lagCurve = [];
  let best = null;
  for (let lag = 0; lag <= o.maxLagMs; lag += o.lagStepMs) {
    const pairs = pairsAt(lag);
    if (pairs.length < 20) continue;
    const { rms } = fitModel(pairs, 'affine');
    lagCurve.push({ lag, rms });
    if (!best || rms < best.rms) best = { lag, rms };
  }
  if (!best) throw new Error('有效样本太少，无法拟合');

  // 4. 用最佳延迟做带离群点剔除的拟合
  const pairs = pairsAt(best.lag);
  return {
    ref,
    lagMs: best.lag,
    lagCurve,
    sampleCount: samples.length,
    models: {
      affine: robustFit(pairs, 'affine', o),
      quadratic: robustFit(pairs, 'quadratic', o),
    },
  };
}

/**
 * 多点定点校准（比如每块显示器的中心）：用户依次对准已知的屏幕点。
 * 拟合各向同性模型 x = a + G·tan(h)，y = b − G·tan(v)：G 是“头转动对应的像素数”，
 * 只需两个点就能解出。points: [{ x, y, h, v }]，h / v 为相对参考朝向的角度。
 * 返回和 fitModel 相同结构的仿射模型，可以直接给 AbsolutePointer 使用。
 */
export function fitCenters(points) {
  if (points.length < 2) throw new Error('至少需要两个定点');
  const rows = [];
  const ys = [];
  for (const p of points) {
    const th = Math.tan(p.h * RAD);
    const tv = Math.tan(p.v * RAD);
    rows.push([1, 0, th]);
    ys.push(p.x);
    rows.push([0, 1, -tv]);
    ys.push(p.y);
  }
  const [[a, b, G]] = leastSquares(rows, [ys]);
  if (!(G > 0)) throw new Error('几个定点的头部角度几乎没有差别，无法算出比例；请确认转头对准了每个点');
  const model = { kind: 'affine', cx: [a, G, 0], cy: [b, 0, -G], G };
  model.rms = rmsError(model, points);
  model.n = points.length;
  model.rejected = 0;
  return model;
}
