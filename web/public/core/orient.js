// 用四元数算头部朝向，消掉歪头对水平角、垂直角的串扰。
//
// AirPods 在耳朵里是斜着的，它自己的“前方”轴（设备 +Y）和头的前后轴差了一个角度。
// 直接用欧拉角 yaw / pitch，等于拿设备 +Y 当前方：歪头时 +Y 绕着真正的前后轴画圈，
// 水平角、垂直角跟着变，光标就会被带偏。
// 歪头本身就是绕头的前后轴转，所以从一次歪头前后的姿态就能求出这根轴 f，
// 之后用 f 在世界坐标里的方向算水平角和垂直角，歪头就不再影响它们。
//
// 约定（已用实测数据核对）：CoreMotion 的四元数 q 把设备坐标转到参考坐标，
// f = (0, 1, 0) 时，下面算出的 yaw / pitch 和 CMAttitude 的欧拉角完全一致。

const D = 180 / Math.PI;

export function quatMul([aw, ax, ay, az], [bw, bx, by, bz]) {
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export const quatConj = ([w, x, y, z]) => [w, -x, -y, -z];

/** 用 q 旋转向量 v */
export function rotate(q, [vx, vy, vz]) {
  const [, x, y, z] = quatMul(quatMul(q, [0, vx, vy, vz]), quatConj(q));
  return [x, y, z];
}

const norm = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((c) => c / n);
};

/** 前方轴 f 指向的水平角和垂直角（弧度，和欧拉角同号） */
export function pointing(q, f = [0, 1, 0]) {
  const [x, y, z] = rotate(q, f);
  return { yaw: Math.atan2(-x, y), pitch: Math.asin(Math.max(-1, Math.min(1, z))) };
}

/** 四元数的平均（同半球内直接相加再归一化，小范围内足够准） */
export function meanQuat(list) {
  const ref = list[0];
  const sum = [0, 0, 0, 0];
  for (const q of list) {
    const s = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) sum[i] += s * q[i];
  }
  return norm(sum);
}

/**
 * 从歪头前后的两个姿态求头的前后轴（设备坐标）。
 * q1 = q0 · dq，dq 是在设备坐标里的转动，它的转轴就是前后轴。
 * 返回 { f, angleDeg, offDeg }：offDeg 是 f 和设备 +Y 的夹角，也就是耳机斜了多少。
 */
export function forwardFromTilt(q0, q1) {
  const dq = quatMul(quatConj(q0), q1);
  const s = Math.hypot(dq[1], dq[2], dq[3]);
  const angleDeg = 2 * Math.atan2(s, Math.abs(dq[0])) * D;
  let f = norm([dq[1], dq[2], dq[3]]);
  if (f[1] < 0) f = f.map((c) => -c); // 转轴方向朝前
  return { f, angleDeg, offDeg: Math.acos(Math.min(1, f[1])) * D };
}
