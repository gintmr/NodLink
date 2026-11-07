// 奶蛙的动作编排：108 帧分成 12 段。只管排帧，不管识别和声音（见 naiwa.js）。逐帧播放交给 ui/frame-player.js。
//
// 帧区间（含首尾；左右以画面方向为准）：
//   000–008 起笑   009–017 大笑下压 A   018–026 大笑回弹 A   027–035 大笑下压 B   036–044 大笑回弹 B   045–053 收笑回中
//   054–062 向左起手   063–071 保持左起手   072–080 左侧回中
//   081–089 向右起手   090–098 保持右起手   099–107 右侧回中
//
// 大笑不是自动循环，而是“跟着头走”（follow）：外面每帧给一个点头深度 depth（0 = 头在中线或更高，1 = 点到底），
//   头往下走 → 在“下压”段里找蹲得一样低的那帧；头往上走 → 在“回弹”段里找；
//   往下 / 往上一换方向（回头超过 0.1）就换段：下压 A → 回弹 A → 下压 B → 回弹 B → 下压 A …
//   所以点得快它就笑得快，点得慢就慢，点得浅它只蹲一点；头停住它也停住。
//   “蹲得多低”用每帧角色头顶的高度量（逐帧量过，见 CROUCH_TOP）：换段时直接跳到高度相同的那帧，身体不会突然高低跳；
//   同一段里往目标帧走时限速 40 帧 / 秒，头的抖动不会让画面乱闪。
//   开始：先快速播起笑（0.2 s），再接着跟。停下（或要转身）：先跟着 depth = 0 回到站直的那帧，再收笑（或直接起手）。
// 左右：起手 → 保持（循环）→ 回中；换方向先回中再起另一边。
//
// 接缝（逐帧比过像素差，相邻帧平均差约 9）：
//   向右起手末帧 089 → 保持段第一帧 090 差 27.9（这一帧角色突然变小、蹲低），从 094 接进保持段降到 22.6；
//   向左起手 062 → 063 差 16.9，从 070 接进去降到 14.7。所以保持段从这两帧开始循环，不从段首开始。
//   起手刚到位就不要了，直接回中：089→099 差 16.9、062→072 差 19.5，比先进保持段再出来还小。
//   回中（053、080、107）后马上接下一个动作时不停在第 0 帧：080→081 差 10.4、053→054 差 8.0。
//   大笑站直的几帧（009、026、027、044）到收笑 045、到起手 054 / 081 差 8～13；下压中途和回弹里同高度的帧差 10～20。

export const SEGMENTS = {
  idle: { from: 0, to: 0, loop: true },
  laughIn: [0, 8],
  downA: [9, 17],
  upA: [18, 26],
  downB: [27, 35],
  upB: [36, 44],
  laughOut: [45, 53],
  leftIn: [54, 62],
  leftHold: { from: 63, to: 71, loop: true },
  leftOut: [72, 80],
  rightIn: [81, 89],
  rightHold: { from: 90, to: 98, loop: true },
  rightOut: [99, 107],
};

const HOLD_ENTRY = { leftHold: 70, rightHold: 94 };
const LAUGH_SEGS = ['downA', 'upA', 'downB', 'upB'];
const NEXT = { downA: 'upA', upA: 'downB', downB: 'upB', upB: 'downA' };
const isDown = (seg) => seg === 'downA' || seg === 'downB';

// 每帧角色头顶离画面顶端的像素（512 高的原图里量的），009–044
const CROUCH_TOP = [5, 7, 22, 20, 38, 59, 62, 86, 102, 127, 92, 63, 41, 23, 6, 5, 5, 4, 5, 5, 13, 14, 31, 47, 49, 68, 85, 91, 76, 61, 56, 40, 29, 26, 15, 5];
/** 帧 k 蹲得多低（0 = 站直，1 = 这段最低），每段各自归一 */
export const CROUCH = {};
for (const seg of LAUGH_SEGS) {
  const { from, to } = segRange(seg);
  const tops = [];
  for (let k = from; k <= to; k++) tops.push(CROUCH_TOP[k - 9]);
  const lo = Math.min(...tops);
  const hi = Math.max(...tops);
  for (let k = from; k <= to; k++) CROUCH[k] = (CROUCH_TOP[k - 9] - lo) / (hi - lo);
}

function segRange(seg) {
  const s = SEGMENTS[seg];
  return Array.isArray(s) ? { from: s[0], to: s[1] } : s;
}

/** 这一段里蹲的高度最接近 depth 的帧 */
export function frameAt(seg, depth) {
  const { from, to } = segRange(seg);
  let best = from;
  for (let k = from; k <= to; k++) if (Math.abs(CROUCH[k] - depth) < Math.abs(CROUCH[best] - depth)) best = k;
  return best;
}

/** 每段属于哪个状态（给界面亮灯、给声音用） */
export function kindOf(seg) {
  if (seg === 'idle' || seg === 'laughOut') return 'idle';
  if (seg === 'laughIn' || LAUGH_SEGS.includes(seg)) return 'laugh';
  if (seg.startsWith('left')) return seg === 'leftOut' ? 'idle' : 'left';
  return seg === 'rightOut' ? 'idle' : 'right';
}

const HYST = 0.1; // 往回走超过这么多才算换方向
const FOLLOW_FPS = 40; // 跟着头走时，同一段里最快每秒走几帧

export class NaiwaAnimator {
  /** player：FramePlayer（actions 用上面的 SEGMENTS） */
  constructor(player) {
    this.p = player;
    this.want = 'idle';
    this.seg = null;
    this.depth = 0; // 外面给的点头深度
    this.ext = 0; // 这一段走到的最深 / 最浅
    this.allow = 0; // 限速用的“可走帧数”
    this.go('idle');
  }

  /** 想要的状态：'idle' | 'laugh' | 'left' | 'right' */
  set(want) {
    if (want === this.want) return;
    this.want = want;
    // 站着、保持起手是循环段，不会自己播完，要在这里立刻转走；大笑跟随在 update() 里收
    if (this.seg === 'idle') this.next();
    else if (this.seg === 'leftHold' && want !== 'left') this.go('leftOut');
    else if (this.seg === 'rightHold' && want !== 'right') this.go('rightOut');
    if (!this.following) this.p.speed = this.speedOf(this.seg);
  }

  /** 组合动作，名字照需求：laugh / stopLaugh / left / right / center / idle */
  playAction(name) {
    const map = { laugh: 'laugh', stopLaugh: 'idle', center: 'idle', idle: 'idle', left: 'left', right: 'right' };
    if (!(name in map)) throw new Error(`没有这个动作：${name}`);
    this.p.resume();
    this.set(map[name]);
  }

  get following() {
    return LAUGH_SEGS.includes(this.seg);
  }

  go(seg) {
    this.seg = seg;
    if (LAUGH_SEGS.includes(seg)) return; // 跟随段不自动播，update() 里按深度定帧
    this.p.playAction(seg, { start: HOLD_ENTRY[seg], onEnd: () => this.next() });
    this.p.speed = this.speedOf(seg);
  }

  /** 一段（自动播的）播完，接哪段 */
  next() {
    const w = this.want;
    switch (this.seg) {
      case 'idle':
        if (w === 'laugh') this.go('laughIn');
        else if (w === 'left') this.go('leftIn');
        else if (w === 'right') this.go('rightIn');
        break;
      case 'laughIn':
        if (w === 'laugh') this.follow('downA');
        else this.go('laughOut');
        break;
      case 'leftIn':
        this.go(w === 'left' ? 'leftHold' : 'leftOut');
        break;
      case 'rightIn':
        this.go(w === 'right' ? 'rightHold' : 'rightOut');
        break;
      default: // laughOut、leftOut、rightOut：回到站着，再看要不要接着做别的
        this.go('idle');
        if (w !== 'idle') this.next();
    }
  }

  follow(seg) {
    this.seg = seg;
    this.ext = this.depth;
    this.p.pause();
    this.p.setFrame(frameAt(seg, this.depth));
  }

  speedOf(seg) {
    const w = this.want;
    if (seg === 'laughIn') return 4; // 0.2 s：一开始点头就笑起来
    if (seg === 'laughOut') return w === 'idle' ? 1.5 : 3;
    if (seg === 'leftIn' || seg === 'rightIn') return 1.8; // 起手要“立马”
    if (seg === 'leftOut' || seg === 'rightOut') return w === 'idle' ? 1.4 : 2.2;
    return 1;
  }

  /** 每帧：depth（0…1）是头点下去多深；不在大笑跟随时照常播放 */
  update(dt, { depth = 0 } = {}) {
    this.depth = depth;
    if (!this.following) {
      this.p.update(dt);
      return;
    }
    // 不笑了（回正、停住、要转身）：跟着 depth = 0 回到站直的那帧，再收笑 / 起手
    const leaving = this.want !== 'laugh';
    const d = leaving ? 0 : depth;
    if (leaving && CROUCH[this.p.frame] <= 0.12) {
      // 已经站直了（画面上就是这帧）：收笑，或者直接起手
      if (this.want === 'idle') this.go('laughOut');
      else this.go(this.want === 'left' ? 'leftIn' : 'rightIn');
      return;
    }
    if (leaving && isDown(this.seg)) {
      // 蹲着时要收：换到回弹段里同样高的那帧，再一帧帧站起来（不直接跳到站直）
      return this.switchTo(NEXT[this.seg], CROUCH[this.p.frame]);
    }
    // 换方向：往回走超过 HYST
    if (leaving) {
      // 收的时候只往站直走
    } else if (isDown(this.seg)) {
      if (d > this.ext) this.ext = d;
      else if (d < this.ext - HYST) return this.switchTo(NEXT[this.seg], d);
    } else {
      if (d < this.ext) this.ext = d;
      else if (d > this.ext + HYST) return this.switchTo(NEXT[this.seg], d);
    }
    // 同一段里往目标帧走，限速
    const target = frameAt(this.seg, d);
    // 每次最多走一帧（不跳帧），追不上就下一帧接着追
    this.allow = Math.min(this.allow + dt * FOLLOW_FPS, 1);
    if (this.allow >= 1 && this.p.frame !== target) {
      this.p.setFrame(this.p.frame + Math.sign(target - this.p.frame));
      this.allow -= 1;
    }
  }

  switchTo(seg, d) {
    this.seg = seg;
    this.ext = d;
    this.p.setFrame(frameAt(seg, d)); // 跳到另一段里一样高的那帧
  }

  get kind() {
    return kindOf(this.seg);
  }
}
