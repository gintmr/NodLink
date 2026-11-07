// 第一人称视角：一张 2D 伪 3D 的像素插画。使用者正对着显示器，屏幕占画面约四分之三，
// 周围露出一个打开的 AirPods 充电盒、耳机的一角、一截键盘、鼠标和手机。整张画用同一套高饱和的调色板，逐像素画出来。
// 风格和第三人称、封面一致：苹果式的中性配色。墙是浅灰（深色模式近黑），桌子、键盘、鼠标、耳机是中性石墨和枪灰金属，
// 发光的地方用拱门那条白 → 浅蓝 → 系统蓝的灯带（GLOW）；屏幕里的内容（壁纸、窗口、程序坞）保持原来的彩色。
//
// 一个画面像素是 1.5 个 CSS 像素（Retina 屏上是 3 个物理像素），用 CSS 的 pixelated 放大，块小、细节多。
// 所有物件按比例系数 S 缩放（S = 1 时主屏宽 320 像素），轮廓、高光、抖动这些细节始终是 1 像素。
// 显示器按耳机桥报告的真实排布画：几块、并排还是上下叠、横屏还是竖屏，都跟着布局变。
// 墙、桌子、显示器、前景各画一层，换主题、改窗口大小或显示器布局时重画；
// 每帧只把这几层拼起来，再在屏幕上画星星、光标和目标，所以很省。
// 整张画是固定的，不随头部转动移动：模拟数据时头跟着鼠标转，画面一动就会晃。

import { drawPixelText, pixelTextWidth, screenTitle } from './pixel-font.js';
import { demoClock } from './demo-clock.js';

const CSS_PER_PIXEL = 1.5;

const PAL = {
  ink: '#1c1c1f',
  ink2: '#2c2c31',
  ink3: '#3a3a40',
  violet: '#6a4bd1',
  lilac: '#b9a6ff',
  pink: '#ff5fb4',
  rose: '#ff9fcb',
  peach: '#ffb36b',
  yellow: '#ffe066',
  cyan: '#4fe3ff',
  mint: '#5dffc0',
  white: '#fff8ff',
  alu: '#e8e8ec',
  alu2: '#bcbcc4',
  alu3: '#8e8e96',
};

/** 环境里发光的地方：白 → 浅蓝 → 系统蓝 */
const GLOW = { a: '#ffffff', m: '#b9d4ff', b: '#3d8bff', b2: '#2f74d8' };

const THEME = {
  day: { wall: ['#dcdce2', '#e1e1e6', '#e6e6ea', '#eaeaee', '#eeeef1', '#f1f1f4', '#f5f5f7'], desk: '#2c2c31', desk2: '#323237', deskEdge: '#1c1c1f', glowA: 0.45 },
  night: { wall: ['#050506', '#08080a', '#0b0b0d', '#0e0e11', '#111114', '#141417', '#17171b'], desk: '#1c1c1f', desk2: '#212125', deskEdge: '#111113', glowA: 0.9 },
};


const R = Math.round;

const text = drawPixelText;

function rng(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function layer(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, R(w));
  c.height = Math.max(1, R(h));
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}

/** 像素圆：实心 */
function disc(g, cx, cy, r, color) {
  g.fillStyle = color;
  r = R(r);
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y));
    g.fillRect(R(cx - w), R(cy + y), w * 2 + 1, 1);
  }
}

/** 像素圆环 */
function ring(g, cx, cy, r, color) {
  g.fillStyle = color;
  const n = Math.max(24, R(r * 8));
  for (let a = 0; a < n; a++) {
    const t = (a / n) * Math.PI * 2;
    g.fillRect(R(cx + Math.cos(t) * r), R(cy + Math.sin(t) * r), 1, 1);
  }
}

/** 台阶状圆角矩形（像素风的圆角） */
function block(g, x, y, w, h, r, color) {
  g.fillStyle = color;
  x = R(x);
  y = R(y);
  w = R(w);
  h = R(h);
  for (let i = 0; i < h; i++) {
    const edge = Math.min(i, h - 1 - i);
    const inset = edge < r ? R(r - Math.sqrt(r * r - (r - edge - 0.5) ** 2)) : 0;
    g.fillRect(x + inset, y + i, w - inset * 2, 1);
  }
}

/**
 * 带分层明暗的圆润形状（超椭圆）：光从左上来，按亮度分成几档色阶，边缘一圈描边。
 * 鼠标、充电盒、耳机这类白色塑料件都用它画，比纯色块立体得多
 */
function shaded(g, cx, cy, rw, rh, { n = 2.4, levels, outline, top = 0 } = {}) {
  const x0 = Math.floor(cx - rw);
  const y0 = Math.floor(cy - rh);
  for (let y = y0; y <= cy + rh; y++) {
    const v = (y + 0.5 - cy) / rh;
    if (top && v < -top) continue;
    for (let x = x0; x <= cx + rw; x++) {
      const u = (x + 0.5 - cx) / rw;
      const r = Math.abs(u) ** n + Math.abs(v) ** n;
      if (r > 1) continue;
      let color;
      if (outline && r > 0.86) color = outline;
      else {
        const f = 0.5 + 0.42 * (u * 0.55 + v * 0.75) + 0.3 * r ** 3;
        color = levels[Math.min(levels.length - 1, Math.max(0, Math.floor(f * levels.length)))];
      }
      g.fillStyle = color;
      g.fillRect(x, y, 1, 1);
    }
  }
}

const WHITE_LEVELS = ['#ffffff', '#fafafa', '#f0f0f2', '#e4e4e8', '#d4d4da', '#c2c2c8'];
const GRAPHITE_LEVELS = ['#4a4a50', '#3c3c42', '#323237', '#29292e', '#212125', '#1a1a1d'];
const GUNMETAL = { hi: '#8a8c94', face: '#5a5c63', side: '#3d3e44' };

/** 两色之间的棋盘格抖动，像素画里的过渡 */
function dither(g, x, y, w, h, color, step = 2) {
  g.fillStyle = color;
  for (let yy = 0; yy < h; yy++) for (let xx = (yy % 2); xx < w; xx += step) g.fillRect(R(x) + xx, R(y) + yy, 1, 1);
}

function lerpColor(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => [(s >> 16) & 255, (s >> 8) & 255, s & 255];
  const [r1, g1, b1] = ch(pa);
  const [r2, g2, b2] = ch(pb);
  return `rgb(${R(r1 + (r2 - r1) * t)}, ${R(g1 + (g2 - g1) * t)}, ${R(b1 + (b2 - b1) * t)})`;
}

/** 粉 → 紫 → 青 */
function neonAt(t) {
  // 拱门光条保留粉 → 紫 → 青：其余都是中性色，只留这一点赛博朋克的颜色
  return t < 0.5 ? lerpColor(PAL.pink, PAL.lilac, t * 2) : lerpColor(PAL.lilac, PAL.cyan, (t - 0.5) * 2);
}

/** 屏幕上的像素桌面：分层的黄昏天空、云、城市剪影；主屏上有时钟窗口和正在播放，所有屏底部一排程序坞 */
function drawWallpaper(g, w, h, screen, clock, seed) {
  const main = screen.main;
  const S = Math.max(0.6, Math.min(w, h * 1.6) / 320);
  const z = (n) => Math.max(1, R(n * S));
  const rnd = rng(seed);
  const bands = ['#251a52', '#2e2066', '#3a2a7a', '#4a338c', '#5c3c9e', '#7447a8', '#8f52b0', '#ab5dad', '#c868a8', '#dc78a7', '#f08aa6', '#ffa0a0', '#ffb39a'];
  const bh = Math.ceil((h * 0.66) / bands.length);
  g.fillStyle = bands.at(-1);
  g.fillRect(0, 0, w, h);
  bands.forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(0, i * bh, w, bh);
    if (i) dither(g, 0, i * bh, w, 2, bands[i - 1]);
  });
  // 星星：大部分 1 像素，几颗带十字光芒
  for (let i = 0; i < 70 * S; i++) {
    const x = Math.floor(rnd() * w);
    const y = Math.floor(rnd() * h * 0.35) + z(9);
    g.fillStyle = rnd() < 0.3 ? '#ffd9f0' : PAL.white;
    g.fillRect(x, y, 1, 1);
    if (rnd() < 0.08) {
      g.fillRect(x - 1, y, 3, 1);
      g.fillRect(x, y - 1, 1, 3);
    }
  }
  // 云：几条带抖动边缘的长条
  for (let i = 0; i < 4; i++) {
    const cy = R(h * (0.3 + rnd() * 0.18));
    const cx = R(rnd() * w);
    const cw = R(w * (0.18 + rnd() * 0.2));
    g.fillStyle = 'rgba(255, 190, 220, 0.35)';
    g.fillRect(cx, cy, cw, z(3));
    dither(g, cx + z(4), cy - 1, cw - z(8), 1, 'rgba(255, 210, 230, 0.5)');
    dither(g, cx - z(3), cy + z(3), cw + z(6), 1, 'rgba(255, 190, 220, 0.3)');
  }
  // 月亮和环形山
  const mx = R(w * 0.78);
  const my = R(h * 0.2);
  const mr = z(10);
  disc(g, mx, my, mr + 2, 'rgba(255, 241, 201, 0.25)');
  disc(g, mx, my, mr, '#fff1c9');
  disc(g, mx + R(mr * 0.3), my - R(mr * 0.25), R(mr * 0.22), '#f4d9a8');
  disc(g, mx - R(mr * 0.35), my + R(mr * 0.3), R(mr * 0.16), '#f4d9a8');
  g.fillStyle = '#fffbe8';
  g.fillRect(mx - R(mr * 0.5), my - R(mr * 0.55), z(2), 1);
  // 城市：四层楼，越近越暗；窗户是 1 像素宽的暖黄色，偶尔一盏粉色或青色的招牌
  [['#5a3f96', 0.5, 0.1], ['#4a347f', 0.57, 0.11], ['#2f2260', 0.65, 0.1], ['#1b1440', 0.74, 0.07]].forEach(([col, base, hMax], li) => {
    let x = -2;
    while (x < w) {
      const bw = z(7) + Math.floor(rnd() * z(13));
      const top = R(h * base - rnd() * h * hMax);
      g.fillStyle = col;
      g.fillRect(x, top, bw, h - top);
      g.fillStyle = 'rgba(255, 255, 255, 0.08)';
      g.fillRect(x, top, 1, h - top);
      if (rnd() < 0.3) {
        g.fillStyle = col;
        g.fillRect(x + R(bw / 2), top - z(4), 1, z(4));
      }
      if (li > 0) {
        for (let yy = top + 3; yy < h - z(30); yy += 3) {
          for (let xx = x + 2; xx < x + bw - 2; xx += 2) {
            if (rnd() < 0.22) {
              g.fillStyle = rnd() < 0.85 ? '#ffd98a' : '#fff3c4';
              g.fillRect(xx, yy, 1, 1);
            }
          }
        }
        if (li === 2 && rnd() < 0.18) {
          g.fillStyle = rnd() < 0.5 ? PAL.pink : PAL.cyan;
          g.fillRect(x + 2, top + z(6), Math.max(2, bw - 4), z(2));
        }
      }
      x += bw + 1;
    }
  });
  const win = (x, y, ww, hh, bar) => {
    g.fillStyle = 'rgba(20, 10, 50, 0.35)';
    g.fillRect(x + 2, y + 2, ww, hh);
    g.fillStyle = PAL.ink;
    g.fillRect(x - 1, y - 1, ww + 2, hh + 2);
    g.fillStyle = 'rgba(255, 250, 255, 0.96)';
    g.fillRect(x, y, ww, hh);
    g.fillStyle = bar;
    g.fillRect(x, y, ww, z(7));
    g.fillStyle = 'rgba(255, 255, 255, 0.5)';
    g.fillRect(x, y, ww, 1);
    g.fillStyle = PAL.white;
    for (let i = 0; i < 3; i++) g.fillRect(x + ww - z(6) - i * z(5), y + z(2), z(3), z(3));
  };
  if (main) {
    const x0 = z(16);
    const y0 = z(20);
    win(x0, y0, z(104), z(54), PAL.lilac);
    text(g, clock, x0 + z(8), y0 + z(14), z(3), PAL.ink);
    text(g, 'NODLINK', x0 + z(8), y0 + z(43), Math.max(1, R(S)), PAL.violet);
    const px = w - z(122);
    const py = R(h * 0.4);
    win(px, py, z(106), z(42), PAL.rose);
    const art = (x, y, s) => {
      for (let i = 0; i < s; i++) {
        g.fillStyle = lerpColor(PAL.pink, PAL.violet, i / s);
        g.fillRect(x, y + i, s, 1);
      }
      disc(g, x + R(s * 0.5), y + R(s * 0.5), R(s * 0.2), '#ffe6f4');
    };
    art(px + z(7), py + z(12), z(22));
    g.fillStyle = PAL.ink2;
    g.fillRect(px + z(36), py + z(14), z(52), z(3));
    g.fillStyle = '#9b93b8';
    g.fillRect(px + z(36), py + z(21), z(36), z(2));
    g.fillStyle = '#d9d2f2';
    g.fillRect(px + z(36), py + z(29), z(62), z(2));
    g.fillStyle = PAL.pink;
    g.fillRect(px + z(36), py + z(29), z(34), z(2));
    disc(g, px + z(36) + z(34), py + z(30), z(2), PAL.white);
  }
  // 标题栏：编号牌 + 显示器名，主显示器右侧标 MAIN，方便和真实显示器对上号
  const bar = z(8);
  const ts = Math.max(1, R(S * 0.8));
  const ty = R((bar - 7 * ts) / 2);
  g.fillStyle = 'rgba(255, 255, 255, 0.35)';
  g.fillRect(0, 0, w, bar);
  const tag = main ? 'MAIN' : '';
  const room = Math.floor((w - z(44) - (tag ? pixelTextWidth(tag, ts) + z(6) : 0)) / (6 * ts));
  const title = screenTitle(screen, room);
  const bw = pixelTextWidth(title.no, ts) + z(4);
  g.fillStyle = main ? PAL.pink : PAL.violet;
  g.fillRect(z(3), 1, bw, bar - 2);
  text(g, title.no, z(3) + z(2), ty, ts, PAL.white);
  if (title.name) text(g, title.name, z(3) + bw + z(3), ty, ts, PAL.white);
  if (tag) text(g, tag, w - z(36) - pixelTextWidth(tag, ts), ty, ts, PAL.yellow);
  g.fillStyle = PAL.white;
  g.fillRect(w - z(30), z(3), z(16), z(2));
  g.fillRect(w - z(10), z(2), z(5), z(4));
  const icons = [PAL.rose, PAL.lilac, PAL.mint, PAL.yellow, PAL.cyan, PAL.white, PAL.peach];
  const is = z(14);
  const gap = z(4);
  const dw = icons.length * (is + gap) + gap;
  if (dw < w - 8) {
    const dx = Math.floor((w - dw) / 2);
    const dy = h - is - z(10);
    g.fillStyle = 'rgba(255, 255, 255, 0.4)';
    g.fillRect(dx, dy - gap, dw, is + gap * 2);
    g.fillStyle = 'rgba(255, 255, 255, 0.6)';
    g.fillRect(dx, dy - gap, dw, 1);
    icons.forEach((col, i) => {
      const x = dx + gap + i * (is + gap);
      block(g, x - 1, dy - 1, is + 2, is + 2, z(3), PAL.ink2);
      block(g, x, dy, is, is, z(3), col);
      g.fillStyle = 'rgba(255, 255, 255, 0.55)';
      g.fillRect(x + 2, dy + 1, is - 4, 1);
      g.fillStyle = 'rgba(20, 20, 30, 0.45)';
      g.fillRect(x + R(is * 0.3), dy + R(is * 0.3), R(is * 0.4), R(is * 0.4));
    });
  }
}

export class PixelDesk {
  constructor(container, scene) {
    this.scene = scene;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pixel-desk';
    this.g = this.canvas.getContext('2d');
    container.append(this.canvas);
    this.visible = false;
    this.night = false;
    this.layout = null;
    this.safeTop = 0;
    this.trail = [];
    this.lastSampleT = null;
    this.clock = '';
    this.canvas.addEventListener('pointermove', (e) => { this.scene.pointerPx = this.toScreenPx(e.clientX, e.clientY, true); });
    this.canvas.addEventListener('pointerleave', () => { this.scene.pointerPx = null; });
  }

  show(on) {
    this.visible = on;
    this.canvas.style.display = on ? '' : 'none';
    if (on) this.build();
  }

  setTheme(night) {
    this.night = night;
    if (this.visible) this.build();
  }

  setLayout(layout) {
    this.layout = layout;
    if (this.visible) this.build();
  }

  setSafeTop(px) {
    this.safeTop = px;
    if (this.visible) this.build();
  }

  // ---------- 静态的几层 ----------

  build() {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch || !this.layout?.screens.length) return;
    this.cssW = cw;
    this.cssH = ch;
    const W = R(cw / CSS_PER_PIXEL);
    const H = R(ch / CSS_PER_PIXEL);
    this.W = W;
    this.H = H;
    this.canvas.width = W;
    this.canvas.height = H;
    this.g.imageSmoothingEnabled = false;

    // 显示器排布：所有屏幕的外接矩形宽度占画面约 76%（竖屏 90%），高度不超过顶栏以下的 66%
    const screens = this.layout.screens;
    const minX = Math.min(...screens.map((s) => s.x));
    const maxX = Math.max(...screens.map((s) => s.x + s.w));
    const minY = Math.min(...screens.map((s) => s.y));
    const maxY = Math.max(...screens.map((s) => s.y + s.h));
    const main = screens.find((s) => s.main) ?? screens[0];
    const top = this.safeTop / CSS_PER_PIXEL;
    const k = Math.min((W * (cw > ch ? 0.76 : 0.9)) / (maxX - minX), ((H - top) * 0.66) / (maxY - minY));
    this.k = k;
    const zoneW = (maxX - minX) * k;
    const zoneH = (maxY - minY) * k;
    // 比例系数：S = 1 时主屏宽 320 像素，物件的大小都跟着它
    const S = Math.max(0.7, (main.w * k) / 320);
    this.S = S;
    const avail = H - top;
    const sy = R(top + Math.max(16 * S, Math.min((avail - zoneH) * 0.22, avail * 0.12)));
    const sx = R((W - zoneW) / 2);
    this.zone = { x: sx, y: sy, minX, minY };
    this.rects = screens.map((s, i) => ({ i, main: s === main, x: sx + R((s.x - minX) * k), y: sy + R((s.y - minY) * k), w: R(s.w * k), h: R(s.h * k) }));
    this.deskY = R(sy + zoneH + 30 * S);
    const t = THEME[this.night ? 'night' : 'day'];
    const pad = R(30 * S);
    this.pad = pad;
    this.buildWall(t, pad);
    this.buildDesk(t);
    this.buildMonitors();
    this.buildForeground(pad);
    this.buildScreens();
  }

  /** 墙：分层的颜色，层间棋盘格过渡；显示器后面一圈灯带，左上角一幅小画，右上角几块六边形灯 */
  buildWall(t, pad) {
    const { W, H, S, deskY } = this;
    const z = (n) => Math.max(1, R(n * S));
    const [c, g] = layer(W + pad * 2, H);
    const bands = t.wall;
    const bh = Math.ceil(deskY / bands.length);
    bands.forEach((col, i) => {
      g.fillStyle = col;
      g.fillRect(0, i * bh, c.width, bh);
      if (i) dither(g, 0, i * bh, c.width, 2, bands[i - 1]);
    });
    // 墙面上很淡的竖向墙纸纹
    g.fillStyle = this.night ? 'rgba(255, 255, 255, 0.025)' : 'rgba(80, 40, 160, 0.035)';
    for (let x = 0; x < c.width; x += z(12)) g.fillRect(x, 0, 1, deskY);

    // 灯带：把所有显示器围起来，底边藏在桌面后面
    const rs = this.rects;
    const x0 = Math.min(...rs.map((r) => r.x)) - z(24) + pad;
    const x1 = Math.max(...rs.map((r) => r.x + r.w)) + z(24) + pad;
    const y0 = Math.min(...rs.map((r) => r.y)) - z(22);
    const rr = z(16);
    const path = [];
    for (let y = deskY; y > y0 + rr; y--) path.push([x0, y]);
    for (let a = 180; a <= 270; a += 1.5) path.push([x0 + rr + Math.cos((a * Math.PI) / 180) * rr, y0 + rr + Math.sin((a * Math.PI) / 180) * rr]);
    for (let x = x0 + rr; x < x1 - rr; x++) path.push([x, y0]);
    for (let a = 270; a <= 360; a += 1.5) path.push([x1 - rr + Math.cos((a * Math.PI) / 180) * rr, y0 + rr + Math.sin((a * Math.PI) / 180) * rr]);
    for (let y = y0 + rr; y < deskY; y++) path.push([x1, y]);
    const tw = z(2);
    const [gc, gg] = layer(c.width, c.height);
    for (const [x, y] of path) {
      gg.fillStyle = neonAt((x - x0) / (x1 - x0));
      gg.fillRect(R(x) - tw, R(y) - tw, tw * 3, tw * 3);
    }
    g.save();
    g.globalAlpha = t.glowA;
    g.filter = `blur(${z(12)}px)`;
    g.drawImage(gc, 0, 0);
    g.filter = `blur(${z(4)}px)`;
    g.drawImage(gc, 0, 0);
    g.restore();
    for (const [x, y] of path) {
      g.fillStyle = neonAt((x - x0) / (x1 - x0));
      g.fillRect(R(x), R(y), tw, tw);
    }
    g.fillStyle = 'rgba(255, 255, 255, 0.7)';
    for (const [x, y] of path) if (R(x + y) % 3 === 0) g.fillRect(R(x), R(y), 1, 1);
    // 灯带的卡扣
    g.fillStyle = PAL.alu2;
    for (let y = y0 + rr + z(20); y < deskY - 4; y += z(36)) {
      g.fillRect(x0 - 1, y, tw + 2, z(3));
      g.fillRect(x1 - 1, y, tw + 2, z(3));
    }

    // 左上：画框里一幅小画（日落、山和湖）
    const aw = R(Math.min(x0 - pad - z(30), 90 * S));
    if (aw > 24 * S) {
      const ax = pad + z(10);
      const ay = R(y0 + z(10));
      const ah = R(aw * 0.75);
      g.fillStyle = 'rgba(20, 10, 50, 0.35)';
      g.fillRect(ax - z(3) + 2, ay - z(3) + 2, aw + z(6), ah + z(6));
      g.fillStyle = GUNMETAL.side;
      g.fillRect(ax - z(3), ay - z(3), aw + z(6), ah + z(6));
      g.fillStyle = GUNMETAL.face;
      g.fillRect(ax - z(3), ay - z(3), aw + z(6) - 1, ah + z(6) - 1);
      g.fillStyle = GUNMETAL.hi;
      g.fillRect(ax - z(3), ay - z(3), aw + z(6) - 1, 1);
      g.fillStyle = '#120f24';
      g.fillRect(ax - 1, ay - 1, aw + 2, ah + 2);
      const sky = ['#ff9fcb', '#ffa9b8', '#ffb3a3', '#ffc890', '#ffdc7a', '#ffe066'];
      sky.forEach((col, i) => {
        g.fillStyle = col;
        g.fillRect(ax, ay + R((i * ah * 0.6) / sky.length), aw, R((ah * 0.6) / sky.length) + 1);
      });
      disc(g, ax + R(aw * 0.62), ay + R(ah * 0.45), R(aw * 0.11), '#fff1c9');
      g.fillStyle = '#7f6cff';
      for (let x = 0; x < aw; x++) {
        const hh = R(ah * 0.42 + Math.sin(x / (6 * S)) * 4 * S + Math.sin(x / (2.3 * S)) * 1.5 * S);
        g.fillRect(ax + x, ay + ah - hh, 1, hh);
      }
      g.fillStyle = '#4b3a9a';
      for (let x = 0; x < aw; x++) {
        const hh = R(ah * 0.25 + Math.sin(x / (4 * S) + 2) * 3 * S);
        g.fillRect(ax + x, ay + ah - hh, 1, hh);
      }
      g.fillStyle = '#5fb8ff';
      g.fillRect(ax, ay + ah - R(ah * 0.12), aw, R(ah * 0.12));
      dither(g, ax, ay + ah - R(ah * 0.12), aw, 1, '#ffd9f0', 3);
    }

    // 右上：六边形灯，各带一点光
    const hexes = [[0, 0, GLOW.a], [1, 0, GLOW.m], [0.5, 1, GLOW.b], [1.5, 1, GLOW.a], [1, 2, GLOW.m], [2, 2, GLOW.b2]];
    const hs = z(9);
    const hx0 = x1 + z(16);
    const hy0 = y0 + z(30);
    for (const [qx, qy, col] of hexes) {
      const cx = hx0 + qx * (hs * 2 + 2);
      const cy = hy0 + qy * (hs * 1.75);
      if (cx > c.width - hs) continue;
      g.save();
      g.globalAlpha = t.glowA * 0.6;
      g.filter = `blur(${z(6)}px)`;
      disc(g, cx, cy, hs + z(3), col);
      g.restore();
      for (let y = -hs; y <= hs; y++) {
        const w = R(hs - Math.abs(y) * 0.5);
        g.fillStyle = Math.abs(y) >= hs - 1 ? PAL.ink2 : col;
        g.fillRect(R(cx - w), R(cy + y), w * 2 + 1, 1);
      }
      g.fillStyle = 'rgba(255, 255, 255, 0.65)';
      g.fillRect(R(cx - hs * 0.4), R(cy - hs * 0.5), R(hs * 0.4), 1);
    }
    this.wall = c;
  }

  /** 桌面：上面映着灯带和屏幕的颜色 */
  buildDesk(t) {
    const { W, H, deskY, S } = this;
    const z = (n) => Math.max(1, R(n * S));
    const [c, g] = layer(W, H);
    g.fillStyle = t.deskEdge;
    g.fillRect(0, deskY - z(2), W, z(2));
    g.fillStyle = t.desk;
    g.fillRect(0, deskY, W, H - deskY);
    // 越远越密的细纹：近大远小
    g.fillStyle = t.desk2;
    let gap = 3;
    for (let y = deskY + 3; y < H; y += gap) {
      for (let x = (y % 2) * 2; x < W; x += gap * 2) g.fillRect(x, y, gap, 1);
      gap = Math.min(gap + 0.4, 9);
      y = R(y);
    }
    g.save();
    g.globalAlpha = this.night ? 0.55 : 0.35;
    g.filter = `blur(${z(16)}px)`;
    const rs = this.rects;
    const cx = (Math.min(...rs.map((r) => r.x)) + Math.max(...rs.map((r) => r.x + r.w))) / 2;
    g.fillStyle = GLOW.a;
    g.fillRect(cx - W * 0.44, deskY, W * 0.22, z(36));
    g.fillStyle = GLOW.b;
    g.fillRect(cx + W * 0.22, deskY, W * 0.22, z(36));
    g.fillStyle = GLOW.m;
    g.fillRect(cx - W * 0.2, deskY + 2, W * 0.4, z(30));
    g.restore();
    const neon = g.createLinearGradient(0, 0, W, 0);
    neon.addColorStop(0, GLOW.a);
    neon.addColorStop(0.5, GLOW.m);
    neon.addColorStop(1, GLOW.b);
    g.save();
    g.globalAlpha = this.night ? 0.7 : 0.45;
    g.filter = `blur(${z(3)}px)`;
    g.fillStyle = neon;
    g.fillRect(0, deskY - 1, W, z(3));
    g.restore();
    g.fillStyle = neon;
    g.fillRect(0, deskY, W, 1);
    this.desk = c;
  }

  /**
   * 显示器：深色窄边框，右侧露出一条铝合金的厚度，顶上一颗摄像头。
   * 支架只给下面没有别的显示器的那几块画，叠在上面的显示器看起来是挂在墙上。
   */
  buildMonitors() {
    const { W, H, deskY, S } = this;
    const z = (n) => Math.max(1, R(n * S));
    const [c, g] = layer(W, H);
    const b = z(5);
    const below = (r) => this.rects.some((o) => o !== r && o.y > r.y + r.h / 2 && o.x < r.x + r.w && o.x + o.w > r.x);
    for (const r of this.rects) {
      if (below(r)) continue;
      const nx = R(r.x + r.w / 2);
      const neckW = Math.max(z(14), R(r.w * 0.11));
      const neckTop = r.y + r.h;
      g.fillStyle = PAL.alu3;
      g.fillRect(nx - R(neckW / 2) + z(2), neckTop, neckW, deskY - neckTop + 2);
      g.fillStyle = PAL.alu;
      g.fillRect(nx - R(neckW / 2), neckTop, neckW - z(2), deskY - neckTop + 2);
      g.fillStyle = PAL.white;
      g.fillRect(nx - R(neckW / 2) + 1, neckTop, 1, deskY - neckTop);
      g.fillStyle = PAL.alu2;
      g.fillRect(nx - R(neckW / 2) + neckW - z(3), neckTop, 1, deskY - neckTop);
      const baseW = R(neckW * 2.8);
      g.fillStyle = 'rgba(30, 20, 60, 0.28)';
      g.fillRect(nx - R(baseW / 2) + 2, deskY + z(5), baseW - 4, z(3));
      block(g, nx - baseW / 2, deskY - 1, baseW, z(6), z(2), PAL.alu2);
      block(g, nx - baseW / 2, deskY - 2, baseW, z(4), z(2), PAL.alu);
      g.fillStyle = PAL.white;
      g.fillRect(nx - R(baseW / 2) + z(3), deskY - 2, baseW - z(6), 1);
    }
    for (const r of this.rects) {
      block(g, r.x - b + z(3), r.y - b + z(1), r.w + b * 2, r.h + b * 2, z(4), PAL.alu3);
      block(g, r.x - b + z(2), r.y - b, r.w + b * 2, r.h + b * 2, z(4), PAL.alu2);
      block(g, r.x - b, r.y - b, r.w + b * 2, r.h + b * 2, z(4), PAL.ink);
      g.fillStyle = PAL.ink3;
      g.fillRect(r.x - b + z(4), r.y - b, r.w + b * 2 - z(8), 1);
      g.fillStyle = '#0e0e10';
      g.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
      g.fillStyle = '#4a4a52';
      g.fillRect(R(r.x + r.w / 2) - 1, r.y - R(b / 2) - 1, 2, 2);
    }
    this.monitors = c;
  }

  /**
   * 前景：和第三人称（scene3d.js 的 rebuildWorld）摆的是同一批东西、同样的方位：
   * 左前 AirPods 充电盒；中间 键盘和鼠标（垫在一块带霓虹边的深色桌垫上）；右后 耳机架；右前 手机和无线充。
   * 零食、饮料、模型这些杂物不摆：颜色各不相干，桌面显得乱
   */
  buildForeground(pad) {
    const { W, H, deskY, S } = this;
    const z = (n) => Math.max(1, R(n * S));
    const [c, g] = layer(W + pad * 2, H);
    const room = H - deskY;
    const shadow = 'rgba(0, 0, 0, 0.45)';
    // 灯带渐变按整张画的横向位置取色：左白、中浅蓝、右蓝，和拱门、桌沿连成一条
    const neon = g.createLinearGradient(pad, 0, pad + W, 0);
    neon.addColorStop(0, GLOW.a);
    neon.addColorStop(0.5, GLOW.m);
    neon.addColorStop(1, GLOW.b);
    const glowA = this.night ? 0.7 : 0.45;
    /** 在一层上画发光的形状，模糊后叠回来，当作光晕 */
    const glow = (draw, blur, alpha = glowA) => {
      const [gc, gg] = layer(c.width, c.height);
      draw(gg);
      g.save();
      g.globalAlpha = alpha;
      g.filter = `blur(${blur}px)`;
      g.drawImage(gc, 0, 0);
      g.restore();
    };

    // 键盘：近大远小，只露出上面几排
    const kbTop = R(H - Math.min(room * 0.5, 44 * S));
    const kbW = R(W * 0.56);
    const kx = R(pad + (W - kbW) / 2);
    const mrw = 14 * S;
    const mrh = 25 * S;
    const mcx = kx + kbW + z(12) + mrw;

    // 桌垫：深色，一圈 1 像素的霓虹细边
    const matX = kx - z(22);
    const matY = kbTop - z(12);
    const matW = mcx + mrw + z(18) - matX;
    const matH = H - matY + z(8);
    glow((gg) => block(gg, matX, matY, matW, matH, z(6), neon), z(3), glowA * 0.6);
    block(g, matX, matY, matW, matH, z(6), neon);
    block(g, matX + 1, matY + 1, matW - 2, matH - 2, z(6) - 1, this.night ? '#0f0f11' : '#18181b');

    // 键盘：枪灰底座，深色键帽；键缝里透出紫色背光，四角几颗霓虹键
    g.fillStyle = shadow;
    g.fillRect(kx - z(3), kbTop - z(2), kbW + z(6), H);
    g.fillStyle = GUNMETAL.side;
    g.fillRect(kx - z(3), kbTop + 1, kbW + z(6), H);
    g.fillStyle = GUNMETAL.face;
    g.fillRect(kx - z(2), kbTop, kbW + z(4), H);
    g.fillStyle = GUNMETAL.hi;
    g.fillRect(kx - z(2), kbTop, kbW + z(4), 1);
    g.fillStyle = this.night ? '#2f6fd8' : '#2a5fc0';
    g.fillRect(kx + z(1), kbTop + z(2), kbW - z(2), H);
    let y = kbTop + z(3);
    let kh = z(6);
    let row = 0;
    const rnd = rng(9);
    const accents = [];
    while (y < H) {
      const n = 15 - (row % 2);
      const gapK = z(2);
      const kw = (kbW - z(4) - (n - 1) * gapK) / n;
      for (let i = 0; i < n; i++) {
        const x = R(kx + z(2) + i * (kw + gapK));
        const w = R(kw);
        const accent = row === 0 && i === 0 ? GLOW.b : row === 1 && i === n - 1 ? GLOW.m : row === 2 && i === 0 ? GLOW.b2 : row === 0 && i === n - 1 ? GLOW.m : null;
        g.fillStyle = '#141416';
        g.fillRect(x, y + 1, w, kh);
        g.fillStyle = accent ?? '#2a2a2e';
        g.fillRect(x, y, w, kh - 1);
        g.fillStyle = accent ? 'rgba(255, 255, 255, 0.75)' : 'rgba(185, 166, 255, 0.3)';
        g.fillRect(x + 1, y, w - 2, 1);
        g.fillStyle = accent ? 'rgba(20, 20, 30, 0.45)' : '#5a9cff';
        const lw = Math.max(1, R(w * (0.2 + rnd() * 0.25)));
        g.fillRect(x + R(w * 0.3), y + R(kh * 0.35), lw, 1);
        if (rnd() < 0.4) g.fillRect(x + R(w * 0.3), y + R(kh * 0.35) + 2, Math.max(1, lw - 1), 1);
        if (accent) accents.push([x, y, w, kh, accent]);
      }
      y += kh + z(2);
      kh += z(2);
      row++;
    }
    glow((gg) => accents.forEach(([x, yy, w, h, col]) => { gg.fillStyle = col; gg.fillRect(x, yy, w, h); }), z(3));

    // 鼠标：石墨外壳，底下一圈青色的灯，顶面分层明暗，左上一道高光
    const mcy = R(H - Math.min(room * 0.42, 40 * S) + mrh);
    g.save();
    g.globalAlpha = 0.7;
    shaded(g, mcx + z(3), mcy + z(5), mrw + z(2), mrh + z(1), { n: 2.6, levels: [shadow] });
    g.restore();
    glow((gg) => shaded(gg, mcx, mcy + z(2), mrw + z(1), mrh, { n: 2.6, levels: [GLOW.b] }), z(4));
    shaded(g, mcx, mcy + z(2), mrw, mrh, { n: 2.6, levels: [GLOW.b, GLOW.b2], outline: '#2a5fb8' });
    shaded(g, mcx, mcy, mrw - 1, mrh - 1, { n: 2.6, levels: GRAPHITE_LEVELS, outline: '#0f0f11' });
    g.fillStyle = '#6e6e78';
    for (let a = 200; a <= 250; a += 4) {
      const t = (a * Math.PI) / 180;
      g.fillRect(R(mcx + Math.cos(t) * mrw * 0.68), R(mcy + Math.sin(t) * mrh * 0.72), 1, 1);
    }
    g.fillStyle = '#0f0f11';
    g.fillRect(R(mcx), R(mcy - mrh * 0.85), 1, R(mrh * 0.35));

    // AirPods 充电盒：左下，盖子打开，里面露出两只耳机；正面一颗绿色的状态灯。白色是产品本色，保持原样
    const bw = 26 * S;
    const bh = 19 * S;
    const bcx = R(pad + Math.max(W * 0.13, bw + 14 * S));
    const bcy = R(H - Math.min(room * 0.45, 44 * S));
    g.save();
    g.globalAlpha = 0.7;
    shaded(g, bcx + z(4), bcy + bh * 0.85, bw + z(4), z(6), { n: 2, levels: [shadow] });
    g.restore();
    // 盖子：往后掀起，露出内侧
    const lidY = bcy - bh - z(9);
    shaded(g, bcx, lidY, bw - z(1), z(12), { n: 3, levels: ['#f2f2f4', '#e6e6ea', '#d6d6dc'], outline: '#bfbfc6' });
    shaded(g, bcx, lidY + z(2), bw - z(5), z(7), { n: 3, levels: ['#e0e0e5', '#d2d2d8'] });
    // 盒身：正面
    shaded(g, bcx, bcy, bw, bh, { n: 3.2, levels: WHITE_LEVELS, outline: '#bfbfc6' });
    // 盒口：上沿一条深色的缝，里面两个凹槽
    g.fillStyle = '#bcbcc4';
    g.fillRect(R(bcx - bw * 0.82), R(bcy - bh * 0.62), R(bw * 1.64), 1);
    for (const side of [-1, 1]) {
      const hx2 = bcx + side * bw * 0.36;
      shaded(g, hx2, bcy - bh * 0.48, z(8), z(5), { n: 2, levels: ['#a0a0a8', '#8c8c95'] });
      // 耳机：圆圆的头和一小截柄
      shaded(g, hx2, bcy - bh * 0.62, z(6.5), z(6), { n: 2, levels: WHITE_LEVELS, outline: '#c2c2c8' });
      g.fillStyle = '#2a2a2f';
      g.fillRect(R(hx2 - side * z(2)), R(bcy - bh * 0.62), z(2), z(2));
      g.fillStyle = PAL.white;
      g.fillRect(R(hx2 - z(3)), R(bcy - bh * 0.62 - z(3)), z(2), 1);
    }
    g.fillStyle = PAL.white;
    g.fillRect(R(bcx - bw * 0.55), R(bcy - bh * 0.3), R(bw * 0.25), 1);
    glow((gg) => disc(gg, bcx, R(bcy + bh * 0.2), z(3), PAL.mint), z(2));
    disc(g, bcx, R(bcy + bh * 0.2), z(1.4), PAL.mint);
    this.caseAt = { x: bcx - pad, y: bcy - z(4) };

    // 耳机架和头戴耳机：右边，只露出一半。枪灰支架，石墨耳机，耳罩外侧一道青色的灯。
    // 画面窄、显示器占满时耳机会挡住屏幕，这时不画
    const hx = pad + W - z(2);
    const hy = R(Math.max(deskY - 116 * S, this.zone.y + 30 * S));
    const screensRight = Math.max(...this.rects.map((r) => r.x + r.w)) + pad;
    this.podsAt = null;
    if (hx - z(48) > screensRight + z(6)) {
      g.fillStyle = shadow;
      g.fillRect(hx - z(20), deskY + z(6), z(44), z(3));
      g.fillStyle = GUNMETAL.side;
      g.fillRect(hx + z(2), hy, z(4), deskY - hy + z(4));
      g.fillStyle = GUNMETAL.face;
      g.fillRect(hx, hy, z(4), deskY - hy + z(4));
      g.fillStyle = GUNMETAL.hi;
      g.fillRect(hx, hy, 1, deskY - hy);
      block(g, hx - z(20), deskY + 1, z(44), z(7), z(3), GUNMETAL.side);
      block(g, hx - z(20), deskY, z(44), z(5), z(3), GUNMETAL.face);
      g.fillStyle = GUNMETAL.hi;
      g.fillRect(hx - z(17), deskY, z(38), 1);
      // 底座前沿一道紫光
      glow((gg) => { gg.fillStyle = GLOW.m; gg.fillRect(hx - z(18), deskY + z(5), z(40), z(2)); }, z(3));
      g.fillStyle = GLOW.m;
      g.fillRect(hx - z(18), deskY + z(5), z(40), 1);
      const bandR = z(36);
      for (let a = 190; a <= 350; a += 0.6) {
        const t = (a * Math.PI) / 180;
        const x = hx + z(2) + Math.cos(t) * bandR;
        const yy = hy + bandR + Math.sin(t) * bandR;
        g.fillStyle = '#0f0f11';
        g.fillRect(R(x), R(yy) - z(3), 1, z(7));
        g.fillStyle = '#2c2c31';
        g.fillRect(R(x), R(yy) - z(3) + 1, 1, z(5));
        if (a % 6 < 0.6) {
          g.fillStyle = '#4a4a50';
          g.fillRect(R(x), R(yy) - z(3) + 1, 1, 1);
        }
      }
      const cupX = hx + z(2) - bandR - z(10);
      const cupY = hy + bandR - z(6);
      glow((gg) => { gg.fillStyle = GLOW.b; gg.fillRect(cupX - z(2), cupY + z(8), z(4), z(30)); }, z(4));
      block(g, cupX - z(1), cupY, z(20), z(46), z(8), '#0f0f11');
      block(g, cupX, cupY + 1, z(18), z(44), z(8), '#2a2a2e');
      g.fillStyle = '#4a4a50';
      g.fillRect(cupX + z(4), cupY + z(6), z(2), z(14));
      // 耳罩外侧的灯
      g.fillStyle = GLOW.b;
      g.fillRect(cupX + z(1), cupY + z(10), z(1.5), z(26));
      g.fillStyle = 'rgba(255, 255, 255, 0.7)';
      g.fillRect(cupX + z(1), cupY + z(12), 1, z(6));
      // 耳垫：深紫，棋盘格表现绒面
      block(g, cupX + z(14), cupY + z(4), z(10), z(38), z(4), '#2a2a2e');
      dither(g, cupX + z(16), cupY + z(8), z(6), z(30), '#3a3a40', 2);
      g.fillStyle = PAL.mint;
      g.fillRect(cupX + z(8), cupY + z(36), z(2), z(2));
      this.podsAt = { x: cupX - pad + z(10), y: cupY + z(22) };
    }

    // 手机和无线充：右前，鼠标右边，平放在充电板上，往远处收窄。石墨充电板一圈青光，深色机身
    const phx = R(mcx + mrw + z(30));
    const phb = R(H - z(5));
    g.save();
    g.globalAlpha = 0.7;
    shaded(g, phx + z(2), phb - z(4), z(22), z(7), { n: 2, levels: [shadow] });
    g.restore();
    glow((gg) => ring(gg, phx, phb - z(6), z(18), GLOW.b), z(3));
    shaded(g, phx, phb - z(6), z(20), z(6.5), { n: 2, levels: GRAPHITE_LEVELS, outline: '#0f0f11' });
    ring(g, phx, phb - z(6), z(17), GLOW.b);
    const pth = z(15);
    for (let i = 0; i <= pth; i++) {
      const f = i / pth;
      const hw = R(z(8) + f * z(4));
      const yy = phb - z(5) - pth + i;
      const xx = phx + R((1 - f) * z(3));
      const edge = i === 0 || i === pth;
      g.fillStyle = edge ? '#0f0f11' : '#2c2c31';
      g.fillRect(xx - hw, yy, hw * 2, 1);
      if (edge || i < z(2) || i > pth - z(2)) continue;
      g.fillStyle = lerpColor('#3b2f8a', '#8a3f8f', f);
      g.fillRect(xx - hw + z(1.5), yy, hw * 2 - z(3), 1);
    }
    g.fillStyle = 'rgba(255, 255, 255, 0.55)';
    g.fillRect(phx + z(1), phb - z(5) - R(pth * 0.66), z(6), 1);
    g.fillRect(phx + z(0.5), phb - z(5) - R(pth * 0.5), z(8), 1);

    this.front = c;
  }

  /** 屏幕内容：每块屏幕一张像素桌面；时钟每分钟重画一次 */
  buildScreens() {
    this.clock = demoClock(); // 不是真实时间（见 demo-clock.js）
    this.screenArt = this.rects.map((r) => {
      const [c, g] = layer(r.w, r.h);
      drawWallpaper(g, r.w, r.h, this.layout.screens[r.i], this.clock, 7 + r.i * 13);
      return c;
    });
    const rnd = rng(3);
    this.stars = this.rects.map((r) => Array.from({ length: R(30 * this.S) }, () => ({ x: Math.floor(rnd() * r.w), y: R(10 * this.S) + Math.floor(rnd() * r.h * 0.3), p: rnd() * 6 })));
  }

  // ---------- 坐标 ----------

  /** 屏幕坐标 → 画布像素 */
  toCanvas(p) {
    return { x: this.zone.x + (p.x - this.zone.minX) * this.k, y: this.zone.y + (p.y - this.zone.minY) * this.k };
  }

  canvasAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * this.W, y: ((clientY - r.top) / r.height) * this.H };
  }

  /** 页面上的点 → 屏幕坐标。loose：屏幕外也换算（模拟头部可以看向屏幕外） */
  toScreenPx(clientX, clientY, loose = false) {
    if (!this.zone) return null;
    const { x, y } = this.canvasAt(clientX, clientY);
    if (!loose && !this.screenAt(x, y)) return null;
    return { x: this.zone.minX + (x - this.zone.x) / this.k, y: this.zone.minY + (y - this.zone.y) / this.k };
  }

  screenAt(x, y) {
    const m = 5 * this.S;
    return this.rects?.find((r) => x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m) ?? null;
  }

  toCss(x, y) {
    return { x: (x / this.W) * this.cssW, y: (y / this.H) * this.cssH };
  }

  pick(clientX, clientY) {
    if (!this.zone) return null;
    const { x, y } = this.canvasAt(clientX, clientY);
    if (this.cursorAt && Math.hypot(x - this.cursorAt.x, y - this.cursorAt.y) < 9 * this.S) return 'cursor';
    const s = this.screenAt(x, y);
    if (s) return `screen:${s.i}`;
    // 点 AirPods 充电盒或耳机，都展开耳机的数据
    for (const p of [this.caseAt, this.podsAt]) if (p && Math.hypot(x - p.x, y - p.y) < 30 * this.S) return 'pods';
    return null;
  }

  anchor(part) {
    if (!this.zone) return null;
    if (part?.startsWith('screen:')) {
      const r = this.rects[Number(part.slice(7))];
      return r ? this.toCss(r.x + r.w / 2, r.y - 6 * this.S) : null;
    }
    if (part === 'cursor' && this.cursorAt) return this.toCss(this.cursorAt.x, this.cursorAt.y);
    if (part === 'pods' && this.caseAt) return this.toCss(this.caseAt.x, this.caseAt.y - 34 * this.S);
    return null;
  }

  // ---------- 每帧 ----------

  draw({ sampleT, cursor, raw, target, compare, hit, control, alerts, selected, debug }) {
    if (!this.visible) return;
    if (this.canvas.clientWidth !== this.cssW || this.canvas.clientHeight !== this.cssH) this.build();
    if (!this.zone) return;
    const g = this.g;
    const { W, H, pad, S } = this;
    const z = (n) => Math.max(1, R(n * S));
    const now = performance.now();
    if (demoClock() !== this.clock) this.buildScreens();

    g.clearRect(0, 0, W, H);
    g.drawImage(this.wall, -pad, 0);
    g.drawImage(this.desk, 0, 0);
    g.drawImage(this.monitors, 0, 0);

    // 屏幕内容
    this.rects.forEach((r, i) => {
      g.drawImage(this.screenArt[i], r.x, r.y);
      g.fillStyle = PAL.white;
      for (const s of this.stars[i]) if (Math.sin(now / 500 + s.p) > 0.4) g.fillRect(r.x + s.x, r.y + s.y, 1, 1);
      if (debug) {
        g.fillStyle = 'rgba(255, 255, 255, 0.35)';
        for (const f of [1 / 3, 2 / 3]) {
          g.fillRect(R(r.x + r.w * f), r.y, 1, r.h);
          g.fillRect(r.x, R(r.y + r.h * f), r.w, 1);
        }
      }
      // 告警或选中时边框亮起来
      const level = alerts?.[`screen:${i}`];
      if (level || selected === `screen:${i}`) {
        const pulse = level ? 0.5 + 0.5 * Math.sin(now / 260) : 1;
        g.globalAlpha = level ? 0.4 + 0.6 * pulse : 0.9;
        g.fillStyle = level === 'bad' ? '#ff4d5e' : level ? '#ffa526' : PAL.yellow;
        const m = z(4);
        g.fillRect(r.x - m, r.y - m, r.w + m * 2, z(2));
        g.fillRect(r.x - m, r.y + r.h + m - z(2), r.w + m * 2, z(2));
        g.fillRect(r.x - m, r.y - m, z(2), r.h + m * 2);
        g.fillRect(r.x + r.w + m - z(2), r.y - m, z(2), r.h + m * 2);
        g.globalAlpha = 1;
      }
    });

    // 指向线的落点、轨迹、光标、目标：只画在屏幕里面
    g.save();
    g.beginPath();
    for (const r of this.rects) g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    const hitC = hit ? this.toCanvas(hit) : null;
    if (hitC && sampleT != null && sampleT !== this.lastSampleT) {
      this.trail.push({ ...hitC, t: sampleT });
      this.lastSampleT = sampleT;
    }
    if (sampleT != null) this.trail = this.trail.filter((p) => p.t >= sampleT - 1500 && p.t <= sampleT);
    for (const p of this.trail) {
      const a = 1 - (sampleT - p.t) / 1500;
      g.fillStyle = `rgba(255, 255, 255, ${(a * 0.7).toFixed(2)})`;
      g.fillRect(R(p.x), R(p.y), 1, 1);
    }
    if (target) {
      const tc = this.toCanvas(target);
      const r = z(5) + R(Math.sin(now / 200) * S);
      disc(g, tc.x, tc.y, r + z(2), PAL.white);
      disc(g, tc.x, tc.y, r, PAL.pink);
      disc(g, tc.x, tc.y, z(1.5), PAL.white);
    }
    if (hitC) {
      const ph2 = (now % 1200) / 1200;
      g.globalAlpha = 1 - ph2;
      ring(g, hitC.x, hitC.y, z(2) + ph2 * z(8), PAL.white);
      g.globalAlpha = 1;
      disc(g, hitC.x, hitC.y, z(1.5), PAL.white);
    }
    if (debug && raw) {
      const rc = this.toCanvas(raw);
      disc(g, rc.x, rc.y, z(1), '#9a9aa8');
    }
    this.cursorAt = null;
    if (cursor) {
      const cc = this.toCanvas(cursor);
      this.cursorAt = cc;
      if (debug && compare && hitC) {
        g.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(R(hitC.x) + 0.5, R(hitC.y) + 0.5);
        g.lineTo(R(cc.x) + 0.5, R(cc.y) + 0.5);
        g.stroke();
      }
      // 头控状态：识别歪头时金色，说话时青色，按住时粉色并带实心点，让给键鼠时灰色，驻留时外圈一点点走满
      const mode = control?.mode;
      const col = alerts?.cursor ? '#ffa526' : { gesture: PAL.yellow, voice: PAL.cyan, drag: PAL.pink, yield: '#8a84a8' }[mode] ?? (selected === 'cursor' ? PAL.yellow : PAL.white);
      const cr = z(6);
      ring(g, cc.x, cc.y, cr + 1, PAL.ink);
      for (let k = 0; k < Math.max(1, z(1.5)); k++) ring(g, cc.x, cc.y, cr - k, col);
      ring(g, cc.x, cc.y, cr - Math.max(1, z(1.5)), PAL.ink);
      if (mode === 'drag') disc(g, cc.x, cc.y, z(2), PAL.pink);
      if (mode === 'dwell' && control.progress > 0.05) {
        const n = 48;
        const dr = cr + z(3);
        g.fillStyle = PAL.lilac;
        for (let i = 0; i < n * control.progress; i++) {
          const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
          g.fillRect(R(cc.x + Math.cos(a) * dr), R(cc.y + Math.sin(a) * dr), Math.max(1, z(1)), Math.max(1, z(1)));
        }
      }
    }
    // 吸附到的元素：粉色框
    if (control?.snap) {
      const a = this.toCanvas(control.snap);
      const b = this.toCanvas({ x: control.snap.x + control.snap.w, y: control.snap.y + control.snap.h });
      g.strokeStyle = PAL.pink;
      g.lineWidth = 1;
      g.strokeRect(R(a.x) - 1.5, R(a.y) - 1.5, Math.max(R(b.x - a.x), 1) + 3, Math.max(R(b.y - a.y), 1) + 3);
    }
    // 点击的波纹：左键粉色，右键青色，双击两圈
    const fx = control?.fx;
    const fxP = fx ? (performance.now() - fx.t) / 450 : 1;
    if (fxP < 1) {
      const fc = this.toCanvas(fx.at);
      g.globalAlpha = 1 - fxP;
      const fcol = fx.kind === 'right' ? PAL.cyan : PAL.pink;
      ring(g, fc.x, fc.y, z(7) + R(fxP * z(12)), fcol);
      if (fx.kind === 'double') ring(g, fc.x, fc.y, z(4) + R(fxP * z(8)), fcol);
      g.globalAlpha = 1;
    }
    // 玻璃上的一道反光
    const rs = this.rects;
    const gx = Math.min(...rs.map((r) => r.x));
    const gy = Math.min(...rs.map((r) => r.y));
    const gw = Math.max(...rs.map((r) => r.x + r.w)) - gx;
    const gh = Math.max(...rs.map((r) => r.y + r.h)) - gy;
    g.fillStyle = 'rgba(255, 255, 255, 0.05)';
    g.beginPath();
    g.moveTo(gx + gw * 0.45, gy);
    g.lineTo(gx + gw * 0.62, gy);
    g.lineTo(gx + gw * 0.3, gy + gh);
    g.lineTo(gx + gw * 0.13, gy + gh);
    g.fill();
    g.restore();

    g.drawImage(this.front, -pad, 0);
    // 耳机出问题时，耳机那一角亮起来
    const pods = alerts?.pods;
    if (pods || selected === 'pods') {
      g.globalAlpha = pods ? 0.5 + 0.5 * Math.sin(now / 260) : 0.8;
      ring(g, this.caseAt.x, this.caseAt.y, z(32), pods === 'bad' ? '#ff4d5e' : pods ? '#ffa526' : PAL.yellow);
      g.globalAlpha = 1;
    }
  }
}
