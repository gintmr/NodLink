// 模拟头部：跟随一个屏幕目标，加入已知的延迟、平滑、噪声和漂移，
// 用来在没有真机时检验算法是否正确。

import { RAD, wrapDeg } from './angles.js';

export const SIM_DEFAULTS = {
  lagMs: 150,               // 看到目标到转头的延迟（含传输）
  tauMs: 80,                // 一阶平滑，模拟头部转动的惯性
  noiseDeg: 0.2,            // 每个样本的高斯噪声（标准差）
  driftYawDegPerMin: 0,
  driftPitchDegPerMin: 0,
  distancePx: 3000,         // 眼睛到屏幕的距离，按舞台像素计
  rateHz: 25,
  yawOffset: 170,           // 故意靠近 ±180°，检验角度回绕处理
  pitchOffset: -5,
  seed: 1,
};

export class SimHead {
  constructor(options = {}) {
    this.p = { ...SIM_DEFAULTS, ...options };
    this.rand = mulberry32(this.p.seed);
    this.history = [];
    this.state = null;
  }

  set(options) {
    Object.assign(this.p, options);
  }

  /** t：ms；target：当前想指向的点；stage：{ w, h }。返回绝对角度（度） */
  step(t, target, stage) {
    const p = this.p;
    if (target) this.history.push({ t, x: target.x, y: target.y });
    const cutoff = t - p.lagMs - 2000;
    while (this.history.length > 2 && this.history[1].t < cutoff) this.history.shift();

    const goal = this.lookup(t - p.lagMs) ?? { x: stage.w / 2, y: stage.h / 2 };
    if (!this.state) this.state = { x: goal.x, y: goal.y, t };
    const a = p.tauMs > 0 ? 1 - Math.exp(-(t - this.state.t) / p.tauMs) : 1;
    this.state.x += a * (goal.x - this.state.x);
    this.state.y += a * (goal.y - this.state.y);
    // 歪头：调试台按住 [ 或 ] 时设置 rollDeg，同样带惯性
    this.state.r = (this.state.r ?? 0) + a * ((p.rollDeg ?? 0) - (this.state.r ?? 0));
    this.state.t = t;

    // 头在屏幕中心正前方 distancePx 处；h 向右为正，v 向上为正
    const h = Math.atan((this.state.x - stage.w / 2) / p.distancePx) / RAD;
    const v = Math.atan((stage.h / 2 - this.state.y) / p.distancePx) / RAD;
    const minutes = t / 60000;
    return {
      // 模仿 CoreMotion 的实测约定：向左转 yaw 增大（向右转减小），抬头 pitch 增大
      yaw: wrapDeg(p.yawOffset - h + p.driftYawDegPerMin * minutes + this.gauss() * p.noiseDeg),
      pitch: p.pitchOffset + v + p.driftPitchDegPerMin * minutes + this.gauss() * p.noiseDeg,
      roll: this.state.r + this.gauss() * p.noiseDeg,
    };
  }

  lookup(t) {
    const hs = this.history;
    if (!hs.length) return null;
    if (t <= hs[0].t) return hs[0];
    for (let i = hs.length - 1; i >= 0; i--) {
      if (hs[i].t <= t) {
        const a = hs[i];
        const b = hs[i + 1];
        if (!b) return a;
        const f = (t - a.t) / (b.t - a.t);
        return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
      }
    }
    return null;
  }

  gauss() {
    const u = 1 - this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }
}

/** 可复现的伪随机数 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
