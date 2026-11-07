// 角度工具。全部以“度”为单位。

export const RAD = Math.PI / 180;

/** 折回 [-180, 180)，避免 179° → -179° 这类回绕造成跳变 */
export function wrapDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

/** 圆周平均：先把角度变成单位向量再平均，跨越 ±180° 时依然正确 */
export function circularMeanDeg(values) {
  let s = 0;
  let c = 0;
  for (const a of values) {
    s += Math.sin(a * RAD);
    c += Math.cos(a * RAD);
  }
  return Math.atan2(s, c) / RAD;
}
