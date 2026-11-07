// 点头节拍（Nod Beat）：只用头玩的节奏游戏。音乐是 Web Audio 现场合成的（底鼓、拍手、踩镲、贝斯、琶音、主旋律），
// 一首约 77 秒，分五段：越往后乐器越多、速度越快（96 → 112 BPM）、提示越密。
//
// 玩法：箭头沿四条轨道飞进中间的圆圈，碰到圈的那一拍做对应的动作——
//   ↓ 点头（低头再回来）  ↑ 抬头再回来  ← 向左歪头  → 向右歪头  ↔ 摇头（琥珀色的圈从外往里收）
// 判定：Perfect ±110 ms、Great ±200 ms、Good ±300 ms；提示过了 +300 ms 还没做就是 Miss，连击清零。
// 多做的动作不扣分。分数 = 基础分 × 连击倍率（10 连 ×2、25 连 ×3、45 连 ×4）。
//
// 时间全部以音频时钟（AudioContext.currentTime）为准：音符用“前瞻调度”（每 25 ms 把未来 0.12 s 的音排进音频时钟），
// 提示的时间就是它在曲子里的拍点；减去输出延迟（outputLatency）就是“耳朵听到”的时刻，画面和判定都按它算。
//
// 延迟补偿（重要）：kit 的手势是在动作“做完”（头回到中立位）时才触发的，而玩家瞄的是动作的起点或最深处，
// 所以手势事件天然比拍点晚 150～350 ms，而且因人、因动作而异。这里给每类动作一个补偿量（起始：点头 230 ms、
// 歪头 260 ms、摇头 300 ms），判定误差 = 手势时刻 − 拍点 − 补偿量。补偿量会自动校准：取最近 8 次命中的
// “手势时刻 − 拍点”的中位数（样本少于 4 个时用起始值补齐，中位数不怕偶尔一次手滑）。超出 Good 窗但在 ±450 ms
// 以内的动作不计分、只进校准样本，这样即使某人的延迟离起始值很远，几次之后也能收敛回判定窗里。

import { NEON, clamp, glow, roundRect } from './kit.js';

const APPROACH = 1.5; // 提示从出现到碰圈（秒）
const LOOKAHEAD = 0.12; // 调度器往前排多远（秒，音频时钟）
const TICK_MS = 25;
const WIN = { perfect: 0.13, great: 0.24, good: 0.36 }; // 头比手指慢，窗放宽
const CAPTURE = 0.5; // 判定窗外、这个范围内的动作只拿来校准延迟
const POINTS = { perfect: 300, great: 200, good: 100 };
const ACC = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };
const LAT0 = { nod: 0.16, tilt: 0.18, shake: 0.35 }; // 手势做完相对拍点的起始延迟（秒）
const LAT_N = 8;
const TOP = 92; // 顶部留给游戏厅的记分栏

// 五种提示：颜色、属于哪类手势（决定延迟补偿）、在屏幕上的飞行方向（箭头朝哪飞就做哪个动作）
const KINDS = {
  down: { color: NEON.pink, fam: 'nod', dx: 0, dy: 1, ang: Math.PI / 2, label: ['点头', 'Nod'] },
  up: { color: NEON.cyan, fam: 'nod', dx: 0, dy: -1, ang: -Math.PI / 2, label: ['抬头', 'Look up'] },
  left: { color: NEON.violet, fam: 'tilt', dx: -1, dy: 0, ang: Math.PI, label: ['左歪头', 'Tilt left'] },
  right: { color: NEON.blue, fam: 'tilt', dx: 1, dy: 0, ang: 0, label: ['右歪头', 'Tilt right'] },
  shake: { color: NEON.amber, fam: 'shake', label: ['摇头', 'Shake'] },
};
const LANES = ['down', 'up', 'left', 'right'];
const MIRROR = { down: 'up', up: 'down', left: 'right', right: 'left', shake: 'shake' };

// 曲子的分段：小节数、速度、哪些乐器、每小节哪几拍出提示、出哪些动作
const SECTIONS = [
  { name: ['前奏', 'Intro'], bars: 2, bpm: 96, kick: 2, hat: 8, pad: 1, color: NEON.violet, int: 0.4 },
  {
    name: ['第一段', 'Verse'], bars: 8, bpm: 96, kick: 4, hat: 8, bass: 1, color: NEON.violet, int: 0.6,
    slots: (b) => (b % 4 === 3 ? [0, 1, 2] : [0, 2]),
    pool: (b) => (b < 4 ? ['down', 'down', 'up'] : LANES),
  },
  {
    name: ['第二段', 'Build'], bars: 8, bpm: 100, kick: 4, hat: 8, clap: 1, bass: 1, arp: 1, color: NEON.cyan, int: 0.75,
    slots: (b) => [[0, 2], [0, 2], [0, 2, 3], [0, 2]][b % 4],
    pool: () => LANES,
    mirror: true,
  },
  {
    name: ['第三段', 'Chorus'], bars: 8, bpm: 108, kick: 4, hat: 16, clap: 1, bass: 1, arp: 1, lead: 1, color: NEON.pink, int: 0.9,
    slots: (b) => [[0, 2], [0, 2, 3], [0, 2], [0, 1, 2]][b % 4],
    pool: () => [...LANES, 'shake'],
    mirror: true,
  },
  {
    name: ['高潮', 'Drop'], bars: 6, bpm: 112, kick: 4, hat: 16, clap: 1, bass: 2, arp: 1, lead: 1, color: NEON.violet, int: 1,
    slots: (b) => (b % 2 === 1 ? [0, 2] : [0, 2, 3]),
    pool: () => [...LANES, 'shake'],
    mirror: true,
  },
  { name: ['尾声', 'Outro'], bars: 1, bpm: 112, kick: 1, end: 1, color: NEON.violet, int: 0.6, slots: () => [0], pool: () => ['down'] },
];

// 和弦进行 Am – F – C – G（每小节一个）：贝斯根音和三个和弦音（MIDI）
const CHORDS = [
  { root: 45, tones: [57, 60, 64] },
  { root: 41, tones: [53, 57, 60] },
  { root: 48, tones: [55, 60, 64] },
  { root: 43, tones: [55, 59, 62] },
];
const BASS1 = { 0: 0, 3: 0, 6: 12, 8: 0, 11: 0, 14: 7 };
const BASS2 = { 0: 0, 2: 12, 4: 0, 6: 12, 8: 0, 10: 12, 12: 0, 14: 7 };
// 主旋律：四小节一句，[第几个十六分音符, MIDI, 长度（十六分音符）]
const LEAD = [
  [[0, 76, 2], [3, 74, 2], [6, 72, 2], [8, 69, 4], [14, 72, 2]],
  [[0, 72, 2], [3, 69, 2], [6, 72, 2], [8, 77, 4], [12, 76, 2], [14, 74, 2]],
  [[0, 76, 3], [3, 79, 2], [6, 76, 2], [8, 72, 4], [14, 74, 2]],
  [[0, 74, 2], [3, 71, 2], [6, 74, 2], [8, 79, 6], [14, 76, 2]],
].map((bar) => Object.fromEntries(bar.map(([st, m, len]) => [st, [m, len]])));

export default {
  id: 'beat',
  title: { zh: '点头节拍', en: 'Nod Beat' },
  tagline: { zh: '跟着鼓点点头、歪头、摇头', en: 'Nod, tilt and shake to the beat' },
  how: { zh: '箭头进圈时做动作', en: 'Move as arrows hit the ring' },
  accent: NEON.violet,
  icon: drawIcon,
  create,
};

/** 编曲和谱面：十六分音符的时间表 + 提示列表（固定种子，每局同一首谱，越玩越熟） */
export function buildSong() {
  const rnd = mulberry32(0x6b17);
  const steps = [];
  const cues = [];
  let t = 0;
  let gbar = 0;
  let prev = null;
  let prev2 = null;
  SECTIONS.forEach((sec, si) => {
    const st = 60 / sec.bpm / 4;
    sec.start = t;
    let lastBar = [];
    for (let b = 0; b < sec.bars; b++, gbar++) {
      for (let s = 0; s < 16; s++) steps.push({ t: t + s * st, si, bar: gbar, lb: b, s });
      if (sec.slots) {
        const slots = sec.slots(b);
        const mirrorBar = sec.mirror && b % 2 === 1 && rnd() < 0.55;
        const thisBar = [];
        slots.forEach((beat, i) => {
          const ct = t + beat * 4 * st;
          const gap = prev ? ct - prev.t : 9;
          if (prev?.kind === 'shake' && gap < 1.0) return; // 摇头最费时间：之后空出至少 1 秒
          if (gap < 0.45) return; // 两个动作之间至少 0.45 秒（格子本身已经保证，这里再防一手）
          const pool = sec.pool(b).filter((k) => k !== 'shake' || gap >= 0.9);
          let kind = null;
          const m = mirrorBar && lastBar[i] ? MIRROR[lastBar[i]] : null;
          if (m && pool.includes(m)) kind = m;
          else if (pool.includes('shake') && rnd() < 0.5) kind = 'shake'; // 有空当时偶尔来一下摇头
          else {
            kind = pool[Math.floor(rnd() * pool.length)];
            if (prev && prev2 && kind === prev.kind && kind === prev2.kind) kind = pool[Math.floor(rnd() * pool.length)];
          }
          const cue = { t: ct, kind, si, judged: null, doneAt: 0 };
          cues.push(cue);
          thisBar[i] = kind;
          prev2 = prev;
          prev = cue;
        });
        lastBar = thisBar;
      }
      t += 16 * st;
    }
    sec.end = t;
  });
  const beats = steps.filter((x) => x.s % 4 === 0);
  return { steps, beats, cues, length: t };
}

function create(api) {
  const { input, sound } = api;
  const ac = sound.ac;
  const song = buildSong();
  const { steps, beats, cues } = song;
  const lang = () => (api.lang === 'en' ? 1 : 0);

  // ---- 音频图：各声部 → duck（底鼓侧链）→ bus → 游戏厅的 master ----
  const bus = ac.createGain();
  bus.gain.value = sound.muted ? 0 : 0.85;
  bus.connect(sound.master);
  const drums = ac.createGain();
  drums.gain.value = 0.9;
  drums.connect(bus);
  const duck = ac.createGain();
  duck.gain.value = 1;
  duck.connect(bus);
  const delay = ac.createDelay(1);
  delay.delayTime.value = (60 / 108) * 0.75; // 附点八分的回声
  const fb = ac.createGain();
  fb.gain.value = 0.3;
  const wet = ac.createGain();
  wet.gain.value = 0.22;
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(wet);
  wet.connect(duck);
  const nodes = [bus, drums, duck, delay, fb, wet];
  // 一秒白噪声，拍手、踩镲、镲片、上升音效都从它里面随机截一段
  const noiseBuf = ac.createBuffer(1, Math.ceil(ac.sampleRate), ac.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  let live = []; // 已排上的声源，destroy 时统一停掉

  const s = {
    countdown: 3,
    started: false,
    audioOn: false,
    t0: 0,
    lat: 0,
    vis: -10,
    visInit: false,
    next: 0, // 调度到第几个十六分音符
    vp: 0, // 画面走到第几个十六分音符
    bp: 0, // 画面走到第几拍
    cueLo: 0, // 第一个还没判定的提示
    dLo: 0, // 第一个还要画的提示
    beatAt: -99,
    beatStrong: 0,
    si: 0,
    bar: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    counts: { perfect: 0, great: 0, good: 0, miss: 0 },
    lat8: { nod: [], tilt: [], shake: [] },
    pops: [],
    parts: [],
    ripples: [],
    banner: null,
    sqAt: -99,
    sqAxis: 'y',
    missAt: -99,
    hitAt: -99,
    hitColor: NEON.violet,
    lit: {},
    flash: 0,
    flashColor: NEON.violet,
    echo: null,
    done: false,
    timer: null,
  };

  // ---------- 声音 ----------

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function track(src, end) {
    live.push({ src, end });
  }

  function note(midi, t, dur, { type = 'sawtooth', vol = 0.1, cutoff = 0, sweep = 0, q = 1, out = duck, attack = 0.006 } = {}) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(mtof(midi), t);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (cutoff) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = q;
      f.frequency.setValueAtTime(cutoff, t);
      if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
      o.connect(f);
      f.connect(g);
    } else o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + dur + 0.03);
    track(o, t + dur + 0.03);
  }

  function noise(t, dur, { type = 'highpass', freq = 7000, to = 0, q = 0.7, vol = 0.1, rise = false, out = drums } = {}) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ac.createGain();
    if (rise) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.95);
      g.gain.linearRampToValueAtTime(0, t + dur);
    } else {
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(t, Math.random() * Math.max(0, 1 - dur), Math.min(dur + 0.02, 1));
    track(src, t + dur + 0.03);
  }

  function kick(t) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g);
    g.connect(drums);
    o.start(t);
    o.stop(t + 0.32);
    track(o, t + 0.32);
    // 侧链压缩的“泵”感：底鼓一响，合成器让一下
    duck.gain.setValueAtTime(0.45, t);
    duck.gain.linearRampToValueAtTime(1, t + 0.18);
  }

  /** 排一个十六分音符上的所有声音 */
  function playStep(st, t) {
    const sec = SECTIONS[st.si];
    const k = st.s;
    const ch = CHORDS[st.bar % 4];
    const stepDur = 60 / sec.bpm / 4;
    if ((sec.kick === 4 && k % 4 === 0) || (sec.kick === 2 && k % 8 === 0) || (sec.kick === 1 && k === 0)) kick(t);
    if (sec.clap && (k === 4 || k === 12)) {
      noise(t, 0.16, { type: 'bandpass', freq: 1500, q: 0.9, vol: 0.45 });
      noise(t + 0.012, 0.1, { type: 'bandpass', freq: 2400, q: 1.2, vol: 0.2 });
    }
    if (sec.hat === 8 && k % 4 === 2) noise(t, 0.05, { vol: 0.13 });
    if (sec.hat === 16) noise(t, k % 4 === 2 ? 0.09 : 0.03, { vol: k % 4 === 2 ? 0.14 : 0.055, freq: 8000 });
    const bassMap = sec.bass === 2 ? BASS2 : sec.bass ? BASS1 : null;
    if (bassMap && bassMap[k] != null) note(ch.root + bassMap[k], t, stepDur * 1.8, { type: 'sawtooth', vol: 0.2, cutoff: 1400, sweep: 220, q: 4 });
    if (sec.arp) {
      const tones = ch.tones;
      const m = [tones[0], tones[1], tones[2], tones[1]][k % 4] + 12 + (k >= 8 && sec.lead ? 12 : 0);
      note(m, t, 0.09, { type: 'square', vol: 0.03, cutoff: 2600 });
    }
    if (sec.lead) {
      const ln = LEAD[st.bar % 4][k];
      if (ln) {
        const up = st.si === 4 ? 12 : 0;
        note(ln[0] + up, t, ln[1] * stepDur * 0.95, { type: 'triangle', vol: 0.14, attack: 0.01 });
        note(ln[0] + up, t, ln[1] * stepDur * 0.9, { type: 'square', vol: 0.035, cutoff: 3000, out: delay });
        note(ln[0] + up, t, ln[1] * stepDur * 0.9, { type: 'square', vol: 0.04, cutoff: 3000 });
      }
    }
    if (sec.pad && k === 0) for (const m of ch.tones) note(m, t, stepDur * 15, { type: 'triangle', vol: 0.035, attack: 0.3 });
    // 段落：新段落的第一拍一记镲，段落最后一小节一道上升的噪声
    if (k === 0 && st.lb === 0 && st.si >= 2) noise(t, 1.2, { freq: 5000, vol: 0.13 });
    if (k === 0 && st.si >= 1 && st.si < SECTIONS.length - 1 && st.lb === sec.bars - 1) noise(t, stepDur * 16, { type: 'bandpass', freq: 400, to: 6000, q: 2, vol: 0.12, rise: true });
    if (sec.end && k === 0) {
      for (const m of [57, 60, 64, 69]) note(m, t, 2.2, { type: 'triangle', vol: 0.07, attack: 0.01 });
      note(33, t, 2, { type: 'sine', vol: 0.3 });
      noise(t, 1.8, { freq: 4000, vol: 0.16 });
    }
  }

  /** 前瞻调度：把音频时钟上未来 LOOKAHEAD 秒内的音排好 */
  function schedule() {
    if (!s.started || !s.audioOn) return;
    bus.gain.value = sound.muted ? 0 : 0.85;
    const now = ac.currentTime;
    while (s.next < steps.length) {
      const st = steps[s.next];
      const at = s.t0 + st.t;
      if (at > now + LOOKAHEAD) break;
      if (at > now - 0.05) playStep(st, Math.max(at, now));
      s.next++;
    }
    if (live.length > 64) live = live.filter((x) => x.end > now);
  }

  /** 命中音：当前和弦里的一个高音，Perfect 再加一个五度泛音 */
  function hitSound(grade) {
    if (!s.audioOn || sound.muted) return;
    const t = ac.currentTime;
    const ch = CHORDS[s.bar % 4];
    const m = ch.tones[(s.combo + 2) % 3] + 24;
    note(m, t, 0.16, { type: 'triangle', vol: 0.12, out: bus });
    if (grade === 'perfect') note(m + 7, t + 0.03, 0.12, { type: 'sine', vol: 0.07, out: bus });
  }

  function missSound() {
    if (!s.audioOn || sound.muted) return;
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.18);
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + 0.22);
    track(o, t + 0.22);
  }

  // ---------- 时钟和判定 ----------

  /** 现在“耳朵听到”的是曲子的第几秒 */
  const songNow = () => (s.audioOn ? ac.currentTime - s.lat : performance.now() / 1000) - s.t0;

  function start() {
    input.rearm(); // 正前方由大厅开局前的“对准中心”定，这里只清手势
    s.started = true;
    s.audioOn = ac.state === 'running';
    // 输出延迟：浏览器报多少用多少（蓝牙耳机可能更大，残差由下面的延迟自动校准吸收）
    s.lat = s.audioOn ? clamp(ac.outputLatency || ac.baseLatency || 0, 0, 0.4) : 0;
    s.t0 = (s.audioOn ? ac.currentTime : performance.now() / 1000) + 0.1;
    s.timer = setInterval(schedule, TICK_MS);
    schedule();
  }

  /** 某类动作当前的补偿量：最近 8 次命中误差的中位数，样本不够用起始值补齐 */
  function latency(fam) {
    const h = s.lat8[fam];
    const arr = h.length >= 4 ? h.slice() : h.concat(Array(4 - h.length).fill(LAT0[fam]));
    arr.sort((a, b) => a - b);
    const n = arr.length;
    const med = n % 2 ? arr[(n - 1) / 2] : (arr[n / 2 - 1] + arr[n / 2]) / 2;
    return clamp(med, 0.04, 0.6);
  }

  const multOf = (combo) => (combo >= 45 ? 4 : combo >= 25 ? 3 : combo >= 10 ? 2 : 1);

  function onGesture(kind) {
    if (!s.started || s.done) return;
    const tg = songNow();
    const fam = KINDS[kind].fam;
    const off = latency(fam);
    s.echo = { kind, at: s.vis };
    let best = null;
    let bestErr = Infinity;
    for (let i = s.cueLo; i < cues.length; i++) {
      const c = cues[i];
      if (c.t > tg + 1) break;
      if (c.judged || c.kind !== kind) continue;
      const err = tg - c.t - off;
      if (Math.abs(err) < Math.abs(bestErr)) {
        best = c;
        bestErr = err;
      }
    }
    if (!best || Math.abs(bestErr) > CAPTURE) return;
    const h = s.lat8[fam];
    h.push(tg - best.t);
    if (h.length > LAT_N) h.shift();
    if (Math.abs(bestErr) > WIN.good) return; // 只进校准，不计分
    const ae = Math.abs(bestErr);
    judge(best, ae <= WIN.perfect ? 'perfect' : ae <= WIN.great ? 'great' : 'good', bestErr);
  }

  function judge(c, grade, err) {
    c.judged = grade;
    c.doneAt = s.vis;
    s.counts[grade]++;
    const before = multOf(s.combo);
    s.combo++;
    s.maxCombo = Math.max(s.maxCombo, s.combo);
    const mult = multOf(s.combo);
    s.score += POINTS[grade] * mult;
    api.setScore(s.score);
    const k = KINDS[c.kind];
    const text = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD' }[grade];
    const sub = grade === 'perfect' ? '' : err < 0 ? api.tr('早', 'early') : api.tr('晚', 'late');
    s.pops.push({ text, sub, color: grade === 'good' ? null : k.color, life: 1 });
    if (mult > before) s.banner = { text: `×${mult}`, sub: api.tr('倍率提升', 'Multiplier up'), life: 1.6, color: NEON.amber };
    s.sqAt = s.vis;
    s.sqAxis = k.fam === 'tilt' ? 'x' : k.fam === 'nod' ? 'y' : 'xy';
    s.hitAt = s.vis;
    s.hitColor = k.color;
    s.lit[c.kind] = s.vis;
    s.flash = grade === 'perfect' ? 1 : 0.5;
    s.flashColor = k.color;
    burst(c.kind, grade === 'perfect' ? 22 : 14);
    s.ripples.push({ color: k.color, life: 1, w: grade === 'perfect' ? 4 : 2.5 });
    hitSound(grade);
  }

  function miss(c) {
    c.judged = 'miss';
    c.doneAt = s.vis;
    s.counts.miss++;
    s.combo = 0;
    s.missAt = s.vis;
    s.pops.push({ text: 'MISS', sub: '', color: NEON.red, life: 1 });
    missSound();
  }

  let geo = { cx: 0, cy: 0, R: 50, L: 200 };
  function burst(kind, n) {
    const { cx, cy, R } = geo;
    const k = KINDS[kind];
    for (let i = 0; i < n; i++) {
      let x, y, a;
      if (kind === 'shake') {
        a = Math.random() * Math.PI * 2;
        x = cx + Math.cos(a) * R;
        y = cy + Math.sin(a) * R;
      } else {
        x = cx - k.dx * R;
        y = cy - k.dy * R;
        a = Math.atan2(-k.dy, -k.dx) + (Math.random() - 0.5) * 2.2;
      }
      const v = 80 + Math.random() * 260;
      s.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color: k.color, size: 2 + Math.random() * 3 });
    }
    if (s.parts.length > 240) s.parts.splice(0, s.parts.length - 240);
  }

  const offs = [
    input.on('nod', (e) => onGesture(e.dir === 'up' ? 'up' : 'down')),
    input.on('tilt', (e) => onGesture(e.side === 'right' ? 'right' : 'left')),
    input.on('shake', () => onGesture('shake')),
  ];

  // ---------- 每帧 ----------

  function update(dt) {
    const tn = songNow();
    // 画面时钟：音频时钟在有的浏览器里一跳一跳的，这里按帧推进、慢慢向它靠拢
    if (!s.visInit || Math.abs(tn - s.vis) > 0.08) {
      s.vis = tn;
      s.visInit = true;
    } else s.vis += dt + (tn - s.vis) * 0.2;
    if (!s.audioOn) schedule();
    // Miss：过了“拍点 + 补偿 + 300 ms”还没做
    for (let i = s.cueLo; i < cues.length; i++) {
      const c = cues[i];
      if (c.t > tn) break;
      if (!c.judged && tn > c.t + latency(KINDS[c.kind].fam) + WIN.good) miss(c);
    }
    while (s.cueLo < cues.length && cues[s.cueLo].judged) s.cueLo++;
    while (s.dLo < cues.length && cues[s.dLo].judged && s.vis - cues[s.dLo].doneAt > 0.5) s.dLo++;
    // 画面走到哪一拍、哪一段
    while (s.vp < steps.length && steps[s.vp].t <= s.vis) {
      const st = steps[s.vp++];
      if (st.s % 4 === 0) {
        s.beatAt = st.t;
        s.beatStrong = st.s === 0 ? 1 : 0.6;
      }
      if (st.s === 0 && st.lb === 0 && st.si > 0) {
        const sec = SECTIONS[st.si];
        s.banner = { text: sec.name[lang()], sub: `${sec.bpm} BPM`, life: 1.6, color: sec.color };
      }
      s.bar = st.bar;
      s.si = st.si;
    }
    while (s.bp < beats.length && beats[s.bp].t <= s.vis) s.bp++;
    if (!s.done && tn > song.length + 0.3 && s.cueLo >= cues.length) {
      s.done = true;
      const { perfect, great, good, miss: m } = s.counts;
      const acc = accuracy().toFixed(1);
      api.finish({
        score: s.score,
        stats: api.tr(`Perfect ${perfect} · Great ${great} · Good ${good} · Miss ${m} · 准确率 ${acc}%`, `Perfect ${perfect} · Great ${great} · Good ${good} · Miss ${m} · accuracy ${acc}%`),
      });
    }
  }

  function accuracy() {
    const c = s.counts;
    const n = c.perfect + c.great + c.good + c.miss;
    return n ? ((c.perfect * ACC.perfect + c.great * ACC.great + c.good * ACC.good) / n) * 100 : 100;
  }

  function frame(dt) {
    if (!s.started) {
      s.countdown -= dt;
      if (Math.ceil(s.countdown) !== Math.ceil(s.countdown + dt)) sound.tick(s.countdown <= 0);
      if (s.countdown <= 0) start();
    }
    if (s.started) update(dt);
    draw(dt);
  }

  // ---------- 画 ----------

  function draw(dt) {
    const { g, w, h } = api;
    const c = api.colors;
    const dark = api.dark;
    const bottom = h - 48;
    const cx = w / 2;
    const cy = (TOP + bottom) / 2;
    const R = clamp(Math.min(w, bottom - TOP) * 0.085, 34, 62);
    const L = Math.max(80, Math.min((bottom - TOP) / 2 - 28, w / 2 - 36) - R);
    geo = { cx, cy, R, L };
    const S = clamp(R * 0.68, 24, 40);
    const sec = SECTIONS[s.si];
    const vis = s.vis;
    const pulse = s.started ? Math.exp(-Math.max(0, vis - s.beatAt) * 7) * s.beatStrong : 0;
    const playing = s.started && vis < song.length + 0.3;

    // 背景：底色 + 跟着鼓点一亮一亮的中心光
    g.fillStyle = c.bg;
    g.fillRect(0, 0, w, h);
    const gr = g.createRadialGradient(cx, cy, R * 0.5, cx, cy, Math.max(w, h) * 0.62);
    gr.addColorStop(0, rgba(sec.color, (dark ? 0.2 : 0.16) * (0.4 + sec.int * 0.6) * (0.55 + 0.75 * pulse)));
    gr.addColorStop(1, rgba(sec.color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);

    // 底部的“频谱”：假的，但跟着拍子跳
    if (s.started) {
      const n = 40;
      const bw = w / n;
      g.fillStyle = rgba(sec.color, dark ? 0.13 : 0.2);
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const bell = Math.exp(-((u - 0.5) ** 2) * 6);
        const wob = 0.5 + 0.5 * Math.sin(i * 1.7 + vis * 3.1) * Math.sin(i * 0.63 - vis * 1.9);
        const bh = 4 + 46 * sec.int * (0.3 * wob + 0.7 * pulse * bell * (0.6 + 0.4 * wob));
        g.rect(i * bw + 1, h - 30 - bh, bw - 2, bh);
      }
      g.fill();
    }

    // 往里收的拍子圈：每一拍一圈，强拍更亮
    if (playing) {
      g.lineWidth = 1;
      for (let i = s.bp; i < beats.length; i++) {
        const b = beats[i];
        const ahead = b.t - vis;
        if (ahead > APPROACH) break;
        const f = ahead / APPROACH;
        const strong = b.s === 0;
        g.strokeStyle = dark ? `rgba(255,255,255,${(strong ? 0.16 : 0.07) * (1 - f)})` : `rgba(0,0,0,${(strong ? 0.13 : 0.06) * (1 - f)})`;
        g.beginPath();
        g.arc(cx, cy, R + f * L, 0, Math.PI * 2);
        g.stroke();
      }
    }

    // 四条轨道和圈上的四个落点
    for (const kind of LANES) {
      const k = KINDS[kind];
      const rx = cx - k.dx * R;
      const ry = cy - k.dy * R;
      g.strokeStyle = rgba(k.color, dark ? 0.16 : 0.3);
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(rx - k.dx * (S * 0.6), ry - k.dy * (S * 0.6));
      g.lineTo(cx - k.dx * (R + L + S), cy - k.dy * (R + L + S));
      g.stroke();
      const lit = clamp(1 - (vis - (s.lit[kind] ?? -9)) / 0.3, 0, 1);
      g.lineWidth = 2;
      g.strokeStyle = rgba(k.color, 0.5 + 0.5 * lit);
      roundRect(g, rx - S / 2, ry - S / 2, S, S, S * 0.28);
      g.fillStyle = dark ? 'rgba(10,10,14,0.85)' : 'rgba(255,255,255,0.9)';
      g.fill();
      if (lit) {
        g.fillStyle = rgba(k.color, 0.7 * lit);
        g.fill();
      }
      g.stroke();
      arrow(g, rx, ry, S * 0.3, k.ang, rgba(k.color, 0.55 + 0.45 * lit));
    }

    // 中心的圈：跟着拍子跳，命中时被“压扁”再弹回来，Miss 时抖一下
    const sqAge = vis - s.sqAt;
    const sq = sqAge < 0.7 ? Math.exp(-sqAge * 7) * Math.cos(sqAge * 30) : 0;
    let sx = 1;
    let sy = 1;
    if (s.sqAxis === 'y') { sy = 1 - 0.22 * sq; sx = 1 + 0.14 * sq; }
    else if (s.sqAxis === 'x') { sx = 1 - 0.22 * sq; sy = 1 + 0.14 * sq; }
    else { sx = sy = 1 - 0.16 * sq; }
    const missAge = vis - s.missAt;
    const jx = missAge < 0.35 ? Math.sin(missAge * 70) * 7 * Math.exp(-missAge * 9) : 0;
    const hitMix = clamp(1 - (vis - s.hitAt) / 0.35, 0, 1);
    const ringCol = missAge < 0.3 ? NEON.red : hitMix > 0 ? s.hitColor : NEON.violet;
    const rp = R * (1 + 0.07 * pulse);
    g.save();
    g.translate(cx + jx, cy);
    g.scale(sx, sy);
    g.fillStyle = dark ? 'rgba(10,10,16,0.55)' : 'rgba(255,255,255,0.6)';
    g.beginPath();
    g.arc(0, 0, rp - 2, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 3 + 2 * pulse + 2 * hitMix;
    g.strokeStyle = ringCol;
    glow(g, ringCol, dark ? 14 + 22 * Math.max(pulse, hitMix) : 8 + 10 * hitMix, () => g.stroke());
    g.restore();

    // 刚识别到的动作：圈外一道细光（不管对不对，让玩家知道动作被认到了）
    if (s.echo) {
      const a = 1 - (vis - s.echo.at) / 0.35;
      if (a > 0) {
        g.strokeStyle = rgba(KINDS[s.echo.kind].color, a * 0.8);
        g.lineWidth = 2;
        g.beginPath();
        g.arc(cx, cy, R + 8 + (1 - a) * 14, 0, Math.PI * 2);
        g.stroke();
      } else s.echo = null;
    }

    // 提示
    for (let i = s.dLo; i < cues.length; i++) {
      const cu = cues[i];
      const ahead = cu.t - vis;
      if (ahead > APPROACH + 0.2) break;
      if (cu.judged && cu.judged !== 'miss') continue;
      let a = clamp((APPROACH + 0.2 - ahead) / 0.3, 0, 1);
      const isMiss = cu.judged === 'miss';
      if (isMiss) a *= clamp(1 - (vis - cu.doneAt) / 0.45, 0, 1);
      if (a <= 0) continue;
      // 碰圈以后停在落点上等你的动作（动作做完才触发，所以会晚一点点）
      const d = R + Math.max(0, ahead / APPROACH) * L + (isMiss ? (vis - cu.doneAt) * 60 : 0);
      const near = Math.abs(ahead) < 0.12 ? 1.12 : 1;
      if (cu.kind === 'shake') {
        g.strokeStyle = isMiss ? rgba('#8e8e93', a) : rgba(NEON.amber, a);
        g.lineWidth = 4;
        g.setLineDash([10, 7]);
        g.beginPath();
        g.arc(cx, cy, d, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
        const q = Math.PI / 4;
        tile(g, cx + Math.cos(-q) * d, cy + Math.sin(-q) * d, S * 0.85 * near, 'shake', a, isMiss);
        tile(g, cx + Math.cos(Math.PI - q) * d, cy + Math.sin(Math.PI - q) * d, S * 0.85 * near, 'shake', a, isMiss);
      } else {
        const k = KINDS[cu.kind];
        tile(g, cx - k.dx * d, cy - k.dy * d, S * near, cu.kind, a, isMiss);
      }
    }

    // 命中涟漪、火花
    for (const r of s.ripples) {
      r.life -= dt * 2.4;
      if (r.life <= 0) continue;
      g.strokeStyle = rgba(r.color, r.life * 0.9);
      g.lineWidth = r.w;
      g.beginPath();
      g.arc(cx, cy, R + (1 - r.life) * R * 1.4, 0, Math.PI * 2);
      g.stroke();
    }
    s.ripples = s.ripples.filter((r) => r.life > 0);
    for (const p of s.parts) {
      p.life -= dt * 1.8;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - dt * 3;
      p.vy *= 1 - dt * 3;
      if (p.life <= 0) continue;
      g.globalAlpha = p.life;
      g.fillStyle = p.color;
      g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    g.globalAlpha = 1;
    s.parts = s.parts.filter((p) => p.life > 0);

    // 圈里：连击数
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (s.started && s.combo >= 2) {
      g.fillStyle = c.text;
      g.font = `600 ${Math.round(R * 0.52)}px "Unbounded Variable", sans-serif`;
      g.fillText(String(s.combo), cx + jx, cy - R * 0.08);
      g.fillStyle = c.text2;
      g.font = `500 ${Math.round(clamp(R * 0.2, 10, 13))}px -apple-system, "PingFang SC", sans-serif`;
      g.fillText(api.tr('连击', 'combo'), cx + jx, cy + R * 0.38);
    }

    // 判定字：圈的右上方，往上飘
    for (const p of s.pops) {
      p.life -= dt * 1.7;
      if (p.life <= 0) continue;
      const age = 1 - p.life;
      const sc = 0.7 + 0.3 * Math.min(1, age * 8);
      const px = cx + R * 1.35 + S * 0.6;
      const py = cy - R * 1.35 - S * 0.4 - age * 26;
      g.globalAlpha = Math.min(1, p.life * 1.6);
      g.fillStyle = p.color ?? c.text;
      g.font = `700 ${Math.round(20 * sc)}px "Unbounded Variable", sans-serif`;
      g.textAlign = 'left';
      g.fillText(p.text, px, py);
      if (p.sub) {
        g.fillStyle = c.text2;
        g.font = '500 12px -apple-system, "PingFang SC", sans-serif';
        g.fillText(p.sub, px, py + 20);
      }
    }
    g.globalAlpha = 1;
    s.pops = s.pops.filter((p) => p.life > 0);
    if (s.pops.length > 4) s.pops.splice(0, s.pops.length - 4);

    // 左上：准确率；右上：倍率
    if (s.started) {
      g.textBaseline = 'alphabetic';
      g.textAlign = 'left';
      g.fillStyle = c.text2;
      g.font = '500 12px -apple-system, "PingFang SC", sans-serif';
      g.fillText(api.tr('准确率', 'Accuracy'), 24, 112);
      g.fillStyle = c.text;
      g.font = '600 22px "Unbounded Variable", sans-serif';
      g.fillText(`${accuracy().toFixed(1)}%`, 24, 140);
      g.textAlign = 'right';
      g.fillStyle = c.text2;
      g.font = '500 12px -apple-system, "PingFang SC", sans-serif';
      g.fillText(api.tr('倍率', 'Multiplier'), w - 24, 112);
      const mult = multOf(s.combo);
      g.fillStyle = mult > 1 ? NEON.amber : c.text;
      g.font = '600 22px "Unbounded Variable", sans-serif';
      g.fillText(`×${mult}`, w - 24, 140);
    }

    // 段落 / 倍率横幅
    if (s.banner) {
      s.banner.life -= dt;
      const b = s.banner;
      if (b.life > 0) {
        const a = Math.min(1, b.life * 2, (1.6 - b.life) * 6);
        g.globalAlpha = a;
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        g.fillStyle = b.color;
        g.font = '600 22px "Unbounded Variable", -apple-system, "PingFang SC", sans-serif';
        g.fillText(b.text, cx, 124);
        g.fillStyle = c.text2;
        g.font = '500 12px -apple-system, "PingFang SC", sans-serif';
        g.fillText(b.sub, cx, 144);
        g.globalAlpha = 1;
      } else s.banner = null;
    }

    // 底部：进度条（带段落刻度）、段落名、剩余时间、延迟补偿读数
    const px0 = 24;
    const pw = w - 48;
    const prog = s.started ? clamp(vis / song.length, 0, 1) : 0;
    g.fillStyle = c.line;
    roundRect(g, px0, h - 20, pw, 4, 2);
    g.fill();
    g.fillStyle = sec.color;
    roundRect(g, px0, h - 20, Math.max(4, pw * prog), 4, 2);
    g.fill();
    g.fillStyle = c.text2;
    for (const se of SECTIONS.slice(1)) g.fillRect(px0 + (pw * se.start) / song.length - 0.5, h - 23, 1, 10);
    g.textBaseline = 'alphabetic';
    g.font = '500 11px -apple-system, "PingFang SC", sans-serif';
    g.textAlign = 'left';
    g.fillText(`${sec.name[lang()]} · ${sec.bpm} BPM`, px0, h - 30);
    g.textAlign = 'right';
    const left = Math.max(0, song.length - Math.max(0, vis));
    g.fillText(`${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`, px0 + pw, h - 30);
    if (s.started) {
      g.textAlign = 'center';
      const ms = (f) => Math.round(latency(f) * 1000);
      g.fillText(api.tr(`延迟补偿 点头 ${ms('nod')} · 歪头 ${ms('tilt')} · 摇头 ${ms('shake')} ms`, `Latency comp. nod ${ms('nod')} · tilt ${ms('tilt')} · shake ${ms('shake')} ms`), cx, h - 30);
    }

    // 开局：倒计时 + 动作图例（图例一直留到第一个提示快来）
    const firstCue = cues[0]?.t ?? 0;
    const legendA = !s.started ? 1 : clamp((firstCue - 0.9 - vis) / 0.5, 0, 1);
    if (legendA > 0) {
      g.globalAlpha = legendA;
      const items = ['down', 'up', 'left', 'right', 'shake'];
      const gap = Math.min(96, (w - 48) / items.length);
      const ly = Math.min(cy + R + L * 0.55, bottom - 40);
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      items.forEach((kind, i) => {
        const x = cx + (i - 2) * gap;
        tile(g, x, ly, 28, kind, 1, false);
        g.fillStyle = c.text2;
        g.font = '500 12px -apple-system, "PingFang SC", sans-serif';
        g.fillText(KINDS[kind].label[lang()], x, ly + 34);
      });
      g.fillStyle = c.text2;
      g.font = '500 14px -apple-system, "PingFang SC", sans-serif';
      g.fillText(api.tr('箭头碰到圆圈时做对应的动作，跟着鼓点来', 'Make the move as each arrow hits the ring — ride the beat'), cx, Math.max(TOP + 30, cy - R - L * 0.55));
      g.globalAlpha = 1;
    }
    if (!s.started) {
      g.fillStyle = c.text;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `600 ${Math.round(R * 0.9)}px "Unbounded Variable", sans-serif`;
      g.fillText(String(Math.max(1, Math.ceil(s.countdown))), cx, cy);
    }

    // 命中闪一下屏
    if (s.flash > 0) {
      g.fillStyle = rgba(s.flashColor, s.flash * (dark ? 0.07 : 0.09));
      g.fillRect(0, 0, w, h);
      s.flash = Math.max(0, s.flash - dt * 5);
    }
    if (missAge < 0.25) {
      const v = g.createRadialGradient(cx, cy, Math.min(w, h) * 0.3, cx, cy, Math.max(w, h) * 0.75);
      v.addColorStop(0, rgba(NEON.red, 0));
      v.addColorStop(1, rgba(NEON.red, 0.16 * (1 - missAge / 0.25)));
      g.fillStyle = v;
      g.fillRect(0, 0, w, h);
    }
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
  }

  return {
    frame,
    destroy() {
      for (const off of offs) off();
      if (s.timer) clearInterval(s.timer);
      s.timer = null;
      for (const x of live) {
        try { x.src.stop(0); } catch {}
      }
      live = [];
      for (const n of nodes) {
        try { n.disconnect(); } catch {}
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 画图小工具

const rgbCache = {};
function rgba(hex, a) {
  const v = (rgbCache[hex] ??= [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  return `rgba(${v[0]},${v[1]},${v[2]},${a})`;
}

/** 箭头：中心 (x, y)，u 是半长，ang 是朝向（0 向右，屏幕坐标） */
function arrow(g, x, y, u, ang, color) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = u * 0.42;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(-u, 0);
  g.lineTo(u * 0.2, 0);
  g.stroke();
  g.beginPath();
  g.moveTo(u, 0);
  g.lineTo(u * 0.05, -u * 0.72);
  g.lineTo(u * 0.05, u * 0.72);
  g.closePath();
  g.fill();
  g.restore();
}

/** 双头箭头 ↔ */
function arrow2(g, x, y, u, color) {
  g.save();
  g.translate(x, y);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = u * 0.36;
  g.beginPath();
  g.moveTo(-u * 0.4, 0);
  g.lineTo(u * 0.4, 0);
  g.stroke();
  for (const sgn of [1, -1]) {
    g.beginPath();
    g.moveTo(sgn * u, 0);
    g.lineTo(sgn * u * 0.25, -u * 0.6);
    g.lineTo(sgn * u * 0.25, u * 0.6);
    g.closePath();
    g.fill();
  }
  g.restore();
}

/** 一个提示方块：彩色圆角方块 + 深色箭头（蓝色上用白箭头），Miss 的变灰 */
function tile(g, x, y, S, kind, a, grey) {
  const k = KINDS[kind];
  const col = grey ? '#8e8e93' : k.color;
  g.globalAlpha = a * 0.22;
  g.fillStyle = col;
  roundRect(g, x - S * 0.72, y - S * 0.72, S * 1.44, S * 1.44, S * 0.42);
  g.fill();
  g.globalAlpha = a;
  roundRect(g, x - S / 2, y - S / 2, S, S, S * 0.28);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 1;
  g.stroke();
  const ink = kind === 'right' && !grey ? '#ffffff' : '#15151c';
  if (kind === 'shake') arrow2(g, x, y, S * 0.34, ink);
  else arrow(g, x, y, S * 0.3, k.ang, ink);
  g.globalAlpha = 1;
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 大厅卡片上的小图：一个跟着 96 BPM 跳的圈，四个方向轮流飞来箭头 */
function drawIcon(canvas, now, focus) {
  const g = canvas.getContext('2d');
  const sz = Math.min(canvas.clientWidth, canvas.clientHeight) || 80;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(sz * dpr)) canvas.width = canvas.height = Math.round(sz * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, sz, sz);
  const c = sz / 2;
  const beat = 60 / (focus ? 112 : 96);
  const t = now / 1000 / beat; // 以拍为单位
  const pulse = Math.exp(-(t - Math.floor(t)) * 5);
  const R = sz * 0.15;
  const L = sz * 0.3;
  const order = ['down', 'left', 'up', 'right'];
  order.forEach((kind, i) => {
    const k = KINDS[kind];
    g.strokeStyle = rgba(k.color, 0.18);
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(c - k.dx * R, c - k.dy * R);
    g.lineTo(c - k.dx * (R + L), c - k.dy * (R + L));
    g.stroke();
    // 每个箭头 4 拍一轮、错开 1 拍；前 2 拍在飞，正好在拍点碰圈
    const q = (((t + i) % 4) + 4) % 4;
    if (q < 2) {
      const d = R + (1 - q / 2) * L;
      tile(g, c - k.dx * d, c - k.dy * d, sz * 0.13, kind, Math.min(1, q * 2), false);
    }
  });
  g.strokeStyle = NEON.violet;
  g.lineWidth = 2 + 2 * pulse;
  glow(g, NEON.violet, 6 + 12 * pulse, () => {
    g.beginPath();
    g.arc(c, c, R * (1 + 0.1 * pulse), 0, Math.PI * 2);
    g.stroke();
  });
}
