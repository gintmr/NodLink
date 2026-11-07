// 吸附：头不去对准像素，而是选中离头部落点最近的一个可点元素（按钮、链接、输入框……）。
// 思路来自 Bubble Cursor（Grossman & Balakrishnan, 2005）：每个元素实际管辖的是“离它最近的那一片区域”，
// 比它本身大得多。头部落点抖 15～20 点，按钮只有 20～30 点宽，直接对准做不到，选“最近的”就容易了。
//
// 只用最近的元素还不够：落点在两个元素的分界线附近抖动时，选中项会来回跳。所以加滞回：
//   - 新元素要比当前选中的明显更近（近出 max(minMargin, switchMargin × 当前距离)）
//   - 并且持续 switchMs 一直更近，才换过去
//   - 落点还在当前元素里面时绝不换
// 输出的光标位置：小元素放在正中心（光标完全不抖）；大元素（文本框、列表）放在落点处、限制在元素内，
// 因为大元素里点哪儿是有意义的。离所有元素都超过 radius 时不吸附，光标照常跟头走。
// 坐标都是全局坐标（点）。

export const SNAP_DEFAULTS = {
  radius: 90,          // 离元素超过这么远就不吸附
  switchMargin: 0.35,  // 新元素要近出当前距离的这个比例
  minMargin: 10,       // 至少近出这么多点
  switchMs: 120,       // 持续这么久都更近才换
  bigW: 240,           // 比这宽或比 bigH 高的算大元素
  bigH: 80,
};

/** 点到矩形的距离：在矩形里是 0 */
export function rectDist(p, r) {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

const sameRect = (a, b) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2;

export class Snapper {
  constructor(options = {}) {
    this.o = { ...SNAP_DEFAULTS, ...options };
    this.items = [];
    this.current = null;
    this.challenger = null; // { item, since }
    this.switches = 0;      // 换了几次目标，给统计用
  }

  set(options) {
    Object.assign(this.o, options);
  }

  /** 换一批元素（界面刷新后重新扫描的结果）。当前选中的如果还在，保持选中 */
  setTargets(items) {
    this.items = items ?? [];
    if (this.current) this.current = this.items.find((it) => sameRect(it, this.current)) ?? null;
    this.challenger = null;
  }

  clear() {
    this.current = null;
    this.challenger = null;
  }

  /** t：ms；p：头部落点。返回 { target, point }：point 是光标应该在的位置 */
  update(t, p) {
    const o = this.o;
    let best = null;
    let bestD = Infinity;
    for (const it of this.items) {
      const d = rectDist(p, it);
      // 同样近（都在里面）时选面积小的：嵌套时选里层的按钮，不选外面的容器
      if (d < bestD - 0.01 || (Math.abs(d - bestD) <= 0.01 && best && it.w * it.h < best.w * best.h)) {
        best = it;
        bestD = d;
      }
    }
    if (bestD > o.radius) best = null;

    const cur = this.current;
    if (!cur) {
      this.current = best;
      if (best) this.switches += 1;
    } else if (best !== cur) {
      const dc = rectDist(p, cur);
      if (dc > o.radius * 1.2) {
        // 已经离开很远了：直接换（或者不吸附）
        this.current = best;
        this.challenger = null;
        this.switches += 1;
      } else if (best && dc > 0 && bestD + Math.max(o.minMargin, o.switchMargin * dc) < dc) {
        if (this.challenger?.item !== best) this.challenger = { item: best, since: t };
        else if (t - this.challenger.since >= o.switchMs) {
          this.current = best;
          this.challenger = null;
          this.switches += 1;
        }
      } else {
        this.challenger = null;
      }
    } else {
      this.challenger = null;
    }

    const target = this.current;
    if (!target) return { target: null, point: p };
    if (target.w > o.bigW || target.h > o.bigH) {
      const m = 4;
      return {
        target,
        point: {
          x: Math.min(Math.max(p.x, target.x + m), target.x + target.w - m),
          y: Math.min(Math.max(p.y, target.y + m), target.y + target.h - m),
        },
      };
    }
    return { target, point: { x: target.x + target.w / 2, y: target.y + target.h / 2 } };
  }
}
