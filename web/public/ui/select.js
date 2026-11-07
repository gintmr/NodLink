// 下拉菜单：把页面里的 <select> 换成和整套界面一样的样式（系统自带的下拉列表每个浏览器、每个系统版本长得都不一样）。
//
// 原来的 <select> 还留着，藏起来当数据源：app.js 照旧读写 .value、监听 change，不用改。
// - 点按钮或按 ↓ / ↑ / 回车 / 空格打开；列表里 ↑ ↓ 移动，Home / End 到头尾，回车或空格选中，Esc 或 Tab 关掉
// - 选项的文字、个数变了（切换语言、加载了新角色），按钮上的文字跟着变；代码里直接改 .value 也会跟着变
// - 列表挂在 body 上用 fixed 定位，不会被卡片的滚动区域裁掉；下面放不下就往上开

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

let uid = 0;
let open = null; // 当前打开的那个 { select, button, list, active }

/** 页面里所有还没换过的 <select> 都换成自定义下拉菜单 */
export function enhanceSelects(root = document) {
  for (const select of root.querySelectorAll('select:not([data-dd])')) enhance(select);
}

function labelFor(select) {
  const row = select.closest('label');
  const text = row?.querySelector(':scope > span')?.textContent?.trim();
  return text || select.getAttribute('aria-label') || '';
}

function enhance(select) {
  select.dataset.dd = '';
  const id = `dd-${++uid}`;
  const wrap = document.createElement('span');
  wrap.className = 'dd';
  select.replaceWith(wrap);
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.classList.add('dd-native');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dd-btn';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `${id}-list`);
  button.innerHTML = `<span class="dd-value"></span>${CHEVRON}`;
  wrap.append(select, button);

  const sync = () => {
    const opt = select.options[select.selectedIndex];
    button.querySelector('.dd-value').textContent = opt ? opt.textContent : '';
    button.disabled = select.disabled;
    const name = labelFor(select);
    if (name) button.setAttribute('aria-label', `${name}: ${opt ? opt.textContent : ''}`);
    if (open?.select === select) render(open);
  };
  // 代码里直接赋值 .value / .selectedIndex 不会发事件，这里拦一下，按钮上的字跟着变
  for (const prop of ['value', 'selectedIndex']) {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); sync(); },
    });
  }
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label'] });
  select.addEventListener('change', sync);
  sync();

  button.addEventListener('click', () => (open?.select === select ? close(true) : show(select, button, id)));
  // 页面上空格是离合、C 是回中：按在下拉菜单上的键不往外传
  button.addEventListener('keydown', (e) => {
    if ([' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) e.stopPropagation();
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      if (open?.select !== select) show(select, button, id);
    }
  });
}

function show(select, button, id) {
  close(false);
  const list = document.createElement('div');
  list.className = 'dd-list';
  list.id = `${id}-list`;
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  const name = labelFor(select);
  if (name) list.setAttribute('aria-label', name);
  document.body.append(list);
  open = { select, button, list, active: Math.max(select.selectedIndex, 0), id };
  render(open);
  place(open);
  button.setAttribute('aria-expanded', 'true');
  button.classList.add('open');
  list.focus({ preventScroll: true });
  requestAnimationFrame(() => list.classList.add('in'));

  list.addEventListener('keydown', onKey);
  list.addEventListener('pointermove', (e) => {
    const item = e.target.closest('.dd-item');
    if (item && !item.classList.contains('disabled')) setActive(Number(item.dataset.i));
  });
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.dd-item');
    if (item && !item.classList.contains('disabled')) choose(Number(item.dataset.i));
  });
}

function render(o) {
  const { select, list } = o;
  list.innerHTML = '';
  [...select.options].forEach((opt, i) => {
    const item = document.createElement('div');
    item.className = 'dd-item';
    item.id = `${o.id}-opt-${i}`;
    item.dataset.i = i;
    item.setAttribute('role', 'option');
    const selected = i === select.selectedIndex;
    item.setAttribute('aria-selected', String(selected));
    if (opt.disabled) {
      item.classList.add('disabled');
      item.setAttribute('aria-disabled', 'true');
    }
    if (selected) item.classList.add('selected');
    item.innerHTML = `<span class="dd-check">${selected ? CHECK : ''}</span><span class="dd-text"></span>`;
    item.querySelector('.dd-text').textContent = opt.textContent;
    list.append(item);
  });
  setActive(Math.min(o.active, select.options.length - 1));
}

function setActive(i) {
  if (!open) return;
  open.active = i;
  for (const el of open.list.children) el.classList.toggle('active', Number(el.dataset.i) === i);
  const el = open.list.children[i];
  if (el) {
    open.list.setAttribute('aria-activedescendant', el.id);
    el.scrollIntoView({ block: 'nearest' });
  }
}

/** 列表放在按钮下方，右边和按钮对齐；下面放不下就放上面 */
function place({ button, list }) {
  const r = button.getBoundingClientRect();
  list.style.minWidth = `${Math.max(r.width, 140)}px`;
  const w = list.offsetWidth;
  const h = list.offsetHeight;
  const gap = 6;
  const below = window.innerHeight - r.bottom - gap - 8;
  const up = h > below && r.top - gap - 8 > below;
  list.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  list.style.top = up ? `${Math.max(8, r.top - gap - h)}px` : `${r.bottom + gap}px`;
  list.style.maxHeight = `${Math.max(120, up ? r.top - gap - 16 : below)}px`;
  list.classList.toggle('up', up);
}

function step(dir) {
  const n = open.select.options.length;
  let i = open.active;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (!open.select.options[i].disabled) return setActive(i);
  }
}

function onKey(e) {
  if (!open) return;
  if (e.key !== 'Tab') e.stopPropagation();
  const n = open.select.options.length;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); step(1); break;
    case 'ArrowUp': e.preventDefault(); step(-1); break;
    case 'Home': e.preventDefault(); setActive(0); break;
    case 'End': e.preventDefault(); setActive(n - 1); break;
    case 'Enter':
    case ' ': e.preventDefault(); choose(open.active); break;
    case 'Escape': e.preventDefault(); close(true); break;
    case 'Tab': close(true); break;
    default: {
      // 按字母跳到这个字开头的选项
      if (e.key.length !== 1) return;
      const k = e.key.toLowerCase();
      const opts = [...open.select.options];
      const from = open.active + 1;
      const hit = [...opts.slice(from), ...opts.slice(0, from)].find((o) => !o.disabled && o.textContent.trim().toLowerCase().startsWith(k));
      if (hit) setActive(hit.index);
    }
  }
}

function choose(i) {
  const { select } = open;
  const opt = select.options[i];
  if (!opt || opt.disabled) return;
  const changed = select.selectedIndex !== i;
  close(true);
  if (changed) {
    select.selectedIndex = i;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function close(refocus) {
  if (!open) return;
  const { button, list } = open;
  open = null;
  button.setAttribute('aria-expanded', 'false');
  button.classList.remove('open');
  list.remove();
  if (refocus) button.focus({ preventScroll: true });
}

// 点到外面、滚动、窗口大小变了：关掉
document.addEventListener('pointerdown', (e) => {
  if (open && !open.list.contains(e.target) && !open.button.contains(e.target)) close(false);
}, true);
document.addEventListener('scroll', (e) => { if (open && !open.list.contains(e.target)) close(false); }, true);
window.addEventListener('resize', () => close(false));
