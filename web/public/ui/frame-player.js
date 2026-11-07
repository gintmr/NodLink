// 逐帧播放器：一串同尺寸的单帧图片（PNG，带透明），按帧率播放。
// 不缩放、不淡化：每一帧原样画在同一个固定的框里，角色位置不会跳；切换动作就是直接换帧（不会有双影）。
//
// 用法：
//   const p = new FramePlayer({ urls, fps: 10, actions: { wave: [10, 19], hold: { from: 20, to: 29, loop: true } } });
//   await p.load((done, total) => ...);   // 预加载并解码全部图片
//   p.playAction('wave', { onEnd })        // 按名字播一段（含首尾帧）
//   p.play({ from, to, loop, reverse, fps, speed, onEnd })
//   p.pause() / p.resume() / p.stop()
//   p.setFrame(i)                          // 跳到某帧并停住
//   p.setProgress(0…1)                     // 在当前这段（没有就是整串）里按进度定位并停住
//   p.speed = 1.5                          // 播放速度倍数
//   每帧调用 p.update(dt)，再 p.draw(g, x, y, size) 画到 2D 画布上；
//   也可以 p.run(canvas) 让它自己用 requestAnimationFrame 播放、画满这块画布。

export class FramePlayer {
  constructor({ urls, fps = 10, actions = {} }) {
    this.urls = urls;
    this.fps = fps;
    this.actions = {};
    for (const [name, a] of Object.entries(actions)) this.actions[name] = Array.isArray(a) ? { from: a[0], to: a[1] } : { ...a };
    this.images = new Array(urls.length).fill(null);
    this.loaded = 0;
    this.frame = 0;
    this.speed = 1;
    this.seg = null; // 正在播的一段 { name, from, to, loop, reverse, fps, onEnd }
    this.playing = false;
    this.acc = 0;
  }

  get count() {
    return this.urls.length;
  }

  /** 预加载并解码全部帧；onProgress(已好, 总数) */
  load(onProgress) {
    let done = 0;
    return Promise.all(this.urls.map((url, i) => new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      const finish = (good) => {
        if (good) {
          this.images[i] = img;
          img.decode?.().catch(() => {}); // 顺手提前解码；页面在后台时 decode() 会一直挂着，所以不等它
        }
        this.loaded = ++done;
        onProgress?.(done, this.urls.length);
        resolve();
      };
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = url;
    })));
  }

  // ---------- 播放控制 ----------

  /** 播一段：from/to 都包含；reverse 倒着播；loop 循环；播完（不循环时）调用 onEnd */
  play({ from = 0, to = this.count - 1, loop = false, reverse = false, fps = this.fps, speed, name = null, onEnd = null, start } = {}) {
    from = this.clampFrame(from);
    to = this.clampFrame(to);
    if (from > to) [from, to] = [to, from];
    this.seg = { name, from, to, loop, reverse, fps, onEnd };
    if (speed != null) this.speed = speed;
    this.frame = start != null ? this.clampFrame(start) : reverse ? to : from;
    this.acc = 0;
    this.playing = true;
    return this;
  }

  /** 按名字播一段（构造时给的 actions）；opts 里的字段覆盖默认 */
  playAction(name, opts = {}) {
    const a = this.actions[name];
    if (!a) throw new Error(`没有这个动作：${name}`);
    return this.play({ ...a, ...opts, name });
  }

  pause() {
    this.playing = false;
    return this;
  }

  resume() {
    if (this.seg) this.playing = true;
    return this;
  }

  stop() {
    this.playing = false;
    this.seg = null;
    return this;
  }

  /** 跳到某帧并停住 */
  setFrame(i) {
    this.frame = this.clampFrame(i);
    this.playing = false;
    this.acc = 0;
    return this;
  }

  /** 在当前这段里（没有就是整串）按 0…1 定位并停住 */
  setProgress(v, { whole = !this.seg } = {}) {
    const from = whole ? 0 : this.seg.from;
    const to = whole ? this.count - 1 : this.seg.to;
    v = Math.min(Math.max(v, 0), 1);
    return this.setFrame(Math.round(from + (to - from) * v));
  }

  /** 当前这段播到哪了（0…1） */
  get progress() {
    const from = this.seg?.from ?? 0;
    const to = this.seg?.to ?? this.count - 1;
    return to === from ? 1 : (this.frame - from) / (to - from);
  }

  clampFrame(i) {
    return Math.min(Math.max(Math.round(i), 0), this.count - 1);
  }

  /** 推进时间（秒）。一次 dt 可能跨好几帧，段尾的 onEnd 只会在这一段真的播完时调一次 */
  update(dt) {
    const s = this.seg;
    if (!this.playing || !s) return;
    this.acc += dt * s.fps * this.speed;
    while (this.acc >= 1 && this.playing && this.seg === s) {
      this.acc -= 1;
      const step = s.reverse ? -1 : 1;
      const next = this.frame + step;
      if (next > s.to || next < s.from) {
        if (s.loop) this.frame = s.reverse ? s.to : s.from;
        else {
          this.playing = false;
          this.acc = 0;
          s.onEnd?.(this); // onEnd 里可以接着 play() 下一段
        }
      } else this.frame = next;
    }
  }

  // ---------- 画 ----------

  /** 当前帧画进 (x, y, size × size) 的框里；还没加载好就画已有的最近一帧 */
  draw(g, x, y, size) {
    let img = this.images[this.frame];
    if (!img) img = this.images.find(Boolean);
    if (!img) return;
    g.drawImage(img, x, y, size, size);
  }

  /** 独立使用：自己跑 requestAnimationFrame，画满 canvas（居中、等比） */
  run(canvas) {
    const g = canvas.getContext('2d');
    let last = performance.now();
    const step = (now) => {
      this.raf = requestAnimationFrame(step);
      this.update(Math.min((now - last) / 1000, 0.1));
      last = now;
      const w = canvas.width;
      const h = canvas.height;
      const size = Math.min(w, h);
      g.clearRect(0, 0, w, h);
      this.draw(g, (w - size) / 2, (h - size) / 2, size);
    };
    this.raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(this.raf);
  }
}
