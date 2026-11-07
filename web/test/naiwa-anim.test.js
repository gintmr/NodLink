// 奶蛙的逐帧编排：大笑跟着头的深度走，起手 / 回中按段播。帧只能一帧一帧走，或者走事先检查过的接口，不能乱跳。
// 播放器的基本操作（倒放、指定帧、进度）也在这里测。不加载图片：url 用数字代替。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FramePlayer } from '../public/ui/frame-player.js';
import { NaiwaAnimator, SEGMENTS, CROUCH, frameAt } from '../public/ui/games/naiwa-anim.js';

const make = () => {
  const p = new FramePlayer({ urls: Array.from({ length: 108 }, (_, i) => i), fps: 10, actions: SEGMENTS });
  return { p, a: new NaiwaAnimator(p) };
};
const isLaugh = (f) => f >= 9 && f <= 44;

// 允许的跳转：相邻帧、各段的接口、保持段的循环和“从任意保持帧回中”；大笑段之间换段时只要蹲的高度差不多
const ALLOWED = new Set(['53>0', '0>54', '0>81', '62>70', '89>94', '71>63', '98>90', '80>0', '107>0',
  '89>99', '62>72', '80>81', '80>54', '107>54', '107>81', '53>54', '53>81', '53>1', '80>1', '107>1']);
for (let i = 1; i < 108; i++) ALLOWED.add(`${i - 1}>${i}`);
for (let i = 63; i <= 71; i++) ALLOWED.add(`${i}>72`);
for (let i = 90; i <= 98; i++) ALLOWED.add(`${i}>99`);
for (const top of [9, 10, 23, 24, 25, 26, 27, 28, 43, 44]) for (const to of [45, 54, 81]) ALLOWED.add(`${top}>${to}`); // 站直时收笑 / 起手
for (const from of [8]) for (let k = 9; k <= 17; k++) ALLOWED.add(`${from}>${k}`); // 起笑完接上当前深度

/** script：[[秒数, 想要的状态, depth(t)]]，60 Hz 推进，记下每一步的帧 */
function drive(script) {
  const { p, a } = make();
  const frames = [p.frame];
  const segs = [a.seg];
  let t = 0;
  for (const [sec, want, depth = () => 0] of script) {
    a.set(want);
    for (let k = 0; k < sec * 60; k++) {
      t += 1 / 60;
      a.update(1 / 60, { depth: depth(t) });
      if (frames.at(-1) !== p.frame) frames.push(p.frame);
      if (segs.at(-1) !== a.seg) segs.push(a.seg);
    }
  }
  return { frames, segs, a, p };
}
const nod = (hz, amp = 1) => (t) => amp * (0.5 - 0.5 * Math.cos(2 * Math.PI * hz * t));

function badJumps(frames) {
  const bad = [];
  for (let i = 1; i < frames.length; i++) {
    const [x, y] = [frames[i - 1], frames[i]];
    if (ALLOWED.has(`${x}>${y}`)) continue;
    if (isLaugh(x) && isLaugh(y) && Math.abs(CROUCH[x] - CROUCH[y]) < 0.25) continue; // 换段：一样高
    bad.push(`${x}>${y}`);
  }
  return bad;
}

test('各种状态来回切，帧不乱跳', () => {
  const { frames } = drive([[0.5, 'idle'], [5, 'laugh', nod(1.2)], [2.5, 'idle'], [2.5, 'left'], [1, 'right'], [3, 'right'], [2, 'idle'],
    [1, 'laugh', nod(2)], [0.3, 'left'], [3, 'left'], [2, 'idle'], [0.2, 'right'], [0.2, 'left'], [3, 'idle'], [3, 'laugh', nod(0.5, 0.4)], [2, 'idle']]);
  assert.deepEqual(badJumps(frames), []);
});

test('大笑跟着点头：下去走下压段、上来走回弹段，A / B 轮流', () => {
  const { segs } = drive([[0.2, 'idle'], [4, 'laugh', nod(1)]]);
  assert.deepEqual(segs.slice(0, 7), ['idle', 'laughIn', 'downA', 'upA', 'downB', 'upB', 'downA']);
});

test('点得快它笑得快，点得慢它笑得慢', () => {
  const count = (hz) => drive([[0.2, 'idle'], [6, 'laugh', nod(hz)]]).segs.filter((x) => x.startsWith('down')).length;
  const slow = count(0.5);
  const fast = count(2);
  assert.ok(fast >= slow * 3, `慢 ${slow} 次下压，快 ${fast} 次`);
});

test('点得浅它只蹲一点；头停住它也停住', () => {
  const { frames } = drive([[0.2, 'idle'], [4, 'laugh', nod(1, 0.3)]]);
  const deepest = Math.max(...frames.filter(isLaugh).map((f) => CROUCH[f]));
  assert.ok(deepest < 0.45, `最深 ${deepest}`);
  const { p, a } = make();
  a.set('laugh');
  for (let k = 0; k < 60; k++) a.update(1 / 60, { depth: 0.6 });
  const f0 = p.frame;
  for (let k = 0; k < 60; k++) a.update(1 / 60, { depth: 0.6 });
  assert.equal(p.frame, f0, '深度不变，帧不动');
  assert.equal(p.frame, frameAt(a.seg, 0.6));
});

test('不笑了：从蹲着一帧帧站起来，再收笑回到第 0 帧', () => {
  const { segs, frames, p } = drive([[0.2, 'idle'], [1.3, 'laugh', () => 0.9], [3, 'idle', () => 0.9]]);
  assert.ok(segs.includes('laughOut'));
  assert.equal(p.frame, 0);
  assert.deepEqual(badJumps(frames), []);
});

test('笑着转头：先站直，再直接起手', () => {
  const { segs } = drive([[0.2, 'idle'], [1.3, 'laugh', nod(1)], [3, 'left', nod(1)]]);
  const i = segs.indexOf('leftIn');
  assert.ok(i > 0);
  assert.ok(segs[i - 1].startsWith('up') || segs[i - 1].startsWith('down'), segs.join(','));
});

test('换方向时先回中再起另一边；保持段从挑好的帧接进去', () => {
  const { segs, frames } = drive([[2, 'left'], [3, 'right']]);
  const i = segs.indexOf('rightIn');
  assert.deepEqual(segs.slice(i - 2, i + 2), ['leftHold', 'leftOut', 'rightIn', 'rightHold']); // 回中后不停留，直接起另一边
  assert.ok(frames.join(',').includes('62,70'));
  assert.ok(frames.join(',').includes('89,94'));
});

test('播放器：倒放、指定帧、进度、暂停', () => {
  const p = new FramePlayer({ urls: Array.from({ length: 108 }, (_, i) => i), fps: 10 });
  p.play({ from: 10, to: 14, reverse: true });
  assert.equal(p.frame, 14);
  const seen = [];
  let ended = 0;
  p.seg.onEnd = () => ended++;
  for (let k = 0; k < 20; k++) {
    p.update(0.1);
    seen.push(p.frame);
  }
  assert.deepEqual([...new Set(seen)], [13, 12, 11, 10]);
  assert.equal(ended, 1);
  p.play({ from: 20, to: 30 });
  p.setProgress(0.5);
  assert.equal(p.frame, 25);
  assert.equal(p.playing, false);
  p.setFrame(999);
  assert.equal(p.frame, 107);
  p.play({ from: 0, to: 3, loop: true });
  p.pause();
  p.update(1);
  assert.equal(p.frame, 0);
  p.resume();
  p.update(0.45);
  assert.equal(p.frame, 0, '0.45 s 走 4 帧：0→1→2→3→0');
});
