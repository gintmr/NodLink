// 介绍页的背景歌：一开始往下滑，就从指定的那一句开始放，淡入；进入控制台时淡出。
//
// 浏览器不许网页“自己”出声：必须先有一次点按或按键，play() 才会成功。滚轮、触控板滑动都不算。
// 所以这里的做法是：
//   1. 一滑动就试着放（这次页面之前被点过、或浏览器对本站放行了自动播放时，直接就响）；
//   2. 被拦下来了，就记着“想放”，下一次按键时补上，并亮出一个小按钮，点它就放；
//   3. 歌文件不存在（比如从开源仓库克隆下来，没有这首歌）：什么都不显示，页面照常用。
//
// 静音开关存在 localStorage 的 nodlink.music 里。

const KEY = 'nodlink.music';
const VOLUME = 0.85;

export function createSong({ src, start = 0, onState = () => {} }) {
  const audio = new Audio();
  audio.preload = 'auto';
  let available = false;
  let wanted = false;   // 已经滑过了，想放
  let blocked = false;  // 想放但被浏览器拦了，等一次点按或按键
  let started = false;  // 已经从 start 那句开过头
  let leaving = false;
  let fadeRaf = 0;
  let muted = false;
  try { muted = JSON.parse(localStorage.getItem(KEY)) === 'off'; } catch { /* 隐私模式 */ }

  const state = () => (!available ? 'none' : muted ? 'muted' : blocked ? 'blocked' : !audio.paused ? 'playing' : 'idle');
  const emit = () => onState(state());

  audio.addEventListener('loadedmetadata', () => { available = true; emit(); if (wanted) play(); });
  audio.addEventListener('error', () => { available = false; emit(); });
  audio.addEventListener('play', emit);
  audio.addEventListener('pause', emit);
  audio.src = src;

  function fade(to, ms, done) {
    cancelAnimationFrame(fadeRaf);
    const from = audio.volume;
    const t0 = performance.now();
    const step = () => {
      const k = Math.min((performance.now() - t0) / ms, 1);
      audio.volume = from + (to - from) * (1 - (1 - k) ** 3);
      if (k < 1) fadeRaf = requestAnimationFrame(step);
      else done?.();
    };
    step();
  }

  function play() {
    if (!available || muted || leaving || !audio.paused) return;
    if (!started) {
      audio.currentTime = start;
      started = true;
    }
    audio.volume = 0;
    const p = audio.play();
    p.then(() => {
      blocked = false;
      emit();
      fade(VOLUME, 1600);
    }).catch(() => {
      blocked = true;
      emit();
    });
  }

  return {
    /** 用户开始滑动了：想放 */
    want() {
      if (wanted) return;
      wanted = true;
      play();
    },
    /** 一次点按或按键（浏览器认的“用户操作”）：之前被拦下的，这时补上 */
    unlock() {
      if (wanted && blocked) play();
    },
    /** 点了“放音乐”的小按钮 */
    playNow() {
      wanted = true;
      if (muted) this.setMuted(false);
      play();
    },
    setMuted(m) {
      muted = m;
      try { localStorage.setItem(KEY, JSON.stringify(m ? 'off' : 'on')); } catch { /* 隐私模式 */ }
      if (m) fade(0, 400, () => audio.pause());
      else if (wanted) play();
      emit();
    },
    get muted() { return muted; },
    get state() { return state(); },
    /** 进入控制台：淡出后停下，释放 */
    leave(ms = 1400) {
      leaving = true;
      if (audio.paused) return;
      fade(0, ms, () => { audio.pause(); audio.removeAttribute('src'); audio.load(); });
    },
  };
}
