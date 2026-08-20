/**
 * 构建产物冒烟脚本（技术方案 v2 §10.2）。
 *
 * 验证 dist/ 的关键产物存在且体积在预算内：
 *   - index.html 存在且引用入口 JS
 *   - 入口 JS/CSS 存在
 *   - gzip 总量 < 1.5MB（包体积预算）
 *
 * 用法：pnpm build && node scripts/smoke.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

const GZIP_BUDGET_BYTES = 1.5 * 1024 * 1024; // 1.5MB gzip 总量预算

let failures = 0;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failures++;
};
const pass = (msg) => console.log(`PASS: ${msg}`);

// 1. index.html 存在且引用入口 JS
const indexPath = join(distDir, 'index.html');
if (!existsSync(indexPath)) {
  fail('dist/index.html 不存在（先执行 pnpm build）');
  process.exit(1);
}
const html = readFileSync(indexPath, 'utf-8');
const entryMatch = html.match(/src="([^"]*index-[^"]+\.js)"/);
if (!entryMatch) {
  fail('index.html 未引用入口 JS（index-*.js）');
} else {
  pass(`index.html 引用入口 ${entryMatch[1]}`);
}

// 2. 入口 JS/CSS 存在
const assetsDir = join(distDir, 'assets');
if (!existsSync(assetsDir)) {
  fail('dist/assets 不存在');
  process.exit(1);
}
const assets = readdirSync(assetsDir);
const entryJs = assets.filter((f) => f.endsWith('.js'));
const entryCss = assets.filter((f) => f.endsWith('.css'));
if (entryJs.length === 0) fail('无 JS 产物');
else pass(`JS 产物 ${entryJs.length} 个`);
if (entryCss.length === 0) fail('无 CSS 产物');
else pass(`CSS 产物 ${entryCss.length} 个`);

// 3. gzip 总量预算
let totalGzip = 0;
for (const f of assets) {
  const buf = readFileSync(join(assetsDir, f));
  totalGzip += gzipSync(buf).length;
}
const totalMB = (totalGzip / 1024 / 1024).toFixed(2);
if (totalGzip > GZIP_BUDGET_BYTES) {
  fail(`gzip 总量 ${totalMB}MB 超出预算 1.50MB`);
} else {
  pass(`gzip 总量 ${totalMB}MB（预算 1.50MB）`);
}

if (failures > 0) {
  console.error(`\n冒烟失败：${failures} 项`);
  process.exit(1);
}
console.log('\n冒烟通过');
