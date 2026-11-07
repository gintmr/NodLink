// 穿墙光缝：霓虹隧道里，一面面光墙迎面飞来，每面墙上开着一道细长的发光缝。你是一把“光刃”：
// 转头移动它，歪头转动它（向左歪头逆时针转）。墙到面前的那一刻，光刃要在缝里、角度也要对上，
// 就能穿过去；对不上就撞墙，3 条命撞完结束。连着穿过有连击加成，位置和角度都几乎正中算 Perfect。
//
// 画面：伪 3D 透视，消失点在屏幕中央（随头轻微视差）。墙是半透明的深色面板，缝是挖空的霓虹（粉 → 紫 → 青）。
// 最近一面墙的缝会在玩家平面上提前画出一道虚线“预影”，好让你提前摆好姿势。
// 难度：前 20 秒很宽松（缝宽、角度小、离中间近）；8～60 秒连续变难：墙更快、更密、缝更窄、角度到 ±35°、
// 位置更偏；30 秒后偶尔有一道缝在飞来的路上慢慢转动或平移；60 秒以后还会再慢慢加速。
// 模拟数据（鼠标代替头）时，歪头用 [ ] 键，← → 键也能微调光刃角度。

import { NEON, clamp, lerp, rand, glow, aimPoint } from './kit.js';

const Z_FAR = 7; // 墙出生的深度（玩家所在平面 z = 1）
const Z_GONE = 0.4; // 穿过以后飞到这里消失
const Z_TUNNEL = 12; // 隧道画到多深
const LIVES = 5;
const MARGIN = 0.08; // 和 aimPoint 的默认边距一致
const DEG = Math.PI / 180;
const ALONG_OK = 0.6; // 沿缝方向的偏差：光刃中心在缝中间 60% 的范围内都算
const PERFECT_PERP = 0.35;
const PERFECT_ANG = 0.4;

export default {
  id: 'slot',
  title: { zh: '穿墙光缝', en: 'Slit Rush' },
  tagline: { zh: '光墙迎面飞来，把光刃穿进那道缝', en: 'Thread your light blade through the slit' },
  how: { zh: '转头移动 · 歪头转角度', en: 'Turn to move · tilt to rotate' },
  accent: NEON.pink,
  icon: drawIcon,
  create,
};

/** 难度：t 是开局后的秒数。d 在 8～60 秒之间从 0 平滑地升到 1，之后 late 再慢慢加一点速 */
function tune(t, o) {
  const x = clamp((t - 10) / 80, 0, 1);
  const d = x * x * (3 - 2 * x);
  const late = clamp((t - 90) / 120, 0, 1);
  o.d = d;
  o.travel = lerp(4.2, 2.1, d) - 0.3 * late; // 墙从出生到撞上玩家的秒数
  o.gap = lerp(2.8, 1.4, d) - 0.2 * late; // 两面墙之间的秒数
  o.halfW = lerp(3.8, 2.1, d) - 0.15 * late; // 缝的半宽（°，按转头角度算）。头部抖动约 1°，太窄靠运气
  o.len = lerp(19, 13, d); // 缝长（°）
  o.angTol = lerp(16, 10, d); // 角度容差（°）
  o.maxAng = lerp(10, 28, d); // 缝的角度范围 ±
  o.maxX = lerp(0.28, 0.8, d); // 缝中心离中间多远（归一化）
  o.maxY = lerp(0.22, 0.7, d);
  o.jump = lerp(0.45, 1.1, d); // 相邻两道缝中心最多差多远
  o.turn = lerp(14, 45, d); // 相邻两道缝角度最多差多少
  o.moving = clamp((t - 50) / 40, 0, 1) * 0.3; // 会动的缝出现的概率
  return o;
}

function create(api) {
  const { input, sound } = api;
  const s = {
    t: 0,
    started: false,
    countdown: 3,
    lives: LIVES,
    score: 0,
    combo: 0,
    maxCombo: 0,
    passed: 0,
    perfects: 0,
    spawned: 0,
    nextSpawn: 0,
    walls: [],
    dist: 0, // 隧道走过的距离（z 单位），网格滚动用
    shake: 0,
    flash: 0,
    pulse: 0, // 光刃穿过时亮一下
    dead: false,
    deadT: 0,
    finished: false,
    trim: 0, // ← → 键的角度微调（模拟数据时用）
    prev: { nx: 0, ny: 0, ang: 0 },
  };
  const T = tune(0, {});
  const P = { x: 0, y: 0, a: 0, hl: 0, hw: 0 }; // 一道缝在玩家平面上的位置（像素，相对屏幕中心）
  const J = { pass: false, perfect: false, perp: 0, along: 0, ang: 0 }; // 判定结果
  const view = { w: 1, h: 1, cx: 0, cy: 0, ox: 0, oy: 0, ppd: 20, ax: 0, ay: 0, roll: 0 };

  // 粒子、飘字、拖尾：预先分配，循环复用
  const parts = Array.from({ length: 260 }, () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, col: '' }));
  let partI = 0;
  const pops = [];
  const TRAIL = 10;
  const trail = Array.from({ length: TRAIL }, () => ({ x: 0, y: 0, a: 0, ok: false }));
  let trailI = 0;
  const streaks = Array.from({ length: 40 }, () => ({ ang: rand(0, Math.PI * 2), rad: rand(0.72, 1), z: rand(1, Z_FAR + 3) }));

  const roll = () => clamp(input.r + s.trim, -60, 60);

  function spawn() {
    tune(s.t, T);
    const n = s.spawned++;
    let nx;
    let ny;
    let ang;
    if (n === 0) {
      nx = 0;
      ny = 0;
      ang = 0;
    } else if (n === 1) {
      nx = (Math.random() < 0.5 ? -1 : 1) * 0.25;
      ny = 0.1;
      ang = 0;
    } else if (n === 2) {
      nx = 0;
      ny = -0.1;
      ang = (Math.random() < 0.5 ? -1 : 1) * 10;
    } else {
      // 离上一道缝不太远（快的时候来得及），但也不原地不动
      const dir = rand(0, Math.PI * 2);
      const r = rand(0.15, T.jump);
      nx = clamp(s.prev.nx + Math.cos(dir) * r, -T.maxX, T.maxX);
      ny = clamp(s.prev.ny + Math.sin(dir) * r * 0.8, -T.maxY, T.maxY);
      ang = clamp(rand(-T.maxAng, T.maxAng), s.prev.ang - T.turn, s.prev.ang + T.turn);
    }
    s.prev.nx = nx;
    s.prev.ny = ny;
    s.prev.ang = ang;
    // 30 秒后：偶尔一道缝在路上转动或平移，到面前时正好停在最终位置
    let dAng = 0;
    let dx = 0;
    let dy = 0;
    if (n > 3 && Math.random() < T.moving) {
      if (Math.random() < 0.55) dAng = (Math.random() < 0.5 ? -1 : 1) * rand(20, 40);
      else {
        const dir = rand(0, Math.PI * 2);
        dx = Math.cos(dir) * 0.4;
        dy = Math.sin(dir) * 0.35;
      }
    }
    s.walls.push({
      z: Z_FAR,
      speed: (Z_FAR - 1) / T.travel,
      nx,
      ny,
      ang,
      dAng,
      dx,
      dy,
      halfW: T.halfW,
      len: T.len,
      angTol: T.angTol,
      d: T.d,
      judged: false,
      ok: false,
    });
  }

  /** 墙飞到哪了（0 = 刚出生，1 = 到玩家面前） */
  const progress = (wall) => clamp((Z_FAR - wall.z) / (Z_FAR - 1), 0, 1);

  /** 这面墙的缝此刻在玩家平面上的位置和角度，写进 P */
  function slitPose(wall) {
    const k = 1 - progress(wall);
    const sx = view.w * (0.5 - MARGIN);
    const sy = view.h * (0.5 - MARGIN);
    P.x = (wall.nx + wall.dx * k) * sx;
    P.y = -(wall.ny + wall.dy * k) * sy;
    P.a = wall.ang + wall.dAng * k;
    P.hl = (wall.len * view.ppd) / 2;
    P.hw = wall.halfW * view.ppd * 0.85; // 画出来的比判定的窄一点，留点余量
    return P;
  }

  /** 现在撞上这面墙会怎样：结果写进 J（perp / along / ang 都按容差归一化，≤ 1 算过） */
  function judge(wall) {
    slitPose(wall);
    const dx = view.ax - P.x;
    const dy = view.ay - P.y;
    const c = Math.cos(P.a * DEG);
    const sn = Math.sin(P.a * DEG);
    J.along = Math.abs(dx * c + dy * sn) / P.hl;
    J.perp = Math.abs(-dx * sn + dy * c) / (wall.halfW * view.ppd);
    J.ang = Math.abs(view.roll - P.a) / wall.angTol;
    J.pass = J.perp <= 1 && J.along <= ALONG_OK && J.ang <= 1;
    J.perfect = J.pass && J.perp <= PERFECT_PERP && J.ang <= PERFECT_ANG;
    return J;
  }

  function burst(x, y, a, hl, n, cols, spread) {
    const c = Math.cos(a * DEG);
    const sn = Math.sin(a * DEG);
    for (let i = 0; i < n; i++) {
      const p = parts[partI];
      partI = (partI + 1) % parts.length;
      const u = rand(-1, 1) * hl;
      p.x = x + c * u;
      p.y = y + sn * u;
      const side = Math.random() < 0.5 ? -1 : 1;
      const sp = rand(80, 420) * spread;
      // 主要往缝的两侧飞，再加一点向外扩散
      p.vx = -sn * side * sp + (p.x - view.cx) * rand(0.5, 1.6);
      p.vy = c * side * sp + (p.y - view.cy) * rand(0.5, 1.6);
      p.life = rand(0.6, 1);
      p.col = cols[i % cols.length];
    }
  }

  function pop(text, x, y, color, size) {
    if (pops.length > 12) pops.shift();
    pops.push({ text, x, y, color, size, life: 1 });
  }

  function hit(wall) {
    judge(wall);
    wall.judged = true;
    wall.ok = J.pass;
    const bx = view.cx + view.ax;
    const by = view.cy + view.ay;
    if (J.pass) {
      s.combo += 1;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      s.passed += 1;
      const mult = 1 + Math.min(s.combo - 1, 15) * 0.2;
      let pts = Math.round((100 + 100 * wall.d) * mult);
      if (J.perfect) {
        s.perfects += 1;
        pts += Math.round(150 * mult);
      }
      s.score += pts;
      api.setScore(s.score);
      sound.noise(0.28, { vol: 0.22, freq: 700 + Math.min(s.combo, 12) * 90, q: 0.6 });
      sound.good(s.combo);
      s.pulse = 1;
      burst(bx, by, view.roll, P.hl * 0.8, J.perfect ? 48 : 30, [NEON.pink, NEON.violet, NEON.cyan, '#ffffff'], 1);
      pop(`+${pts}`, bx, by - 34, J.perfect ? NEON.cyan : NEON.pink, 22);
      if (J.perfect) {
        s.flash = 0.6;
        pop('PERFECT', bx, by - 66, NEON.mint, 26);
        sound.tone(1760, 0.14, { type: 'triangle', vol: 0.1, when: 0.07 });
      }
    } else {
      s.lives -= 1;
      s.combo = 0;
      s.shake = 22;
      s.flash = -1;
      sound.bad();
      sound.noise(0.35, { vol: 0.4, freq: 260, q: 0.9 });
      burst(bx, by, view.roll, P.hl * 0.8, 40, [NEON.red, NEON.amber, '#ffffff'], 0.7);
      // 告诉玩家差在哪
      const why = J.ang > 1 ? api.tr('角度不对', 'Wrong angle') : api.tr('偏了', 'Off target');
      pop(why, bx, by - 40, NEON.red, 22);
      if (s.lives <= 0) {
        s.dead = true;
        s.deadT = 0;
      }
    }
  }

  function frame(dt) {
    const { g, w, h } = api;
    const dark = api.dark;
    const c = api.colors;
    // ---- 视图参数 ----
    view.w = w;
    view.h = h;
    view.cx = w / 2;
    view.cy = h / 2;
    view.ppd = ((w * (0.5 - MARGIN)) / input.rangeH + (h * (0.5 - MARGIN)) / input.rangeV) / 2;
    const aim = aimPoint(input, w, h, MARGIN);
    view.ax = aim.x - view.cx;
    view.ay = aim.y - view.cy;
    view.roll = roll();
    // 视差：消失点跟着头稍微挪一点，像从窗口往隧道里看
    view.ox = view.ax * 0.12;
    view.oy = view.ay * 0.12;

    // ---- 逻辑 ----
    if (!s.started) {
      s.countdown -= dt;
      if (Math.ceil(s.countdown) !== Math.ceil(s.countdown + dt)) sound.tick(s.countdown <= 0);
      if (s.countdown <= 0) {
        s.started = true;
        input.rearm(); // 正前方由大厅开局前的“对准中心”定，这里只清手势
        s.trim = 0;
      }
    }
    tune(s.t, T);
    const tunnelSpeed = s.started ? (Z_FAR - 1) / T.travel : 1.2;
    s.dist += tunnelSpeed * dt;
    if (s.started) {
      if (!s.dead) {
        s.t += dt;
        s.nextSpawn -= dt;
        if (s.nextSpawn <= 0) {
          spawn();
          s.nextSpawn += T.gap;
        }
      } else {
        s.deadT += dt;
        if (s.deadT > 1.1 && !s.finished) {
          s.finished = true;
          api.finish({
            score: s.score,
            stats: api.tr(`穿过 ${s.passed} 面 · Perfect ${s.perfects} · 最长连击 ${s.maxCombo}`, `${s.passed} walls · ${s.perfects} perfect · best combo ${s.maxCombo}`),
          });
        }
      }
      for (const wall of s.walls) {
        wall.z -= wall.speed * dt;
        if (!wall.judged && wall.z <= 1) {
          if (s.dead) wall.judged = true;
          else hit(wall);
        }
      }
      // 飞过去的墙删掉（原地压缩，不新建数组）
      let k = 0;
      for (const wall of s.walls) if (wall.z > Z_GONE) s.walls[k++] = wall;
      s.walls.length = k;
    }
    // 最近的一面还没判定的墙：用来画预影、光刃对没对上
    let next = null;
    let next2 = null;
    for (const wall of s.walls) {
      if (wall.judged) continue;
      if (!next) next = wall;
      else if (!next2) next2 = wall;
    }
    const aligned = next ? judge(next).pass : false;
    // 光刃长度：跟着下一道缝的长度（没有墙时用当前难度）
    const bladeHl = (next ? next.len : T.len) * view.ppd * 0.5 * 0.82;

    // ---- 画 ----
    g.save();
    if (s.shake > 0.3) {
      g.translate(rand(-1, 1) * s.shake, rand(-1, 1) * s.shake);
      s.shake *= Math.exp(-dt * 9);
    } else s.shake = 0;
    const vx = view.cx + view.ox;
    const vy = view.cy + view.oy;
    const bg = g.createRadialGradient(vx, vy, 0, vx, vy, Math.max(w, h) * 0.75);
    bg.addColorStop(0, dark ? '#1a0d26' : '#fbeef7');
    bg.addColorStop(0.55, dark ? '#0b0712' : '#f1eef8');
    bg.addColorStop(1, c.bg);
    g.fillStyle = bg;
    g.fillRect(-40, -40, w + 80, h + 80);
    drawTunnel(g, dark, dt, tunnelSpeed);

    // 墙：远的先画；已经过了玩家平面的放到光刃后面再画
    for (let i = s.walls.length - 1; i >= 0; i--) if (s.walls[i].z >= 1) drawWall(g, s.walls[i], dark);
    if (next) drawGhost(g, next, 1, aligned);
    if (next2) drawGhost(g, next2, 0.3, false);
    drawBlade(g, dt, bladeHl, aligned);
    for (let i = s.walls.length - 1; i >= 0; i--) if (s.walls[i].z < 1) drawWall(g, s.walls[i], dark);
    drawParticles(g, dt);
    g.restore();

    // 闪光：Perfect 粉青，撞墙红
    if (s.flash) {
      g.fillStyle = s.flash > 0 ? `rgba(255,124,186,${s.flash * 0.16})` : `rgba(255,84,112,${-s.flash * 0.3})`;
      g.fillRect(0, 0, w, h);
      s.flash = s.flash > 0 ? Math.max(0, s.flash - dt * 2.5) : Math.min(0, s.flash + dt * 2);
    }
    drawPops(g, dt);
    drawHud(g, c);
  }

  // ---------- 画各部分 ----------

  /** 透视：玩家平面上的点 (X, Y)（相对中心的像素）放到深度 z 时在屏幕上的位置 */
  const px = (X, z) => view.cx + view.ox + (X - view.ox) / z;
  const py = (Y, z) => view.cy + view.oy + (Y - view.oy) / z;

  function drawTunnel(g, dark, dt, speed) {
    const { w, h } = view;
    const hw = w / 2;
    const hh = h / 2;
    const rgb = dark ? '177,140,255' : '120,80,200';
    // 横向的框：一圈圈朝镜头滚过来
    const frac = s.dist % 1;
    g.lineWidth = 1;
    for (let k = 0; k < Z_TUNNEL; k++) {
      const z = 1 + k + (1 - frac);
      if (z > Z_TUNNEL) break;
      const a = (1 - (z - 1) / (Z_TUNNEL - 1)) * (dark ? 0.42 : 0.32);
      g.strokeStyle = `rgba(${rgb},${a})`;
      const x0 = px(-hw, z);
      const y0 = py(-hh, z);
      g.strokeRect(x0, y0, px(hw, z) - x0, py(hh, z) - y0);
    }
    // 纵向的线：四个面上各几条，汇向消失点
    g.strokeStyle = `rgba(${rgb},${dark ? 0.16 : 0.13})`;
    g.beginPath();
    for (let i = 0; i <= 8; i++) {
      const f = i / 8 - 0.5;
      const X = f * w;
      const Y = f * h;
      g.moveTo(px(X, 1), py(-hh, 1));
      g.lineTo(px(X, Z_TUNNEL), py(-hh, Z_TUNNEL));
      g.moveTo(px(X, 1), py(hh, 1));
      g.lineTo(px(X, Z_TUNNEL), py(hh, Z_TUNNEL));
      g.moveTo(px(-hw, 1), py(Y, 1));
      g.lineTo(px(-hw, Z_TUNNEL), py(Y, Z_TUNNEL));
      g.moveTo(px(hw, 1), py(Y, 1));
      g.lineTo(px(hw, Z_TUNNEL), py(Y, Z_TUNNEL));
    }
    g.stroke();
    // 速度线：贴着隧道壁往后掠
    const sp = speed * 1.6;
    g.lineWidth = 1.5;
    g.strokeStyle = dark ? 'rgba(235,225,255,0.5)' : 'rgba(110,70,190,0.35)';
    g.beginPath();
    for (const st of streaks) {
      st.z -= sp * dt;
      if (st.z < 0.7) {
        st.z = Z_FAR + rand(0, 3);
        st.ang = rand(0, Math.PI * 2);
        st.rad = rand(0.72, 1);
      }
      const X = Math.cos(st.ang) * st.rad * hw;
      const Y = Math.sin(st.ang) * st.rad * hh;
      const tail = st.z + 0.25 + speed * 0.06;
      g.moveTo(px(X, st.z), py(Y, st.z));
      g.lineTo(px(X, tail), py(Y, tail));
    }
    g.stroke();
  }

  function drawWall(g, wall, dark) {
    const z = wall.z;
    const iz = 1 / z;
    const aIn = clamp((Z_FAR - z) / 1.2, 0, 1);
    const aOut = z < 1 ? clamp((z - Z_GONE) / (1 - Z_GONE), 0, 1) : 1;
    const alpha = aIn * aOut;
    if (alpha <= 0.01) return;
    slitPose(wall);
    const { w, h } = view;
    const crashed = wall.judged && !wall.ok;
    g.save();
    g.globalAlpha = alpha;
    // 世界坐标：玩家平面的像素，按深度缩放到消失点
    g.translate(view.cx + view.ox, view.cy + view.oy);
    g.scale(iz, iz);
    g.translate(-view.ox, -view.oy);
    // 面板（挖掉缝）
    g.beginPath();
    g.rect(-w / 2, -h / 2, w, h);
    g.save();
    g.translate(P.x, P.y);
    g.rotate(P.a * DEG);
    g.rect(-P.hl, -P.hw, P.hl * 2, P.hw * 2);
    g.restore();
    g.fillStyle = crashed ? 'rgba(110,14,40,0.72)' : dark ? 'rgba(26,12,44,0.74)' : 'rgba(44,26,80,0.6)';
    g.fill('evenodd');
    g.lineWidth = z + 2;
    g.strokeStyle = crashed ? 'rgba(255,84,112,0.7)' : 'rgba(177,140,255,0.55)';
    g.strokeRect(-w / 2, -h / 2, w, h);
    // 缝：霓虹描边 + 里面一层淡光
    g.translate(P.x, P.y);
    g.rotate(P.a * DEG);
    const grad = g.createLinearGradient(-P.hl, 0, P.hl, 0);
    if (crashed) {
      grad.addColorStop(0, NEON.red);
      grad.addColorStop(1, NEON.amber);
    } else {
      grad.addColorStop(0, NEON.pink);
      grad.addColorStop(0.5, NEON.violet);
      grad.addColorStop(1, NEON.cyan);
    }
    g.fillStyle = crashed ? 'rgba(255,84,112,0.12)' : 'rgba(255,124,186,0.12)';
    g.fillRect(-P.hl, -P.hw, P.hl * 2, P.hw * 2);
    glow(g, crashed ? NEON.red : NEON.pink, clamp(28 * iz, 4, 40), () => {
      g.strokeStyle = grad;
      g.lineWidth = 2 + 2.5 * z;
      g.beginPath();
      g.roundRect(-P.hl, -P.hw, P.hl * 2, P.hw * 2, Math.min(P.hw, 10));
      g.stroke();
    });
    g.restore();
  }

  /** 预影：下一道缝在玩家平面上的位置（虚线），对上了填一层薄荷绿 */
  function drawGhost(g, wall, weight, aligned) {
    slitPose(wall);
    const p = progress(wall);
    const a = lerp(0.15, 0.85, p) * weight;
    g.save();
    g.translate(view.cx + P.x, view.cy + P.y);
    g.rotate(P.a * DEG);
    if (aligned) {
      g.fillStyle = `rgba(122,240,196,${0.1 + 0.12 * p})`;
      g.fillRect(-P.hl, -P.hw, P.hl * 2, P.hw * 2);
    }
    g.setLineDash([10, 8]);
    g.lineDashOffset = -s.dist * 30;
    g.lineWidth = 1.5;
    g.strokeStyle = aligned ? `rgba(122,240,196,${a})` : `rgba(255,124,186,${a})`;
    g.strokeRect(-P.hl, -P.hw, P.hl * 2, P.hw * 2);
    g.setLineDash([]);
    // 中线：缝的方向
    g.globalAlpha = a * 0.6;
    g.beginPath();
    g.moveTo(-P.hl * 0.3, 0);
    g.lineTo(P.hl * 0.3, 0);
    g.stroke();
    g.restore();
  }

  function drawBlade(g, dt, hl, aligned) {
    const x = view.cx + view.ax;
    const y = view.cy + view.ay;
    // 拖尾
    const t0 = trail[trailI];
    t0.x = x;
    t0.y = y;
    t0.a = view.roll;
    t0.ok = true;
    trailI = (trailI + 1) % TRAIL;
    g.lineCap = 'round';
    for (let i = 1; i < TRAIL; i++) {
      const tr = trail[(trailI + i) % TRAIL];
      if (!tr.ok) continue;
      const a = (i / TRAIL) * 0.22;
      const c = Math.cos(tr.a * DEG) * hl;
      const sn = Math.sin(tr.a * DEG) * hl;
      g.strokeStyle = `rgba(177,140,255,${a})`;
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(tr.x - c, tr.y - sn);
      g.lineTo(tr.x + c, tr.y + sn);
      g.stroke();
    }
    // 光刃本体
    g.save();
    g.translate(x, y);
    g.rotate(view.roll * DEG);
    const pulse = s.pulse;
    s.pulse = Math.max(0, s.pulse - dt * 3);
    const thick = 7 + pulse * 5;
    const grad = g.createLinearGradient(-hl, 0, hl, 0);
    if (aligned) {
      grad.addColorStop(0, NEON.cyan);
      grad.addColorStop(0.5, NEON.mint);
      grad.addColorStop(1, NEON.cyan);
    } else {
      grad.addColorStop(0, NEON.pink);
      grad.addColorStop(0.5, NEON.violet);
      grad.addColorStop(1, NEON.cyan);
    }
    glow(g, aligned ? NEON.mint : NEON.pink, 22 + pulse * 20, () => {
      g.strokeStyle = grad;
      g.lineWidth = thick;
      g.beginPath();
      g.moveTo(-hl, 0);
      g.lineTo(hl, 0);
      g.stroke();
    });
    // 白色内芯
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = Math.max(1.5, thick * 0.3);
    g.beginPath();
    g.moveTo(-hl * 0.92, 0);
    g.lineTo(hl * 0.92, 0);
    g.stroke();
    // 中心点：位置判定看的是它
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(0, 0, 3.5, 0, Math.PI * 2);
    g.fill();
    g.restore();
    g.lineCap = 'butt';
  }

  function drawParticles(g, dt) {
    const drag = Math.exp(-dt * 2.5);
    for (const p of parts) {
      if (p.life <= 0) continue;
      p.life -= dt * 1.5;
      if (p.life <= 0) continue;
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      g.globalAlpha = p.life;
      g.fillStyle = p.col;
      const r = 1.5 + p.life * 2.5;
      g.fillRect(p.x - r / 2, p.y - r / 2, r, r);
    }
    g.globalAlpha = 1;
  }

  function drawPops(g, dt) {
    g.textAlign = 'center';
    let k = 0;
    for (const p of pops) {
      p.life -= dt * 1.2;
      if (p.life <= 0) continue;
      pops[k++] = p;
      p.y -= dt * 40;
      const grow = 1 + (1 - Math.min(1, (1 - p.life) * 6)) * 0.5; // 先大后小，“弹”一下
      g.globalAlpha = Math.min(1, p.life * 1.6);
      g.font = `700 ${Math.round(p.size * grow)}px "Unbounded Variable", sans-serif`;
      g.fillStyle = p.color;
      glow(g, p.color, 14, () => g.fillText(p.text, p.x, p.y));
    }
    pops.length = k;
    g.globalAlpha = 1;
  }

  function drawHud(g, c) {
    const { w, h } = view;
    // 命：三道小光缝
    for (let i = 0; i < LIVES; i++) {
      const on = i < s.lives;
      const x = 28 + i * 40;
      g.fillStyle = on ? NEON.pink : c.line;
      if (on) glow(g, NEON.pink, 10, () => g.fillRect(x, 112, 28, 6));
      else g.fillRect(x, 112, 28, 6);
    }
    g.textAlign = 'left';
    g.font = '500 12px -apple-system, "PingFang SC", sans-serif';
    g.fillStyle = c.text2;
    g.fillText(api.tr('生命', 'LIVES'), 28, 138);
    // 速度
    g.textAlign = 'right';
    g.font = '600 22px "Unbounded Variable", sans-serif';
    g.fillStyle = c.text;
    const speed = s.started ? 3.4 / T.travel : 1;
    g.fillText(`${speed.toFixed(1)}×`, w - 28, 122);
    g.font = '500 12px -apple-system, "PingFang SC", sans-serif';
    g.fillStyle = c.text2;
    g.fillText(api.tr('速度', 'SPEED'), w - 28, 140);
    // 连击
    g.textAlign = 'center';
    if (s.combo > 1) {
      const m = 1 + Math.min(s.combo - 1, 15) * 0.2;
      g.font = '700 26px "Unbounded Variable", sans-serif';
      g.fillStyle = NEON.cyan;
      glow(g, NEON.cyan, 12, () => g.fillText(`${s.combo} ${api.tr('连击', 'COMBO')}`, w / 2, 124));
      g.font = '600 13px "Unbounded Variable", sans-serif';
      g.fillStyle = c.text2;
      g.fillText(`×${m.toFixed(1)}`, w / 2, 146);
    }
    // 开局倒计时 + 说明
    if (!s.started) {
      g.font = '600 96px "Unbounded Variable", sans-serif';
      g.fillStyle = c.text;
      g.fillText(String(Math.max(1, Math.ceil(s.countdown))), w / 2, h / 2 - 90);
      g.font = '500 16px -apple-system, "PingFang SC", sans-serif';
      g.fillStyle = c.text2;
      g.fillText(api.tr('头摆正。转头移动光刃，歪头转动它，穿过墙上的光缝', 'Face forward. Turn to move the blade, tilt to rotate it, fly it through the slit'), w / 2, h / 2 + 100);
      g.font = '500 13px -apple-system, "PingFang SC", sans-serif';
      g.fillText(api.tr('模拟数据：鼠标移动，[ ] 或 ← → 键转角度', 'Simulated: mouse to move, [ ] or ← → to rotate'), w / 2, h / 2 + 126);
    } else if (s.t < 6 && !s.dead) {
      g.font = '500 14px -apple-system, "PingFang SC", sans-serif';
      g.fillStyle = c.text2;
      g.globalAlpha = clamp(6 - s.t, 0, 1);
      g.fillText(api.tr('虚线框是下一道缝的位置：变绿就是对上了', 'The dashed outline is the next slit: it turns green when you line up'), w / 2, h - 40);
      g.globalAlpha = 1;
    }
  }

  // 模拟数据时 [ ] 只能给固定的歪头角度，← → 键可以连续微调
  function key(e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      s.trim = clamp(s.trim + (e.key === 'ArrowLeft' ? -4 : 4), -40, 40);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      s.trim = 0;
    }
  }

  return {
    frame,
    key,
    destroy() {
      s.walls.length = 0;
      pops.length = 0;
    },
  };
}

/** 大厅卡片上的小图：隧道里一面墙飞来，光刃转过去对准缝 */
function drawIcon(canvas, now, focus) {
  const g = canvas.getContext('2d');
  const size = Math.min(canvas.clientWidth, canvas.clientHeight) || 80;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = canvas.height = Math.round(size * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  const c = size / 2;
  const t = (now / 1000) * (focus ? 1.5 : 0.8);
  const half = size * 0.46;
  // 隧道框
  g.lineWidth = 1;
  for (let k = 0; k < 6; k++) {
    const z = 1 + k + (1 - (t % 1));
    const r = half / z;
    g.strokeStyle = `rgba(255,124,186,${0.4 * (1 - (z - 1) / 6)})`;
    g.strokeRect(c - r, c - r, r * 2, r * 2);
  }
  // 一面墙飞来：每一轮换一个角度
  const cycle = Math.floor(t * 0.6);
  const p = (t * 0.6) % 1;
  const ang = [-25, 18, 0, 30, -12][cycle % 5];
  const z = lerp(5, 0.9, p * p);
  const r = half / z;
  const sl = (half * 0.7) / z;
  const sw = (half * 0.08) / z;
  g.save();
  g.globalAlpha = p > 0.92 ? (1 - p) / 0.08 : Math.min(1, p * 4);
  g.translate(c, c);
  g.beginPath();
  g.rect(-r, -r, r * 2, r * 2);
  g.rotate(ang * DEG);
  g.rect(-sl, -sw, sl * 2, sw * 2);
  g.fillStyle = 'rgba(40,20,64,0.55)';
  g.fill('evenodd');
  g.shadowColor = NEON.pink;
  g.shadowBlur = 8;
  g.strokeStyle = NEON.pink;
  g.lineWidth = 1.5;
  g.strokeRect(-sl, -sw, sl * 2, sw * 2);
  g.restore();
  // 光刃：转过去对准
  const bladeAng = lerp(0, ang, Math.min(1, p * 1.6));
  g.save();
  g.translate(c, c);
  g.rotate(bladeAng * DEG);
  g.shadowColor = NEON.cyan;
  g.shadowBlur = 10;
  g.strokeStyle = NEON.cyan;
  g.lineWidth = 3;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(-half * 0.55, 0);
  g.lineTo(half * 0.55, 0);
  g.stroke();
  g.restore();
}
