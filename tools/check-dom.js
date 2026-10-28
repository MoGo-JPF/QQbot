// 开发辅助：交叉检查 panel/public/app.js 用到的 #id 是否都在 index.html 里
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const js = fs.readFileSync(path.join(HERE, '..', 'panel', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(HERE, '..', 'panel', 'public', 'index.html'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));

const missing = [...jsIds].filter((id) => !htmlIds.has(id));
const unused = [...htmlIds].filter((id) => !jsIds.has(id));

console.log(`html id ${htmlIds.size} 个，app.js 用到 ${jsIds.size} 个`);
console.log('app.js 用了但 html 里没有：', missing.length ? missing.join(', ') : '（无）');
console.log('html 里有但 app.js 没用到：', unused.length ? unused.join(', ') : '（无）');
process.exitCode = missing.length ? 1 : 0;
