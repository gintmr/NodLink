// 场景里显示的“时间”：不用电脑的真实时间，画面上的时钟、锁屏都用一个固定的演示时间。
// 从固定的 10:24 开始，跟着页面打开后真实流过的时间走（所以分钟照样会跳，看起来是活的）。

const START_MIN = 10 * 60 + 24;
const t0 = performance.now();

/** 'HH:MM' */
export function demoClock() {
  const min = Math.floor(START_MIN + (performance.now() - t0) / 60000) % (24 * 60);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
