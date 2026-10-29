#!/usr/bin/env node
/**
 * 打包脚本 —— 生成平台可直接安装的 ZIP。
 *
 * 为什么不用 `openlearn-plugin-sdk pack`：
 *   官方 CLI 的 pack 只写入 index.js / manifest.json / frontend.js 三个条目。
 *   本插件的可见 UI 是 storage/*.html（声明式可视沙箱视图），必须一并入包；
 *   而平台安装侧只解压 ZIP 里 `storage/**` 的条目（install.ts → extractZipEntries），
 *   所以静态页必须放在 storage/ 下、且 view 路径要写成 `storage/xxx.html`。
 *
 * 产物：dist/openlearn-plugin-lab-help.zip + 根目录同名副本（与其它插件一致，便于手动上传）。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const storageDir = join(root, 'storage');

const die = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

const manifestPath = join(root, 'manifest.json');
if (!existsSync(manifestPath)) die('缺少 manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const key of ['id', 'name', 'version', 'main']) {
  if (!manifest[key]) die(`manifest.json 缺少必填字段：${key}`);
}

const bundlePath = join(distDir, 'index.js');
if (!existsSync(bundlePath)) die('缺少 dist/index.js —— 先跑 `npm run build`');

/**
 * 守卫：frontend.js 必须存在。
 *
 * 宿主 activateRemotePlugin() 先 fetch 这个文件，404 就 throw —— 而且
 * `registerManifestContributions()` 在 fetch 之后。少了它，manifest 里声明的
 * teacher.tab / student.classroom.overlay 一条都不会注册：教师端没页签、
 * 学生端没浮层，安装向导也不报错（最容易踩、最难查的一个坑）。
 * 它由 CLI 从 `src/frontend.tsx` 构建产出。
 */
const frontendPath = join(distDir, 'frontend.js');
if (!existsSync(frontendPath)) {
  die('缺少 dist/frontend.js —— 先在 src/frontend.tsx 提供前端入口并跑 `npm run build`');
}

/** 收集 storage/ 下所有文件，保持 `storage/…` 相对路径（install.ts 只解压此前缀）。 */
function collectStorage(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectStorage(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

const storageFiles = collectStorage(storageDir);

/**
 * 守卫：manifest 里声明的每个 view 都必须真的在包里。
 * 平台侧对 view 的处理是「找不到就让面板空着」（静态路由 404），
 * 作者拿不到任何报错 —— 所以必须在打包期拦住拼写错误。
 */
const declaredViews = [];
for (const [slot, entries] of Object.entries(manifest.contributes ?? {})) {
  if (!Array.isArray(entries)) continue;
  for (const entry of entries) {
    if (entry && typeof entry.view === 'string') declaredViews.push({ slot, view: entry.view, id: entry.id });
  }
}
if (declaredViews.length === 0) die('manifest.contributes 里没有任何 view 声明 —— 第三方 process 插件将无法渲染 UI');

for (const { slot, view, id } of declaredViews) {
  if (view.includes('..') || view.startsWith('/')) die(`view 路径非法（不允许 .. 或绝对路径）：${slot}/${id} → ${view}`);
  if (!view.startsWith('storage/')) {
    die(`view 必须以 storage/ 开头：${slot}/${id} → ${view}（安装侧只解压 storage/**，其它位置会 404）`);
  }
  const abs = resolve(root, view);
  if (!existsSync(abs) || !statSync(abs).isFile()) die(`view 指向的文件不存在：${slot}/${id} → ${view}`);
}

const zip = new JSZip();
zip.file('index.js', readFileSync(bundlePath, 'utf8'));
zip.file('frontend.js', readFileSync(frontendPath, 'utf8'));
zip.file('manifest.json', JSON.stringify(manifest, null, 2));
for (const abs of storageFiles) {
  zip.file(relative(root, abs).split(sep).join('/'), readFileSync(abs));
}

const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });

mkdirSync(distDir, { recursive: true });
const zipName = `openlearn-plugin-${String(manifest.id).replace(/^@[^/]+\//, '')}.zip`;
const outDist = join(distDir, zipName);
const outRoot = join(root, zipName);
writeFileSync(outDist, buffer);
writeFileSync(outRoot, buffer);

const sha = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
console.log(`✔ ${zipName}  ${(buffer.length / 1024).toFixed(1)} KB  sha256:${sha}…`);
console.log(`  id=${manifest.id}  version=${manifest.version}`);
console.log(`  条目：index.js、frontend.js、manifest.json、storage×${storageFiles.length}`);
for (const { slot, view, id } of declaredViews) console.log(`  view  ${slot}/${id} → ${view}`);
console.log(`  → ${outRoot}`);
