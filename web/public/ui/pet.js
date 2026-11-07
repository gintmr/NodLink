// NodBot：控制台 3D 场景里的 Q 版小机器人，全部程序建模，不下载模型文件。
//
// 造型：一颗圆润的白色头（亮面陶瓷），正面一块黑色玻璃面罩，面罩里是会眨的发光眼睛、腮红和一张小嘴；
// 头顶一根弹簧天线，顶端一颗渐变发光球；两侧耳罩带一圈灯环（AirPods 由场景挂在耳罩外侧）；
// 短脖子带一圈细灯；身体是上宽下尖的陀螺形，胸口一块小圆屏跳着心电一样的波形，腰上一圈贴着身体的渐变灯带，
// 背后一个小电池仓；两只圆手套悬浮在身体两侧（没有胳膊，像手办）；底部一个推进口，喷着淡淡的光。
// 画风：扁平卡通（“2D 的样子，3D 的体积”）。纯色块 + 三级明暗的卡通着色（MeshToonMaterial），
// 外轮廓一圈深紫描边（把模型沿法线往外推一点、只画背面），面罩里的眼睛、高光都是扁平的贴纸，
// 不用金属反光、清漆和环境反射。配色：奶白、淡紫阴影、深紫描边，加粉 → 紫 → 青的点缀。
//
// 动作（全部按时间算，不用骨骼动画）：
//   常驻：呼吸（身体微微起伏、缩放）、眨眼（随机间隔，偶尔连眨两下）、天线跟着头的转动滞后摆动、
//        小手轻轻漂浮、推进口的光闪烁、胸口波形滚动、眼睛跟着转头方向稍微偏一点
//   一次性：Yes 点头 + 笑眼、No 摇头 + 叉叉眼、Wave 挥手 + 笑、Cheer 双手举起蹦一下 + 星星眼、
//          Think 歪头 + 眼睛往上看、Love 爱心眼
// 头的姿态由场景按 AirPods 数据设置（head 的四元数），这里的一次性动作叠加在上面。
//
// 坐标：头的中心在原点，正前方是 -Z，头宽约 0.5（和场景里其它角色一致，HEAD_SIZE）。

import * as THREE from 'three';

const R = 0.25; // 头半径

const C = {
  shell: 0xfdfcff,
  shellDark: 0xe6e0fa,
  gunmetal: 0x5a5280,
  visor: 0x26214a,
  outline: 0x2b2547,
  eye: 0x8af0ff,
  pink: 0xff7cba,
  violet: 0xb18cff,
  cyan: 0x66d6ff,
  blush: 0xff8fc0,
};

const ease = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

/** 三级明暗的卡通着色：亮面、过渡、暗面，分界是硬的 */
let toonRamp = null;
function toon(color) {
  if (!toonRamp) {
    toonRamp = new THREE.DataTexture(new Uint8Array([190, 190, 190, 255, 228, 228, 228, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
    toonRamp.minFilter = THREE.NearestFilter;
    toonRamp.magFilter = THREE.NearestFilter;
    toonRamp.generateMipmaps = false;
    toonRamp.needsUpdate = true;
  }
  // 自发光垫一层底色：暗面也是浅色（带一点淡紫），光照只负责分出明暗的色块，不会发灰
  const base = new THREE.Color(color).lerp(new THREE.Color(0xb9a8ff), 0.18);
  return new THREE.MeshToonMaterial({ color, gradientMap: toonRamp, emissive: base, emissiveIntensity: 0.62, toneMapped: false });
}

/** 描边：沿法线往外推 thickness，只画背面，纯色 */
const OUTLINE_VERT = `uniform float thickness; void main() { vec3 p = position + normalize(normal) * thickness; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`;
const OUTLINE_FRAG = `uniform vec3 color; void main() { gl_FragColor = vec4(color, 1.0); }`;
function outlined(mesh, thickness = 0.006) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(C.outline) }, thickness: { value: thickness } },
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: THREE.BackSide,
  });
  const o = new THREE.Mesh(mesh.geometry, mat);
  o.userData.outline = true;
  o.raycast = () => {};
  mesh.add(o);
  return mesh;
}

function glowMat(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false });
}

/** 一条沿 x 方向从粉到紫到青的渐变贴图 */
function gradientTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 4;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, '#ff7cba');
  grad.addColorStop(0.5, '#b18cff');
  grad.addColorStop(1, '#66d6ff');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 胸口小屏：一条滚动的心电波形，画在画布上，每帧换偏移 */
function pulseTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#07070d';
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#8af0ff';
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.shadowColor = '#8af0ff';
  g.shadowBlur = 12;
  g.beginPath();
  const y0 = 70;
  g.moveTo(0, y0);
  for (const [x, y] of [[60, y0], [78, y0 - 8], [92, y0], [104, y0], [116, y0 - 50], [130, y0 + 30], [142, y0], [170, y0], [184, y0 - 10], [200, y0], [256, y0]]) g.lineTo(x, y);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** 一段圆弧做成的粗线（笑眼、嘴巴）：TorusGeometry 只取一段 */
function arc(radius, tube, angle, mat) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 32, angle), mat);
  return m;
}

/** 平面星星（星星眼） */
function starShape(r1, r2) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? r2 : r1;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i) s.lineTo(x, y);
    else s.moveTo(x, y);
  }
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

/** 平面爱心（爱心眼） */
function heartShape(k) {
  const s = new THREE.Shape();
  s.moveTo(0, -0.9 * k);
  s.bezierCurveTo(-1.2 * k, -0.1 * k, -0.9 * k, 0.9 * k, 0, 0.35 * k);
  s.bezierCurveTo(0.9 * k, 0.9 * k, 1.2 * k, -0.1 * k, 0, -0.9 * k);
  return new THREE.ShapeGeometry(s, 16);
}

export class NodBot {
  constructor() {
    const grad = gradientTexture();
    this.mats = {
      shell: toon(C.shell),
      shellDark: toon(C.shellDark),
      gunmetal: toon(C.gunmetal),
      visor: new THREE.MeshBasicMaterial({ color: C.visor }),
      eye: glowMat(C.eye),
      blush: glowMat(C.blush, 0.55),
      grad: new THREE.MeshBasicMaterial({ map: grad, toneMapped: false }),
      gradSoft: new THREE.MeshBasicMaterial({ map: grad, toneMapped: false, transparent: true, opacity: 0.85 }),
      jet: new THREE.MeshBasicMaterial({ color: C.cyan, toneMapped: false, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    };

    this.root = new THREE.Group();
    this.root.name = 'NodBot';
    this.body = new THREE.Group(); // 身体（呼吸、蹦跳）
    this.root.add(this.body);
    this.head = new THREE.Group(); // 头：场景按 AirPods 数据转它
    this.head.name = 'head';
    this.root.add(this.head);
    this.headInner = new THREE.Group(); // 一次性动作叠加在这一层上
    this.head.add(this.headInner);

    this.buildHead();
    this.buildBody();
    this.buildHands();

    this.outlineMats = [];
    this.root.traverse((o) => {
      if (o.userData.outline) this.outlineMats.push(o.material);
      if (o.isMesh) {
        o.castShadow = !o.userData.outline && !o.material.transparent && o.material.type !== 'MeshBasicMaterial';
        o.receiveShadow = true;
      }
    });

    // 动作状态
    this.t = 0;
    this.nextBlink = 1.5;
    this.blinkT = -1;
    this.doubleBlink = false;
    this.action = null; // { name, t0, dur }
    this.lastHeadQ = new THREE.Quaternion();
    this.antennaVel = new THREE.Vector2();
    this.antennaOff = new THREE.Vector2();
  }

  // ---------- 头 ----------
  buildHead() {
    const h = this.headInner;
    const M = this.mats;
    // 头壳：略扁的球
    const shell = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 48), M.shell);
    shell.scale.set(1.04, 0.94, 0.98);
    shell.name = 'head_shell';
    outlined(shell, 0.008);
    h.add(shell);
    this.headMesh = shell;

    // 面罩：头壳前方的一片球面，比头壳略大一点，黑色玻璃
    // 面罩的轮廓是参数空间里的圆角矩形：u 沿水平角、v 沿竖直角。透明贴图挖出圆角，包边沿同一条轮廓走
    const PHI0 = Math.PI * 0.5 - 0.98;
    const PHIL = 1.96;
    const TH0 = Math.PI * 0.5 - 0.62;
    const THL = 1.2;
    const CR = 0.3; // 圆角占短边的比例
    const roundRect = (n) => {
      // 返回 (u, v) ∈ [0,1]² 上一圈圆角矩形的点；四个角的半径换算成 u、v 各自的比例
      const ru = CR * Math.min(1, THL / PHIL);
      const rv = CR * Math.min(1, PHIL / THL);
      const out = [];
      const corners = [[1 - ru, 1 - rv, 0], [ru, 1 - rv, Math.PI / 2], [ru, rv, Math.PI], [1 - ru, rv, Math.PI * 1.5]];
      for (const [cu, cv, a0] of corners) {
        for (let i = 0; i <= n; i++) {
          const a = a0 + (i / n) * (Math.PI / 2);
          out.push([cu + Math.cos(a) * ru, cv + Math.sin(a) * rv]);
        }
      }
      return out;
    };
    const mask = document.createElement('canvas');
    mask.width = 256;
    mask.height = 256;
    const mg = mask.getContext('2d');
    mg.fillStyle = '#000';
    mg.fillRect(0, 0, 256, 256);
    mg.fillStyle = '#fff';
    mg.beginPath();
    roundRect(12).forEach(([u, v], i) => (i ? mg.lineTo(u * 256, (1 - v) * 256) : mg.moveTo(u * 256, (1 - v) * 256)));
    mg.fill();
    const visorMat = M.visor.clone(); // 扁平的深紫，没有反光；高光是一块贴纸
    visorMat.alphaMap = new THREE.CanvasTexture(mask);
    visorMat.alphaTest = 0.5;
    visorMat.transparent = false;
    const visorGeo = new THREE.SphereGeometry(R * 1.012, 96, 48, PHI0, PHIL, TH0, THL);
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.scale.copy(shell.scale);
    visor.rotation.y = Math.PI; // 球面参数里 phi 从 +X 开始，转过来朝 -Z
    h.add(visor);
    // 面罩边上一圈细细的枪灰包边：沿面罩边缘采样一圈，做成管子
    // SphereGeometry 的 uv：u = (phi − phiStart) / phiLength，v = 1 − (theta − thetaStart) / thetaLength
    const pt = (u, v) => {
      const phi = PHI0 + u * PHIL;
      const th = TH0 + (1 - v) * THL;
      return new THREE.Vector3(-Math.cos(phi) * Math.sin(th), Math.cos(th), Math.sin(phi) * Math.sin(th)).multiplyScalar(R * 1.016).multiply(shell.scale).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    };
    const edge = roundRect(10).map(([u, v]) => pt(u, v));
    const rimTube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge, true, 'catmullrom', 0.2), 200, 0.0055, 8, true), new THREE.MeshBasicMaterial({ color: C.outline }));
    h.add(rimTube);

    // 脸：眼睛、腮红、嘴，都贴在面罩表面前一点点
    this.face = new THREE.Group();
    h.add(this.face);
    const onVisor = (obj, x, y, z = 0.004) => {
      // 把平面元素摆到面罩球面上：沿法线贴合
      const p = new THREE.Vector3(x, y, 0);
      const zz = -Math.sqrt(Math.max((R * 1.02) ** 2 - (x / shell.scale.x) ** 2 - (y / shell.scale.y) ** 2, 0)) * shell.scale.z - z;
      obj.position.set(p.x, p.y, zz);
      obj.lookAt(obj.position.clone().multiplyScalar(2)); // 平面的正面朝外
      this.face.add(obj);
      return obj;
    };
    // 面罩上的高光：左上角一条斜的白色圆角条 + 一个小圆点，像贴纸
    const gloss = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.07, 6, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, toneMapped: false }));
    gloss.scale.z = 0.1;
    onVisor(gloss, -0.165, 0.06, 0.003).rotateZ(-0.75);
    const glossDot = new THREE.Mesh(new THREE.CircleGeometry(0.01, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, toneMapped: false }));
    onVisor(glossDot, -0.19, 0.012, 0.003);
    // 普通眼：竖着的圆角胶囊
    this.eyes = [-1, 1].map((s) => {
      const g = new THREE.Group();
      const e = new THREE.Mesh(new THREE.CapsuleGeometry(0.024, 0.034, 8, 16), M.eye);
      e.scale.z = 0.15;
      const shine = new THREE.Mesh(new THREE.CircleGeometry(0.008, 16), glowMat(0xffffff));
      shine.position.set(0.008, 0.02, 0.004);
      g.add(e, shine);
      // 眼睛后面一团淡淡的光
      const halo = new THREE.Mesh(new THREE.CircleGeometry(0.07, 32), new THREE.MeshBasicMaterial({ color: C.eye, transparent: true, opacity: 0.12, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.z = -0.002;
      g.add(halo);
      onVisor(g, s * 0.075, 0.018);
      g.userData.baseX = g.position.x;
      g.userData.baseY = g.position.y;
      return g;
    });
    // 表情眼：笑眼（^ ^）、叉叉、星星、爱心，平时藏着
    const expr = (make) => [-1, 1].map((s) => {
      const g = make(s);
      onVisor(g, s * 0.075, 0.018, 0.006);
      g.visible = false;
      return g;
    });
    this.happyEyes = expr(() => {
      const g = new THREE.Group();
      const a = arc(0.026, 0.0075, Math.PI, M.eye);
      a.position.y = -0.008;
      g.add(a);
      return g;
    });
    this.xEyes = expr(() => {
      const g = new THREE.Group();
      for (const r of [Math.PI / 4, -Math.PI / 4]) {
        const bar = new THREE.Mesh(new THREE.CapsuleGeometry(0.007, 0.05, 6, 12), glowMat(C.pink));
        bar.scale.z = 0.3;
        bar.rotation.z = r;
        g.add(bar);
      }
      return g;
    });
    this.starEyes = expr(() => new THREE.Mesh(starShape(0.034, 0.015), glowMat(0xffe27a)));
    this.loveEyes = expr(() => new THREE.Mesh(heartShape(0.03), glowMat(C.pink)));
    this.lookUpEyes = expr(() => {
      const e = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.016, 8, 16), M.eye);
      e.scale.z = 0.15;
      e.position.y = 0.022;
      return e;
    });
    // 腮红
    this.blush = [-1, 1].map((s) => {
      const b = new THREE.Mesh(new THREE.CircleGeometry(0.022, 24), M.blush);
      b.scale.y = 0.55;
      return onVisor(b, s * 0.112, -0.03);
    });
    // 嘴：一道小弧，说话或开心时张开
    this.mouth = new THREE.Group();
    const smile = arc(0.016, 0.004, Math.PI, M.eye);
    smile.rotation.z = Math.PI;
    this.mouthSmile = smile;
    const open = new THREE.Mesh(new THREE.CircleGeometry(0.016, 24, Math.PI, Math.PI), M.eye);
    open.visible = false;
    this.mouthOpen = open;
    this.mouth.add(smile, open);
    onVisor(this.mouth, 0, -0.045);

    // 耳罩：两侧扁圆柱 + 一圈渐变灯环 + 中间的小凹点
    this.ears = [-1, 1].map((s) => {
      const g = new THREE.Group();
      const cup = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.068, 0.04, 48), M.shellDark), 0.006);
      cup.rotation.z = Math.PI / 2;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.006, 10, 64), M.grad);
      ring.rotation.y = Math.PI / 2;
      ring.position.x = s * 0.021;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.042, 0.012, 40), M.gunmetal);
      cap.rotation.z = Math.PI / 2;
      cap.position.x = s * 0.022;
      g.add(cup, ring, cap);
      g.position.set(s * R * 1.0, -0.005, 0.012);
      h.add(g);
      return g;
    });

    // 天线：底座 + 一节弹簧 + 一根细杆 + 发光球，整根绕底座摆动
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.02, 32), M.gunmetal);
    base.position.set(0, R * 0.94, 0.01);
    h.add(base);
    this.antenna = new THREE.Group();
    this.antenna.position.set(0, R * 0.94 + 0.01, 0.01);
    h.add(this.antenna);
    const coil = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 41 }, (_, i) => new THREE.Vector3(Math.cos(i * 0.9) * 0.009, i * 0.0011, Math.sin(i * 0.9) * 0.009))), 160, 0.0022, 6, false), M.gunmetal);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.07, 12), M.shellDark);
    rod.position.y = 0.045 + 0.035;
    const tip = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.022, 32, 24), M.gradSoft), 0.005);
    tip.position.y = 0.125;
    tip.rotation.z = Math.PI / 2;
    const tipGlow = new THREE.Mesh(new THREE.SphereGeometry(0.04, 24, 16), new THREE.MeshBasicMaterial({ color: C.violet, transparent: true, opacity: 0.18, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    tipGlow.position.y = 0.125;
    this.antennaTip = tip;
    this.antennaGlow = tipGlow;
    this.antenna.add(coil, rod, tip, tipGlow);

  }

  // ---------- 身体 ----------
  buildBody() {
    const M = this.mats;
    const b = this.body;
    // 脖子：一节枪灰的环 + 一圈细灯
    const neck = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.062, 0.05, 40), M.gunmetal), 0.005);
    neck.position.y = -R * 0.94 - 0.012;
    b.add(neck);
    const neckLight = new THREE.Mesh(new THREE.TorusGeometry(0.057, 0.004, 8, 64), M.grad);
    neckLight.rotation.x = Math.PI / 2;
    neckLight.position.y = neck.position.y - 0.012;
    b.add(neckLight);

    // 躯干：上宽下尖的水滴，车床旋转出来
    const top = -R * 0.94 - 0.045;
    const H = 0.36;
    const prof = [];
    for (let i = 0; i <= 40; i++) {
      const k = i / 40; // 0 顶 → 1 底
      const shoulder = Math.sin(Math.min(k / 0.18, 1) * Math.PI * 0.5); // 肩部圆过去
      const taper = 1 - ease(clamp01((k - 0.25) / 0.75)) * 0.82; // 往下收尖
      const r = 0.155 * shoulder * taper + 0.012;
      prof.push(new THREE.Vector2(Math.max(r, 0.001), top - k * H));
    }
    prof.unshift(new THREE.Vector2(0.001, top + 0.004));
    prof.reverse(); // 车床的点要从下往上排，面才朝外
    const torso = outlined(new THREE.Mesh(new THREE.LatheGeometry(prof, 72), M.shell), 0.008);
    torso.name = 'torso';
    b.add(torso);
    this.torso = torso;
    // 腰上一圈渐变灯带：取躯干轮廓的一小段，往外放大一点点再车一圈，贴着表面走，侧面看不会凸出来
    const bandProf = [];
    for (let i = 0; i <= 6; i++) {
      const k = 0.4 + (i / 6) * 0.05;
      const r = 0.155 * (1 - ease(clamp01((k - 0.25) / 0.75)) * 0.82) + 0.012;
      bandProf.push(new THREE.Vector2(r * 1.012 + 0.0015, top - k * H));
    }
    bandProf.reverse();
    const band = new THREE.Mesh(new THREE.LatheGeometry(bandProf, 96), M.grad);
    b.add(band);
    // 胸口小屏：一块微凸的圆角屏，跳动的波形
    this.pulseTex = pulseTexture();
    const screenGeo = new THREE.CircleGeometry(0.04, 40);
    const screen = new THREE.Mesh(screenGeo, new THREE.MeshBasicMaterial({ map: this.pulseTex, toneMapped: false }));
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.041, 0.005, 10, 48), new THREE.MeshBasicMaterial({ color: C.outline }));
    const chest = new THREE.Group();
    chest.add(screen, bezel);
    chest.position.set(0, top - H * 0.15, -0.169); // 贴在躯干表面外面一点；屏幕小一些，侧面看不会伸出轮廓
    chest.rotation.x = 0.3; // 躯干往下收，屏幕跟着表面往下倾
    chest.rotation.y = Math.PI;
    b.add(chest);
    // 背后一个小背包（电池仓），带一道灯
    const pack = outlined(new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.05, 8, 24), M.shellDark), 0.006);
    pack.position.set(0, top - H * 0.2, 0.148);
    pack.scale.set(1.1, 1, 0.55);
    b.add(pack);
    // 底部推进口 + 一道向下的光
    const bottom = top - H;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.02, 0.028, 32, 1, true), M.gunmetal);
    nozzle.position.y = bottom + 0.004;
    b.add(nozzle);
    const jet = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.14, 32, 1, true), M.jet);
    jet.rotation.x = Math.PI;
    jet.position.y = bottom - 0.07;
    this.jet = jet;
    b.add(jet);
    this.bottomY = bottom - 0.14;
  }

  // ---------- 手 ----------
  buildHands() {
    const M = this.mats;
    this.hands = [-1, 1].map((s) => {
      const pivot = new THREE.Group(); // 肩膀位置（看不见），手绕它转
      pivot.position.set(s * 0.235, -R - 0.12, -0.01); // 躯干这里半径约 0.17，手放在外面留一点缝
      const hand = new THREE.Group();
      const palm = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.042, 32, 24), M.shellDark), 0.006); // 比身体深一档的淡紫，小圆球才看得出是实心的
      palm.scale.set(0.85, 1.05, 0.8);
      hand.add(palm);
      hand.position.y = -0.1;
      pivot.add(hand);
      this.body.add(pivot);
      return { pivot, hand, s };
    });
  }

  /** 深色模式：自发光的底色压低一点，不然在黑背景里白得刺眼 */
  setNight(night) {
    this.root.traverse((o) => {
      if (o.isMesh && o.material.isMeshToonMaterial) o.material.emissiveIntensity = night ? 0.4 : 0.62;
    });
    // 描边：白天深紫；夜里深色描边贴着黑背景看不见，换成淡紫，像一圈柔和的轮廓光
    this.outlineBase = night ? 0x8a80cc : C.outline;
    this.setAlert(null);
  }

  /** 出问题时整圈描边变成告警色（琥珀 / 红），选中时变金色；g = { color, k } 或 null */
  setAlert(g) {
    const c = g ? g.color : this.outlineBase ?? C.outline;
    for (const m of this.outlineMats) m.uniforms.color.value.setHex(c);
  }

  /** 头的大小，给场景挂耳机用：耳罩外沿的半宽、头高 */
  get earHalf() {
    return R + 0.058; // 耳罩外沿约在 R + 0.028，耳机（半径约 0.04）的中心再往外放 0.03，贴着耳罩不嵌进去
  }

  get headHeight() {
    return R * 2 * 0.94;
  }

  /** 一次性动作：Yes 点头、No 摇头、Wave 挥手、Cheer 欢呼、Think 思考、Love 爱心 */
  play(name) {
    const durs = { Yes: 1.2, No: 1.3, Wave: 1.8, Cheer: 1.5, Think: 2.2, Love: 2 };
    if (!durs[name]) return false;
    this.action = { name, t0: this.t, dur: durs[name] };
    return true;
  }

  get touchesHead() {
    return this.action && ['Yes', 'No', 'Think'].includes(this.action.name);
  }

  /**
   * 每帧调用：dt 秒；pose 是头部姿态（度，h 左右、v 上下），用来让眼睛往那边偏一点。
   * 头的四元数已经由场景设好；这里在 headInner 上叠加动作。
   */
  update(dt, pose) {
    this.t += dt;
    const t = this.t;
    const a = this.action;
    const at = a ? (t - a.t0) / a.dur : 0;
    if (a && at >= 1) this.action = null;
    const act = this.action ? this.action.name : null;
    const env = act ? Math.sin(Math.PI * clamp01(at)) : 0; // 动作的起落

    // ---- 呼吸 ----
    const br = Math.sin(t * 2.1);
    this.body.position.y = br * 0.004;
    this.torso.scale.set(1 + br * 0.012, 1 - br * 0.008, 1 + br * 0.012);

    // ---- 叠加在头上的动作 ----
    const hi = this.headInner;
    hi.rotation.set(0, 0, 0);
    hi.position.set(0, 0, 0);
    if (act === 'Yes') hi.rotation.x = -Math.sin(at * Math.PI * 4) * 0.28 * env;
    if (act === 'No') hi.rotation.y = Math.sin(at * Math.PI * 5) * 0.35 * env;
    if (act === 'Think') {
      hi.rotation.z = 0.22 * ease(clamp01(at * 4)) * (1 - ease(clamp01((at - 0.8) * 5)));
      hi.rotation.x = 0.1 * env;
    }
    if (act === 'Cheer') {
      const hop = Math.max(0, Math.sin(at * Math.PI * 2)) * 0.05;
      this.root.position.y = hop;
      hi.rotation.x = 0.12 * env;
    } else {
      this.root.position.y = 0;
    }

    // ---- 天线：跟着头的转动滞后摆，像弹簧 ----
    const q = this.head.getWorldQuaternion(new THREE.Quaternion()).multiply(hi.quaternion);
    const dq = q.clone().multiply(this.lastHeadQ.clone().invert());
    this.lastHeadQ.copy(q);
    const e = new THREE.Euler().setFromQuaternion(dq, 'YXZ');
    const kick = dt > 0 ? 1 / Math.max(dt, 1 / 120) : 0;
    this.antennaVel.x += (-e.z * kick * 0.9 - this.antennaOff.x * 160) * dt;
    this.antennaVel.y += (e.x * kick * 0.9 - this.antennaOff.y * 160) * dt;
    this.antennaVel.multiplyScalar(Math.exp(-dt * 7));
    this.antennaOff.addScaledVector(this.antennaVel, dt);
    this.antennaOff.clampScalar(-0.6, 0.6);
    this.antenna.rotation.z = this.antennaOff.x + Math.sin(t * 1.7) * 0.04;
    this.antenna.rotation.x = this.antennaOff.y + Math.sin(t * 1.3 + 1) * 0.03;
    const tipPulse = 0.6 + 0.4 * Math.sin(t * 3);
    this.antennaGlow.material.opacity = 0.12 + 0.14 * tipPulse + (act ? 0.15 * env : 0);
    this.antennaGlow.scale.setScalar(0.9 + 0.2 * tipPulse);

    // ---- 眨眼 ----
    if (this.blinkT < 0 && t > this.nextBlink) {
      this.blinkT = 0;
      this.doubleBlink = Math.random() < 0.25;
    }
    let lid = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const span = this.doubleBlink ? 0.36 : 0.16;
      const k = this.blinkT / 0.16;
      lid = 1 - Math.sin(Math.PI * clamp01(k % 1)) * 0.92;
      if (this.blinkT > span) {
        this.blinkT = -1;
        this.nextBlink = t + 2 + Math.random() * 3.5;
      }
    }

    // ---- 表情 ----
    const show = (arr, v) => arr.forEach((g) => { g.visible = v; });
    const mode = act === 'Yes' || act === 'Wave' ? 'happy' : act === 'No' ? 'x' : act === 'Cheer' ? 'star' : act === 'Love' ? 'love' : act === 'Think' ? 'up' : 'normal';
    show(this.eyes, mode === 'normal');
    show(this.happyEyes, mode === 'happy');
    show(this.xEyes, mode === 'x');
    show(this.starEyes, mode === 'star');
    show(this.loveEyes, mode === 'love');
    show(this.lookUpEyes, mode === 'up');
    // 眼睛往转头的方向偏一点（看着要指的地方），眨眼时压扁
    const lookX = pose ? Math.max(-1, Math.min(1, -pose.h / 30)) * 0.012 : 0;
    const lookY = pose ? Math.max(-1, Math.min(1, pose.v / 20)) * 0.008 : 0;
    for (const g of this.eyes) {
      g.position.x = g.userData.baseX + lookX;
      g.position.y = g.userData.baseY + lookY;
      g.scale.y = lid;
    }
    const pop = 1 + 0.15 * Math.sin(t * 10) * (mode === 'star' || mode === 'love' ? 1 : 0);
    for (const g of [...this.starEyes, ...this.loveEyes]) g.scale.setScalar(pop);
    // 腮红：开心时更红
    const blushK = mode === 'happy' || mode === 'love' || mode === 'star' ? 0.9 : 0.45;
    for (const b of this.blush) b.material.opacity += (blushK - b.material.opacity) * Math.min(1, dt * 6);
    // 嘴：开心时张开
    const openMouth = mode === 'happy' || mode === 'star' || mode === 'love';
    this.mouthOpen.visible = openMouth;
    this.mouthSmile.visible = !openMouth && mode !== 'x';
    this.mouth.scale.setScalar(mode === 'x' ? 0.6 : 1);

    // ---- 手 ----
    for (const h of this.hands) {
      const s = h.s;
      const float = Math.sin(t * 2.1 + s) * 0.012;
      h.hand.position.y = -0.1 + float;
      let rz = s * 0.12 + Math.sin(t * 1.6 + s * 2) * 0.05;
      let rx = 0;
      if (act === 'Wave' && s === 1) rz = 2.0 * env + Math.sin(at * Math.PI * 7) * 0.35 * env + 0.12 * (1 - env); // 举起来左右摆
      if (act === 'Cheer') rz = s * (2.3 * env) + s * 0.12 * (1 - env);
      if (act === 'Yes') rx = -0.3 * env;
      if (act === 'Think' && s === 1) {
        rz = -1.2 * env;
        rx = -0.9 * env;
      }
      if (act === 'Love') rx = -0.6 * env;
      h.pivot.rotation.set(rx, 0, rz);
    }

    // ---- 推进口、胸口、灯 ----
    this.jet.material.opacity = 0.35 + 0.2 * Math.sin(t * 23) * Math.sin(t * 7) + (act === 'Cheer' ? 0.3 * env : 0);
    this.jet.scale.set(1, 0.85 + 0.25 * Math.abs(Math.sin(t * 13)), 1);
    this.pulseTex.offset.x = (t * 0.45) % 1;
  }
}
