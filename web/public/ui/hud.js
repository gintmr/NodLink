// 场景四角的两块常驻信息，挂在边缘仪表（ui/instruments.js）的取景框里，和它一起只在第三人称出现：
//
//   左下  运行数据：采样率、数据完整率、准度、连续运行时长，下面一行是头控操作次数和拦下的误触。
//         全是实测数字，没有的显示“–”，不编数字。端到端延迟测不准（耳机和电脑的时钟没对齐），所以不显示
//   右下  显示器小地图：按比例画出几块屏的排列（像 macOS 的“显示器排列”），上面是实时的光标（粉点）
//         和头指向的落点（紫圈），一眼看出头控能跨屏走
//
// 都是 DOM 和 SVG，数字每秒刷新几次，小地图每帧只改两个点的位置。

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
};

export class StatsPanel {
  constructor(root, t) {
    this.t = t;
    this.el = document.createElement('div');
    this.el.className = 'hud-stats';
    this.el.innerHTML = `
      <div class="hud-cell" data-k="rate"><b>–</b><i>Hz</i><span></span></div>
      <div class="hud-cell" data-k="integrity"><b>–</b><i>%</i><span></span></div>
      <div class="hud-cell" data-k="accuracy"><b>–</b><i>%</i><span></span></div>
      <div class="hud-cell" data-k="uptime"><b>–</b><i></i><span></span></div>
      <p class="hud-foot"></p>
      <p class="hud-empty"></p>`;
    root.append(this.el);
    this.cells = Object.fromEntries([...this.el.querySelectorAll('.hud-cell')].map((c) => [c.dataset.k, { b: c.querySelector('b'), i: c.querySelector('i'), span: c.querySelector('span') }]));
    this.foot = this.el.querySelector('.hud-foot');
    this.empty = this.el.querySelector('.hud-empty');
    this.shown = {};
    this.relabel();
  }

  relabel() {
    const t = this.t;
    this.cells.rate.span.textContent = t('采样率');
    this.cells.integrity.span.textContent = t('数据完整率');
    this.cells.accuracy.span.textContent = t('准度偏差');
    this.cells.uptime.span.textContent = t('连续运行');
    this.empty.textContent = t('连接耳机后显示');
    this.shown = {};
  }

  set(key, value, unit) {
    const c = this.cells[key];
    const k = `${value}|${unit}`;
    if (this.shown[key] === k) return;
    this.shown[key] = k;
    c.b.textContent = value;
    c.i.textContent = unit;
  }

  /**
   * rate：Hz；integrity：0～1；accuracy：最近一次九点测试的平均偏差占对角线的比例（%）；
   * uptimeMs：连续收到数据多久了；ops / rejects：头控操作次数、拦下的误触次数
   */
  update({ rate, integrity, accuracy, uptimeMs, ops, rejects }) {
    const t = this.t;
    // 还没有数据：一句话代替一排“–”，看着不像坏了
    this.el.classList.toggle('is-empty', !rate);
    this.set('rate', rate ? rate.toFixed(0) : '–', 'Hz');
    this.set('integrity', integrity == null ? '–' : (Math.floor(integrity * 1000) / 10).toFixed(1), integrity == null ? '' : '%');
    this.set('accuracy', accuracy == null ? '–' : accuracy.toFixed(1), accuracy == null ? '' : '%');
    if (uptimeMs == null) this.set('uptime', '–', '');
    else {
      const s = Math.floor(uptimeMs / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = String(s % 60).padStart(2, '0');
      this.set('uptime', h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`, '');
    }
    const foot = t('头控操作 {n} 次 · 拦下误触 {m} 次', { n: ops, m: rejects }) + (accuracy == null ? ` · ${t('准度：做一次九点测试后显示')}` : '');
    if (this.foot.textContent !== foot) this.foot.textContent = foot;
  }
}

export class MiniMap {
  constructor(root, t) {
    this.t = t;
    this.el = document.createElement('div');
    this.el.className = 'hud-map';
    this.svg = svgEl('svg', { 'aria-hidden': 'true' });
    this.label = document.createElement('span');
    this.point = document.createElement('p'); // 正在指向：App · 元素
    this.point.className = 'hud-pointing';
    this.el.append(this.label, this.svg, this.point);
    root.append(this.el);
    this.screens = svgEl('g', {}, this.svg);
    this.hit = svgEl('circle', { r: 5, class: 'hud-hit' }, this.svg);
    this.cursor = svgEl('circle', { r: 3.4, class: 'hud-cursor' }, this.svg);
    this.key = null;
    this.relabel();
  }

  relabel() {
    this.key = null; // 屏幕编号的文字跟着重画
  }

  /** 小地图下面一行：正在指向什么（没有就收起） */
  setPointing(text) {
    const v = text ? `${this.t('正在指向')} · ${text}` : '';
    if (this.point.textContent !== v) this.point.textContent = v;
  }

  /** screens：[{ x, y, w, h, main, name }]（屏幕坐标）；cursor / hit：同一坐标里的点或 null */
  update({ screens, cursor, hit }) {
    const key = JSON.stringify(screens.map((s) => [s.x, s.y, s.w, s.h, s.main]));
    if (key !== this.key) this.build(screens, key);
    this.place(this.cursor, cursor);
    this.place(this.hit, hit);
  }

  build(screens, key) {
    this.key = key;
    this.screens.replaceChildren();
    if (!screens.length) return;
    const minX = Math.min(...screens.map((s) => s.x));
    const minY = Math.min(...screens.map((s) => s.y));
    const maxX = Math.max(...screens.map((s) => s.x + s.w));
    const maxY = Math.max(...screens.map((s) => s.y + s.h));
    // 最大 176×104，按比例缩，四周留 6 像素
    const k = Math.min(176 / (maxX - minX), 104 / (maxY - minY));
    const W = Math.round((maxX - minX) * k) + 12;
    const H = Math.round((maxY - minY) * k) + 12;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    Object.assign(this.svg.style, { width: `${W}px`, height: `${H}px` });
    this.map = { minX, minY, k };
    screens.forEach((s, i) => {
      const x = 6 + (s.x - minX) * k;
      const y = 6 + (s.y - minY) * k;
      const w = s.w * k;
      const h = s.h * k;
      svgEl('rect', { x: x + 1, y: y + 1, width: Math.max(w - 2, 2), height: Math.max(h - 2, 2), rx: 3.5, class: s.main ? 'hud-screen main' : 'hud-screen' }, this.screens);
      if (s.main) svgEl('rect', { x: x + w / 2 - 6, y: y + 4, width: 12, height: 2, rx: 1, class: 'hud-menubar' }, this.screens);
      svgEl('text', { x: x + 6, y: y + h - 6, class: 'hud-screen-no' }, this.screens).textContent = String(i + 1);
    });
    const n = screens.length;
    this.label.textContent = n > 1 ? this.t('{n} 块显示器', { n }) : this.t('显示器');
  }

  place(dot, p) {
    if (!p || !this.map) {
      dot.style.display = 'none';
      return;
    }
    dot.style.display = '';
    const { minX, minY, k } = this.map;
    dot.setAttribute('cx', (6 + (p.x - minX) * k).toFixed(1));
    dot.setAttribute('cy', (6 + (p.y - minY) * k).toFixed(1));
  }
}
