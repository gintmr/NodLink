// 边缘仪表：把场景四周的空白做成一个取景框，实时显示头部朝向怎样变成控制。
//
//   四角   取景框的角标
//   底部   水平角刻度带（YAW）：刻度带跟着转头左右滑，中间的指针不动，像飞机的航向带
//   右侧   垂直角刻度带（PITCH）：同上，上下滑
//   左侧   歪头仪表（ROLL）：半圆表盘，指针就是头顶的方向；两侧标出“左键 / 右键”的触发区，
//          歪到触发区并回正就是一次点击，点出去的那一下对应的区域会亮一下
//
// 只用 DOM 和 SVG，刻度在开头画好一次，之后每帧只改 transform 和几个数字，不碰 3D 渲染。
// 不动几秒后变淡，一动就亮起来；没有数据时只留一个很淡的框。
//
// 显示前先平滑：人头不可能完全不动，真耳机静止时半秒内也有 0.2～0.8° 的微小晃动（传感器本身的噪声只有约 0.05°），
// 模拟数据默认每个样本加 0.2° 的噪声。原样显示到 0.1°，数字会一直跳，看着乱。
// 所以仪表用一层 One Euro 滤波（静止时截止频率很低，转头时自动放开），数字再加 0.15° 的滞回：
// 变化不到 0.15° 不改字。只影响显示，光标和手势识别用的还是原始数据。

import { getLang } from './i18n.js';
import { OneEuroFilter } from '../core/filter.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
};
/** 页面的全局样式把 svg 都定成 18px 的图标，这里按属性写回真实尺寸 */
const size = (svg) => Object.assign(svg.style, { width: `${svg.getAttribute('width')}px`, height: `${svg.getAttribute('height')}px` });
const fmt = (d) => (d == null || !Number.isFinite(d) ? '–' : `${d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)}°`);

/** 一条刻度带：range 度、每度 ppd 像素，每 2° 一根短刻度、每 10° 一根长刻度带数字 */
function tape(vertical, range, ppd) {
  const len = range * 2 * ppd;
  const svg = el('svg', vertical ? { width: 44, height: len, viewBox: `0 0 44 ${len}` } : { width: len, height: 30, viewBox: `0 0 ${len} 30` });
  size(svg);
  svg.classList.add('inst-scale');
  for (let d = -range; d <= range; d += 2) {
    const major = d % 10 === 0;
    const p = (d + range) * ppd;
    const n = major ? 9 : 4.5;
    if (vertical) {
      // 垂直角向上为正：上面是正的
      const y = len - p;
      el('line', { x1: 44 - n, x2: 44, y1: y, y2: y, class: major ? 'major' : '' }, svg);
      if (major) el('text', { x: 44 - 14, y: y + 3.5, 'text-anchor': 'end' }, svg).textContent = d === 0 ? '0' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
    } else {
      el('line', { x1: p, x2: p, y1: 30 - n, y2: 30, class: major ? 'major' : '' }, svg);
      if (major) el('text', { x: p, y: 30 - 14, 'text-anchor': 'middle' }, svg).textContent = d === 0 ? '0' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
    }
  }
  return { svg, len };
}

export class Instruments {
  /** gesture：歪头手势的阈值（core/control.js 的 preDeg、enterDeg） */
  constructor(anchor, gesture) {
    this.g = gesture;
    this.root = document.createElement('div');
    this.root.className = 'inst';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.dataset.state = 'none';
    for (const c of ['tl', 'tr', 'bl', 'br']) {
      const corner = document.createElement('i');
      corner.className = `inst-corner ${c}`;
      this.root.append(corner);
    }

    // 底部：水平角
    this.yawRange = 90;
    this.yawPpd = 7;
    this.yaw = this.build('yaw', false, this.yawRange, this.yawPpd, 'YAW');
    // 右侧：垂直角
    this.pitchRange = 60;
    this.pitchPpd = 6;
    this.pitch = this.build('pitch', true, this.pitchRange, this.pitchPpd, 'PITCH');
    this.buildRoll();
    anchor.before(this.root); // 放在顶栏和卡片前面，叠在它们下面

    const smooth = () => new OneEuroFilter({ minCutoff: 0.5, beta: 0.08, dCutoff: 1 });
    this.f = { h: smooth(), v: smooth(), r: smooth() };
    this.val = { yaw: null, pitch: null, roll: null }; // 数字上现在显示的值（滞回用）
    this.anchor = null; // 上次“动了”时的姿态：离开它超过 0.8° 才算又动了
    this.movedAt = -1e9;
    this.fxT = null;
    this.shown = { yaw: '', pitch: '', roll: '', note: '' };
    this.textAt = 0;
  }

  build(name, vertical, range, ppd, label) {
    const box = document.createElement('div');
    box.className = `inst-tape inst-${name}`;
    const win = document.createElement('div');
    win.className = 'inst-window';
    const { svg, len } = tape(vertical, range, ppd);
    win.append(svg);
    const caret = document.createElement('i');
    caret.className = 'inst-caret';
    win.append(caret);
    const read = document.createElement('div');
    read.className = 'inst-read';
    read.innerHTML = `<span class="inst-label">${label}</span><b>–</b>`;
    box.append(win, read);
    this.root.append(box);
    return { box, svg, len, value: read.querySelector('b') };
  }

  /** 歪头阈值改了（更多设置里的“歪头角度”），表盘重画 */
  setGesture({ preDeg, enterDeg, tilt }) {
    if (this.g.preDeg === preDeg && this.g.enterDeg === enterDeg && this.g.tilt === tilt) return;
    this.g = { preDeg, enterDeg, tilt };
    const old = this.roll.box;
    this.buildRoll();
    old.replaceWith(this.roll.box);
    this.shown.roll = '';
    this.val.roll = null;
  }

  buildRoll() {
    const box = document.createElement('div');
    box.className = 'inst-roll';
    const R = 46;
    const K = 3; // 表盘上的角度 = 歪头角度 × 3：触发阈值只有十几度，原样画挤在一起看不清
    this.rollK = K;
    const svg = el('svg', { width: 120, height: 74, viewBox: '-60 -58 120 74' }, box);
    size(svg);
    const polar = (deg, r) => [Math.sin((deg * Math.PI) / 180) * r, -Math.cos((deg * Math.PI) / 180) * r];
    const arc = (a0, a1, r) => {
      const [x0, y0] = polar(a0, r);
      const [x1, y1] = polar(a1, r);
      return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    const enter = Math.min(this.g.enterDeg * K, 80);
    const pre = Math.min(this.g.preDeg * K, enter - 4);
    el('path', { d: arc(-88, 88, R), class: 'ring' }, svg);
    // 触发区：左歪是左键（粉），右歪是右键（青）
    this.zoneL = el('path', { d: arc(-88, -enter, R), class: 'zone left' }, svg);
    this.zoneR = el('path', { d: arc(enter, 88, R), class: 'zone right' }, svg);
    for (const a of [-enter, enter]) {
      const [x0, y0] = polar(a, R - 7);
      const [x1, y1] = polar(a, R + 4);
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'mark' }, svg);
    }
    for (const a of [-pre, 0, pre]) {
      const [x0, y0] = polar(a, R - 4);
      const [x1, y1] = polar(a, R);
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'tick' }, svg);
    }
    this.needle = el('g', { class: 'needle' }, svg);
    el('line', { x1: 0, y1: 0, x2: 0, y2: -(R - 10), class: 'needle-line' }, this.needle);
    el('circle', { cx: 0, cy: -(R - 10), r: 2.6, class: 'needle-tip' }, this.needle);
    el('circle', { cx: 0, cy: 0, r: 3.2, class: 'hub' }, svg);
    const [lx, ly] = polar(-62, R + 12);
    const [rx, ry] = polar(62, R + 12);
    this.labelL = el('text', { x: lx, y: ly, 'text-anchor': 'end', class: 'zone-label left' }, svg);
    this.labelR = el('text', { x: rx, y: ry, 'text-anchor': 'start', class: 'zone-label right' }, svg);
    const read = document.createElement('div');
    read.className = 'inst-read';
    read.innerHTML = '<span class="inst-label">ROLL</span><b>–</b>';
    box.append(read);
    box.classList.toggle('off', this.g.tilt === false); // 关了歪头点击：只当水平仪看，不画触发区
    if (!this.roll) this.root.append(box);
    this.roll = { box, value: read.querySelector('b') };
    this.relabel();
  }

  /** 切换语言后调一次 */
  relabel() {
    const en = getLang() === 'en';
    this.labelL.textContent = en ? 'LEFT' : '左键';
    this.labelR.textContent = en ? 'RIGHT' : '右键';
  }

  /**
   * 每帧调一次。pose：{ h, v, r }（度，相对正前方）；rollBase：歪头中立位；
   * status：control.status() 的结果；fx：最近一次点击 { kind, t }
   */
  update(now, { pose, rollBase, status, fx, hidden }) {
    if (hidden) {
      this.setState('hidden');
      return;
    }
    if (!pose) {
      this.setState('none');
      this.val = { yaw: null, pitch: null, roll: null };
      for (const f of Object.values(this.f)) f.reset();
      this.setText('yaw', '–');
      this.setText('pitch', '–');
      this.setText('roll', '–');
      return;
    }
    const rawR = rollBase == null ? pose.r : ((pose.r - rollBase + 540) % 360) - 180;
    const sec = now / 1000;
    const sm = (key, x) => {
      const f = this.f[key];
      if (f.x != null && Math.abs(x - f.x) > 30) f.reset(); // 拖时间轴跳到别处：不要慢慢滑过去
      return f.filter(x, sec);
    };
    const h = sm('h', pose.h);
    const v = sm('v', pose.v);
    const r = sm('r', rawR);
    if (!this.anchor || Math.abs(h - this.anchor.h) + Math.abs(v - this.anchor.v) + Math.abs(r - this.anchor.r) > 0.8) {
      this.anchor = { h, v, r };
      this.movedAt = now;
    }
    this.setState(now - this.movedAt < 3500 ? 'live' : 'idle');

    // 刻度带：指针不动，刻度往反方向滑
    const clampH = Math.max(-this.yawRange, Math.min(this.yawRange, h));
    const clampV = Math.max(-this.pitchRange, Math.min(this.pitchRange, v));
    this.yaw.svg.style.transform = `translate3d(${(-(clampH + this.yawRange) * this.yawPpd).toFixed(1)}px,0,0)`;
    this.pitch.svg.style.transform = `translate3d(0,${(-(this.pitchRange - clampV) * this.pitchPpd).toFixed(1)}px,0)`;
    const a = Math.max(-86, Math.min(86, r * this.rollK));
    this.needle.setAttribute('transform', `rotate(${a.toFixed(1)})`);

    // 手势：歪到哪边，那边的触发区就亮；点出去的那一下闪一次
    const side = status?.mode === 'gesture' ? status.side : null;
    const enter = Math.abs(rawR) >= this.g.enterDeg ? (rawR < 0 ? 'left' : 'right') : null;
    this.roll.box.dataset.arm = side ?? enter ?? '';
    if (fx && fx.t !== this.fxT && now - fx.t < 600) {
      this.fxT = fx.t;
      const hitSide = fx.kind === 'right' ? 'right' : ['click', 'double', 'down'].includes(fx.kind) ? 'left' : null;
      if (hitSide) {
        const z = hitSide === 'left' ? this.zoneL : this.zoneR;
        z.classList.remove('hit');
        void z.getBoundingClientRect();
        z.classList.add('hit');
      }
    }

    // 数字每秒刷新 15 次就够，少改 DOM
    if (now - this.textAt > 66) {
      this.textAt = now;
      this.setValue('yaw', h);
      this.setValue('pitch', v);
      this.setValue('roll', r);
    }
  }

  /** 数字的滞回：比现在显示的差不到 0.15° 就不改 */
  setValue(which, x) {
    const shown = this.val[which];
    if (shown != null && Math.abs(x - shown) < 0.15) return;
    this.val[which] = x;
    this.setText(which, fmt(Math.abs(x) < 0.05 ? 0 : x));
  }

  setState(s) {
    if (this.root.dataset.state !== s) this.root.dataset.state = s;
  }

  setText(which, text) {
    if (this.shown[which] === text) return;
    this.shown[which] = text;
    this[which].value.textContent = text;
  }
}
