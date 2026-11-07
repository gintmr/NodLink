// 声纳猎手：空间里藏着一个看不见的目标，它一直在“嘀”。声音用 HRTF 钉在空间里，戴着 AirPods 转头，
// 声音就停在原来的方向——跟着声音转过去：越对准，嘀得越快、越高（像盖革计数器）；对准了点一下头就是锁定。
// 连着锁中有连击加成，60 秒一局。闭着眼也能玩，所以对视障用户同样友好。
//
// 画面：一扇黑色的“声纳窗”，中间是你的准星。每次嘀的时候目标位置泛起一圈涟漪——只有它在你面前时才看得见，
// 大部分时候要靠耳朵找。4 秒还没找到，屏幕边上才出现一个指示箭头。
// 难度：锁定半径从 8° 收到 4°，目标越来越远；20 秒后偶尔混进一个“嗡嗡”的假目标，点错扣分。

import { NEON, clamp, lerp, rand, wrap, glow } from './kit.js';

const ROUND_S = 60;
const VIEW_DEG = 96; // 画面横向对应的视角（越大准星越小、看到的空间越多）

export default {
  id: 'sonar',
  title: { zh: '声纳猎手', en: 'Sonar Hunter' },
  tagline: { zh: '戴上耳机，跟着声音转头，点头锁定', en: 'Turn toward the ping, nod to lock' },
  how: { zh: '转头找声音 · 点头锁定', en: 'Turn to find · nod to lock' },
  accent: NEON.cyan,
  range: { h: 70, v: 30 }, // 模拟数据时鼠标代表的角度范围
  icon: drawIcon,
  create,
};

function create(api) {
  const { input, sound } = api;
  const s = {
    t: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    found: 0,
    times: [],
    target: null,
    decoy: null,
    ripples: [],
    arcs: [],
    sparks: [],
    flash: 0,
    started: false,
    countdown: 3,
  };
  const stars = Array.from({ length: 140 }, () => ({ yaw: rand(-180, 180), pitch: rand(-40, 60), r: rand(0.5, 1.6), a: rand(0.2, 0.7) }));
  const src = sound.source();
  const decoySrc = sound.source();
  const lockRadius = () => lerp(12, 7, clamp(s.found / 25, 0, 1)); // 头部指向本来就有几度误差，别要求太准

  function spawn() {
    const far = clamp(s.found / 12, 0, 1);
    const yaw = (Math.random() < 0.5 ? -1 : 1) * rand(lerp(20, 35, far), lerp(45, 75, far));
    const pitch = rand(-8, lerp(10, 22, far));
    s.target = { yaw: wrap(input.h + yaw), pitch, born: s.t, nextPing: 0 };
    src.set(...dir(s.target.yaw, s.target.pitch, 2));
    s.decoy = s.t > 30 && Math.random() < 0.25 ? { yaw: wrap(s.target.yaw + (Math.random() < 0.5 ? -1 : 1) * rand(35, 70)), pitch: rand(-5, 15), nextPing: 0.3 } : null;
    if (s.decoy) decoySrc.set(...dir(s.decoy.yaw, s.decoy.pitch, 2));
  }

  const offTilt = input.on('nod', (e) => {
    if (e.dir !== 'down' || !s.started || s.t >= ROUND_S) return;
    const aim = { yaw: e.h ?? input.h, pitch: e.v ?? input.v }; // 点头前指着的地方，不是点到底的地方
    if (s.decoy && angDist(aim, s.decoy) < lockRadius() + 2) {
      s.score = Math.max(0, s.score - 150);
      s.combo = 0;
      sound.bad();
      s.flash = -1;
      s.decoy = null;
      api.setScore(s.score);
      return;
    }
    if (!s.target) return;
    const d = angDist(aim, s.target);
    if (d <= lockRadius()) {
      const took = s.t - s.target.born;
      s.times.push(took);
      s.combo += 1;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      s.found += 1;
      const speed = Math.round(clamp(6 - took, 0, 6) * 40);
      s.score += Math.round((100 + speed) * (1 + Math.min(s.combo - 1, 8) * 0.25));
      api.setScore(s.score);
      sound.good(s.combo);
      s.flash = 1;
      burst(s.target);
      spawn();
    } else {
      s.combo = 0;
      sound.tone(300, 0.08, { type: 'square', vol: 0.06 });
    }
  });

  function burst(t) {
    for (let i = 0; i < 26; i++) s.sparks.push({ yaw: t.yaw, pitch: t.pitch, vx: rand(-40, 40), vy: rand(-30, 40), life: 1 });
  }

  function ping(t, decoy) {
    const d = angDist({ yaw: input.h, pitch: input.v }, t);
    const out = decoy ? decoySrc.node : src.node;
    if (decoy) {
      // 假目标：低沉的嗡声，节奏不变
      sound.tone(170, 0.18, { type: 'sawtooth', vol: 0.12, out });
      t.nextPing = s.t + 0.8;
    } else {
      // 越近越快、越高；仰角高的音也高一点（耳朵能分辨上下）
      const close = 1 - clamp(d / 90, 0, 1);
      sound.tone(620 + close * 520 + t.pitch * 6, 0.07, { type: 'sine', vol: 0.5, out });
      if (d <= lockRadius()) sound.tone(1560, 0.05, { type: 'triangle', vol: 0.18, out, when: 0.04 });
      t.nextPing = s.t + lerp(0.85, 0.12, close ** 1.6);
    }
    s.ripples.push({ yaw: t.yaw, pitch: t.pitch, life: 1, decoy });
    // 准星边上的“回声弧”：只指个大概方向（±30°），还得转头去找；没有空间音频（比如外放）时也能玩
    if (!decoy) s.arcs.push({ yaw: t.yaw, pitch: t.pitch, life: 1 });
  }

  function frame(dt) {
    const { g, w, h } = api;
    const c = api.colors;
    // 开局倒计时：先把头摆正
    if (!s.started) {
      s.countdown -= dt;
      if (Math.ceil(s.countdown) !== Math.ceil(s.countdown + dt)) sound.tick(s.countdown <= 0);
      if (s.countdown <= 0) {
        s.started = true;
        input.rearm(); // 正前方由大厅开局前的“对准中心”定，这里只清手势
        spawn();
      }
    } else if (s.t < ROUND_S) {
      s.t += dt;
      if (s.target && s.t >= s.target.nextPing) ping(s.target, false);
      if (s.decoy && s.t >= s.decoy.nextPing) ping(s.decoy, true);
      if (s.t >= ROUND_S) {
        const avg = s.times.length ? s.times.reduce((a, b) => a + b, 0) / s.times.length : 0;
        api.finish({ score: s.score, stats: api.tr(`找到 ${s.found} 个 · 平均 ${avg.toFixed(1)} 秒 · 最长连击 ${s.maxCombo}`, `${s.found} found · ${avg.toFixed(1)} s avg · best combo ${s.maxCombo}`) });
      }
    }
    sound.setListener(input.h, input.v);

    // ---- 画 ----
    const ppd = w / VIEW_DEG;
    const toScreen = (yaw, pitch) => ({ x: w / 2 + wrap(yaw - input.h) * ppd, y: h / 2 - (pitch - input.v) * ppd });
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    grad.addColorStop(0, api.dark ? '#0b1020' : '#e9eef8');
    grad.addColorStop(1, c.bg);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    // 星点：固定在空间里，转头时整片移动，看得出自己在转
    for (const st of stars) {
      const p = toScreen(st.yaw, st.pitch);
      if (p.x < -10 || p.x > w + 10 || p.y < -10 || p.y > h + 10) continue;
      g.fillStyle = api.dark ? `rgba(200,220,255,${st.a})` : `rgba(40,60,110,${st.a * 0.5})`;
      g.beginPath();
      g.arc(p.x, p.y, st.r, 0, Math.PI * 2);
      g.fill();
    }
    // 经纬网：围着你的一个球面，每 15° 一条经线、每 10° 一条纬线，转头时整片滑过去，看得出空间感
    g.lineWidth = 1;
    for (let lon = -180; lon < 180; lon += 15) {
      const x = toScreen(lon, 0).x;
      if (x < -2 || x > w + 2) continue;
      g.strokeStyle = lon % 90 === 0 ? (api.dark ? 'rgba(102,214,255,0.16)' : 'rgba(30,90,160,0.16)') : c.line;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let lat = -40; lat <= 60; lat += 10) {
      const y = toScreen(0, lat).y;
      if (y < -2 || y > h + 2) continue;
      g.strokeStyle = lat === 0 ? (api.dark ? 'rgba(102,214,255,0.22)' : 'rgba(30,90,160,0.2)') : c.line;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    // 涟漪
    for (const r of s.ripples) {
      r.life -= dt * 0.9;
      const p = toScreen(r.yaw, r.pitch);
      const rad = (1 - r.life) * 90 + 6;
      g.strokeStyle = r.decoy ? `rgba(255,120,80,${r.life * 0.7})` : `rgba(102,214,255,${r.life * 0.9})`;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(p.x, p.y, rad, 0, Math.PI * 2);
      g.stroke();
    }
    s.ripples = s.ripples.filter((r) => r.life > 0);
    // 火花
    for (const sp of s.sparks) {
      sp.life -= dt * 1.4;
      sp.yaw += sp.vx * dt * 0.25;
      sp.pitch += sp.vy * dt * 0.25;
      const p = toScreen(sp.yaw, sp.pitch);
      g.fillStyle = `rgba(255,255,255,${sp.life})`;
      g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    s.sparks = s.sparks.filter((sp) => sp.life > 0);
    // 锁定范围内：目标显形
    const lr = lockRadius();
    if (s.target && s.started) {
      const d = angDist({ yaw: input.h, pitch: input.v }, s.target);
      const p = toScreen(s.target.yaw, s.target.pitch);
      if (d < lr * 2.2) {
        const a = clamp(1 - (d - lr) / (lr * 1.2), 0.15, 1);
        glow(g, NEON.cyan, 24, () => {
          g.fillStyle = `rgba(102,214,255,${a})`;
          g.beginPath();
          g.arc(p.x, p.y, 7 + (d <= lr ? 3 * Math.sin(s.t * 20) : 0), 0, Math.PI * 2);
          g.fill();
        });
      }
      // 4 秒还没找到：屏幕边上出现一个箭头
      if (s.t - s.target.born > 4 && (p.x < 0 || p.x > w || p.y < 0 || p.y > h)) {
        const ang = Math.atan2(p.y - h / 2, p.x - w / 2);
        const ex = w / 2 + Math.cos(ang) * (Math.min(w, h) / 2 - 40);
        const ey = h / 2 + Math.sin(ang) * (Math.min(w, h) / 2 - 40);
        g.save();
        g.translate(ex, ey);
        g.rotate(ang);
        g.fillStyle = `rgba(102,214,255,${0.4 + 0.3 * Math.sin(s.t * 6)})`;
        g.beginPath();
        g.moveTo(14, 0);
        g.lineTo(-8, -10);
        g.lineTo(-8, 10);
        g.closePath();
        g.fill();
        g.restore();
      }
    }
    // 准星：锁定范围画成一圈，对准了变亮
    const ringR = lr * ppd;
    // 回声弧：每次嘀，准星外圈朝声音的大致方向亮一段
    for (const a of s.arcs) {
      a.life -= dt * 1.6;
      const ang = Math.atan2(-(a.pitch - input.v), wrap(a.yaw - input.h));
      const R = ringR + 22;
      glow(g, NEON.cyan, 16, () => {
        g.strokeStyle = `rgba(102,214,255,${Math.max(a.life, 0) * 0.85})`;
        g.lineWidth = 5;
        g.lineCap = 'round';
        g.beginPath();
        g.arc(w / 2, h / 2, R + (1 - a.life) * 18, ang - 0.5, ang + 0.5);
        g.stroke();
      });
    }
    s.arcs = s.arcs.filter((a) => a.life > 0);
    const onTarget = s.target && angDist({ yaw: input.h, pitch: input.v }, s.target) <= lr;
    g.strokeStyle = onTarget ? NEON.cyan : c.text2;
    g.lineWidth = onTarget ? 2.5 : 1.5;
    g.beginPath();
    g.arc(w / 2, h / 2, ringR, 0, Math.PI * 2);
    g.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.beginPath();
      g.moveTo(w / 2 + dx * (ringR + 6), h / 2 + dy * (ringR + 6));
      g.lineTo(w / 2 + dx * (ringR + 16), h / 2 + dy * (ringR + 16));
      g.stroke();
    }
    // 命中闪光 / 点错闪红
    if (s.flash) {
      g.fillStyle = s.flash > 0 ? `rgba(102,214,255,${s.flash * 0.18})` : `rgba(255,84,112,${-s.flash * 0.22})`;
      g.fillRect(0, 0, w, h);
      s.flash = s.flash > 0 ? Math.max(0, s.flash - dt * 3) : Math.min(0, s.flash + dt * 3);
    }
    // 顶部：剩余时间和连击；开局倒计时
    g.textAlign = 'center';
    g.fillStyle = c.text;
    if (!s.started) {
      g.font = '600 96px "Unbounded Variable", sans-serif';
      g.fillText(String(Math.max(1, Math.ceil(s.countdown))), w / 2, h / 2 - ringR - 60);
      g.font = '500 16px -apple-system, "PingFang SC", sans-serif';
      g.fillStyle = c.text2;
      g.fillText(api.tr('戴好耳机，头摆正。目标会在你身边某处发出“嘀”声', 'Put on your AirPods and face forward. A ping will sound somewhere around you'), w / 2, h / 2 + ringR + 60);
    } else {
      const left = Math.max(0, ROUND_S - s.t);
      g.font = '600 40px "Unbounded Variable", sans-serif';
      g.fillStyle = left < 10 ? NEON.red : c.text;
      g.fillText(left.toFixed(0), w / 2, 118);
      if (s.combo > 1) {
        g.font = '600 18px "Unbounded Variable", sans-serif';
        g.fillStyle = NEON.cyan;
        g.fillText(`×${s.combo}`, w / 2, 146);
      }
    }
  }

  return {
    frame,
    destroy() {
      offTilt();
      src.stop();
      decoySrc.stop();
    },
  };
}

/** 方位（度）→ 空间坐标（米）：x 右、y 上、z 前 */
function dir(yaw, pitch, dist) {
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  return [Math.sin(y) * Math.cos(p) * dist, Math.sin(p) * dist, Math.cos(y) * Math.cos(p) * dist];
}

function angDist(a, b) {
  return Math.hypot(wrap(a.yaw - b.yaw), a.pitch - b.pitch);
}

/** 大厅卡片上的小图：一圈扫描线和几道涟漪 */
function drawIcon(canvas, now, focus) {
  const g = canvas.getContext('2d');
  const s = Math.min(canvas.clientWidth, canvas.clientHeight) || 80;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(s * dpr)) {
    canvas.width = canvas.height = Math.round(s * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, s, s);
  const c = s / 2;
  const t = now / 1000;
  g.strokeStyle = 'rgba(102,214,255,0.25)';
  g.lineWidth = 1;
  for (const r of [0.2, 0.35, 0.48]) {
    g.beginPath();
    g.arc(c, c, s * r, 0, Math.PI * 2);
    g.stroke();
  }
  const a = t * (focus ? 3 : 1.4);
  const sweep = g.createConicGradient(a, c, c);
  sweep.addColorStop(0, 'rgba(102,214,255,0.5)');
  sweep.addColorStop(0.15, 'rgba(102,214,255,0)');
  sweep.addColorStop(1, 'rgba(102,214,255,0)');
  g.fillStyle = sweep;
  g.beginPath();
  g.arc(c, c, s * 0.48, 0, Math.PI * 2);
  g.fill();
  const ph = (t * 0.8) % 1;
  g.strokeStyle = `rgba(102,214,255,${1 - ph})`;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(c + s * 0.18, c - s * 0.12, 3 + ph * s * 0.2, 0, Math.PI * 2);
  g.stroke();
}
