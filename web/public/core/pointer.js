// 运行时光标：绝对模式和相对模式。输入为映射后的绝对角度（度）。

import { wrapDeg } from './angles.js';
import { predict } from './calibration.js';
import { OneEuroFilter } from './filter.js';

/**
 * 绝对模式：模型预测 → One Euro 滤波 → 叠加偏移（重新居中、漂移校正）→ 精细模式（可选）。
 *
 * 精细模式：头的轻微晃动（看东西、说话时每秒几度）按原比例会让光标晃几十像素。
 * 所以按头部转速调倍率：慢于 slowDps 时光标只走 slowGain 倍，快于 fastDps 时按原比例；
 * 转得快时再把光标往“头真正指的位置”拉，免得慢动作攒下的差越来越大；差最多 maxOff。
 * 慢动作时不拉，细调才不会被拽走。这和鼠标的加速曲线是同一个思路。
 */
export class AbsolutePointer {
  constructor(calibration, kind = 'affine', filterOptions = {}, gain = 1) {
    this.ref = calibration.ref;
    this.model = calibration.models[kind];
    this.center = predict(this.model, 0, 0); // 正前方对应的屏幕位置
    this.gain = gain;
    this.fx = new OneEuroFilter(filterOptions);
    this.fy = new OneEuroFilter(filterOptions);
    this.offset = { x: 0, y: 0 };
    this.raw = null;
    this.base = null;
    this.precision = null; // { slowGain, slowDps, fastDps, pull }
    this.out = null;
    this.speed = 0;
  }

  /** 打开 / 关闭精细模式；options 为 null 时关闭 */
  setPrecision(options) {
    this.precision = options && { slowGain: 0.25, slowDps: 3, fastDps: 35, pull: 4, maxOff: 80, ...options };
    this.out = null;
  }

  setFilter({ minCutoff, beta }) {
    for (const f of [this.fx, this.fy]) Object.assign(f, { minCutoff, beta });
  }

  /** 灵敏度：以正前方为中心缩放光标位移。小于 1 时要转更大的角度才能移动同样距离，更容易控制 */
  setGain(gain) {
    this.gain = gain;
  }

  update(h, v, tSec) {
    const p = predict(this.model, wrapDeg(h - this.ref.h), wrapDeg(v - this.ref.v));
    const c = this.center;
    this.raw = { x: c.x + this.gain * (p.x - c.x), y: c.y + this.gain * (p.y - c.y) };
    this.base = { x: this.fx.filter(this.raw.x, tSec), y: this.fy.filter(this.raw.y, tSec) };
    if (this.precision) this.refine(h, v, tSec);
    return this.position;
  }

  /** 头真正指的位置（不经过精细模式） */
  get absolute() {
    return this.base && { x: this.base.x + this.offset.x, y: this.base.y + this.offset.y };
  }

  refine(h, v, tSec) {
    const pr = this.precision;
    const abs = this.absolute;
    if (this.lastHV) {
      const dt = Math.min(Math.max(tSec - this.lastHV.t, 0.001), 0.1);
      const inst = Math.hypot(wrapDeg(h - this.lastHV.h), v - this.lastHV.v) / dt;
      this.speed += (inst - this.speed) * Math.min(dt / 0.08, 1);
      let f = Math.min(Math.max((this.speed - pr.slowDps) / (pr.fastDps - pr.slowDps), 0), 1);
      f = f * f * (3 - 2 * f);
      if (this.out && this.lastAbs) {
        const k = pr.slowGain + (1 - pr.slowGain) * f;
        this.out.x += k * (abs.x - this.lastAbs.x);
        this.out.y += k * (abs.y - this.lastAbs.y);
        const w = Math.min(f * pr.pull * dt, 1);
        this.out.x += (abs.x - this.out.x) * w;
        this.out.y += (abs.y - this.out.y) * w;
        // 差得再多也不超过 maxOff：超出的部分直接跟上，光标不会离头指的地方太远
        const ex = this.out.x - abs.x;
        const ey = this.out.y - abs.y;
        const e = Math.hypot(ex, ey);
        if (e > pr.maxOff) {
          this.out.x = abs.x + (ex * pr.maxOff) / e;
          this.out.y = abs.y + (ey * pr.maxOff) / e;
        }
      }
    }
    this.out ??= { ...abs };
    this.lastAbs = abs;
    this.lastHV = { h, v, t: tSec };
  }

  get position() {
    if (this.held) return { ...this.held };
    return this.precision && this.out ? { ...this.out } : this.absolute;
  }

  /** 停住：歪头点击、键鼠让位时光标原地不动（或停在 at），滤波照常跑。恢复时从停住的位置接着走 */
  setHold(on, at) {
    if (!on && this.held && this.out) this.out = { ...this.held };
    this.held = on ? (at ? { ...at } : this.position) : null;
  }

  /**
   * 认为用户此刻正指着 target，按 gain 比例把光标拉过去。
   * gain = 1 就是重新居中；点击时用较小的 gain 悄悄修正漂移。
   */
  correct(target, gain = 1) {
    const p = this.position;
    if (!p) return;
    const dx = gain * (target.x - p.x);
    const dy = gain * (target.y - p.y);
    this.offset.x += dx;
    this.offset.y += dy;
    if (this.out) {
      this.out.x += dx;
      this.out.y += dy;
      this.lastAbs = this.absolute;
    }
  }
}

/** 相对模式：类似摇杆，头偏离中立位越多光标移动越快。暂停（离合）后恢复时重新取中立位 */
export class RelativePointer {
  constructor(options) {
    this.set(options);
    this.pos = null;
    this.neutral = null;
    this.paused = false;
  }

  set({ deadzoneDeg = 1.5, gain = 60, expo = 1.5 } = {}) {
    Object.assign(this, { deadzoneDeg, gain, expo });
  }

  /** bounds: { w, h }，光标限制在舞台内 */
  update(h, v, tSec, bounds) {
    this.pos ??= { x: bounds.w / 2, y: bounds.h / 2 };
    if (this.hold) {
      this.t = tSec;
      return this.position;
    }
    if (this.paused || !this.neutral) {
      if (!this.paused) this.neutral = { h, v };
      this.t = tSec;
      return this.position;
    }
    const dt = Math.min(Math.max(tSec - this.t, 0), 0.1);
    this.t = tSec;
    const speed = (d) => {
      const a = Math.abs(d) - this.deadzoneDeg;
      return a <= 0 ? 0 : Math.sign(d) * this.gain * a ** this.expo;
    };
    // 水平角向右为正、垂直角向上为正；屏幕 y 向下为正
    this.pos.x += speed(wrapDeg(h - this.neutral.h)) * dt;
    this.pos.y -= speed(wrapDeg(v - this.neutral.v)) * dt;
    this.pos.x = Math.min(Math.max(this.pos.x, 0), bounds.w);
    this.pos.y = Math.min(Math.max(this.pos.y, 0), bounds.h);
    return this.position;
  }

  setPaused(paused) {
    this.paused = paused;
    if (!paused) this.neutral = null;
  }

  setHold(on, at) {
    this.hold = on;
    if (on && at && this.pos) this.pos = { ...at };
  }

  recenter(bounds) {
    this.pos = { x: bounds.w / 2, y: bounds.h / 2 };
    this.neutral = null;
  }

  get position() {
    return this.pos && { x: this.pos.x, y: this.pos.y };
  }
}

/**
 * 增量模式：像普通鼠标一样，头部转动多少，光标就从当前位置移动多少。
 * 头部角度先换算成“虚拟屏幕坐标”（G·tan），滤波后取相邻两帧的差作为位移，再乘以灵敏度。
 * 跨显示器、碰到屏幕边缘的处理交给系统，和真实鼠标一样。
 */
export class DeltaPointer {
  constructor({ G = 3000, gain = 1, filter = {} } = {}) {
    this.G = G;
    this.gain = gain;
    this.fx = new OneEuroFilter(filter);
    this.fy = new OneEuroFilter(filter);
    this.prev = null;
    this.pos = null;
    this.delta = { x: 0, y: 0 };
    this.paused = false;
  }

  setGain(gain) {
    this.gain = gain;
  }

  setFilter({ minCutoff, beta }) {
    for (const f of [this.fx, this.fy]) Object.assign(f, { minCutoff, beta });
  }

  /** bounds: { w, h }，网页里显示的光标限制在这个范围内 */
  update(h, v, tSec, bounds) {
    this.pos ??= { x: bounds.w / 2, y: bounds.h / 2 };
    const x = this.fx.filter(this.G * Math.tan(h * (Math.PI / 180)), tSec);
    const y = this.fy.filter(-this.G * Math.tan(v * (Math.PI / 180)), tSec);
    // 停住（歪头、说话）期间不更新 prev：恢复后从停住前的头部位置接着算，
    // 歪头时顺带的转动在回正时抵消，不会每歪一次就把光标带偏一点
    if (this.hold) {
      this.delta = { x: 0, y: 0 };
      return this.position;
    }
    if (this.prev && !this.paused) {
      this.delta = { x: (x - this.prev.x) * this.gain, y: (y - this.prev.y) * this.gain };
      this.pos.x = Math.min(Math.max(this.pos.x + this.delta.x, 0), bounds.w);
      this.pos.y = Math.min(Math.max(this.pos.y + this.delta.y, 0), bounds.h);
    } else {
      this.delta = { x: 0, y: 0 };
    }
    this.prev = { x, y };
    return this.position;
  }

  setPaused(paused) {
    this.paused = paused;
  }

  setHold(on, at) {
    this.hold = on;
    if (on && at && this.pos) this.pos = { ...at };
  }

  recenter(bounds, at) {
    this.pos = at ? { ...at } : { x: bounds.w / 2, y: bounds.h / 2 };
  }

  get position() {
    return this.pos && { x: this.pos.x, y: this.pos.y };
  }
}
