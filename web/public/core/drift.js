// 自动纠正水平漂移。
//
// AirPods 没有指南针，水平角（yaw）只能靠陀螺仪积分，会慢慢漂。垂直角有重力参照，不漂。
// 实测（耳机桥日志，每 3 分钟取一次水平角中位数）：每分钟 0.4～2.3°，方向一直相同，
// 10 分钟就差 5～20°，想看屏幕中间得把头转向一边，而且越用越偏。
//
// 纠正的依据：用电脑时人总体上是正对屏幕的，水平角的长期平均应该在正前方（0°）附近。
// 做法是一个二阶跟踪：先对纠正后的水平角做慢平均，再同时估计漂移量和漂移速度，
// 漂移是一直在涨的，只估漂移量会一直慢半拍。拉回速度最多 rateDegPerMin，看屏幕两侧时感觉不到；
// 转头看别处（偏离超过 awayDeg）的时间不算进平均。
//
// 漂移速度是陀螺仪的零偏，回中以后也不变：回中只清掉漂移量，学到的速度留着（recenter），
// 关掉纠正才全部清零（reset）。
//
// 模拟（在屏幕 ±15° 里随机看，每处 4～15 秒，偶尔看别处，30 分钟；第 10 分钟以后的误差）：
//   旧参数（周期 600 s、最快 1.5°/分）：漂 1°/分以内误差约 2°，漂 2°/分时 12°、2.5°/分时 22°，追不上；
//   现参数（周期 420 s、平均 25 s、最快 4°/分）：0～2.5°/分都在 3° 左右。
// 代价是没有漂移时被“这一阵多看了一边”带偏的也多一点（约 3°）。所以它只是兜底，偏了还是说“回中”或按 C。

export const DRIFT_DEFAULTS = {
  periodS: 420,       // 跟踪的快慢：越长越不容易被“这阵子多看了一边”带偏，越短跟漂移跟得越紧
  tauS: 25,           // 平均的时间常数
  rateDegPerMin: 4,   // 拉回的最快速度（实测漂移最快约 2.3°/分，要留余量追上）
  awayDeg: 35,        // 偏离正前方超过这个角度的时刻不算
};

export class YawDrift {
  constructor(options = {}) {
    this.o = { ...DRIFT_DEFAULTS, ...options };
    this.reset();
  }

  /** 全部清零（关掉纠正时） */
  reset() {
    this.rate = 0; // 估计的漂移速度（度/秒）
    this.recenter();
  }

  /** 回中、重新校准：漂移量清零，学到的漂移速度留着（陀螺仪的零偏不会因为回中而变） */
  recenter() {
    this.offset = 0; // 要从水平角里减掉的漂移（度）
    this.mean = 0;
    this.t = null;
  }

  /** tSec：秒；h：相对正前方的水平角（度，未纠正）。返回当前的漂移量 */
  update(tSec, h) {
    const o = this.o;
    const dt = this.t == null ? 0 : Math.min(Math.max(tSec - this.t, 0), 0.2);
    this.t = tSec;
    if (dt <= 0) return this.offset;
    const corrected = h - this.offset;
    if (Math.abs(corrected) < o.awayDeg) this.mean += (corrected - this.mean) * (1 - Math.exp(-dt / o.tauS));
    const w = (2 * Math.PI) / o.periodS;
    this.rate += w * w * this.mean * dt;
    const max = (o.rateDegPerMin / 60) * dt;
    this.offset += Math.min(Math.max((this.rate + 2 * w * this.mean) * dt, -max), max);
    return this.offset;
  }
}
