// 小规模最小二乘：特征数只有 3～6 个，直接解正规方程即可。

/**
 * rows：每个样本的特征行；targets：若干个输出列（如 [xs, ys]）。
 * 返回每个输出列对应的系数数组。
 */
export function leastSquares(rows, targets) {
  const n = rows[0].length;
  const ata = Array.from({ length: n }, () => new Array(n).fill(0));
  const atb = targets.map(() => new Array(n).fill(0));
  rows.forEach((r, k) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) ata[i][j] += r[i] * r[j];
      targets.forEach((y, m) => { atb[m][i] += r[i] * y[k]; });
    }
  });
  return atb.map((b) => solve(ata.map((row) => row.slice()), b));
}

/** 带列主元的高斯消元，会修改传入的 A 和 b */
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) throw new Error('矩阵奇异：样本太少或分布太集中');
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}
