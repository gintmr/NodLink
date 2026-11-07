// 光刃：发光的几何晶体（棱柱、六棱晶、钻形、多面球、晶片）从屏幕下方抛上来，在重力里翻转。
// 头就是刀尖：转头 / 甩头让刀尖划过晶体，速度够快就沿刀口把它劈成两半，半块各自旋转飞开，迸出碎晶。
// 一刀劈开好几个有连切加成；红黑色、带尖刺、一直在跳的“虚空核”千万别碰，碰到扣一条命；
// 晶体没劈就落回屏幕下方也扣命。三条命。越往后一次抛得越多、越快、散得越开、虚空核越多；
// 偶尔飞出一颗金晶，要在短时间里来回劈三刀才碎，分很多。
//
// 刀刃：刀尖最近约 140 ms 的轨迹画成一条两头尖的发光飘带，越快越亮。
// 判定：每帧刀尖走过的一小段线段扫过晶体，同时刀尖速度超过阈值（约 0.5 × 屏幕对角线 / 秒）才算劈。
// 模拟数据时鼠标代替头，指针位置就是刀尖。

import { NEON, clamp, lerp, rand, aimPoint, easeOut } from './kit.js';

const LIVES = 5;
const TRAIL_S = 0.14; // 刀刃长度（秒）
const TRAIL_N = 48; // 轨迹环形缓冲
const SPEED_WIN = 0.07; // 算刀尖速度用的时间窗（头部数据 30～50 Hz，窗太短会忽快忽慢）
const TIP_TAU = 0.018; // 刀尖轻微平滑，头部数据一跳一跳时刀刃也连贯
const AIM_MARGIN = 0.025; // 和模拟数据的鼠标换算对齐：指针在哪刀尖就在哪
const TOP = 96; // 顶部记分栏留空
const MAX_PARTS = 220;
const MAX_HALVES = 32;
const LIGHT = -Math.PI * 0.75; // 光从左上方来
const COLORS = [NEON.pink, NEON.violet, NEON.cyan, NEON.blue, NEON.mint];
const GOLD = '#ffcf5a';
// 浅色背景上，亮色的字换深一点的同色系
const ON_LIGHT = { [NEON.mint]: '#0f9f6e', [GOLD]: '#c08400', [NEON.red]: '#e0284a' };
const NUM_FONT = '"Unbounded Variable", sans-serif';
const UI_FONT = '-apple-system, "PingFang SC", sans-serif';

export default {
  id: 'blade',
  title: { zh: '光刃', en: 'Light Blade' },
  tagline: { zh: '头就是刀尖，劈开抛上来的发光晶体', en: 'Your head is the blade — slice the tossed crystals' },
  how: { zh: '快速转头划过晶体 · 别碰红色虚空核', en: 'Sweep fast through crystals · avoid red void cores' },
  accent: NEON.cyan,
  range: { h: 16, v: 10 }, // 不大的转头就能扫满屏幕
  icon: drawIcon,
  create,
};

// ---------------------------------------------------------------------------
// 晶体形状：单位半径的多边形 + 一个“芯”（切面从芯连到每条边，按朝向打亮 / 压暗）

function mkShape(verts, core) {
  const n = verts.length;
  const v = new Float32Array(n * 2);
  const ang = new Float32Array(n);
  verts.forEach(([x, y], i) => {
    v[i * 2] = x;
    v[i * 2 + 1] = y;
  });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ang[i] = Math.atan2((v[i * 2 + 1] + v[j * 2 + 1]) / 2 - core[1], (v[i * 2] + v[j * 2]) / 2 - core[0]);
  }
  return { v, n, ang, cx: core[0], cy: core[1] };
}

function ngon(n, a0) {
  return Array.from({ length: n }, (_, i) => [Math.cos(a0 + (i / n) * Math.PI * 2), Math.sin(a0 + (i / n) * Math.PI * 2)]);
}

const SHAPES = [
  mkShape([[0, -1.05], [0.9, 0.55], [-0.9, 0.55]], [-0.1, -0.02]), // 三棱
  mkShape(ngon(6, -Math.PI / 2), [-0.18, -0.2]), // 六棱晶
  mkShape([[-0.94, -0.3], [-0.5, -0.82], [0.5, -0.82], [0.94, -0.3], [0, 1]], [0, -0.36]), // 钻形
  mkShape(ngon(11, 0.3), [-0.26, -0.28]), // 多面球
  mkShape([[0, -1.2], [0.52, -0.08], [0, 1.15], [-0.52, 0.12]], [-0.08, -0.14]), // 晶片
];
const GOLD_SHAPE = SHAPES[1];

// 切面明暗的颜色字符串预先做好，每帧不拼字符串
const WHITE = Array.from({ length: 11 }, (_, i) => `rgba(255,255,255,${(i / 10).toFixed(2)})`);
const BLACK = Array.from({ length: 11 }, (_, i) => `rgba(8,6,24,${(i / 10).toFixed(2)})`);

function crystalPath(g, sh, r) {
  const v = sh.v;
  g.beginPath();
  g.moveTo(v[0] * r, v[1] * r);
  for (let i = 1; i < sh.n; i++) g.lineTo(v[i * 2] * r, v[i * 2 + 1] * r);
  g.closePath();
}

/** 在当前（已平移、旋转到晶体中心的）坐标系里画一颗晶体；rot 是它在世界里的转角，用来算光照 */
function drawCrystal(g, sh, r, color, rot, dark, glowBlur) {
  const v = sh.v;
  const n = sh.n;
  crystalPath(g, sh, r);
  g.fillStyle = color;
  if (glowBlur > 0) {
    g.shadowColor = color;
    g.shadowBlur = glowBlur;
  }
  g.fill();
  g.shadowBlur = 0;
  const cx = sh.cx * r;
  const cy = sh.cy * r;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b = Math.cos(sh.ang[i] + rot - LIGHT);
    g.fillStyle = b > 0 ? WHITE[Math.round(b * 5)] : BLACK[Math.round(-b * (dark ? 4 : 3))];
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(v[i * 2] * r, v[i * 2 + 1] * r);
    g.lineTo(v[j * 2] * r, v[j * 2 + 1] * r);
    g.closePath();
    g.fill();
  }
  // 棱线
  g.lineWidth = 1;
  g.strokeStyle = WHITE[dark ? 3 : 5];
  g.beginPath();
  for (let i = 0; i < n; i++) {
    g.moveTo(cx, cy);
    g.lineTo(v[i * 2] * r, v[i * 2 + 1] * r);
  }
  g.stroke();
  crystalPath(g, sh, r);
  g.lineWidth = 1.6;
  g.strokeStyle = dark ? WHITE[6] : 'rgba(24,18,60,0.42)';
  g.stroke();
  // 高光
  g.fillStyle = WHITE[9];
  g.beginPath();
  g.arc(cx - r * 0.16, cy - r * 0.16, Math.max(1.2, r * 0.07), 0, Math.PI * 2);
  g.fill();
}

/** 半块：用刀口那条线（局部坐标里的点 lp、法向 ln）裁掉另一侧，再画整颗晶体；刀口上留一道渐暗的亮痕 */
function drawHalf(g, hf, dark, glowBlur) {
  const L = hf.r * 3;
  const dx = -hf.lny;
  const dy = hf.lnx;
  const ox = hf.lnx * L * hf.side;
  const oy = hf.lny * L * hf.side;
  g.save();
  g.translate(hf.x, hf.y);
  g.rotate(hf.rot);
  g.beginPath();
  g.moveTo(hf.lpx + dx * L, hf.lpy + dy * L);
  g.lineTo(hf.lpx - dx * L, hf.lpy - dy * L);
  g.lineTo(hf.lpx - dx * L + ox, hf.lpy - dy * L + oy);
  g.lineTo(hf.lpx + dx * L + ox, hf.lpy + dy * L + oy);
  g.closePath();
  g.clip();
  drawCrystal(g, hf.sh, hf.r, hf.color, hf.rot, dark, glowBlur);
  if (hf.seam > 0) {
    g.strokeStyle = WHITE[Math.round(hf.seam * 10)];
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(hf.lpx - dx * hf.r * 1.2, hf.lpy - dy * hf.r * 1.2);
    g.lineTo(hf.lpx + dx * hf.r * 1.2, hf.lpy + dy * hf.r * 1.2);
    g.stroke();
  }
  g.restore();
}

/** 虚空核：黑色带尖刺的球，红色的心一直在跳 */
function drawVoid(g, r, rot, pulse) {
  const spikes = 9;
  g.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = rot + (i / (spikes * 2)) * Math.PI * 2;
    const rr = i % 2 ? r * 0.6 : r * (1 + 0.07 * pulse);
    if (i) g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath();
  g.fillStyle = '#14060b';
  g.shadowColor = NEON.red;
  g.shadowBlur = 12 + 14 * pulse;
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 2;
  g.strokeStyle = NEON.red;
  g.stroke();
  g.fillStyle = NEON.red;
  g.globalAlpha = 0.55 + 0.45 * pulse;
  g.beginPath();
  g.arc(0, 0, r * (0.3 + 0.06 * pulse), 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  g.beginPath();
  g.arc(0, 0, r * 0.12, 0, Math.PI * 2);
  g.fill();
}

// 刀刃飘带：点从旧到新放在 RX / RY 里，宽度从尾巴的 0 渐到刀尖
const RX = new Float64Array(TRAIL_N);
const RY = new Float64Array(TRAIL_N);
const NX = new Float64Array(TRAIL_N);
const NY = new Float64Array(TRAIL_N);

function ribbonNormals(n) {
  let px = 0;
  let py = 1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(i - 1, 0);
    const b = Math.min(i + 1, n - 1);
    const dx = RX[b] - RX[a];
    const dy = RY[b] - RY[a];
    const len = Math.hypot(dx, dy);
    if (len > 1e-3) {
      px = -dy / len;
      py = dx / len;
    }
    NX[i] = px;
    NY[i] = py;
  }
  // 开头几个点可能还没方向，用第一个有方向的补上
  for (let i = n - 2; i >= 0; i--) {
    if (NX[i] === 0 && NY[i] === 1) {
      NX[i] = NX[i + 1];
      NY[i] = NY[i + 1];
    }
  }
}

function ribbonPath(g, n, width) {
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const wi = width * Math.pow(i / (n - 1), 0.85);
    const x = RX[i] + NX[i] * wi;
    const y = RY[i] + NY[i] * wi;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--) {
    const wi = width * Math.pow(i / (n - 1), 0.85);
    g.lineTo(RX[i] - NX[i] * wi, RY[i] - NY[i] * wi);
  }
  g.closePath();
}

/** bright：0…1，越快越亮越宽 */
function drawRibbon(g, n, bright, dark, scale = 1) {
  if (n < 2) return;
  ribbonNormals(n);
  const width = (2.5 + 7.5 * bright) * scale;
  const color = dark ? NEON.cyan : NEON.blue;
  g.save();
  g.globalAlpha = 0.3 + 0.7 * bright;
  g.shadowColor = color;
  g.shadowBlur = (dark ? 26 : 14) * bright * scale;
  g.fillStyle = color;
  ribbonPath(g, n, width);
  g.fill();
  g.shadowBlur = 0;
  g.globalAlpha = 0.45 + 0.55 * bright;
  g.fillStyle = '#ffffff';
  ribbonPath(g, n, width * 0.38);
  g.fill();
  g.restore();
}

// ---------------------------------------------------------------------------

function create(api) {
  const { input, sound } = api;
  const s = {
    t: 0, // 世界时间（结束时慢放）
    rt: 0, // 真实时间
    started: false,
    countdown: 3,
    over: false,
    endT: 0,
    finished: false,
    score: 0,
    lives: LIVES,
    combo: 0,
    maxCombo: 0,
    sliced: 0,
    bestSwipe: 0,
    tosses: 0,
    level: 1,
    levelShow: 0,
    nextToss: 0.5,
    pending: [],
    objs: [],
    halves: [],
    pops: [],
    cuts: [],
    drops: [],
    tipX: 0,
    tipY: 0,
    tipOk: false,
    speed: 0,
    dirX: 1,
    dirY: 0,
    swipeOn: false,
    swipeN: 0,
    swipeLow: 0,
    swipePeak: 0,
    swipeT: 0,
    swipeX: 0,
    swipeY: 0,
    whooshAt: -1,
    frameHits: 0,
    flash: 0,
    hurt: 0,
    shake: 0,
    distort: 0,
  };
  // 刀尖轨迹（环形缓冲）
  const tx = new Float64Array(TRAIL_N);
  const ty = new Float64Array(TRAIL_N);
  const tt = new Float64Array(TRAIL_N);
  let th = 0;
  let tn = 0;
  const at = (i) => (th - 1 - i + TRAIL_N * 2) % TRAIL_N; // i = 0 最新
  const pushTrail = (x, y, t) => {
    tx[th] = x;
    ty[th] = y;
    tt[th] = t;
    th = (th + 1) % TRAIL_N;
    tn = Math.min(tn + 1, TRAIL_N);
  };
  // 粒子池：预先分配，用完覆盖最旧的
  const parts = Array.from({ length: MAX_PARTS }, () => ({ life: 0, max: 1, x: 0, y: 0, vx: 0, vy: 0, size: 3, rot: 0, spin: 0, color: '#fff', kind: 0 }));
  let pCur = 0;
  const emit = (x, y, vx, vy, life, size, color, kind) => {
    const p = parts[pCur];
    pCur = (pCur + 1) % MAX_PARTS;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = p.max = life;
    p.size = size;
    p.color = color;
    p.kind = kind;
    p.rot = rand(0, Math.PI * 2);
    p.spin = rand(-12, 12);
  };
  let bgCache = null;

  // 刀尖指针换成刀刃，系统指针藏起来（模拟数据时鼠标就是刀尖）
  const cv = api.canvas;
  const prevCursor = cv?.style?.cursor ?? '';
  if (cv?.style) cv.style.cursor = 'none';
  const restoreCursor = () => {
    if (cv?.style) cv.style.cursor = prevCursor;
  };

  // 头不像手那么快那么准：晶体做大、刀速门槛放低（约 9°/s 的转头就算挥刀）
  const sizeScale = () => clamp(Math.min(api.w, api.h) / 820, 0.85, 1.4);
  const threshold = () => clamp(0.24 * Math.hypot(api.w, api.h), 240, 520);

  // ---------- 出题 ----------

  function toss() {
    s.tosses += 1;
    const lv = 1 + Math.floor((s.tosses - 1) / 6);
    if (lv !== s.level) {
      s.level = lv;
      s.levelShow = 1.6;
      sound.tick(true);
    }
    const k = clamp((lv - 1) / 13, 0, 1); // 0 → 1：第 1 波到第 14 波
    const n = Math.min(1 + Math.floor(lv * 0.4) + (Math.random() < 0.35 ? 1 : 0), 6);
    const gScale = lerp(0.7, 1.25, k); // 重力：屏幕高度 / 秒²。飞得慢，头跟得上
    const spread = lerp(0.14, 0.34, k);
    const voidP = lv < 3 ? 0 : lerp(0.08, 0.3, k);
    const maxVoids = 1 + Math.floor(lv / 5);
    const burst = Math.random() < lerp(0.35, 0.6, k);
    let voids = 0;
    let last = 0;
    for (let i = 0; i < n; i++) {
      const delay = burst ? rand(0, 0.12) : i * rand(0.3, 0.5) * lerp(1, 0.7, k);
      last = Math.max(last, delay);
      let kind = 'crystal';
      if (i > 0 && voids < maxVoids && Math.random() < voidP) {
        kind = 'void';
        voids += 1;
      }
      s.pending.push({ at: s.t + delay, kind, gScale, spread });
    }
    if (lv >= 3 && Math.random() < 0.13 && !s.objs.some((o) => o.kind === 'gold')) {
      const d = rand(0.1, 0.5);
      last = Math.max(last, d);
      s.pending.push({ at: s.t + d, kind: 'gold', gScale, spread });
    }
    const air = 2 * Math.sqrt((2 * 0.7) / gScale);
    s.nextToss = s.t + last + air * lerp(1.0, 0.72, k) + lerp(0.8, 0.3, k);
  }

  function spawn(p) {
    const { w, h } = api;
    const ss = sizeScale();
    const kind = p.kind;
    const r = (kind === 'gold' ? 74 : kind === 'void' ? 52 : rand(56, 70)) * ss;
    const grav = p.gScale * h * (kind === 'gold' ? 0.62 : 1);
    const x = w / 2 + rand(-1, 1) * w * p.spread;
    const y = h + r + 4;
    const apex = rand(TOP + r + 20, h * 0.46);
    const vy = -Math.sqrt(2 * grav * (y - apex));
    const air = (2 * -vy) / grav;
    const endX = clamp(x + rand(-0.25, 0.25) * w, w * 0.12, w * 0.88); // 横向飘得少，头不用追着跑
    s.objs.push({
      kind,
      sh: kind === 'gold' ? GOLD_SHAPE : SHAPES[(Math.random() * SHAPES.length) | 0],
      color: kind === 'gold' ? GOLD : COLORS[(Math.random() * COLORS.length) | 0],
      x,
      y,
      vx: (endX - x) / air,
      vy,
      grav,
      r,
      rot: rand(0, Math.PI * 2),
      spin: rand(-1.6, 1.6),
      alive: true,
      hits: 0,
      lastHit: -9,
      armed: true,
      phase: rand(0, 6),
    });
    if (kind === 'void') sound.tone(120, 0.2, { type: 'sine', vol: 0.05, slide: 160 });
    else sound.tone(kind === 'gold' ? 980 : rand(360, 460), 0.08, { type: 'sine', vol: 0.04, slide: kind === 'gold' ? 1400 : 560 });
  }

  // ---------- 劈 ----------

  function checkHits(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    for (const o of s.objs) {
      if (!o.alive) continue;
      let u = l2 > 1e-6 ? ((o.x - ax) * dx + (o.y - ay) * dy) / l2 : 0;
      u = clamp(u, 0, 1);
      const px = ax + dx * u;
      const py = ay + dy * u;
      const rr = o.r * (o.kind === 'void' ? 0.72 : 1.2) + (o.kind === 'void' ? 0 : 8); // 晶体宽松，虚空严一点
      if ((px - o.x) ** 2 + (py - o.y) ** 2 > rr * rr) continue;
      if (o.kind === 'void') hitVoid(o);
      else if (o.kind === 'gold') {
        if (o.armed) hitGold(o, px, py);
      } else {
        scoreSlice(o, 10);
        slice(o, px, py, 1);
      }
    }
  }

  function scoreSlice(o, base) {
    s.combo += 1;
    s.maxCombo = Math.max(s.maxCombo, s.combo);
    s.sliced += 1;
    s.swipeN += 1;
    s.swipeX = o.x;
    s.swipeY = o.y;
    s.score += base + 2 * Math.min(s.combo, 10);
    s.frameHits += 1;
    api.setScore(s.score);
  }

  /** 沿刀口把晶体劈成两半 */
  function slice(o, px, py, power) {
    o.alive = false;
    const dx = s.dirX;
    const dy = s.dirY;
    const nx = -dy;
    const ny = dx;
    // 刀口离中心太远的话往里挪一点，两半都要像样
    const d = clamp((px - o.x) * nx + (py - o.y) * ny, -0.4 * o.r, 0.4 * o.r);
    const cx = o.x + nx * d;
    const cy = o.y + ny * d;
    const cos = Math.cos(o.rot);
    const sin = Math.sin(o.rot);
    const lx = cx - o.x;
    const ly = cy - o.y;
    const lpx = lx * cos + ly * sin;
    const lpy = -lx * sin + ly * cos;
    const lnx = nx * cos + ny * sin;
    const lny = -nx * sin + ny * cos;
    const sep = rand(110, 170) * power;
    for (const side of [1, -1]) {
      if (s.halves.length >= MAX_HALVES) s.halves.shift();
      s.halves.push({
        sh: o.sh,
        color: o.color,
        r: o.r,
        x: o.x,
        y: o.y,
        vx: o.vx * 0.6 + nx * side * sep + dx * 70,
        vy: Math.min(o.vy, 0) * 0.4 + ny * side * sep + dy * 70,
        grav: o.grav,
        rot: o.rot,
        spin: o.spin + side * rand(2.5, 5.5),
        lpx,
        lpy,
        lnx,
        lny,
        side,
        seam: 1,
      });
    }
    const nShards = o.kind === 'gold' ? 26 : 12;
    for (let i = 0; i < nShards; i++) {
      const along = rand(-1, 1) * o.r;
      const sd = Math.random() < 0.5 ? 1 : -1;
      const sp = rand(80, 380);
      emit(cx + dx * along, cy + dy * along, nx * sd * sp + dx * rand(-60, 160), ny * sd * sp + dy * rand(-60, 160) - 60, rand(0.4, 0.8), rand(2.5, 6), Math.random() < 0.3 ? '#ffffff' : o.color, 0);
    }
    if (s.cuts.length >= 12) s.cuts.shift();
    s.cuts.push({ x1: cx - dx * o.r * 1.7, y1: cy - dy * o.r * 1.7, x2: cx + dx * o.r * 1.7, y2: cy + dy * o.r * 1.7, life: 1 });
    s.flash = Math.max(s.flash, 0.35);
  }

  function hitGold(o, px, py) {
    o.armed = false;
    if (o.hits > 0 && s.t - o.lastHit > 1.6) o.hits = 0; // 三刀要连着劈
    o.hits += 1;
    o.lastHit = s.t;
    if (o.hits >= 3) {
      scoreSlice(o, 10);
      const bonus = 250;
      s.score += bonus;
      api.setScore(s.score);
      slice(o, px, py, 1.4);
      popup(o.x, o.y - o.r, api.tr(`金晶 +${bonus + 10}`, `GOLD +${bonus + 10}`), GOLD, 30);
      sound.good(12);
      sound.tone(1760, 0.3, { type: 'triangle', vol: 0.12, when: 0.08 });
      s.flash = 1;
      return;
    }
    s.score += 15;
    api.setScore(s.score);
    sound.good(6 + o.hits * 3);
    // 被劈一下往上弹一点、转快一点，好接着劈
    const room = Math.max(0, o.y - (TOP + o.r + 10));
    o.vy = Math.max(-Math.sqrt(2 * o.grav * room), Math.min(o.vy * 0.2, -api.h * 0.55));
    o.vx *= 0.5;
    o.spin += (Math.random() < 0.5 ? -1 : 1) * 4;
    for (let i = 0; i < 10; i++) emit(px, py, rand(-260, 260), rand(-320, 120), rand(0.35, 0.7), rand(2, 4), GOLD, 1);
    popup(o.x, o.y - o.r - 8, `${o.hits} / 3`, GOLD, 20);
  }

  function hitVoid(o) {
    o.alive = false;
    for (let i = 0; i < 30; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(120, 520);
      emit(o.x, o.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.4, 0.9), rand(3, 7), i % 3 ? '#1a0a10' : NEON.red, i % 3 ? 0 : 1);
    }
    s.shake = 18;
    s.distort = 1;
    s.hurt = 1;
    sound.bad();
    sound.tone(70, 0.55, { type: 'sine', vol: 0.5, slide: 32 });
    sound.noise(0.45, { vol: 0.3, freq: 160, q: 0.5 });
    popup(o.x, o.y, api.tr('虚空核 −1', 'VOID −1'), NEON.red, 26);
    loseLife();
  }

  function loseLife() {
    if (s.over || s.lives <= 0) return;
    s.lives -= 1;
    s.combo = 0;
    if (s.lives <= 0) {
      s.over = true;
      s.endT = 0;
      endSwipe();
    }
  }

  function popup(x, y, text, color, size) {
    if (s.pops.length >= 8) s.pops.shift();
    s.pops.push({ x, y, text, color, size, life: 1 });
  }

  function endSwipe() {
    if (!s.swipeOn) return;
    s.swipeOn = false;
    const n = s.swipeN;
    s.bestSwipe = Math.max(s.bestSwipe, n);
    if (n >= 3) {
      const bonus = 5 * n * n;
      s.score += bonus;
      api.setScore(s.score);
      popup(s.swipeX, s.swipeY - 30, api.tr(`${n} 连切 +${bonus}`, `${n}-CUT +${bonus}`), NEON.mint, 22 + Math.min(n, 6) * 2);
      sound.tone(880 * Math.pow(2, Math.min(n, 8) / 12), 0.22, { type: 'triangle', vol: 0.14, slide: 1760 });
    } else if (n === 0 && s.swipeT > 0.05 && s.swipePeak > threshold() * 1.2 && s.rt - s.whooshAt > 0.25 && s.started && !s.over) {
      // 空挥：轻轻一声风
      s.whooshAt = s.rt;
      sound.noise(0.14, { vol: 0.06, freq: 900, q: 0.6 });
    }
  }

  // ---------- 刀尖 ----------

  function updateTip(dt) {
    const { w, h } = api;
    if (!input.ok) {
      s.tipOk = false;
      tn = 0;
      s.speed = 0;
      endSwipe();
      return;
    }
    const a = aimPoint(input, w, h, AIM_MARGIN);
    if (!s.tipOk) {
      s.tipOk = true;
      s.tipX = a.x;
      s.tipY = a.y;
      tn = 0;
    }
    // 瞬移（鼠标移出画面、重新定正前方）：断开轨迹，不算一刀
    if (Math.hypot(a.x - s.tipX, a.y - s.tipY) > 0.4 * Math.max(w, h)) {
      s.tipX = a.x;
      s.tipY = a.y;
      tn = 0;
      s.speed = 0;
      endSwipe();
      pushTrail(s.tipX, s.tipY, s.rt);
      return;
    }
    const px = s.tipX;
    const py = s.tipY;
    const k = 1 - Math.exp(-dt / TIP_TAU);
    s.tipX += (a.x - s.tipX) * k;
    s.tipY += (a.y - s.tipY) * k;
    pushTrail(s.tipX, s.tipY, s.rt);
    const mx = s.tipX - px;
    const my = s.tipY - py;
    const ml = Math.hypot(mx, my);
    if (ml > 0.5) {
      s.dirX = mx / ml;
      s.dirY = my / ml;
    }
    // 速度：最近 70 ms 走过的路程
    let len = 0;
    let span = 0;
    for (let i = 1; i < tn; i++) {
      const a1 = at(i - 1);
      const a0 = at(i);
      if (s.rt - tt[a0] > SPEED_WIN) break;
      len += Math.hypot(tx[a1] - tx[a0], ty[a1] - ty[a0]);
      span = s.rt - tt[a0];
    }
    s.speed = span > 0 ? len / Math.max(span, 0.035) : 0;
    const thr = threshold();
    if (s.speed > thr) {
      if (!s.swipeOn) {
        s.swipeOn = true;
        s.swipeN = 0;
        s.swipePeak = 0;
        s.swipeT = 0;
      }
      s.swipeLow = 0;
      s.swipeT += dt;
      s.swipePeak = Math.max(s.swipePeak, s.speed);
      if (s.started && !s.over && tn >= 2) checkHits(px, py, s.tipX, s.tipY);
    } else if (s.swipeOn) {
      s.swipeLow += dt;
      if (s.swipeLow > 0.1) endSwipe();
    }
    // 金晶：刀尖离开它以后才能再劈下一刀
    for (const o of s.objs) {
      if (o.kind === 'gold' && !o.armed && Math.hypot(s.tipX - o.x, s.tipY - o.y) > o.r * 1.1) o.armed = true;
    }
  }

  // ---------- 每帧 ----------

  function frame(dt) {
    const { g, w, h } = api;
    const dark = api.dark;
    const c = api.colors;
    s.rt += dt;
    if (!s.started) {
      s.countdown -= dt;
      if (Math.ceil(s.countdown) !== Math.ceil(s.countdown + dt)) sound.tick(s.countdown <= 0);
      if (s.countdown <= 0) {
        s.started = true;
        input.rearm(); // 正前方由大厅开局前的“对准中心”定，这里只清手势
        s.tipOk = false;
        tn = 0;
      }
    }
    s.frameHits = 0;
    updateTip(dt);
    if (s.frameHits) {
      // 一帧里劈中几个只出一声，越连越高
      sound.noise(0.09, { vol: 0.16, freq: 2400 + Math.min(s.swipeN, 8) * 250, q: 1.2 });
      sound.good(clamp(s.swipeN - 1 + Math.floor(s.combo / 6), 0, 12));
    }

    const wdt = s.over ? dt * 0.3 : dt; // 最后一条命没了：慢放一下再结算
    if (s.started) {
      s.t += wdt;
      if (!s.over) {
        if (s.t >= s.nextToss) {
          if (s.objs.length > 9) s.nextToss = s.t + 0.3;
          else toss();
        }
        for (let i = s.pending.length - 1; i >= 0; i--) {
          if (s.t >= s.pending[i].at) {
            spawn(s.pending[i]);
            s.pending.splice(i, 1);
          }
        }
      }
      let j = 0;
      for (const o of s.objs) {
        if (!o.alive) continue;
        o.vy += o.grav * wdt;
        o.x += o.vx * wdt;
        o.y += o.vy * wdt;
        o.rot += o.spin * wdt;
        if (o.vy > 0 && o.y - o.r > h + 4) {
          if (o.kind === 'crystal' && !s.over) {
            // 漏掉一颗：底边对应位置一道红光
            if (s.drops.length >= 6) s.drops.shift();
            s.drops.push({ x: o.x, life: 1 });
            s.shake = Math.max(s.shake, 6);
            sound.tone(300, 0.22, { type: 'triangle', vol: 0.14, slide: 150 });
            popup(clamp(o.x, 60, w - 60), h - 40, '−1', NEON.red, 22);
            loseLife();
          }
          continue;
        }
        s.objs[j++] = o;
      }
      s.objs.length = j;
    }
    if (s.over) {
      s.endT += dt;
      if (s.endT > 1.4 && !s.finished) {
        s.finished = true;
        restoreCursor();
        api.finish({
          score: s.score,
          stats: api.tr(`切开 ${s.sliced} 个 · 最多一刀 ${s.bestSwipe} 个 · 最长连击 ${s.maxCombo}`, `${s.sliced} sliced · best swipe ${s.bestSwipe} · best combo ${s.maxCombo}`),
        });
      }
    }

    // ---- 画 ----
    drawBg(g, w, h, dark, c);
    const shx = s.shake > 0.3 ? rand(-1, 1) * s.shake : 0;
    const shy = s.shake > 0.3 ? rand(-1, 1) * s.shake : 0;
    s.shake *= Math.exp(-dt * 9);
    g.save();
    g.translate(shx, shy);
    const glowBlur = dark ? 18 : 10;

    // 漏掉的位置
    for (const d of s.drops) {
      d.life -= dt * 1.2;
      if (d.life <= 0) continue;
      g.globalAlpha = d.life * 0.8;
      g.fillStyle = NEON.red;
      g.shadowColor = NEON.red;
      g.shadowBlur = 20;
      g.beginPath();
      g.ellipse(d.x, h, 70, 10 + 14 * d.life, 0, Math.PI, 0);
      g.fill();
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }
    if (s.drops.length && s.drops[0].life <= 0) s.drops.shift();
    // 半块
    let j = 0;
    for (const hf of s.halves) {
      hf.vy += hf.grav * wdt;
      hf.x += hf.vx * wdt;
      hf.y += hf.vy * wdt;
      hf.rot += hf.spin * wdt;
      hf.seam = Math.max(0, hf.seam - dt * 2.2);
      if ((hf.vy > 0 && hf.y - hf.r > h + 10) || hf.x < -hf.r * 2 || hf.x > w + hf.r * 2) continue;
      drawHalf(g, hf, dark, s.halves.length > 16 ? 0 : glowBlur * 0.6); // 半块多了就不发光，省显卡
      s.halves[j++] = hf;
    }
    s.halves.length = j;
    // 晶体 / 虚空核 / 金晶
    for (const o of s.objs) {
      g.save();
      g.translate(o.x, o.y);
      if (o.kind === 'void') {
        drawVoid(g, o.r, o.rot, 0.5 + 0.5 * Math.sin(s.rt * 9 + o.phase));
      } else {
        g.rotate(o.rot);
        drawCrystal(g, o.sh, o.r, o.color, o.rot, dark, o.kind === 'gold' ? glowBlur + 10 + 8 * Math.sin(s.rt * 6) : glowBlur);
        if (o.kind === 'gold') {
          // 裂纹：劈了几刀就几道
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2;
          g.beginPath();
          for (let i = 0; i < o.hits; i++) {
            const a = 0.6 + i * 2.1;
            g.moveTo(0, 0);
            g.lineTo(Math.cos(a) * o.r * 0.5, Math.sin(a) * o.r * 0.5);
            g.lineTo(Math.cos(a + 0.4) * o.r * 0.9, Math.sin(a + 0.4) * o.r * 0.9);
          }
          g.stroke();
        }
      }
      g.restore();
    }
    // 碎晶粒子
    for (const p of parts) {
      if (p.life <= 0) continue;
      p.life -= wdt;
      if (p.life <= 0) continue;
      p.vy += 900 * wdt;
      p.vx *= Math.exp(-wdt * 1.5);
      p.x += p.vx * wdt;
      p.y += p.vy * wdt;
      p.rot += p.spin * wdt;
      const a = p.life / p.max;
      g.globalAlpha = a;
      g.fillStyle = p.color;
      if (p.kind === 1) {
        g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      } else {
        const cs = Math.cos(p.rot) * p.size;
        const sn = Math.sin(p.rot) * p.size;
        g.beginPath();
        g.moveTo(p.x + cs, p.y + sn);
        g.lineTo(p.x - sn * 0.6 - cs * 0.5, p.y + cs * 0.6 - sn * 0.5);
        g.lineTo(p.x + sn * 0.6 - cs * 0.5, p.y - cs * 0.6 - sn * 0.5);
        g.closePath();
        g.fill();
      }
    }
    g.globalAlpha = 1;
    // 刀口亮线
    for (const ct of s.cuts) {
      ct.life -= dt * 5;
      if (ct.life <= 0) continue;
      g.globalAlpha = ct.life;
      g.strokeStyle = dark ? '#ffffff' : NEON.blue;
      g.lineWidth = 1 + 3 * ct.life;
      g.beginPath();
      g.moveTo(ct.x1, ct.y1);
      g.lineTo(ct.x2, ct.y2);
      g.stroke();
    }
    g.globalAlpha = 1;
    if (s.cuts.length && s.cuts[0].life <= 0) s.cuts.shift();
    // 刀刃
    if (s.tipOk) {
      let n = 0;
      for (let i = Math.min(tn, TRAIL_N) - 1; i >= 0; i--) {
        const k = at(i);
        if (s.rt - tt[k] > TRAIL_S) continue;
        RX[n] = tx[k];
        RY[n] = ty[k];
        n += 1;
      }
      const bright = clamp(s.speed / threshold(), 0, 1);
      drawRibbon(g, n, bright, dark);
      // 刀尖：一个小亮点，慢的时候也看得到自己指在哪
      g.fillStyle = dark ? '#ffffff' : NEON.blue;
      g.shadowColor = dark ? NEON.cyan : NEON.blue;
      g.shadowBlur = 10;
      g.beginPath();
      g.arc(s.tipX, s.tipY, 3.5 + 2 * bright, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = dark ? 'rgba(102,214,255,0.45)' : 'rgba(47,140,255,0.45)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(s.tipX, s.tipY, 11, 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();

    // 劈中虚空核：画面错位 + 红闪
    if (s.distort > 0.02) {
      const dpr = api.canvas.width / w || 1;
      for (let i = 0; i < 7; i++) {
        const by = rand(0, h);
        const bh = rand(8, 60);
        const off = rand(-1, 1) * 36 * s.distort;
        g.drawImage(api.canvas, 0, by * dpr, w * dpr, bh * dpr, off, by, w, bh);
      }
      s.distort *= Math.exp(-dt * 5);
    } else s.distort = 0;
    if (s.hurt > 0.01) {
      g.fillStyle = `rgba(255,84,112,${(s.hurt * 0.3).toFixed(3)})`;
      g.fillRect(0, 0, w, h);
      s.hurt *= Math.exp(-dt * 4);
    }
    if (s.flash > 0.01) {
      g.fillStyle = dark ? `rgba(160,230,255,${(s.flash * 0.1).toFixed(3)})` : `rgba(255,255,255,${(s.flash * 0.25).toFixed(3)})`;
      g.fillRect(0, 0, w, h);
      s.flash *= Math.exp(-dt * 10);
    }

    // ---- 记分（顶部 90 px 留给记分栏）----
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = c.text;
    g.font = `600 34px ${NUM_FONT}`;
    g.fillText(String(s.score), 32, 140);
    if (s.combo >= 3) {
      g.font = `600 15px ${NUM_FONT}`;
      g.fillStyle = dark ? NEON.mint : '#0f9f6e';
      g.fillText(api.tr(`连击 ×${s.combo}`, `COMBO ×${s.combo}`), 34, 166);
    }
    // 命：三颗小晶
    for (let i = 0; i < LIVES; i++) {
      const x = w - 40 - i * 30;
      const y = 126;
      const alive = i < s.lives;
      g.beginPath();
      g.moveTo(x, y - 11);
      g.lineTo(x + 8, y);
      g.lineTo(x, y + 11);
      g.lineTo(x - 8, y);
      g.closePath();
      if (alive) {
        g.fillStyle = dark ? NEON.cyan : NEON.blue;
        g.shadowColor = g.fillStyle;
        g.shadowBlur = dark ? 12 : 4;
        g.fill();
        g.shadowBlur = 0;
      } else {
        g.strokeStyle = c.text2;
        g.lineWidth = 1.5;
        g.stroke();
      }
    }
    // 弹出的字
    g.textAlign = 'center';
    for (const p of s.pops) {
      p.life -= dt * 0.9;
      if (p.life <= 0) continue;
      p.y -= dt * 40;
      g.globalAlpha = clamp(p.life * 1.6, 0, 1);
      g.font = `700 ${p.size}px ${NUM_FONT}`;
      g.fillStyle = dark ? p.color : ON_LIGHT[p.color] ?? p.color;
      g.shadowColor = p.color;
      g.shadowBlur = dark ? 14 : 0;
      g.fillText(p.text, clamp(p.x, 90, w - 90), Math.max(p.y, TOP + 70));
      g.shadowBlur = 0;
    }
    g.globalAlpha = 1;
    if (s.pops.length && s.pops[0].life <= 0) s.pops.shift();
    // 第几波
    if (s.levelShow > 0) {
      s.levelShow -= dt;
      g.globalAlpha = clamp(s.levelShow, 0, 1);
      g.font = `600 28px ${NUM_FONT}`;
      g.fillStyle = c.text;
      g.fillText(api.tr(`第 ${s.level} 波`, `WAVE ${s.level}`), w / 2, h * 0.3);
      g.globalAlpha = 1;
    }
    // 开局倒计时
    if (!s.started) {
      g.fillStyle = c.text;
      g.font = `600 96px ${NUM_FONT}`;
      g.fillText(String(Math.max(1, Math.ceil(s.countdown))), w / 2, h * 0.46);
      g.font = `500 16px ${UI_FONT}`;
      g.fillStyle = c.text2;
      g.fillText(api.tr('头摆正（或把鼠标放到画面中间）。快速转头划过晶体就能劈开，别碰红色虚空核', 'Face forward (or put the mouse in the middle). Sweep fast through crystals; avoid the red void cores'), w / 2, h * 0.46 + 50);
    }
  }

  /** 背景：深色是夜空般的蓝紫渐变，浅色是淡灰白；一层慢慢漂的三角点阵，底部一道发射口的光 */
  function drawBg(g, w, h, dark, c) {
    if (!bgCache || bgCache.w !== w || bgCache.h !== h || bgCache.dark !== dark) {
      const grad = g.createRadialGradient(w / 2, h * 1.05, 0, w / 2, h * 1.05, Math.max(w, h) * 1.05);
      grad.addColorStop(0, dark ? '#16123a' : '#ffffff');
      grad.addColorStop(0.55, dark ? '#0a0a1c' : '#eef0f7');
      grad.addColorStop(1, c.bg);
      const floor = g.createLinearGradient(0, h - 120, 0, h);
      floor.addColorStop(0, dark ? 'rgba(177,140,255,0)' : 'rgba(47,140,255,0)');
      floor.addColorStop(1, dark ? 'rgba(177,140,255,0.22)' : 'rgba(47,140,255,0.12)');
      bgCache = { w, h, dark, grad, floor };
    }
    g.fillStyle = bgCache.grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = bgCache.floor;
    g.fillRect(0, h - 120, w, 120);
    g.fillStyle = dark ? 'rgba(200,210,255,0.09)' : 'rgba(40,50,110,0.09)';
    const step = 56;
    const ox = (s.rt * 6) % step;
    for (let row = 0, y = TOP; y < h; row++, y += step * 0.866) {
      for (let x = (row % 2 ? step / 2 : 0) - ox; x < w; x += step) g.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  return {
    frame,
    destroy() {
      restoreCursor();
    },
  };
}

// ---------------------------------------------------------------------------
// 大厅卡片上的小图：一颗晶体被一道飘带劈开，两半飞开，再重新长出来

const ICON_HALF = { sh: SHAPES[2], color: NEON.violet, r: 0, x: 0, y: 0, rot: 0, lpx: 0, lpy: 0, lnx: 0, lny: 0, side: 1, seam: 0 };

function isDark() {
  if (typeof document === 'undefined') return true;
  const r = document.documentElement;
  return r.dataset.theme === 'dark' || (!r.dataset.theme && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function drawIcon(canvas, now, focus) {
  const g = canvas.getContext('2d');
  const S = Math.min(canvas.clientWidth, canvas.clientHeight) || 80;
  const dpr = Math.min((typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1, 2);
  if (canvas.width !== Math.round(S * dpr)) canvas.width = canvas.height = Math.round(S * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, S, S);
  const dark = isDark();
  const t = (now / 1000) * (focus ? 1.35 : 1);
  const CYC = 2.2;
  const ph = (t % CYC) / CYC;
  const SW = 0.3; // 飘带扫过的时段
  const CUT = SW * (0.7 / 1.5); // 刀尖经过中心的时刻
  const cx = S / 2;
  const cy = S / 2 + Math.sin(t * 2) * S * 0.02;
  const r = S * 0.21;
  const rot = t * 0.7;
  const blur = dark ? 12 : 6;
  const bx = Math.SQRT1_2; // 刀的方向：左下 → 右上
  const by = -Math.SQRT1_2;
  if (ph < CUT) {
    g.save();
    g.translate(cx, cy);
    g.rotate(rot);
    drawCrystal(g, SHAPES[2], r, NEON.violet, rot, dark, blur);
    g.restore();
  } else {
    const sep = easeOut((ph - CUT) / 0.5) * S * 0.14;
    const fade = ph > 0.78 ? Math.max(0, 1 - (ph - 0.78) / 0.12) : 1;
    const nx = -by;
    const ny = bx;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const hf = ICON_HALF;
    hf.r = r;
    hf.rot = rot + (ph - CUT) * 0.6;
    hf.lpx = 0;
    hf.lpy = 0;
    hf.lnx = nx * cos + ny * sin;
    hf.lny = -nx * sin + ny * cos;
    hf.seam = clamp(1 - (ph - CUT) * 4, 0, 1);
    g.globalAlpha = fade;
    for (const side of [1, -1]) {
      hf.side = side;
      hf.x = cx + nx * side * sep + bx * sep * 0.3;
      hf.y = cy + ny * side * sep + by * sep * 0.3 + sep * sep * 0.02;
      drawHalf(g, hf, dark, blur * 0.6);
    }
    g.globalAlpha = 1;
    if (ph > 0.88) {
      // 重新长出来
      const k = (ph - 0.88) / 0.12;
      g.save();
      g.globalAlpha = k;
      g.translate(cx, cy);
      g.rotate(rot);
      g.scale(0.6 + 0.4 * k, 0.6 + 0.4 * k);
      drawCrystal(g, SHAPES[2], r, NEON.violet, rot, dark, blur);
      g.restore();
    }
  }
  if (ph < SW) {
    const tip = (ph / SW) * 1.5 - 0.2;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const u = Math.max(-0.2, tip - 0.4 * (1 - i / (n - 1)));
      RX[i] = S * (0.08 + 0.84 * u) + Math.sin(u * Math.PI) * S * 0.025;
      RY[i] = S * (0.92 - 0.84 * u) + Math.sin(u * Math.PI) * S * 0.025;
    }
    drawRibbon(g, n, 1, dark, 0.7);
  }
}
