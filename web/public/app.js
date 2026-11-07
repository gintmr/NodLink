// NodLink：场景就是界面。
// 数据挂在 3D 部件上：点部件，它的数据和操作在旁边展开；出问题的部件自己亮起来；
// 想一直盯着的数值可以“钉”成探针，跟着部件走；底部时间轴可以拖回过去的任意时刻。
// 屏幕坐标（space）覆盖所有显示器；校准时目标红点由耳机桥画在真实显示器上。

import { RAD, wrapDeg, circularMeanDeg } from './core/angles.js';
import { makeCalibrationPath, calibrate, fitCenters, predict } from './core/calibration.js';
import { AbsolutePointer, RelativePointer, DeltaPointer } from './core/pointer.js';
import { makeGridTest, evaluateGrid } from './core/accuracy.js';
import { HeadControl, CONTROL_DEFAULTS, REJECT, TILT_MODES } from './core/control.js';
import { pointing, meanQuat, forwardFromTilt } from './core/orient.js';
import { rectDist } from './core/snap.js';
import { YawDrift } from './core/drift.js';
import { SimHead } from './core/sim.js';
import { Scene3D } from './ui/scene3d.js';
import { Timeline } from './ui/timeline.js';
import { t, getLang, setLang, translateDom, onLangChange } from './ui/i18n.js';
import { enhanceSelects } from './ui/select.js';
import { Instruments } from './ui/instruments.js';
import { StatsPanel, MiniMap } from './ui/hud.js';
import { Arcade } from './ui/arcade.js';
import { GAMES } from './ui/games/index.js';
import { Challenge } from './ui/challenge.js';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);
const num = (id) => Number($(id).value);
const radio = (name) => document.querySelector(`input[name=${name}]:checked`).value;
const cssCache = new Map();
/** 读 CSS 颜色变量。结果缓存起来，换主题时清空；每帧直接读 getComputedStyle 很费 */
const css = (name) => {
  if (!cssCache.has(name)) cssCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  return cssCache.get(name);
};
const store = {
  get: (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set: (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 隐私模式下忽略 */ } },
};
const COUNTDOWN_MS = 2000;
const STREAM_MAX = 60_000;
const HISTORY_MS = 3.5 * 60_000;
const STALE_MS = 1000;
const PHONE = { w: 390, h: 844 };

/** 屏幕坐标空间：screens 是各显示器在其中的矩形，origin 是左上角对应的全局坐标 */
const space = { w: 1, h: 1, screens: [], origin: { x: 0, y: 0 }, fromBridge: false };

enhanceSelects(); // 所有下拉菜单换成和界面一样的样式

const scene = new Scene3D($('scene'));
window.nodlink = { scene }; // 方便在浏览器控制台里调试 3D 场景
// 场景四周的取景框和三条仪表：实时显示头部朝向怎样变成控制（ui/instruments.js）
const instruments = new Instruments(document.querySelector('header.top'), CONTROL_DEFAULTS);
// 左下角的运行数据、右下角的显示器小地图（ui/hud.js），和仪表一起只在第三人称出现
const hudStats = new StatsPanel(instruments.root, t);
const miniMap = new MiniMap(instruments.root, t);
const hud = { ops: 0, rejects: 0, accuracy: null, since: null, at: 0, device: [] }; // device：最近 10 秒样本的设备时间戳（秒）

let run = null;        // 正在进行的流程
let calib = null;      // { kind, result, ref, G, layoutKey, source }
let pointer = null;
let cursor = null;
let sysCursor = null;  // 耳机桥报告的系统光标位置（屏幕坐标）
let last = null;       // 最近一个样本（含映射后的 h / v / r）
let zero = null;       // 正前方；中心校准前是第一个样本
let centered = false;
let selected = null;   // 展开的部件
let replayT = null;    // 时间轴拖到的时刻；null 表示实时
const sessions = [];
const stream = [];
const arrivals = [];
const history = [];    // 每 30 ms 一帧，供回放、探针波形使用
const live = { relay: false, sources: 0, event: null, displays: null, control: { enabled: false, other: false, trusted: false }, pods: null, podsAt: 0 };

// ---------- 屏幕坐标空间 ----------

function rebuildSpace() {
  const phone = $('stage-size').value === 'phone';
  let screens;
  if (!phone && live.displays?.length && sourceKind === 'live') {
    const minX = Math.min(...live.displays.map((d) => d.x));
    const minY = Math.min(...live.displays.map((d) => d.y));
    screens = live.displays.map((d) => ({ name: d.name, main: d.main, x: d.x - minX, y: d.y - minY, w: d.w, h: d.h }));
    space.origin = { x: minX, y: minY };
    space.fromBridge = true;
  } else {
    const s = phone ? PHONE : { w: screen.width, h: screen.height };
    screens = [{ name: phone ? '手机' : '这块屏幕', main: true, x: 0, y: 0, w: s.w, h: s.h }];
    space.origin = { x: 0, y: 0 };
    space.fromBridge = false;
  }
  // 编号：主显示器是 1，其余从左到右、从上到下。标题栏、卡片和日志都用这个编号
  const rest = screens.filter((s) => !s.main).sort((a, b) => a.x - b.x || a.y - b.y);
  [screens.find((s) => s.main) ?? rest.shift(), ...rest].forEach((s, i) => { if (s) s.no = i + 1; });
  space.screens = screens;
  space.w = Math.max(...screens.map((s) => s.x + s.w));
  space.h = Math.max(...screens.map((s) => s.y + s.h));
  resizeStage();
}

const mainScreen = () => space.screens.find((s) => s.main) ?? space.screens[0];
const center = (sc = mainScreen()) => ({ x: sc.x + sc.w / 2, y: sc.y + sc.h / 2 });
const layoutKey = () => JSON.stringify(space.screens.map(({ x, y, w, h }) => [x, y, w, h]));
const currentG = () => calib?.G ?? (num('set-dist') || 3000);
const frontPoint = () => (calib ? predict(calib.result.models.affine, 0, 0) : center());

// ---------- 数据源 ----------

const readSim = () => ({
  lagMs: num('sim-lag'),
  tauMs: num('sim-tau'),
  noiseDeg: num('sim-noise'),
  driftYawDegPerMin: num('sim-drift-yaw'),
  driftPitchDegPerMin: num('sim-drift-pitch'),
  rateHz: Math.max(1, num('sim-rate')),
  distancePx: num('set-dist'),
});

const sim = new SimHead({ ...readSim(), seed: Date.now() });
let sourceKind = 'sim';
// 公开体验版（GitHub Pages 上的静态网页）：没有中继和耳机桥，只用模拟数据。和本地版是同一份代码，
// 构建时（scripts/build-public.js）在 <html> 上加 data-edition="public"；要耳机桥的界面带 .live-only，在这里一律藏起来
const PUBLIC = document.documentElement.dataset.edition === 'public';
if (PUBLIC) {
  // 仓库地址：在 <用户>.github.io/<仓库>/ 上从网址推出来，别的地方用 index.html 里写的默认值
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  if (m) $('edition-link').href = `https://github.com/${m[1]}/${repo ?? `${m[1]}.github.io`}#readme`;
}
let simTimer = null;
let ws = null;
let lastHover = null;

/** 模拟头部此刻想指向的点：流程目标优先，其次是鼠标在 3D 屏幕上指的位置 */
function simTarget(now) {
  const hover = scene.pointerPx ?? (stageMouse && document.body.classList.contains('inpage-run') ? stageMouse : null);
  if (hover) lastHover = hover;
  return currentTarget(now) ?? lastHover ?? center();
}

function startSource() {
  stopSource();
  drift.reset(); // 换了数据源，学到的漂移速度不算数
  $('sim-opts').hidden = sourceKind !== 'sim';
  arrivals.length = 0;
  last = null;
  zero = null;
  centered = false;
  resetCalibration(t('数据源换了，请重新校准。'));
  rebuildSpace();
  logEvent(sourceKind === 'sim' ? t('切到模拟数据') : t('切到耳机数据'));
  if (sourceKind === 'sim') {
    simTimer = setInterval(() => {
      const t = performance.now();
      // 模拟的头正对主显示器中心
      const tgt = simTarget(t);
      const c = center();
      const s = sim.step(t, { x: tgt.x - c.x + space.w / 2, y: tgt.y - c.y + space.h / 2 }, space);
      onSample({ t, ...s, src: 'sim' });
    }, 1000 / sim.p.rateHz);
  } else {
    connectLive();
  }
}

function stopSource() {
  clearInterval(simTimer);
  simTimer = null;
  setControl(false);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  Object.assign(live, { relay: false, sources: 0, event: null, displays: null, control: { enabled: false, other: false, trusted: false }, pods: null, podsAt: 0 });
}

function connectLive() {
  if (PUBLIC) return;
  ws = new WebSocket(`ws://${location.host}/ws?role=view`);
  ws.onopen = () => {
    live.relay = true;
    live.podsAt = performance.now(); // 给耳机桥几秒报到
    send({ type: 'hello' }); // 让耳机桥报告显示器和控制状态
    sendVoice();
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'motion') {
      // 斜戴校正：有前后轴时，用它的朝向代替欧拉角的 yaw / pitch
      const p = m.q && forward ? pointing(m.q, forward.f) : m;
      onSample({ t: deviceClock(performance.now(), m.t), deviceT: m.t, yaw: p.yaw / RAD, pitch: p.pitch / RAD, roll: m.roll / RAD, q: m.q, src: 'live' });
    } else if (m.type === 'relay') {
      if (m.sources && !live.sources) live.podsAt = performance.now();
      live.sources = m.sources;
      if (!m.sources && live.displays) {
        live.displays = null;
        rebuildSpace();
      }
    } else if (m.type === 'displays') {
      live.displays = m.displays;
      rebuildSpace();
    } else if (m.type === 'control') {
      const was = live.control.enabled;
      // enabled 只表示“这个网页在控制”；别的网页在控制时 other 为真，这里不发光标、不识别手势
      live.control = { enabled: m.enabled && m.owner === PAGE_ID, other: m.enabled && m.owner !== PAGE_ID, trusted: m.trusted };
      if (was !== live.control.enabled) {
        logEvent(live.control.enabled ? t('接管了鼠标') : t(live.control.other ? '另一个网页接管了鼠标' : '交还了鼠标'), 'info');
        // 耳机桥交还鼠标时自己会松开按住的键，这里只清状态
        if (live.control.enabled) control.engage(performance.now());
        else {
          control.reset(performance.now());
          labels.items = [];
          labels.pending = null;
        }
        pointer?.setHold?.(false);
      }
      syncControlUI();
    } else if (m.type === 'cursorPos') {
      sysCursor = { x: m.x - space.origin.x, y: m.y - space.origin.y };
    } else if (m.type === 'headphones') {
      onHeadphones(m);
    } else if (m.type === 'targets') {
      onTargets(m);
    } else if (m.type === 'pointing') {
      onPointing(m);
    } else if (m.type === 'voice') {
      onVoice(m);
    } else if (m.type === 'input') {
      // 真实的鼠标、触控板或键盘动了（耳机桥已经排除了自己发出的事件）
      applyControl(control.physical(performance.now()));
    } else {
      live.event = m;
      pushStream({ t: performance.now(), event: m });
      if (m.name === 'headphonesConnected') {
        logEvent(t('耳机连上了'), 'good');
        scene.play('Wave');
      } else if (m.name === 'headphonesDisconnected') {
        logEvent(t('耳机断开了'), 'bad');
      }
    }
  };
  ws.onclose = () => {
    live.relay = false;
    live.displays = null;
    rebuildSpace();
    setTimeout(() => { if (sourceKind === 'live') connectLive(); }, 2000);
  };
}

/**
 * 耳机数据是成批到的（每 20 ms 采一帧，但大约每 60 ms 才到一批），按到达时间算，同一批的几帧挤在 1 ms 里，
 * 滤波和速度判断都会失真。所以按设备时间排开：设备时间加上“最快到达的那一帧”的延迟，换算到页面时钟。
 */
const clock = { offset: Infinity, last: -Infinity };
function deviceClock(arrival, deviceSec) {
  if (deviceSec == null) return arrival;
  clock.offset = Math.min(clock.offset, arrival - deviceSec * 1000);
  clock.last = Math.max(deviceSec * 1000 + clock.offset, clock.last + 0.5);
  return clock.last;
}

/** 斜戴校正用的头部前后轴（设备坐标），“识别轴方向”时从歪头那一步求出来 */
const FORWARD_KEY = 'nodlink.forward.v1';
let forward = store.get(FORWARD_KEY);

/** 这个网页的编号：好几个网页同时开着时，耳机桥只听正在控制的那一个 */
const PAGE_ID = Math.random().toString(36).slice(2, 10);

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...msg, page: PAGE_ID }));
}

/** 耳机桥在线：能画全屏叠加层、能控制系统鼠标 */
const bridgeReady = () => sourceKind === 'live' && live.relay && !!live.displays;

for (const r of $$('input[name=source]')) r.onchange = () => { sourceKind = r.value; startSource(); };
for (const id of ['sim-lag', 'sim-tau', 'sim-noise', 'sim-drift-yaw', 'sim-drift-pitch', 'set-dist']) {
  $(id).onchange = () => { sim.set(readSim()); if (pointer instanceof DeltaPointer || (pointer instanceof AbsolutePointer && !calib)) rebuildPointer(); };
}
$('sim-rate').onchange = () => { sim.set(readSim()); startSource(); };
$('stage-size').onchange = rebuildSpace;

// ---------- 轴映射 ----------

const axes = {};
const AXES_KEY = 'nodlink.axes.v2';
function readAxes() {
  axes.h = $('axis-h').value;
  axes.v = $('axis-v').value;
  axes.r = ['yaw', 'pitch', 'roll'].find((x) => x !== axes.h && x !== axes.v) ?? 'roll';
  axes.sh = $('inv-h').checked ? -1 : 1;
  axes.sv = $('inv-v').checked ? -1 : 1;
  axes.sr = $('inv-r').checked ? -1 : 1;
  $('axis-r-name').textContent = axes.r;
}
function axesChanged() {
  readAxes();
  drift.reset();
  store.set(AXES_KEY, axes);
  zero = null;
  centered = false;
  resetCalibration(t('轴映射改了，请重新校准。'));
  logEvent(t('改了轴映射'));
}
for (const id of ['axis-h', 'axis-v', 'inv-h', 'inv-v', 'inv-r']) $(id).onchange = axesChanged;
const savedAxes = store.get(AXES_KEY);
if (savedAxes?.h && savedAxes?.v) {
  $('axis-h').value = savedAxes.h;
  $('axis-v').value = savedAxes.v;
  $('inv-h').checked = savedAxes.sh === -1;
  $('inv-v').checked = savedAxes.sv === -1;
  $('inv-r').checked = savedAxes.sr === -1;
}
readAxes();

function resetCalibration(message) {
  if (!calib) return;
  calib = null;
  $('centers-result').innerHTML = '';
  $('cal-result').innerHTML = `<p class="detail">${message}</p>`;
  $('lag-figure').hidden = true;
  rebuildPointer();
}

// ---------- 样本处理 ----------

function pushStream(item) {
  stream.push(item);
  if (stream.length > STREAM_MAX + 1000) stream.splice(0, 1000);
}

/** 相对正前方的姿态 */
function poseOf(s) {
  if (!s || !zero) return null;
  const ref = calib?.ref ?? zero;
  return { h: wrapDeg(s.h - ref.h - drift.offset), v: wrapDeg(s.v - ref.v), r: wrapDeg(s.r - zero.r) };
}

/** 耳机水平角会慢慢漂，接管鼠标或玩游戏时自动往回拉（core/drift.js）；回中、重新校准时漂移量清零，学到的漂移速度留着 */
const drift = new YawDrift();
if (store.get('nodlink.drift') != null) $('c-drift').checked = store.get('nodlink.drift');
$('c-drift').onchange = () => {
  store.set('nodlink.drift', $('c-drift').checked);
  if (!$('c-drift').checked) drift.reset();
};

/** 最近 10 秒的数据完整率：按样本间隔的中位数算应收多少个，实际收到多少个 */
function dataIntegrity() {
  const d = hud.device;
  if (d.length < 20) return null;
  const gaps = [];
  for (let i = 1; i < d.length; i++) gaps.push(d[i] - d[i - 1]);
  gaps.sort((a, b) => a - b);
  const step = gaps[gaps.length >> 1];
  if (!(step > 0)) return null;
  const expected = Math.round((d.at(-1) - d[0]) / step) + 1;
  return Math.min(1, d.length / expected);
}

function onSample(s) {
  const dev = s.deviceT ?? s.t / 1000;
  hud.device.push(dev);
  while (hud.device.length && hud.device[0] < dev - 10) hud.device.shift();
  arrivals.push({ t: s.t, d: s.deviceT });
  while (arrivals.length && arrivals[0].t < s.t - 2000) arrivals.shift();
  const h = axes.sh * s[axes.h];
  const v = axes.sv * s[axes.v];
  const r = axes.sr * s[axes.r];
  last = { ...s, h, v, r };
  if (!zero) {
    zero = { h, v, r };
    if (!calib && pointer instanceof AbsolutePointer) rebuildPointer(); // 有了正前方，几何模型才有参考
  }
  pushStream({ t: s.t, deviceT: s.deviceT, yaw: s.yaw, pitch: s.pitch, roll: s.roll, src: s.src });
  const pose = poseOf(last);
  timeline.push(s.t, pose.h, pose.v);

  if (run) {
    sendOverlay(s.t);
    if (['center', 'centers', 'axes', 'calibration'].includes(run.kind)) {
      if (s.t >= run.t0) run.samples.push({ t: s.t - run.t0, h, v, r, yaw: s.yaw, pitch: s.pitch, roll: s.roll, deviceT: s.deviceT, q: s.q });
      recordHistory(s, pose);
      return;
    }
  }
  if ((live.control.enabled || document.body.classList.contains('in-arcade')) && $('c-drift').checked && !run && zero) drift.update(s.t / 1000, wrapDeg(h - (calib?.ref ?? zero).h));
  if (pointer && !(run?.forCalibration || run?.kind === 'preparing')) cursor = pointer.update(h - drift.offset, v, s.t / 1000, space);
  if (run?.kind === 'grid') run.records.push({ t: s.t - run.t0, x: cursor?.x, y: cursor?.y, h, v });
  if (cursor) probeTargets(s.t, cursor);
  if (pointer && !run) applyControl(control.update(s.t, pose, shownCursor()));
  recordHistory(s, pose);
  driveSystemCursor();
}

function recordHistory(s, pose) {
  const prev = history.at(-1);
  if (prev && s.t - prev.t < 30) return;
  const raw = rawPx();
  history.push({ t: s.t, yaw: s.yaw, pitch: s.pitch, roll: s.roll, pose, cursor: shownCursor() && { ...shownCursor() }, raw: raw && { ...raw } });
  while (history.length && history[0].t < s.t - HISTORY_MS) history.shift();
}

function frameAt(t) {
  let lo = 0;
  let hi = history.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (history[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return history[lo];
}

/** 当前要显示的那一帧：实时就是最新样本，回放时是时间轴上的那一刻 */
function currentFrame() {
  if (replayT != null) return frameAt(replayT);
  if (!last) return null;
  return { t: last.t, yaw: last.yaw, pitch: last.pitch, roll: last.roll, pose: poseOf(last), cursor: shownCursor(), raw: rawPx() };
}

function rawPx() {
  if (!(pointer instanceof AbsolutePointer) || !pointer.raw) return null;
  return { x: pointer.raw.x + pointer.offset.x, y: pointer.raw.y + pointer.offset.y };
}

/** 接管系统鼠标的增量模式下，以系统光标为准 */
function shownCursor() {
  if (live.control.enabled && pointer instanceof DeltaPointer && sysCursor) return sysCursor;
  return cursor;
}

/** 视线落在屏幕上的位置（屏幕坐标），用模型的比例换算 */
function hitPx(pose) {
  if (!pose) return null;
  const f = frontPoint();
  const G = currentG();
  return { x: f.x + G * Math.tan(pose.h * RAD), y: f.y - G * Math.tan(pose.v * RAD) };
}

// ---------- 光标 ----------

const readFilter = () => ({ minCutoff: num('f-min'), beta: num('f-beta') });
const readRel = () => ({ deadzoneDeg: num('r-dead'), gain: num('r-gain'), expo: num('r-expo') });
const cursorMode = () => radio('cursor-mode');
// v2：上一版没校准时会自动切到增量模式并记住，换个键，让默认回到绝对模式
const MODE_KEY = 'nodlink.mode.v2';
const MODE_HINTS = {
  absolute: '头朝哪，光标就在哪，和紫色指向线的落点一致。没校准时按“头到屏幕的距离”估算，校准后更准。',
  delta: '像普通鼠标：头转多少，光标就从当前位置走多少，跨显示器也自然。光标不跟指向线对齐，用久了会和头的朝向错开。',
  relative: '像摇杆：头偏得越多，光标跑得越快。不需要校准。',
};

function rebuildPointer() {
  const mode = cursorMode();
  $('abs-opts').hidden = mode === 'relative';
  $('rel-opts').hidden = mode !== 'relative';
  $('mode-hint').textContent = t(MODE_HINTS[mode]);
  if (mode === 'relative') pointer = new RelativePointer(readRel());
  else if (mode === 'delta') pointer = new DeltaPointer({ G: currentG(), gain: num('f-gain'), filter: readFilter() });
  else {
    pointer = new AbsolutePointer(calib ? { ...calib.result, ref: calib.ref } : geometric(), calib ? $('model-kind').value : 'affine', readFilter(), num('f-gain'));
    pointer.setPrecision($('f-precise').checked ? {} : null);
  }
  cursor = null;
}

/** 没校准时的绝对模式：和指向线同一个几何模型——正前方对着主显示器中心，x = 中心 + G·tan(水平角) */
function geometric() {
  const c = center();
  const G = currentG();
  const model = { kind: 'affine', cx: [c.x, G, 0], cy: [c.y, 0, -G], G };
  return { ref: zero ? { h: zero.h, v: zero.v } : { h: 0, v: 0 }, models: { affine: model, quadratic: model } };
}

for (const r of $$('input[name=cursor-mode]')) {
  r.onchange = () => {
    rebuildPointer();
    store.set(MODE_KEY, cursorMode());
    logEvent(t('光标改成{mode}模式', { mode: t({ absolute: t('绝对'), delta: t('增量'), relative: t('摇杆') }[cursorMode()]) }));
  };
}
$('model-kind').onchange = rebuildPointer;
if (store.get('nodlink.precise') != null) $('f-precise').checked = store.get('nodlink.precise');
$('f-precise').onchange = () => {
  store.set('nodlink.precise', $('f-precise').checked);
  if (pointer instanceof AbsolutePointer) pointer.setPrecision($('f-precise').checked ? {} : null);
};
for (const id of ['f-min', 'f-beta']) $(id).onchange = () => pointer?.setFilter?.(readFilter());
for (const id of ['r-dead', 'r-gain', 'r-expo']) $(id).onchange = () => pointer?.set?.(readRel());

let gainTimer = null;
function gainChanged(log = true) {
  const g = num('f-gain');
  const el = $('f-gain');
  $('f-gain-val').textContent = `${g.toFixed(2)}×`;
  el.style.setProperty('--p', `${((g - el.min) / (el.max - el.min)) * 100}%`);
  pointer?.setGain?.(g);
  store.set('nodlink.gain', g);
  if (log) {
    clearTimeout(gainTimer);
    gainTimer = setTimeout(() => logEvent(t('灵敏度调到 {g}×', { g: g.toFixed(2) })), 700);
  }
}
$('f-gain').oninput = () => gainChanged();
if (store.get('nodlink.gain')) $('f-gain').value = store.get('nodlink.gain');
const savedMode = store.get(MODE_KEY);
if (savedMode) for (const r of $$('input[name=cursor-mode]')) r.checked = r.value === savedMode;
gainChanged(false);

/** 回中：认为用户此刻正看着正前方（主显示器中间），漂移清零 */
function recenter() {
  drift.recenter();
  if (document.body.classList.contains('in-arcade')) arcade.recentered(); // 游戏厅的正前方跟着换
  if (last && !calib) zero = { h: last.h, v: last.v, r: last.r };
  if (last && calib) calib.ref = { h: last.h, v: last.v }; // 和“中心校准”一样：校准模型的正前方换成现在的朝向
  if (pointer instanceof AbsolutePointer) rebuildPointer();
  else if (pointer instanceof RelativePointer) pointer.recenter(space);
  else if (pointer instanceof DeltaPointer) {
    pointer.recenter(space, center());
    if (live.control.enabled) send({ type: 'cursor', x: center().x + space.origin.x, y: center().y + space.origin.y });
  }
}

function toggleClutch() {
  if (pointer?.setPaused) pointer.setPaused(!pointer.paused);
}

$('btn-recenter').onclick = recenter;
$('btn-clutch').onclick = toggleClutch;

// ---------- 接管系统鼠标 ----------

function setControl(on) {
  if (on && !bridgeReady()) on = false;
  sendVoice();
  send({ type: 'control', enabled: on, yieldMs: control.o.yieldMs });
  if (!on) live.control.enabled = false;
  syncControlUI();
}
$('ctl').onchange = (e) => setControl(e.target.checked);

function syncControlUI() {
  const ready = bridgeReady();
  $('ctl').checked = live.control.enabled;
  $('ctl').disabled = !ready;
  $('ctl-hint').textContent = !ready
    ? t('先把数据源切到“耳机”，并运行耳机桥（mac/NodLinkBridge/run.sh）。')
    : live.control.enabled && !live.control.trusted
      ? t('光标能动，但其他 App 收不到悬停。到“系统设置 → 隐私与安全性 → 辅助功能”打开 NodLinkBridge。')
      : t('打开后头部就是整台电脑的鼠标。按 Esc 交还。');
}

/** 每个样本把光标发给耳机桥：增量模式发位移，其他模式发绝对位置 */
function driveSystemCursor() {
  if (!live.control.enabled || !pointer || run || control.yielding(performance.now())) return;
  if (pointer instanceof DeltaPointer) {
    const d = pointer.delta;
    if (Math.abs(d.x) + Math.abs(d.y) > 0.05) send({ type: 'cursor', dx: d.x, dy: d.y, ts: last?.deviceT });
  } else if (cursor) {
    // ts：这一帧的设备时间。耳机桥按它把成批到达的位置匀开，以 120 Hz 平滑地走
    send({ type: 'cursor', x: cursor.x + space.origin.x, y: cursor.y + space.origin.y, ts: last?.deviceT });
  }
}

// ---------- 头控按键：歪头、驻留、防误触、键鼠让位 ----------
// 判断都在 core/control.js 里；这里把动作发给耳机桥，并在两个视角里画出反馈。
// 没接管系统鼠标时（比如模拟数据）也照常识别，只是不发给耳机桥，方便调参。

const CONTROL_KEY = 'nodlink.control.v1';
const readControl = () => ({
  tilt: $('c-tilt').checked,
  tiltMode: $('c-tilt-mode').value,
  dwell: $('c-dwell').checked,
  enterDeg: num('c-enter'),
  dwellMs: num('c-dwell-ms'),
  yieldMs: num('c-yield') * 1000,
});
const savedControl = store.get(CONTROL_KEY);
if (savedControl) {
  $('c-tilt').checked = savedControl.tilt ?? true;
  if (TILT_MODES[savedControl.tiltMode]) $('c-tilt-mode').value = savedControl.tiltMode;
  $('c-dwell').checked = !!savedControl.dwell;
  for (const [id, key, k] of [['c-enter', 'enterDeg', 1], ['c-dwell-ms', 'dwellMs', 1], ['c-yield', 'yieldMs', 1000]]) {
    if (savedControl[key]) $(id).value = savedControl[key] / k;
  }
}
if (store.get('nodlink.cue') != null) $('c-sound').checked = store.get('nodlink.cue');
if (store.get('nodlink.voice')) {
  $('c-voice').checked = !!store.get('nodlink.voice').on;
  $('c-mic').value = store.get('nodlink.voice').mic ?? 'builtin';
}
const control = new HeadControl(readControl());
function applyControlOptions() {
  const o = readControl();
  // 进入阈值改了，退出、预备阈值按比例跟着改，保持滞回
  o.exitDeg = (o.enterDeg * CONTROL_DEFAULTS.exitDeg) / CONTROL_DEFAULTS.enterDeg;
  o.preDeg = (o.enterDeg * CONTROL_DEFAULTS.preDeg) / CONTROL_DEFAULTS.enterDeg;
  control.set(o);
  instruments.setGesture({ preDeg: o.preDeg, enterDeg: o.enterDeg, tilt: o.tilt });
  store.set(CONTROL_KEY, o);
}
for (const id of ['c-tilt', 'c-tilt-mode', 'c-dwell', 'c-enter', 'c-dwell-ms', 'c-yield']) $(id).onchange = applyControlOptions;
applyControlOptions();
for (const id of ['c-tilt', 'c-tilt-mode', 'c-dwell', 'c-voice']) $(id).addEventListener('change', () => renderTiltLegend());
$('c-sound').onchange = () => store.set('nodlink.cue', $('c-sound').checked);

// ---------- 吸附（只在执行操作时） ----------
// 一直吸附不好用：电脑上能点的地方太密，光标在它们之间跳来跳去，反而更难控制。
// 所以光标平时照常跟头走；只在点击、按下的那一刻，把回溯出来的停留处（core/control.js 的 intended）
// 对准到它所在的、或紧挨着的小按钮中心。耳机桥一直在后台读落点附近的按钮位置，备着用。

const snap = { target: null, items: [], probeAt: 0, fresh: false, scan: null };
if (store.get('nodlink.snap') != null) $('c-snap').checked = store.get('nodlink.snap');
$('c-snap').onchange = () => store.set('nodlink.snap', $('c-snap').checked);
const SNAP_NEAR = 8;          // 离按钮这么近（点）以内才对准
const SNAP_MAX = { w: 160, h: 80 }; // 比这大的（文本框、列表）不对准，点在停留处
const ROLE_NAMES = {
  Button: '按钮', Link: '链接', TextField: '输入框', TextArea: '文本区', CheckBox: '复选框', RadioButton: '选项',
  PopUpButton: '下拉菜单', MenuButton: '菜单按钮', MenuBarItem: '菜单', MenuItem: '菜单项', DockItem: '程序坞图标',
  Row: '列表行', Cell: '单元格', Slider: '滑块', ComboBox: '组合框', DisclosureTriangle: '展开箭头', Incrementor: '加减按钮', ColorWell: '颜色',
  StaticText: '文字', Image: '图片', Window: '窗口', Group: '区域', ScrollArea: '滚动区', WebArea: '网页', Toolbar: '工具栏', Heading: '标题',
};

/** 每 100 ms 把光标位置报给耳机桥，它在后台读附近的按钮 */
function probeTargets(t, p) {
  if (!$('c-snap').checked || !live.control.enabled || run || t - snap.probeAt < 100) return;
  snap.probeAt = t;
  send({ type: 'probe', x: p.x + space.origin.x, y: p.y + space.origin.y, fresh: snap.fresh });
  snap.fresh = false;
}

/** 执行位置对准到按钮：p 所在、或离 p 不到 SNAP_NEAR 的最小那个小元素的中心 */
function refinePoint(p) {
  snap.target = null;
  if (!p || !$('c-snap').checked || !live.control.enabled) return p;
  const g = { x: p.x + space.origin.x, y: p.y + space.origin.y };
  let best = null;
  let bestD = Infinity;
  for (const it of snap.items) {
    if (it.w > SNAP_MAX.w || it.h > SNAP_MAX.h) continue;
    const d = rectDist(g, it);
    if (d <= SNAP_NEAR && (d < bestD - 0.5 || (Math.abs(d - bestD) <= 0.5 && it.w * it.h < best.w * best.h))) {
      best = it;
      bestD = d;
    }
  }
  if (!best) return p;
  snap.target = best;
  return { x: best.x + best.w / 2 - space.origin.x, y: best.y + best.h / 2 - space.origin.y };
}
control.refine = refinePoint;

function onTargets(m) {
  snap.items = m.items ?? [];
  if (labels.pending) {
    const g = labels.pending;
    labels.pending = null;
    buildLabels(g);
  }
  const prev = snap.scan;
  snap.scan = { n: snap.items.length, ms: m.ms, title: m.title, role: m.role };
  if (!prev || prev.title !== m.title || prev.role !== m.role) {
    logEvent(t('吸附：{where}里有 {n} 个可点的地方（读取 {ms} ms）', { where: m.title || t(m.role === 'AXMenuBar' ? '菜单栏' : m.role === 'AXList' ? '程序坞' : '这个窗口'), n: snap.items.length, ms: m.ms }));
  }
}

// ---------- 耳机连接 ----------
// 耳机桥每秒报一次：连没连上、有没有数据、声音从哪儿出。顶栏一个状态点，点开是逐项检查和修复按钮。

function onHeadphones(m) {
  const was = live.pods;
  live.pods = { ...m, airpodsOut: /airpods/i.test(m.output ?? '') };
  live.podsAt = performance.now();
  if (was && was.connected !== m.connected) logEvent(m.connected ? t('耳机连上了') : t('耳机断开了'), m.connected ? 'good' : 'bad');
  $('c-silent').checked = !!m.silentAudio;
}

/** 耳机桥连着中继，却好几秒没报耳机状况：多半是卡住了（实测出现过音频设备切换时主线程卡死），
 *  这时网页发什么指令它都不处理，重新连接耳机数据也没用，只能重启耳机桥 */
const BRIDGE_STUCK_MS = 5000;
const bridgeStuck = () => sourceKind === 'live' && live.relay && live.sources > 0 && performance.now() - live.podsAt > BRIDGE_STUCK_MS;

/** 耳机现在的状况：{ level, text } */
function podsStatus() {
  if (sourceKind !== 'live') return { level: 'off', text: t('模拟数据') };
  if (!live.relay) return { level: 'bad', text: t('中继没连上') };
  if (!live.sources) return { level: 'bad', text: t('耳机桥没运行') };
  if (bridgeStuck()) return { level: 'bad', text: t('耳机桥没响应') };
  const p = live.pods;
  if (p?.streaming || (last && performance.now() - last.t < STALE_MS)) return { level: 'ok', text: `AirPods · ${p?.rate ? p.rate.toFixed(0) : '–'} Hz` };
  if (p && !p.connected) return { level: 'bad', text: t('耳机没连上') };
  if (p && !p.airpodsOut) return { level: 'warn', text: t('声音输出不是 AirPods') };
  return { level: 'warn', text: t('耳机连着，没有数据') };
}

/** 耳机卡片里的逐项检查 */
function renderPodsChecks() {
  const p = live.pods;
  const row = (ok, label, value, fix) => `<li data-ok="${ok}"><b>${label}</b><span>${value}</span>${fix ? `<em>${fix}</em>` : ''}</li>`;
  const streaming = !!(last && performance.now() - last.t < STALE_MS);
  const rows = [
    bridgeStuck()
      ? row(false, t('耳机桥'), t('没响应'), t('耳机桥卡住了，网页发的指令它都不处理：在运行它的终端里按 Ctrl+C，再运行 mac/NodLinkBridge/run.sh'))
      : row(live.relay && live.sources > 0, t('耳机桥'), t(live.sources ? '在运行' : '没运行'), live.sources ? '' : t('运行 mac/NodLinkBridge/run.sh')),
    row(!!p?.connected, t('耳机'), t(p?.connected ? '已连接' : '没连上'), p?.connected ? '' : t('戴好 AirPods，打开盒盖靠近 Mac；还不行就到蓝牙设置里连接')),
    row(!!p?.airpodsOut, t('声音输出'), p?.output ?? '–', p?.airpodsOut ? '' : t('点“声音输出”，选你的 AirPods：只有声音从 AirPods 出来，系统才给头部姿态')),
    row(streaming, t('头部数据'), streaming ? `${p?.rate ? p.rate.toFixed(0) : '–'} Hz` : t('{s} 秒没有数据', { s: p?.quiet ?? '–' }), streaming ? '' : t('先点“重新连接耳机数据”；还没有就打开下面的“播放静音”，或者放点音乐')),
  ];
  const html = rows.join('');
  if ($('pods-checks').innerHTML !== html) $('pods-checks').innerHTML = html;
}

for (const b of $$('[data-open]')) b.onclick = () => openPart(b.dataset.open);

/** 校准做到哪一步了：顶栏按钮和校准卡片共用 */
function calibStatus(streaming) {
  if (calib && calib.layoutKey !== layoutKey() && cursorMode() === 'absolute') return { level: 'warn', chip: t('需要校准'), text: t('显示器变了，要重新做多屏定点或路径校准') };
  if (calib) return { level: 'ok', chip: t('已校准'), text: t('已做{kind}，正前方也定好了', { kind: t({ centers: t('多屏定点'), path: t('路径校准') }[calib.kind]) }) };
  if (centered) return { level: 'ok', chip: t('已定正前方'), text: t('正前方定好了。想更准可以再做路径校准') };
  if (sourceKind === 'live' && streaming) return { level: 'warn', chip: t('需要校准'), text: t('还没定正前方：先做一次中心校准') };
  return { level: 'idle', chip: t('校准'), text: t(sourceKind === 'live' ? t('耳机有数据后，先做一次中心校准') : t('模拟数据也可以走一遍校准流程')) };
}
$('btn-pods-restart').onclick = () => {
  if (bridgeStuck()) return logEvent(t('耳机桥没响应，先重启它（Ctrl+C 后再运行 run.sh）'), 'bad');
  send({ type: 'motionRestart' });
  logEvent(t('让耳机桥重新读取耳机数据'));
};
$('btn-open-bt').onclick = () => send({ type: 'openSettings', pane: 'bluetooth' });
$('btn-open-sound').onclick = () => send({ type: 'openSettings', pane: 'sound' });
$('c-silent').onchange = () => send({ type: 'silentAudio', on: $('c-silent').checked });

// ---------- 语音指令 ----------
// 识别在耳机桥里（本机、只认指令词）；耳机桥只在接管鼠标期间听。这里管冻结时机和执行。

const voiceState = { on: false, mic: '', onDevice: false, text: '', textAt: 0 };
function sendVoice() {
  send({ type: 'voice', enabled: $('c-voice').checked, mic: $('c-mic').value });
}
for (const id of ['c-voice', 'c-mic']) {
  $(id).onchange = () => {
    store.set('nodlink.voice', { on: $('c-voice').checked, mic: $('c-mic').value });
    applyControlOptions();
    sendVoice();
  };
}
const VOICE_ERRORS = { speech: '没有语音识别权限：系统设置 → 隐私与安全性 → 语音识别', mic: '没有麦克风权限：系统设置 → 隐私与安全性 → 麦克风', unavailable: '这台 Mac 上没有可用的中文语音识别', engine: '麦克风启动失败' };
function onVoice(m) {
  if (m.phase === 'state') {
    Object.assign(voiceState, { on: !!m.on, mic: m.mic ?? '', onDevice: !!m.onDevice });
    if (m.error) logEvent(t(VOICE_ERRORS[m.error] ?? '语音指令没能启动'), 'bad');
    else logEvent(m.on ? t('语音指令开始听了（{mic}）', { mic: m.mic }) : t('语音指令停了'));
  } else if (m.phase === 'text') {
    Object.assign(voiceState, { text: m.text, textAt: performance.now() });
  } else {
    // 标号亮着时开口：别在说话中途收起（耳机桥收起后就不认单个数字了）
    if (m.phase === 'start' && labels.items.length) labels.until = Math.max(labels.until, performance.now() + LABEL_TALK_MS);
    if (m.phase === 'command') Object.assign(voiceState, { text: m.text, textAt: performance.now() });
    applyControl(control.voice(performance.now(), m.phase, m.command, shownCursor(), m), 'voice');
  }
}

/** 设置面板里的映射表：每个场景下，每个头部动作做什么。语音指令开着时再列几条常用的说法 */
const TILT_LEGEND = {
  click: [['向左歪头再回正', '单击（连做两次是双击）'], ['向右歪头再回正', '右键'], ['向左歪着停住', '按住左键拖拽，再歪一次松开']],
  dictate: [['向左歪头并保持', '按住 Fn：输入法开始语音输入'], ['回正', '松开 Fn：结束语音输入，文字上屏'], ['向右歪头', '回车（发送）']],
  douyin: [['向左歪头', '↓ 下一条视频'], ['向右歪头', 'X 打开或关闭评论区']],
};
const VOICE_LEGEND = [['说“点击”“双击”“右键”', '在光标处点'], ['说“长按”“松开”', '按住、松开左键'], ['说“上滑”“下滑”', '滚动'], ['说“复制”“粘贴”“撤销”', '⌘C、⌘V、⌘Z'], ['说“command tab”这类组合键', '直接按下'], ['说“标号”，再说数字', '点中标出来的按钮'], ['说“关闭窗口”“最小化”“全屏”', '按头指的那个窗口的红黄绿按钮'], ['开头说“从这里”，结尾说“到这里”', '选中一段文字'], ['说“空格”“回车”“key m”', '按对应的键']];
function renderTiltLegend() {
  const rows = [
    ...(control.o.tilt ? TILT_LEGEND[control.o.tiltMode] ?? [] : []),
    ...(control.o.dwell ? [['停住不动', '驻留点击']] : []),
    ...($('c-voice').checked ? VOICE_LEGEND : []),
    ['动一下鼠标或键盘', '头控立刻让位，停手后自动恢复'],
  ];
  $('tilt-legend').innerHTML = rows.map(([a, b]) => `<div><dt>${t(a)}</dt><dd>${t(b)}</dd></div>`).join('');
}
renderTiltLegend(); // TILT_LEGEND 在这上面才定义好，所以第一次在这里画

const TILT_HINTS = {
  click: '左歪单击 · 右歪右键 · 左歪停住按下',
  dictate: '左歪按住 Fn 说话，回正松开 · 右歪回车',
  douyin: '左歪下一条 · 右歪评论区',
};

const KEY_NAMES = {
  space: '空格', return: '回车', delete: '删除', tab: 'Tab', escape: 'Esc', up: '↑', down: '↓', left: '←', right: '→',
  pageup: 'Page Up', pagedown: 'Page Down', forwarddelete: '向后删除', cmd: '⌘', shift: 'Shift', ctrl: 'Ctrl', alt: '⌥',
};
const BUTTON_LOG = {
  'left:click:1': '左键单击', 'left:click:2': '双击', 'right:click:1': '右键',
  'left:down:1': '按住左键，可以拖拽了', 'left:up:1': '松开左键',
};
const RELEASE_WHY = { physical: '（键鼠动了）', timeout: '（按太久，自动松开）', reset: '', voice: '' };
let controlFx = null; // 点击的波纹：{ kind, at, t }

const WINDOW_LOG = { close: '关闭窗口', minimize: '最小化窗口', fullscreen: '切换全屏' };

// ---------- 标号：头指的地方附近的可点元素标上 1～9，说数字就点 ----------
// 小按钮（窗口左上角的红黄绿只有 14 点、间距 20 点）比头部抖动还小，靠对准选不稳。
// 头只负责指个大概，数字负责精确：只标最近的 9 个，数字少、好认。10 秒没用自动收起

const LABEL_MAX = 9;
const LABEL_RADIUS = 260;  // 离头指的地方超过这么远（点）的不标
const LABEL_BIG = { w: 600, h: 300 }; // 比这大的（整块面板、网页正文）不标
const LABEL_MS = 15000;
const LABEL_TALK_MS = 6000; // 标号亮着时开口说话，至少再留这么久，说慢了也来得及
const labels = { items: [], pending: null, until: 0 };

function showLabels(at) {
  if (!live.control.enabled || !at) return;
  // 先让耳机桥重读一遍头指的那个窗口，读到了再标（onTargets 里接着做）
  labels.pending = { x: at.x + space.origin.x, y: at.y + space.origin.y, t: performance.now() };
  send({ type: 'probe', x: labels.pending.x, y: labels.pending.y, fresh: true });
}

function buildLabels(g) {
  const near = snap.items
    .filter((it) => it.w <= LABEL_BIG.w && it.h <= LABEL_BIG.h)
    .map((it) => ({ it, d: rectDist(g, it) }))
    .filter((o) => o.d <= LABEL_RADIUS)
    .sort((a, b) => a.d - b.d || a.it.w * a.it.h - b.it.w * b.it.h);
  // 同一块地方套着好几层（按钮和它所在的行）只标最小的那个
  const picked = [];
  for (const { it } of near) {
    if (picked.length >= LABEL_MAX) break;
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    if (picked.some((p) => Math.abs(p.x + p.w / 2 - cx) < 6 && Math.abs(p.y + p.h / 2 - cy) < 6)) continue;
    picked.push(it);
  }
  if (!picked.length) {
    hideLabels(false);
    logEvent(t('标号：头指的地方附近没有可点的东西'), 'bad');
    return;
  }
  // 按阅读顺序编号：从上到下，同一行从左到右
  picked.sort((a, b) => (Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < 10 ? a.x - b.x : a.y - b.y));
  labels.items = picked.map((it, i) => ({ n: i + 1, x: it.x, y: it.y, w: it.w, h: it.h }));
  labels.until = performance.now() + LABEL_MS;
  send({ type: 'labels', items: labels.items });
  logEvent(t('标号：标了 {n} 个，说数字点它，说“取消”收起', { n: labels.items.length }), 'good');
}

function hideLabels(say) {
  const had = labels.items.length > 0;
  labels.items = [];
  labels.pending = null;
  send({ type: 'labels', on: false });
  if (say && had) logEvent(t('收起了标号'));
}

function pickLabel(n) {
  const it = labels.items.find((l) => l.n === n);
  if (!it) {
    logEvent(t(labels.items.length ? '没有 {n} 号' : '标号已经收起了，先说“标号”', { n }), 'bad');
    return;
  }
  const at = { x: it.x + it.w / 2 - space.origin.x, y: it.y + it.h / 2 - space.origin.y };
  hideLabels(false);
  applyControl(control.click(performance.now(), 'left', at));
}

setInterval(() => {
  if (labels.items.length && performance.now() > labels.until) hideLabels(true);
  if (labels.pending && performance.now() - labels.pending.t > 1500) {
    labels.pending = null;
    logEvent(t('标号：没读到头指的那个窗口'), 'bad');
  }
}, 300);

let actionSource = null; // 正在执行的这批操作是谁发起的：'voice' 或 null（头控）
function applyControl(actions, source = null) {
  actionSource = source;
  const now = performance.now();
  const controlling = live.control.enabled;
  for (const a of actions) {
    if (a.type === 'freeze') {
      pointer?.setHold?.(a.on, a.at);
      // 停住时框出要点的按钮；恢复时去掉
      if (controlling) send(a.on && snap.target ? { type: 'highlight', x: snap.target.x, y: snap.target.y, w: snap.target.w, h: snap.target.h } : { type: 'highlight', on: false });
      if (!a.on) snap.target = null;
      // 歪头确认时把光标拉回开始歪头的位置；说完话恢复时不补停住期间的转头
      if (a.on && a.at && controlling) send({ type: 'cursor', x: a.at.x + space.origin.x, y: a.at.y + space.origin.y });
      if (!a.on && a.discard && pointer instanceof DeltaPointer) pointer.prev = null;
    }
    else if (a.type === 'yield') {
      pointer?.setHold?.(true);
      logEvent(t('键鼠在用，头控让位'));
    } else if (a.type === 'resume') {
      adoptSystemCursor();
      logEvent(t('键鼠停手了，头控恢复'));
    } else if (a.type === 'button') {
      const at = a.at ?? shownCursor();
      if (controlling) {
        // 点在回溯出来的位置（停留处，或对准后的按钮中心），各种模式都一样
        const pos = at ? { x: at.x + space.origin.x, y: at.y + space.origin.y } : {};
        send({ type: 'button', button: a.button, action: a.action, count: a.count ?? 1, mods: a.mods ?? [], ...pos });
      }
      if (a.action !== 'down') setTimeout(() => { snap.fresh = true; }, 300); // 点完界面多半变了，重读一次
      if (!control.frozen) snap.target = null;
      if (at) controlFx = { kind: a.action === 'click' ? (a.button === 'right' ? 'right' : a.count > 1 ? 'double' : 'click') : a.action, at: { ...at }, t: now };
      const kind = a.action === 'click' ? (a.button === 'right' ? 'right' : a.count > 1 ? 'double' : 'click') : a.action;
      if (a.action !== 'up') hud.ops++;
      logEvent(t(BUTTON_LOG[`${a.button}:${a.action}:${a.action === 'click' ? Math.min(a.count, 2) : 1}`]) + t(RELEASE_WHY[a.why] ?? ''), 'good', kind);
    } else if (a.type === 'window') {
      if (controlling) send({ type: 'window', action: a.action, ...(a.at ? { x: a.at.x + space.origin.x, y: a.at.y + space.origin.y } : {}) });
      hud.ops++;
      logEvent(t(WINDOW_LOG[a.action] ?? a.action), 'good', 'key');
    } else if (a.type === 'labels') {
      if (a.on) showLabels(a.at ?? shownCursor());
      else hideLabels(true);
    } else if (a.type === 'label') {
      pickLabel(a.n);
    } else if (a.type === 'key' && a.key === 'escape' && !a.mods?.length && labels.items.length) {
      hideLabels(true); // 标号亮着时说“取消”只收起标号，不按 Esc
    } else if (a.type === 'key') {
      if (controlling) send(a);
      const name = (k) => t(KEY_NAMES[k] ?? k.toUpperCase());
      if (a.action === 'releaseAll') logEvent(t('放开了按住的键'), 'good', 'key');
      else if (a.action === 'up') logEvent(t('松开 {k}', { k: name(a.key) }), 'good', 'key');
      else if (a.tilt) { hud.ops++; logEvent(t(a.action === 'down' ? '歪头按住 {k}' : '歪头按键 {k}', { k: name(a.key) }), 'good', 'key'); }
      else logEvent(t(a.action === 'down' ? '按住 {k}，说“松开”放开' : '按键 {k}', { k: [...(a.mods ?? []).map(name), name(a.key)].join(' + ') }), 'good', 'key');
    } else if (a.type === 'scroll' || a.type === 'zoom') {
      if (controlling) send(a);
      hud.ops++;
      logEvent(t(a.type === 'scroll' ? (a.dy > 0 ? '上滑' : '下滑') : a.dir === 'in' ? '放大' : '缩小'), 'good', (a.type === 'scroll' ? a.dy > 0 : a.dir === 'in') ? 'scrollUp' : 'scrollDown');
    } else if (a.type === 'clutch') {
      pointer?.setPaused?.(a.on);
      logEvent(t(a.on ? '光标暂停了，说“继续”恢复' : '光标继续'), 'good');
    } else if (a.type === 'recenter') {
      recenter();
      logEvent(t('光标回中'), 'good');
    } else if (a.type === 'cue') {
      if (controlling && $('c-sound').checked) send({ type: 'cue', name: a.name });
    } else if (a.type === 'reject') {
      hud.rejects++;
      logEvent(t('拦下一次误触：{why}', { why: t(REJECT[a.reason]) }), 'info', 'reject');
    }
  }
}

/** 键鼠用完、头控恢复时：增量和摇杆模式从系统光标现在的位置接着走；绝对模式回到头指的位置 */
function adoptSystemCursor() {
  pointer?.setHold?.(false);
  // 绝对模式不动偏移：头指哪光标就回到哪，校准不受手动操作影响
  if (!live.control.enabled || !sysCursor || !pointer || pointer instanceof AbsolutePointer) return;
  pointer.pos = { ...sysCursor };
  if (pointer instanceof DeltaPointer) pointer.prev = null; // 让位期间的转头不算
}

/** 屏幕下方的状态胶囊：接管鼠标时一直在，告诉用户现在是头在控、在拖拽，还是让给了键鼠 */
let driftShown = null;
function updateControlPill(now) {
  const dd = Math.abs(drift.offset) >= 0.5 ? drift.offset.toFixed(1) : null;
  if (dd !== driftShown) {
    driftShown = dd;
    $('drift-state').textContent = dd ? t('已自动纠正 {d}°。偏了说“回中”或按 C：先看着屏幕中间再说。', { d: dd }) : t('耳机的水平角会慢慢漂。偏了说“回中”或按 C：先看着屏幕中间再说。');
  }
  const st = control.status(now);
  const on = live.control.enabled;
  // 选了耳机、耳机桥在线：胶囊一直在，一键开始头控；接管后显示状态和“交还”
  const offer = !on && bridgeReady();
  const other = offer && live.control.other;
  const show = !run && (offer || (!!pointer && (on || st.mode !== 'ready')));
  document.body.classList.toggle('ctl-on', show);
  if (!show) return;
  const sec = (ms) => Math.max(0, ms / 1000).toFixed(1);
  // 歪头的映射和语音指令都要写出来：原来语音一开就只剩语音的说明，歪头做什么就看不到了
  const tiltHint = control.o.tilt ? TILT_HINTS[control.o.tiltMode] ?? TILT_HINTS.click : control.o.dwell ? '停住不动就点击' : '';
  const voiceHint = voiceState.on ? (tiltHint ? '也可以说“点击”“右键”“上滑”等指令' : '说“点击”“右键”“长按”“松开”“上滑”“下滑”，英文也行') : '';
  const gestures = [tiltHint, voiceHint].filter(Boolean).map((x) => t(x)).join(' · ') || t('点击已关闭');
  const text = other
    ? ['另一个网页正在控制鼠标', '同时开着几个网页时只有一个能控制；关掉别的网页，或在这里接管']
    : offer
    ? ['耳机已就绪', '开始后，头就是这台 Mac 的鼠标；动一下真实鼠标或按 Esc 随时收回']
    : {
      ready: [on ? (snap.target ? t('选中{role}', { role: t(ROLE_NAMES[snap.target.r] ?? '元素') }) : '头控中') : '头控（没接管鼠标，只在这里演示）', on && !live.control.trusted ? '缺“辅助功能”权限：只能移动，不能点击' : gestures],
      gesture: ['识别歪头…', '光标已停住，回正就点'],
      drag: ['左键按住中', t('再歪一次头松开 · {s} 秒后自动松开', { s: Math.ceil(st.left / 1000) })],
      yield: ['让给键鼠', t('停手 {s} 秒后头控恢复', { s: sec(st.left) })],
      dwell: ['准备点击', '保持不动，圈满就点'],
      voice: ['在听…', voiceState.text || '光标已停住，说指令'],
      keys: [t('按住 {k}', { k: (st.keys ?? []).join('、') }), '说“松开”放开'],
      dictate: ['语音输入中', '对着输入法说话，头回正就结束'],
    }[st.mode];
  // 刚认出的话在胶囊里留两秒
  if (!offer && st.mode === 'ready' && voiceState.on && now - voiceState.textAt < 2000) text[1] = t('听到：{s}', { s: voiceState.text });
  const mode = offer ? 'offer' : st.mode;
  $('ctl-pill').style.setProperty('--p', mode === 'dwell' ? st.progress : mode === 'yield' ? st.left / control.o.yieldMs : 0);
  $('ctl-pill').dataset.mode = mode;
  $('ctl-text').textContent = t(text[0]);
  $('ctl-sub').textContent = t(text[1]);
  $('ctl-stop').hidden = !on && !offer;
  $('ctl-stop').textContent = t(on ? '交还 · Esc' : other ? '在这里接管' : '开始头控');
  $('ctl-stop').classList.toggle('ink', offer);
}

/** 开始头控：绝对模式还没校准时，先换成不用校准的增量模式 */
function startControl() {
  setControl(true);
}
$('ctl-stop').onclick = () => (live.control.enabled ? setControl(false) : startControl());
// 光标的设置卡片平时要点场景里的光标才打开，从这里直接打开
$('ctl-settings').onclick = () => openPart('actions');

// ---------- 流程：校准与测试 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 有耳机桥时目标画在真实显示器上；否则浏览器全屏，再不行就铺满页面 */
async function beginRun() {
  applyControl(control.reset(performance.now())); // 校准和测试期间不识别手势，按住的键先松开
  pointer?.setHold?.(false);
  run = { kind: 'preparing' };
  document.body.classList.add('running');
  timeline.scrub(null);
  updateButtons();
  if (bridgeReady()) return;
  document.body.classList.add('inpage-run');
  if ($('stage-size').value !== 'phone' && document.fullscreenEnabled) {
    try {
      // 有的浏览器（比如嵌入式页面）既不允许也不拒绝，最多等 1.5 秒
      await Promise.race([$('stage-wrap').requestFullscreen(), sleep(1500)]);
      if (document.fullscreenElement) await sleep(500);
    } catch { /* 浏览器不允许全屏，就铺满页面 */ }
  }
  await sleep(50);
  resizeStage();
}

function endRun() {
  run = null;
  document.body.classList.remove('running', 'inpage-run');
  send({ type: 'overlay', on: false });
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  updateButtons();
}

document.addEventListener('fullscreenchange', () => {
  resizeStage();
  if (!document.fullscreenElement && run && run.kind !== 'preparing') endRun();
});

let overlayAt = 0;
function sendOverlay(now) {
  if (!run || !bridgeReady() || now - overlayAt < 30) return;
  overlayAt = now;
  const t = currentTarget(now);
  send({ type: 'overlay', target: t ? { x: t.x + space.origin.x, y: t.y + space.origin.y } : null, label: bannerText(now), progress: runProgress(now) });
}

function startCountdown(target, label, then, forCalibration = false) {
  run = { kind: 'countdown', t0: performance.now(), target, label, then, forCalibration };
}

/** 把以某块显示器左上角为原点的路径 / 测试，平移到屏幕坐标 */
function onScreen(obj, sc = mainScreen()) {
  const shift = (p) => p && { ...p, x: p.x + sc.x, y: p.y + sc.y };
  return { ...obj, at: (t) => shift(obj.at(t)), targets: obj.targets?.map(shift) };
}

$('btn-cal').onclick = async () => {
  if (run) return;
  await beginRun();
  const m = mainScreen();
  startCountdown(center(), t('准备路径校准：用鼻尖跟随红点'), () => {
    run = { kind: 'calibration', t0: performance.now(), path: onScreen(makeCalibrationPath(m.w, m.h)), samples: [] };
  }, true);
};

$('btn-grid').onclick = async () => {
  if (run) return;
  if (!pointer) {
    $('grid-result').innerHTML = `<p class="error">${t('光标还没法用：先校准指向线，或者把光标切到增量、摇杆模式。')}</p>`;
    return;
  }
  const sc = (selected?.startsWith('screen:') && space.screens[Number(selected.slice(7))]) || mainScreen();
  await beginRun();
  const test = onScreen(makeGridTest(sc.w, sc.h, { rounds: Math.max(1, num('grid-rounds')) }), sc);
  startCountdown(test.targets[0], t('准备精度测试：用鼻尖依次对准红点'), () => {
    run = { kind: 'grid', t0: performance.now(), test, screen: sc, records: [], lastIndex: 0 };
  });
};

function currentTarget(now) {
  if (!run) return null;
  const t = now - run.t0;
  if (run.kind === 'countdown') return run.target;
  if (run.kind === 'axes' || run.kind === 'center') return center();
  if (run.kind === 'centers') return run.targets[Math.min(Math.floor(t / CENTERS_STEP_MS), run.targets.length - 1)];
  if (run.kind === 'calibration') return run.path.at(t);
  if (run.kind === 'grid') return run.test.at(t);
  return null;
}

function runProgress(now) {
  if (!run) return null;
  const t = now - run.t0;
  const total = { center: CENTER_MS, centers: (run.targets?.length ?? 0) * CENTERS_STEP_MS, axes: run.total, calibration: run.path?.duration, grid: run.test?.duration }[run.kind];
  return total ? Math.min(t / total, 1) : null;
}

function advance(now) {
  if (!run) return;
  const t = now - run.t0;
  if (run.kind === 'countdown' && t >= COUNTDOWN_MS) run.then();
  else if (run.kind === 'center' && t >= CENTER_MS) finishCenter();
  else if (run.kind === 'centers' && t >= run.targets.length * CENTERS_STEP_MS) finishCenters();
  else if (run.kind === 'axes' && t >= run.total) finishAxes();
  else if (run.kind === 'calibration' && t >= run.path.duration) finishCalibration();
  else if (run.kind === 'grid') {
    const index = Math.floor(t / run.test.dwellMs);
    if (index > run.lastIndex) {
      if ($('grid-correct').checked && pointer instanceof AbsolutePointer) pointer.correct(run.test.targets[run.lastIndex], num('grid-gain'));
      run.lastIndex = index;
    }
    if (t >= run.test.duration) finishGrid();
  }
  if (run) sendOverlay(now);
}

function abortRun() {
  if (run) endRun();
}
$('run-stop').onclick = abortRun;

/** 流程进行中的胶囊：当前步骤、进度条；目标画在真实显示器上时提醒去那边看 */
function updateRunPill(now) {
  if (!run) return;
  $('run-text').textContent = bannerText(now) || t('正在准备…');
  $('run-where').textContent = bridgeReady() ? t('目标显示在你的显示器上') : '';
  $('run-bar').style.width = `${Math.round((runProgress(now) ?? 0) * 100)}%`;
}

function updateButtons() {
  for (const id of ['btn-cal', 'btn-grid', 'btn-center', 'btn-centers', 'btn-axes']) $(id).disabled = !!run;
}

const meanPose = (list) => ({ h: circularMeanDeg(list.map((s) => s.h)), v: circularMeanDeg(list.map((s) => s.v)), r: circularMeanDeg(list.map((s) => s.r)) });
const simTag = (src) => (src === 'sim' ? `<span class="tag-sim">${t('模拟数据')}</span>` : '');
const metric = (value, unit, label) => `<div class="metric"><b>${value}<small>${unit}</small></b><span>${label}</span></div>`;

// 中心校准：主显示器正中显示红点，取最后 1.5 秒的平均朝向作为“正前方”
const CENTER_MS = 2500;

$('btn-center').onclick = async () => {
  if (run) return;
  await beginRun();
  run = { kind: 'center', t0: performance.now(), samples: [] };
};

function finishCenter() {
  const { samples } = run;
  endRun();
  const use = samples.filter((s) => s.t >= CENTER_MS - 1500);
  if (use.length < 10) {
    $('center-result').innerHTML = `<p class="error">${t('没收到足够的数据。确认 AirPods 戴好、是这台 Mac 的声音输出，再试一次。')}</p>`;
    logEvent(t('中心校准没成功'), 'bad');
    scene.play('No');
    return;
  }
  zero = meanPose(use);
  centered = true;
  drift.recenter();
  if (calib) {
    calib.ref = { h: zero.h, v: zero.v };
    rebuildPointer();
  } else if (pointer instanceof AbsolutePointer) {
    rebuildPointer();
  } else if (pointer?.recenter) {
    pointer.recenter(space, center());
  }
  sessions.push({ type: 'center', startedAt: new Date().toISOString(), samples, zero });
  $('center-result').innerHTML = `<p class="verdict">${t('正前方定好了{sim}', { sim: simTag(sourceKind) })}</p>`;
  logEvent(t('定好了正前方'), 'good');
  scene.play('Yes');
}

// 多屏定点：依次对准每块显示器中心（只有一块时加左右两点），拟合“转头角度 ↔ 像素”的比例和正前方
const CENTERS_STEP_MS = 2600;

$('btn-centers').onclick = async () => {
  if (run) return;
  await beginRun();
  const main = mainScreen();
  const others = space.screens.filter((s) => s !== main).sort((a, b) => a.x - b.x);
  const targets = [main, ...others].map((s) => ({ ...center(s), name: s.name }));
  if (targets.length === 1) {
    targets.push({ x: main.x + main.w * 0.15, y: main.y + main.h / 2, name: '左侧' }, { x: main.x + main.w * 0.85, y: main.y + main.h / 2, name: '右侧' });
  }
  run = { kind: 'centers', t0: performance.now(), targets, samples: [] };
};

function finishCenters() {
  const { targets, samples } = run;
  endRun();
  // 每个点前 1.1 秒用来转头过去，只用之后的数据
  const groups = targets.map((_, i) => samples.filter((s) => s.t >= i * CENTERS_STEP_MS + 1100 && s.t < (i + 1) * CENTERS_STEP_MS));
  const session = { type: 'centers', startedAt: new Date().toISOString(), layout: space.screens, targets, samples };
  try {
    if (groups.some((g) => g.length < 10)) throw new Error('有的点没收到足够的数据。确认耳机数据正常，再试一次。');
    const ref = meanPose(groups[0]);
    const points = groups.map((g, i) => {
      const p = meanPose(g);
      return { x: targets[i].x, y: targets[i].y, h: wrapDeg(p.h - ref.h), v: wrapDeg(p.v - ref.v) };
    });
    const model = fitCenters(points);
    calib = { kind: 'centers', result: { ref: { h: ref.h, v: ref.v }, models: { affine: model, quadratic: model } }, ref: { h: ref.h, v: ref.v }, G: model.G, layoutKey: layoutKey(), source: sourceKind };
    zero = ref;
    centered = true;
    drift.recenter();
    session.result = { G: model.G, rms: model.rms, points };
    rebuildPointer();
    const deg = Math.atan(1000 / model.G) / RAD;
    $('centers-result').innerHTML = `<p class="verdict">${t('{n} 个点对上了{sim}', { n: targets.length, sim: simTag(sourceKind) })}</p>
      <div class="metrics">${metric(deg.toFixed(1), '°', t('光标走 1000 px 要转的头'))}${metric(model.rms.toFixed(0), 'px', t('各点的平均偏差'))}</div>`;
    logEvent(t('多屏定点完成'), 'good');
    scene.play('Yes');
  } catch (err) {
    session.error = err.message;
    $('centers-result').innerHTML = `<p class="error">${t(err.message)}</p>`;
    logEvent(t('多屏定点没成功'), 'bad');
    scene.play('No');
  }
  sessions.push(session);
}

function finishCalibration() {
  const { path, samples } = run;
  endRun();
  const m = mainScreen();
  const session = { type: 'calibration', startedAt: new Date().toISOString(), settings: snapshotSettings(), path: { w: m.w, h: m.h, offset: { x: m.x, y: m.y }, duration: path.duration, segments: path.segments }, samples };
  try {
    const result = calibrate(samples, path);
    session.result = result;
    const a = result.models.affine;
    calib = { kind: 'path', result, ref: { ...result.ref }, G: (a.cx[1] - a.cy[2]) / 2, layoutKey: layoutKey(), source: sourceKind };
    zero = { h: result.ref.h, v: result.ref.v, r: zero?.r ?? last?.r ?? 0 };
    drift.recenter();
    centered = true;
    const p = (a.rms / Math.hypot(m.w, m.h)) * 100;
    $('cal-result').innerHTML = `<p class="verdict">${t('拟合偏差约为屏幕对角线的 {p}%{sim}', { p: p.toFixed(1), sim: simTag(calib.source) })}</p>
      <div class="metrics">${metric(result.lagMs, 'ms', t('你跟上目标用的时间'))}${metric(a.rms.toFixed(0), 'px', t('仿射模型偏差'))}${metric(result.models.quadratic.rms.toFixed(0), 'px', t('二次模型偏差'))}${metric(a.n, '', t('用到的样本'))}</div>`;
    drawLagChart(result);
    rebuildPointer();
    logEvent(t('路径校准完成'), 'good');
    scene.play('Yes');
  } catch (err) {
    session.error = err.message;
    $('cal-result').innerHTML = `<p class="error">${t('没校准成功：{msg}', { msg: t(err.message) })}</p>`;
    $('lag-figure').hidden = true;
    logEvent(t('路径校准没成功'), 'bad');
    scene.play('No');
  }
  sessions.push(session);
}

function finishGrid() {
  const { test, records, screen: sc } = run;
  endRun();
  const r = evaluateGrid(test, records);
  sessions.push({ type: 'grid', startedAt: new Date().toISOString(), settings: snapshotSettings(), screen: sc, correction: $('grid-correct').checked ? num('grid-gain') : 0, test: { w: test.w, h: test.h, dwellMs: test.dwellMs, rounds: test.rounds, targets: test.targets }, records, result: r });
  const f = (v) => (v == null ? '–' : v.toFixed(0));
  const p = r.meanError == null ? null : (r.meanError / r.diagonal) * 100;
  if (p != null) hud.accuracy = { p, source: sourceKind };
  const rounds = r.byRound.length > 1 ? `<p class="detail">${t('每轮平均偏差：{list} px。越来越大说明在漂移。', { list: r.byRound.map(f).join(' → ') })}</p>` : '';
  $('grid-result').innerHTML = `<p class="verdict">${t('平均偏差约为对角线的 {p}%{sim}', { p: p == null ? '–' : p.toFixed(1), sim: simTag(sourceKind) })}</p>
    <div class="metrics">${metric(f(r.meanError), 'px', t('平均偏差'))}${metric(f(r.maxError), 'px', t('最大偏差'))}${metric(f(r.meanJitter), 'px', t('停住时的抖动'))}${metric(r.perTarget.length, '', t('目标'))}</div>${rounds}`;
  logEvent(t('测完准度：平均 {e} px', { e: f(r.meanError) }), p != null && p < 1.5 ? 'good' : 'warn');
}

function drawLagChart(r) {
  $('lag-figure').hidden = false;
  const c = $('lag-chart');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth;
  const H = c.clientHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pts = r.lagCurve;
  const maxLag = pts.at(-1).lag || 1;
  const lo = Math.min(...pts.map((p) => p.rms));
  const hi = Math.max(...pts.map((p) => p.rms));
  const x = (lag) => 4 + (lag / maxLag) * (W - 8);
  const y = (rms) => H - 18 - ((rms - lo) / (hi - lo || 1)) * (H - 26);
  g.strokeStyle = css('--violet');
  g.lineWidth = 2;
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(p.lag), y(p.rms)) : g.moveTo(x(p.lag), y(p.rms))));
  g.stroke();
  g.fillStyle = css('--gold');
  g.beginPath();
  g.arc(x(r.lagMs), y(lo), 5, 0, 2 * Math.PI);
  g.fill();
  g.fillStyle = css('--text-2');
  g.font = '10px "Unbounded Variable", sans-serif';
  g.fillText('0', 4, H - 3);
  g.textAlign = 'right';
  g.fillText(`${maxLag} ms`, W - 4, H - 3);
}

// 轴方向向导：依次提示动作，每段取最后 1.5 秒和基线比较，变化最大的轴就是这个动作对应的轴
const AXIS_STEPS = [
  { key: 'base', label: '正对屏幕，保持不动', ms: 3000 },
  { key: 'right', label: '向右转头，保持', ms: 3000 },
  { key: 'back1', label: '回正', ms: 2000 },
  { key: 'up', label: '抬头，保持', ms: 3000 },
  { key: 'back2', label: '回正', ms: 2000 },
  { key: 'tilt', label: '向右歪头（右耳靠向右肩），保持', ms: 3000 },
];

function axisStepAt(t) {
  let t0 = 0;
  for (const st of AXIS_STEPS) {
    if (t < t0 + st.ms) return { ...st, left: t0 + st.ms - t };
    t0 += st.ms;
  }
  return null;
}

$('btn-axes').onclick = async () => {
  if (run) return;
  await beginRun();
  run = { kind: 'axes', t0: performance.now(), total: AXIS_STEPS.reduce((a, st) => a + st.ms, 0), samples: [] };
};

function finishAxes() {
  const { samples } = run;
  endRun();
  const keys = ['yaw', 'pitch', 'roll'];
  const segment = (key) => {
    let t0 = 0;
    for (const st of AXIS_STEPS) {
      if (st.key === key) return samples.filter((s) => s.t >= t0 + st.ms - 1500 && s.t < t0 + st.ms);
      t0 += st.ms;
    }
    return [];
  };
  const mean = (list, key) => circularMeanDeg(list.map((s) => s[key]));
  const base = segment('base');
  if (base.length < 10) {
    $('axes-result').innerHTML = `<p class="error">${t('没收到足够的数据。确认耳机数据正常，再试一次。')}</p>`;
    return;
  }
  const deltas = {};
  for (const step of ['right', 'up', 'tilt']) {
    const w = segment(step);
    deltas[step] = Object.fromEntries(keys.map((key) => [key, w.length ? wrapDeg(mean(w, key) - mean(base, key)) : 0]));
  }
  const pick = (d) => keys.reduce((a, b) => (Math.abs(d[b]) > Math.abs(d[a]) ? b : a));
  const found = { right: pick(deltas.right), up: pick(deltas.up), tilt: pick(deltas.tilt) };
  sessions.push({ type: 'axes', startedAt: new Date().toISOString(), samples, deltas, found });
  const weak = Object.entries(found).some(([step, key]) => Math.abs(deltas[step][key]) < 5);
  if (new Set(Object.values(found)).size < 3 || weak) {
    $('axes-result').innerHTML = `<p class="error">${t('动作幅度不够，或者几个动作落在了同一根轴上，设置没动。动作再大一些（至少 5°）再试。')}</p>`;
    scene.play('No');
    return;
  }
  // 歪头那一步的转轴就是头的前后轴：用它消掉斜戴带来的串扰
  let tiltNote = '';
  const qs = (list) => list.map((x) => x.q).filter(Boolean);
  if (qs(base).length > 10 && qs(segment('tilt')).length > 10) {
    const fw = forwardFromTilt(meanQuat(qs(base)), meanQuat(qs(segment('tilt'))));
    if (fw.angleDeg >= 8) {
      forward = { f: fw.f, offDeg: fw.offDeg, at: new Date().toISOString() };
      store.set(FORWARD_KEY, forward);
      sessions.at(-1).forward = forward;
      tiltNote = t('耳机斜戴了 {d}°，已校正：歪头不会再带偏光标。', { d: fw.offDeg.toFixed(1) });
      logEvent(tiltNote, 'good');
    }
  }
  $('axis-h').value = found.right;
  $('axis-v').value = found.up;
  $('inv-h').checked = deltas.right[found.right] < 0;
  $('inv-v').checked = deltas.up[found.up] < 0;
  $('inv-r').checked = deltas.tilt[found.tilt] < 0;
  axesChanged();
  const inv = (on) => (on ? t('，反转') : '');
  $('axes-result').innerHTML = `<p class="verdict">${t('认出来了，已经用上')}</p><p class="detail">${t('水平 = {h}；垂直 = {v}；歪头 = {r}', { h: found.right + inv($('inv-h').checked), v: found.up + inv($('inv-v').checked), r: found.tilt + inv($('inv-r').checked) })}</p>${tiltNote ? `<p class="detail">${tiltNote}</p>` : ''}`;
  scene.play('Yes');
}

const tr = t;
function bannerText(now) {
  if (!run || run.kind === 'preparing') return '';
  const t = now - run.t0;
  if (run.kind === 'countdown') return `${tr(run.label)} · ${Math.ceil((COUNTDOWN_MS - t) / 1000)}`;
  if (run.kind === 'center') return tr('用鼻尖对准屏幕正中的红点，保持不动 · {n}', { n: Math.max(1, Math.ceil((CENTER_MS - t) / 1000)) });
  if (run.kind === 'centers') {
    const i = Math.min(Math.floor(t / CENTERS_STEP_MS), run.targets.length - 1);
    return tr('用鼻尖对准红点（{name}）· {i} / {n}', { name: tr(run.targets[i].name), i: i + 1, n: run.targets.length });
  }
  if (run.kind === 'axes') {
    const st = axisStepAt(t);
    return st ? `${tr(st.label)} · ${Math.ceil(st.left / 1000)}` : tr('正在计算…');
  }
  if (run.kind === 'calibration') {
    const p = run.path.at(t);
    if (!p) return tr('正在计算…');
    return p.phase === 'center' ? tr('对准中心') : p.phase === 'corner' ? tr('依次对准四个角') : tr('沿边跟随，第 {lap} / 2 圈', { lap: p.lap });
  }
  if (run.kind === 'grid') {
    const p = run.test.at(t);
    return p ? tr('精度测试 {i} / {n}', { i: p.index + 1, n: run.test.targets.length }) : '';
  }
  return '';
}

// ---------- 页面内校准画布（没有耳机桥时） ----------

const canvas = $('stage');
const ctx = canvas.getContext('2d');
const stage = { w: 0, h: 0 };
let k = 1;
let stageMouse = null;
canvas.addEventListener('pointermove', (e) => { stageMouse = { x: e.offsetX / k, y: e.offsetY / k }; });

function resizeStage() {
  const wrap = $('stage-wrap');
  const W = wrap.clientWidth || innerWidth;
  const H = wrap.clientHeight || innerHeight;
  const scale = Math.min(W / space.w, H / space.h);
  const w = Math.max(1, Math.round(space.w * scale));
  const h = Math.max(1, Math.round(space.h * scale));
  k = w / space.w;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  Object.assign(stage, { w, h });
}
new ResizeObserver(resizeStage).observe($('stage-wrap'));

function drawStage(now) {
  if (!document.body.classList.contains('inpage-run')) return;
  const { w, h } = stage;
  ctx.clearRect(0, 0, w, h);
  for (const sc of space.screens) {
    ctx.fillStyle = css('--paper');
    ctx.beginPath();
    ctx.roundRect(sc.x * k + 2, sc.y * k + 2, sc.w * k - 4, sc.h * k - 4, 14);
    ctx.fill();
  }
  const target = currentTarget(now);
  if (target) {
    for (const [r, c] of [[19, '#fff'], [14, css('--pink')], [4.5, '#fff']]) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(target.x * k, target.y * k, r, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  const banner = bannerText(now);
  if (banner) {
    ctx.font = '600 17px -apple-system, "PingFang SC", sans-serif';
    const tw = ctx.measureText(banner).width;
    ctx.fillStyle = css('--ink');
    ctx.beginPath();
    ctx.roundRect(w / 2 - tw / 2 - 20, 28, tw + 40, 40, 20);
    ctx.fill();
    ctx.fillStyle = css('--paper');
    ctx.textAlign = 'center';
    ctx.fillText(banner, w / 2, 54);
    ctx.textAlign = 'start';
  }
}

// ---------- 时间轴与事件 ----------

const timeline = new Timeline($('timeline'), {
  onScrub(t) {
    replayT = t;
    if (t == null) delete document.body.dataset.replay;
    else document.body.dataset.replay = '';
    $('btn-live').setAttribute('aria-pressed', String(t == null));
  },
  onHover(e, clientX) {
    const tip = $('tl-tip');
    if (!e) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    tip.textContent = t(e.label);
    tip.style.left = `${clientX - $('timeline').getBoundingClientRect().left}px`;
  },
});
$('btn-live').onclick = () => timeline.scrub(null);

/** kind：头控、语音操作的种类，时间轴按它画不同的标记；系统事件不传 */
function logEvent(label, level = 'info', kind = null) {
  timeline.event(performance.now(), label, level, kind, kind != null && actionSource === 'voice');
  pushStream({ t: performance.now(), log: label, level });
}

// ---------- 部件：点哪里，哪里展开 ----------

// 第一人称的像素画布和第三人称的 3D 画布都在 #scene 里，事件绑在容器上
const sceneCanvas = $('scene');
let downAt = null;
sceneCanvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
sceneCanvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const part = scene.pick(e.clientX, e.clientY);
  if (part) openPart(part);
  else closePart();
});
let hoverAt = 0;
sceneCanvas.addEventListener('pointermove', (e) => {
  if (e.buttons || performance.now() - hoverAt < 80) return;
  hoverAt = performance.now();
  document.body.classList.toggle('hovering', !!scene.pick(e.clientX, e.clientY));
});

// 设置面板只有四个（耳机、校准、光标、操作）加“更多”菜单。3D 里点到的部件归到对应的面板：
// 耳机和头 → 耳机；指向线和显示器 → 校准（显示器里是准度测试）；光标 → 光标
const PANEL_OF = { pods: 'pods', head: 'pods', calib: 'calib', ray: 'calib', cursor: 'cursor', actions: 'actions' };
const panelOf = (part) => (part?.startsWith('screen') ? 'calib' : PANEL_OF[part] ?? part);
const cardFor = (part) => document.querySelector(`.callout[data-part="${panelOf(part)}"]`);
function markPanelButtons() {
  const open = selected ? panelOf(selected) : null;
  for (const b of $$('[data-panel]')) b.setAttribute('aria-pressed', String(b.dataset.panel === open));
}

function openPart(part) {
  closeMenu();
  for (const c of $$('.callout')) c.hidden = true;
  selected = part;
  scene.select(part);
  cardFor(part).hidden = false;
  document.body.classList.add('has-callout');
  if (panelOf(part) === 'calib') fillScreenCard(part.startsWith('screen') ? Number(part.slice(7)) : space.screens.indexOf(mainScreen()));
  markPanelButtons();
  updateStats(performance.now(), true);
}
// 顶栏的几个设置按钮：点一下打开，再点一下关上
for (const b of $$('[data-panel]')) {
  b.onclick = () => (selected && panelOf(selected) === b.dataset.panel ? closePart() : openPart(b.dataset.panel));
}

function closePart() {
  selected = null;
  scene.select(null);
  for (const c of $$('.callout')) c.hidden = true;
  document.body.classList.remove('has-callout');
  markPanelButtons();
}
for (const x of $$('.callout .x')) x.onclick = closePart;

function fillScreenCard(i) {
  const sc = space.screens[i];
  if (!sc) return;
  $('screen-title').textContent = `${t('准度测试')} · ${t('显示器 {no} · {name}', { no: sc.no, name: t(sc.name) })}`;
  setState('screen-state', t(sc.main ? t('{w} × {h}，主显示器，位置 {x}, {y}') : t('{w} × {h}，位置 {x}, {y}'), { w: sc.w, h: sc.h, x: sc.x + space.origin.x, y: sc.y + space.origin.y }), 'ok');
}

/** 卡片放在部件旁边，用一条引线连过去 */
function placeCard() {
  const card = selected && cardFor(selected);
  if (!card || card.hidden || matchMedia('(max-width: 720px)').matches) return;
  const a = scene.anchor(selected);
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const gap = 18;
  const topLimit = 76;
  const bottomLimit = innerHeight - 104;
  let x;
  let y;
  // 卡片固定靠在画面右侧（和“更多”菜单同一个位置），不盖住中间的机器人和屏幕；引线从部件连过来
  x = innerWidth - w - gap;
  y = a ? Math.min(Math.max(a.y - h * 0.3, topLimit), Math.max(bottomLimit - h, topLimit)) : topLimit;
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  const line = $('leader').querySelector('line');
  const dot = $('leader').querySelector('circle');
  if (a) {
    const ex = x > a.x ? x : x + w;
    const ey = Math.min(Math.max(a.y, y + 24), y + h - 24);
    line.setAttribute('x1', a.x);
    line.setAttribute('y1', a.y);
    line.setAttribute('x2', ex);
    line.setAttribute('y2', ey);
    dot.setAttribute('cx', a.x);
    dot.setAttribute('cy', a.y);
    $('leader').style.visibility = 'visible';
  } else {
    $('leader').style.visibility = 'hidden';
  }
}

// ---------- 游戏厅（ui/arcade.js） ----------
// 头部数据给游戏：耳机数据用相对姿态；模拟数据时，游戏画面上的鼠标位置直接当成头的朝向（不带模拟的延迟和噪声），
// 歪头仍然用 [ ] 键
const arcade = new Arcade(GAMES, {
  getPose: () => {
    if (sourceKind === 'sim') {
      if (!arcade.mouse) return last ? { h: 0, v: 0, r: poseOf(last)?.r ?? 0 } : null;
      return { h: arcade.mouse.x * arcade.input.rangeH * 1.05, v: -arcade.mouse.y * arcade.input.rangeV * 1.05, r: poseOf(last)?.r ?? 0 };
    }
    return last && performance.now() - last.t < STALE_MS ? poseOf(last) : null;
  },
  t,
  lang: getLang,
  // 玩游戏时把系统鼠标交还：头只在游戏里用，不然点头摇头会把真光标甩到别的屏幕、点到别的窗口
  onOpen: () => {
    arcadeHadControl = live.control.enabled;
    if (arcadeHadControl) {
      setControl(false);
      logEvent(t('玩游戏时先交还鼠标，退出游戏后自动接回'));
    }
  },
  onClose: () => {
    if (arcadeHadControl && bridgeReady()) setControl(true);
    arcadeHadControl = false;
  },
});
let arcadeHadControl = false;
window.nodlink.arcade = arcade; // 方便在控制台里调试游戏
$('btn-arcade').onclick = () => {
  closeMenu();
  closePart();
  arcade.show();
};

// ---------- 试一试（ui/challenge.js）：四个日常小场景 ----------
// 不交还鼠标：页面看到的就是真实的系统点击和按键。每个场景切到合适的歪头场景，退出时恢复设置里选的
const challenge = new Challenge({
  t,
  onLevel: (mode) => {
    if (mode) control.set({ tilt: true, tiltMode: mode });
    else applyControlOptions();
  },
  context: () => ({
    source: sourceKind,
    control: live.control.enabled,
    cursorMode: cursorMode(),
    tiltMode: control.o.tiltMode,
    voice: $('c-voice').checked,
    snap: $('c-snap').checked,
  }),
});
window.nodlink.challenge = challenge;
$('btn-challenge').onclick = () => {
  closeMenu();
  closePart();
  challenge.show();
};
// 奶蛙：直接进游戏厅里的奶蛙（ui/games/naiwa.js），返回就回到调试台
$('btn-naiwa').onclick = () => {
  closeMenu();
  closePart();
  arcade.show('naiwa');
};

// ---------- 新手引导：连接耳机 → 定正前方 → 开始头控 ----------

let guideKey = '';
function updateGuide() {
  const streaming = !!last && performance.now() - last.t < STALE_MS;
  const done = {
    pods: sourceKind === 'live' && streaming,
    center: centered || !!calib,
    control: live.control.enabled,
  };
  const order = ['pods', 'center', 'control'];
  const current = order.find((k) => !done[k]) ?? null;
  const key = JSON.stringify([done, current]);
  if (key === guideKey) return;
  guideKey = key;
  document.body.classList.toggle('guide-done', !current);
  for (const b of $$('#first-hint [data-step]')) {
    const k = b.dataset.step;
    b.dataset.state = done[k] ? 'done' : k === current ? 'current' : 'todo';
    b.querySelector('i').textContent = done[k] ? '✓' : String(order.indexOf(k) + 1);
  }
}
for (const b of $$('#first-hint [data-step]')) {
  b.onclick = () => {
    const k = b.dataset.step;
    if (k === 'pods') {
      if (sourceKind !== 'live') {
        const r = document.querySelector('input[name=source][value=live]');
        r.checked = true;
        r.onchange();
      }
      openPart('pods');
    } else if (k === 'center') openPart('calib');
    else if (bridgeReady()) setControl(true);
    else openPart('pods');
  };
}

// ---------- 正在指向：头指的那个点下面是哪个 App 的什么元素（耳机桥读辅助功能） ----------

const pointedAt = { at: 0, sentAt: 0, info: null };
function onPointing(m) {
  pointedAt.info = m.app || m.label ? m : null;
  pointedAt.at = performance.now();
}
function updatePointing(now) {
  const c = shownCursor();
  const liveData = sourceKind === 'live' && bridgeReady() && !!last && now - last.t < STALE_MS;
  if (liveData && c && !run && now - pointedAt.sentAt > 150) {
    pointedAt.sentAt = now;
    send({ type: 'point', x: c.x + space.origin.x, y: c.y + space.origin.y });
  }
  const info = liveData && now - pointedAt.at < 1000 ? pointedAt.info : null;
  const el = $('pointing');
  const a = info && replayT == null ? scene.anchor('cursor') : null;
  el.hidden = !a;
  miniMap.setPointing(info ? pointingText(info) : null);
  if (!a) return;
  const app = info.app ?? '';
  const what = pointingText(info, true);
  if (el.dataset.k !== app + what) {
    el.dataset.k = app + what;
    el.querySelector('.pointing-app').textContent = app;
    el.querySelector('.pointing-what').textContent = what;
  }
  el.style.transform = `translate3d(${Math.round(a.x + 18)}px, ${Math.round(a.y + 14)}px, 0)`;
}
/** “按钮「关闭」”；withoutApp=false 时前面带上 App 名 */
function pointingText(info, withoutApp = false) {
  const role = info.role ? t(ROLE_NAMES[info.role] ?? '') : '';
  const label = info.label ? `「${info.label}」` : '';
  const what = (role + label) || t('空白处');
  return withoutApp || !info.app ? what : `${info.app} · ${what}`;
}

function setState(id, text, level) {
  const el = $(id);
  el.textContent = text;
  el.dataset.level = level;
}

// ---------- 暗驾驶舱：只有出问题的部件才亮 ----------

/** 每个部件的问题：{ level: 'warn' | 'bad', text } 或没有 */
function computeAlerts(streaming) {
  const a = {};
  if (sourceKind === 'live') {
    if (!live.relay) a.pods = { level: 'bad', text: t('中继没连上') };
    else if (!live.sources) a.pods = { level: 'warn', text: t('耳机桥没运行') };
    else if (!streaming) a.pods = { level: podsStatus().level === 'bad' ? 'bad' : 'warn', text: podsStatus().text };
  }
  if (calib && calib.layoutKey !== layoutKey() && cursorMode() === 'absolute') a.ray = { level: 'warn', text: t('显示器变了，要重新校准') };
  if (live.control.enabled && !live.control.trusted) a.cursor = { level: 'warn', text: t('缺辅助功能权限') };
  else if (pointer?.paused) a.cursor = { level: 'warn', text: t('离合中，按空格恢复') };
  return a;
}

const tags = new Map();
let alerts = {};

function syncTags() {
  for (const [part, el] of tags) {
    if (!alerts[part] || part === selected) {
      el.remove();
      tags.delete(part);
    }
  }
  for (const [part, al] of Object.entries(alerts)) {
    if (part === selected) continue;
    let el = tags.get(part);
    if (!el) {
      el = document.createElement('button');
      el.className = 'tag';
      el.onclick = () => openPart(part === 'head' || part === 'ray' ? 'calib' : part); // 这两样提醒的都是校准
      $('layer').append(el);
      tags.set(part, el);
    }
    el.dataset.level = al.level;
    el.textContent = al.text;
  }
}

function placeTags() {
  for (const [part, el] of tags) {
    const a = scene.anchor(part);
    el.style.display = a ? '' : 'none';
    if (a) {
      el.style.left = `${a.x}px`;
      el.style.top = `${a.y}px`;
    }
  }
}

// ---------- 探针：钉在部件上的读数 ----------

const PROBES = {
  'pods:rate': { label: '采样率', value: (f) => (replayT == null && rateNow ? `${rateNow.toFixed(0)} Hz` : '–') },
  // 和四周仪表盘一样：相对正前方、歪头相对平时的中立位、平滑过的数（直接取仪表上显示的值）。
  // 原来这里是传感器原始角度，零点是耳机开始传数据那一刻，和仪表对不上，看着像出错
  'pods:yaw': { label: 'yaw', value: () => deg(instruments.val.yaw) },
  'pods:pitch': { label: 'pitch', value: () => deg(instruments.val.pitch) },
  'pods:roll': { label: 'roll', value: () => deg(instruments.val.roll) },
  'head:h': { label: '水平角', value: (f) => deg(f?.pose?.h) },
  'head:v': { label: '垂直角', value: (f) => deg(f?.pose?.v) },
  'head:wave': { label: '朝向，近 10 秒', wave: (fr) => [fr.map((p) => p.pose?.h), fr.map((p) => p.pose?.v)] },
  'ray:error': {
    label: '落点和光标差',
    value: (f) => {
      const hit = hitPx(f?.pose);
      return hit && f?.cursor ? `${Math.hypot(hit.x - f.cursor.x, hit.y - f.cursor.y).toFixed(0)} px` : '–';
    },
  },
  'cursor:pos': { label: '光标位置', value: (f) => (f?.cursor ? `${f.cursor.x.toFixed(0)}, ${f.cursor.y.toFixed(0)}` : '–') },
  'cursor:wave': { label: '光标 x，滤波前后', wave: (fr) => [fr.map((p) => p.raw?.x), fr.map((p) => p.cursor?.x)] },
};
const deg = (v) => (v == null || !Number.isFinite(v) ? '–' : `${v.toFixed(1)}°`);
let rateNow = null;
let probes = (store.get('nodlink.probes') ?? []).filter((id) => PROBES[id]);
const probeEls = new Map(); // 探针 id → 卡片里的一行
const probeCards = new Map(); // 部件 → { card, line, dot }：同一个部件的探针收进一张卡片
let probeSvg = null;

function dropCard(c) {
  for (const el of [c.card, c.line, c.dot]) el.remove();
}

function syncProbes() {
  for (const [id, el] of probeEls) {
    if (!probes.includes(id)) {
      el.remove();
      probeEls.delete(id);
    }
  }
  if (!probeSvg) {
    probeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    probeSvg.classList.add('probe-leaders');
    probeSvg.setAttribute('aria-hidden', 'true');
    $('layer').prepend(probeSvg);
  }
  for (const id of probes) {
    if (probeEls.has(id)) continue;
    const part = id.split(':')[0];
    let c = probeCards.get(part);
    if (!c) {
      const card = document.createElement('div');
      card.className = 'probe';
      $('layer').append(card);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '3');
      probeSvg.append(line, dot);
      c = { card, line, dot };
      probeCards.set(part, c);
    }
    const def = PROBES[id];
    const el = document.createElement('div');
    el.className = def.wave ? 'probe-row wave' : 'probe-row';
    el.innerHTML = `<span>${t(def.label)}</span>${def.wave ? '<canvas></canvas>' : '<b>–</b>'}<button aria-label="${t('取下探针')}"><svg><use href="#i-close"/></svg></button>`;
    el.querySelector('button').onclick = () => togglePin(id);
    c.card.append(el);
    probeEls.set(id, el);
  }
  for (const [part, c] of probeCards) {
    if (c.card.children.length) continue;
    dropCard(c);
    probeCards.delete(part);
  }
  for (const b of $$('[data-pin]')) b.setAttribute('aria-pressed', String(probes.includes(b.dataset.pin)));
  store.set('nodlink.probes', probes);
}

function togglePin(id) {
  probes = probes.includes(id) ? probes.filter((p) => p !== id) : [...probes, id];
  syncProbes();
}
for (const b of $$('[data-pin]')) b.onclick = () => togglePin(b.dataset.pin);

/**
 * 探针卡片放在部件朝外的一侧（部件在画面左半边就放左边），离开主体，用一根折线连回部件，
 * 不再一列压在机器人身上。同一侧的几张卡片上下错开
 */
function drawProbes(frame) {
  const visible = true;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const top = 84;
  const bottom = H - 150;
  const placed = { '-1': [], 1: [] };
  const gap = 110; // 卡片离部件的水平距离
  for (const [part, c] of probeCards) {
    const a = visible ? scene.anchor(part) : null;
    for (const el of [c.card, c.line, c.dot]) el.style.display = a ? '' : 'none';
    if (!a) continue;
    const side = a.x < W / 2 ? -1 : 1;
    const w = c.card.offsetWidth;
    const h = c.card.offsetHeight;
    let x = side < 0 ? a.x - gap - w : a.x + gap;
    x = Math.max(16, Math.min(W - w - 16, x));
    let y = Math.max(top, Math.min(bottom - h, a.y - h / 2));
    for (const r of placed[side]) if (y < r.y + r.h + 10 && y + h > r.y - 10) y = r.y + r.h + 10;
    placed[side].push({ y, h });
    c.card.style.transform = `translate3d(${x.toFixed(0)}px,${y.toFixed(0)}px,0)`;
    // 折线：部件 → 斜着走一小段 → 卡片朝向部件那条边上
    const ex = side < 0 ? x + w : x;
    const ey = y + Math.min(h / 2, 22);
    const kx = a.x + side * 28;
    c.line.setAttribute('points', `${a.x.toFixed(1)},${a.y.toFixed(1)} ${kx.toFixed(1)},${ey.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`);
    c.dot.setAttribute('cx', a.x.toFixed(1));
    c.dot.setAttribute('cy', a.y.toFixed(1));
  }
  for (const id of probes) {
    const el = probeEls.get(id);
    if (!el || el.parentElement.style.display === 'none') continue;
    const def = PROBES[id];
    if (def.value) {
      const v = def.value(frame);
      const b = el.querySelector('b');
      if (b.textContent !== v) b.textContent = v;
    } else drawWave(el.querySelector('canvas'), def.wave(windowFrames(frame?.t)));
  }
}

function windowFrames(t) {
  if (t == null) return [];
  const out = [];
  for (let i = history.length - 1; i >= 0 && history[i].t >= t - 10_000; i--) if (history[i].t <= t) out.push(history[i]);
  return out.reverse();
}

function drawWave(c, series) {
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth;
  const H = c.clientHeight;
  if (c.width !== W * dpr) {
    c.width = W * dpr;
    c.height = H * dpr;
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const vals = series.flat().filter((v) => v != null);
  if (!vals.length) return;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = Math.max(hi - lo, 1e-6);
  const colors = [css('--text-2'), css('--wave')];
  series.forEach((s, k2) => {
    g.strokeStyle = colors[k2];
    g.lineWidth = k2 ? 2 : 1.3;
    g.beginPath();
    let started = false;
    s.forEach((v, i) => {
      if (v == null) return;
      const x = (i / Math.max(s.length - 1, 1)) * W;
      const y = H - 3 - ((v - lo) / span) * (H - 6);
      if (started) g.lineTo(x, y);
      else g.moveTo(x, y);
      started = true;
    });
    g.stroke();
  });
}

// ---------- 镜头 ----------

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  cssCache.clear();
  scene.setTheme();
});

// ---------- 外观：跟随系统（默认）、浅色、深色，在“更多”里选，记在本机 ----------

function setAppearance(mode) {
  if (mode !== 'light' && mode !== 'dark') mode = 'auto';
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  store.set('nodlink.theme', mode);
  cssCache.clear();
  scene.setTheme();
}
// 顶栏最右边的太阳 / 月亮：在浅色和深色之间切（没手动选过时跟随系统）
$('btn-theme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  setAppearance(dark ? 'light' : 'dark');
};
window.addEventListener('nodlink:theme', (e) => setAppearance(e.detail)); // 封面右上角的深浅切换
setAppearance(store.get('nodlink.theme'));

// ---------- 视角：第一人称（默认）和第三人称 ----------

function setView(view) {
  for (const r of $$('input[name=view]')) r.checked = r.value === view;
  scene.setView(view === 'third' ? 'home' : 'first');
  document.body.dataset.view = view;
  store.set('nodlink.view', view);
}
for (const r of $$('input[name=view]')) r.onchange = () => setView(r.value);

// ---------- 语言 ----------

for (const r of $$('input[name=lang]')) {
  r.checked = r.value === getLang();
  r.onchange = () => setLang(r.value);
}
onLangChange(() => {
  renderTiltLegend();
  arcade.relabel();
  // 顶栏和封面各有一组语言按钮，切了哪一组，两组都跟着变
  for (const r of $$('input[name=lang], input[name=cover-lang]')) r.checked = r.value === getLang();
  instruments.relabel();
  hudStats.relabel();
  miniMap.relabel();
  $('mode-hint').textContent = t(MODE_HINTS[cursorMode()]);
  syncControlUI();
  for (const el of probeEls.values()) el.remove();
  probeEls.clear();
  for (const c of probeCards.values()) dropCard(c);
  probeCards.clear();
  syncProbes();
  if (selected?.startsWith('screen:')) fillScreenCard(Number(selected.slice(7)));
  updateStats(performance.now(), true);
  updateSafeArea();
});

/** 顶栏和时间轴挡住的边缘不放内容 */
function updateSafeArea() {
  const top = document.querySelector('.top').getBoundingClientRect().bottom;
  scene.setSafeArea({ left: 0, right: 0, top, bottom: 0 });
}
addEventListener('resize', updateSafeArea);

// ---------- 状态（每 200 ms） ----------

let statsAt = 0;
let wasStreaming = false;

function updateStats(now, force = false) {
  if (!force && now - statsAt < 200) return;
  statsAt = now;
  const streaming = !!last && now - last.t < STALE_MS;
  if (streaming !== wasStreaming && sourceKind === 'live') logEvent(streaming ? t('收到耳机数据') : t('耳机数据停了'), streaming ? 'good' : 'warn');
  wasStreaming = streaming;
  rateNow = null;
  let devRate = null;
  if (arrivals.length > 1) {
    const a = arrivals[0];
    const b = arrivals.at(-1);
    rateNow = ((arrivals.length - 1) * 1000) / (b.t - a.t);
    if (a.d != null && b.d > a.d) devRate = (arrivals.length - 1) / (b.d - a.d);
  }

  alerts = computeAlerts(streaming);
  scene.setAlerts(Object.fromEntries(Object.entries(alerts).map(([p, al]) => [p, al.level])));
  syncTags();
  syncControlUI();
  const ps = podsStatus();
  $('pods-chip').dataset.level = ps.level;
  if ($('pods-chip-text').textContent !== ps.text) $('pods-chip-text').textContent = ps.text;

  if (!selected) return;
  const f = currentFrame();
  // 一个面板里可能有好几个部件的状态：耳机面板里有耳机和头部朝向，校准面板里有校准、指向线和准度测试
  const panel = panelOf(selected);
  let al = alerts.pods;
  if (panel === 'pods') {
    renderPodsChecks();
    const rate = devRate ?? rateNow;
    setState('pods-state', al ? al.text : `${t(sourceKind === 'sim' ? t('模拟数据') : t('正在接收'))} · ${rate ? rate.toFixed(0) : '–'} Hz`, al?.level ?? 'ok');
    $('pods-note').textContent = al ? podsAdvice() : '';
    $('st-yaw').textContent = deg(instruments.val.yaw);
    $('st-pitch').textContent = deg(instruments.val.pitch);
    $('st-roll').textContent = deg(instruments.val.roll);
    $('pods-raw').textContent = f?.yaw == null ? '' : t('传感器原始值 yaw {y} · pitch {p} · roll {r}（零点是耳机开始传数据时的朝向）', { y: deg(f.yaw), p: deg(f.pitch), r: deg(f.roll) });
  }
  if (panel === 'pods') {
    al = alerts.head;
    setState('head-state', al ? t('{alert}：用鼻尖对准屏幕正中，做一次中心校准', { alert: al.text }) : t(centered ? t('正前方定好了') : t('用第一个样本当作正前方')), al?.level ?? (centered ? 'ok' : 'idle'));
    $('st-rel-h').textContent = deg(f?.pose?.h);
    $('st-rel-v').textContent = deg(f?.pose?.v);
  }
  if (panel === 'calib') {
    const cs = calibStatus(streaming);
    setState('calib-state', cs.text, cs.level);
    al = alerts.ray;
    const text = calib
      ? t('{kind}：光标走 1000 px 要转头 {deg}°', { kind: t({ centers: t('多屏定点'), path: t('路径校准') }[calib.kind]), deg: (Math.atan(1000 / calib.G) / RAD).toFixed(1) })
      : t(cursorMode() === 'absolute' ? t('还没校准：光标按估算的距离跟着指向线走，校准后更准') : t('还没校准；增量和摇杆模式也能用，校准后比例更准'));
    setState('ray-state', al?.text ?? text, al?.level ?? (calib ? 'ok' : 'idle'));
  }
}

function podsAdvice() {
  if (!live.relay) return t('在 web 目录运行 npm start，然后刷新这个页面。');
  if (!live.sources) return t('运行 mac/NodLinkBridge/run.sh。第一次会请求“运动与健身”权限。');
  return t('戴好 AirPods，并在控制中心把它设为这台 Mac 的声音输出。');
}

// ---------- 主循环 ----------

let coverDrawnAt = -1e9;
function frame(now) {
  advance(now);
  drawStage(now);
  const f = currentFrame();
  const hide = ['calibration', 'axes', 'center', 'centers'].includes(run?.kind) || !!run?.forCalibration;
  scene.setLayout({ screens: space.screens, front: frontPoint(), G: currentG() });
  // 封面盖着时，主场景每秒只画一帧：模型、贴图、着色器在后面先准备好，又不和封面抢显卡
  const covered = ['covered', 'in-arcade', 'in-challenge'].some((c) => document.body.classList.contains(c));
  if (!covered || now - coverDrawnAt > 1000) {
    coverDrawnAt = now;
    scene.render({
      pose: f?.pose ?? null,
      sampleT: f?.t,
      streaming: !!last && now - last.t < STALE_MS,
      compare: !!calib && pointer instanceof AbsolutePointer,
      cursor: hide ? null : f?.cursor ?? null,
      raw: hide ? null : f?.raw ?? null,
      target: currentTarget(now),
      control: hide || replayT != null ? null : { ...control.status(now), fx: controlFx, snap: snap.target && { x: snap.target.x - space.origin.x, y: snap.target.y - space.origin.y, w: snap.target.w, h: snap.target.h } },
    });
  }
  instruments.update(now, {
    pose: f?.pose ?? null,
    rollBase: replayT == null ? control.base : null,
    status: replayT == null ? control.status(now) : null,
    fx: controlFx,
    hidden: hide,
  });
  const streamingNow = !!last && now - last.t < STALE_MS;
  if (streamingNow) hud.since ??= now;
  else hud.since = null;
  if (now - hud.at > 250) {
    hud.at = now;
    hudStats.update({
      rate: streamingNow ? rateNow : null,
      // 完整率只对真耳机有意义（按耳机自己的时间戳算）；模拟数据没有设备时间，显示“–”
      integrity: streamingNow && sourceKind === 'live' ? dataIntegrity() : null,
      accuracy: hud.accuracy?.source === sourceKind ? hud.accuracy.p : null,
      uptimeMs: hud.since == null ? null : now - hud.since,
      ops: hud.ops,
      rejects: hud.rejects,
    });
  }
  miniMap.update({ screens: space.screens, cursor: hide ? null : f?.cursor ?? null, hit: hide ? null : hitPx(f?.pose) });
  updateStats(now);
  updateGuide();
  updatePointing(now);
  updateRunPill(now);
  updateControlPill(now);
  placeCard();
  placeTags();
  drawProbes(f);
  if (now - tlDrawnAt > 66) drawTimeline(now);
  requestAnimationFrame(frame);
}

let tlDrawnAt = 0;
function drawTimeline(now) {
  tlDrawnAt = now;
  timeline.draw({
    wave: css('--wave-fill'),
    waveLine: css('--wave'),
    tick: css('--text-2'),
    info: css('--text'),
    good: css('--green'),
    warn: css('--amber'),
    bad: css('--red'),
    head: css('--text'),
    knob: css('--panel-solid'),
    click: css('--blue'),
    right: css('--sky'),
    scroll: css('--text-2'),
    key: css('--text'),
    voice: css('--violet'),
  });
  $('tl-time').textContent = replayT == null ? t('现在') : t('−{n} 秒', { n: ((now - replayT) / 1000).toFixed(1) });
}

// ---------- 更多菜单、模型、导出、键盘 ----------

function closeMenu() {
  $('menu').hidden = true;
  $('btn-menu').setAttribute('aria-expanded', 'false');
}
$('btn-menu').onclick = () => {
  const open = $('menu').hidden;
  if (open) closePart();
  $('menu').hidden = !open;
  $('btn-menu').setAttribute('aria-expanded', String(open));
};
$('menu').querySelector('.x').onclick = closeMenu;
$('btn-home').onclick = () => setView(document.body.dataset.view ?? 'first');

// 角色固定是程序建模的 NodBot（ui/pet.js）。原来的机器人、骑士、法师模型和“从文件加载 .glb”都去掉了
function loadCharacter() {
  try {
    scene.loadPet();
    scene.play('Wave');
  } catch (err) {
    console.error('角色加载失败', err);
  }
}

// 模拟数据时按住 [ 或 ] 歪头，用来试歪头点击
function simTilt(e, down) {
  if (sourceKind !== 'sim' || !['[', ']'].includes(e.key)) return false;
  sim.set({ rollDeg: down ? (e.key === '[' ? -18 : 18) * axes.sr : 0 });
  return true;
}
window.addEventListener('keyup', (e) => simTilt(e, false));
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && !['radio', 'checkbox', 'range'].includes(e.target.type)) return;
  if (simTilt(e, true)) return;
  if (e.key === 'c' || e.key === 'C') recenter();
  else if (e.key === ' ') {
    e.preventDefault();
    toggleClutch();
  } else if (e.key === 'Escape') {
    if (run) abortRun();
    else if (live.control.enabled) setControl(false);
    else {
      closePart();
      closeMenu();
    }
  }
});

function snapshotSettings() {
  return {
    source: sourceKind,
    sim: sourceKind === 'sim' ? { ...sim.p } : null,
    axes: { ...axes },
    space: { w: space.w, h: space.h, screens: space.screens, origin: space.origin },
    distancePx: num('set-dist'),
    G: currentG(),
    model: $('model-kind').value,
    cursorMode: cursorMode(),
    gain: num('f-gain'),
    filter: readFilter(),
    relative: readRel(),
  };
}

$('btn-export').onclick = () => {
  const data = { app: 'NodLink', format: 3, exportedAt: new Date().toISOString(), userAgent: navigator.userAgent, settings: snapshotSettings(), sessions, stream };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `nodlink-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

rebuildSpace();
rebuildPointer();
startSource();
syncProbes();
translateDom();
scene.setLens('show'); // 演示 / 调试的切换已去掉：所有操作都在演示镜头里完成
setView(store.get('nodlink.view') ?? 'third'); // 默认第三人称：机器人、屏幕、指向线都看得见
updateSafeArea();
loadCharacter();
requestAnimationFrame(frame);
