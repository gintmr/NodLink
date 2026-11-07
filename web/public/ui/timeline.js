// 时间轴：界面上唯一常驻的部分，收在顶栏中间。上面画头部活动的起伏，标着发生过的事件；
// 拖动它，场景和探针一起回到那一刻；双击或点“实时”回到现在。
//
// 事件按种类画成不同的标记，像一台飞行记录仪：
//   单击 粉色圆点 · 双击 两颗圆点 · 右键 青色圆点 · 拖拽 从按下到松开的一段粉色横条
//   滚动和缩放 小三角 · 按键和窗口 小方块 · 被拦下的误触 灰色叉
//   语音发起的操作外面多一圈紫色细环；连接、校准这类系统事件还是按级别着色的小圆点

import { t } from './i18n.js';

const WINDOW_MS = 3 * 60_000; // 显示最近 3 分钟

export class Timeline {
  /** onScrub(t | null)：拖到某一时刻，null 表示回到实时 */
  constructor(canvas, { onScrub, onHover }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onScrub = onScrub;
    this.onHover = onHover;
    this.activity = []; // { t, a }：每 100 ms 一个点，a 是这段时间的头部角速度（°/s）
    this.events = [];   // { t, label, level, kind, voice, end }
    this.playhead = null;
    this.hoverEvent = null;
    this.last = null;
    this.bucket = null;

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return this.timeAt(e.clientX - r.left);
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.scrub(pos(e));
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) this.scrub(pos(e));
      const r = canvas.getBoundingClientRect();
      this.hoverEvent = this.eventNear(e.clientX - r.left);
      this.onHover?.(this.hoverEvent, e.clientX);
    });
    canvas.addEventListener('pointerup', () => { this.dragging = false; });
    canvas.addEventListener('pointerleave', () => {
      this.hoverEvent = null;
      this.onHover?.(null);
    });
    canvas.addEventListener('dblclick', () => this.scrub(null));
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 每个样本调用一次：h / v 为相对角度（度） */
  push(t, h, v) {
    if (this.last) {
      const dt = (t - this.last.t) / 1000;
      if (dt > 0) {
        const speed = Math.hypot(h - this.last.h, v - this.last.v) / dt;
        if (!this.bucket || t - this.bucket.t >= 100) {
          if (this.bucket) this.activity.push({ t: this.bucket.t, a: this.bucket.sum / this.bucket.n });
          this.bucket = { t, sum: 0, n: 0 };
        }
        this.bucket.sum += Math.min(speed, 200);
        this.bucket.n += 1;
      }
    }
    this.last = { t, h, v };
    const cutoff = t - WINDOW_MS - 1000;
    while (this.activity.length && this.activity[0].t < cutoff) this.activity.shift();
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
  }

  /**
   * level：'info' | 'good' | 'warn' | 'bad'；
   * kind：'click' | 'double' | 'right' | 'down' | 'up' | 'scrollUp' | 'scrollDown' | 'key' | 'reject' | undefined（系统事件）；
   * voice：这一下是语音指令发起的
   */
  event(t, label, level = 'info', kind = null, voice = false) {
    if (kind === 'up') {
      // 松开：把最近一次还没结束的按下补成一段拖拽
      const down = [...this.events].reverse().find((e) => e.kind === 'down' && e.end == null);
      if (down) down.end = t;
    }
    this.events.push({ t, label, level, kind, voice });
  }

  scrub(t) {
    const now = performance.now();
    this.playhead = t == null || t > now - 150 ? null : t;
    this.onScrub(this.playhead);
  }

  timeAt(x) {
    const now = performance.now();
    return now - WINDOW_MS + (x / this.w) * WINDOW_MS;
  }

  xAt(t) {
    return ((t - (performance.now() - WINDOW_MS)) / WINDOW_MS) * this.w;
  }

  eventNear(x) {
    let best = null;
    for (const e of this.events) {
      const d = Math.abs(this.xAt(e.t) - x);
      if (d < 8 && (!best || d < best.d)) best = { ...e, d };
    }
    return best;
  }

  draw(colors) {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const base = h - 12;

    // 头部活动的起伏：动得越多越高
    const top = Math.max(30, ...this.activity.map((p) => p.a));
    ctx.beginPath();
    if (this.activity.length) ctx.moveTo(this.xAt(this.activity[0].t), base);
    for (const p of this.activity) ctx.lineTo(this.xAt(p.t), base - (p.a / top) * (base - 8));
    if (this.activity.length) ctx.lineTo(this.xAt(this.activity.at(-1).t), base);
    ctx.closePath();
    ctx.fillStyle = colors.wave;
    ctx.fill();
    ctx.strokeStyle = colors.waveLine;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this.activity.forEach((p, i) => (i ? ctx.lineTo(this.xAt(p.t), base - (p.a / top) * (base - 8)) : ctx.moveTo(this.xAt(p.t), base - (p.a / top) * (base - 8))));
    ctx.stroke();

    // 刻度：每 30 秒一格
    ctx.fillStyle = colors.tick;
    ctx.font = '9px "Sora Variable", -apple-system, sans-serif';
    for (let s = 0; s <= WINDOW_MS / 1000; s += 30) {
      const x = w - (s / (WINDOW_MS / 1000)) * w;
      ctx.fillRect(Math.round(x), base, 1, 4);
      if (s && s % 60 === 0) ctx.fillText(t('−{n} 分', { n: s / 60 }), x + 3, h - 2);
    }

    // 事件：按种类画标记，竖着一根很淡的细线落到起伏上
    const now = performance.now();
    const y = 9;
    for (const e of this.events) {
      const x = this.xAt(e.t);
      const hot = this.hoverEvent && this.hoverEvent.t === e.t;
      const k = hot ? 1.4 : 1;
      const color = { click: colors.click, double: colors.click, down: colors.click, right: colors.right, scrollUp: colors.scroll, scrollDown: colors.scroll, key: colors.key, reject: colors.tick }[e.kind] ?? colors[e.level] ?? colors.info;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (e.kind !== 'up') {
        ctx.globalAlpha = 0.28;
        ctx.fillRect(x - 0.5, y, 1, base - y);
        ctx.globalAlpha = 1;
      }
      switch (e.kind) {
        case 'down': {
          // 拖拽：按下到松开（还没松开就画到现在）
          const x2 = this.xAt(e.end ?? now);
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x, y - 2, Math.max(x2 - x, 2), 4);
          ctx.globalAlpha = 1;
          dot(ctx, x, y, 3 * k);
          break;
        }
        case 'up':
          dot(ctx, x, y, 2.2 * k);
          break;
        case 'double':
          dot(ctx, x - 2.5, y, 2.4 * k);
          dot(ctx, x + 2.5, y, 2.4 * k);
          break;
        case 'scrollUp':
        case 'scrollDown': {
          const up = e.kind === 'scrollUp';
          ctx.beginPath();
          ctx.moveTo(x, y + (up ? -3.5 : 3.5) * k);
          ctx.lineTo(x - 3.2 * k, y + (up ? 2.5 : -2.5) * k);
          ctx.lineTo(x + 3.2 * k, y + (up ? 2.5 : -2.5) * k);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'key':
          ctx.fillRect(x - 2.6 * k, y - 2.6 * k, 5.2 * k, 5.2 * k);
          break;
        case 'reject':
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x - 2.5, y - 2.5);
          ctx.lineTo(x + 2.5, y + 2.5);
          ctx.moveTo(x + 2.5, y - 2.5);
          ctx.lineTo(x - 2.5, y + 2.5);
          ctx.stroke();
          break;
        default:
          dot(ctx, x, y, (e.kind ? 3.2 : 2.6) * k);
      }
      if (e.voice) {
        ctx.strokeStyle = colors.voice;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, 6 * k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 播放头：一根细线，底部一个圆形手柄
    if (this.playhead != null) {
      const x = Math.round(Math.min(Math.max(this.xAt(this.playhead), 7), w - 7));
      ctx.fillStyle = colors.head;
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.beginPath();
      ctx.arc(x, base, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.knob;
      ctx.beginPath();
      ctx.arc(x, base, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
