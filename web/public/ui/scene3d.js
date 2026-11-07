// 3D 场景：整个界面的主角。一座“霓虹工作站”小岛：深色亮面的圆地台嵌着两圈霓虹，上面一张石墨台面、枪灰板腿的书桌，
// 显示器背后立着灯带拱门，背景里飘着淡淡发光的粒子和方块（ui/particles.js）。材质只有三种：石墨（家具外壳）、枪灰金属（结构件）、显示器的铝；
// 发光的地方都用拱门那条粉 → 紫 → 青的渐变，左粉右青。桌上只摆和这套系统有关的东西：键盘鼠标、AirPods 充电盒、手机、头戴耳机。
// 小机器人戴着 AirPods 站在桌前的展示台上，它的头就是用户的头：到显示器的距离和真实一致，指向线的落点才准。
// 浅色模式是白天，深色模式是夜晚（荧光和粒子更亮）。
// 所有数据都挂在部件上：耳机、头、指向线、屏幕上的光标、每块显示器都可以点；出问题的部件会亮。
//
// 尺寸按真实比例：U 个世界单位 = 1 米。头在原点，正前方是 -Z，显示器屏幕平面在 z = -DZ（约 52 厘米）。
// 屏幕坐标 p 换算到平面上：x = (p.x − front.x)·s，y = (front.y − p.y)·s，s = DZ / G，
// 和校准模型 x = front.x + G·tan(水平角) 一致，所以指向线的落点就是模型认为你指着的位置。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { drawPixelText, pixelTextWidth, screenTitle } from './pixel-font.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { PixelDesk } from './pixel-desk.js';
import { OneEuroFilter } from '../core/filter.js';
import { ParticleField } from './particles.js';
import { NodBot } from './pet.js';
import { demoClock } from './demo-clock.js';

const RAD = Math.PI / 180;
const U = 2.6;           // 1 米 = U 个世界单位（配件、机器人这些实物的尺寸按它算）
// 显示器离头 DZ。屏幕的大小按“像素 × DZ / 头到屏幕的距离”换算，所以 DZ 只是把屏幕和它的距离一起按比例放大：
// 从头看过去的角度不变，指向线照样落在光标上。原来是 3，场景只剩显示器和机器人后加大到 4.4，显示器在画面里大很多
const DZ = 4.4;
const HEAD_SIZE = 0.5;   // 机器人头部宽度：场景里只剩显示器、机器人和两样配件，机器人放大一些当主角
const TRAIL_MS = 2000;
const HDRI = 'models/room/white_home_studio_1k.hdr'; // 环境光

const COLOR = {
  ray: 0x2f8cff,
  target: 0xff4fa3,
  ink: 0x17171c,
  amber: 0xff9f1a,
  red: 0xff4d4d,
  gold: 0xd9a93a,
  pink: 0xff4fa3,
  cyan: 0x4fd8ff,
  grey: 0x8e8e93,
  x: 0xff5a4f,
  y: 0x2fd08f,
  z: 0x5b8cff,
};

/** 头控状态对应的光标颜色：识别歪头时金色，说话时青色，按住时粉色，让给键鼠时灰色 */
const CONTROL_COLOR = { gesture: COLOR.gold, voice: COLOR.cyan, drag: COLOR.pink, yield: COLOR.grey };

const VIEW = {
  // 桌子去掉后东西都悬在空中，镜头拉近、压低一点，机器人和屏幕占的画面更大
  // 只定观察方向和大致距离；最后由 frameHome() 把机器人和显示器整体居中、缩放到合适大小
  home: { pos: [3.3, 0.75, 3.9], target: [-0.35, -0.25, -2.1] },
  // 竖屏窗口（手机）：从更正面、更高的地方看，机器人在下、屏幕在上，不会挤到一边
  homeTall: { pos: [1.1, 1.9, 5.2], target: [-0.15, -0.3, -2.2] },
  front: { pos: [0.4, 0.5, 2.6], target: [0, -0.1, -DZ] },
  top: { pos: [0, 8, -1.4], target: [0, 0, -1.45] },
};

function canvasTexture(c) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const pixelText = drawPixelText;

/** 屏幕上显示的时间 HH:MM：不是真实时间（见 demo-clock.js）；每分钟重画 */
const nowClock = demoClock;

/** 显示器的桌面：像素风的黄昏城市，左上角一块像素窗口里是时钟，底下一排像素图标。
 * 画布只有 320×200，贴图放大时用最近邻采样，每个像素都清清楚楚 */
function wallpaper(screen, clock = nowClock()) {
  const main = screen.main;
  // 按屏幕自己的宽高比画：竖屏（手机比例）不再把横版的画面拉长，时钟、窗口都不变形。纵向的位置按 k 缩放
  const W = 320;
  const H = Math.round(Math.min(Math.max((W * screen.h) / Math.max(screen.w, 1), 140), 720));
  const k = H / 200;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const rnd = rng(main ? 11 : 23);
  // 分层的天空，层与层之间用棋盘格过渡
  const bands = ['#251a52', '#3a2a7a', '#5c3c9e', '#8f52b0', '#c868a8', '#f08aa6', '#ffb39a'];
  const bh = Math.round(17 * k);
  bands.forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(0, i * bh, W, bh);
    if (i) {
      g.fillStyle = bands[i - 1];
      for (let x = 0; x < W; x += 2) g.fillRect(x + ((i * bh) % 2), i * bh, 1, 1);
    }
  });
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 40; i++) g.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * 50 * k), 1, 1);
  // 月亮
  g.fillStyle = '#fff1c9';
  const my = Math.round(46 * k);
  for (let y = -9; y <= 9; y++) for (let x = -9; x <= 9; x++) if (x * x + y * y <= 81) g.fillRect(250 + x, my + y, 1, 1);
  g.fillStyle = '#f4d9a8';
  g.fillRect(246, my - 4, 3, 3);
  g.fillRect(253, my + 4, 2, 2);
  // 城市：三层楼，越近越暗，窗户是暖黄色的点
  [['#4a347f', 112, 26], ['#2f2260', 128, 22], ['#1b1440', 146, 16]].map(([col, b, hm]) => [col, Math.round(b * k), Math.round(hm * Math.min(k, 2))]).forEach(([col, base, hMax], li) => {
    let x = -2;
    while (x < W) {
      const w = 8 + Math.floor(rnd() * 14);
      const top = base - Math.floor(rnd() * hMax);
      g.fillStyle = col;
      g.fillRect(x, top, w, H - top);
      if (li > 0) {
        g.fillStyle = '#ffd98a';
        for (let yy = top + 3; yy < H - 30; yy += 4) for (let xx = x + 2; xx < x + w - 2; xx += 3) if (rnd() < 0.3) g.fillRect(xx, yy, 1, 2);
      }
      x += w + 1;
    }
  });
  // 像素窗口：标题栏 + 时钟
  const win = (x, y, w, h) => {
    g.fillStyle = 'rgba(255, 255, 255, 0.92)';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#b9a6ff';
    g.fillRect(x, y, w, 7);
    g.fillStyle = '#ffffff';
    g.fillRect(x + w - 6, y + 2, 3, 3);
    g.fillStyle = '#2b2150';
    g.fillRect(x - 1, y - 1, w + 2, 1);
    g.fillRect(x - 1, y + h, w + 2, 1);
    g.fillRect(x - 1, y, 1, h);
    g.fillRect(x + w, y, 1, h);
  };
  if (main) {
    win(18, 22, 108, 54);
    pixelText(g, clock, 26, 36, 3, '#2b2150');
    pixelText(g, 'NODLINK', 26, 64, 1, '#8f7dff');
    const cy = Math.round(82 * k); // 小卡片的上沿，跟着高度往下挪
    win(196, cy, 104, 40);
    // 一张像素小卡片：正在播放
    g.fillStyle = '#ff9fcb';
    g.fillRect(203, cy + 11, 22, 22);
    g.fillStyle = '#8f7dff';
    g.fillRect(209, cy + 17, 10, 10);
    g.fillStyle = '#2b2150';
    g.fillRect(232, cy + 14, 52, 3);
    g.fillStyle = '#9b93b8';
    g.fillRect(232, cy + 21, 36, 2);
    g.fillStyle = '#d9d2f2';
    g.fillRect(232, cy + 28, 60, 2);
    g.fillStyle = '#ff6fa8';
    g.fillRect(232, cy + 28, 34, 2);
  }
  // 菜单栏和程序坞
  g.fillStyle = 'rgba(255, 255, 255, 0.35)';
  g.fillRect(0, 0, W, 7);
  // 标题栏：编号牌 + 显示器名，主显示器标 MAIN
  const tag = main ? 'MAIN' : '';
  const title = screenTitle(screen, Math.floor((W - 44 - (tag ? pixelTextWidth(tag, 1) + 6 : 0)) / 6));
  const bw = pixelTextWidth(title.no, 1) + 4;
  g.fillStyle = main ? '#ff5fb4' : '#6a4bd1';
  g.fillRect(3, 0, bw, 7);
  pixelText(g, title.no, 5, 0, 1, '#ffffff');
  if (title.name) pixelText(g, title.name, 3 + bw + 3, 0, 1, '#ffffff');
  if (tag) pixelText(g, tag, W - 36 - pixelTextWidth(tag, 1), 0, 1, '#ffe066');
  const icons = ['#ff9fcb', '#b9a6ff', '#8fe7d0', '#ffd28a', '#9fd4ff', '#ffffff', '#ffb3a8'];
  const dw = icons.length * 18 + 6;
  const dx = Math.floor((W - dw) / 2);
  g.fillStyle = 'rgba(255, 255, 255, 0.4)';
  g.fillRect(dx, H - 26, dw, 22);
  icons.forEach((col, i) => {
    const x = dx + 5 + i * 18;
    g.fillStyle = '#2b2150';
    g.fillRect(x - 1, H - 22, 16, 16);
    g.fillStyle = col;
    g.fillRect(x, H - 21, 14, 14);
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.fillRect(x + 4, H - 17, 6, 6);
  });
  const tex = canvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

/** 开放空间的背景：淡彩渐变上几团柔和的光。画在 3D 里而不是透明画布下面，光晕的叠加混合才正确 */
function backdropTexture(night) {
  return paintTexture(640, 400, (g, w, h) => {
    const base = g.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, night ? '#050506' : '#f5f5f7');
    base.addColorStop(1, night ? '#101013' : '#e6e6eb');
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    const blobs = night
      ? [[0.5, 1.05, 0.6, 'rgba(60, 120, 255, 0.16)'], [0.5, 0.35, 0.5, 'rgba(255, 255, 255, 0.04)']]
      : [[0.5, 0.3, 0.6, 'rgba(255, 255, 255, 0.9)'], [0.5, 1.05, 0.6, 'rgba(120, 160, 255, 0.12)']];
    for (const [x, y, r, col] of blobs) {
      const grad = g.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * w);
      grad.addColorStop(0, col);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }
  });
}

/** 地上的软影子：中间深、边缘透明的一团黑 */
let shadowTex = null;
function SHADOW_TEX() {
  shadowTex ??= paintTexture(128, 128, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.85)');
    grad.addColorStop(0.45, 'rgba(0,0,0,0.4)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });
  return shadowTex;
}

/** 加色混合的光晕片：放在发光物体后面，代替昂贵的辉光后期 */
function glowSprite(color, size, opacity) {
  const mat = new THREE.SpriteMaterial({ map: GLOW_TEX(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.setScalar(size);
  sp.userData.decor = true;
  return sp;
}
let glowTex = null;
function GLOW_TEX() {
  glowTex ??= paintTexture(128, 128, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.3)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });
  return glowTex;
}

/** 灯带的颜色：沿 t ∈ [0, 1] 从粉到紫到天蓝。其余都是中性色，只留拱门和机器人脚下的光环这一点赛博朋克的颜色 */
const NEON = [new THREE.Color('#ff7cba'), new THREE.Color('#b18cff'), new THREE.Color('#66d6ff')];
function neonColor(t, out) {
  const k = Math.min(Math.max(t, 0), 1) * 2;
  return k < 1 ? out.copy(NEON[0]).lerp(NEON[1], k) : out.copy(NEON[1]).lerp(NEON[2], k - 1);
}

/** 圆角矩形的轮廓点（中心在原点）。open：从左下角往上走、到右下角为止，底边不闭合 */
function roundRect2D(w, h, r, open) {
  const L = -w / 2;
  const R = w / 2;
  const B = -h / 2;
  const T = h / 2;
  const pts = [];
  const arc = (cx, cy, a0, a1) => {
    for (let k = 0; k <= 6; k++) {
      const a = a0 + ((a1 - a0) * k) / 6;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  if (open) {
    pts.push([L, B]);
    arc(L + r, T - r, Math.PI, Math.PI / 2);
    arc(R - r, T - r, Math.PI / 2, 0);
    pts.push([R, B]);
  } else {
    arc(L + r, T - r, Math.PI / 2, Math.PI);
    arc(L + r, B + r, Math.PI, Math.PI * 1.5);
    arc(R - r, B + r, Math.PI * 1.5, Math.PI * 2);
    arc(R - r, T - r, 0, Math.PI / 2);
  }
  return pts;
}

/** 灯带：一根沿路径走的发光软管，颜色沿 x 渐变。range = [x0, x1]：按这个范围取色（几根灯条连成一条渐变），默认用自己的范围 */
function neonTube(points, radius, closed, range, segments) {
  const curve = points.length === 2 && !closed
    ? new THREE.LineCurve3(points[0], points[1])
    : new THREE.CatmullRomCurve3(points, closed, 'centripetal', 0.1);
  const geo = new THREE.TubeGeometry(curve, segments ?? Math.max(points.length * 8, 8), radius, 8, closed);
  const xs = points.map((p) => p.x);
  const x0 = range ? range[0] : Math.min(...xs);
  const x1 = range ? range[1] : Math.max(...xs);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) neonColor((pos.getX(i) - x0) / (x1 - x0 || 1), c).toArray(colors, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  mesh.userData.tintable = true;
  return mesh;
}

/** 灯带打在墙上的光晕：同一条路径在画布上模糊着画几遍，叠加到墙面上 */
function neonHalo(pts2d, w, h, pad) {
  const W = 512;
  const H = Math.round((W * (h + pad * 2)) / (w + pad * 2));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const sx = W / (w + pad * 2);
  const grad = g.createLinearGradient(0, 0, W, 0);
  NEON.forEach((col, i) => grad.addColorStop(i / 2, `#${col.getHexString()}`));
  const path = () => {
    g.beginPath();
    pts2d.forEach(([u, v], i) => {
      const x = (u + w / 2 + pad) * sx;
      const y = H - (v + h / 2 + pad) * sx;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
  };
  g.strokeStyle = grad;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [blur, width, alpha] of [[36, 60, 0.55], [14, 18, 0.7]]) {
    g.filter = `blur(${blur}px)`;
    g.globalAlpha = alpha;
    g.lineWidth = width;
    path();
    g.stroke();
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w + pad * 2, h + pad * 2),
    new THREE.MeshBasicMaterial({ map: canvasTexture(c), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  mesh.userData.decor = true;
  return mesh;
}

/** 可复现的随机数 */
function rng(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** 在 w×h 的画布上画好，转成贴图 */
function paintTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  return canvasTexture(c);
}

function roundedShape(w, h, r) {
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** 圆角矩形的屏幕（XY 平面，UV 归一到 0–1） */
function roundedPlane(w, h, r) {
  const g = new THREE.ShapeGeometry(roundedShape(w, h, r), 8);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5);
  return g;
}

/** 统一的几种材质：阳极氧化铝、白色塑料、深色玻璃 */
const MAT = {
  alu: () => new THREE.MeshStandardMaterial({ color: 0xd8d9de, metalness: 0.85, roughness: 0.3 }),
  // 家具、展示台、配件统一用这两种：和显示器的铝、拱门的霓虹配成一套
  graphite: () => new THREE.MeshPhysicalMaterial({ color: 0x1c1c1f, metalness: 0.45, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.35 }),
  gunmetal: () => new THREE.MeshStandardMaterial({ color: 0x47484e, metalness: 0.9, roughness: 0.32 }),
  white: () => new THREE.MeshPhysicalMaterial({ color: 0xf8f8fa, roughness: 0.35, clearcoat: 0.4 }),
  dark: () => new THREE.MeshStandardMaterial({ color: 0x1c1b22, roughness: 0.4 }),
  screen: (map) => new THREE.MeshBasicMaterial({ map, toneMapped: false }),
};

/** 手机锁屏：一张“封面”壁纸，不显示时间和日期。
 * 夜空渐变 + 几颗柔光圆 + 一副 AirPods 的线稿和 NodLink 字样。clock 参数留着不用，调用的地方不用改 */
function phoneTexture() {
  return paintTexture(256, 520, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, w * 0.4, h);
    bg.addColorStop(0, '#2a2b6b');
    bg.addColorStop(0.5, '#7357e8');
    bg.addColorStop(1, '#ff9fc8');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // 柔光圆
    for (const [x, y, r, a] of [[0.2, 0.22, 90, 0.35], [0.85, 0.48, 120, 0.28], [0.35, 0.86, 110, 0.3], [0.7, 0.12, 50, 0.25]]) {
      const grd = g.createRadialGradient(x * w, y * h, 0, x * w, y * h, r);
      grd.addColorStop(0, `rgba(255,255,255,${a})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    }
    // 小星星
    g.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 26; i++) {
      const x = (i * 97) % w;
      const y = (i * 53) % (h * 0.55);
      g.fillRect(x, y, i % 3 ? 2 : 3, i % 3 ? 2 : 3);
    }
    // 一副 AirPods 线稿（两只耳机，柄朝下）
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.lineWidth = 6;
    g.lineCap = 'round';
    for (const [cx, flip] of [[w / 2 - 34, -1], [w / 2 + 34, 1]]) {
      const cy = h * 0.4;
      g.beginPath();
      g.arc(cx, cy, 24, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(cx + flip * 10, cy + 22);
      g.lineTo(cx + flip * 14, cy + 80);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.textAlign = 'center';
    g.font = '700 40px -apple-system, "Helvetica Neue", sans-serif';
    g.fillText('NodLink', w / 2, h * 0.68);
  });
}

/** 角色手上的道具：加载时去掉 */
const PROP_NAMES = /sword|shield|axe|crossbow|dagger|staff|wand|spellbook|quiver|arrow|mug|knife|blade|smokebomb/i;

/** 角色没有点头、摇头、挥手动画时，用它自带的相近动画代替（KayKit 角色包的命名） */
const CLIP_ALIASES = { Yes: ['Cheer'], No: ['Hit_A'], Wave: ['Interact'] };

/** 以下物件都按米建模，放进场景时整体放大 U 倍 */

/** AirPods 充电盒：盖子往后掀开，两只耳机插在盒里，正面一颗绿色状态灯 */
function makeAirPodsCase() {
  const g = new THREE.Group();
  const gloss = new THREE.MeshPhysicalMaterial({ color: 0xfbfaff, roughness: 0.25, clearcoat: 0.9 });
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.054, 0.034, 0.022, 4, 0.009), gloss);
  body.position.y = 0.017;
  const lid = new THREE.Group();
  lid.position.set(0, 0.034, -0.011);
  lid.rotation.x = -1.85;
  const lidShell = new THREE.Mesh(new RoundedBoxGeometry(0.054, 0.012, 0.022, 4, 0.006), gloss);
  lidShell.position.set(0, 0.006, 0.011);
  lid.add(lidShell);
  const well = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.002, 0.014), new THREE.MeshStandardMaterial({ color: 0xd2d2d8, roughness: 0.6 }));
  well.position.y = 0.0335;
  g.add(body, lid, well);
  for (const side of [-1, 1]) {
    const bud = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 24, 16), gloss);
    bud.position.set(side * 0.012, 0.039, 0.001);
    bud.scale.set(1, 0.85, 1);
    const grille = new THREE.Mesh(new THREE.CircleGeometry(0.0028, 16), new THREE.MeshBasicMaterial({ color: 0x2a2a2f }));
    grille.position.set(side * 0.012 - side * 0.0062, 0.041, 0.004);
    grille.rotation.y = -side * 0.9;
    g.add(bud, grille);
  }
  const led = new THREE.Mesh(new THREE.CircleGeometry(0.0016, 16), new THREE.MeshBasicMaterial({ color: 0x5dffc0, toneMapped: false }));
  led.position.set(0, 0.021, 0.0111);
  g.add(led);
  g.traverse((o) => {
    if (o.isMesh) o.userData.deskCase = true;
  });
  return g;
}


function makePhoneOnCharger() {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.053, 0.008, 48), MAT.graphite());
  pad.position.y = 0.004;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0505, 0.0015, 8, 64), new THREE.MeshBasicMaterial({ color: 0xa9cbff, toneMapped: false }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.006;
  const phone = new THREE.Group();
  phone.position.y = 0.0088;
  phone.rotation.y = 0.25;
  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(roundedShape(0.072, 0.147, 0.011), { depth: 0.007, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelSegments: 2 }),
    new THREE.MeshStandardMaterial({ color: 0x2c2c31, metalness: 0.8, roughness: 0.28 }),
  );
  body.rotation.x = -Math.PI / 2;
  const screen = new THREE.Mesh(roundedPlane(0.068, 0.143, 0.009), MAT.screen(phoneTexture()));
  screen.rotation.x = -Math.PI / 2;
  screen.position.y = 0.0082;
  phone.add(body, screen);
  g.add(pad, ring, phone);
  g.userData.screen = screen;
  return g;
}

export class Scene3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // 像素密度最多 1.5：Retina 屏上 2 倍要多画 78% 的像素，肉眼几乎看不出差别；掉帧时再自动降到 1
    this.maxDpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(this.maxDpr);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // 不用实时阴影：东西都悬在空中，地上各放一团柔和的圆影（rebuildWorld 里的 blob），浅色模式下不再有大块灰色多边形
    this.renderer.shadowMap.enabled = false;
    container.prepend(this.renderer.domElement);
    // 第一人称是一张像素插画，叠在 3D 画布上面
    this.pixel = new PixelDesk(container, this);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.05, 300);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 22;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.addEventListener('start', () => { this.camGoal = null; this.userMoved = true; });

    this.lineMaterials = [];
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.pickables = [];
    this.layout = { screens: [], front: { x: 0, y: 0 }, G: 3000 };
    this.lens = 'show';
    this.alerts = {};
    this.selected = null;
    this.pointerPx = null;
    this.trail = [];
    this.lastSampleT = null;
    this.clock = new THREE.Clock();
    this.poseQ = new THREE.Quaternion();
    // 只用于显示的平滑：数据一秒二三十个样本，还带着噪声，直接画出来落点会一直跳。
    // 静止时强力去抖，转头快时几乎不拖；调试镜头不平滑，看的是原始数据
    this.poseFilters = ['h', 'v', 'r'].map(() => new OneEuroFilter({ minCutoff: 0.8, beta: 0.3, dCutoff: 1 }));
    this.floorY = -0.6;

    // 光：天光（HDRI）+ 一盏不投影的主光 + 吊灯（场景里唯一投影的灯）
    this.hemi = new THREE.HemisphereLight(0xf7f8fb, 0xe9e6e1, 0.5);
    this.key = new THREE.DirectionalLight(0xfff4ea, 1);
    this.key.position.set(4, 7, 6);
    this.lamp = new THREE.SpotLight(0xf0f4ff, 0, 0, 0.95, 0.85, 1.6);
    this.lamp.castShadow = true;
    this.lamp.shadow.mapSize.set(2048, 2048);
    this.lamp.shadow.bias = -0.0004;
    this.lamp.shadow.normalBias = 0.02;
    Object.assign(this.lamp.shadow.camera, { near: 0.3, far: 14 });
    this.scene.add(this.hemi, this.key, this.lamp, this.lamp.target);
    new RGBELoader().load(HDRI, (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = hdr;
      this.applyDayNight();
    });

    this.particles = new ParticleField(this.scene); // 背景里飘的光点和方块
    this.room = new THREE.Group();    // 地板、墙、窗、书桌、显示器、摆件
    this.scene.add(this.room);
    this.markers = new THREE.Group(); // 屏幕上的目标、光标、轨迹
    this.markers.position.z = -DZ;
    this.scene.add(this.markers);
    this.pivot = new THREE.Group();   // 没有头部骨骼的模型整体绕这里转
    this.pivot.rotation.order = 'YXZ';
    this.scene.add(this.pivot);
    this.pickPlane = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ visible: false }));
    this.pickPlane.position.z = -DZ;
    this.scene.add(this.pickPlane);
    // 只用于点击的隐形物体放在第 1 层：相机不渲染它们（环境光遮蔽的深度图也不会画进去），射线照样能打到
    this.pickPlane.layers.set(1);
    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.enableAll();

    this.buildMarkers();
    this.setTheme();

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this.onPointer(e));
    el.addEventListener('pointerleave', () => { this.pointerPx = null; });
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.setView('first', true);
  }

  // ---------- 材质 ----------

  // ---------- 外观 ----------

  setTheme() {
    // “更多”里手动选了浅色或深色就用它，否则跟随系统
    const forced = document.documentElement.dataset.theme;
    this.night = forced ? forced === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    this.pixel.setTheme(this.night);
    this.cursorColor = this.night ? 0xffffff : COLOR.ink;
    this.cursor?.material.color.setHex(this.cursorColor);
    this.applyDayNight();
    this.rebuildWorld();
  }

  /** 白天：明亮柔和，荧光调暗；夜晚：环境暗下来，荧光、吊灯和屏幕成为主光 */
  applyDayNight() {
    const night = this.night;
    this.scene.environmentIntensity = night ? 0.18 : 0.75;
    this.hemi.color.setHex(night ? 0x9aa6c0 : 0xf7f8fb);
    this.hemi.groundColor.setHex(night ? 0x16161a : 0xe9e6e1);
    this.hemi.intensity = night ? 0.35 : 0.55;
    this.key.intensity = night ? 0.35 : 1.2;
    this.lamp.intensity = night ? 34 : 14;
    this.renderer.toneMappingExposure = 1;
    this.scene.background?.dispose?.();
    // 浅色：纯色 #f5f5f7，和游戏大厅、页面底色一样亮（渐变贴图会被色调映射压灰）；深色保留近黑的渐变
    this.scene.background = night ? backdropTexture(true) : new THREE.Color(0xf5f5f7);
    this.particles?.setNight(night);
    this.pet?.setNight(night);
  }

  /** 镜头：演示（真实的书房）或调试（几何变灰）。页面上已经不再切换，固定是演示；调试的画法留着备用 */
  setLens(lens) {
    const debug = lens === 'debug';
    this.lens = lens;
    this.scene.traverse((o) => this.applyLensTo(o, debug));
    this.applyLensExtras(debug);
  }

  /** 换镜头时要变的东西：可着色的网格、屏幕、装饰、彩色灯 */
  lensTargets() {
    const out = [];
    this.scene.traverse((o) => {
      if ((o.isMesh && (o.userData.tintable || o.userData.wall)) || o.userData.decor || (o.isLight && o.userData.base != null)) out.push(o);
    });
    return out;
  }

  applyLensTo(o, debug) {
    if (o.isMesh && o.userData.wall) {
      // 屏幕：调试时去掉壁纸，换成纯色
      o.material.map = debug ? null : o.userData.wall;
      o.material.color.setHex(debug ? (this.night ? 0x26262e : 0xf4f4f7) : 0xffffff);
      o.material.needsUpdate = true;
      return;
    }
    if (o.isMesh && o.userData.tintable) for (const mat of [].concat(o.material)) this.tintMat(mat, debug);
    // 调试时关掉彩色灯光和墙上的光晕，只留中性的素模
    if (o.userData.decor) o.visible = !debug;
    if (o.isLight && o.userData.base != null) o.intensity = debug ? 0 : o.userData.base;
  }

  tintMat(mat, debug) {
    mat.userData.orig ??= { color: mat.color.clone(), map: mat.map, glow: mat.emissiveIntensity };
    if (debug) {
      mat.color.setScalar(this.night ? 0.32 : 0.78);
      mat.map = null;
      if (mat.emissive) mat.emissiveIntensity = 0;
    } else {
      mat.color.copy(mat.userData.orig.color);
      mat.map = mat.userData.orig.map;
      if (mat.emissive) mat.emissiveIntensity = mat.userData.orig.glow;
    }
    mat.needsUpdate = true;
  }

  applyLensExtras(debug) {
    if (this.axes) this.axes.visible = debug;
    if (this.grid) this.grid.visible = debug;
    if (this.particles) this.particles.visible = !debug;
    for (const g of this.screenGrids ?? []) g.visible = debug;
  }

  /** 出问题的部件亮起来：parts = { pods, head, ray, cursor, 'screen:0' … } → 'warn' | 'bad' */
  setAlerts(parts) {
    this.alerts = parts;
  }

  select(part) {
    this.selected = part;
  }

  // ---------- 机器人 ----------

  async loadModel(source) {
    const loader = new GLTFLoader();
    const gltf = typeof source === 'string' ? await loader.loadAsync(source) : await loader.parseAsync(source, '');
    this.disposeModel();

    const root = gltf.scene;
    root.rotation.y = Math.PI; // glTF 约定模型面朝 +Z，这里的正前方是 -Z
    const holder = new THREE.Group();
    holder.add(root);
    this.scene.add(holder);
    holder.updateMatrixWorld(true);

    // 角色包里常把剑、盾、法杖一起挂在手上，这里用不上，直接拿掉
    const props = [];
    root.traverse((o) => { if (o.isMesh && PROP_NAMES.test(o.name)) props.push(o); });
    for (const o of props) o.removeFromParent();

    let head = null;
    let headMesh = null;
    root.traverse((o) => {
      if (/head/i.test(o.name) && !/end|top/i.test(o.name) && (!head || (o.isBone && !head.isBone))) head = o;
      if (o.isMesh) {
        if (/head/i.test(o.name)) headMesh = o;
        o.castShadow = !o.isSkinnedMesh; // 蒙皮网格在阴影深度图里会被拉成一大片，手部不投影
        o.receiveShadow = true;
        o.frustumCulled = false;
        // 换成带清漆的塑料，像一个桌面手办
        const src = [].concat(o.material)[0];
        o.material = new THREE.MeshPhysicalMaterial({ color: src.color, map: src.map, roughness: 0.42, metalness: src.metalness ?? 0, clearcoat: 0.7, clearcoatRoughness: 0.25, flatShading: !!src.flatShading });
        o.userData.part = 'head';
        o.userData.tintable = true;
        this.pickables.push(o);
      }
    });

    // 按头部大小归一化，并把头部中心移到原点
    const full = new THREE.Box3().setFromObject(root);
    const headBox = headMesh ? new THREE.Box3().setFromObject(headMesh) : null;
    const headWidth = headBox ? headBox.getSize(new THREE.Vector3()).x : full.getSize(new THREE.Vector3()).y * 0.3;
    holder.scale.setScalar(HEAD_SIZE / headWidth);
    holder.updateMatrixWorld(true);
    const center = headMesh
      ? new THREE.Box3().setFromObject(headMesh).getCenter(new THREE.Vector3())
      : head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    holder.position.sub(center);
    holder.updateMatrixWorld(true);
    this.floorY = new THREE.Box3().setFromObject(root).min.y;
    const headWorld = headMesh ? new THREE.Box3().setFromObject(headMesh) : new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(HEAD_SIZE, HEAD_SIZE, HEAD_SIZE));
    const hc = headWorld.getCenter(new THREE.Vector3());
    const size = headWorld.getSize(new THREE.Vector3());

    this.model = { holder, root, head: head?.isBone ? head : null, baseY: holder.position.y };
    if (this.model.head) {
      this.model.restLocal = head.quaternion.clone();
      this.model.centerLocal = head.worldToLocal(hc.clone());
    } else {
      this.pivot.add(holder);
    }
    const parent = this.model.head ?? this.pivot;
    const attach = (obj) => {
      this.scene.add(obj);
      parent.attach(obj);
      return obj;
    };

    this.headTop = new THREE.Object3D();
    this.headTop.position.set(hc.x, hc.y + size.y * 0.7, hc.z);
    attach(this.headTop);

    // 耳机：挂在头的两侧，跟着头转。戴着头盔的角色挂在头盔外面；帽子在头顶上方，不算
    let earHalf = size.x / 2;
    head?.traverse((o) => {
      if (!o.isMesh || o === headMesh) return;
      const box = new THREE.Box3().setFromObject(o);
      if (Math.abs(box.getCenter(new THREE.Vector3()).y - hc.y) < size.y * 0.25) earHalf = Math.max(earHalf, box.getSize(new THREE.Vector3()).x / 2);
    });
    this.pods = [];
    for (const side of [-1, 1]) {
      const pod = this.makePod(size.y);
      pod.position.set(hc.x + side * (earHalf + 0.005), hc.y - size.y * 0.06, hc.z + size.z * 0.05);
      pod.rotation.z = side * 0.12;
      this.pods.push(attach(pod));
    }

    // 头部坐标轴（调试镜头可见）
    this.axes = new THREE.Group();
    const o = new THREE.Vector3();
    for (const [to, color] of [[new THREE.Vector3(0.4, 0, 0), COLOR.x], [new THREE.Vector3(0, 0.45, 0), COLOR.y], [new THREE.Vector3(0, 0, 0.4), COLOR.z]]) {
      const l = this.fatLine([o, to], { color, linewidth: 2.5, depthTest: false });
      l.renderOrder = 4;
      this.axes.add(l);
    }
    this.axes.position.copy(hc);
    attach(this.axes);

    this.modelMeshes = [];
    root.traverse((o) => { if (o.isMesh) this.modelMeshes.push(o); });
    this.mixer = gltf.animations.length ? new THREE.AnimationMixer(root) : null;
    this.clips = Object.fromEntries(gltf.animations.map((a) => [a.name, a]));
    const idle = this.clips.Unarmed_Idle ?? this.clips.Idle;
    if (this.mixer && idle) this.mixer.clipAction(idle).play();
    this.mixer?.addEventListener('finished', (e) => {
      e.action.fadeOut(0.3);
      if (e.action === this.oneShot) this.oneShot = null;
    });
    this.rebuildWorld();
    return gltf.animations.map((a) => a.name);
  }

  /** 内置角色 NodBot（ui/pet.js）：程序建模的 Q 版小机器人，不用模型文件。挂耳机、指向线这些和 glTF 角色一样 */
  loadPet() {
    this.disposeModel();
    const bot = new NodBot();
    const holder = new THREE.Group();
    holder.add(bot.root);
    this.scene.add(holder);
    holder.updateMatrixWorld(true);
    bot.root.traverse((o) => {
      if (!o.isMesh || o.userData.outline) return;
      o.userData.part = 'head';
      this.pickables.push(o);
    });
    this.floorY = bot.bottomY;
    this.pet = bot;
    bot.setNight(this.night);
    this.model = { holder, root: bot.root, head: bot.head, baseY: 0, restLocal: bot.head.quaternion.clone(), centerLocal: new THREE.Vector3() };
    const attach = (obj) => {
      this.scene.add(obj);
      bot.head.attach(obj);
      return obj;
    };
    const hh = bot.headHeight;
    this.headTop = new THREE.Object3D();
    this.headTop.position.set(0, hh * 0.7, 0);
    attach(this.headTop);
    this.pods = [];
    for (const side of [-1, 1]) {
      const pod = this.makePod(hh);
      pod.position.set(side * (bot.earHalf + 0.005), -hh * 0.06, hh * 0.04);
      pod.rotation.z = side * 0.12;
      this.pods.push(attach(pod));
    }
    this.axes = new THREE.Group();
    const o = new THREE.Vector3();
    for (const [to, color] of [[new THREE.Vector3(0.4, 0, 0), COLOR.x], [new THREE.Vector3(0, 0.45, 0), COLOR.y], [new THREE.Vector3(0, 0, 0.4), COLOR.z]]) {
      const l = this.fatLine([o, to], { color, linewidth: 2.5, depthTest: false });
      l.renderOrder = 4;
      this.axes.add(l);
    }
    attach(this.axes);
    this.modelMeshes = []; // 告警高亮改成描边变色（setAlert），不动材质的自发光
    this.mixer = null;
    this.clips = {};
    this.rebuildWorld();
    return ['Yes', 'No', 'Wave', 'Cheer', 'Think', 'Love'];
  }

  makePod(k) {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.06, emissive: 0xffffff, emissiveIntensity: 0 });
    const pod = new THREE.Group();
    const bud = new THREE.Mesh(new THREE.SphereGeometry(0.085 * k, 32, 20), mat);
    bud.scale.set(0.9, 1, 1.1);
    const stem = new THREE.Mesh(new THREE.CapsuleGeometry(0.028 * k, 0.17 * k, 6, 16), mat);
    stem.position.set(0, -0.13 * k, -0.02 * k);
    stem.rotation.x = 0.18;
    for (const m of [bud, stem]) {
      m.castShadow = true;
      m.userData.part = 'pods';
      this.pickables.push(m);
    }
    pod.add(bud, stem);
    pod.userData.mat = mat;
    return pod;
  }

  disposeModel() {
    if (!this.model) return;
    for (const obj of [...(this.pods ?? []), this.headTop, this.axes]) obj?.removeFromParent();
    this.model.holder.removeFromParent();
    this.pivot.clear();
    this.pivot.quaternion.identity();
    this.mixer?.stopAllAction();
    this.pickables = this.pickables.filter((m) => !['head', 'pods'].includes(m.userData.part));
    this.model = null;
    this.mixer = null;
    this.oneShot = null;
    this.pet = null;
  }

  /** 播放一次动画：Yes 点头、No 摇头、Wave 挥手 */
  play(name) {
    if (this.pet) {
      this.pet.play(name);
      return;
    }
    const clip = this.clips?.[name] ?? (CLIP_ALIASES[name] ?? []).map((n) => this.clips?.[n]).find(Boolean);
    if (!this.mixer || !clip) return;
    const action = this.mixer.clipAction(clip);
    action.reset().setLoop(THREE.LoopOnce, 1).fadeIn(0.2).play();
    this.oneShot = action;
    this.oneShotTouchesHead = /yes|no/i.test(name);
  }

  // ---------- 书房 ----------

  setLayout({ screens, front, G }) {
    const key = JSON.stringify({ screens, front, G });
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.layout = { screens, front, G };
    this.centerWorld();
    this.pixel.setLayout(this.layout);
    this.trail = [];
    this.rebuildWorld();
  }

  /**
   * 显示器整体平移，让所有显示器合起来的中心正对机器人（头在原点）。
   * 原来以“正前方”（对准中心时定的那一点）为原点：两块屏上下摞着、正前方在上面那块时，机器人和上面那块齐平，看着偏高。
   * 平移后，机器人头的静止朝向同步转向原来的正前方（见 render() 里的 poseQ），指向线照样打在光标上
   */
  centerWorld() {
    this.off = { x: 0, y: 0 };
    const s = DZ / this.layout.G;
    const rs = this.layout.screens.map((sc) => ({ c: this.toWorld({ x: sc.x + sc.w / 2, y: sc.y + sc.h / 2 }), w: sc.w * s, h: sc.h * s }));
    if (!rs.length) return;
    const L = Math.min(...rs.map((r) => r.c.x - r.w / 2));
    const R = Math.max(...rs.map((r) => r.c.x + r.w / 2));
    const T = Math.max(...rs.map((r) => r.c.y + r.h / 2));
    const B = Math.min(...rs.map((r) => r.c.y - r.h / 2));
    this.off = { x: -(L + R) / 2, y: -(T + B) / 2 };
  }

  rebuildWorld() {
    this.room.clear();
    this.pickables = this.pickables.filter((m) => !String(m.userData.part).startsWith('screen') && !m.userData.deskCase);
    this.screenFaces = [];
    this.screenGrids = [];
    this.monitorBodies = [];
    const night = this.night;
    const s = DZ / this.layout.G;
    const rects = this.layout.screens.map((sc, i) => {
      const c = this.toWorld({ x: sc.x + sc.w / 2, y: sc.y + sc.h / 2 });
      return { ...c, w: sc.w * s, h: sc.h * s, main: sc.main, i };
    });
    const screenL = Math.min(...rects.map((r) => r.x - r.w / 2), -0.9);
    const screenR = Math.max(...rects.map((r) => r.x + r.w / 2), 0.9);
    const screenTop = Math.max(...rects.map((r) => r.y + r.h / 2), 0.5);
    const screenBottom = Math.min(...rects.map((r) => r.y - r.h / 2), -0.5);

    // 书桌：显示器下沿离桌面 11 厘米；宽度只比显示器多一点，进深 62 厘米
    this.monitorBox = { cx: (screenL + screenR) / 2, cy: (screenTop + screenBottom) / 2, w: screenR - screenL, bottom: screenBottom };
    const deskTop = screenBottom - 0.11 * U;
    const topT = 0.025 * U;
    const floor = deskTop - 0.74 * U;
    const deskW = Math.max(1.1 * U, screenR - screenL + 0.5 * U);
    const cx = (screenL + screenR) / 2;
    const x0 = cx - deskW / 2;
    const x1 = cx + deskW / 2;
    const z1 = -DZ - 0.22 * U;
    const z0 = z1 + 0.62 * U;
    this.deskTop = deskTop;

    const add = (mesh, cast = true) => {
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.userData.tintable ??= true;
      this.room.add(mesh);
      return mesh;
    };
    const paint = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...extra });
    const led = (color, intensity, x, y, z) => {
      const l = new THREE.PointLight(color, intensity * (night ? 1 : 0.25), 0, 2);
      l.position.set(x, y, z);
      l.userData.base = l.intensity;
      this.room.add(l);
      return l;
    };
    const glowMul = night ? 1 : 0.7;

    // 地面看不见：书桌、地台、展示台都去掉了，显示器、配件和机器人悬在空中，地上各有一团柔和的圆影
    const blobs = [];
    const blob = (x, z, w, d, strength = 1) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: SHADOW_TEX(), transparent: true, depthWrite: false, toneMapped: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, floor + 0.002, z);
      m.renderOrder = -1;
      m.userData.base = (night ? 0.55 : 0.2) * strength;
      m.material.opacity = m.userData.base;
      this.room.add(m);
      blobs.push(m);
      return m;
    };

    // 悬浮：每帧在 render() 里让这些东西上下浮动、轻轻晃。显示器几乎不动，配件浮得多一点
    this.floaters = [];
    const float = (obj, amp, period, phase, wobble = 0, shadow = null) => {
      this.floaters.push({ obj, y: obj.position.y, rx: obj.rotation.x, rz: obj.rotation.z, amp, period, phase, wobble, shadow });
      return obj;
    };
    /** 一组按世界坐标摆好的东西，换成绕自己中心晃的一组 */
    const centered = (group) => {
      const c = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
      const outer = new THREE.Group();
      outer.position.copy(c);
      group.position.sub(c);
      outer.add(group);
      this.room.add(outer);
      return outer;
    };

    // 顶光：原来挂着一圈环形吊灯，模型去掉了（挡在画面上方，主体只能往下放），只留它往下打的这盏光
    const lampY = Math.max(deskTop + 1.05 * U, screenTop + 0.15 * U);
    const lampZ = (z1 + z0) / 2 + 0.05 * U;
    this.lamp.position.set(cx - 0.05 * U, lampY - 0.3, lampZ);
    this.lamp.target.position.set(cx, deskTop, (z1 + z0) / 2 + 0.1 * U);

    // 显示器：薄铝机身、很窄的黑边框、发光的屏幕，表面一层很淡的玻璃反光，背后一块后壳和挂板。
    // 不要支架，悬在空中；背后透出一圈淡紫的环境光，像屏幕的光打在身后
    const alu = MAT.alu();
    rects.forEach((r, idx) => {
      const mon = new THREE.Group();
      const body = new THREE.Mesh(new RoundedBoxGeometry(r.w + 0.04, r.h + 0.04, 0.032, 4, 0.015), MAT.alu());
      body.position.set(r.x, r.y, -DZ - 0.017);
      body.castShadow = true;
      body.userData = { part: `screen:${r.i}`, tintable: true };
      const bezel = new THREE.Mesh(roundedPlane(r.w + 0.026, r.h + 0.026, 0.011), MAT.dark());
      bezel.position.set(r.x, r.y, -DZ + 0.0003);
      bezel.userData.tintable = true;
      const wall = wallpaper(this.layout.screens[r.i]);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), new THREE.MeshBasicMaterial({ map: wall, toneMapped: false }));
      face.position.set(r.x, r.y, -DZ + 0.001);
      face.userData = { part: `screen:${r.i}`, wall, screen: this.layout.screens[r.i] };
      const pts = [];
      for (const f of [1 / 3, 2 / 3]) {
        pts.push(new THREE.Vector3(r.x - r.w / 2 + r.w * f, r.y - r.h / 2, 0), new THREE.Vector3(r.x - r.w / 2 + r.w * f, r.y + r.h / 2, 0));
        pts.push(new THREE.Vector3(r.x - r.w / 2, r.y - r.h / 2 + r.h * f, 0), new THREE.Vector3(r.x + r.w / 2, r.y - r.h / 2 + r.h * f, 0));
      }
      const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9a9aa8 }));
      grid.position.z = -DZ + 0.002;
      // 背面：机身后面鼓出一块圆角后壳，中间一块方形挂板
      const shell = new THREE.Mesh(new RoundedBoxGeometry(r.w * 0.72, r.h * 0.66, 0.036, 4, 0.016), alu);
      shell.position.set(r.x, r.y, -DZ - 0.05);
      const plate = new THREE.Mesh(new RoundedBoxGeometry(Math.min(r.w * 0.22, 0.13 * U), Math.min(r.h * 0.3, 0.13 * U), 0.012, 2, 0.005), MAT.gunmetal());
      plate.position.set(r.x, r.y, -DZ - 0.074);
      // 玻璃：一层几乎透明的镜面，只反一点环境光，屏幕看起来像一整块玻璃
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(r.w + 0.026, r.h + 0.026), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.06, transparent: true, opacity: 0.07, depthWrite: false }));
      glass.position.set(r.x, r.y, -DZ + 0.0025);
      // 背后的环境光
      const ambi = glowSprite(r.main ? 0xb18cff : 0x8fa8ff, Math.max(r.w, r.h) * 2.1, night ? 0.4 : 0.26);
      ambi.position.set(r.x, r.y, -DZ - 0.25);
      for (const o of [shell, plate]) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.userData.tintable = true;
      }
      mon.add(body, bezel, face, grid, shell, plate, glass, ambi);
      this.room.add(mon);
      // 屏幕上的光标、目标画在另一层里，不跟着动：所以显示器只浮 6 毫米左右，看不出错位
      float(mon, 0.006, 9 + idx, idx * 1.7, 0, blob(r.x, -DZ + 0.15, (r.w + 0.3) * 1.15, 1.1, 0.8));
      this.screenFaces.push(face);
      this.screenGrids.push(grid);
      this.monitorBodies.push(body);
      this.pickables.push(body, face);
    });
    const main = rects.find((r) => r.main) ?? rects[0] ?? { x: 0, y: 0, w: 1.6, h: 1 };
    led(0xa8c4ff, 2.4, main.x, main.y - main.h * 0.2, -DZ + 0.4);

    // 配件只留两样：左边 AirPods 充电盒（可以点）、右边手机。放大到 1.8 倍，悬在屏幕两侧前方，各浮各的
    const place = (obj, x, y, z, rotY = 0, k = 1.8) => {
      obj.scale.setScalar(U * k);
      obj.position.set(x, y, z);
      obj.rotation.y = rotY;
      obj.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = !o.material.transparent;
        o.receiveShadow = true;
        o.userData.tintable = true;
      });
      this.room.add(obj);
      return obj;
    };
    const podsCase = place(makeAirPodsCase(), screenL + 0.05, screenBottom + 0.05, -DZ + 1.6, 0.55, 2.2);
    podsCase.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.part = 'pods';
      this.pickables.push(o);
    });
    float(podsCase, 0.045, 4.8, 2.6, 0.07, blob(podsCase.position.x, podsCase.position.z, 0.7, 0.55));
    // 手机连着无线充一起立起来，屏幕朝着镜头
    const phone = place(makePhoneOnCharger(), screenR + 0.4, screenBottom + 0.2, -DZ + 1.25, -0.5);
    phone.rotation.x = 1.0;
    this.phoneScreen = phone.userData.screen;
    float(phone, 0.05, 4.1, 3.7, 0.08, blob(phone.position.x, phone.position.z, 0.75, 0.6));
    this.wallClock = nowClock();

    // 机器人：不再站在展示台上，悬在空中。脚下两圈慢慢转的霓虹光环和一团光
    this.hoverY = this.floorY - 0.08;
    const hover = new THREE.Group();
    hover.position.set(0, this.hoverY, 0);
    const ring = (r, n) => Array.from({ length: n }, (_, k) => {
      const a = (k / n) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
    });
    const ringA = neonTube(ring(0.27, 96), 0.006, true, [-0.27, 0.27], 160);
    const ringB = neonTube(ring(0.19, 80), 0.0045, true, [-0.19, 0.19], 128);
    ringB.position.y = -0.06;
    ringB.rotation.x = 0.12;
    ringA.material.color.setScalar(night ? 1 : 0.9);
    ringB.material.color.setScalar(night ? 0.8 : 0.7);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 48), new THREE.MeshBasicMaterial({ map: GLOW_TEX(), color: 0xb18cff, transparent: true, opacity: night ? 0.6 : 0.4, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.01;
    hover.add(ringA, ringB, disc);
    this.room.add(hover);
    this.hover = { group: hover, ringA, ringB, disc, discOpacity: disc.material.opacity };
    this.robotShadow = blob(0, 0.05, 1.3, 1.1, 1.1);

    this.grid = new THREE.GridHelper(40, 80, 0x9a9aa2, 0xcacad0);
    this.grid.position.set(cx, floor + 0.01, 0);
    this.room.add(this.grid);

    this.target.scale.setScalar(Math.max(main.h / 1.1, 0.6));
    this.applyDayNight();
    this.setLens(this.lens);
    // 显示器布局变了：没手动转过镜头就按新布局重新取景
    if ((this.viewName === 'first' || this.viewName === 'home') && !this.userMoved) this.setView(this.viewName, true);
  }

  // ---------- 屏幕上的标记与指向线 ----------

  lineMaterial(options) {
    const m = new LineMaterial({ worldUnits: false, ...options });
    m.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1);
    this.lineMaterials.push(m);
    return m;
  }

  fatLine(points, options) {
    const g = new LineGeometry();
    g.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
    const line = new Line2(g, this.lineMaterial(options));
    line.computeLineDistances();
    return line;
  }

  buildMarkers() {
    const mat = (color) => new THREE.MeshBasicMaterial({ color, depthTest: false, toneMapped: false });
    this.target = new THREE.Group();
    this.target.add(
      new THREE.Mesh(new THREE.CircleGeometry(0.075, 48), mat(0xffffff)),
      new THREE.Mesh(new THREE.CircleGeometry(0.058, 48), mat(COLOR.target)),
      new THREE.Mesh(new THREE.CircleGeometry(0.018, 24), mat(0xffffff)),
    );
    this.hit = new THREE.Mesh(new THREE.CircleGeometry(0.03, 32), mat(0xffffff));
    this.ripple = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.042, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false, toneMapped: false }));
    this.raw = new THREE.Mesh(new THREE.CircleGeometry(0.014, 20), mat(0x9a9aa8));
    // 头控点击的波纹；拖拽时光标中间的实心点
    this.burst = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.085, 48), new THREE.MeshBasicMaterial({ color: COLOR.pink, transparent: true, depthTest: false, toneMapped: false }));
    this.grab = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), mat(COLOR.pink));

    const circle = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      circle.push(new THREE.Vector3(Math.cos(a) * 0.075, Math.sin(a) * 0.075, 0));
    }
    this.cursor = this.fatLine(circle, { color: 0xffffff, linewidth: 3, depthTest: false });
    this.cursorHit = new THREE.Mesh(new THREE.CircleGeometry(0.16, 24), new THREE.MeshBasicMaterial({ visible: false }));
    this.cursorHit.userData.part = 'cursor';
    this.cursorHit.layers.set(1);
    this.pickables.push(this.cursorHit);

    this.errorLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.errorLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));

    this.trailLine = new Line2(new LineGeometry(), this.lineMaterial({ color: 0xffffff, linewidth: 4, vertexColors: true, depthTest: false }));
    this.trailLine.frustumCulled = false;

    for (const m of [this.trailLine, this.target, this.hit, this.ripple, this.raw, this.cursor, this.cursorHit, this.errorLine, this.burst, this.grab]) {
      m.renderOrder = 3;
      m.visible = false;
      this.markers.add(m);
    }

    // 指向线：从头部射向屏幕；外面套一根看不见的圆柱，方便点击
    this.ray = new Line2(new LineGeometry(), this.lineMaterial({ color: COLOR.ray, linewidth: 3.5 }));
    this.ray.geometry.setPositions([0, 0, 0, 0, 0, -1]);
    this.scene.add(this.ray);
    this.rayHit = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.rayHit.userData.part = 'ray';
    this.rayHit.layers.set(1);
    this.scene.add(this.rayHit);
    this.pickables.push(this.rayHit);
  }

  // ---------- 镜头位置 ----------

  /**
   * 视角。first：第一人称，站在使用者的位置正对显示器，屏幕占视野约 78%，下沿露出桌面、键盘和耳机；
   * home：第三人称，能看到机器人、指向线和整张桌子，方便校准；front / top：调试用。
   */
  setView(name, instant = false) {
    this.viewName = name;
    this.userMoved = false;
    // 第一人称画像素插画，3D 画布藏起来、也不再渲染
    this.pixel.show(name === 'first');
    this.renderer.domElement.style.visibility = name === 'first' ? 'hidden' : '';
    // 第一人称时镜头固定，不让拖动；第三人称可以转
    this.controls.enabled = name !== 'first';
    let pos;
    let target;
    if (name === 'first') {
      const b = this.monitorBox ?? { cx: 0, cy: 0, w: 1.7, bottom: -0.55 };
      const vfov = this.camera.fov * RAD;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
      const d = b.w / (0.76 * 2 * Math.tan(hfov / 2));
      const viewH = 2 * d * Math.tan(vfov / 2);
      // 屏幕下沿放在画面下方约 30% 处；眼睛略高于屏幕中心、往下俯视，下面露出桌面、键盘和鼠标
      const lookY = b.bottom - 0.3 * viewH + viewH / 2;
      pos = new THREE.Vector3(b.cx, lookY + 0.45 * viewH, -DZ + d);
      target = new THREE.Vector3(b.cx, lookY, -DZ);
    } else {
      const p = name === 'home' && this.camera.aspect < 0.85 ? VIEW.homeTall : VIEW[name];
      target = new THREE.Vector3(...p.target);
      pos = new THREE.Vector3(...p.pos);
      // 显示器多、摞得高或很宽时，镜头对准它们的中心并按比例退远（以一块 27 寸横屏为准）
      const b = this.monitorBox;
      if (name === 'home' && b) {
        const off = pos.clone().sub(target);
        const h = 2 * (b.cy - b.bottom);
        const ref = DZ / 3; // 一块 27 寸横屏在这个 DZ 下的宽高是 1.92·ref × 1.08·ref
        const k = Math.max(1, (h / (1.08 * ref)) * 0.78, (b.w / (1.92 * ref)) * 0.85);
        target.x += b.cx * 0.6;
        target.y += b.cy * 0.6;
        pos.copy(target).addScaledVector(off, k);
      }
      // 竖屏时适当拉远，但只拉一半，主体不至于太小
      pos.sub(target).multiplyScalar(Math.max(1, Math.sqrt(1.35 / this.camera.aspect))).add(target);
      if (name === 'home') this.frameHome(pos, target);
    }
    this.camGoal = { pos, target };
    if (instant) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.camGoal = null;
    }
  }

  /**
   * 第三人称：保持观察方向不变，平移镜头，让机器人和所有显示器合起来的范围落在可见区域（顶栏以下）正中，
   * 再前后推拉，让这个范围占可见区域宽 74%、高 70% 左右（取先碰到的那个）。迭代几次，透视下也能收敛。
   */
  frameHome(pos, target) {
    const b = this.monitorBox;
    if (!b) return;
    const top = 2 * b.cy - b.bottom;
    const pts = [];
    for (const x of [b.cx - b.w / 2, b.cx + b.w / 2]) for (const y of [b.bottom, top]) pts.push(new THREE.Vector3(x, y, -DZ));
    // 机器人：头在原点，脚在 hoverY 附近（模型加载前按 1.6 估）
    const feet = (this.hoverY ?? -1.6) - 0.1;
    for (const x of [-0.45, 0.45]) for (const y of [feet, 0.42]) for (const z of [-0.3, 0.3]) pts.push(new THREE.Vector3(x, y, z));
    const cam = this.camera.clone();
    const h = this.container.clientHeight || 1;
    const safeTop = this.safe?.top ?? 0;
    const goalY = -safeTop / h; // 可见区域中心在画布 NDC 里的纵坐标（顶栏挡住了上面一截）
    const visH = 1 - safeTop / h; // 可见区域在 NDC 里的半高
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let it = 0; it < 6; it++) {
      cam.position.copy(pos);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of pts) {
        v.copy(p).project(cam);
        x0 = Math.min(x0, v.x);
        x1 = Math.max(x1, v.x);
        y0 = Math.min(y0, v.y);
        y1 = Math.max(y1, v.y);
      }
      const dist = pos.distanceTo(target);
      const hh = Math.tan((cam.fov * RAD) / 2) * dist;
      right.setFromMatrixColumn(cam.matrixWorld, 0);
      up.setFromMatrixColumn(cam.matrixWorld, 1);
      const dx = ((x0 + x1) / 2) * hh * cam.aspect;
      const dy = (((y0 + y1) / 2 - goalY) * hh) / visH; // 画布比视锥高（视锥只对应可见区域），换算回去
      pos.addScaledVector(right, dx).addScaledVector(up, dy);
      target.addScaledVector(right, dx).addScaledVector(up, dy);
      const fill = Math.max((x1 - x0) / 2 / 0.74, (y1 - y0) / 2 / (0.7 * visH));
      const k = Math.min(Math.max(fill, 0.6), 1.6);
      pos.sub(target).multiplyScalar(1 + (k - 1) * 0.8).add(target);
    }
  }

  /** 顶栏和时间轴挡住的边缘不放内容：把投影中心移到可见区域 */
  setSafeArea(insets) {
    this.safe = insets;
    this.pixel.setSafeTop(insets.top);
    this.resize();
  }

  // ---------- 部件的位置与点击 ----------

  /** 点击位置上的部件：'pods' | 'head' | 'ray' | 'cursor' | 'screen:i' | null */
  pick(clientX, clientY) {
    if (this.viewName === 'first') return this.pixel.pick(clientX, clientY);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    for (const hit of this.raycaster.intersectObjects(this.pickables, false)) {
      if (hit.object.userData.part && hit.object.visible) return hit.object.userData.part;
    }
    return null;
  }

  /** 部件在画面上的位置（CSS 像素），用来摆放标签、探针和展开卡片 */
  anchor(part) {
    if (this.viewName === 'first') return this.pixel.anchor(part);
    const v = new THREE.Vector3();
    if (part === 'pods' && this.pods?.length) this.pods[0].getWorldPosition(v);
    else if (part === 'head' && this.headTop) this.headTop.getWorldPosition(v);
    else if (part === 'ray' && this.ray.visible) v.copy(this.rayMid);
    else if (part === 'cursor' && this.cursor.visible) this.cursor.getWorldPosition(v);
    else if (part?.startsWith('screen:')) {
      const body = this.monitorBodies?.[Number(part.slice(7))];
      if (!body) return null;
      v.set(body.position.x, body.position.y + body.geometry.parameters.height / 2, body.position.z);
    } else return null;
    v.project(this.camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  // ---------- 每帧 ----------

  /**
   * pose：相对正前方的角度 { h, v, r }（度）；sampleT：最近样本时间（ms），只在变化时记录轨迹；
   * cursor / raw / target：屏幕坐标或 null；compare：是否画落点与模型光标的误差线（调试镜头）。
   */
  /** 换一张显示当前时间的屏幕壁纸和手机锁屏 */
  refreshClocks(clock) {
    this.wallClock = clock;
    const debug = this.lens === 'debug';
    for (const face of this.screenFaces) {
      face.userData.wall.dispose();
      face.userData.wall = wallpaper(face.userData.screen, clock);
      if (!debug) face.material.map = face.userData.wall;
      face.material.needsUpdate = true;
    }
    const mat = this.phoneScreen?.material;
    if (!mat) return;
    const old = mat.userData.orig?.map ?? mat.map;
    const tex = phoneTexture(clock);
    if (mat.userData.orig) mat.userData.orig.map = tex;
    if (mat.map === old) mat.map = tex;
    old?.dispose();
    mat.needsUpdate = true;
  }

  /** 每帧把姿态过一遍 One Euro，样本之间也连续地动 */
  smoothPose(pose) {
    if (!pose || this.lens === 'debug') {
      for (const f of this.poseFilters) f.reset();
      return pose;
    }
    const t = performance.now() / 1000;
    // 角度跨过 ±180° 时直接跳过去，不从另一边绕一大圈
    this.poseFilters.forEach((f, i) => {
      if (f.x != null && Math.abs(pose[['h', 'v', 'r'][i]] - f.x) > 90) f.reset();
    });
    const [h, v, r] = this.poseFilters.map((f, i) => f.filter(pose[['h', 'v', 'r'][i]], t));
    return { ...pose, h, v, r };
  }

  render({ pose: rawPose, sampleT, streaming, cursor, raw, target, compare, control }) {
    const pose = this.smoothPose(rawPose);
    if (this.viewName === 'first') {
      // 指向线的落点按校准模型的比例换算：x = 正前方 + G·tan(水平角)，y = 正前方 − G·tan(垂直角)/cos(水平角)
      const { front, G } = this.layout;
      const hit = pose && Math.abs(pose.h) < 80 && Math.abs(pose.v) < 80
        ? { x: front.x + G * Math.tan(pose.h * RAD), y: front.y - (G * Math.tan(pose.v * RAD)) / Math.cos(pose.h * RAD) }
        : null;
      this.pixel.draw({ pose, sampleT, cursor, raw, target, compare, hit, control, alerts: this.alerts, selected: this.selected, debug: this.lens === 'debug' });
      return;
    }
    const dt = this.clock.getDelta();
    this.mixer?.update(dt);
    const now = performance.now();
    this.particles.update(this.reducedMotion ? 0 : now / 1000, this.renderer.getPixelRatio());
    const clock = nowClock();
    if (clock !== this.wallClock) this.refreshClocks(clock);

    // 静止朝向对着“正前方”那一点：显示器为了居中平移过（centerWorld），正前方不一定在机器人正前
    const o = this.off ?? { x: 0, y: 0 };
    if (pose) this.poseQ.setFromEuler(new THREE.Euler(pose.v * RAD + Math.atan2(o.y, DZ), -pose.h * RAD - Math.atan2(o.x, DZ), -pose.r * RAD, 'YXZ'));
    const m = this.model;
    if (m?.head && !(this.oneShot && this.oneShotTouchesHead)) {
      // 在世界坐标里把头从静止姿态转过 poseQ，再换回骨骼的局部坐标
      const parentWorld = m.head.parent.getWorldQuaternion(new THREE.Quaternion());
      const restWorld = parentWorld.clone().multiply(m.restLocal);
      m.head.quaternion.copy(parentWorld.clone().invert().multiply(this.poseQ.clone().multiply(restWorld)));
    } else if (!m?.head) {
      this.pivot.quaternion.copy(this.poseQ);
    }

    // 内置小机器人：眨眼、呼吸、天线、手和一次性动作，叠加在上面设好的头部姿态上
    this.pet?.update(this.reducedMotion ? 0 : Math.min(dt, 0.1), pose);

    // 悬浮：显示器几乎不动，配件浮得多一点、轻轻晃；机器人和脚下的光环一起浮，光环慢慢转
    const ts = now / 1000;
    const still = this.reducedMotion;
    for (const f of this.floaters ?? []) {
      const k = still ? 0 : Math.sin((ts / f.period) * Math.PI * 2 + f.phase);
      f.obj.position.y = f.y + k * f.amp;
      if (f.shadow) f.shadow.material.opacity = f.shadow.userData.base * (1 - k * 0.15);
      if (f.wobble && !still) {
        f.obj.rotation.x = f.rx + Math.sin((ts / (f.period * 1.3)) * Math.PI * 2 + f.phase) * f.wobble;
        f.obj.rotation.z = f.rz + k * f.wobble * 0.8;
      }
    }
    const bob = still ? 0 : Math.sin(ts * 1.6) * 0.035;
    if (m) m.holder.position.y = m.baseY + bob;
    if (this.robotShadow) this.robotShadow.material.opacity = this.robotShadow.userData.base * (1 - bob * 4);
    if (this.hover) {
      const h = this.hover;
      h.group.position.y = this.hoverY + bob * 0.7;
      h.ringA.rotation.y = still ? 0 : ts * 0.5;
      h.ringB.rotation.y = still ? 0 : -ts * 0.8;
      h.disc.material.opacity = h.discOpacity * (0.85 + 0.15 * Math.sin(ts * 2.4));
    }

    // 告警：出问题的部件按级别闪琥珀色或红色；选中的部件淡淡发金光
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    const glow = (part) => {
      const lvl = this.alerts[part];
      if (lvl) return { color: lvl === 'bad' ? COLOR.red : COLOR.amber, k: 0.25 + 0.45 * pulse };
      if (this.selected === part) return { color: COLOR.gold, k: 0.25 };
      return null;
    };
    const apply = (mesh, g) => {
      const mat = mesh.material;
      if (!mat.emissive) return;
      mat.emissive.setHex(g ? g.color : 0x000000);
      mat.emissiveIntensity = g ? g.k : 0;
    };
    const podGlow = glow('pods');
    for (const pod of this.pods ?? []) {
      const mat = pod.userData.mat;
      mat.emissive.setHex(podGlow ? podGlow.color : 0xffffff);
      mat.emissiveIntensity = podGlow ? podGlow.k : mat.emissiveIntensity + ((streaming ? 0.1 : 0) - mat.emissiveIntensity) * 0.1;
    }
    const headGlow = glow('head');
    for (const o of this.modelMeshes ?? []) apply(o, headGlow);
    this.pet?.setAlert(headGlow);
    (this.monitorBodies ?? []).forEach((b, i) => apply(b, glow(`screen:${i}`)));
    const rayAlert = this.alerts.ray;
    this.ray.material.color.setHex(rayAlert ? (rayAlert === 'bad' ? COLOR.red : COLOR.amber) : this.selected === 'ray' ? COLOR.gold : COLOR.ray);
    this.cursor.material.color.setHex(this.alerts.cursor ? COLOR.amber : CONTROL_COLOR[control?.mode] ?? (this.selected === 'cursor' ? COLOR.gold : 0xffffff));

    // 指向线与屏幕平面的交点
    this.scene.updateMatrixWorld();
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.poseQ);
    const origin = m?.head ? m.head.localToWorld(m.centerLocal.clone()) : new THREE.Vector3();
    origin.add(dir.clone().multiplyScalar(HEAD_SIZE * 0.55));
    let hitWorld = null;
    if (pose && dir.z < -0.05) hitWorld = origin.clone().add(dir.clone().multiplyScalar((-DZ - origin.z) / dir.z));
    const end = hitWorld ?? origin.clone().add(dir.clone().multiplyScalar(2));
    this.ray.geometry.setPositions([origin.x, origin.y, origin.z, end.x, end.y, end.z]);
    this.ray.visible = !!pose && this.viewName !== 'first';
    this.rayMid = origin.clone().lerp(end, 0.5);
    this.rayHit.position.copy(this.rayMid);
    this.rayHit.scale.set(1, origin.distanceTo(end), 1);
    this.rayHit.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.rayHit.visible = !!pose && this.viewName !== 'first';

    this.hit.visible = !!hitWorld;
    this.ripple.visible = !!hitWorld;
    if (hitWorld) {
      this.hit.position.set(hitWorld.x, hitWorld.y, 0.004);
      const ph = (now % 1400) / 1400;
      this.ripple.position.copy(this.hit.position);
      this.ripple.scale.setScalar(1 + ph * 2.2);
      this.ripple.material.opacity = 0.7 * (1 - ph);
      if (sampleT != null && sampleT !== this.lastSampleT) {
        this.trail.push({ x: hitWorld.x, y: hitWorld.y, t: sampleT });
        this.lastSampleT = sampleT;
      }
    }
    if (sampleT != null) this.trail = this.trail.filter((p) => p.t >= sampleT - TRAIL_MS && p.t <= sampleT);
    this.updateTrail(sampleT);

    const debug = this.lens === 'debug';
    this.place(this.cursor, cursor);
    this.place(this.cursorHit, cursor);
    this.place(this.grab, control?.mode === 'drag' ? cursor : null);
    const fx = control?.fx;
    const fxP = fx ? (performance.now() - fx.t) / 450 : 1;
    this.place(this.burst, fxP < 1 ? fx.at : null);
    if (fxP < 1) {
      this.burst.scale.setScalar(1 + fxP * 1.6);
      this.burst.material.opacity = 1 - fxP;
      this.burst.material.color.setHex(fx.kind === 'right' ? COLOR.cyan : COLOR.pink);
    }
    this.place(this.raw, debug ? raw : null);
    this.place(this.target, target);
    const showError = debug && compare && hitWorld && cursor;
    this.errorLine.visible = !!showError;
    if (showError) {
      const c = this.toWorld(cursor);
      const pos = this.errorLine.geometry.attributes.position;
      pos.setXYZ(0, hitWorld.x, hitWorld.y, 0.005);
      pos.setXYZ(1, c.x, c.y, 0.005);
      pos.needsUpdate = true;
    }

    if (this.camGoal) {
      this.camera.position.lerp(this.camGoal.pos, 0.1);
      this.controls.target.lerp(this.camGoal.target, 0.1);
      if (this.camera.position.distanceTo(this.camGoal.pos) < 0.005) this.camGoal = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.governDpr(now);
  }

  // ---------- 内部 ----------

  toWorld(p) {
    const s = DZ / this.layout.G;
    const o = this.off ?? { x: 0, y: 0 };
    return { x: (p.x - this.layout.front.x) * s + o.x, y: (this.layout.front.y - p.y) * s + o.y };
  }

  place(obj, px) {
    obj.visible = !!px;
    if (!px) return;
    const w = this.toWorld(px);
    obj.position.set(w.x, w.y, 0.006);
  }

  updateTrail(now) {
    const n = this.trail.length;
    this.trailLine.visible = n >= 2;
    // 只在轨迹变了（有新样本）时重建几何体，不再每帧分配
    const key = `${now}:${n}`;
    if (n < 2 || key === this.trailKey) return;
    this.trailKey = key;
    const positions = [];
    const colors = [];
    const fade = new THREE.Color(0x1b3a6b);
    const bright = new THREE.Color(0xffffff);
    for (const p of this.trail) {
      positions.push(p.x, p.y, 0.003);
      const c = fade.clone().lerp(bright, (1 - (now - p.t) / TRAIL_MS) ** 1.3);
      colors.push(c.r, c.g, c.b);
    }
    const g = new LineGeometry();
    g.setPositions(positions);
    g.setColors(colors);
    this.trailLine.geometry.dispose();
    this.trailLine.geometry = g;
  }

  onPointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.pickPlane)[0];
    if (!hit) {
      this.pointerPx = null;
      return;
    }
    const s = this.layout.G / DZ;
    const o = this.off ?? { x: 0, y: 0 };
    this.pointerPx = { x: this.layout.front.x + (hit.point.x - o.x) * s, y: this.layout.front.y - (hit.point.y - o.y) * s };
  }

  /** 连续 2 秒平均帧间隔超过 28 ms（低于约 35 帧）就把像素密度降到 1；很流畅时再升回去 */
  governDpr(now) {
    const g = (this.gov ??= { t0: now, n: 0, last: now });
    const dt = now - g.last;
    g.last = now;
    if (dt > 250) {
      g.t0 = now;
      g.n = 0;
      return;
    }
    g.n++;
    if (now - g.t0 < 2000) return;
    const avg = (now - g.t0) / g.n;
    const dpr = this.renderer.getPixelRatio();
    if (avg > 28 && dpr > 1) this.setDpr(1);
    else if (avg < 18 && dpr < this.maxDpr) this.setDpr(this.maxDpr);
    g.t0 = now;
    g.n = 0;
  }

  setDpr(dpr) {
    this.renderer.setPixelRatio(dpr);
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const s = this.safe;
    const vw = s ? Math.max(w - s.left - s.right, 1) : w;
    const vh = s ? Math.max(h - s.top - s.bottom, 1) : h;
    this.camera.aspect = vw / vh;
    if (s) this.camera.setViewOffset(vw, vh, -s.left, -s.top, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    for (const m of this.lineMaterials) m.resolution.set(w, h);
    if (this.viewName && !this.userMoved) this.setView(this.viewName, true);
  }
}
