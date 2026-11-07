// 9 点精度测试：3×3 网格依次出现目标，每个停留 dwellMs；
// 取停留后半段的光标平均位置算误差，再算抖动。

const ORDER = [4, 0, 8, 2, 6, 1, 7, 3, 5]; // 先中心，之后每次都跳到不相邻的点

export function makeGridTest(w, h, { margin = 0.12, dwellMs = 2500, rounds = 1 } = {}) {
  const grid = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      grid.push({ x: w * (margin + ((1 - 2 * margin) * c) / 2), y: h * (margin + ((1 - 2 * margin) * r) / 2) });
    }
  }
  const targets = [];
  for (let k = 0; k < rounds; k++) for (const i of ORDER) targets.push({ ...grid[i], round: k + 1 });
  const duration = targets.length * dwellMs;
  return {
    w,
    h,
    dwellMs,
    rounds,
    targets,
    duration,
    at(t) {
      if (t < 0 || t >= duration) return null;
      const index = Math.floor(t / dwellMs);
      return { ...targets[index], index, inDwell: t - index * dwellMs };
    },
  };
}

/** records: [{ t, x, y }]，t 为相对测试开始的 ms，x/y 为光标位置 */
export function evaluateGrid(test, records) {
  const d = test.dwellMs;
  const perTarget = test.targets.map((target, i) => {
    const pts = records.filter((r) => r.x != null && r.t >= i * d + d / 2 && r.t < (i + 1) * d);
    if (!pts.length) return { ...target, error: null, jitter: null };
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const jitter = Math.sqrt(pts.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / pts.length);
    return { ...target, meanX: mx, meanY: my, error: Math.hypot(mx - target.x, my - target.y), jitter };
  });
  const valid = perTarget.filter((p) => p.error != null);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const byRound = [];
  for (let k = 1; k <= test.rounds; k++) byRound.push(mean(valid.filter((p) => p.round === k).map((p) => p.error)));
  return {
    diagonal: Math.hypot(test.w, test.h),
    meanError: mean(valid.map((p) => p.error)),
    maxError: valid.length ? Math.max(...valid.map((p) => p.error)) : null,
    meanJitter: mean(valid.map((p) => p.jitter)),
    byRound,
    perTarget,
  };
}
