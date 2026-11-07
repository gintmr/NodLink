// 介绍页第二章：在同一个 3D 场景里，把一次完整的头控过程放大、拆成四段镜头，10 秒一轮，不用文字，靠辅助线讲清楚。
//
//   0.0–2.6 s 蓝牙：镜头贴近耳机。右耳 AirPods 发出一圈圈波纹，一串数据点沿弧线流进笔记本（每秒 50 次的头部朝向）
//   2.6–5.6 s 指向：镜头拉高到斜上方。先从头到屏幕四角、正中依次连出虚线（校准时看过的五个点，定下“头朝哪 ↔ 屏幕哪”），
//             头左右转、上下点时，头顶画出水平角（绿）和垂直角（红）的扇形，屏幕上一横一竖两条十字线标出光标坐标
//   5.6–7.6 s 点击：镜头从头后方看屏幕。光标停在一个按钮上，头向左歪，头周围画出歪头角（蓝），歪到位时按钮按下、点出波纹
//   7.6–10  s 语音：头转到另一处，紫色声波一圈圈从头前方飞向笔记本，屏幕上连点两下（语音“双击”），然后回到正中
//
// 颜色和其它章节一致：蓝是光标和数据，左右转绿、上下点红、歪头蓝，语音紫。
// 镜头、头的动作、辅助线都只由这一轮里的时间 ft 算出来，切到这一章时从 0 开始。

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

export const FLOW_LOOP = 10;

const ease = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
/** 在 [a, b] 里为 1，前后各用 fade 秒淡入淡出 */
const env = (t, a, b, fade = 0.45) => ease(clamp01((t - a) / fade)) * ease(clamp01((b - t) / fade));

// 头的关键帧：时间、yaw（右转为正，弧度）、pitch（抬头为正）
const HEAD_KEYS = [
  [0, 0, 0.07],
  [2.6, 0, 0.07],
  [3.4, 0.32, 0.18],
  [4.3, -0.3, -0.02],
  [5.0, -0.14, 0.05],
  [7.6, -0.14, 0.05],
  [8.1, 0.17, 0.13],
  [9.4, 0.17, 0.13],
  [FLOW_LOOP, 0, 0.07],
];
const CLICK_T = 6.5; // 歪头到位、按钮按下
const VOICE = [8.15, 9.0]; // 声波飞行的时间段
const DOUBLE = [9.05, 9.22]; // 语音双击的两下

/** 这一轮里头的动作：yaw、pitch、tilt（1 = 一次点击的歪头幅度，向左） */
export function flowPose(ft) {
  let yaw = 0;
  let pitch = 0.07;
  for (let i = 1; i < HEAD_KEYS.length; i++) {
    if (ft <= HEAD_KEYS[i][0]) {
      const [t0, y0, p0] = HEAD_KEYS[i - 1];
      const [t1, y1, p1] = HEAD_KEYS[i];
      const k = ease(clamp01((ft - t0) / (t1 - t0)));
      yaw = y0 + (y1 - y0) * k;
      pitch = p0 + (p1 - p0) * k;
      break;
    }
  }
  if (ft < 2.6) yaw += Math.sin(ft * 2.4) * 0.1; // 蓝牙那段轻轻晃，数据在流
  const tilt = ft > 6.2 && ft < 6.85 ? Math.sin(((ft - 6.2) / 0.65) * Math.PI) : 0;
  return { yaw, pitch, tilt };
}

// 四段镜头。和其它章节同一套参数：注视点 look、水平距离 r、绕到哪一侧 ang、相机高度 y
const CAMS = [
  { t: 0, look: [0.25, 0.7, 0.95], r: 5.8, ang: 0.95, y: 2.0 }, // 蓝牙：从右侧看耳机，笔记本在后面
  { t: 2.6, look: [0, 1.0, 0.6], r: 6.9, ang: 1.12, y: 3.3 }, // 指向：侧上方，头、射线、屏幕全在画面里
  { t: 5.6, look: [-0.1, 1.0, -0.55], r: 5.9, ang: 0.14, y: 2.35 }, // 点击：从头后上方看屏幕，头在画面下方
  { t: 7.6, look: [0, 0.95, -0.2], r: 6.2, ang: -0.45, y: 2.0 }, // 语音：从左后方拉开，看得到头和屏幕之间
];
/** 这一轮里的镜头：每段开头用 0.9 秒从上一段过渡过来 */
export function flowShot(ft) {
  let i = CAMS.length - 1;
  while (i > 0 && ft < CAMS[i].t) i--;
  const cur = CAMS[i];
  const prev = CAMS[(i + CAMS.length - 1) % CAMS.length];
  const k = ease(clamp01((ft - cur.t) / 0.9));
  const l = (a, b) => a + (b - a) * k;
  return {
    look: [l(prev.look[0], cur.look[0]), l(prev.look[1], cur.look[1]), l(prev.look[2], cur.look[2])],
    r: l(prev.r, cur.r),
    ang: l(prev.ang, cur.ang),
    y: l(prev.y, cur.y),
    orbit: 0,
    shift: 0,
  };
}

/** 辅助线和特效。world：场景根节点；display：屏幕平面（本地坐标，宽 SW 高 SH）；head：头 */
export function createFlowFx({ world, display, head, SW, SH, isDark }) {
  const fx = new THREE.Group();
  world.add(fx);
  const BLUE = 0x0a84ff;
  const GREEN = 0x34c759;
  const RED = 0xff3b30;
  const PURPLE = 0xbf5af2;
  const basic = (color, opacity = 1, extra = {}) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, toneMapped: false, depthWrite: false, side: THREE.DoubleSide, ...extra });
  // 辅助线用 Line2（屏幕像素宽度的粗线），普通 Line 在高分屏上只有 1 像素，看不清
  const lineMats = [];
  const lineMat = (color, dashed = false, width = 2.4) => {
    const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity: 0, dashed, dashSize: 0.08, gapSize: 0.06, toneMapped: false, depthWrite: false });
    lineMats.push(m);
    return m;
  };
  const makeLine = (n, mat, parent = fx) => {
    const l = new Line2(new LineGeometry(), mat);
    l.frustumCulled = false;
    parent.add(l);
    return l;
  };
  const flat = [];
  const setLine = (line, pts) => {
    flat.length = 0;
    for (const p of pts) flat.push(p.x, p.y, p.z);
    line.geometry.setPositions(flat);
    if (line.material.dashed) line.computeLineDistances();
  };
  // 扇形：圆心 + 一串弧上的点，三角扇
  const makeFan = (n, color) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * 3), 3));
    const idx = [];
    for (let i = 1; i < n; i++) idx.push(0, i, i + 1);
    g.setIndex(idx);
    const m = new THREE.Mesh(g, basic(color, 0));
    m.frustumCulled = false;
    fx.add(m);
    return m;
  };
  const setFan = (fan, c, pts) => {
    const a = fan.geometry.attributes.position;
    a.setXYZ(0, c.x, c.y, c.z);
    pts.forEach((p, i) => a.setXYZ(i + 1, p.x, p.y, p.z));
    a.needsUpdate = true;
  };

  // ---------- 1. 蓝牙：耳机发出的波纹 + 流向笔记本的数据点 ----------
  const btRings = [0, 1, 2].map(() => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 6, 64), basic(BLUE, 0));
    fx.add(m);
    return m;
  });
  const PACKETS = 14;
  const packets = Array.from({ length: PACKETS }, () => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 8), basic(BLUE, 0));
    fx.add(m);
    return m;
  });
  const dataPath = makeLine(40, lineMat(BLUE, true, 2));
  const DECK = new THREE.Vector3(0.78, 0.1, -0.25); // 数据落到笔记本的地方（键盘右侧）
  const receiver = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.075, 40), basic(BLUE, 0));
  receiver.rotation.x = -Math.PI / 2;
  receiver.position.copy(DECK);
  fx.add(receiver);
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), DECK.clone());

  // ---------- 2. 指向：校准的四角 + 正中射线、水平角和垂直角扇形、屏幕上的十字线 ----------
  const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1], [0, 0]].map(([u, v]) => new THREE.Vector3((u * SW) / 2 * 0.92, (v * SH) / 2 * 0.9, 0.006));
  const cornerRays = corners.map((c, i) => makeLine(2, lineMat(i === 4 ? BLUE : 0x8e8e93, true, i === 4 ? 2.6 : 2)));
  const cornerDots = corners.map((c) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.045, 32), basic(0xffffff, 0));
    m.position.copy(c);
    display.add(m);
    return m;
  });
  const ARC = 32;
  const yawArc = makeLine(ARC + 1, lineMat(GREEN, false, 3.5));
  const yawFan = makeFan(ARC + 1, GREEN);
  const pitchArc = makeLine(ARC + 1, lineMat(RED, false, 3.5));
  const pitchFan = makeFan(ARC + 1, RED);
  const crossV = makeLine(2, lineMat(0xffffff, true, 2), display);
  const crossH = makeLine(2, lineMat(0xffffff, true, 2), display);

  // ---------- 3. 点击：歪头角扇形、按钮、波纹 ----------
  const rollArc = makeLine(ARC + 1, lineMat(BLUE, false, 3.5));
  const rollFan = makeFan(ARC + 1, BLUE);
  const rollRef = makeLine(2, lineMat(0x8e8e93, true, 2));
  const button = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.12), basic(0xffffff, 0));
  display.add(button);
  const ripples = [0, 1, 2].map(() => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.068, 48), basic(BLUE, 0));
    display.add(m);
    return m;
  });

  // ---------- 4. 语音：一圈圈飞向笔记本的声波 ----------
  const waves = [0, 1, 2, 3].map(() => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.026, 8, 64), basic(PURPLE, 0));
    fx.add(m);
    return m;
  });

  const v = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const podPos = new THREE.Vector3();
  const mouth = new THREE.Vector3();
  const screenCenter = new THREE.Vector3();
  let buttonAt = null;

  return {
    /**
     * w：这一章的显示程度（0～1）；ft：这一轮里的时间；pose：当前头的动作；
     * center：头的位置；local：光标在屏幕上的本地坐标；camera：用来让波纹朝向镜头
     */
    update({ w, ft, pose, center, local, camera, width, height }) {
      for (const m of lineMats) m.resolution.set(width, height);
      fx.visible = w > 0.01;
      const show = (m, o) => { m.material.opacity = o * w; m.visible = o * w > 0.005; };
      if (!fx.visible) {
        for (const m of [...cornerDots, button, ...ripples, crossV, crossH]) m.visible = false;
        return null;
      }
      const dark = isDark();
      for (const l of [...cornerRays.slice(0, 4), rollRef]) l.material.color.setHex(dark ? 0xaeaeb2 : 0x6e6e73);

      // ---- 1. 蓝牙 ----
      const eBt = env(ft, -1, 2.7); // 波纹和数据线只在第一段
      const ePk = 0.18 + 0.82 * eBt; // 数据点一直在流，后面几段淡一些
      head.localToWorld(podPos.set(0.46, 0, 0));
      btRings.forEach((m, i) => {
        const k = (ft * 0.9 + i / 3) % 1;
        m.position.copy(podPos);
        m.scale.setScalar(0.16 + k * 0.42);
        m.lookAt(camera.position);
        show(m, (1 - k) * 0.7 * eBt);
      });
      curve.v0.copy(podPos);
      curve.v1.copy(podPos).lerp(DECK, 0.5);
      curve.v1.y += 0.9;
      setLine(dataPath, curve.getPoints(39));
      show(dataPath, 0.55 * eBt);
      packets.forEach((m, i) => {
        const k = (ft * 0.55 + i / PACKETS) % 1;
        curve.getPoint(k, m.position);
        show(m, Math.sin(k * Math.PI) * ePk);
      });
      receiver.scale.setScalar(1 + ((ft * 1.8) % 1) * 1.4);
      show(receiver, (1 - ((ft * 1.8) % 1)) * 0.8 * eBt);

      // ---- 2. 指向 ----
      const ePoint = env(ft, 2.6, 5.9);
      display.getWorldPosition(screenCenter);
      corners.forEach((c, i) => {
        const appear = ease(clamp01((ft - 2.75 - i * 0.16) / 0.3)); // 校准的五个点一个一个连上
        v.copy(c);
        display.localToWorld(v);
        setLine(cornerRays[i], [center, v]);
        show(cornerRays[i], (i === 4 ? 0.95 : 0.7) * appear * ePoint);
        show(cornerDots[i], appear * ePoint);
      });
      // 水平角：在头的高度、水平面上，从正前方转到现在的朝向
      const R1 = 0.8;
      const yawPts = [];
      for (let i = 0; i <= ARC; i++) {
        const s = (pose.yaw * i) / ARC;
        yawPts.push(new THREE.Vector3(center.x + Math.sin(s) * R1, center.y - 0.02, center.z - Math.cos(s) * R1));
      }
      setLine(yawArc, yawPts);
      setFan(yawFan, v.set(center.x, center.y - 0.02, center.z), yawPts);
      const big = (a, full) => clamp01(Math.abs(a) / full);
      show(yawArc, ePoint * big(pose.yaw, 0.05));
      show(yawFan, 0.22 * ePoint * big(pose.yaw, 0.05));
      // 垂直角：在朝向所在的竖直面里，从水平转到现在的仰角
      const R2 = 0.62;
      const hx = Math.sin(pose.yaw);
      const hz = -Math.cos(pose.yaw);
      const pitchPts = [];
      for (let i = 0; i <= ARC; i++) {
        const s = (pose.pitch * i) / ARC;
        pitchPts.push(new THREE.Vector3(center.x + hx * Math.cos(s) * R2, center.y + Math.sin(s) * R2, center.z + hz * Math.cos(s) * R2));
      }
      setLine(pitchArc, pitchPts);
      setFan(pitchFan, center, pitchPts);
      show(pitchArc, ePoint * big(pose.pitch, 0.04));
      show(pitchFan, 0.22 * ePoint * big(pose.pitch, 0.04));
      // 屏幕十字线：光标的横、纵坐标
      const eCross = Math.max(ePoint, env(ft, 5.6, 7.7) * 0.6);
      setLine(crossV, [v.set(local.x, -SH / 2, 0.007), v2.set(local.x, SH / 2, 0.007)]);
      setLine(crossH, [v.set(-SW / 2, local.y, 0.007), v2.set(SW / 2, local.y, 0.007)]);
      show(crossV, 0.8 * eCross);
      show(crossH, 0.8 * eCross);

      // ---- 3. 点击 ----
      const eClick = env(ft, 5.55, 7.75);
      if (ft < 6.15 || buttonAt == null) buttonAt = { x: local.x, y: local.y };
      button.position.set(buttonAt.x + 0.02, buttonAt.y - 0.01, 0.0055);
      const pressed = ft > CLICK_T - 0.02 && ft < CLICK_T + 0.45;
      button.material.color.setHex(pressed ? BLUE : 0xffffff);
      show(button, (pressed ? 1 : 0.92) * eClick);
      // 歪头角：在头的竖直面里，从“头顶朝上”转到歪过去的方向（向左歪，头顶往左）
      const roll = pose.tilt * 0.35;
      const R3 = 0.58;
      const rollPts = [];
      for (let i = 0; i <= ARC; i++) {
        const s = (roll * i) / ARC;
        rollPts.push(new THREE.Vector3(center.x - Math.sin(s) * R3, center.y + Math.cos(s) * R3, center.z + 0.02));
      }
      setLine(rollArc, rollPts);
      setFan(rollFan, center, rollPts);
      setLine(rollRef, [center, v.set(center.x, center.y + R3 * 1.25, center.z + 0.02)]);
      show(rollArc, eClick * big(roll, 0.03));
      show(rollFan, 0.28 * eClick * big(roll, 0.03));
      show(rollRef, 0.6 * eClick);

      // 波纹：点击一下，语音双击两下
      const hits = [CLICK_T, DOUBLE[0], DOUBLE[1]];
      ripples.forEach((m, i) => {
        const k = (ft - hits[i]) / 0.6;
        const on = k >= 0 && k < 1;
        if (on && (i === 0 ? buttonAt : true)) m.position.set(i === 0 ? buttonAt.x : local.x, i === 0 ? buttonAt.y : local.y, 0.0065);
        m.scale.setScalar(0.6 + k * 2.4);
        show(m, on ? 1 - k : 0);
      });

      // ---- 4. 语音 ----
      // 嘴在头前方偏下；声波沿着嘴 → 屏幕中心飞过去，越飞越大、越淡
      mouth.set(center.x + hx * 0.3, center.y - 0.22, center.z + hz * 0.3);
      waves.forEach((m, i) => {
        const k = ((ft - VOICE[0]) / (VOICE[1] - VOICE[0])) * 1.25 - i * 0.18;
        const on = k > 0 && k < 1;
        m.position.copy(mouth).lerp(screenCenter, k * 0.82);
        m.scale.setScalar(0.1 + k * 0.32);
        m.lookAt(screenCenter);
        show(m, on ? Math.min(1, Math.sin(k * Math.PI) * 1.4) : 0);
      });

      // 给页面用：现在是第几段（配说明文字），以及说话气泡该挂在哪
      const phase = ft < 2.6 ? 0 : ft < 5.6 ? 1 : ft < 7.6 ? 2 : 3;
      return { phase, mouth, talking: ft > VOICE[0] - 0.25 && ft < DOUBLE[1] + 0.5 };
    },
  };
}
