// 介绍页：打开网页先看到的地方。往下滑是几章介绍（开场 → 流程动画 → 传感器 → 指向 → 映射 → 随处可用 → 设备 → 开始），
// 后面钉着同一个 3D 场景：一台笔记本放在影棚光里，一对 AirPods 悬在屏幕正前方（像戴在一个看不见的头上，
// 我们站在这个人身后看），从两只耳机中间射出一道细光打到屏幕上，光标就在光落下的地方。
// 每一章给这个场景一个“镜头”：传感器一章推近到耳机、画出三根转轴；点击一章歪头点出波纹；随处可用一章关灯、
// 让头侧躺下来，光标照样跟着走。章节之间按滚动位置平滑过渡。
//
// 在任何一章点一下、或按回车，进入主场景（app.js 的 3D 书房）。↑ ↓ / 空格 / PageUp PageDown 翻章。
// 可选的背景歌：打开后一开始滑动就从“触不可及”那句放（ui/intro-song.js，默认关，见下面的 SONG）。
//
// 为什么要它：主场景要加载 three.js、角色模型、字体，第一次打开要一两秒才齐。介绍页的文字是写死在 HTML 里的，
// 一打开就有；这里的 3D 全是程序建模，不下载模型和环境贴图（环境光用 three.js 自带的 RoomEnvironment）。
// 看介绍的这段时间，主场景在后面加载好、先把着色器编译掉，点进去时直接就是完整的画面。
//
// 地址后面加 #app 可以跳过介绍页（调试时用）。

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { getLang, setLang, translateDom } from './i18n.js';
import { createSong } from './intro-song.js';
import { createFlowFx, flowPose, flowShot, FLOW_LOOP } from './cover-flow.js';

// 可选的背景歌（默认关）：enabled 改成 true，一开始滑动时就放。
// 歌曲版权不属于本项目，不进仓库；想要的话自己放一份到 web/public/audio/intro-song.m4a，start 是从第几秒开始放。
const SONG = { src: 'audio/intro-song.m4a', start: 0, enabled: false };

// 每一章的镜头，顺序和 index.html 里的章节一一对应。
// r 是相机离注视点的水平距离，y 是相机高度，look 是注视点，ang 是相机绕到哪一侧（弧度，0 = 正后方），orbit 是缓慢绕圈的幅度；
// shift = 1 时把画面推到文字的另一侧（宽屏推到右边，竖屏推到下面），night 是关灯的程度，lie 是头侧躺的程度，
// scene 是 3D 画面的不透明度，rings 是三根转轴的显示程度，pose 是头的动作（见 poseFor），seq 表示镜头不固定、按流程动画的时间走
// pod 是充电盒的显示程度：中间几章它离得远、会把画面撑宽（3D 自动取景时只能缩小），只在开场和最后一章出现
const SHOT = { r: 14.2, y: 3.6, look: [0, 2.05, 0.3], ang: 0, orbit: 0.12, shift: 0, night: 0, lie: 0, scene: 1, rings: 0, pose: 'demo', pod: 1 };
const SHOTS = [
  { ...SHOT }, // 开场
  { ...SHOT, seq: true, pose: 'flow', pod: 0 }, // 流程：同一个场景里分四段镜头，把过程放大拆开（ui/cover-flow.js），镜头按时间走
  { ...SHOT, r: 7, y: 2.3, look: [0, 1.0, 1.9], ang: 0.55, orbit: 0.05, shift: 1, rings: 1, pose: 'axes', pod: 0 }, // 传感器：推近到耳机，从斜后方看，三根轴都不是一条线
  { ...SHOT, r: 10.5, y: 3.0, look: [0, 1.25, 0.5], orbit: 0.1, shift: 1, pose: 'point', pod: 0 }, // 指向
  { ...SHOT, r: 9, y: 2.6, look: [0, 1.4, -0.1], orbit: 0.06, shift: 1, pose: 'click', pod: 0 }, // 映射：靠近屏幕看点击的波纹
  { ...SHOT, r: 10.5, y: 2.5, look: [0, 1.15, 0.6], ang: -0.25, orbit: 0.08, shift: 1, night: 1, lie: 1, pose: 'night', pod: 0 }, // 随处：关灯、躺下
  { ...SHOT, r: 15, y: 4.2, look: [0, 1.45, 0.3], orbit: 0.14, shift: 1, pod: 0 }, // 设备
  { ...SHOT, r: 17, y: 4.4, look: [0, 2.55, 0.3] }, // 开始：场景沉到文字下面
];

/** 头的动作。返回 yaw（右转为正）、pitch（抬头为正）、tilt（歪头，1 = 一次点击的幅度）、axis（传感器一章正在演示的轴） */
function poseFor(pose, t, ft = 0) {
  switch (pose) {
    case 'flow':
      return flowPose(ft);
    case 'axes': { // 三根轴轮流演示，每根 2.5 秒
      const k = (t % 7.5) / 2.5;
      const axis = Math.floor(k);
      const s = Math.sin((k - axis) * Math.PI * 2);
      return { yaw: axis === 0 ? s * 0.45 : 0, pitch: 0.04 + (axis === 1 ? s * 0.24 : 0), tilt: axis === 2 ? s * 1.25 : 0, axis };
    }
    case 'point': // 只指不点：光标在屏幕上画圈
      return { yaw: Math.sin(t * 0.9) * 0.32, pitch: 0.06 + Math.sin(t * 1.3 + 1) * 0.12, tilt: 0 };
    case 'click': { // 慢慢移动，每 2.4 秒歪头点一下
      const cyc = (t % 2.4) / 2.4;
      const tilt = cyc > 0.55 && cyc < 0.71 ? Math.sin(((cyc - 0.55) / 0.16) * Math.PI) : 0;
      return { yaw: Math.sin(t * 0.5) * 0.22, pitch: 0.05 + Math.sin(t * 0.7) * 0.08, tilt };
    }
    case 'night': // 躺着也照样指
      return { yaw: Math.sin(t * 0.6) * 0.26, pitch: 0.05 + Math.sin(t * 0.9 + 2) * 0.1, tilt: 0 };
    default: { // 开场、设备、开始：转头、点头，每 6.5 秒歪一下头点击
      const cyc = (t % 6.5) / 6.5;
      return {
        yaw: Math.sin((t * Math.PI * 2) / 6.5) * 0.34 + Math.sin(t * 1.7) * 0.04,
        pitch: 0.07 + Math.sin((t * Math.PI * 2) / 4.6) * 0.11,
        tilt: cyc > 0.2 && cyc < 0.28 ? Math.sin(((cyc - 0.2) / 0.08) * Math.PI) : 0,
      };
    }
  }
}

const smooth = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, k) => a + (b - a) * k;

const cover = document.getElementById('cover');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let entered = false;
let stop = null; // 停掉介绍页的渲染、释放显存
let song = null;

if (!cover || location.hash === '#app') {
  enter(true);
} else {
  setup();
}

function enter(instant = false) {
  if (entered) return;
  entered = true;
  song?.leave();
  document.body.classList.remove('covered');
  if (!cover) return;
  if (instant) {
    cover.remove();
    stop?.();
    return;
  }
  cover.classList.add('leaving');
  const done = () => {
    cover.remove();
    stop?.();
  };
  cover.addEventListener('transitionend', (e) => { if (e.target === cover) done(); }, { once: false });
  setTimeout(done, 1200); // transitionend 没来（比如标签页在后台）也要收尾
}

function setup() {
  const scroller = cover.querySelector('.cover-scroll');
  const chapters = [...cover.querySelectorAll('.ch')];

  // 右边的章节目录：每章一个点，悬停显示章名
  const nav = cover.querySelector('.cover-nav');
  const dots = chapters.map((ch, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span>${ch.dataset.label}</span>`;
    b.addEventListener('click', () => go(i));
    nav.append(b);
    return b;
  });

  // 右上角的语言和深浅切换：和主页面顶栏最右边的按钮是同一套设置、同一个位置
  translateDom(cover); // 上次选了英文：介绍页一出来就是英文，不用等主场景加载完
  for (const r of cover.querySelectorAll('input[name=cover-lang]')) {
    r.checked = r.value === getLang();
    r.addEventListener('change', () => setLang(r.value));
  }
  // 深浅：存到 nodlink.theme，主场景收到 nodlink:theme 后跟着换
  const themeBtn = cover.querySelector('.theme-btn');
  themeBtn?.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const mode = dark ? 'light' : 'dark';
    root.dataset.theme = mode;
    try { localStorage.setItem('nodlink.theme', JSON.stringify(mode)); } catch {}
    window.dispatchEvent(new CustomEvent('nodlink:theme', { detail: mode }));
  });

  // 背景歌
  const musicBtn = cover.querySelector('.music-btn');
  const musicPill = cover.querySelector('.cover-music');
  if (SONG.enabled) song = createSong({
    ...SONG,
    onState: (s) => {
      musicBtn.hidden = s === 'none';
      musicBtn.setAttribute('aria-pressed', String(s !== 'muted'));
      musicPill.hidden = s !== 'blocked' || entered;
    },
  });
  musicBtn.addEventListener('click', () => song?.setMuted(!song.muted));
  musicPill.addEventListener('click', () => song?.playNow());

  // 点一下进入；右上角按钮、章节目录、放音乐的按钮不算
  cover.addEventListener('click', (e) => {
    if (e.target.closest('.cover-top, .cover-nav, .cover-music')) return;
    enter();
  });
  // 一开始滑动就放歌：滚动、滚轮、触摸滑动都算
  scroller.addEventListener('scroll', () => { if (scroller.scrollTop > 8) song?.want(); }, { passive: true });
  // 用滚轮、手指自己滑了：之前按键定下的目标章作废
  cover.addEventListener('wheel', (e) => { goal = null; if (Math.abs(e.deltaY) > 4) song?.want(); }, { passive: true });
  cover.addEventListener('touchmove', () => { goal = null; song?.want(); }, { passive: true });

  // 介绍页盖着时，按键不要漏给主场景（空格是离合、C 是回中）。按键是浏览器认的“用户操作”，顺便补上被拦下的歌
  window.addEventListener('keydown', (e) => {
    if (entered) return;
    e.stopPropagation();
    if (e.target.closest?.('.cover-top')) return; // 在语言、深浅按钮上按空格回车：让按钮自己处理
    const next = { ArrowDown: 1, PageDown: 1, ' ': e.shiftKey ? -1 : 1, ArrowUp: -1, PageUp: -1 }[e.key];
    if (next) {
      e.preventDefault();
      song?.want();
      go((goal ?? active) + next);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      go(e.key === 'Home' ? 0 : chapters.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      enter();
    }
    song?.unlock();
  }, true);

  // 滚动位置 → 章节进度（0 = 开场，1 = 传感器……可以是小数）。章节可能比一屏高（窄屏文字多），按每章的顶边算
  let active = 0;
  let flowT0 = performance.now(); // 流程一章的动画从哪一刻开始算：每次切到这一章都从头播
  let goal = null; // 正在平滑滚向的那一章：连按几下 ↓ 时一章一章往下数，不会因为还没滚到而原地踏步
  const progress = () => {
    const y = scroller.scrollTop;
    for (let i = chapters.length - 1; i >= 0; i--) {
      const top = chapters[i].offsetTop;
      if (y >= top || i === 0) {
        const nextTop = chapters[i + 1]?.offsetTop;
        return nextTop == null ? i : i + Math.min(Math.max((y - top) / (nextTop - top), 0), 1);
      }
    }
    return 0;
  };
  function go(i) {
    i = Math.min(Math.max(i, 0), chapters.length - 1);
    goal = i;
    scroller.scrollTo({ top: chapters[i].offsetTop, behavior: reduced ? 'auto' : 'smooth' });
  }
  const markActive = (p) => {
    const i = Math.round(p);
    if (goal != null && Math.abs(p - goal) < 0.02) goal = null;
    if (i === active && dots[i].classList.contains('on')) return;
    active = i;
    if (SHOTS[i]?.seq) flowT0 = performance.now();
    dots.forEach((d, k) => {
      d.classList.toggle('on', k === i);
      if (k === i) d.setAttribute('aria-current', 'step');
      else d.removeAttribute('aria-current');
    });
    chapters.forEach((c, k) => c.classList.toggle('on', k === i));
  };
  markActive(0);

  const canvas = cover.querySelector('canvas');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    // 没有 WebGL：只留文字，章节目录照常
    scroller.addEventListener('scroll', () => markActive(progress()), { passive: true });
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-3, 6, 4);
  const rim = new THREE.DirectionalLight(0xdfe6ff, 1.1);
  rim.position.set(4, 3, -5);
  scene.add(key, rim);

  const world = new THREE.Group();
  scene.add(world);

  // ---------- 笔记本 ----------
  const alu = new THREE.MeshPhysicalMaterial({ color: 0xd4d6dc, metalness: 1, roughness: 0.32, clearcoat: 0.2 });
  const dark = new THREE.MeshPhysicalMaterial({ color: 0x0c0c10, roughness: 0.5, metalness: 0.2 });
  const W = 3.1;
  const D = 2.15;
  const base = new THREE.Mesh(new RoundedBoxGeometry(W, 0.09, D, 4, 0.04), alu);
  base.position.y = 0.045;
  const kb = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.86, D * 0.38), new THREE.MeshStandardMaterial({ map: keyboardTexture(), roughness: 0.6 }));
  kb.rotation.x = -Math.PI / 2;
  kb.position.set(0, 0.0905, -D * 0.17);
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.36, D * 0.27), new THREE.MeshPhysicalMaterial({ color: 0xc9ccd3, metalness: 0.9, roughness: 0.22 }));
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(0, 0.0908, D * 0.27);
  // 屏幕：绕后边的铰链往后仰 ~105°
  const lid = new THREE.Group();
  lid.position.set(0, 0.09, -D / 2 + 0.03);
  lid.rotation.x = -0.24;
  const shell = new THREE.Mesh(new RoundedBoxGeometry(W, D * 0.98, 0.06, 4, 0.03), alu);
  shell.position.set(0, D * 0.49, -0.03);
  const bezel = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.06, D * 0.98 - 0.06), dark);
  bezel.position.set(0, D * 0.49, 0.0015);
  const SW = W - 0.2;
  const SH = D * 0.98 - 0.22;
  const screenTex = screenTexture();
  const display = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }));
  display.position.set(0, D * 0.49 + 0.02, 0.003);
  lid.add(shell, bezel, display);
  // 光标和点击波纹，贴在屏幕上
  const cursor = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.13), new THREE.MeshBasicMaterial({ map: cursorTexture(), transparent: true, toneMapped: false, depthWrite: false }));
  cursor.position.z = 0.006;
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.068, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, toneMapped: false, depthWrite: false }));
  ripple.position.z = 0.005;
  display.add(cursor, ripple);
  const laptop = new THREE.Group();
  laptop.add(base, kb, pad, lid);
  world.add(laptop);

  // ---------- AirPods：一对耳机悬在屏幕正前方，充电盒放在左边桌上 ----------
  const gloss = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08 });
  const caseBody = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.5, 0.26, 6, 0.12), gloss);
  caseBody.position.set(0, 0.25, 0);
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.004, 0.262), new THREE.MeshStandardMaterial({ color: 0xcfcfd4, roughness: 0.5 }));
  seam.position.set(0, 0.36, 0);
  const led = new THREE.Mesh(new THREE.CircleGeometry(0.012, 16), new THREE.MeshBasicMaterial({ color: 0x4ade80, toneMapped: false }));
  led.position.set(0, 0.26, 0.131);
  const podCase = new THREE.Group();
  podCase.add(caseBody, seam, led);
  podCase.position.set(-2.75, 0, 0.95);
  podCase.rotation.y = 0.45;
  world.add(podCase);

  // 头：一个看不见的头，两只耳机挂在两侧，一起转。面朝屏幕（-z），镜头在它身后
  const HEAD = new THREE.Vector3(0, 0.98, 2.35);
  const head = new THREE.Group();
  head.position.copy(HEAD);
  head.rotation.order = 'YXZ';
  world.add(head);
  for (const side of [-1, 1]) {
    const bud = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.17, 40, 28), gloss);
    shell.scale.set(0.92, 1, 1.12);
    // 耳塞朝里（朝向看不见的耳朵），柄朝下、略朝前
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.08, 24, 16), new THREE.MeshPhysicalMaterial({ color: 0x2a2a30, roughness: 0.6 }));
    tip.position.set(side * -0.11, 0.02, 0);
    tip.scale.set(0.4, 0.75, 0.6);
    const stem = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.2, 8, 20), gloss);
    stem.position.set(side * 0.02, -0.21, -0.05);
    stem.rotation.set(-0.12, 0, side * 0.1);
    bud.add(shell, tip, stem);
    bud.position.set(side * 0.46, 0, 0);
    head.add(bud);
  }
  // 头指出去的那道光：从两只耳机中间到屏幕上的落点
  const beamMat = new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.55, toneMapped: false, depthWrite: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 1, 12, 1, true), beamMat);
  const origin = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), beamMat);
  world.add(beam, origin);
  const hitGlow = new THREE.Mesh(new THREE.CircleGeometry(0.09, 32), new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false }));
  hitGlow.position.z = 0.004;
  display.add(hitGlow);

  // 传感器一章的三根转轴：绕竖直轴转（左右转头，绿）、绕左右轴转（抬头低头，红）、绕前后轴转（歪头，蓝），
  // 颜色和调试台里 x 红 / y 绿 / z 蓝 的约定一致。正在演示的那根亮，另外两根淡
  const ringGeo = new THREE.TorusGeometry(0.74, 0.007, 8, 120);
  const rings = { yaw: 0x34c759, pitch: 0xff3b30, roll: 0x0071e3 };
  for (const [name, color] of Object.entries(rings)) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }));
    m.position.copy(HEAD);
    if (name === 'yaw') m.rotation.x = Math.PI / 2;
    if (name === 'pitch') m.rotation.y = Math.PI / 2;
    world.add(m);
    rings[name] = m;
  }
  const axisNames = ['yaw', 'pitch', 'roll'];
  const axisItems = [...cover.querySelectorAll('.axes [data-axis]')];
  let shownAxis = -1;

  // 流程一章的辅助线和特效
  const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const flowFx = createFlowFx({ world, display, head, SW, SH, isDark });
  const FLOW_IDX = SHOTS.findIndex((s) => s.seq);
  const flowCaps = [...cover.querySelectorAll('.flow-caps li')];
  const bubble = cover.querySelector('.flow-bubble');
  const bubbleAt = new THREE.Vector3();
  let shownCap = -2;

  // 软阴影：画在地上的几块模糊椭圆，不用阴影贴图
  const shadowTex = blobTexture();
  const shadow = (w, d, x, z, o) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: o, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.001, z);
    world.add(m);
    return m;
  };
  shadow(W * 1.35, D * 1.5, 0, 0, 0.55);
  const caseShadow = shadow(1.0, 0.75, -2.75, 0.95, 0.5);
  const headShadow = shadow(1.7, 0.7, 0, HEAD.z, 0.2);

  // 主题：光束在深色底上用亮一点的蓝
  const applyTheme = () => {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    beamMat.color.setHex(dark ? 0x2997ff : 0x0071e3);
    hitGlow.material.color.setHex(dark ? 0x2997ff : 0x0071e3);
  };
  applyTheme();
  window.addEventListener('nodlink:theme', applyTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  // ---------- 镜头、尺寸 ----------
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  cover.addEventListener('pointermove', (e) => {
    pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
  });
  let vw = 1;
  let vh = 1;
  const resize = () => {
    vw = cover.clientWidth;
    vh = cover.clientHeight;
    renderer.setSize(vw, vh, false);
    camera.aspect = vw / vh;
    // 竖屏时拉远，三样东西都放得下
    camera.fov = camera.aspect < 1 ? 46 : 30;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(cover);
  resize();

  // ---------- 自动取景：3D 填满文字旁边剩下的那块 ----------
  // 每一章量一次“留给 3D 的区域”（相对这一章顶边，滚到这一章时就是屏幕坐标）：
  //   侧排的章节：文字实际占到的右边 + 间距 → 内容区右边；上下都到内容区边上
  //   开场、开始（和竖屏）：文字下面 → 底部提示上面
  // 每一帧把场景里的东西（笔记本、耳机、充电盒、转轴圆环）投到屏幕上量出外框，再用 setViewOffset 缩放、平移，
  // 让外框正好落进这块区域。只缩放和平移，不拉伸，所以不变形；外框在区域里，所以不压文字、不出画面
  let regions = [];
  const textRange = document.createRange();
  const measureRegions = () => {
    const cs = getComputedStyle(cover);
    const padX = parseFloat(cs.getPropertyValue('--pad-x')) || 0;
    const landscape = vw / vh >= 1.25 && padX > 0;
    const px = landscape ? (padX / 100) * vw : 24;
    const py = landscape ? (parseFloat(cs.getPropertyValue('--pad-y')) / 100) * vh : 24;
    const gap = Math.max(24, vw * 0.035);
    regions = chapters.map((ch) => {
      const cr = ch.getBoundingClientRect();
      const text = ch.querySelector('.ch-text, .flow-caps, .cover-copy');
      if (!text) return null;
      textRange.selectNodeContents(text);
      // 文字实际占到的范围（块元素本身会撑满整列）；流程一章的说明按时间换着亮、宽度会变，用整列的宽度，3D 不跟着跳
      const tr = text.classList.contains('flow-caps') ? text.getBoundingClientRect() : textRange.getBoundingClientRect();
      const stacked = !landscape || ch.classList.contains('ch-hero') || ch.classList.contains('ch-end');
      if (stacked) {
        const foot = ch.querySelector('.cover-foot');
        const top = tr.bottom - cr.top + gap * 0.6;
        const bottom = foot ? foot.getBoundingClientRect().top - cr.top - gap * 0.4 : vh - py;
        return { x: px, y: top, w: vw - 2 * px, h: Math.max(bottom - top, vh * 0.2) };
      }
      const left = tr.right - cr.left + gap;
      return { x: left, y: py, w: Math.max(vw - px - left, vw * 0.2), h: vh - 2 * py };
    });
  };
  document.fonts?.ready.then(measureRegions);
  const fit = { z: 1, bx: vw / 2, by: vh / 2, rx: vw / 2, ry: vh / 2, ready: false };
  const fitPts = [];
  const podPts = [];
  {
    // 笔记本：底座四角 + 屏幕上沿两角（屏幕绕铰链往后仰 0.24 弧度，上沿在 y≈2.14、z≈-1.55）
    for (const x of [-W / 2, W / 2]) {
      for (const z of [-D / 2, D / 2]) fitPts.push(new THREE.Vector3(x, 0, z));
      fitPts.push(new THREE.Vector3(x, 0.09 + D * 0.98 * Math.cos(0.24), -D / 2 - D * 0.98 * Math.sin(0.24)));
    }
    // 充电盒
    for (const dx of [-0.38, 0.38]) for (const y of [0, 0.5]) podPts.push(new THREE.Vector3(-2.75 + dx, y, 0.95));
    // 头上的两只耳机（含耳机柄）
    for (const x of [-0.66, 0.66]) for (const y of [-0.62, 0.22]) fitPts.push(new THREE.Vector3(x, HEAD.y + y, HEAD.z));
  }
  const ringPts = [];
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) ringPts.push(new THREE.Vector3(dx * 0.76, HEAD.y + dy * 0.76, HEAD.z + dz * 0.76));
  const proj = new THREE.Vector3();
  const frameScene = (i0, i1, a, ringsOn, podOn, dt) => {
    if (!regions.length || frameScene.n++ % 30 === 0 || frameScene.size !== `${vw}x${vh}`) {
      frameScene.size = `${vw}x${vh}`;
      measureRegions();
    }
    const r0 = regions[i0];
    const r1 = regions[i1] ?? r0;
    if (!r0) return camera.clearViewOffset();
    const rg = { x: lerp(r0.x, r1.x, a), y: lerp(r0.y, r1.y, a), w: lerp(r0.w, r1.w, a), h: lerp(r0.h, r1.h, a) };
    camera.clearViewOffset();
    camera.updateMatrixWorld();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (v) => {
      proj.copy(v);
      world.localToWorld(proj).project(camera);
      const sx = ((proj.x + 1) / 2) * vw;
      const sy = ((1 - proj.y) / 2) * vh;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    };
    fitPts.forEach(add);
    if (ringsOn) ringPts.forEach(add);
    if (podOn) podPts.forEach(add);
    const zt = Math.min(rg.w / Math.max(x1 - x0, 1), rg.h / Math.max(y1 - y0, 1)) * 0.93;
    const target = { z: zt, bx: (x0 + x1) / 2, by: (y0 + y1) / 2, rx: rg.x + rg.w / 2, ry: rg.y + rg.h / 2 };
    const k = fit.ready && !reduced ? 1 - Math.exp(-dt / 0.12) : 1;
    for (const key of ['z', 'bx', 'by', 'rx', 'ry']) fit[key] += (target[key] - fit[key]) * k;
    fit.ready = true;
    camera.setViewOffset(vw, vh, fit.bx - fit.rx / fit.z, fit.by - fit.ry / fit.z, vw / fit.z, vh / fit.z);
  };
  frameScene.n = 0;
  window.addEventListener('nodlink:lang', () => setTimeout(measureRegions, 50));

  // ---------- 动画 ----------
  const t0 = performance.now();
  const rayO = new THREE.Vector3();
  const rayD = new THREE.Vector3();
  const planeP = new THREE.Vector3();
  const planeN = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const local = new THREE.Vector3();
  const look = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const eul = new THREE.Euler(0, 0, 0, 'YXZ');
  let raf = 0;
  let pv = 0; // 跟着滚动位置走、但带一点阻尼的章节进度：滚轮一格一格地跳，镜头要连贯
  let lastT = performance.now();
  let tiltDown = false;
  let night = 0;
  let nightClass = false;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    const t = reduced ? 1.2 : (performance.now() - t0) / 1000;
    const p = progress();
    markActive(p);
    const now = performance.now();
    const dt = Math.min((now - lastT) / 1000, 0.5);
    lastT = now;
    pv = reduced ? p : pv + (p - pv) * (1 - Math.exp(-dt / 0.2)); // 按时间算阻尼：掉帧时也照样跟上
    const i0 = Math.min(Math.floor(pv), SHOTS.length - 1);
    const i1 = Math.min(i0 + 1, SHOTS.length - 1);
    const a = smooth(Math.min(Math.max(pv - i0, 0), 1));
    // 流程一章：这一轮里的时间 ft，以及它的显示程度
    const ft = reduced ? 4.2 : ((now - flowT0) / 1000) % FLOW_LOOP;
    const wFlow = Math.max(0, 1 - Math.abs(pv - FLOW_IDX));
    // 镜头参数：流程那一章按时间取，其它章节固定
    const s0 = SHOTS[i0].seq ? { ...SHOTS[i0], ...flowShot(ft) } : SHOTS[i0];
    const s1 = SHOTS[i1].seq ? { ...SHOTS[i1], ...flowShot(ft) } : SHOTS[i1];
    const mix = (k) => lerp(s0[k], s1[k], a);

    // 头的动作：两章的动作按进度混合
    const p0 = poseFor(s0.pose, t, ft);
    const p1 = poseFor(s1.pose, t, ft);
    const yaw = lerp(p0.yaw, p1.yaw, a);
    const pitch = lerp(p0.pitch, p1.pitch, a);
    const tilt = lerp(p0.tilt, p1.tilt, a);
    const lie = mix('lie');
    // 面朝 -z：往右转是绕 y 轴负方向转；抬头是绕 x 轴正方向；向左歪头（点击）= 头顶往左，绕 z 轴正方向。躺下 = 整个头绕前后轴侧过去
    head.rotation.set(pitch, -yaw, tilt * 0.35 + lie * 1.2);
    head.position.y = HEAD.y + Math.sin(t * 1.3) * 0.03 - lie * 0.22;
    headShadow.material.opacity = 0.2 - Math.sin(t * 1.3) * 0.02;

    // 三根转轴：只在传感器一章附近出现
    const wSensor = Math.max(0, mix('rings') * 1.6 - 0.6);
    const axis = p0.axis ?? p1.axis ?? -1;
    axisNames.forEach((n, k) => { rings[n].material.opacity = wSensor * (k === axis ? 0.95 : 0.16); });
    const showAxis = wSensor > 0.5 ? axis : -1;
    if (showAxis !== shownAxis) {
      shownAxis = showAxis;
      axisItems.forEach((el, k) => el.classList.toggle('on', k === showAxis));
    }

    // 关灯：灯光、环境光一起暗下去，屏幕和光束是自发光，留在黑暗里
    night = mix('night');
    key.intensity = 1.6 * (1 - 0.9 * night);
    rim.intensity = 1.1 * (1 - 0.75 * night);
    scene.environmentIntensity = 1 - 0.88 * night;
    beamMat.opacity = 0.55 + 0.35 * night;
    cover.style.setProperty('--night', night.toFixed(3));
    if (night > 0.5 !== nightClass) {
      nightClass = night > 0.5;
      cover.classList.toggle('night', nightClass);
    }

    // 光标 = 头的朝向和屏幕平面的交点：光落在哪，光标就在哪，对应关系一目了然
    scene.updateMatrixWorld();
    head.getWorldPosition(rayO);
    // 躺下时头的“前方”不变：先去掉侧躺的那一下再算朝向
    q.setFromEuler(eul.set(pitch, -yaw, 0));
    rayD.set(0, 0, -1).applyQuaternion(q);
    display.getWorldPosition(planeP);
    planeN.set(0, 0, 1).applyQuaternion(display.getWorldQuaternion(q));
    const denom = rayD.dot(planeN);
    if (denom < -1e-3) {
      const k = planeP.clone().sub(rayO).dot(planeN) / denom;
      hit.copy(rayO).addScaledVector(rayD, k);
      local.copy(hit);
      display.worldToLocal(local);
      local.x = THREE.MathUtils.clamp(local.x, -SW / 2 + 0.06, SW / 2 - 0.06);
      local.y = THREE.MathUtils.clamp(local.y, -SH / 2 + 0.06, SH / 2 - 0.06);
      // 箭头的尖在贴图左上角：把贴图往右下挪，让尖正好落在光点上
      cursor.position.set(local.x + 0.045, local.y - 0.05, 0.006);
      hitGlow.position.set(local.x, local.y, 0.004);
      hit.copy(local);
      display.localToWorld(hit);
      // 光束：耳机中间 → 落点
      const len = rayO.distanceTo(hit);
      beam.position.copy(rayO).lerp(hit, 0.5);
      beam.scale.set(1, len, 1);
      beam.quaternion.setFromUnitVectors(up, hit.clone().sub(rayO).normalize());
      origin.position.copy(rayO);
    }
    // 歪头到位的那一下，屏幕上点出一圈波纹（传感器一章只演示转轴，不点）
    const clicking = tilt > 0.8 && wSensor < 0.5 && wFlow < 0.5; // 流程一章的点击由它自己按时间点
    if (clicking && !tiltDown) {
      ripple.userData.t = t;
      ripple.position.set(local.x, local.y, 0.005);
    }
    tiltDown = tilt > 0.8;
    const rp = ripple.userData.t == null ? 1 : (t - ripple.userData.t) / 0.6;
    ripple.visible = rp >= 0 && rp < 1;
    if (ripple.visible) {
      ripple.scale.setScalar(0.6 + rp * 2.2);
      ripple.material.opacity = 1 - rp;
    }

    const fl = flowFx.update({ w: wFlow, ft, pose: { yaw, pitch, tilt }, center: rayO, local, camera, width: vw, height: vh });

    // 镜头：按章节插值，缓慢地绕一点，再跟着鼠标轻轻偏
    pointer.x += (pointer.tx - pointer.x) * 0.04;
    pointer.y += (pointer.ty - pointer.y) * 0.04;
    const portrait = camera.aspect < 1;
    look.set(lerp(s0.look[0], s1.look[0], a), lerp(s0.look[1], s1.look[1], a), lerp(s0.look[2], s1.look[2], a));
    const ang = mix('ang') + (reduced ? 0 : Math.sin(t * 0.18) * mix('orbit')) + pointer.x * 0.08;
    const r = mix('r') * (portrait ? 1.45 : 1);
    camera.position.set(look.x + Math.sin(ang) * r, mix('y') - pointer.y * 0.3, look.z + Math.cos(ang) * r);
    camera.lookAt(look);
    // 把画面推到文字另一侧：宽屏往右（最多推 280px，和文字一起收在中间那一列），竖屏往下
    const shift = mix('shift');
    cover.style.setProperty('--shift', shift.toFixed(3));
    // 取景交给 frameScene：3D 自动缩放、平移到文字旁边留给它的那块（见上面）
    const pod = mix('pod');
    podCase.scale.setScalar(Math.max(smooth(pod), 0.001));
    podCase.visible = pod > 0.01;
    caseShadow.material.opacity = 0.5 * pod;
    frameScene(i0, i1, a, mix('rings') > 0.02, pod > 0.3, dt);
    // 流程一章的说明文字和说话气泡（相机这一帧已经摆好，按它把嘴的位置投到屏幕上）
    const capOn = fl && wFlow > 0.5 ? fl.phase : -1;
    if (capOn !== shownCap) {
      shownCap = capOn;
      flowCaps.forEach((el, k) => el.classList.toggle('on', k === capOn));
    }
    const talk = !!fl && wFlow > 0.7 && fl.talking;
    if (talk) {
      camera.updateMatrixWorld();
      bubbleAt.copy(fl.mouth).project(camera);
      bubble.style.setProperty('--bx', `${(((bubbleAt.x + 1) / 2) * vw + 18).toFixed(1)}px`);
      bubble.style.setProperty('--by', `${(((1 - bubbleAt.y) / 2) * vh - 64).toFixed(1)}px`);
    }
    bubble.classList.toggle('on', talk);
    const shown = mix('scene');
    canvas.style.opacity = shown.toFixed(3);
    if (shown > 0.01) renderer.render(scene, camera);
  };
  tick();

  stop = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      for (const m of [].concat(o.material ?? [])) {
        m.map?.dispose();
        m.dispose();
      }
    });
    env.dispose();
    renderer.dispose();
  };
}

// ---------- 程序生成的贴图 ----------

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 屏幕：紫粉渐变的桌面、菜单栏、一扇窗口和程序坞 */
function screenTexture() {
  return canvasTex(1024, 640, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#1b1440');
    bg.addColorStop(0.55, '#5b3d9e');
    bg.addColorStop(0.85, '#e86fa8');
    bg.addColorStop(1, '#ffb07a');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const glow = g.createRadialGradient(w * 0.7, h * 0.35, 10, w * 0.7, h * 0.35, w * 0.5);
    glow.addColorStop(0, 'rgba(140,200,255,0.45)');
    glow.addColorStop(1, 'rgba(140,200,255,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, 0, w, 22);
    // 窗口
    const rr = (x, y, ww, hh, r) => {
      g.beginPath();
      g.roundRect(x, y, ww, hh, r);
    };
    g.fillStyle = 'rgba(255,255,255,0.86)';
    rr(w * 0.12, h * 0.16, w * 0.46, h * 0.5, 16);
    g.fill();
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
      g.fillStyle = c;
      g.beginPath();
      g.arc(w * 0.12 + 22 + i * 20, h * 0.16 + 20, 6, 0, Math.PI * 2);
      g.fill();
    });
    g.fillStyle = 'rgba(30,20,60,0.12)';
    for (let i = 0; i < 5; i++) {
      rr(w * 0.12 + 28, h * 0.16 + 56 + i * 44, w * 0.46 - 56 - (i % 2) * 90, 22, 8);
      g.fill();
    }
    // 程序坞
    g.fillStyle = 'rgba(255,255,255,0.28)';
    rr(w * 0.3, h - 70, w * 0.4, 54, 16);
    g.fill();
    ['#ff7cba', '#b18cff', '#66d6ff', '#9ef0c4', '#ffd36e', '#ffffff'].forEach((c, i) => {
      g.fillStyle = c;
      rr(w * 0.3 + 18 + i * ((w * 0.4 - 36) / 6), h - 60, 36, 36, 9);
      g.fill();
    });
  });
}

function keyboardTexture() {
  return canvasTex(512, 220, (g, w, h) => {
    g.fillStyle = '#1a1a20';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#0d0d11';
    const cols = 14;
    const rows = 5;
    const kw = w / cols;
    const kh = h / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        g.beginPath();
        g.roundRect(c * kw + 3, r * kh + 3, kw - 6, kh - 6, 4);
        g.fill();
      }
    }
  });
}

/** macOS 风格的白色箭头光标，黑描边 */
function cursorTexture() {
  return canvasTex(128, 128, (g) => {
    g.translate(28, 14);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, 84);
    g.lineTo(20, 66);
    g.lineTo(33, 96);
    g.lineTo(46, 90);
    g.lineTo(33, 61);
    g.lineTo(60, 61);
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 7;
    g.strokeStyle = '#111';
    g.stroke();
    g.fillStyle = '#fff';
    g.fill();
  });
}

function blobTexture() {
  return canvasTex(256, 256, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, 'rgba(0,0,0,0.9)');
    r.addColorStop(0.5, 'rgba(0,0,0,0.35)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, w, h);
  });
}
