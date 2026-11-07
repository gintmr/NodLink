// 控制台 3D 场景的背景粒子：空旷的背景里飘着两种东西，都很淡，不抢机器人和显示器的戏。
//   光点：小圆点慢慢往上漂、左右轻摆，忽明忽暗
//   方块：小方框缓缓上浮、自转；一道光波从左往右扫过，扫到的方块依次亮起一圈淡淡的荧光
// 颜色取场景里那条粉 → 紫 → 青的渐变。深色模式用叠加混合，真正发光；浅色模式白底上叠加看不见，
// 改成普通混合、颜色压深一点，像纸面上的一层淡彩。
// 全部在着色器里按时间算位置，CPU 每帧只更新一个时间值。粒子围着场景撒成一整圈（360°），中间留空，离镜头近的淡掉。

import * as THREE from 'three';

const PALETTE = [new THREE.Color('#ff7cba'), new THREE.Color('#b18cff'), new THREE.Color('#66d6ff')];

const VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSpeed;
  uniform vec2 uYRange;
  uniform float uSquare;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  varying float vPulse;
  void main() {
    vec3 p = position;
    float h = uYRange.y - uYRange.x;
    // 往上漂，到顶后从底下重新出来；上下两端淡出，看不到“跳回去”
    p.y = uYRange.x + mod(p.y - uYRange.x + uTime * uSpeed * (0.55 + aSeed * 0.9), h);
    p.x += sin(uTime * 0.23 + aSeed * 40.0) * 0.35;
    p.z += cos(uTime * 0.19 + aSeed * 23.0) * 0.25;
    float edge = smoothstep(0.0, 0.12, (p.y - uYRange.x) / h) * (1.0 - smoothstep(0.82, 1.0, (p.y - uYRange.x) / h));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = -mv.z;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = min(aSize * (38.0 / dist), aSize * 2.2) * uPixelRatio; // 离得再近也不超过 2.2 倍原大小
    // 太近的不画（不挡主体），太远的淡掉
    float far = (1.0 - smoothstep(16.0, 46.0, dist)) * smoothstep(8.0, 12.0, dist);
    // 方块：一道光波从左往右扫，扫到的依次亮起；光点：各自慢慢明灭
    float wave = sin(uTime * 0.9 - p.x * 0.42 - p.z * 0.12);
    float pulse = uSquare > 0.5 ? pow(max(wave, 0.0), 10.0) : 0.5 + 0.5 * sin(uTime * (0.8 + aSeed) + aSeed * 30.0);
    vPulse = pulse;
    vAlpha = edge * far;
    vColor = aColor;
    vSeed = aSeed;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uSquare;
  uniform float uNight;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  varying float vPulse;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a;
    if (uSquare > 0.5) {
      // 自转的小方框：一圈细边 + 外面一层荧光，亮起时荧光变强
      float ang = uTime * (0.25 + vSeed * 0.4) + vSeed * 6.28;
      c = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c;
      float d = max(abs(c.x), abs(c.y));
      float frame = (1.0 - smoothstep(0.25, 0.27, d)) - (1.0 - smoothstep(0.195, 0.215, d));
      float fill = (1.0 - smoothstep(0.2, 0.25, d)) * 0.12;
      float glow = exp(-pow(max(d - 0.24, 0.0) * 9.0, 2.0)) * (1.0 - smoothstep(0.24, 0.5, d));
      a = frame * (0.35 + 0.65 * vPulse) + fill * (0.4 + vPulse) + glow * vPulse * 0.9;
    } else {
      float d = length(c);
      float core = 1.0 - smoothstep(0.0, 0.16, d);
      float glow = exp(-d * d * 22.0);
      a = core * 0.8 + glow * 0.45;
      a *= 0.35 + 0.65 * vPulse;
    }
    a *= vAlpha * uOpacity;
    if (a < 0.003) discard;
    // 浅色模式：颜色压深，普通混合；深色模式：叠加，亮的地方再提一点
    vec3 col = uNight > 0.5 ? vColor * (1.0 + vPulse * 0.6) : vColor * 0.82;
    gl_FragColor = vec4(col, a);
  }
`;

const CENTER = [-0.3, -2]; // 场景中心（x, z）：机器人和显示器之间
const RING = [9, 26]; // 粒子环的内外半径

function field(count, { square, yRange, speed, size }) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const sz = new Float32Array(count);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // 围着场景一整圈（镜头怎么绕都看得到）：以机器人和显示器中间为圆心，半径 9～26 的环里均匀撒，
    // 中间空出来，不挡主体；离镜头太近的由着色器淡掉
    const ang = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random() * (RING[1] ** 2 - RING[0] ** 2) + RING[0] ** 2);
    const x = CENTER[0] + Math.sin(ang) * r;
    const z = CENTER[1] - Math.cos(ang) * r;
    pos.set([x, yRange[0] + Math.random() * (yRange[1] - yRange[0]), z], i * 3);
    seed[i] = Math.random();
    sz[i] = size[0] + Math.random() * (size[1] - size[0]);
    // 颜色绕一圈渐变：正后方粉、两侧紫、正前方青，首尾接得上
    const t = Math.min(Math.max(1 - Math.cos(ang) + (Math.random() - 0.5) * 0.3, 0), 2);
    (t < 1 ? c.copy(PALETTE[0]).lerp(PALETTE[1], t) : c.copy(PALETTE[1]).lerp(PALETTE[2], t - 1)).toArray(col, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const m = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSpeed: { value: speed },
      uYRange: { value: new THREE.Vector2(...yRange) },
      uSquare: { value: square ? 1 : 0 },
      uNight: { value: 0 },
      uOpacity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = -2;
  return pts;
}

export class ParticleField {
  constructor(scene) {
    this.group = new THREE.Group();
    this.dots = field(560, { square: false, yRange: [-6, 10], speed: 0.16, size: [3, 8] });
    this.squares = field(170, { square: true, yRange: [-6, 10], speed: 0.1, size: [12, 24] });
    this.group.add(this.dots, this.squares);
    scene.add(this.group);
  }

  /** 深色：叠加发光；浅色：普通混合，淡一点 */
  setNight(night) {
    for (const p of [this.dots, this.squares]) {
      const m = p.material;
      m.uniforms.uNight.value = night ? 1 : 0;
      m.uniforms.uOpacity.value = night ? 1 : 0.6;
      m.blending = night ? THREE.AdditiveBlending : THREE.NormalBlending;
      m.needsUpdate = true;
    }
  }

  update(timeSec, pixelRatio) {
    for (const p of [this.dots, this.squares]) {
      p.material.uniforms.uTime.value = timeSec;
      p.material.uniforms.uPixelRatio.value = pixelRatio;
    }
  }

  set visible(v) {
    this.group.visible = v;
  }
}
