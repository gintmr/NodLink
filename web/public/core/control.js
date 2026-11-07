// 头控的“按键”部分：歪头手势、驻留点击、防误触，以及和真实键鼠的让位规则。
// 只做判断，不碰系统：输入是姿态和光标位置，输出是要执行的动作，由调用方发给耳机桥。
//
// 手势（roll，左右歪头）。歪头用来干什么按场景切换（TILT_MODES）：
//   点击：
//   左歪并回正 = 左键单击；两次单击间隔够短 = 双击
//   右歪并回正 = 右键
//   左歪停住不回正 = 按下左键（锁定），之后头可以自由转动拖拽；再歪一次头 = 松开
// 锁定式拖拽是有意的：一边保持歪头一边转头很累，患者更做不到。
//   语音输入：左歪 = 按住 Fn（交给系统或输入法的语音输入），回正 = 松开 Fn；右歪 = 回车
//   抖音：左歪 = ↓ 下一条；右歪 = X 打开或关闭评论区（抖音网页版的快捷键）
// 按键类的歪头在歪够的那一刻就发，不等回正，刷视频要跟手；也不停住光标，按键和光标位置无关。
//
// 防误触，按发生顺序：
//   1. 歪头中立位缓慢跟随当前姿势，侧躺、靠在枕头上也能用，慢慢歪过去不会触发
//   2. 头转得快（走路、甩头、回头说话）时不接受新手势
//   3. 从开始歪到歪够角度必须够快，慢慢歪是换姿势，不是指令
//   4. 歪头期间水平角、垂直角基本不变（纯歪头），边转边歪是在看东西
//   5. 回正有滞回：进入阈值大、退出阈值小，角度在阈值附近抖动不会连发
//   6. 点在开始歪头那一刻的位置，而不是歪头带偏后的位置。确认是手势之后才停住光标（并拉回起点），
//      没确认之前光标照常走：说话、换姿势时 roll 常越过预备阈值，一越过就停住会让光标一顿一顿的
//   7. 点击后有冷却期；刚接管、刚从键鼠手里拿回控制时有一小段静默期
//   8. 真实键鼠一动，头控立刻让位，停手一会儿才恢复；按住的键立刻松开，绝不卡住
//   9. 按住最多保持 maxHoldMs，超时自动松开
//
// 语音（识别在耳机桥里做，这里只管时机）：认出指令后在冻结的位置执行；
// 说完 voiceGraceMs 内没等到指令就解冻；说话太久（voiceHoldMs）也解冻。
//
// 回溯定位：一开口、一歪头，头就会带着光标偏一点。所以执行的位置不是“现在的光标”，
// 而是“开口 / 开始歪头之前，光标最后一次停住的地方”：往回找最近一段 fixMs 内都没怎么动的停留，取它的中心。
// 找到后再交给 refine（吸附到那里的按钮，可选）。说话时如果刚停过，光标立刻拉回那里并停住，让人看到要点哪儿。

import { wrapDeg } from './angles.js';

/**
 * 歪头场景。do：click 原来的点击；press 歪够时按一下键；hold 歪够时按住、回正时松开。
 * 按住期间（语音输入）不认语音指令：话是说给输入法的，不能被当成“点击”“下滑”。
 */
export const TILT_MODES = {
  click: { left: { do: 'click' }, right: { do: 'click' } },
  dictate: { left: { do: 'hold', key: 'fn' }, right: { do: 'press', key: 'return' } },
  douyin: { left: { do: 'press', key: 'down' }, right: { do: 'press', key: 'x' } },
};

export const CONTROL_DEFAULTS = {
  tilt: true,            // 歪头手势
  tiltMode: 'click',     // 歪头用来干什么，见 TILT_MODES
  keyHoldMaxMs: 30000,   // 歪头按住键最长时间（一段语音输入）；耳机桥兜底是 35 秒
  keyTiltMaxMs: 3000,    // 按键类歪头歪够后这么久还不回正，当作换了姿势
  dwell: false,          // 驻留点击
  preDeg: 4,             // 偏离中立位超过这个角度就冻结光标，准备识别手势
  enterDeg: 12,          // 歪够这个角度才算手势
  exitDeg: 6,            // 回到这个角度以内算回正
  riseMs: 450,           // 从 preDeg 到 enterDeg 的最长时间
  tapMaxMs: 700,         // 歪够后多久内回正算单击
  holdMs: 800,           // 左歪保持这么久算按下
  driftDeg: 8,           // 手势期间水平角、垂直角最多变化多少
  calmDegPerSec: 80,     // 头转得比这快时不接受新手势
  refractoryMs: 150,     // 点击后的冷却：防回弹，又不能挡住双击的第二下
  settleMs: 600,         // 刚接管、刚恢复后的静默
  doubleMs: 500,         // 双击间隔
  doublePx: 12,          // 双击两次之间光标最多差多少
  dwellMs: 800,          // 驻留时间
  dwellPx: 30,           // 驻留半径
  yieldMs: 1500,         // 键鼠停手多久后头控恢复
  maxHoldMs: 30000,      // 按住最长时间
  voiceHoldMs: 2500,     // 说话时光标最多冻结多久
  voiceGraceMs: 1200,    // 说完后再等多久识别结果：英文是说完后才认的，要多等一会儿
  fixMs: 250,            // 停住至少这么久才算“停留”
  fixPx: 14,             // 停留期间光标离中心的平均距离不超过这么多
  lookbackMs: 1500,      // 最多往回找这么久
  leadMs: 100,           // 歪头越过预备阈值前，头其实已经开始动了
  voiceLagMs: 150,       // 开口到收到“开口”事件的延迟（检测 + 传输）
  freezeRecentMs: 700,   // 开口前这么短时间内停留过，才在说话时把光标拉回去并停住
  scrollPx: 300,         // 上滑、下滑一次滚多少
  baselineTauMs: 4000,   // 中立位跟随的时间常数
  blockedTauMs: 800,     // 被拦下时中立位跟得更快，换完姿势很快就能继续用
};

/** 被拦下的原因，给日志和统计用 */
export const REJECT = {
  fast: '头在快速转动',
  slow: '歪得太慢，像是换姿势',
  drift: '歪头时头也在转',
  long: '右歪停太久，当作取消',
  settle: '刚恢复控制',
};

export class HeadControl {
  constructor(options = {}) {
    this.o = { ...CONTROL_DEFAULTS, ...options };
    this.base = null;       // 歪头中立位
    this.state = 'idle';    // idle / armed / tilt / blocked / cooldown
    this.held = false;      // 左键锁定按下
    this.heldAt = 0;
    this.frozenAt = null;   // 冻结时的光标位置
    this.yieldUntil = -Infinity;
    this.settleUntil = -Infinity;
    this.resumed = true;
    this.lastClick = null;
    this.hist = [];         // 最近几秒的光标位置 { t, x, y }，回溯定位用
    this.keysHeld = [];     // 语音“长按”着的键，给界面显示；放开由耳机桥执行
    this.refine = (p) => p; // 调用方可替换：把定位点吸附到按钮上
    this.dwell = null;      // { x, y, t0, done }
    this.speed = 0;
    this.prev = null;
    this.stats = { clicks: 0, rejected: {} };
    this.keyHold = null;    // 歪头按住的键 { key, t }
  }

  set(options) {
    Object.assign(this.o, options);
    if (!this.o.dwell) this.dwell = null;
  }

  /** 光标是否应当停住：歪头识别中，或者键鼠正在用 */
  get frozen() {
    return this.frozenAt != null;
  }

  yielding(t) {
    return t < this.yieldUntil;
  }

  /** 给界面显示的状态 */
  status(t) {
    if (this.yielding(t)) return { mode: 'yield', left: this.yieldUntil - t };
    if (this.keyHold) return { mode: 'dictate', key: this.keyHold.key };
    if (this.voiceHold) return { mode: 'voice' };
    if (this.keysHeld.length && !this.held) return { mode: 'keys', keys: this.keysHeld };
    if (this.held) return { mode: 'drag', left: this.o.maxHoldMs - (t - this.heldAt) };
    if (this.state === 'armed' || this.state === 'tilt') return { mode: 'gesture', side: this.side };
    if (this.dwell && !this.dwell.done && this.o.dwell) return { mode: 'dwell', progress: Math.min((t - this.dwell.t0) / this.o.dwellMs, 1) };
    return { mode: 'ready' };
  }

  /** 刚接管鼠标：静默一会儿，丢掉旧状态 */
  engage(t) {
    this.reset(t);
    this.settleUntil = t + this.o.settleMs;
  }

  /** 交还鼠标或中止：按住的键要松开 */
  reset(t) {
    const out = [];
    if (this.held) out.push(...this.release(t, 'reset'));
    if (this.keyHold) out.push(...this.keyUp());
    if (this.keysHeld.length) out.push({ type: 'key', action: 'releaseAll' });
    this.keysHeld = [];
    this.state = 'idle';
    this.frozenAt = null;
    this.voiceHold = false;
    this.dwell = null;
    this.base = null;
    return out;
  }

  /** 真实的鼠标、触控板或键盘动了：立刻让位 */
  physical(t) {
    const out = this.held ? this.release(t, 'physical') : [];
    if (!this.yielding(t)) out.push({ type: 'yield' });
    this.keysHeld = []; // 耳机桥看到真实键鼠时已经放开了
    this.keyHold = null;
    this.yieldUntil = t + this.o.yieldMs;
    this.resumed = false;
    this.state = 'idle';
    this.frozenAt = null;
    this.voiceHold = false;
    this.dwell = null;
    return out;
  }

  /**
   * 每个样本调用一次。t：ms；pose：相对正前方的 { h, v, r }（度）；cursor：当前光标位置。
   * 返回动作列表：button（click / down / up）、freeze、resume、yield、reject、cue。
   */
  update(t, pose, cursor) {
    const o = this.o;
    const out = [];
    if (!pose) return out;

    // 头部转动速度（水平和垂直），平滑一下
    if (this.prev) {
      const dt = Math.max(t - this.prev.t, 1) / 1000;
      const inst = Math.hypot(wrapDeg(pose.h - this.prev.h), pose.v - this.prev.v) / dt;
      this.speed += (inst - this.speed) * Math.min(dt / 0.1, 1);
    }
    const dtMs = this.prev ? t - this.prev.t : 0;
    this.prev = { t, h: pose.h, v: pose.v };
    if (cursor) {
      this.hist.push({ t, x: cursor.x, y: cursor.y });
      while (this.hist.length && this.hist[0].t < t - 4000) this.hist.shift();
    }

    if (this.yielding(t)) return out;
    if (!this.resumed) {
      this.resumed = true;
      this.settleUntil = t + o.settleMs;
      out.push({ type: 'resume' });
    }

    if (this.held && t - this.heldAt > o.maxHoldMs) out.push(...this.release(t, 'timeout'));
    if (this.voiceHold) {
      // 说话时不识别歪头，也不驻留
      if (t > this.voiceUntil) {
        this.voiceHold = false;
        this.unfreeze(out, true);
      }
      return out;
    }

    this.base ??= pose.r;
    const d = wrapDeg(pose.r - this.base);
    const a = Math.abs(d);
    const follow = (tau) => {
      this.base += wrapDeg(pose.r - this.base) * (1 - Math.exp(-dtMs / tau));
    };

    if (o.tilt && this.state === 'keyhold') {
      // 按住键期间头可以随便动（边说话边看屏幕），只看回没回正
      if (a < o.exitDeg) {
        out.push(...this.keyUp());
        this.state = 'cooldown';
        this.cooldownUntil = t + o.refractoryMs;
      } else if (t - this.keyHold.t > o.keyHoldMaxMs) {
        out.push(...this.keyUp());
        this.state = 'blocked';
      }
    } else if (o.tilt && this.state === 'keytilt') {
      // 键已经按过了，等回正；歪着不回来就是换了姿势，中立位跟过去
      if (a < o.exitDeg) {
        this.state = 'cooldown';
        this.cooldownUntil = t + o.refractoryMs;
      } else if (t - this.tEnter > o.keyTiltMaxMs) {
        this.state = 'blocked';
      }
    } else if (o.tilt) {
      switch (this.state) {
        case 'cooldown':
          if (t >= this.cooldownUntil) {
            this.state = a < o.preDeg ? 'idle' : 'blocked';
            this.unfreeze(out);
          }
          break;
        case 'idle':
          if (a < o.preDeg) {
            follow(o.baselineTauMs);
            break;
          }
          if (t < this.settleUntil) this.block(out, 'settle');
          else if (this.speed > o.calmDegPerSec) this.block(out, 'fast');
          else {
            this.state = 'armed';
            this.side = d < 0 ? 'left' : 'right';
            this.t0 = t;
            this.start = { h: pose.h, v: pose.v };
          }
          break;
        case 'armed':
        case 'tilt': {
          const side = d < 0 ? 'left' : 'right';
          const drift = Math.max(Math.abs(wrapDeg(pose.h - this.start.h)), Math.abs(pose.v - this.start.v));
          if (drift > o.driftDeg) {
            this.block(out, 'drift');
          } else if (this.state === 'armed') {
            if (a < o.preDeg || side !== this.side) {
              this.state = 'idle'; // 小幅晃动，没歪够就回来了
              this.unfreeze(out);
            } else if (a >= o.enterDeg) {
              if (t - this.t0 > o.riseMs) this.block(out, 'slow');
              else if (this.held) {
                // 锁定中再歪一次：在开始歪头前停留的位置松开，等回正
                this.freeze(out, this.intended(this.t0 - o.leadMs));
                out.push(...this.release(t, 'tilt'));
                this.state = 'blocked';
                this.unfreezeLater = true;
              } else if (this.tiltAction().do !== 'click') {
                out.push(...this.keyTilt(t));
              } else {
                this.state = 'tilt';
                this.tEnter = t;
                this.freeze(out, this.intended(this.t0 - o.leadMs));
              }
            } else if (t - this.t0 > o.riseMs) {
              this.block(out, 'slow');
            }
          } else if (a < o.exitDeg) {
            // 回正
            const dur = t - this.tEnter;
            if (dur <= o.tapMaxMs) out.push(...this.click(t, this.side === 'left' ? 'left' : 'right'));
            else this.reject(out, 'long');
            this.state = 'cooldown';
            this.cooldownUntil = t + o.refractoryMs;
          } else if (this.side === 'left' && t - this.tEnter >= o.holdMs) {
            // 左歪停住：按下并锁定，光标解冻，可以拖拽
            this.held = true;
            this.heldAt = t;
            out.push({ type: 'button', button: 'left', action: 'down', at: this.frozenAt }, { type: 'cue', name: 'down' });
            this.state = 'blocked';
            this.unfreeze(out);
          }
          break;
        }
        case 'blocked':
          follow(o.blockedTauMs);
          if (Math.abs(wrapDeg(pose.r - this.base)) < o.preDeg) {
            this.state = 'idle';
            if (this.unfreezeLater) this.unfreeze(out);
          }
          break;
      }
    } else {
      if (this.keyHold) out.push(...this.keyUp()); // 按住时关了歪头：立刻松开，绝不卡住
      this.state = 'idle';
      follow(o.baselineTauMs);
    }

    if (o.dwell && cursor && !this.frozen) out.push(...this.updateDwell(t, cursor));
    return out;
  }

  /**
   * 语音事件。phase：start（开口）、end（说完）、command（认出指令）。
   * 指令：left double right hold release scrollUp scrollDown zoomIn zoomOut pause resume recenter
   */
  voice(t, phase, command, cursor, args = {}) {
    const out = [];
    if (this.yielding(t) || this.keyHold) return out;
    if (phase === 'start') {
      const onset = t - this.o.voiceLagMs;
      this.voiceOnset = onset;
      // 开口前刚停过：光标拉回停留处并停住，说话时头怎么偏都不影响。没停过（边转头边说话）就不管光标
      const fx = this.fixation(onset);
      if (!this.frozen && fx && onset - fx.t < this.o.freezeRecentMs) {
        this.state = 'idle';
        this.voiceHold = true;
        this.freeze(out, this.refine(fx));
      }
      if (this.voiceHold) this.voiceUntil = t + this.o.voiceHoldMs;
    } else if (phase === 'end') {
      if (this.voiceHold) this.voiceUntil = Math.min(this.voiceUntil, t + this.o.voiceGraceMs);
    } else if (phase === 'command') {
      // 没冻结时：用这句话开口前的停留处；收不到开口事件时，用认出指令前的停留处
      const onset = this.voiceOnset != null && t - this.voiceOnset < 4000 ? this.voiceOnset : t - this.o.voiceLagMs;
      out.push(...this.command(t, command, this.frozenAt ?? this.intended(onset) ?? cursor, args));
      this.voiceOnset = null;
      if (this.voiceHold) {
        this.voiceHold = false;
        this.unfreeze(out, true);
      }
    }
    return out;
  }

  /** args：按键指令的 { key, mods, hold } */
  command(t, name, at, args = {}) {
    const cue = (n) => ({ type: 'cue', name: n });
    switch (name) {
      case 'left': return this.click(t, 'left', at);
      case 'right': return this.click(t, 'right', at);
      case 'double':
        this.stats.clicks += 1;
        this.lastClick = null;
        return [{ type: 'button', button: 'left', action: 'click', count: 1, at }, { type: 'button', button: 'left', action: 'click', count: 2, at }, cue('double')];
      case 'hold': // 也是“长按”“拖动”：按下不放，转头拖，说“松开”或再歪一次头放下
        if (this.held) return [];
        this.held = true;
        this.heldAt = t;
        return [{ type: 'button', button: 'left', action: 'down', at }, cue('down')];
      case 'release': {
        // 鼠标在停留处松开（选文字、拖拽的终点）；按住的键一起放开
        const out = this.held ? this.release(t, 'voice', at) : [];
        if (this.keysHeld.length) {
          this.keysHeld = [];
          out.push({ type: 'key', action: 'releaseAll' }, cue('up'));
        }
        return out;
      }
      // 选一段文字：先说“从这里”点下起点，看到终点再说“到这里”，就是 Shift + 点击
      case 'selectFrom': return this.click(t, 'left', at);
      case 'selectTo':
        this.lastClick = null;
        return [{ type: 'button', button: 'left', action: 'click', count: 1, at, mods: ['shift'] }, cue('click')];
      case 'key':
        if (!args.key) return [];
        if (args.hold) this.keysHeld = [...new Set([...this.keysHeld, [...(args.mods ?? []), args.key].join('+')])];
        return [{ type: 'key', key: args.key, mods: args.mods ?? [], action: args.hold ? 'down' : 'press' }, cue(args.hold ? 'down' : 'click')];
      case 'scrollUp': return [{ type: 'scroll', dy: this.o.scrollPx }, cue('click')];
      case 'scrollDown': return [{ type: 'scroll', dy: -this.o.scrollPx }, cue('click')];
      case 'zoomIn': return [{ type: 'zoom', dir: 'in' }, cue('click')];
      case 'zoomOut': return [{ type: 'zoom', dir: 'out' }, cue('click')];
      case 'pause': return [{ type: 'clutch', on: true }, cue('down')];
      case 'resume': return [{ type: 'clutch', on: false }, cue('up')];
      case 'recenter': return [{ type: 'recenter' }, cue('up')];
      // 关闭、最小化、全屏头指的那个窗口（耳机桥按窗口自己的按钮）
      case 'window': return args.key ? [{ type: 'window', action: args.key, at }, cue('click')] : [];
      // 标号：在头指的地方附近给可点元素标上 1～9；说数字点它
      case 'labels': return [{ type: 'labels', on: true, at }, cue('up')];
      case 'labelsOff': return [{ type: 'labels', on: false }, cue('down')];
      case 'label': return args.key ? [{ type: 'label', n: Number(args.key) }] : [];
      default: return [];
    }
  }

  /** tEnd 之前最近的一次停留：{ x, y, t }（t 是停留结束的时刻）；找不到返回 null */
  fixation(tEnd) {
    const o = this.o;
    const h = this.hist;
    let end = h.length - 1;
    while (end >= 0 && h[end].t > tEnd) end--;
    for (; end >= 0 && h[end].t >= tEnd - o.lookbackMs; end--) {
      let start = end;
      while (start > 0 && h[start - 1].t >= h[end].t - o.fixMs) start--;
      if (h[end].t - h[start].t < o.fixMs * 0.8) continue; // 这一段样本不够长
      let cx = 0;
      let cy = 0;
      for (let i = start; i <= end; i++) {
        cx += h[i].x;
        cy += h[i].y;
      }
      const n = end - start + 1;
      cx /= n;
      cy /= n;
      let spread = 0;
      for (let i = start; i <= end; i++) spread += Math.hypot(h[i].x - cx, h[i].y - cy);
      if (spread / n <= o.fixPx) return { x: cx, y: cy, t: h[end].t };
    }
    return null;
  }

  /** 执行操作的位置：tEnd 之前的停留处（再吸附到按钮）；没停留过就用 tEnd 那一刻的光标 */
  intended(tEnd) {
    const fx = this.fixation(tEnd);
    if (fx) return this.refine(fx);
    const h = this.hist;
    let i = h.length - 1;
    while (i > 0 && h[i].t > tEnd) i--;
    return h[i] ? this.refine({ x: h[i].x, y: h[i].y }) : null;
  }

  /** 当前场景下这一侧歪头的动作 */
  tiltAction(side = this.side) {
    return (TILT_MODES[this.o.tiltMode] ?? TILT_MODES.click)[side] ?? { do: 'click' };
  }

  /** 按键类歪头：歪够的这一刻按下（或按住） */
  keyTilt(t) {
    const act = this.tiltAction();
    this.tEnter = t;
    this.stats.clicks += 1;
    if (act.do === 'hold') {
      this.state = 'keyhold';
      this.keyHold = { key: act.key, t };
      return [{ type: 'key', key: act.key, mods: [], action: 'down', tilt: true }, { type: 'cue', name: 'down' }];
    }
    this.state = 'keytilt';
    return [{ type: 'key', key: act.key, mods: [], action: 'press', tilt: true }, { type: 'cue', name: 'click' }];
  }

  keyUp() {
    const k = this.keyHold;
    this.keyHold = null;
    return k ? [{ type: 'key', key: k.key, mods: [], action: 'up', tilt: true }, { type: 'cue', name: 'up' }] : [];
  }

  updateDwell(t, cursor) {
    const o = this.o;
    const dw = this.dwell;
    if (!dw || Math.hypot(cursor.x - dw.x, cursor.y - dw.y) > (dw.done ? o.dwellPx * 1.5 : o.dwellPx)) {
      // 离开驻留圈：重新开始计时
      this.dwell = { x: cursor.x, y: cursor.y, t0: t, done: false };
      return [];
    }
    if (dw.done || t < this.settleUntil || t - dw.t0 < o.dwellMs) return [];
    dw.done = true; // 停着不动不会连点，要先移出驻留圈
    if (this.held) return this.release(t, 'dwell');
    return this.click(t, 'left', { x: dw.x, y: dw.y });
  }

  click(t, button, at = this.frozenAt) {
    let count = 1;
    const lc = this.lastClick;
    if (button === 'left' && lc && t - lc.t <= this.o.doubleMs && at && lc.at && Math.hypot(at.x - lc.at.x, at.y - lc.at.y) <= this.o.doublePx) {
      count = lc.count + 1;
    }
    this.lastClick = button === 'left' ? { t, at, count } : null;
    this.stats.clicks += 1;
    return [
      { type: 'button', button, action: 'click', count, at },
      { type: 'cue', name: button === 'right' ? 'right' : count > 1 ? 'double' : 'click' },
    ];
  }

  release(t, why, at) {
    this.held = false;
    return [{ type: 'button', button: 'left', action: 'up', why, at }, { type: 'cue', name: 'up' }];
  }

  /** 停住光标；at 是要停在的位置（歪头时是开始歪头的位置，调用方要把光标拉回去） */
  freeze(out, at) {
    this.frozenAt = at ? { x: at.x, y: at.y } : null;
    this.unfreezeLater = false;
    out.push({ type: 'freeze', on: true, at: this.frozenAt });
  }

  /**
   * 恢复光标。discard：停住期间的转头不算（说话时头不会回到原处）；
   * 否则停住期间的转头在恢复时补上（歪头回正后，顺带的转动正好抵消）
   */
  unfreeze(out, discard = false) {
    if (this.frozenAt == null && !this.unfreezeLater) return;
    this.frozenAt = null;
    this.unfreezeLater = false;
    out.push({ type: 'freeze', on: false, discard });
  }

  block(out, reason) {
    this.state = 'blocked';
    this.unfreeze(out);
    this.reject(out, reason);
  }

  reject(out, reason) {
    this.stats.rejected[reason] = (this.stats.rejected[reason] ?? 0) + 1;
    out.push({ type: 'reject', reason });
  }
}
