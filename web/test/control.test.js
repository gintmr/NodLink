// 头控按键逻辑：该点的要点，不该点的（晃动、换姿势、边转边歪、键鼠在用）一个都不能点。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeadControl } from '../public/core/control.js';
import { mulberry32 } from '../public/core/sim.js';

const DT = 20; // 50 Hz

/** 按 pose(t) 喂 duration 毫秒的样本，收集动作 */
function feed(ctl, from, duration, pose, cursor = () => ({ x: 500, y: 300 })) {
  const out = [];
  for (let t = from; t < from + duration; t += DT) {
    for (const a of ctl.update(t, pose(t), cursor(t))) out.push({ ...a, t });
  }
  return { out, t: from + duration };
}

const still = (r = 0) => () => ({ h: 0, v: 0, r });
/** 用 ms 毫秒歪到 deg 度，停 hold 毫秒，再用 ms 毫秒回正 */
const tilt = (t0, deg, { ms = 120, hold = 150 } = {}) => (t) => {
  const s = t - t0;
  const k = s < ms ? s / ms : s < ms + hold ? 1 : Math.max(0, 1 - (s - ms - hold) / ms);
  return { h: 0, v: 0, r: deg * k };
};
const buttons = (out) => out.filter((a) => a.type === 'button');
const rejects = (out) => out.filter((a) => a.type === 'reject').map((a) => a.reason);

function ready() {
  const ctl = new HeadControl();
  const { t } = feed(ctl, 0, 1000, still());
  return { ctl, t };
}

test('左歪回正是单击，点在开始歪头时的位置', () => {
  const { ctl, t } = ready();
  // 歪头时光标被带偏了 40 像素
  const { out } = feed(ctl, t, 800, tilt(t, -18), (s) => ({ x: 500 + (s - t) * 0.05, y: 300 }));
  const b = buttons(out);
  assert.equal(b.length, 1);
  assert.deepEqual([b[0].button, b[0].action, b[0].count], ['left', 'click', 1]);
  assert.ok(Math.abs(b[0].at.x - 500) < 3, `点击位置 ${b[0].at.x}`);
});

test('两次快速左歪是双击，右歪是右键', () => {
  const { ctl, t } = ready();
  const a = feed(ctl, t, 420, tilt(t, -18, { ms: 80, hold: 60 }));
  const b = feed(ctl, a.t, 600, tilt(a.t, -18, { ms: 80, hold: 60 }));
  const c = feed(ctl, b.t + 500, 800, tilt(b.t + 500, 18));
  assert.deepEqual(buttons([...a.out, ...b.out]).map((x) => x.count), [1, 2]);
  assert.deepEqual(buttons(c.out).map((x) => x.button), ['right']);
});

test('慢慢歪过去是换姿势：不点，而且中立位会跟过去，侧躺后照样能点', () => {
  const { ctl, t } = ready();
  const lean = feed(ctl, t, 3000, (s) => ({ h: 0, v: 0, r: -25 * Math.min((s - t) / 2500, 1) }));
  assert.equal(buttons(lean.out).length, 0);
  assert.ok(rejects(lean.out).includes('slow'));
  const rest = feed(ctl, lean.t, 6000, still(-25));
  assert.equal(buttons(rest.out).length, 0);
  const tap = feed(ctl, rest.t, 800, (s) => ({ ...tilt(rest.t, -18)(s), r: -25 + tilt(rest.t, -18)(s).r }));
  assert.equal(buttons(tap.out).length, 1);
});

test('边转头边歪头、快速甩头时歪头，都不点', () => {
  const { ctl, t } = ready();
  const turning = feed(ctl, t, 800, (s) => ({ ...tilt(t, -18)(s), h: (s - t) * 0.04 }));
  assert.equal(buttons(turning.out).length, 0);
  assert.ok(rejects(turning.out).includes('drift'));

  const calm = feed(ctl, turning.t, 1500, still());
  // 先以 150°/s 甩头，甩的过程中歪头
  const fast = feed(ctl, calm.t, 600, (s) => ({ h: 30 * Math.sin((s - calm.t) / 200), v: 0, r: -18 * Math.min((s - calm.t - 200) / 100, 1) * (s - calm.t > 200) }));
  assert.equal(buttons(fast.out).length, 0);
  assert.ok(rejects(fast.out).includes('fast'));
});

test('正常姿态下的抖动一分钟内一次都不点', () => {
  const { ctl, t } = ready();
  const rnd = mulberry32(7);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  // 说话、看东西时的小晃动：roll ±3° 慢摆加 1° 噪声，水平角来回看
  const { out } = feed(ctl, t, 60_000, (s) => ({ h: 15 * Math.sin(s / 1700), v: 5 * Math.sin(s / 2300), r: 3 * Math.sin(s / 900) + gauss() }));
  assert.equal(buttons(out).length, 0);
  // 光标也一次都没被停住：没确认是手势之前不冻结
  assert.equal(out.filter((a) => a.type === 'freeze').length, 0);
});

test('左歪停住是按下并锁定，再歪一次松开；超时也会松开', () => {
  const { ctl, t } = ready();
  const hold = feed(ctl, t, 1600, tilt(t, -18, { hold: 1000 }));
  assert.deepEqual(buttons(hold.out).map((b) => b.action), ['down']);
  assert.ok(ctl.held);
  // 拖拽：头自由转动，光标不冻结
  const drag = feed(ctl, hold.t, 2000, (s) => ({ h: (s - hold.t) * 0.005, v: 0, r: 0 }));
  assert.equal(ctl.frozen, false);
  assert.equal(buttons(drag.out).length, 0);
  const up = feed(ctl, drag.t, 800, (s) => ({ ...tilt(drag.t, 18)(s), h: 10 }));
  assert.deepEqual(buttons(up.out).map((b) => b.action), ['up']);

  const again = feed(ctl, up.t + 500, 1600, tilt(up.t + 500, -18, { hold: 1000 }));
  assert.ok(ctl.held);
  const timeout = feed(ctl, again.t, 31_000, still());
  assert.deepEqual(buttons([...again.out, ...timeout.out]).map((b) => b.action), ['down', 'up']);
});

test('真实键鼠一动就让位：松开按住的键，期间不识别手势，停手后恢复', () => {
  const { ctl, t } = ready();
  const hold = feed(ctl, t, 1600, tilt(t, -18, { hold: 1000 }));
  assert.ok(ctl.held);
  const phys = ctl.physical(hold.t);
  assert.deepEqual(phys.filter((a) => a.type === 'button').map((a) => a.action), ['up']);
  assert.ok(phys.some((a) => a.type === 'yield'));
  const during = feed(ctl, hold.t, 1000, tilt(hold.t, -18));
  assert.equal(buttons(during.out).length, 0);
  assert.equal(ctl.status(during.t).mode, 'yield');
  const back = feed(ctl, during.t, 1500, still());
  assert.ok(back.out.some((a) => a.type === 'resume'));
  const tap = feed(ctl, back.t, 800, tilt(back.t, -18));
  assert.equal(buttons(tap.out).length, 1);
});

test('驻留点击：停住点一次，不动不会连点，移开再回来才会再点', () => {
  const ctl = new HeadControl({ dwell: true, tilt: false });
  let pos = { x: 100, y: 100 };
  const cur = () => pos;
  const a = feed(ctl, 0, 3000, still(), cur);
  assert.equal(buttons(a.out).length, 1);
  pos = { x: 300, y: 100 };
  const b = feed(ctl, a.t, 200, still(), cur);
  pos = { x: 100, y: 100 };
  const c = feed(ctl, b.t, 1500, still(), cur);
  assert.equal(buttons([...b.out, ...c.out]).length, 1);
});

// ---------- 四元数朝向：消掉歪头串扰 ----------

import { pointing, forwardFromTilt, quatMul } from '../public/core/orient.js';

const axisQuat = ([x, y, z], deg) => {
  const a = (deg * Math.PI) / 360;
  const n = Math.hypot(x, y, z);
  return [Math.cos(a), (x / n) * Math.sin(a), (y / n) * Math.sin(a), (z / n) * Math.sin(a)];
};

test('耳机斜戴时，歪头会带偏欧拉角；从一次歪头求出前后轴后，歪头不再影响水平角和垂直角', () => {
  // 耳机相对头：绕左右轴前倾 15°、绕上下轴转 8°
  const mount = quatMul(axisQuat([1, 0, 0], 15), axisQuat([0, 0, 1], 8));
  const head0 = quatMul(axisQuat([0, 0, 1], 20), axisQuat([1, 0, 0], -5)); // 头朝左前方、略低头
  const head1 = quatMul(head0, axisQuat([0, 1, 0], 18)); // 绕头的前后轴歪 18°
  const q0 = quatMul(head0, mount);
  const q1 = quatMul(head1, mount);
  const D = 180 / Math.PI;
  const naive = [pointing(q0), pointing(q1)];
  const shift = Math.hypot(naive[1].yaw - naive[0].yaw, naive[1].pitch - naive[0].pitch) * D;
  assert.ok(shift > 3, `斜戴时歪头带偏 ${shift.toFixed(1)}°`);

  const { f, angleDeg, offDeg } = forwardFromTilt(q0, q1);
  assert.ok(Math.abs(angleDeg - 18) < 0.01);
  assert.ok(offDeg > 10 && offDeg < 20, `斜了 ${offDeg.toFixed(1)}°`);
  const fixed = [pointing(q0, f), pointing(q1, f)];
  assert.ok(Math.abs(fixed[1].yaw - fixed[0].yaw) * D < 0.01);
  assert.ok(Math.abs(fixed[1].pitch - fixed[0].pitch) * D < 0.01);
  // 转头时水平角照样跟着变
  const turned = pointing(quatMul(quatMul(axisQuat([0, 0, 1], 10), head0), mount), f);
  assert.ok(Math.abs((turned.yaw - fixed[0].yaw) * D - 10) < 0.5);
});

test('语音：开口就冻结光标，指令在冻结的位置执行；说完没指令会解冻；聊天里的歪头不算', () => {
  const { ctl, t: t0 } = ready();
  let pos = { x: 200, y: 200 };
  const t = feed(ctl, t0, 600, still(), () => pos).t; // 先在 (200, 200) 停一会儿
  const start = ctl.voice(t, 'start', null, pos);
  assert.ok(start.some((a) => a.type === 'freeze' && a.on));
  assert.equal(ctl.status(t).mode, 'voice');
  // 说话时头在动、还歪了头：不点
  pos = { x: 260, y: 230 };
  const talk = feed(ctl, t, 600, tilt(t, -18), () => pos);
  assert.equal(buttons(talk.out).length, 0);
  const cmd = ctl.voice(talk.t, 'command', 'left', pos);
  const b = buttons(cmd);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].at, { x: 200, y: 200 });
  assert.equal(ctl.frozen, false);

  const rest = feed(ctl, talk.t, 1000, still(), () => pos); // 又停了一会儿
  ctl.voice(rest.t, 'start', null, pos);
  assert.equal(ctl.frozen, true);
  ctl.voice(talk.t + 1800, 'end', null, pos);
  const after = feed(ctl, talk.t + 1800, 1500, still(), () => pos); // 说完后最多等 voiceGraceMs（1.2 秒）
  assert.ok(after.out.some((a) => a.type === 'freeze' && !a.on));
  assert.equal(ctl.frozen, false);

  assert.deepEqual(buttons(ctl.voice(after.t, 'command', 'double', pos)).map((x) => x.count), [1, 2]);
  assert.equal(ctl.voice(after.t, 'command', 'scrollUp', pos)[0].dy > 0, true);
  assert.equal(ctl.voice(after.t, 'command', 'zoomOut', pos)[0].dir, 'out');
});

test('回溯定位：停在小按钮上，一开口头就偏了，点击仍然落在刚才停留的地方', () => {
  const { ctl, t: t0 } = ready();
  const rnd = mulberry32(5);
  // 停在 (300, 200)，带 3 像素的抖动
  const rest = feed(ctl, t0, 1200, still(), () => ({ x: 300 + 3 * (rnd() - 0.5), y: 200 + 3 * (rnd() - 0.5) }));
  // 开口那一刻头已经开始偏（事件比实际开口晚 150 ms），说话期间偏出去 40 像素
  const drift = (s) => ({ x: 300 + Math.min((s - rest.t) * 0.1, 40), y: 200 });
  const pre = feed(ctl, rest.t, 150, still(), drift);
  ctl.voice(pre.t, 'start', null, drift(pre.t));
  const talk = feed(ctl, pre.t, 500, still(), drift);
  const b = buttons(ctl.voice(talk.t, 'command', 'left', drift(talk.t)));
  assert.equal(b.length, 1);
  assert.ok(Math.hypot(b[0].at.x - 300, b[0].at.y - 200) < 4, `点在 ${b[0].at.x.toFixed(1)}, ${b[0].at.y.toFixed(1)}`);

  // 没冻结的情况（一边转头一边开口）：认出指令时也回到开口前的停留处
  const ctl2 = new HeadControl();
  let x = 100;
  const a = feed(ctl2, 0, 1000, still(), () => ({ x, y: 100 })); // 停在 100
  const moving = feed(ctl2, a.t, 300, still(), (s) => ({ x: 100 + (s - a.t) * 0.5, y: 100 })); // 开始移开
  x = 250;
  ctl2.voice(a.t + 200, 'start', null, { x: 200, y: 100 });
  const b2 = buttons(ctl2.voice(moving.t + 300, 'command', 'right', { x: 250, y: 100 }));
  assert.ok(Math.abs(b2[0].at.x - 100) < 4, `点在 ${b2[0].at.x.toFixed(1)}`);
});

test('回溯定位：歪头时顺带的偏移也不算，点在歪头前停留的地方', () => {
  const { ctl, t } = ready(); // ready() 里光标一直停在 (500, 300)
  // 歪头过程中光标被带偏 40 像素
  const { out } = feed(ctl, t, 800, tilt(t, -18), (s) => ({ x: 500 + Math.min((s - t) * 0.2, 40), y: 300 }));
  const b = buttons(out);
  assert.equal(b.length, 1);
  assert.ok(Math.abs(b[0].at.x - 500) < 3, `点在 ${b[0].at.x.toFixed(1)}`);
});

test('选文字：“从这里”点起点，“到这里”Shift + 点终点；长按拖选时“松开”落在停留处', () => {
  const { ctl, t: t0 } = ready();
  let pos = { x: 100, y: 100 };
  const a = feed(ctl, t0, 600, still(), () => pos);
  const from = buttons(ctl.voice(a.t, 'command', 'selectFrom', pos));
  assert.deepEqual([from[0].at.x, from[0].mods], [100, undefined]);
  pos = { x: 400, y: 100 };
  const b = feed(ctl, a.t, 600, still(), () => pos);
  const to = buttons(ctl.voice(b.t, 'command', 'selectTo', pos));
  assert.deepEqual([to[0].at.x, to[0].mods], [400, ['shift']]);

  // 长按、转头拖到 600 停住，开口时头又偏了一点
  ctl.voice(b.t, 'command', 'hold', pos);
  pos = { x: 600, y: 100 };
  const c = feed(ctl, b.t, 700, still(), () => pos);
  const up = buttons(ctl.voice(c.t + 300, 'command', 'release', { x: 630, y: 100 }));
  assert.equal(up[0].action, 'up');
  assert.ok(Math.abs(up[0].at.x - 600) < 3);
});

test('按键：key m 按一下；长按空格按住，“松开”一起放开', () => {
  const { ctl, t } = ready();
  const press = ctl.voice(t, 'command', 'key', null, { key: 'm' });
  assert.deepEqual(press.filter((x) => x.type === 'key')[0], { type: 'key', key: 'm', mods: [], action: 'press' });
  const hold = ctl.voice(t, 'command', 'key', null, { key: 'space', hold: true });
  assert.equal(hold.find((x) => x.type === 'key').action, 'down');
  assert.equal(ctl.status(t).mode, 'keys');
  const rel = ctl.voice(t + 500, 'command', 'release', null);
  assert.ok(rel.some((x) => x.type === 'key' && x.action === 'releaseAll'));
  assert.equal(ctl.status(t + 500).mode, 'ready');
});

// ---------- 歪头场景：语音输入、抖音 ----------
const keys = (out) => out.filter((a) => a.type === 'key').map((a) => `${a.action}:${a.key}`);
function readyIn(tiltMode) {
  const ctl = new HeadControl({ tiltMode });
  const { t } = feed(ctl, 0, 1000, still());
  return { ctl, t };
}

test('抖音：左歪歪够就按 ↓，右歪按 X，不点鼠标也不停住光标', () => {
  const { ctl, t } = readyIn('douyin');
  const a = feed(ctl, t, 800, tilt(t, -18));
  const b = feed(ctl, a.t + 300, 800, tilt(a.t + 300, 18));
  const all = [...a.out, ...b.out];
  assert.deepEqual(keys(all), ['press:down', 'press:x']);
  assert.equal(buttons(all).length, 0);
  assert.equal(all.filter((x) => x.type === 'freeze').length, 0);
  // 歪够那一刻就发，不等回正
  const k = a.out.find((x) => x.type === 'key');
  assert.ok(k.t - t <= 200, `按键时刻 ${k.t - t} ms`);
});

test('抖音：连刷几条，每次歪头只按一次', () => {
  const { ctl, t } = readyIn('douyin');
  let at = t;
  const all = [];
  for (let i = 0; i < 4; i++) {
    const r = feed(ctl, at, 700, tilt(at, -16));
    all.push(...r.out);
    at = r.t;
  }
  assert.deepEqual(keys(all), Array(4).fill('press:down'));
});

test('语音输入：左歪按住 Fn，歪着时头随便转、说话也不松，回正才松开', () => {
  const { ctl, t } = readyIn('dictate');
  // 120 ms 歪到 -18°，歪着 4 秒，期间水平转 20°（看屏幕），再回正
  const pose = (s) => {
    const d = s - t;
    const r = d < 120 ? -18 * d / 120 : d < 4120 ? -18 : -18 * Math.max(0, 1 - (d - 4120) / 150);
    return { h: d > 500 && d < 4000 ? 20 : 0, v: 0, r };
  };
  const a = feed(ctl, t, 2000, pose);
  assert.deepEqual(keys(a.out), ['down:fn']);
  assert.equal(ctl.status(a.t).mode, 'dictate');
  // 按住时语音指令不生效（话是说给输入法的）
  assert.equal(ctl.voice(a.t, 'command', 'left', { x: 1, y: 1 }).length, 0);
  const b = feed(ctl, a.t, 2600, pose);
  assert.deepEqual(keys(b.out), ['up:fn']);
  assert.equal(ctl.status(b.t).mode, 'ready');
});

test('语音输入：右歪是回车；按住 Fn 时关掉歪头会立刻松开', () => {
  const { ctl, t } = readyIn('dictate');
  const a = feed(ctl, t, 800, tilt(t, 18));
  assert.deepEqual(keys(a.out), ['press:return']);
  const b = feed(ctl, a.t + 300, 400, (s) => ({ h: 0, v: 0, r: -18 * Math.min((s - a.t - 300) / 120, 1) }));
  assert.deepEqual(keys(b.out), ['down:fn']);
  ctl.set({ tilt: false });
  const c = feed(ctl, b.t, 100, still(-18));
  assert.deepEqual(keys(c.out), ['up:fn']);
});

test('语音输入：慢慢歪过去（换姿势）不会按住 Fn', () => {
  const { ctl, t } = readyIn('dictate');
  const lean = feed(ctl, t, 3000, (s) => ({ h: 0, v: 0, r: -25 * Math.min((s - t) / 2500, 1) }));
  assert.deepEqual(keys(lean.out), []);
});
