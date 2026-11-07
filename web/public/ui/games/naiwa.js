// 奶蛙：一只跟着你的头动的奶蛙（108 帧手绘逐帧动画，sprites/naiwa/frame-000…107.png）。
//   头不动        它站着
//   上下点头      它捧着肚子大笑，而且完全跟着你的头：你低下去它蹲下去，你抬起来它站起来，
//                 点得快它笑得快、点得浅它只蹲一点，头停它也停；笑声的快慢跟着点头的快慢
//   回正          头回到中线、不再上下动，它就收笑站好
//   左右转头      它立刻扎马步起手（你往左转它就往画面左边出掌，像照镜子），BGM 突然切到“奶蛙步”；转回来就回中
// 键盘也能控制：↑ 大笑、↓ 回中、← → 起手、P 暂停 / 继续、, . 逐帧、M 静音。键盘的指令保持到头再有新动作为止。
//
// 识别：
//   开始笑：头低过中线 2.5°，而且往下的速度过 10°/s（慢慢低头看东西不算），上下快过左右。
//   点头深度：头低过中线的角度 ÷ 10°（0…1），每帧交给 naiwa-anim.js 定帧。中线 = 进来时“对准中心”定的正前方（C 重定）。
//   停：回到中线 ±3° 以内、上下角速度低于 8°/s，持续 0.35 s；或者头停住（低于 6°/s）1 s。
//   笑声：深度每秒变化量平滑后，变化 1.1 /s 按原速放，限制在 0.5～2 倍；不动就静音。
//   转身：水平角离开正前方过 18° 算转身，回到 10° 以内算转回来（中间留一段，免得在边上来回跳）。
//
// 画面：每帧原样画在同一个固定大小的框里（框只随窗口大小变），不逐帧缩放、不交叉淡化。
//
// 声音：笑声 audio/naiwa-laugh.m4a，扎马步的 BGM audio/naiwa-stance.m4a（52 s）。
// 奶蛙的帧和这两段声音都是作者自己做的，随项目以 MIT 协议开源。文件不在时只是没声音。

import { FramePlayer } from '../frame-player.js';
import { NaiwaAnimator, SEGMENTS } from './naiwa-anim.js';
import { clamp } from './kit.js';

const FRAMES = 108;
const FPS = 10;
const URLS = Array.from({ length: FRAMES }, (_, i) => `sprites/naiwa/frame-${String(i).padStart(3, '0')}.png`);
const FEET = 474 / 512; // 素材里脚底在 512 高的第 474 行
const MIRROR = true; // 你往左转 → 它往画面左边出掌

const NOD_DEPTH = 10; // 头低过中线这么多度，它就蹲到底
const START_DEG = 2.5; // 开始笑：头低过中线 2.5°……
const START_SPEED = 10; // ……而且往下的速度过 10°/s（3.5° 的浅点头也能认出来）
const MID_DEG = 3; // 回到中线 ±3° 以内算回正
const NATURAL_SPEED = 1.1; // 深度每秒变 1.1（下去再上来约 1.8 s，接近自然点头的节奏）时笑声按原速放
const TURN_IN = 18; // °
const TURN_OUT = 10;

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// 素材只加载一次，进出页面不重复下载
let shared = null;
function getPlayer() {
  if (!shared) {
    shared = new FramePlayer({ urls: URLS, fps: FPS, actions: SEGMENTS });
    shared.ready = shared.load();
  }
  return shared;
}

export default {
  id: 'naiwa',
  title: { zh: '奶蛙', en: 'Naiwa' },
  tagline: { zh: '你点头，它就笑', en: 'Nod and it laughs' },
  how: { zh: '点头：一起大笑 · 左右转头：扎马步起手', en: 'Nod: laugh along · Turn: kung-fu stance' },
  accent: '#f2b705',
  range: { h: 30, v: 14 },
  noScore: true,
  noGestureChip: true,

  create(api) {
    const host = api.root;
    const player = getPlayer();
    const anim = new NaiwaAnimator(player);

    // ---- 界面：底部三个状态 + 提示；浏览器不让自动出声时给个按钮 ----
    const hud = document.createElement('div');
    hud.className = 'naiwa-hud';
    hud.innerHTML = `
      <div class="naiwa-states">
        <span data-k="idle">${api.tr('站着', 'Standing')}</span>
        <span data-k="laugh">${api.tr('大笑', 'Laughing')}</span>
        <span data-k="turn">${api.tr('起手', 'Stance')}</span>
      </div>
      <p class="naiwa-hint"></p>
      <button class="naiwa-sound" type="button" hidden>${api.tr('点一下，打开声音', 'Click to turn on sound')}</button>`;
    host.append(hud);
    const chips = Object.fromEntries([...hud.querySelectorAll('[data-k]')].map((el) => [el.dataset.k, el]));
    const hint = hud.querySelector('.naiwa-hint');
    const soundBtn = hud.querySelector('.naiwa-sound');
    const HINT = api.tr('上下点头：一起大笑 · 左右转头：扎马步 · 键盘 ↑ ↓ ← → · C 重新定正前方 · M 静音', 'Nod: laugh · Turn: stance · Keys ↑ ↓ ← → · C re-center · M mute');
    const showLoading = () => {
      hint.textContent = player.loaded < FRAMES ? api.tr(`载入动画 ${player.loaded}/${FRAMES}`, `Loading ${player.loaded}/${FRAMES}`) : HINT;
    };
    showLoading();

    // ---- 声音 ----
    const audio = new Audio('audio/naiwa-laugh.m4a');
    audio.loop = true;
    audio.preservesPitch = true;
    audio.volume = 0;
    let audioOk = true;
    let muted = false;
    let pending = null;
    let vol = 0;
    let quiet = 0;
    audio.addEventListener('error', () => { audioOk = false; });
    const tryPlay = () => {
      if (pending || !audio.paused) return;
      pending = audio.play().then(
        () => { pending = null; soundBtn.hidden = true; },
        () => { pending = null; soundBtn.hidden = false; },
      );
    };
    // 扎马步的 BGM：一起手就从那声重拍开始放（笑声让位），回中后很快淡出；1.5 s 内又起手就接着放
    const bgm = new Audio('audio/naiwa-stance.m4a');
    bgm.loop = true;
    bgm.volume = 0;
    let bgmOk = true;
    let bgmVol = 0;
    let bgmOffAt = -1e9;
    let bgmPending = null;
    let bgmOn = false;
    bgm.addEventListener('error', () => { bgmOk = false; });
    const bgmStart = (now) => {
      bgmOn = true;
      if (!bgmOk || muted) return;
      if (bgm.paused && now - bgmOffAt > 1500) bgm.currentTime = 0;
      bgmVol = 1; // 突然切过去，不淡入
      bgm.volume = 1;
      if (bgm.paused && !bgmPending) {
        bgmPending = bgm.play().then(
          () => { bgmPending = null; soundBtn.hidden = true; },
          () => { bgmPending = null; soundBtn.hidden = false; },
        );
      }
    };
    soundBtn.onclick = () => {
      soundBtn.hidden = true;
      (bgmOn ? bgm : audio).play().catch(() => {});
    };

    // ---- 头部信号 ----
    const s = {
      depth: 0, // 点头深度 0…1（0 = 中线或更高）
      speed: 0, // 深度变化有多快（每秒），笑声的音量和速度看它
      laughing: false,
      centerStill: 0, // 头在中线附近、而且没在上下动，持续了多久
      still: 0, // 没在上下动，持续了多久
      dir: 0, // 转头方向：-1 左、0 正面、1 右（你的左右）
      headWant: 'idle',
      manual: null, // 键盘指令，头再有新动作时让位
      manualT: 0,
      rate: 1,
    };

    function frame(dt, now) {
      const inp = api.input;
      const ok = inp.ok;
      const v = ok ? inp.v : 0;
      const vv = ok ? inp.vv : 0;
      const vh = ok ? inp.vh : 0;

      // 转头（带回差）
      const h = ok ? inp.h : 0;
      let dir = s.dir;
      if (Math.abs(h) > TURN_IN) dir = Math.sign(h);
      else if (Math.abs(h) < TURN_OUT) dir = 0;
      s.dir = dir;

      // 开始笑：头往下点、点得够快（慢慢低头看东西不算），上下快过左右
      if (!s.laughing && ok && !dir && v < -START_DEG && vv < -START_SPEED && Math.abs(vv) > Math.abs(vh) * 0.8) s.laughing = true;
      // 停：回到中线附近、不再上下动 0.35 s；或者在哪儿都停住 1 s
      s.centerStill = Math.abs(vv) < 8 && Math.abs(v) < MID_DEG ? s.centerStill + dt : 0;
      s.still = Math.abs(vv) < 6 ? s.still + dt : 0;
      if (s.laughing && (!ok || s.centerStill > 0.35 || s.still > 1)) s.laughing = false;

      // 想要的状态：起手优先于大笑
      const side = dir === 0 ? null : (dir < 0) === MIRROR ? 'left' : 'right';
      const headWant = side ?? (s.laughing ? 'laugh' : 'idle');
      if (headWant !== s.headWant) {
        s.headWant = headWant;
        s.manual = null; // 头有了新动作，键盘指令让位
      }
      const target = s.manual ?? headWant;

      // 点头深度：头低过中线多少度（NOD_DEPTH 度算点到底）；键盘让它笑时用一个慢慢的假点头
      let raw = clamp(-v / NOD_DEPTH, 0, 1);
      if (s.manual === 'laugh') {
        s.manualT += dt;
        raw = 0.5 - 0.5 * Math.cos(2 * Math.PI * 0.6 * s.manualT);
      } else s.manualT = 0;
      const prev = s.depth;
      s.depth += (1 - Math.exp(-dt / 0.04)) * (raw - s.depth);
      const inst = dt > 0 ? Math.abs(s.depth - prev) / dt : 0;
      s.speed += (1 - Math.exp(-dt / 0.35)) * (inst - s.speed); // 平滑一点，点头掉头那一下不至于没声

      const wasStance = anim.want === 'left' || anim.want === 'right';
      anim.set(target);
      const isStance = target === 'left' || target === 'right';
      if (isStance && !wasStance) bgmStart(now);
      else if (!isStance && wasStance) {
        bgmOn = false;
        bgmOffAt = now;
      }

      // 推进动画：大笑时按深度定帧
      anim.update(dt, { depth: s.depth });

      // 扎马步 BGM：回中后 0.2 s 淡出
      if (!bgmOn) {
        bgmVol += (1 - Math.exp(-dt / 0.2)) * (0 - bgmVol);
        bgm.volume = clamp(bgmVol, 0, 1);
        if (bgmVol < 0.01 && !bgm.paused) bgm.pause();
      }
      // 笑声：画面在笑、头在动才响；动得快放得快、动得慢放得慢，停住就停；起手时让给 BGM
      const kind = anim.kind;
      const tgt = audioOk && !muted && kind === 'laugh' && !(bgmOn && bgmOk) ? smoothstep(0.12, 0.45, s.speed) : 0;
      if (tgt > 0.01) {
        quiet = 0;
        tryPlay();
      }
      vol += (1 - Math.exp(-dt / (tgt > vol ? 0.08 : bgmOn ? 0.06 : 0.2))) * (tgt - vol);
      audio.volume = clamp(vol, 0, 1);
      if (tgt <= 0.01 && vol < 0.01) {
        quiet += dt;
        if (quiet > 0.4 && !audio.paused) audio.pause();
      }
      const rate = clamp(s.speed / NATURAL_SPEED, 0.5, 2);
      if (Math.abs(rate - s.rate) > 0.03) {
        s.rate = rate;
        audio.playbackRate = rate;
      }

      chips.idle.classList.toggle('on', kind === 'idle');
      chips.laugh.classList.toggle('on', kind === 'laugh');
      chips.turn.classList.toggle('on', kind === 'left' || kind === 'right');
      if (player.loaded < FRAMES || hint.textContent !== HINT) showLoading();

      draw();
    }

    // ---- 画：固定的框（只随窗口变），脚底落在 HUD 上方 ----
    let box = null;
    function layout(w, h) {
      const size = Math.max(160, Math.min(h - 170, w * 0.92, 760));
      const feetY = h - 128;
      box = { x: Math.round((w - size) / 2), y: Math.round(feetY - size * FEET), size: Math.round(size) };
    }
    function draw() {
      const g = api.g;
      const { w, h } = api;
      if (!box) layout(w, h);
      g.clearRect(0, 0, w, h);
      // 脚下一块固定的淡影子（不跟帧动）
      const cx = box.x + box.size / 2;
      const cy = box.y + box.size * FEET + 2;
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, box.size * 0.36);
      grd.addColorStop(0, api.dark ? 'rgba(0,0,0,0.35)' : 'rgba(80,60,20,0.16)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.save();
      g.translate(cx, cy);
      g.scale(1, 0.16);
      g.translate(-cx, -cy);
      g.fillStyle = grd;
      g.beginPath();
      g.arc(cx, cy, box.size * 0.36, 0, Math.PI * 2);
      g.fill();
      g.restore();
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      player.draw(g, box.x, box.y, box.size);
    }

    return {
      frame,
      resize(w, h) {
        layout(w, h);
      },
      key(e) {
        const k = e.key;
        if (k === 'm' || k === 'M') {
          muted = !muted;
          if (muted) {
            audio.pause();
            bgm.pause();
          }
        } else if (k === 'ArrowUp') s.manual = 'laugh';
        else if (k === 'ArrowDown') s.manual = 'idle';
        else if (k === 'ArrowLeft') s.manual = 'left';
        else if (k === 'ArrowRight') s.manual = 'right';
        else if (k === 'p' || k === 'P') player.playing ? player.pause() : player.resume();
        else if (k === ',') player.setFrame(player.frame - 1);
        else if (k === '.') player.setFrame(player.frame + 1);
        else return;
        e.preventDefault();
      },
      destroy() {
        for (const a of [audio, bgm]) {
          a.pause();
          a.removeAttribute('src');
          a.load();
        }
        hud.remove();
        player.stop();
      },
      // 控制台里用：nodlink.arcade.game.inst.player / .anim
      player,
      anim,
      get debug() {
        return { ...s, seg: anim.seg, frame: player.frame, speed: player.speed, kind: anim.kind, bgm: { paused: bgm.paused, t: bgm.currentTime, vol: bgm.volume, ok: bgmOk }, laughAudio: { paused: audio.paused, vol: audio.volume } };
      },
    };
  },
};
