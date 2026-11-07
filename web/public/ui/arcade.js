// 游戏厅：顶栏“游戏”打开的一层全屏界面。大厅里是几张游戏卡片，进去后一张全屏画布 + 顶部一条记分栏，
// 一局结束弹出结算（分数、最好成绩、这局的数据）。全程可以只用头：转头选游戏、点头开始，结算时点头再来一局。
//
// 游戏模块的接口（ui/games/*.js，export default）：
//   { id, title: {zh, en}, tagline: {zh, en}, how: {zh, en}, accent: '#hex', create(api) }
//   create(api) 返回 { frame(dt, now), resize?(w, h), destroy?() }，api 见下面 makeApi()。
//   可选：range {h, v}（转头范围）、nodCross、noScore（不显示记分栏）、noGestureChip（不闪手势提示）。
// 游戏开着的时候主场景暂停渲染（app.js 看 body.in-arcade），整块显卡留给游戏。
//
// 正前方：打开游戏厅、每局开始前，先“对准中心”——画面正中一个圆点，鼻尖对准、头稳住 0.6 秒，
// 把这时的朝向当正前方，整个游戏厅都以它为准。原来每局都拿“开局那一刻”的朝向当正前方，
// 点头选左边的卡片、倒计时结束时正看着左边，整局都往左偏，想看中间得一直往右转头。
// 耳机的水平漂移由 app.js 的漂移纠正接着管（游戏厅开着时也在跑）。

import { HeadInput, Sound, themeColors } from './games/kit.js';

const BEST_KEY = 'nodlink.arcade.best';
const CENTER_MS = 600; // 对准中心时头要稳住多久
const CENTER_STILL = 12; // 角速度低于这个（°/s）算稳住

export class Arcade {
  /** games：游戏模块列表；getPose()：最新的相对姿态 { h, v, r } 或 null；t：翻译函数；lang()：'zh' | 'en' */
  constructor(games, { getPose, t, lang, onOpen, onClose }) {
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.games = games;
    this.getPose = getPose;
    this.t = t;
    this.lang = lang;
    this.input = new HeadInput();
    this.sound = new Sound();
    this.open = false;
    this.game = null;
    this.mouse = null; // 模拟数据时，鼠标在游戏画面上的位置（-1…1）代替头
    this.centerPose = null; // 对准中心时定下的正前方（getPose 的坐标）
    this.centering = null;
    this.best = load();
    this.build();
  }

  // ---------- 界面 ----------

  build() {
    const el = document.createElement('section');
    el.className = 'arcade';
    el.hidden = true;
    el.setAttribute('aria-label', this.t('游戏'));
    el.innerHTML = `
      <canvas class="arcade-canvas"></canvas>
      <header class="arcade-bar">
        <button class="arcade-back" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span></span></button>
        <div class="arcade-title"></div>
        <div class="arcade-score"><span class="arcade-score-label"></span><b>0</b></div>
        <div class="arcade-best"><span></span><b>–</b></div>
      </header>
      <div class="arcade-hub">
        <div class="arcade-hub-head"><h2></h2><p></p></div>
        <div class="arcade-cards"></div>
      </div>
      <div class="arcade-result" hidden>
        <p class="arcade-result-kicker"></p>
        <h3 class="arcade-result-score">0</h3>
        <p class="arcade-result-best"></p>
        <p class="arcade-result-stats"></p>
        <div class="arcade-result-actions">
          <button class="arcade-again" type="button"></button>
          <button class="arcade-home" type="button"></button>
        </div>
        <p class="arcade-result-hint"></p>
      </div>
      <div class="arcade-center" hidden><i aria-hidden="true"></i><p></p><small></small></div>
      <div class="arcade-nodata" hidden></div>
      <div class="arcade-gesture" aria-live="polite"></div>`;
    document.body.append(el);
    this.el = el;
    this.canvas = el.querySelector('.arcade-canvas');
    this.g = this.canvas.getContext('2d');
    this.cards = el.querySelector('.arcade-cards');
    for (const game of this.games) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'arcade-card';
      c.style.setProperty('--accent', game.accent);
      c.dataset.id = game.id;
      c.innerHTML = '<canvas aria-hidden="true"></canvas><b></b><span></span><em></em><i class="arcade-card-best"></i>';
      c.onclick = () => this.play(game.id);
      this.cards.append(c);
    }
    el.querySelector('.arcade-back').onclick = () => (!this.direct && (this.game || this.el.classList.contains('playing')) ? this.home() : this.close());
    el.querySelector('.arcade-again').onclick = () => this.play(this.lastId);
    el.querySelector('.arcade-home').onclick = () => this.home();
    // 模拟数据时用鼠标当头：鼠标在画面上的位置换成 -1…1
    el.addEventListener('pointermove', (e) => {
      this.mouse = { x: (e.clientX / innerWidth) * 2 - 1, y: (e.clientY / innerHeight) * 2 - 1 };
    });
    el.addEventListener('pointerleave', () => { this.mouse = null; });
    // 按键：Esc 退出，C 重新定正前方；其他键不漏给主场景（空格是离合）。[ ] 留给模拟歪头
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.key === '[' || e.key === ']') return;
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!this.direct && (this.game || this.el.classList.contains('playing'))) this.home();
        else this.close();
      } else if (this.centering && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        this.centerDone(this.getPose()); // 跳过：就用现在的朝向
      } else if (e.key === 'c' || e.key === 'C') this.recentered();
      else if (e.key === 'Enter' && !this.el.querySelector('.arcade-result').hidden) this.play(this.lastId);
      else this.game?.inst?.key?.(e);
    }, true);
    // 头控大厅：转头选卡片、点头开始；结算时点头再来一局、摇头回大厅
    this.input.on('nod', (e) => {
      if (!this.open || this.centering || e.dir !== 'down') return;
      if (!this.game && this.focus != null) this.play(this.games[this.focus].id);
      else if (this.game?.over && performance.now() - this.game.overAt > 900) this.play(this.lastId);
    });
    this.input.on('shake', () => {
      if (this.open && !this.centering && this.game?.over && performance.now() - this.game.overAt > 900) this.home();
    });
    // 认出手势就在底部亮一下，玩的人知道“刚才那下算了”
    const chip = el.querySelector('.arcade-gesture');
    let chipTimer = 0;
    const flash = (name) => {
      if (!this.open || this.game?.def.noGestureChip) return;
      chip.textContent = this.t(name);
      chip.classList.remove('on');
      void chip.offsetWidth; // 连着两下也重新亮
      chip.classList.add('on');
      clearTimeout(chipTimer);
      chipTimer = setTimeout(() => chip.classList.remove('on'), 650);
    };
    this.input.on('nod', (e) => flash(e.dir === 'down' ? '点头' : '抬头'));
    this.input.on('tilt', (e) => flash(e.side === 'left' ? '向左歪头' : '向右歪头'));
    this.input.on('shake', () => flash('摇头'));
    new ResizeObserver(() => this.resize()).observe(el);
    this.relabel();
  }

  relabel() {
    const t = this.t;
    const L = this.lang() === 'en' ? 'en' : 'zh';
    const q = (s) => this.el.querySelector(s);
    q('.arcade-back span').textContent = t('返回');
    q('.arcade-hub-head h2').textContent = t('体感游戏');
    q('.arcade-hub-head p').textContent = t('转头选一个，点头开始。也可以直接点。');
    q('.arcade-score-label').textContent = t('得分');
    q('.arcade-best span').textContent = t('最好');
    q('.arcade-again').textContent = t('再来一局');
    q('.arcade-home').textContent = t('返回大厅');
    q('.arcade-result-hint').textContent = t('点头再来一局 · 摇头返回大厅');
    q('.arcade-center p').textContent = t('鼻尖对准中间的圆点，稳住');
    q('.arcade-center small').textContent = t('用来定正前方，游戏里都以它为准 · 按空格跳过');
    for (const c of this.cards.children) {
      const game = this.games.find((g) => g.id === c.dataset.id);
      c.querySelector('b').textContent = game.title[L];
      c.querySelector('span').textContent = game.tagline[L];
      c.querySelector('em').textContent = game.how[L];
      const best = this.best[game.id];
      c.querySelector('.arcade-card-best').textContent = best ? `${t('最好')} ${best}` : t('还没玩过');
    }
    if (this.game) q('.arcade-title').textContent = this.game.def.title[L];
  }

  /** id：直接进这个游戏（顶栏的快捷入口），返回时关掉整个游戏厅而不是回大厅 */
  show(id = null) {
    this.direct = !!id;
    this.open = true;
    this.el.hidden = false;
    document.body.classList.add('in-arcade');
    this.onOpen?.();
    // 全屏玩：盖住顶栏、程序坞和别的窗口，沉浸一些（浏览器不让就算了）
    if (!document.fullscreenElement) this.el.requestFullscreen?.().catch(() => {});
    this.resize(); // 先定好画布尺寸，第一帧就能画
    this.home();
    if (id) this.play(id);
    else this.center(null);
    this.loop();
  }

  // ---------- 正前方 ----------

  /** 对准中心，定好正前方后接着做 then() */
  center(then) {
    this.centering = { then, buf: [] };
    this.el.classList.add('centering');
    const box = this.el.querySelector('.arcade-center');
    box.hidden = false;
    box.style.setProperty('--p', 0);
  }

  /** 每帧：头稳住就攒样本，一动就重来 */
  centerTick(now, pose) {
    const c = this.centering;
    if (pose && this.input.ok && Math.hypot(this.input.vh, this.input.vv) < CENTER_STILL) c.buf.push({ t: now, ...pose });
    else c.buf = [];
    const held = c.buf.length ? now - c.buf[0].t : 0;
    this.el.querySelector('.arcade-center').style.setProperty('--p', Math.min(held / CENTER_MS, 1));
    if (held >= CENTER_MS) this.centerDone(meanPose(c.buf));
  }

  centerDone(pose) {
    const c = this.centering;
    if (!c) return;
    this.cancelCenter();
    if (pose) this.centerPose = { h: pose.h, v: pose.v, r: pose.r };
    this.rezero();
    if (pose) this.sound.tick(true);
    c.then?.();
  }

  cancelCenter() {
    this.centering = null;
    this.el.classList.remove('centering');
    this.el.querySelector('.arcade-center').hidden = true;
  }

  /** 手势状态清零，正前方用对准中心时定的 */
  rezero() {
    this.input.reset();
    if (this.centerPose) this.input.zero = { ...this.centerPose };
  }

  /** 按 C、说“回中”：此刻的朝向就是正前方 */
  recentered() {
    this.centerPose = null;
    this.input.reset(); // 下一帧的朝向成为正前方，loop 里再记成 centerPose
  }

  close() {
    this.stopGame();
    this.open = false;
    this.el.hidden = true;
    document.body.classList.remove('in-arcade');
    cancelAnimationFrame(this.raf);
    if (document.fullscreenElement === this.el) document.exitFullscreen?.().catch(() => {});
    this.onClose?.();
  }

  home() {
    this.cancelCenter();
    this.stopGame();
    this.input.rangeH = 22;
    this.input.rangeV = 13;
    this.el.classList.remove('playing', 'no-score');
    this.el.querySelector('.arcade-result').hidden = true;
    this.el.querySelector('.arcade-title').textContent = '';
    this.relabel();
    this.rezero();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.size = { w, h, dpr };
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.game?.inst?.resize?.(w, h);
  }

  // ---------- 一局 ----------

  play(id) {
    const def = this.games.find((g) => g.id === id);
    if (!def) return;
    this.stopGame();
    this.lastId = id;
    this.el.classList.add('playing');
    this.el.classList.toggle('no-score', !!def.noScore); // 不计分的（奶蛙）不显示记分栏
    this.el.querySelector('.arcade-result').hidden = true;
    // 这个游戏要的转头范围（声纳要转到身后，别的只在屏幕前）：决定 x / y 的归一化，模拟时鼠标也按它换算
    this.input.rangeH = def.range?.h ?? 22;
    this.input.rangeV = def.range?.v ?? 13;
    // 点头时左右能动多少还算点头（跑酷要边换道边滑铲，放得最宽）
    this.input.nodCross = def.nodCross ?? 0.6;
    this.sound.ac; // 点击 / 按键时创建音频，浏览器才允许出声
    const L = this.lang() === 'en' ? 'en' : 'zh';
    this.el.querySelector('.arcade-title').textContent = def.title[L];
    this.setScore(0);
    this.el.querySelector('.arcade-best b').textContent = this.best[id] ?? '–';
    // 先对准中心，再开局
    this.center(() => {
      const game = { def, over: false, overAt: 0, score: 0 };
      this.game = game;
      game.inst = def.create(this.makeApi(game));
      this.resize();
    });
  }

  stopGame() {
    if (!this.game) return;
    this.game.inst?.destroy?.();
    this.game = null;
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.resize();
  }

  makeApi(game) {
    const self = this;
    return {
      get canvas() { return self.canvas; },
      /** 游戏厅的根元素：要自己的 WebGL 画布、界面时往这里加，destroy() 里删掉 */
      get root() { return self.el; },
      get g() { return self.g; },
      get w() { return self.size.w; },
      get h() { return self.size.h; },
      input: this.input,
      sound: this.sound,
      get dark() {
        const r = document.documentElement;
        return r.dataset.theme === 'dark' || (!r.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
      },
      get colors() { return themeColors(this.dark); },
      get lang() { return self.lang() === 'en' ? 'en' : 'zh'; },
      /** 双语文字：tr('中文', 'English') */
      tr: (zh, en) => (self.lang() === 'en' ? en : zh),
      best: this.best[game.def.id] ?? 0,
      setScore: (n) => {
        game.score = n;
        self.setScore(n);
      },
      /** 一局结束：stats 是一行这局的数据（比如“命中 12 · 最长连击 5”） */
      finish: ({ score = game.score, stats = '' } = {}) => {
        if (game.over) return;
        game.over = true;
        game.overAt = performance.now();
        self.result(game, score, stats);
      },
    };
  }

  setScore(n) {
    this.el.querySelector('.arcade-score b').textContent = n;
  }

  result(game, score, stats) {
    const id = game.def.id;
    const prev = this.best[id] ?? 0;
    const record = score > prev;
    if (record) {
      this.best[id] = score;
      save(this.best);
      this.el.querySelector('.arcade-best b').textContent = score;
    }
    const q = (s) => this.el.querySelector(s);
    q('.arcade-result-kicker').textContent = record ? this.t('新纪录') : this.t('本局得分');
    q('.arcade-result-kicker').classList.toggle('record', record);
    q('.arcade-result-score').textContent = score;
    q('.arcade-result-best').textContent = record && prev ? this.t('上次最好 {n}', { n: prev }) : record ? '' : this.t('最好 {n}', { n: prev });
    q('.arcade-result-stats').textContent = stats;
    q('.arcade-result').hidden = false;
    if (record) this.sound.good(8);
  }

  // ---------- 每帧 ----------

  loop() {
    let last = performance.now();
    const step = (now) => {
      if (!this.open) return;
      this.raf = requestAnimationFrame(step);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const pose = this.getPose();
      this.input.update(now, pose);
      if (!this.centerPose && this.input.zero && !this.centering) this.centerPose = { ...this.input.zero }; // 按过 C
      const nodata = !this.input.ok;
      const tip = this.el.querySelector('.arcade-nodata');
      tip.hidden = !nodata;
      if (nodata) tip.textContent = this.t('没有头部数据：戴好 AirPods，或在“更多”里切到模拟数据（用鼠标代替头）');
      if (this.centering) {
        this.centerTick(now, pose);
        this.g.clearRect(0, 0, this.size.w, this.size.h);
      } else if (this.game) {
        if (!this.game.over || this.game.def.keepRunning) this.game.inst.frame(dt, now);
      } else this.hub(now);
    };
    this.raf = requestAnimationFrame(step);
  }

  /** 大厅：头往哪边转，哪张卡片亮；卡片上画一个小小的动态图标 */
  hub(now) {
    const n = this.games.length;
    const idx = Math.round(((this.input.x + 1) / 2) * (n - 1));
    const focus = this.input.ok ? Math.min(Math.max(idx, 0), n - 1) : null;
    if (focus !== this.focus) {
      this.focus = focus;
      [...this.cards.children].forEach((c, i) => c.classList.toggle('focus', i === focus));
    }
    // 背景：淡淡的网格随头轻轻移动
    const { w, h } = this.size;
    const g = this.g;
    const c = themeColors(document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches));
    g.clearRect(0, 0, w, h);
    g.strokeStyle = c.line;
    g.lineWidth = 1;
    const ox = (this.input.x * 30) % 48;
    const oy = (-this.input.y * 30) % 48;
    for (let x = ox - 48; x < w + 48; x += 48) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = oy - 48; y < h + 48; y += 48) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    [...this.cards.children].forEach((card, i) => this.games[i].icon?.(card.querySelector('canvas'), now, i === focus));
  }
}

/** 一串姿态的平均（水平角绕着第一个样本平均，跨过 ±180° 也不出错） */
function meanPose(buf) {
  if (!buf.length) return null;
  const w = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
  const h0 = buf[0].h;
  const m = (f) => buf.reduce((a, b) => a + f(b), 0) / buf.length;
  return { h: h0 + m((b) => w(b.h - h0)), v: m((b) => b.v), r: m((b) => b.r ?? 0) };
}

function load() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY)) ?? {}; } catch { return {}; }
}
function save(best) {
  try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch {}
}
