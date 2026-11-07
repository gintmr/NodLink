// 把调试台构建成公开体验版（纯静态网页，放 GitHub Pages）：npm run build:public → web/dist/
//
// 和本地版是同一份 public/ 代码，只做三件事：
//   1. 复制 public/ 里会进仓库的文件（按 .gitignore 过滤，所以本地自用的模型、不进仓库的歌不会带上）
//   2. 把本地服务从 node_modules 提供的 three.js 和字体复制到 dist/vendor/（路径和 server.js 的 VENDOR 一致）
//   3. 在 index.html 的 <html> 上加 data-edition="public"：网页据此只用模拟数据，藏起要耳机桥的界面（.live-only）
// 所以本地改的界面，推到 main 以后公开版自动一样（.github/workflows/pages.yml）。

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(WEB, 'public');
const OUT = path.join(WEB, 'dist');
const VENDOR = {
  'vendor/three/build/three.module.js': 'node_modules/three/build/three.module.js',
  'vendor/three/examples/jsm': 'node_modules/three/examples/jsm',
  'vendor/fonts': 'node_modules/@fontsource-variable/unbounded/files',
  'vendor/sora': 'node_modules/@fontsource-variable/sora',
};

rmSync(OUT, { recursive: true, force: true });

// 已提交的和没被忽略的新文件都算（-z：文件名里有中文也不转义）
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: SRC })
  .toString().split('\0').filter(Boolean);
let n = 0;
for (const f of files) {
  const from = path.join(SRC, f);
  try {
    cpSync(from, path.join(OUT, f), { recursive: false, force: true });
    n++;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // git 里删了、磁盘上已经没有的文件跳过
  }
}

for (const [to, from] of Object.entries(VENDOR)) cpSync(path.join(WEB, from), path.join(OUT, to), { recursive: true });

const index = path.join(OUT, 'index.html');
const html = readFileSync(index, 'utf8');
if (!html.includes('<html lang="zh-CN">')) throw new Error('index.html 的 <html> 标签变了，改一下 build-public.js');
writeFileSync(index, html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-edition="public">'));

// GitHub Pages 默认用 Jekyll 处理，会跳过下划线开头的文件；加 .nojekyll 原样发布
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`公开体验版：${n} 个文件 → ${path.relative(process.cwd(), OUT) || '.'}`);
