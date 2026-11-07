// 体感游戏的公共工具：头部输入（角度、角速度、手势）、音效和空间音频、画图小工具。
// 每个游戏只管自己的玩法，用这里的东西读头、出声、画画；大厅（ui/arcade.js）负责循环、计分和结算。

// ---------------------------------------------------------------------------
// 头部输入

/**
 * 每帧喂一次头部姿态（相对角度，度：h 向右为正、v 向上为正、r 歪头），得到：
 *   h / v / r   相对“开局时的正前方”的角度（开局、按 C 时重新定）
 *   x / y       归一化到 -1…1 的指向（水平 ±rangeH°、垂直 ±rangeV° 对应屏幕边缘），y 向上为正
 *   vh / vv / vr  角速度（°/s）
 *   ok          有没有数据
 * 手势（on(name, fn) 订阅）。都在“动作的最高点”触发，不用等头回正，也不用回到原位：
 *   tilt  { side, h, v }               歪头过 6°（歪的速度过 25°/s）
 *   nod   { dir, h, v }                低头 / 抬头过 4°（速度过 22°/s）；h、v 是动作开始前头指的角度。
 *                                      上下要快过左右 × nodCross（默认 0.6）：边转头边点头也算，斜着扫一眼不算
 *   shake {}                           左右摇头：1.2 s 内方向翻转两次，每次过 40°/s，来回摆幅过 7°
 *                                      （头的小幅抖动不算；两次摇头至少隔 0.8 s）
 *   flick { dir, speed }               快速甩头：角速度超过 160°/s（每 250 ms 最多一次）
 * 慢慢转头看别处不算手势：中立位会慢慢跟过去，动作必须够快。
 */
export class HeadInput {
  constructor({ rangeH = 22, rangeV = 13, nodCross = 0.6 } = {}) {
    this.rangeH = rangeH;
    this.rangeV = rangeV;
    this.nodCross = nodCross;
    this.handlers = {};
    this.reset();
  }

  on(name, fn) {
    (this.handlers[name] ??= new Set()).add(fn);
    return () => this.handlers[name].delete(fn);
  }

  emit(name, e = {}) {
    for (const fn of this.handlers[name] ?? []) fn(e);
  }

  /** 开局时用：清掉进行中的手势，中立位从现在算起；正前方不动 */
  rearm() {
    this.tiltState = this.nodState = null;
    this.shakeFlips = [];
    this.lastSign = 0;
    this.baseV = this.v;
    this.baseR = this.r;
  }

  /** 把下一帧的朝向当作正前方 */
  reset() {
    this.zero = null;
    this.h = this.v = this.r = 0;
    this.x = this.y = 0;
    this.vh = this.vv = this.vr = 0;
    this.ok = false;
    this.prev = null;
    this.baseV = 0;
    this.baseR = 0;
    this.tiltState = null;
    this.nodState = null;
    this.shakeFlips = [];
    this.shakeAt = 0;
    this.hist = []; // 最近 300 ms 的角速度，判定动作有多快时连越过门槛之前的那一段也算上
    this.lastSign = 0;
    this.ext = 0;
    this.flickAt = 0;
  }

  update(now, pose) {
    if (!pose) {
      this.ok = false;
      return;
    }
    this.ok = true;
    if (!this.zero) this.zero = { h: pose.h, v: pose.v, r: pose.r };
    const h = wrap(pose.h - this.zero.h);
    const v = pose.v - this.zero.v;
    const r = wrap(pose.r - this.zero.r);
    if (this.prev) {
      const dt = Math.max((now - this.prev.t) / 1000, 1 / 240);
      // 角速度：一阶低通，样本之间（30～50 Hz）没新数据时不会忽高忽低
      const a = 1 - Math.exp(-dt / 0.05);
      this.vh += a * ((h - this.prev.h) / dt - this.vh);
      this.vv += a * ((v - this.prev.v) / dt - this.vv);
      this.vr += a * ((r - this.prev.r) / dt - this.vr);
      // 中立位慢慢跟着走（1.5 s），坐姿变了手势还认得
      const b = 1 - Math.exp(-dt / 1.5);
      if (!this.nodState) this.baseV += b * (v - this.baseV);
      if (!this.tiltState) this.baseR += b * (r - this.baseR);
    } else {
      this.baseV = v;
      this.baseR = r;
    }
    this.h = h;
    this.v = v;
    this.r = r;
    this.x = clamp(h / this.rangeH, -1, 1);
    this.y = clamp(v / this.rangeV, -1, 1);
    this.prev = { t: now, h, v, r };
    this.hist.push({ t: now, vv: this.vv, vr: this.vr, h, v });
    while (this.hist[0].t < now - 300) this.hist.shift();
    this.gestures(now);
  }

  /**
   * 单轴上的“一下”：偏离中立位过 enter° 开始跟踪，速度一掉头（到最高点）就判定：
   * 这一路最快的速度过 speed°/s、而且快过另一方向的干扰（cross）就触发 fire(方向)。
   * 触发后要回到 enter 的一半以内才能再触发；一直不回来，1.5 s 后把这里当新的中立位。
   */
  stroke(st, d, vel, now, { key, enter, speed, cross, quiet, fire, rebase }) {
    if (!st) {
      if (Math.abs(d) < enter) return null;
      const dir = Math.sign(d);
      // 动作开始前头指着哪（最近 300 ms 里最早那个样本）：点头确认时用它，不用点到底时的位置
      const h0 = this.hist[0];
      st = { dir, t: now, peak: 0, vmax: Math.max(0, ...this.hist.map((s) => s[key] * dir)), cmax: 0, done: false, h: h0.h, v: h0.v };
    }
    if (st.done) {
      if (Math.abs(d) < enter * 0.5) return null;
      if (now - st.t > 1500) {
        rebase();
        return null;
      }
      return st;
    }
    const along = vel * st.dir;
    st.peak = Math.max(st.peak, d * st.dir);
    st.vmax = Math.max(st.vmax, along);
    st.cmax = Math.max(st.cmax, cross);
    // 到顶了：速度掉到最快时的三成以下，或者已经往回走了 1.5°
    if (along < st.vmax * 0.3 || d * st.dir < st.peak - 1.5) {
      st.done = true;
      if (!quiet && st.vmax >= speed && st.vmax > st.cmax && now - st.t < 700) fire(st.dir, st);
    } else if (now - st.t > 700) st.done = true; // 慢慢偏过去的，不是手势
    return st;
  }

  gestures(now) {
    // 摇头：水平角速度在 1.2 s 内方向翻转两次（右-左-右 或 左-右-左），每次都够快
    const sign = this.vh > 40 ? 1 : this.vh < -40 ? -1 : 0;
    // 这一趟转到的最远处：翻转时记下来，相邻两次的差就是一次来回的摆幅
    if (this.lastSign) this.ext = this.lastSign > 0 ? Math.max(this.ext, this.h) : Math.min(this.ext, this.h);
    if (sign && sign !== this.lastSign) {
      if (this.lastSign) this.shakeFlips.push({ t: now, h: this.ext });
      this.lastSign = sign;
      this.ext = this.h;
    }
    this.shakeFlips = this.shakeFlips.filter((f) => now - f.t < 1200 && now - this.shakeAt > 800); // 刚摇过一次的余波不攒着
    const fl = this.shakeFlips;
    if (fl.length >= 2 && Math.abs(fl.at(-1).h - fl.at(-2).h) >= 7 && now - this.shakeAt > 800) {
      this.shakeFlips = [];
      this.shakeAt = now;
      this.nodState = this.tiltState = null; // 摇头带出来的上下、歪头不算
      this.baseV = this.v;
      this.baseR = this.r;
      this.emit('shake');
    }
    // 摇头途中的上下、歪头不算。只看刚翻转过的 0.3 s：原来只要 1.2 s 里有过一次翻转就不认点头，
    // 快速转头换道再稍微回一点就算一次翻转，紧接着的点头全被吞掉
    const shaking = now - this.shakeAt < 400 || (fl.length > 0 && now - fl.at(-1).t < 300);
    // 点头 / 抬头：上下要快过左右 × nodCross。原来要求上下快过左右，边转头换道边点头（跑酷）就认不出来
    this.nodState = this.stroke(this.nodState, this.v - this.baseV, this.vv, now, {
      key: 'vv', enter: 4, speed: 22, cross: Math.abs(this.vh) * this.nodCross, quiet: shaking,
      fire: (dir, st) => this.emit('nod', { dir: dir < 0 ? 'down' : 'up', h: st.h, v: st.v }),
      rebase: () => { this.baseV = this.v; },
    });
    // 歪头：转头时 roll 也会跟着变一点，要求歪的速度比转头快
    this.tiltState = this.stroke(this.tiltState, this.r - this.baseR, this.vr, now, {
      key: 'vr', enter: 6, speed: 25, cross: Math.abs(this.vh) * 0.6, quiet: shaking,
      fire: (dir, st) => this.emit('tilt', { side: dir < 0 ? 'left' : 'right', h: st.h, v: st.v }),
      rebase: () => { this.baseR = this.r; },
    });
    // 甩头
    const speed = Math.hypot(this.vh, this.vv);
    if (speed > 160 && now - this.flickAt > 250) {
      this.flickAt = now;
      const dir = Math.abs(this.vh) > Math.abs(this.vv) ? (this.vh > 0 ? 'right' : 'left') : this.vv > 0 ? 'up' : 'down';
      this.emit('flick', { dir, speed });
    }
  }
}

// ---------------------------------------------------------------------------
// 声音

/**
 * 音效：几种合成出来的短音（不下载音频文件）。空间音频：HRTF 声源，声音的位置固定在空间里，
 * 转头时由 setListener 把听者转过去——戴 AirPods 时，声音就“钉”在房间的某个方向上。
 */
export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
  }

  /** 第一次用时创建（浏览器要求用户点过页面以后才能出声） */
  get ac() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** 一个短音：freq Hz、dur 秒、type 波形、vol 音量、slide 结束时的频率（滑音） */
  tone(freq, dur = 0.12, { type = 'sine', vol = 0.25, slide = null, when = 0, out = null } = {}) {
    if (this.muted) return;
    const ac = this.ac;
    const t0 = ac.currentTime + when;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out ?? this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /** 一小段噪声（切开、撞墙） */
  noise(dur = 0.15, { vol = 0.3, freq = 1800, q = 0.8, when = 0 } = {}) {
    if (this.muted) return;
    const ac = this.ac;
    const t0 = ac.currentTime + when;
    const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ac.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
  }

  /** 常用的几个：成功、连击（越连越高）、失败、倒计时 */
  good(combo = 0) {
    const base = 660 * Math.pow(2, Math.min(combo, 12) / 12);
    this.tone(base, 0.09, { type: 'triangle', vol: 0.22 });
    this.tone(base * 1.5, 0.14, { type: 'sine', vol: 0.16, when: 0.05 });
  }

  bad() {
    this.tone(220, 0.25, { type: 'sawtooth', vol: 0.12, slide: 110 });
  }

  tick(high = false) {
    this.tone(high ? 1320 : 880, 0.06, { type: 'square', vol: 0.08 });
  }

  /** 空间里的一个声源（HRTF）：x 向右、y 向上、z 向前（米）。返回 { set(x,y,z), node(去接你的声音), stop() } */
  source() {
    const ac = this.ac;
    const p = ac.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 1;
    p.rolloffFactor = 0.6;
    const g = ac.createGain();
    g.connect(p).connect(this.master);
    return {
      node: g,
      set: (x, y, z) => {
        // Web Audio 的坐标：-z 是正前方
        const t = ac.currentTime;
        p.positionX.setTargetAtTime(x, t, 0.02);
        p.positionY.setTargetAtTime(y, t, 0.02);
        p.positionZ.setTargetAtTime(-z, t, 0.02);
      },
      stop: () => {
        g.disconnect();
        p.disconnect();
      },
    };
  }

  /** 听者（你的头）的朝向：yaw 向右为正、pitch 向上为正（度） */
  setListener(yawDeg, pitchDeg) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const y = (yawDeg * Math.PI) / 180;
    const p = (pitchDeg * Math.PI) / 180;
    const fx = Math.sin(y) * Math.cos(p);
    const fy = Math.sin(p);
    const fz = -Math.cos(y) * Math.cos(p);
    const t = this.ctx.currentTime;
    if (L.forwardX) {
      L.forwardX.setTargetAtTime(fx, t, 0.01);
      L.forwardY.setTargetAtTime(fy, t, 0.01);
      L.forwardZ.setTargetAtTime(fz, t, 0.01);
      L.upX.setTargetAtTime(0, t, 0.01);
      L.upY.setTargetAtTime(1, t, 0.01);
      L.upZ.setTargetAtTime(0, t, 0.01);
    } else {
      L.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  close() {
    this.ctx?.close();
    this.ctx = null;
  }
}

// ---------------------------------------------------------------------------
// 画图

/** 和主场景一致的颜色：粉 → 紫 → 青三色霓虹，加系统蓝 */
export const NEON = { pink: '#ff7cba', violet: '#b18cff', cyan: '#66d6ff', blue: '#2f8cff', mint: '#7af0c4', amber: '#ffb347', red: '#ff5470' };

/** 主题：深色 / 浅色下的底色、文字色 */
export function themeColors(dark) {
  return dark
    ? { bg: '#050507', bg2: '#101014', text: '#f5f5f7', text2: 'rgba(235,235,245,0.6)', line: 'rgba(255,255,255,0.1)' }
    : { bg: '#f5f5f7', bg2: '#e6e6eb', text: '#1d1d1f', text2: '#6e6e73', line: 'rgba(0,0,0,0.08)' };
}

export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** 发光：先画一遍带 shadowBlur 的，再画本体 */
export function glow(g, color, blur, draw) {
  g.save();
  g.shadowColor = color;
  g.shadowBlur = blur;
  draw();
  g.restore();
}

export const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOut = (t) => 1 - (1 - clamp(t, 0, 1)) ** 3;
export const rand = (a, b) => a + Math.random() * (b - a);
export const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** 屏幕坐标里头指着的点：x / y 是 HeadInput 的归一化指向 */
export function aimPoint(input, w, h, margin = 0.08) {
  return { x: w / 2 + input.x * w * (0.5 - margin), y: h / 2 - input.y * h * (0.5 - margin) };
}
