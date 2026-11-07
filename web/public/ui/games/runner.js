// 疾行（Neon Dash）：一条伸向地平线的三车道霓虹公路，你是一团往前飞奔的光球，越跑越快。
//   转头 = 换道（左 / 中 / 右，带滞回，不会在分界处来回抖）
//   抬头再回来（或快速往上甩头）= 跳：跳过矮栏、地面的缺口
//   低头再回来（点头）= 滑铲：钻过高杆。空中点头会急降并接着滑铲
// 整块的方块要换道躲；后期出现会变道的方块（箭头提前预告）。沿路的光片连着吃越吃越高音，连击抬高倍率。
// 撞一下就结束，但路上偶尔有一个护盾，能挡一次。得分 = 跑的米数 + 光片 × 倍率 + 擦身而过的奖励。
//
// 关卡由手工设计的“片段”拼起来：每个片段都保证至少有一条能过的路；片段内的间距按“拍”算，
// 一拍的长度 = 当前速度 × 拍时长（1.05 s 渐缩到 0.8 s），所以越快障碍隔得越远，留给反应的时间不变。
// 手势要 ~250 ms 才认出来，加上看到再反应，每个需要动作的地方之间至少隔一拍。
//
// 画面：伪 3D 透视。消失点在地平线中央，地面网格朝镜头流过来，远处是合成器波风格的太阳、山和楼的剪影。

import { NEON, clamp, lerp, rand } from './kit.js';

const LANE_W = 1.6; // 车道宽（米）
const ROAD_HALF = LANE_W * 1.5 + 0.15;
const FAR = 130; // 能看到多远（米）
const CAM_BACK = 5; // 摄像机在玩家身后多远（米）
const CAM_H = 2.3; // 摄像机高度
const NEAR = -CAM_BACK + 0.6; // 近裁剪面（相对玩家的 z）
const AIR = 0.8; // 一跳在空中多久（秒）
const JUMP_H = 1.5; // 跳多高（米）
const SLIDE_S = 0.95; // 滑铲多久（秒）
const V0 = 10; // 起步速度 m/s（头控比手指慢，起步放慢）
const V1 = 25; // 渐近的最高速度
const V_TAU = 140; // 速度上升的时间常数（秒）：60 s ≈ 15 m/s，120 s ≈ 18 m/s
const ENTER = 0.3; // 头的水平指向超过它就换到边道
const LEAVE = 0.2; // 回到它以内才回中道（滞回）
const HEARTS = 3; // 撞几次才结束（护盾另算）
const P_R = 0.35; // 玩家前后的半径（碰撞）
const GRID = 4; // 地面网格间距
const STREAK_GAP = 1.6; // 两个光片隔多久以内算连着吃

export default {
  id: 'runner',
  title: { zh: '疾行', en: 'Neon Dash' },
  tagline: { zh: '在霓虹公路上狂奔，转头换道', en: 'Sprint down a neon highway, turn to switch lanes' },
  how: { zh: '转头换道 · 抬头跳 · 点头滑铲', en: 'Turn to change lane · look up to jump · nod to slide' },
  accent: NEON.blue,
  range: { h: 20, v: 13 },
  nodCross: 0.3, // 常常边转头换道边点头滑铲：左右动得快也照样认点头
  icon: drawIcon,
  create,
};

// ---------------------------------------------------------------------------
// 关卡片段。l 车道（0 左 1 中 2 右），b 第几拍，len 米，lenB 拍。生成时随机左右镜像。
//   block 方块（换道躲） low 矮栏（跳） high 高杆（滑铲） gap 缺口（跳） mover 会变道的方块
//   line 地上一串光片   arc 跳跃弧线上的光片（以 b 处的障碍为顶点）   under 高杆下面的光片

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const others = (l) => [0, 1, 2].filter((x) => x !== l);
const ALL = [0, 1, 2];

const CHUNKS = [
  // 0 级：一次只要一个动作
  { id: 'a', lv: 0, len: 1, make: () => { const b = pick(ALL); return [{ k: 'block', l: [b], len: 3 }, { k: 'line', l: pick(others(b)), b: -0.6, n: 5 }]; } },
  { id: 'b', lv: 0, len: 1, make: () => [{ k: 'low', l: ALL }, { k: 'arc', l: pick(ALL) }] },
  { id: 'c', lv: 0, len: 1, make: () => [{ k: 'high', l: ALL }, { k: 'under', l: pick(ALL) }] },
  { id: 'd', lv: 0, len: 1, make: () => [{ k: 'block', l: [0, 1], len: 4 }, { k: 'line', l: 2, b: -0.5, n: 6 }] },
  { id: 'e', lv: 0, len: 1.6, make: () => { const a = pick(ALL); return [{ k: 'line', l: a, b: 0, n: 4 }, { k: 'line', l: pick(others(a)), b: 1.2, n: 4 }]; } },
  // 1 级：两个动作连起来
  { id: 'f', lv: 1, len: 2, make: () => [{ k: 'low', l: ALL }, { k: 'arc', l: 1 }, { k: 'high', l: ALL, b: 2 }, { k: 'under', l: pick(ALL), b: 2 }] },
  { id: 'g', lv: 1, len: 2.2, make: () => [{ k: 'block', l: [0, 1], len: 3 }, { k: 'line', l: 2, b: -0.6, n: 3 }, { k: 'block', l: [1, 2], b: 2.2, len: 3 }, { k: 'line', l: 0, b: 1.4, n: 3 }] },
  { id: 'h', lv: 1, len: 2.2, make: () => [{ k: 'block', l: [1], lenB: 2.2 }, { k: 'low', l: [0], b: 1 }, { k: 'arc', l: 0, b: 1 }, { k: 'high', l: [2], b: 1 }, { k: 'under', l: 2, b: 1 }] },
  { id: 'i', lv: 1, len: 1, make: () => [{ k: 'gap', l: ALL, len: 4 }, { k: 'arc', l: pick(ALL), off: 2 }] },
  { id: 'j', lv: 1, len: 2, make: () => [{ k: 'block', l: [0, 2], len: 3 }, { k: 'low', l: [1] }, { k: 'arc', l: 1 }, { k: 'high', l: ALL, b: 2 }, { k: 'under', l: 1, b: 2 }] },
  // 2 级：会变道的方块、之字形、组合
  { id: 'k', lv: 2, len: 1, make: () => [{ k: 'mover', from: 1, to: 0 }, { k: 'line', l: 2, b: -0.4, n: 4 }] },
  { id: 'l', lv: 2, len: 4, make: () => [{ k: 'block', l: [0, 1], len: 3 }, { k: 'line', l: 2, b: -0.5, n: 3 }, { k: 'block', l: [1, 2], b: 2, len: 3 }, { k: 'line', l: 0, b: 1.4, n: 3 }, { k: 'block', l: [0, 1], b: 4, len: 3 }, { k: 'line', l: 2, b: 3.4, n: 3 }] },
  { id: 'm', lv: 2, len: 3.2, make: () => [{ k: 'low', l: ALL }, { k: 'arc', l: 1 }, { k: 'block', l: [0, 2], b: 1.6, len: 2 }, { k: 'line', l: 1, b: 1.1, n: 3 }, { k: 'high', l: ALL, b: 3.2 }, { k: 'under', l: 1, b: 3.2 }] },
  { id: 'n', lv: 2, len: 1, make: () => [{ k: 'gap', l: [0, 1], len: 5 }, { k: 'arc', l: 0, off: 2.5 }, { k: 'high', l: [2] }, { k: 'under', l: 2 }] },
  { id: 'o', lv: 2, len: 2.2, make: () => [{ k: 'mover', from: 1, to: 2 }, { k: 'line', l: 1, b: 0.7, n: 3 }, { k: 'mover', from: 1, to: 0, b: 2.2 }] },
  { id: 'p', lv: 2, len: 2, make: () => [{ k: 'high', l: [0, 1] }, { k: 'block', l: [2], len: 3 }, { k: 'under', l: 0 }, { k: 'low', l: [1, 2], b: 2 }, { k: 'block', l: [0], b: 2, len: 3 }, { k: 'arc', l: 1, b: 2 }] },
  { id: 'q', lv: 2, len: 1, make: () => [{ k: 'mover', from: 0, to: 1 }, { k: 'block', l: [2], len: 3 }, { k: 'line', l: 0, b: 0.5, n: 3 }] },
];

// ---------------------------------------------------------------------------

function create(api) {
  const { input, sound } = api;
  const s = {
    time: 0, // 总时间（含倒计时），给动画用
    t: 0, // 开跑以后的时间
    started: false,
    countdown: 3,
    crashed: false,
    crashT: 0,
    finished: false,
    dist: 0,
    runDist: 0,
    speed: 0,
    lane: 1,
    x: 0, // 玩家横向位置（米）
    y: 0, // 离地高度
    airT: -1, // 起跳后多久；< 0 = 在地上
    airRate: 1, // 急降时空中时间走得更快
    slideT: -1, // 滑铲开始后多久；< 0 = 没在滑
    slideQueued: false,
    jumpReqAt: -9,
    flickJumpAt: -9,
    slideReqAt: -9,
    leftLaneAt: [-9, -9, -9],
    squash: 0, // > 0 拉长，< 0 压扁
    squashV: 0,
    stepPh: 0,
    shield: false,
    invuln: 0,
    hearts: HEARTS,
    shards: 0,
    streak: 0,
    lastShardT: -9,
    near: 0,
    bonus: 0,
    score: 0,
    shake: 0,
    flash: 0,
    flashCol: NEON.red,
    nextAt: 70, // 下一个片段从哪儿开始（沿路的距离）
    lastChunk: null,
    nextShield: 15,
    row: 0,
    lastNearRow: -1,
  };
  const ents = [];
  const parts = [];
  const pops = [];
  const trail = [];
  const lines = Array.from({ length: 28 }, () => newSpeedLine(true));
  const scenery = makeScenery();
  let pal = null;
  let palDark = null;

  // ---- 输入 ----
  const offs = [
    input.on('nod', (e) => {
      if (e.dir === 'down') slide();
      // 甩头已经起跳的话，同一个抬头动作回正时不再跳一次
      else if (s.time - s.flickJumpAt > 0.75) jump();
    }),
    input.on('flick', (e) => {
      if (e.dir !== 'up') return;
      // 低头之后回正也是往上快速转，那不是跳
      if (input.nodState?.dir < 0 || s.time - s.slideReqAt < 0.4 || input.v - input.baseV < -2) return;
      if (jump()) s.flickJumpAt = s.time;
    }),
  ];

  function jump() {
    if (!s.started || s.crashed || s.airT >= 0) return false;
    s.jumpReqAt = s.time;
    s.airT = 0;
    s.airRate = 1;
    s.slideT = -1;
    s.slideQueued = false;
    s.squash = 0.32;
    s.squashV = 0;
    sound.noise(0.2, { vol: 0.1, freq: 1400, q: 0.6 });
    sound.tone(320, 0.16, { type: 'sine', vol: 0.08, slide: 640 });
    return true;
  }

  function slide() {
    if (!s.started || s.crashed) return;
    s.slideReqAt = s.time;
    if (s.airT >= 0) {
      // 空中点头：急降，落地接着滑
      const p = s.airT / AIR;
      if (p < 0.5) s.airT = (1 - p) * AIR;
      s.airRate = 3;
      s.slideQueued = true;
    } else startSlide();
    sound.noise(0.22, { vol: 0.09, freq: 520, q: 0.7 });
  }

  function startSlide() {
    s.slideT = 0;
    s.slideQueued = false;
    s.squash = -0.2;
    s.squashV = 0;
  }

  // ---- 生成 ----
  function beatLen() {
    const beatT = lerp(1.05, 0.8, clamp(s.t / 120, 0, 1));
    return Math.max(s.speed, V0) * beatT;
  }

  function spawnChunk() {
    const level = s.t < 25 ? 0 : s.t < 60 ? 1 : 2;
    const pool = [];
    for (const c of CHUNKS) {
      if (c.lv > level || c.id === s.lastChunk) continue;
      const w = c.lv === level ? 2 : 1;
      for (let i = 0; i < w; i++) pool.push(c);
    }
    const chunk = pick(pool);
    s.lastChunk = chunk.id;
    const B = beatLen();
    const v = Math.max(s.speed, V0);
    const mirror = Math.random() < 0.5;
    const m = (l) => (mirror ? 2 - l : l);
    const start = s.nextAt;
    for (const it of chunk.make()) {
      const at = start + (it.b ?? 0) * B;
      const row = ++s.row;
      if (it.k === 'line') {
        for (let i = 0; i < it.n; i++) ents.push({ k: 'shard', lane: m(it.l), lx: m(it.l), at: at + i * 0.28 * B, len: 0.3, y: 0.6, ph: rand(0, 6) });
      } else if (it.k === 'arc') {
        // 以障碍为顶点的跳跃弧线：玩家在障碍前半个跳跃距离处起跳，正好顶点在障碍上
        const D = v * AIR;
        for (let i = 0; i < 5; i++) {
          const o = ((i - 2) / 4) * D * 0.8;
          const p = 0.5 + o / D;
          ents.push({ k: 'shard', lane: m(it.l), lx: m(it.l), at: at + (it.off ?? 0) + o, len: 0.3, y: 0.45 + 4 * JUMP_H * p * (1 - p), ph: rand(0, 6) });
        }
      } else if (it.k === 'under') {
        for (let i = -1; i <= 1; i++) ents.push({ k: 'shard', lane: m(it.l), lx: m(it.l), at: at + i * 0.12 * B, len: 0.3, y: 0.35, ph: rand(0, 6) });
      } else if (it.k === 'mover') {
        ents.push({ k: 'mover', lane: m(it.from), lx: m(it.from), to: m(it.to), at, len: 2.5, row, switched: false });
      } else {
        const len = it.lenB ? it.lenB * B : it.len ?? (it.k === 'low' ? 0.4 : it.k === 'high' ? 0.35 : it.k === 'gap' ? 4 : 2.5);
        for (const l of it.l) ents.push({ k: it.k, lane: m(l), lx: m(l), at, len, row });
      }
    }
    s.nextAt = start + chunk.len * B + B * (1.3 + rand(0, 0.7));
    // 护盾：放在片段之后的空档里，那里没有障碍
    if (s.t > s.nextShield && !s.shield && !ents.some((e) => e.k === 'shield')) {
      const lane = pick(ALL);
      ents.push({ k: 'shield', lane, lx: lane, at: start + chunk.len * B + B * 0.65, len: 0.4, y: 0.8, ph: 0 });
      s.nextShield = s.t + rand(28, 40);
    }
  }

  // ---- 每帧逻辑 ----
  function laneFromInput() {
    const x = input.x;
    let L = s.lane;
    if (L === 1) L = x < -ENTER ? 0 : x > ENTER ? 2 : 1;
    else if (L === 0) L = x > ENTER ? 2 : x > -LEAVE ? 1 : 0;
    else L = x < -ENTER ? 0 : x < LEAVE ? 1 : 2;
    return L;
  }

  function update(dt) {
    s.time += dt;
    if (!s.started) {
      s.countdown -= dt;
      if (Math.ceil(s.countdown) !== Math.ceil(s.countdown + dt)) sound.tick(s.countdown <= 0);
      if (s.countdown <= 0) {
        s.started = true;
        s.speed = V0;
        input.rearm(); // 正前方由大厅开局前的“对准中心”定，这里只清手势
      }
    }
    // 换道（倒计时时也能先试试）
    if (input.ok && !s.crashed) {
      const L = laneFromInput();
      if (L !== s.lane) {
        s.leftLaneAt[s.lane] = s.t;
        s.lane = L;
        if (s.started) sound.noise(0.08, { vol: 0.04, freq: 2600, q: 1.2 });
      }
    }
    const tx = (s.lane - 1) * LANE_W;
    s.x += (tx - s.x) * (1 - Math.exp(-dt * 15));

    // 压扁 / 拉长：阻尼弹簧
    s.squashV += (-170 * s.squash - 11 * s.squashV) * dt;
    s.squash += s.squashV * dt;
    s.shake = Math.max(0, s.shake - dt * 2.2);
    s.flash = Math.max(0, s.flash - dt * 2.5);
    s.invuln = Math.max(0, s.invuln - dt);

    if (!s.started) return;

    if (s.crashed) {
      s.crashT += dt;
      s.speed *= Math.exp(-dt * 5);
      s.dist += s.speed * dt;
      if (s.crashT > 1.1 && !s.finished) {
        s.finished = true;
        api.finish({
          score: s.score,
          stats: api.tr(`跑了 ${s.runDist} 米 · 收集 ${s.shards} 个 · 擦身而过 ${s.near} 次`, `${s.runDist} m · ${s.shards} shards · ${s.near} near misses`),
        });
      }
      return;
    }

    s.t += dt;
    s.speed = V0 + (V1 - V0) * (1 - Math.exp(-s.t / V_TAU));
    const moved = s.speed * dt;
    s.dist += moved;

    // 跳 / 滑
    if (s.airT >= 0) {
      s.airT += dt * s.airRate;
      const p = s.airT / AIR;
      if (p >= 1) {
        s.airT = -1;
        s.airRate = 1;
        s.y = 0;
        s.squash = -0.28;
        s.squashV = 0;
        sound.tone(150, 0.06, { type: 'triangle', vol: 0.06 });
        if (s.slideQueued) startSlide();
      } else s.y = 4 * JUMP_H * p * (1 - p);
    } else s.y = 0;
    if (s.slideT >= 0) {
      s.slideT += dt;
      if (s.slideT > SLIDE_S) s.slideT = -1;
    }
    // 脚步：很轻的嘀嗒，频率跟着速度
    if (s.airT < 0 && s.slideT < 0) {
      const prev = s.stepPh;
      s.stepPh += dt * (2.4 + s.speed * 0.11);
      if (Math.floor(prev) !== Math.floor(s.stepPh)) sound.tone(rand(105, 125), 0.035, { type: 'triangle', vol: 0.025 });
    }

    if (s.t - s.lastShardT > STREAK_GAP) s.streak = 0;

    while (s.nextAt < s.dist + FAR + 30) spawnChunk();

    // 碰撞、收集、擦身而过
    const sliding = s.slideT >= 0;
    const bodyY = s.y + (sliding ? 0.25 : 0.45);
    for (const e of ents) {
      if (e.dead) continue;
      const z = e.at - s.dist;
      const z1 = z + e.len;
      if (e.k === 'mover') {
        if (!e.switched && z < s.speed * 1.4) {
          e.switched = true;
          sound.tone(520, 0.12, { type: 'square', vol: 0.05, slide: 390 });
        }
        if (e.switched) {
          const d = e.to - e.lx;
          e.lx += Math.sign(d) * Math.min(Math.abs(d), dt / 0.3);
        }
        e.lane = Math.round(e.lx);
      }
      const ex = (e.lx - 1) * LANE_W;
      const dx = Math.abs(ex - s.x);
      const overlap = z <= P_R && z1 + moved >= -P_R;
      if (e.k === 'shard' || e.k === 'shield') {
        if (overlap && dx < 0.8 && Math.abs(e.y - bodyY) < 1.0) {
          e.dead = true;
          if (e.k === 'shard') collectShard(e, ex);
          else {
            s.shield = true;
            sound.tone(520, 0.12, { type: 'triangle', vol: 0.18 });
            sound.tone(780, 0.2, { type: 'sine', vol: 0.14, when: 0.08 });
            popup(api.tr('护盾', 'Shield'), NEON.blue);
          }
        }
        continue;
      }
      // 障碍刚到面前时记下动作是不是“险险赶上”
      if (!e.reached && z <= P_R) {
        e.reached = true;
        if (e.k === 'low' || e.k === 'gap') e.close = s.airT >= 0 && s.time - s.jumpReqAt < 0.22 && dx < LANE_W * 0.6;
        else if (e.k === 'high') e.close = sliding && s.slideT < 0.2 && dx < LANE_W * 0.6;
        else e.close = s.t - s.leftLaneAt[e.lane] < 0.3 && dx > LANE_W * 0.5;
      }
      if (!e.hit) {
        let hit = false;
        if (e.k === 'gap') hit = z <= -0.1 && z1 >= 0.1 && dx < LANE_W * 0.4 && s.y < 0.05;
        else if (overlap && dx < LANE_W * 0.42 + 0.3) {
          if (e.k === 'low') hit = s.y < 0.6;
          else if (e.k === 'high') hit = !sliding;
          else hit = true;
        }
        if (hit) {
          e.hit = true;
          crash(e, ex);
          if (s.crashed) return;
        }
      }
      if (!e.passed && z1 < -P_R) {
        e.passed = true;
        if (e.close && !e.hit && e.row !== s.lastNearRow) {
          s.lastNearRow = e.row;
          s.near += 1;
          const mult = multiplier();
          s.bonus += 50 * mult;
          s.streak += 3;
          s.lastShardT = s.t;
          popup(api.tr('好险！+', 'Close! +') + 50 * mult, NEON.amber);
          sound.tone(990, 0.08, { type: 'triangle', vol: 0.12 });
          sound.tone(1480, 0.12, { type: 'sine', vol: 0.1, when: 0.06 });
        }
      }
    }
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      if (e.dead || e.at + e.len - s.dist < -CAM_BACK) ents.splice(i, 1);
    }
    const score = Math.floor(s.dist) + s.bonus;
    if (score !== s.score) {
      s.score = score;
      api.setScore(score);
    }
  }

  function multiplier() {
    return Math.min(5, 1 + Math.floor(s.streak / 8));
  }

  function collectShard(e, ex) {
    s.streak = s.t - s.lastShardT < STREAK_GAP ? s.streak + 1 : 1;
    s.lastShardT = s.t;
    s.shards += 1;
    s.bonus += 5 * multiplier();
    sound.good(Math.min(s.streak - 1, 12));
    for (let i = 0; i < 6; i++) parts.push({ x: ex, y: e.y, z: 0.3, vx: rand(-2, 2), vy: rand(0, 3), vz: rand(-3, 1), life: 0.5, col: 'shard', size: 0.06 });
  }

  function crash(e, ex) {
    if (s.invuln > 0) return;
    const debris = (n, col) => {
      for (let i = 0; i < n; i++) parts.push({ x: lerp(ex, s.x, 0.5), y: rand(0.2, 1.4), z: 0.2, vx: rand(-5, 5), vy: rand(1, 7), vz: rand(-6, 4), life: rand(0.6, 1.1), col, size: rand(0.06, 0.14) });
    };
    if (s.shield) {
      s.shield = false;
      s.invuln = 1;
      s.shake = 0.6;
      s.flash = 0.6;
      s.flashCol = NEON.blue;
      e.dead = true;
      debris(16, 'shield');
      sound.noise(0.3, { vol: 0.25, freq: 900 });
      sound.tone(700, 0.25, { type: 'triangle', vol: 0.14, slide: 300 });
      popup(api.tr('护盾挡住了', 'Shield saved you'), NEON.blue);
      return;
    }
    if (s.hearts > 1) {
      // 还有命：闪一下、无敌 1.5 秒，接着跑
      s.hearts -= 1;
      s.invuln = 1.5;
      s.shake = 0.7;
      s.flash = 0.7;
      s.flashCol = NEON.red;
      e.dead = true;
      debris(14, 'crash');
      sound.bad();
      popup(api.tr(`撞了一下 · 还剩 ${s.hearts} 次`, `Hit · ${s.hearts} left`), NEON.red);
      return;
    }
    s.crashed = true;
    s.runDist = Math.floor(s.dist);
    s.shake = 1;
    s.flash = 1;
    s.flashCol = NEON.red;
    s.squash = -0.45;
    debris(26, 'crash');
    sound.bad();
    sound.noise(0.4, { vol: 0.35, freq: 380, q: 0.5 });
  }

  function popup(text, col) {
    pops.push({ text, col, life: 1 });
    if (pops.length > 4) pops.shift();
  }

  // ---- 画 ----
  function frame(dt) {
    update(dt);
    draw(dt);
  }

  function draw(dt) {
    const { g, w, h } = api;
    const dark = api.dark;
    if (dark !== palDark) {
      pal = palette(dark);
      palDark = dark;
    }
    const c = api.colors;
    const f = Math.min(h * 0.9, w * 0.75);
    const hy = h * 0.4;
    const running = s.started && !s.crashed && s.airT < 0 && s.slideT < 0;
    const bob = running ? -Math.abs(Math.sin(Math.PI * s.stepPh)) * 0.05 : 0;
    const camX = s.x * 0.6;
    const camY = CAM_H + bob + (s.slideT >= 0 ? -0.08 : 0) + s.y * 0.12;
    const shx = s.shake ? (Math.random() - 0.5) * s.shake * 22 : 0;
    const shy = s.shake ? (Math.random() - 0.5) * s.shake * 22 : 0;
    const cx = w / 2;
    const P = (x, y, z) => {
      const d = Math.max(z + CAM_BACK, 0.05);
      return { x: cx + ((x - camX) * f) / d, y: hy + ((camY - y) * f) / d };
    };

    g.save();
    g.translate(shx, shy);
    // 天空
    const sky = g.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, pal.skyTop);
    sky.addColorStop(1, pal.skyBot);
    g.fillStyle = sky;
    g.fillRect(-30, -30, w + 60, hy + 31);
    drawSun(g, cx - camX * 4, hy, Math.min(w, h) * 0.15);
    drawSkyline(g, w, hy, camX);
    // 地面
    g.fillStyle = pal.ground;
    g.fillRect(-30, hy, w + 60, h - hy + 30);
    // 网格：纵线汇向消失点，横线朝镜头流过来
    g.strokeStyle = pal.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 1; k <= 14; k++) {
      for (const sg of [-1, 1]) {
        const x = sg * (ROAD_HALF + k * 3);
        const a = P(x, 0, NEAR);
        const b = P(x, 0, FAR);
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
      }
    }
    const off = s.dist % GRID;
    for (let z = GRID - off; z < FAR; z += GRID) {
      const y = P(0, 0, z).y;
      g.moveTo(-30, y);
      g.lineTo(w + 30, y);
    }
    g.stroke();
    // 路面
    const r0 = P(-ROAD_HALF, 0, NEAR);
    const r1 = P(ROAD_HALF, 0, NEAR);
    const r2 = P(ROAD_HALF, 0, FAR);
    const r3 = P(-ROAD_HALF, 0, FAR);
    g.fillStyle = pal.road;
    poly(g, [r0, r1, r2, r3]);
    g.fill();
    // 车道虚线
    g.strokeStyle = pal.lane;
    g.lineWidth = 2;
    g.beginPath();
    const dOff = s.dist % 6;
    for (const x of [-LANE_W / 2, LANE_W / 2]) {
      for (let z = -dOff; z < FAR; z += 6) {
        const z0 = Math.max(z, NEAR);
        const z1 = z + 2.6;
        if (z1 <= z0) continue;
        const a = P(x, 0, z0);
        const b = P(x, 0, z1);
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
      }
    }
    g.stroke();
    // 路沿：两条亮线
    g.strokeStyle = pal.edge;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(r0.x, r0.y);
    g.lineTo(r3.x, r3.y);
    g.moveTo(r1.x, r1.y);
    g.lineTo(r2.x, r2.y);
    g.stroke();
    // 地平线的雾
    const fog = g.createLinearGradient(0, hy - 4, 0, hy + (h - hy) * 0.22);
    fog.addColorStop(0, pal.fog + '1)');
    fog.addColorStop(1, pal.fog + '0)');
    g.fillStyle = fog;
    g.fillRect(-30, hy - 4, w + 60, (h - hy) * 0.22 + 4);

    // 实体：先画贴地的（缺口、影子），再从远到近画别的，玩家插在 z = 0 的位置
    const vis = [];
    for (const e of ents) {
      const z = e.at - s.dist;
      if (z > FAR || z + e.len < NEAR) continue;
      if (e.k === 'gap') drawGap(g, P, e, z);
      else vis.push({ e, z });
    }
    vis.sort((a, b) => b.z - a.z);
    // 玩家的影子
    const sh = P(s.x, 0, 0);
    const shr = (0.45 * f) / CAM_BACK / (1 + s.y * 0.6);
    g.fillStyle = dark ? 'rgba(47,140,255,0.25)' : 'rgba(40,40,90,0.18)';
    g.beginPath();
    g.ellipse(sh.x, sh.y, shr, shr * 0.28, 0, 0, Math.PI * 2);
    g.fill();
    let playerDrawn = false;
    for (const { e, z } of vis) {
      if (!playerDrawn && z <= 0) {
        drawPlayer(g, P, f, dt);
        playerDrawn = true;
      }
      g.globalAlpha = clamp((FAR - z) / 40, 0, 1);
      drawEnt(g, P, e, z, camX, camY);
      g.globalAlpha = 1;
    }
    if (!playerDrawn) drawPlayer(g, P, f, dt);
    // 粒子
    for (const p of parts) {
      p.life -= dt;
      p.vy -= 12 * dt;
      p.x += p.vx * dt;
      p.y = Math.max(0, p.y + p.vy * dt);
      p.z += p.vz * dt;
      if (p.z < NEAR) continue;
      const q = P(p.x, p.y, p.z);
      const r = Math.max(1, (p.size * f) / (p.z + CAM_BACK));
      g.fillStyle = p.col === 'shard' ? pal.shard : p.col === 'shield' ? NEON.blue : p.life > 0.5 ? pal.edge : pal.block;
      g.globalAlpha = clamp(p.life * 2, 0, 1);
      g.fillRect(q.x - r, q.y - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
    // 速度线：从消失点往外飞
    const sp = clamp((s.speed - 15) / 14, 0, 1);
    if (sp > 0) {
      g.strokeStyle = pal.speed + (0.12 + sp * 0.25).toFixed(3) + ')';
      g.lineWidth = 1.5;
      g.beginPath();
      const R = Math.hypot(w, h) * 0.6;
      for (const L of lines) {
        L.r += dt * (0.3 + sp * 1.2) * (0.3 + L.r);
        if (L.r > 1.2) Object.assign(L, newSpeedLine(false));
        const a = L.r * R;
        const b = (L.r + L.len * (0.5 + sp)) * R;
        g.moveTo(cx + Math.cos(L.ang) * a, hy + Math.sin(L.ang) * a * 0.8);
        g.lineTo(cx + Math.cos(L.ang) * b, hy + Math.sin(L.ang) * b * 0.8);
      }
      g.stroke();
    }
    g.restore();

    // 闪光
    if (s.flash > 0) {
      g.fillStyle = rgba(s.flashCol, s.flash * 0.25);
      g.fillRect(0, 0, w, h);
    }
    drawHud(g, w, h, c, dt);
  }

  function drawPlayer(g, P, f, dt) {
    const sliding = s.slideT >= 0;
    const rW = 0.42;
    const cy = s.y + (sliding ? 0.24 : 0.45);
    // 拖尾：过去几帧的横向位置，往镜头这边拉出一条渐细的光带
    trail.unshift({ x: s.x, y: cy });
    if (trail.length > 12) trail.pop();
    for (let i = trail.length - 1; i >= 1; i--) {
      const tp = trail[i];
      const q = P(tp.x, tp.y, -i * 0.13 * (s.speed / V0));
      const rr = ((rW * (1 - i / 13) * f) / CAM_BACK) * 0.9;
      g.fillStyle = rgba(NEON.blue, 0.22 * (1 - i / 12));
      g.beginPath();
      g.arc(q.x, q.y, Math.max(rr, 0.5), 0, Math.PI * 2);
      g.fill();
    }
    const o = P(s.x, cy, 0);
    const r = (rW * f) / CAM_BACK;
    const sy = sliding ? 0.6 : 1 + s.squash;
    const sx = sliding ? 1.35 : 1 - s.squash * 0.6;
    const lean = clamp(((s.lane - 1) * LANE_W - s.x) * 0.25, -0.35, 0.35);
    const blink = s.invuln > 0 && Math.floor(s.time * 14) % 2 === 0;
    g.save();
    g.translate(o.x, o.y);
    g.rotate(lean);
    g.scale(sx, sy);
    g.globalAlpha = blink ? 0.35 : 1;
    // 光晕
    const halo = g.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 2.2);
    halo.addColorStop(0, rgba(NEON.cyan, palDark ? 0.55 : 0.4));
    halo.addColorStop(1, rgba(NEON.blue, 0));
    g.fillStyle = halo;
    g.beginPath();
    g.arc(0, 0, r * 2.2, 0, Math.PI * 2);
    g.fill();
    // 球体
    const core = g.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.1, 0, 0, r);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.45, NEON.cyan);
    core.addColorStop(1, NEON.blue);
    g.fillStyle = core;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();
    // 背面的一道“脊线”，看得出是背对你在跑
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = Math.max(1, r * 0.08);
    g.beginPath();
    g.moveTo(0, -r * 0.75);
    g.quadraticCurveTo(r * 0.12 * Math.sin(s.stepPh * Math.PI * 2), 0, 0, r * 0.75);
    g.stroke();
    // 护盾：一圈六边形
    if (s.shield) {
      g.strokeStyle = rgba(NEON.blue, 0.6 + 0.3 * Math.sin(s.time * 6));
      g.lineWidth = Math.max(1.5, r * 0.1);
      hexPath(g, 0, 0, r * 1.45, s.time * 0.8);
      g.stroke();
    }
    g.restore();
  }

  function drawEnt(g, P, e, z, camX, camY) {
    const ex = (e.lx - 1) * LANE_W;
    const half = LANE_W * 0.42;
    if (e.k === 'shard') {
      const q = P(ex, e.y, z);
      const r = 0.22 * f0(P, z);
      const sx = Math.abs(Math.cos(s.time * 4 + e.ph)) * 0.8 + 0.2;
      g.fillStyle = rgba(pal.shard, 0.18);
      g.beginPath();
      g.arc(q.x, q.y, r * 1.8, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = pal.shard;
      g.beginPath();
      g.moveTo(q.x, q.y - r * 1.3);
      g.lineTo(q.x + r * sx, q.y);
      g.lineTo(q.x, q.y + r * 1.3);
      g.lineTo(q.x - r * sx, q.y);
      g.closePath();
      g.fill();
      return;
    }
    if (e.k === 'shield') {
      const q = P(ex, e.y + Math.sin(s.time * 3) * 0.1, z);
      const r = 0.38 * f0(P, z);
      g.fillStyle = rgba(NEON.blue, 0.2);
      g.beginPath();
      g.arc(q.x, q.y, r * 1.7, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = NEON.blue;
      g.lineWidth = Math.max(1.5, r * 0.18);
      hexPath(g, q.x, q.y, r, s.time * 1.5);
      g.stroke();
      g.fillStyle = rgba(NEON.blue, 0.5);
      hexPath(g, q.x, q.y, r * 0.5, -s.time * 2);
      g.fill();
      return;
    }
    if (e.k === 'low') {
      box(g, P, ex - half - 0.1, ex + half + 0.1, 0, 0.6, z, z + e.len, pal.low, camX, camY);
      return;
    }
    if (e.k === 'high') {
      const x0 = ex - LANE_W / 2;
      const x1 = ex + LANE_W / 2;
      box(g, P, x0, x0 + 0.1, 0, 1.6, z, z + 0.12, pal.high, camX, camY);
      box(g, P, x1 - 0.1, x1, 0, 1.6, z, z + 0.12, pal.high, camX, camY);
      box(g, P, x0, x1, 1.0, 1.55, z, z + e.len, pal.high, camX, camY);
      return;
    }
    const col = e.k === 'mover' ? pal.mover : pal.block;
    box(g, P, ex - half, ex + half, 0, 2.0, z, z + e.len, col, camX, camY);
    // 正面一道横向的灯带
    const zn = Math.max(z, NEAR);
    const a = P(ex - half * 0.75, 1.2, zn);
    const b = P(ex + half * 0.75, 1.2, zn);
    g.strokeStyle = col;
    g.lineWidth = Math.max(1, (b.x - a.x) * 0.04);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    // 会变道的：正面画箭头，变道前闪
    if (e.k === 'mover' && e.lx !== e.to) {
      const dir = Math.sign(e.to - e.lx);
      const m = P(ex, 0.75, zn);
      const k = (b.x - a.x) * 0.22;
      const on = e.switched || Math.floor(s.time * 6) % 2 === 0;
      g.strokeStyle = on ? col : rgba(col, 0.3);
      g.lineWidth = Math.max(1.5, k * 0.35);
      g.beginPath();
      g.moveTo(m.x - dir * k, m.y - k);
      g.lineTo(m.x + dir * k * 0.4, m.y);
      g.lineTo(m.x - dir * k, m.y + k);
      g.stroke();
    }
  }

  // 投影的比例（每米多少像素）
  function f0(P, z) {
    return P(1, 0, z).x - P(0, 0, z).x;
  }

  function box(g, P, x0, x1, y0, y1, z0, z1, col, camX, camY) {
    const zn = Math.max(z0, NEAR);
    if (z1 <= zn) return;
    const A = P(x0, y0, zn), B = P(x1, y0, zn), C = P(x1, y1, zn), D = P(x0, y1, zn);
    const A2 = P(x0, y0, z1), B2 = P(x1, y0, z1), C2 = P(x1, y1, z1), D2 = P(x0, y1, z1);
    g.lineWidth = 1.5;
    g.strokeStyle = col;
    const face = (pts, tint) => {
      poly(g, pts);
      g.fillStyle = pal.face;
      g.fill();
      g.fillStyle = rgba(col, tint);
      g.fill();
      g.stroke();
    };
    if (y1 < camY) face([D, C, C2, D2], 0.3);
    if (x0 > camX) face([A, D, D2, A2], 0.16);
    if (x1 < camX) face([B, C, C2, B2], 0.16);
    face([A, B, C, D], 0.1);
  }

  function drawGap(g, P, e, z) {
    const ex = (e.lx - 1) * LANE_W;
    const zn = Math.max(z, NEAR);
    const z1 = z + e.len;
    if (z1 <= zn) return;
    const x0 = ex - LANE_W / 2;
    const x1 = ex + LANE_W / 2;
    g.globalAlpha = clamp((FAR - z) / 40, 0, 1);
    const pts = [P(x0, 0, zn), P(x1, 0, zn), P(x1, 0, z1), P(x0, 0, z1)];
    poly(g, pts);
    g.fillStyle = pal.hole;
    g.fill();
    g.strokeStyle = NEON.red;
    g.lineWidth = 2;
    g.beginPath();
    if (z >= NEAR) {
      g.moveTo(pts[0].x, pts[0].y);
      g.lineTo(pts[1].x, pts[1].y);
    }
    g.moveTo(pts[2].x, pts[2].y);
    g.lineTo(pts[3].x, pts[3].y);
    g.stroke();
    g.globalAlpha = 1;
  }

  function drawSun(g, x, hy, R) {
    const y = hy - R * 0.5;
    g.save();
    g.beginPath();
    g.arc(x, y, R, 0, Math.PI * 2);
    g.clip();
    const grad = g.createLinearGradient(0, y - R, 0, y + R);
    grad.addColorStop(0, pal.sunA);
    grad.addColorStop(1, pal.sunB);
    g.fillStyle = grad;
    // 下半截切成越来越粗的横条
    let yy = y - R;
    g.fillRect(x - R, yy, R * 2, R * 0.85);
    yy += R * 0.85;
    for (let i = 0; yy < y + R; i++) {
      const gap = 2 + i * 1.6;
      const band = Math.max(3, R * 0.14 - i * 2);
      yy += gap;
      g.fillRect(x - R, yy, R * 2, band);
      yy += band;
    }
    g.restore();
  }

  function drawSkyline(g, w, hy, camX) {
    // 山：远一点，视差小
    const shift = -camX * 6;
    g.fillStyle = pal.mount;
    g.beginPath();
    g.moveTo(-40, hy);
    const n = scenery.mount.length;
    for (let i = 0; i < n; i++) g.lineTo(-40 + ((w + 80) * i) / (n - 1) + shift, hy - scenery.mount[i] * hy * 0.32);
    g.lineTo(w + 40, hy);
    g.closePath();
    g.fill();
    // 楼：近一点，视差大
    const shift2 = -camX * 14;
    g.fillStyle = pal.city;
    for (const b of scenery.city) {
      const x = b.x * w + shift2;
      g.fillRect(x, hy - b.h * hy * 0.22, b.w * w, b.h * hy * 0.22 + 1);
    }
    g.fillStyle = pal.cityWin;
    for (const b of scenery.city) {
      if (!b.win) continue;
      const x = b.x * w + shift2;
      const top = hy - b.h * hy * 0.22;
      for (let k = 0; k < b.win; k++) g.fillRect(x + b.w * w * 0.3, top + 6 + k * 7, Math.max(1.5, b.w * w * 0.4), 2);
    }
  }

  function drawHud(g, w, h, c, dt) {
    const top = 96;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    if (s.started) {
      g.fillStyle = c.text;
      g.font = '600 30px "Unbounded Variable", sans-serif';
      g.fillText(`${Math.floor(s.dist)}`, 28, top + 32);
      const dw = g.measureText(`${Math.floor(s.dist)}`).width;
      g.font = '500 15px -apple-system, "PingFang SC", sans-serif';
      g.fillStyle = c.text2;
      g.fillText(api.tr('米', 'm'), 34 + dw, top + 32);
      // 倍率和离下一档还差多少
      const mult = multiplier();
      g.font = '600 18px "Unbounded Variable", sans-serif';
      g.fillStyle = mult > 1 ? pal.shard : c.text2;
      g.fillText(`×${mult}`, 28, top + 62);
      const prog = mult >= 5 ? 1 : (s.streak % 8) / 8;
      g.fillStyle = c.line;
      g.fillRect(70, top + 54, 80, 4);
      g.fillStyle = pal.shard;
      g.fillRect(70, top + 54, 80 * prog, 4);
      // 护盾
      if (s.shield) {
        g.strokeStyle = NEON.blue;
        g.lineWidth = 2;
        hexPath(g, 38, top + 88, 10, 0);
        g.stroke();
        g.fillStyle = NEON.blue;
        g.font = '500 14px -apple-system, "PingFang SC", sans-serif';
        g.fillText(api.tr('护盾', 'Shield'), 56, top + 93);
      }
    }
    // 弹出的字
    g.textAlign = 'center';
    for (let i = 0; i < pops.length; i++) {
      const p = pops[i];
      p.life -= dt * 0.9;
      g.globalAlpha = clamp(p.life * 2, 0, 1);
      g.fillStyle = p.col;
      g.font = '600 22px "Unbounded Variable", -apple-system, "PingFang SC", sans-serif';
      g.fillText(p.text, w / 2, h * 0.3 - (1 - p.life) * 30 - (pops.length - 1 - i) * 30);
    }
    g.globalAlpha = 1;
    for (let i = pops.length - 1; i >= 0; i--) if (pops[i].life <= 0) pops.splice(i, 1);
    if (!s.started) {
      g.fillStyle = c.text;
      g.font = '600 96px "Unbounded Variable", sans-serif';
      g.fillText(String(Math.max(1, Math.ceil(s.countdown))), w / 2, h * 0.32);
      g.font = '500 16px -apple-system, "PingFang SC", sans-serif';
      g.fillStyle = c.text2;
      g.fillText(api.tr('头摆正。转头换道，抬头再回来是跳，点头是滑铲', 'Face forward. Turn to change lanes, look up and back to jump, nod to slide'), w / 2, h * 0.32 + 44);
    }
  }

  return {
    frame,
    debug: { s, ents }, // 给测试脚本看状态用
    // 键盘备用：↑ / 空格跳，↓ 滑铲
    key(e) {
      if (e.key === 'ArrowUp' || e.key === ' ' || e.key === 'w') jump();
      else if (e.key === 'ArrowDown' || e.key === 's') slide();
    },
    destroy() {
      for (const off of offs) off();
    },
  };
}

// ---------------------------------------------------------------------------
// 小工具

function palette(dark) {
  return dark
    ? {
        skyTop: '#05030f', skyBot: '#2b0c3f', ground: '#07050f', grid: 'rgba(177,140,255,0.3)', road: 'rgba(14,10,28,0.94)',
        edge: NEON.pink, lane: 'rgba(102,214,255,0.55)', fog: 'rgba(43,12,63,', mount: '#1b0c30', city: '#12081f', cityWin: 'rgba(255,179,71,0.45)',
        sunA: '#ffc36b', sunB: '#ff3d8b', speed: 'rgba(255,255,255,', face: 'rgba(12,8,24,0.92)', hole: '#000000',
        block: NEON.pink, low: NEON.cyan, high: NEON.violet, mover: NEON.amber, shard: NEON.mint,
      }
    : {
        skyTop: '#cdd6ff', skyBot: '#ffe0ec', ground: '#f4f0fa', grid: 'rgba(110,80,210,0.22)', road: 'rgba(232,226,245,0.96)',
        edge: '#e0458f', lane: 'rgba(47,140,255,0.6)', fog: 'rgba(255,224,236,', mount: '#cbbfe9', city: '#b8aadf', cityWin: 'rgba(255,255,255,0.75)',
        sunA: '#ffc36b', sunB: '#ff7cba', speed: 'rgba(90,60,180,', face: 'rgba(255,255,255,0.93)', hole: '#2a2440',
        block: '#e0458f', low: '#1a9fd6', high: '#7d55e8', mover: '#e08a12', shard: '#11a982',
      };
}

function makeScenery() {
  // 山：几段正弦叠起来的轮廓（0…1）
  const mount = [];
  const p1 = rand(0, 6), p2 = rand(0, 6);
  for (let i = 0; i <= 48; i++) {
    const u = i / 48;
    mount.push(clamp(0.35 + 0.3 * Math.sin(u * 7 + p1) * Math.sin(u * 3.1 + p2) + 0.15 * Math.sin(u * 19 + p2), 0.05, 1));
  }
  const city = [];
  for (let x = -0.05; x < 1.05; ) {
    const bw = rand(0.015, 0.045);
    const near = Math.abs(x + bw / 2 - 0.5) < 0.12; // 中间留低一点，露出太阳
    city.push({ x, w: bw, h: near ? rand(0.1, 0.3) : rand(0.25, 1), win: Math.random() < 0.5 ? Math.floor(rand(1, 5)) : 0 });
    x += bw + rand(0, 0.01);
  }
  return { mount, city };
}

function newSpeedLine(init) {
  return { ang: rand(0, Math.PI * 2), r: init ? rand(0.15, 1.2) : rand(0.15, 0.35), len: rand(0.04, 0.1) };
}

function poly(g, pts) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
}

function hexPath(g, x, y, r, rot) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rot + (i * Math.PI) / 3;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.closePath();
}

/** '#rrggbb' + 透明度 → rgba() */
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 大厅卡片上的小图：一段伸向地平线的路，光球在车道间换来换去、偶尔跳一下 */
function drawIcon(canvas, now, focus) {
  const g = canvas.getContext('2d');
  const s = Math.min(canvas.clientWidth, canvas.clientHeight) || 80;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(s * dpr)) {
    canvas.width = canvas.height = Math.round(s * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, s, s);
  const t = (now / 1000) * (focus ? 1.8 : 1);
  const hy = s * 0.42;
  const cx = s / 2;
  // 太阳
  g.save();
  g.beginPath();
  g.arc(cx, hy, s * 0.2, Math.PI, 0);
  g.clip();
  const sun = g.createLinearGradient(0, hy - s * 0.2, 0, hy);
  sun.addColorStop(0, 'rgba(255,195,107,0.9)');
  sun.addColorStop(1, 'rgba(255,61,139,0.9)');
  g.fillStyle = sun;
  g.fillRect(cx - s * 0.2, hy - s * 0.2, s * 0.4, s * 0.12);
  g.fillRect(cx - s * 0.2, hy - s * 0.07, s * 0.4, s * 0.03);
  g.fillRect(cx - s * 0.2, hy - s * 0.025, s * 0.4, s * 0.02);
  g.restore();
  // 路：从消失点张开的梯形
  const P = (x, z) => ({ x: cx + (x * s * 0.5) / (z + 1), y: hy + (s * 0.55) / (z + 1) });
  const a = P(-1.1, 0), b = P(1.1, 0);
  g.fillStyle = 'rgba(47,140,255,0.12)';
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.lineTo(cx, hy);
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(255,124,186,0.9)';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(cx, hy);
  g.lineTo(b.x, b.y);
  g.stroke();
  // 流动的车道虚线
  g.strokeStyle = 'rgba(102,214,255,0.8)';
  g.lineWidth = 1;
  g.beginPath();
  for (const x of [-0.37, 0.37]) {
    for (let k = 0; k < 6; k++) {
      const z = ((k - ((t * 2) % 1)) * 1.2);
      if (z < 0) continue;
      const p = P(x, z);
      const q = P(x, z + 0.5);
      g.moveTo(p.x, p.y);
      g.lineTo(q.x, q.y);
    }
  }
  g.stroke();
  // 光球：车道按 中→左→中→右 轮换，换道之间跳一下
  const seq = [0, -1, 0, 1];
  const ph = t / 1.1;
  const i = Math.floor(ph);
  const u = ph - i;
  const from = seq[i % 4];
  const to = seq[(i + 1) % 4];
  const lx = lerp(from, to, clamp((u - 0.7) / 0.3, 0, 1)) * 0.74;
  const jumpUp = i % 4 === 1 ? Math.sin(clamp(u / 0.6, 0, 1) * Math.PI) : 0;
  const o = P(lx, 0.25);
  const r = s * 0.08;
  const y = o.y - r - jumpUp * s * 0.14;
  const halo = g.createRadialGradient(o.x, y, 0, o.x, y, r * 2.4);
  halo.addColorStop(0, 'rgba(102,214,255,0.6)');
  halo.addColorStop(1, 'rgba(47,140,255,0)');
  g.fillStyle = halo;
  g.beginPath();
  g.arc(o.x, y, r * 2.4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = NEON.cyan;
  g.beginPath();
  g.arc(o.x, y, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath();
  g.arc(o.x - r * 0.3, y - r * 0.3, r * 0.35, 0, Math.PI * 2);
  g.fill();
}
