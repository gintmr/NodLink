// 试一试：顶栏“试一试”打开的一层全屏界面，用几个日常小场景体验 NodLink 能完成的操作。
// 不是挑战：每个场景几步就做完，做错了只提示，不罚分、不评级。
//
// 和游戏厅不同，这里不交还系统鼠标：头控、语音指令、歪头按键都走真实的系统光标和键盘事件，
// 页面只看真实发生的点击、按键和输入。没接管鼠标时用普通鼠标也能走一遍。
//
//   关掉弹窗：5 个不同的窗口，每个要点的按钮都不一样（稍后、仅必要、不允许、保存、×）
//   刷短视频：下一条、点赞、打开评论、关掉评论（歪头用“抖音”场景）
//   回消息：点输入框，左歪头说一句话，右歪发送，再发个 👍（歪头用“语音输入”场景）
//   点外卖：选菜、选时间、说出备注、提交
//
// 每个场景切到合适的歪头场景（onLevel），退出时恢复。用时和步数存在本机，可以导出 JSON。
// 短视频是画布实时画的抽象画面，不用任何平台的素材和商标。

import { Sound } from './games/kit.js';

const RUNS_KEY = 'nodlink.tryit.runs';

const LEVELS = [
  { id: 'popups', title: '关掉弹窗', sub: '5 个窗口，每个点不同的按钮', tilt: null, icon: '<rect x="4" y="5" width="16" height="13" rx="2.5"/><path d="M4 9h16M15 13l3 3M18 13l-3 3"/>' },
  { id: 'feed', title: '刷短视频', sub: '下一条、双击点赞、单击暂停、开关评论', tilt: 'douyin', icon: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="m11 9.5 3 2.5-3 2.5z"/>' },
  { id: 'chat', title: '回消息', sub: '说一句话发出去，再回个 👍', tilt: 'dictate', icon: '<path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 4v-4h0A2 2 0 0 1 5 13Z"/>' },
  { id: 'order', title: '点外卖', sub: '选菜、选时间、说备注、下单', tilt: 'dictate', icon: '<path d="M6 4h12v16l-3-2-3 2-3-2-3 2Z"/><path d="M9 9h6M9 13h4"/>' },
];

const TILT_BADGE = {
  douyin: '歪头 · 抖音：左歪下一条，右歪评论',
  dictate: '歪头 · 语音输入：左歪按住说话，回正结束，右歪回车',
};

const fmt = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const h = (html) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const shake = (el) => {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
};

export class Challenge {
  /**
   * t：翻译函数；onOpen/onClose：打开、关闭时通知 app.js；
   * onLevel(tiltMode | null)：进入一个场景时切歪头场景，null 表示恢复原来的；
   * context()：记录用的环境信息（数据源、是否接管鼠标等）
   */
  constructor({ t, onOpen, onClose, onLevel, context }) {
    this.t = t;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onLevel = onLevel;
    this.context = context;
    this.sound = new Sound();
    this.open = false;
    this.level = null;
    this.idx = -1;
    this.results = [];
    this.single = false; // 从卡片单独进一个场景：做完回到首页，不往下走
    this.build();
  }

  // ---------- 外壳 ----------

  build() {
    const t = this.t;
    const el = h(`<section class="challenge" hidden aria-label="${t('试一试')}">
      <header class="ch-bar">
        <button class="ch-back" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span>${t('退出')}</span></button>
        <ol class="ch-steps">${LEVELS.map((l, i) => `<li data-i="${i}"><b>${i + 1}</b><span>${t(l.title)}</span></li>`).join('')}</ol>
        <div class="ch-clock"><span>${t('用时')}</span><b>0.0s</b></div>
      </header>
      <div class="ch-task" hidden><p class="ch-task-text"></p><p class="ch-task-hint"></p><span class="ch-tilt" hidden></span></div>
      <div class="ch-stage"></div>
      <div class="ch-intro">
        <p class="ch-kicker">NodLink · ${t('试一试')}</p>
        <h2>${t('不碰键鼠，日常操作照样做。')}</h2>
        <p class="ch-lede">${t('头指位置，说“点击”就点；歪头用来说话、刷视频。四个小场景，每个几步就完成。')}</p>
        <div class="ch-cards">${LEVELS.map((l, i) => `<button type="button" class="ch-card" data-i="${i}"><svg viewBox="0 0 24 24" aria-hidden="true">${l.icon}</svg><em>${i + 1}</em><h3>${t(l.title)}</h3><p>${t(l.sub)}</p></button>`).join('')}</div>
        <button class="ch-go ch-start" type="button">${t('从第一个开始')}</button>
        <p class="ch-note"></p>
      </div>
      <div class="ch-between" hidden>
        <span class="ch-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 12.5 4 4 8-9"/></svg></span>
        <p class="ch-kicker"></p><h2></h2>
        <div class="ch-actions"><button class="ch-go ch-next" type="button"></button><button class="ch-ghost ch-redo" type="button">${t('再做一次')}</button></div>
      </div>
      <div class="ch-report" hidden></div>
    </section>`);
    document.body.append(el);
    this.el = el;
    this.stage = el.querySelector('.ch-stage');
    this.taskEl = el.querySelector('.ch-task');
    this.clockEl = el.querySelector('.ch-clock b');
    el.querySelector('.ch-back').onclick = () => (this.idx >= 0 && this.idx < LEVELS.length ? this.home() : this.hide());
    el.querySelector('.ch-start').onclick = () => this.start();
    el.querySelectorAll('.ch-card').forEach((c) => {
      c.onclick = () => this.start(Number(c.dataset.i), true);
    });
    el.querySelector('.ch-next').onclick = () => this.next();
    el.querySelector('.ch-redo').onclick = () => this.play(this.idx);
    // 场景里的空点（没点在任何可点的东西上），记下来备查
    this.stage.addEventListener('pointerdown', (e) => {
      if (!this.level || this.level.finished) return;
      if (!e.target.closest('button, input, textarea, canvas, [data-hit]')) this.level.empty = (this.level.empty ?? 0) + 1;
    }, true);
    // 打开时按键先给场景（下一条、评论、空格暂停），不漏给主场景
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.key === 'Escape') return; // Esc 照旧交给头控（交还鼠标）
      if (this.level?.key?.(e)) {
        e.preventDefault();
        e.stopPropagation();
      } else if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.key === ' ') {
        e.preventDefault(); // 空格不要变成“离合”
        e.stopPropagation();
      }
    }, true);
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.el.hidden = false;
    document.body.classList.add('in-challenge');
    this.home();
    this.onOpen?.();
    this.tick();
  }

  hide() {
    if (!this.open) return;
    this.endLevel();
    this.open = false;
    this.el.hidden = true;
    document.body.classList.remove('in-challenge');
    cancelAnimationFrame(this.raf);
    this.onLevel?.(null);
    this.onClose?.();
  }

  home() {
    this.endLevel();
    this.onLevel?.(null);
    this.idx = -1;
    this.results = [];
    this.view('intro');
    const ctx = this.context?.() ?? {};
    this.el.querySelector('.ch-note').textContent = ctx.control
      ? this.t('头控已接管鼠标：说“点击”点按钮，歪头按各场景的提示来。点卡片可以单独做一个场景。')
      : this.t('还没接管鼠标，现在用鼠标也能走一遍。要演示头控，先在调试台里“开始头控”。');
    this.steps();
  }

  view(name) {
    for (const v of ['intro', 'between', 'report']) this.el.querySelector(`.ch-${v}`).hidden = v !== name;
    this.el.classList.toggle('playing', name === 'play');
    this.taskEl.hidden = name !== 'play';
  }

  steps() {
    this.el.querySelectorAll('.ch-steps li').forEach((li, i) => {
      li.classList.toggle('on', i === this.idx);
      li.classList.toggle('done', this.results.some((r) => r.id === LEVELS[i].id));
    });
  }

  start(i = 0, single = false) {
    this.results = [];
    this.single = single;
    this.play(i);
  }

  next() {
    if (this.single || this.idx + 1 >= LEVELS.length) return this.single ? this.home() : this.report();
    this.play(this.idx + 1);
  }

  play(i) {
    this.endLevel();
    this.idx = i;
    const def = LEVELS[i];
    this.view('play');
    this.steps();
    this.onLevel?.(def.tilt);
    const badge = this.el.querySelector('.ch-tilt');
    badge.hidden = !def.tilt;
    badge.textContent = def.tilt ? this.t(TILT_BADGE[def.tilt]) : '';
    const Kind = { popups: Popups, feed: Feed, chat: Chat, order: Order }[def.id];
    const api = {
      t: this.t,
      sound: this.sound,
      task: (text, hint = '') => this.task(text, hint),
      done: () => this.levelDone(),
    };
    this.level = new Kind(this.stage, api);
    this.level.startedAt = performance.now();
    this.level.begin?.();
  }

  task(text, hint) {
    const el = this.taskEl;
    el.querySelector('.ch-task-text').textContent = text;
    el.querySelector('.ch-task-hint').textContent = hint;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  levelDone() {
    const lv = this.level;
    if (!lv || lv.finished) return;
    lv.finished = true;
    const ms = performance.now() - lv.startedAt;
    const def = LEVELS[this.idx];
    const res = { id: def.id, title: def.title, ms, empty: lv.empty ?? 0, ...lv.summary() };
    this.results = this.results.filter((r) => r.id !== def.id).concat(res);
    this.steps();
    this.sound.tone(660, 0.1, { vol: 0.18 });
    this.sound.tone(990, 0.16, { vol: 0.18, when: 0.1 });
    setTimeout(() => {
      if (!this.open || this.level !== lv) return;
      this.endLevel();
      const b = this.el.querySelector('.ch-between');
      b.querySelector('.ch-kicker').textContent = this.t('{name} · 完成', { name: this.t(def.title) });
      b.querySelector('h2').textContent = this.t('{n} 步 · {t}', { n: res.steps, t: fmt(res.ms) });
      const last = this.idx === LEVELS.length - 1;
      b.querySelector('.ch-next').textContent = this.single ? this.t('回到首页') : last ? this.t('看总结') : this.t('下一个：{name}', { name: this.t(LEVELS[this.idx + 1].title) });
      this.view('between');
    }, 700);
  }

  endLevel() {
    this.level?.destroy?.();
    this.level = null;
    this.stage.replaceChildren();
  }

  // ---------- 总结 ----------

  report() {
    this.endLevel();
    this.onLevel?.(null);
    const total = this.results.reduce((s, r) => s + r.ms, 0);
    const steps = this.results.reduce((s, r) => s + r.steps, 0);
    const run = { app: 'NodLink', kind: 'tryit', format: 1, at: new Date().toISOString(), context: this.context?.() ?? {}, totalMs: total, steps, levels: this.results };
    const runs = loadRuns();
    runs.push(run);
    saveRuns(runs);
    const r = this.el.querySelector('.ch-report');
    r.innerHTML = `
      <span class="ch-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 12.5 4 4 8-9"/></svg></span>
      <p class="ch-kicker">${this.t('四个场景都完成了')}</p>
      <div class="ch-total"><b>${fmt(total)}</b></div>
      <p class="ch-lede">${run.context.control ? this.t('{n} 步操作，全程靠头和声音', { n: steps }) : this.t('{n} 步操作', { n: steps })}</p>
      <div class="ch-tiles">${this.results.map((res, i) => `<div class="ch-tile"><em>${i + 1}</em><h3>${esc(this.t(res.title))}</h3><b>${fmt(res.ms)}</b><p>${esc(this.t('{n} 步', { n: res.steps }))}</p></div>`).join('')}</div>
      <div class="ch-actions"><button class="ch-go ch-again" type="button">${this.t('再试一次')}</button><button class="ch-ghost ch-export" type="button">${this.t('导出记录')}</button><button class="ch-ghost ch-exit" type="button">${this.t('返回调试台')}</button></div>`;
    r.querySelector('.ch-again').onclick = () => this.start();
    r.querySelector('.ch-export').onclick = () => exportRuns();
    r.querySelector('.ch-exit').onclick = () => this.hide();
    this.idx = LEVELS.length;
    this.steps();
    this.view('report');
  }

  tick() {
    if (!this.open) return;
    this.raf = requestAnimationFrame(() => this.tick());
    const lv = this.level;
    if (lv && !lv.finished) this.clockEl.textContent = fmt(performance.now() - lv.startedAt);
    lv?.frame?.(performance.now());
  }
}

function loadRuns() {
  try {
    return JSON.parse(localStorage.getItem(RUNS_KEY)) ?? [];
  } catch {
    return [];
  }
}
function saveRuns(runs) {
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(-200)));
  } catch {}
}
function exportRuns() {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'NodLink', kind: 'tryit-runs', exportedAt: new Date().toISOString(), runs: loadRuns() }, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `nodlink-tryit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 点击位置离元素中心多少像素（键盘、语音触发的点击没有位置，返回 null） */
function offset(e, el) {
  if (!e.clientX && !e.clientY) return null;
  const r = el.getBoundingClientRect();
  return Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
}

// ---------- 场景 1：关掉弹窗 ----------
// 一次只出一个，每个长得不一样、位置不一样、要点的按钮也不一样。
// 按钮写成 [文字, 样式]，样式里带 ok 的是要点的那个；'x' 表示右上角的关闭按钮。

const WINDOWS = [
  {
    kind: 'dialog', pos: 'center', icon: '⚙️', title: '软件更新', body: '新版本已经下载好，需要重启电脑才能安装。',
    buttons: [['稍后', 'ok'], ['立即重启', 'primary']], target: '稍后',
  },
  {
    kind: 'banner', pos: 'bottom', icon: '🍪', title: '这个网站使用 Cookie', body: '用来记住你的偏好、改善浏览体验。',
    buttons: [['设置', ''], ['仅必要', 'ok'], ['全部接受', 'primary']], target: '仅必要',
  },
  {
    kind: 'toast', pos: 'top-right', icon: '🔔', title: '“演示站”想给你发送通知', body: '包括新消息、提醒和推广信息。',
    buttons: [['不允许', 'ok'], ['允许', 'primary']], target: '不允许',
  },
  {
    kind: 'sheet', pos: 'top', icon: '📄', title: '要保存对“年度总结.docx”的更改吗？', body: '不保存的话，最近的修改会丢失。',
    buttons: [['不保存', ''], ['取消', ''], ['保存', 'ok primary']], target: '保存',
  },
  {
    kind: 'ad', pos: 'left', icon: '🎁', title: '限时福利', body: '新用户免费领 7 天会员，手慢无！',
    buttons: [['立即领取', 'primary big']], close: true, target: '×',
  },
];

class Popups {
  constructor(root, api) {
    this.api = api;
    this.i = 0;
    this.wrong = 0;
    this.offsets = [];
    this.root = root.appendChild(h('<div class="lv-popups"><div class="pp-desk"><span>NodLink</span></div></div>'));
  }

  begin() {
    this.show();
  }

  show() {
    const t = this.api.t;
    const w = WINDOWS[this.i];
    this.api.task(`${this.i + 1}/${WINDOWS.length} · ${w.target === '×' ? t('点右上角的 × 关掉广告') : t('点「{b}」', { b: t(w.target) })}`, t(w.title));
    const el = h(`<div class="pp-win pp-${w.kind} at-${w.pos}">
      ${w.close ? '<button class="pp-x ok" type="button" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' : ''}
      <div class="pp-icon" aria-hidden="true">${w.icon}</div>
      <div class="pp-text"><b>${esc(t(w.title))}</b><p>${esc(t(w.body))}</p></div>
      <div class="pp-foot">${w.buttons.map(([label, cls]) => `<button type="button" class="pp-b ${cls}">${esc(t(label))}</button>`).join('')}</div>
    </div>`);
    el.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', (e) => {
        if (this.cur !== el) return;
        if (b.classList.contains('ok')) this.close(el, e, b);
        else {
          this.wrong += 1;
          shake(el);
          this.api.sound.tone(220, 0.14, { type: 'triangle', vol: 0.12 });
        }
      });
    });
    this.root.appendChild(el);
    this.cur = el;
  }

  close(el, e, b) {
    const off = offset(e, b);
    if (off != null) this.offsets.push(off);
    this.cur = null;
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
    this.api.sound.tone(560 + this.i * 60, 0.08, { vol: 0.16 });
    this.i += 1;
    if (this.i >= WINDOWS.length) return this.api.done();
    setTimeout(() => this.show(), 320);
  }

  summary() {
    const off = this.offsets.length ? this.offsets.reduce((a, b) => a + b, 0) / this.offsets.length : null;
    return { steps: WINDOWS.length, wrong: this.wrong, offsetPx: off, offsets: this.offsets };
  }
}

// ---------- 场景 2：刷短视频 ----------

const CLIPS = [
  { by: '@晚风收集员', cap: '海边的晚霞，五分钟变了七种颜色', c: ['#ff7a59', '#7b2ff7'], kind: 'waves' },
  { by: '@小区猫猫观察', cap: '橘猫第 37 次试图跳上冰箱', c: ['#ffb347', '#ff5e62'], kind: 'bubbles' },
  { by: '@地铁通勤人', cap: '早高峰 8 号线，今天也挤上了', c: ['#00c6ff', '#0072ff'], kind: 'stripes' },
  { by: '@厨房小白', cap: '第一次做番茄炒蛋，结局意外', c: ['#f7971e', '#ffd200'], kind: 'orbit' },
  { by: '@夜跑日记', cap: '十公里打卡，配速 5 分 40', c: ['#11998e', '#38ef7d'], kind: 'stripes' },
  { by: '@宿舍音乐节', cap: '室友的吉他终于不跑调了', c: ['#fc466b', '#3f5efb'], kind: 'waves' },
  { by: '@云南慢游', cap: '洱海边骑车，风是甜的', c: ['#56ccf2', '#2f80ed'], kind: 'bubbles' },
  { by: '@城市夜景', cap: '凌晨三点的天桥，车流像星河', c: ['#232526', '#5b5e78'], kind: 'orbit' },
];
const COMMENTS = ['这也太好看了吧', '前排', '笑死，结局没想到', '已转发给室友', '求 BGM', '收藏了，下次试试', '第一次刷到这么治愈的', '博主更新快一点'];
const CLIP_S = 24; // 每条视频 24 秒

class Feed {
  constructor(root, api) {
    this.api = api;
    this.i = 0;
    this.vt = 0;
    this.paused = false;
    this.liked = new Set();
    this.comments = false;
    this.events = [];
    this.extra = 0; // 任务之外的动作（误触发也在里面），只记录不提示
    const t = api.t;
    this.root = root.appendChild(h(`<div class="lv-feed">
      <div class="fd-phone">
        <canvas class="fd-video"></canvas>
        <div class="fd-meta"><b></b><p></p></div>
        <div class="fd-side">
          <button class="fd-btn fd-like" type="button"><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/></svg><span></span></button>
          <button class="fd-btn fd-cmt" type="button"><svg viewBox="0 0 24 24"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 4v-4A2 2 0 0 1 5 13Z"/></svg><span></span></button>
          <button class="fd-btn fd-star" type="button"><svg viewBox="0 0 24 24"><path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6Z"/></svg><span>${t('收藏')}</span></button>
        </div>
        <div class="fd-paused" hidden><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7Z"/></svg></div>
        <div class="fd-heart" hidden><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/></svg></div>
        <div class="fd-bar"><i></i><span class="fd-time"></span></div>
        <div class="fd-drawer"><header><b>${t('评论')}</b><button class="fd-close" type="button" aria-label="${t('关闭评论')}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header><ul></ul></div>
      </div>
      <aside class="fd-legend">
        <p><kbd>${t('左歪')}</kbd>${t('下一条')}</p><p><kbd>${t('右歪')}</kbd>${t('评论区')}</p><p><kbd>${t('双击')}</kbd>${t('点赞')}</p><p><kbd>${t('点击')}</kbd>${t('暂停 / 播放')}</p>
      </aside>
    </div>`));
    this.canvas = this.root.querySelector('.fd-video');
    this.g = this.canvas.getContext('2d');
    this.tasks = [
      { id: 'next', text: '刷到下一条', hint: '左歪头（也可以说“下滑”）' },
      { id: 'like', text: '双击画面点赞', hint: '头指着画面，说“双击”或“点赞”' },
      { id: 'pause', text: '单击暂停', hint: '说“点击”' },
      { id: 'open', text: '打开评论区', hint: '右歪头' },
      { id: 'close', text: '关掉评论区', hint: '再右歪一次' },
    ];
    this.k = 0;
    this.wire();
    this.load();
  }

  wire() {
    const r = this.root;
    let clickTimer = null;
    this.canvas.addEventListener('click', () => {
      // 单击暂停、双击点赞：单击等一下，看是不是双击
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => this.togglePause(), 260);
    });
    this.canvas.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      this.like(true);
    });
    r.querySelector('.fd-like').onclick = () => this.like();
    r.querySelector('.fd-cmt').onclick = () => this.toggleComments();
    r.querySelector('.fd-close').onclick = () => this.toggleComments(false);
    r.querySelector('.fd-star').onclick = (e) => e.currentTarget.classList.toggle('on');
    r.querySelector('.fd-bar').addEventListener('pointerdown', (e) => {
      const b = e.currentTarget.getBoundingClientRect();
      this.vt = Math.min(Math.max((e.clientX - b.left) / b.width, 0), 1) * CLIP_S;
    });
    let wheelAt = 0;
    r.querySelector('.fd-phone').addEventListener('wheel', (e) => {
      e.preventDefault();
      const now = performance.now();
      if (Math.abs(e.deltaY) < 20 || now - wheelAt < 600) return;
      wheelAt = now;
      this.go(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  }

  begin() {
    this.showTask();
  }

  showTask() {
    const tk = this.tasks[this.k];
    const t = this.api.t;
    this.api.task(`${this.k + 1}/${this.tasks.length} · ${t(tk.text)}`, t(tk.hint));
  }

  /** 每个动作都报到这里：是当前任务要的就推进，不是就只记下来 */
  act(id) {
    this.events.push({ id, t: performance.now() });
    const tk = this.tasks[this.k];
    if (!tk) return;
    if (id !== tk.id) {
      this.extra += 1;
      return;
    }
    this.k += 1;
    this.api.sound.tone(700 + this.k * 40, 0.08, { vol: 0.15 });
    if (this.k >= this.tasks.length) return this.api.done();
    this.showTask();
  }

  key(e) {
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return false;
    if (e.key === 'ArrowDown') this.go(1);
    else if (e.key === 'ArrowUp') this.go(-1);
    else if (e.key === 'x' || e.key === 'X') this.toggleComments();
    else if (e.key === 'z' || e.key === 'Z') this.like();
    else if (e.key === ' ') this.togglePause();
    else return false;
    return true;
  }

  go(d) {
    if (this.i + d < 0) return this.act('prev');
    this.i += d;
    this.vt = 0;
    this.paused = false;
    this.toggleComments(false, true);
    this.root.querySelector('.fd-phone').animate([{ transform: `translateY(${d > 0 ? 40 : -40}px)`, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.32,.72,0,1)' });
    this.load();
    this.act(d > 0 ? 'next' : 'prev');
  }

  load() {
    const c = CLIPS[this.i % CLIPS.length];
    const r = this.root;
    r.querySelector('.fd-meta b').textContent = c.by;
    r.querySelector('.fd-meta p').textContent = this.api.t(c.cap);
    const base = 1200 + ((this.i * 977) % 9000);
    r.querySelector('.fd-like span').textContent = String(base + (this.liked.has(this.i) ? 1 : 0));
    r.querySelector('.fd-like').classList.toggle('on', this.liked.has(this.i));
    r.querySelector('.fd-cmt span').textContent = String(80 + ((this.i * 131) % 600));
    r.querySelector('.fd-star').classList.remove('on');
    r.querySelector('.fd-drawer ul').innerHTML = Array.from({ length: 6 }, (_, j) => `<li><i style="--h:${(this.i * 47 + j * 61) % 360}"></i><div><b>${this.api.t('用户')}${(this.i * 7 + j * 13) % 900 + 100}</b><p>${esc(this.api.t(COMMENTS[(this.i + j) % COMMENTS.length]))}</p></div></li>`).join('');
    r.querySelector('.fd-paused').hidden = true;
  }

  like(fromVideo = false) {
    const r = this.root;
    if (fromVideo) {
      const heart = r.querySelector('.fd-heart');
      heart.hidden = false;
      heart.getAnimations().forEach((a) => a.cancel());
      heart.animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.1)', opacity: 1, offset: 0.4 }, { transform: 'scale(1)', opacity: 0 }], { duration: 700 }).onfinish = () => { heart.hidden = true; };
    }
    const was = this.liked.has(this.i);
    if (was && !fromVideo) this.liked.delete(this.i);
    else this.liked.add(this.i);
    this.load();
    this.act(this.liked.has(this.i) ? 'like' : 'unlike');
  }

  toggleComments(on = !this.comments, quiet = false) {
    if (on === this.comments) return;
    this.comments = on;
    this.root.querySelector('.fd-drawer').classList.toggle('open', on);
    if (!quiet) this.act(on ? 'open' : 'close');
  }

  togglePause() {
    this.paused = !this.paused;
    this.root.querySelector('.fd-paused').hidden = !this.paused;
    this.act(this.paused ? 'pause' : 'play');
  }

  frame(now) {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    if (!this.paused) this.vt = (this.vt + dt) % CLIP_S;
    const cv = this.canvas;
    const w = cv.clientWidth;
    const hh = cv.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hh * dpr);
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawClip(g, w, hh, CLIPS[this.i % CLIPS.length], this.vt, this.i);
    this.root.querySelector('.fd-bar i').style.width = `${(this.vt / CLIP_S) * 100}%`;
    const s = Math.floor(this.vt);
    this.root.querySelector('.fd-time').textContent = `0:${String(s).padStart(2, '0')} / 0:${CLIP_S}`;
  }

  summary() {
    return { steps: this.tasks.length, extra: this.extra, events: this.events };
  }
}

/** 一条“视频”：渐变底 + 随时间动的抽象图形。暂停时 vt 不走，画面就停住 */
function drawClip(g, w, h, c, vt, seed) {
  const gr = g.createLinearGradient(0, 0, w * 0.4, h);
  gr.addColorStop(0, c.c[0]);
  gr.addColorStop(1, c.c[1]);
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  g.save();
  const T = vt;
  if (c.kind === 'waves') {
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      const y0 = h * (0.45 + k * 0.1);
      g.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) g.lineTo(x, y0 + Math.sin(x / (40 + k * 12) + T * (0.8 + k * 0.3) + seed) * (14 + k * 4));
      g.lineTo(w, h);
      g.fillStyle = `rgba(255,255,255,${0.08 + k * 0.03})`;
      g.fill();
    }
    g.beginPath();
    g.arc(w * 0.3, h * 0.26 + Math.sin(T * 0.3) * 10, w * 0.11, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,240,200,.85)';
    g.fill();
  } else if (c.kind === 'bubbles') {
    for (let k = 0; k < 14; k++) {
      const x = (((k * 97 + seed * 31) % 100) / 100) * w;
      const y = h - (((T * (18 + (k % 5) * 9) + k * 70) % (h + 80)) - 40);
      g.beginPath();
      g.arc(x + Math.sin(T + k) * 12, y, 8 + (k % 4) * 9, 0, Math.PI * 2);
      g.fillStyle = `rgba(255,255,255,${0.12 + (k % 3) * 0.08})`;
      g.fill();
    }
  } else if (c.kind === 'stripes') {
    g.translate(w / 2, h / 2);
    g.rotate(-0.35);
    for (let k = -12; k < 12; k++) {
      const x = ((k * 46 + T * 60) % (46 * 24)) - 46 * 12;
      g.fillStyle = `rgba(255,255,255,${k % 2 ? 0.1 : 0.04})`;
      g.fillRect(x, -h, 22, h * 2);
    }
  } else {
    g.translate(w / 2, h * 0.42);
    for (let k = 0; k < 7; k++) {
      const a = T * (0.5 + k * 0.12) + k;
      const rr = 30 + k * 18;
      g.beginPath();
      g.arc(Math.cos(a) * rr, Math.sin(a) * rr, 5 + k * 1.5, 0, Math.PI * 2);
      g.fillStyle = `rgba(255,255,255,${0.25 + k * 0.08})`;
      g.fill();
      g.beginPath();
      g.arc(0, 0, rr, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,255,255,.08)';
      g.stroke();
    }
  }
  g.restore();
  // 底部压暗，文字看得清
  const sh = g.createLinearGradient(0, h * 0.55, 0, h);
  sh.addColorStop(0, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(0,0,0,.55)');
  g.fillStyle = sh;
  g.fillRect(0, h * 0.55, w, h * 0.45);
}

// ---------- 场景 3：回消息 ----------

const EMOJIS = ['😀', '😂', '🥹', '😎', '🤔', '😴', '👍', '👏', '🙏', '🎉', '❤️', '🔥'];

class Chat {
  constructor(root, api) {
    this.api = api;
    const t = api.t;
    this.rounds = [
      { from: '到哪儿了？大概几点能到？', want: 'text', text: '用说的回复小林', hint: '点输入框 → 左歪头说一句话 → 回正 → 右歪发送' },
      { from: '好嘞，回我个 👍', want: '👍', text: '回一个 👍', hint: '点输入框旁边的笑脸，再点 👍' },
    ];
    this.r = 0;
    this.chars = 0;
    this.wrong = 0;
    this.root = root.appendChild(h(`<div class="lv-chat">
      <div class="ct-win">
        <header><i class="ct-av">林</i><div><b>${t('小林')}</b><span class="ct-status">${t('在线')}</span></div></header>
        <ul class="ct-list"></ul>
        <div class="ct-emoji" hidden>${EMOJIS.map((e) => `<button type="button">${e}</button>`).join('')}</div>
        <form class="ct-compose">
          <textarea rows="1" placeholder="${t('点这里，然后左歪头说话')}"></textarea>
          <button class="ct-face" type="button" aria-label="${t('表情')}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M9 10h.01M15 10h.01M8.5 14a4 4 0 0 0 7 0"/></svg></button>
          <button class="ct-send" type="submit">${t('发送')}</button>
        </form>
      </div>
    </div>`));
    this.list = this.root.querySelector('.ct-list');
    this.input = this.root.querySelector('textarea');
    this.root.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.send(this.input.value);
    });
    this.input.addEventListener('keydown', (e) => {
      // 输入法还在组字时的回车是确认候选，不是发送
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this.send(this.input.value);
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
    });
    this.root.querySelector('.ct-face').onclick = () => {
      const p = this.root.querySelector('.ct-emoji');
      p.hidden = !p.hidden;
    };
    this.root.querySelectorAll('.ct-emoji button').forEach((b) => {
      b.onclick = () => {
        this.root.querySelector('.ct-emoji').hidden = true;
        this.send(b.textContent);
      };
    });
  }

  begin() {
    this.msg('them', this.api.t('嘿，今天聚餐别忘了 🍲'));
    this.ask();
  }

  ask() {
    const rd = this.rounds[this.r];
    this.typing(() => {
      this.msg('them', this.api.t(rd.from));
      this.waiting = true;
      this.api.task(`${this.r + 1}/${this.rounds.length} · ${this.api.t(rd.text)}`, this.api.t(rd.hint));
    });
  }

  typing(then) {
    const st = this.root.querySelector('.ct-status');
    st.textContent = this.api.t('对方正在输入…');
    this.typer = setTimeout(() => {
      st.textContent = this.api.t('在线');
      then();
    }, 800);
  }

  msg(who, text) {
    const li = h(`<li class="${who}"><p></p></li>`);
    li.querySelector('p').textContent = text;
    this.list.append(li);
    this.list.scrollTop = this.list.scrollHeight;
  }

  send(raw) {
    const text = raw.trim();
    if (!text) return;
    const rd = this.rounds[this.r];
    this.msg('me', text);
    this.input.value = '';
    this.input.style.height = '';
    if (!rd || !this.waiting) return;
    if (rd.want !== 'text' && text !== rd.want) {
      this.wrong += 1;
      this.typing(() => this.msg('them', this.api.t('哈哈，是 {e} 啦', { e: rd.want })));
      return;
    }
    if (rd.want === 'text') this.chars += [...text].length;
    this.waiting = false;
    this.r += 1;
    this.api.sound.tone(760, 0.08, { vol: 0.15 });
    if (this.r >= this.rounds.length) {
      this.typing(() => {
        this.msg('them', this.api.t('收到，一会儿见！'));
        this.api.done();
      });
    } else this.ask();
  }

  summary() {
    return { steps: this.rounds.length, chars: this.chars, wrong: this.wrong };
  }

  destroy() {
    clearTimeout(this.typer);
  }
}

// ---------- 场景 4：点外卖 ----------

class Order {
  constructor(root, api) {
    this.api = api;
    const t = api.t;
    this.want = { dish: 'beef', time: '12:30', note: '门口' };
    this.state = { dish: null, time: null };
    this.attempts = 0;
    const dishes = [['beef', '牛肉面', '🍜'], ['noodle', '酸辣粉', '🌶️'], ['chicken', '鸡排饭', '🍗'], ['sushi', '寿司', '🍣']];
    const times = ['12:00', '12:30', '13:00'];
    this.root = root.appendChild(h(`<div class="lv-order">
      <div class="od-ticket">
        <p class="od-from">${t('小林想吃')}</p>
        <ul>
          <li>🍜 ${t('牛肉面')}</li>
          <li>🕧 ${t('12:30 送到')}</li>
          <li>📝 ${t('备注：放门口')}</li>
        </ul>
      </div>
      <form class="od-form" novalidate>
        <fieldset data-f="dish"><legend>${t('菜品')}</legend><div class="od-dishes">${dishes.map(([id, name, e]) => `<button type="button" data-dish="${id}"><span>${e}</span>${t(name)}</button>`).join('')}</div></fieldset>
        <fieldset data-f="time"><legend>${t('送达时间')}</legend><div class="od-chips">${times.map((x) => `<button type="button" data-time="${x}">${x}</button>`).join('')}</div></fieldset>
        <fieldset data-f="note"><legend>${t('备注')}</legend><input type="text" placeholder="${t('点这里，左歪头说出备注')}"></fieldset>
        <button class="od-submit" type="submit">${t('提交订单')}</button>
      </form>
    </div>`));
    const r = this.root;
    r.querySelectorAll('[data-dish]').forEach((b) => { b.onclick = () => { this.state.dish = b.dataset.dish; this.sync(); }; });
    r.querySelectorAll('[data-time]').forEach((b) => { b.onclick = () => { this.state.time = b.dataset.time; this.sync(); }; });
    r.querySelector('input').addEventListener('input', () => { this.sync(); });
    r.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
  }

  begin() {
    this.sync();
  }

  /** 任务提示跟着进度走：先选菜，再选时间，再说备注，最后提交 */
  sync() {
    const r = this.root;
    const s = this.state;
    const t = this.api.t;
    r.querySelectorAll('[data-dish]').forEach((b) => b.classList.toggle('on', b.dataset.dish === s.dish));
    r.querySelectorAll('[data-time]').forEach((b) => b.classList.toggle('on', b.dataset.time === s.time));
    r.querySelectorAll('fieldset.bad').forEach((f) => f.classList.remove('bad'));
    const note = r.querySelector('input').value.trim();
    const step = !s.dish ? 0 : !s.time ? 1 : !note ? 2 : 3;
    if (step === this.step) return;
    this.step = step;
    const tasks = [
      ['选「牛肉面」', '头指着它，说“点击”'],
      ['选「12:30」送达', '头指着它，说“点击”'],
      ['备注写“放门口”', '点输入框 → 左歪头说“放门口” → 回正'],
      ['提交订单', '点「提交订单」，或者右歪头回车'],
    ];
    this.api.task(`${step + 1}/4 · ${t(tasks[step][0])}`, t(tasks[step][1]));
  }

  submit() {
    const s = this.state;
    const w = this.want;
    const note = this.root.querySelector('input').value;
    const bad = [];
    if (s.dish !== w.dish) bad.push('dish');
    if (s.time !== w.time) bad.push('time');
    if (!note.includes(w.note)) bad.push('note');
    this.attempts += 1;
    this.root.querySelectorAll('fieldset').forEach((f) => f.classList.toggle('bad', bad.includes(f.dataset.f)));
    if (bad.length) {
      this.step = null;
      this.api.task(this.api.t('标红的再看一眼'), this.api.t('改好再提交'));
      return;
    }
    this.root.querySelector('.od-submit').textContent = this.api.t('下单成功 ✓');
    this.api.done();
  }

  summary() {
    return { steps: 4, attempts: this.attempts };
  }
}
