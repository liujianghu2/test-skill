/**
 * 生成静态预览页：用真实后端返回的结果，配合线上同一份 CSS 渲染出成品界面。
 * 目的是让视觉自检不依赖浏览器自动化（无 JS、无网络等待，直接截屏即可）。
 *
 * 用法：node scripts/build-preview.mjs [--base http://127.0.0.1:5179] [--out .demo/preview.html]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../public/markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const base = args[args.indexOf('--base') + 1] || 'http://127.0.0.1:5179';
const outFile = path.resolve(ROOT, args[args.indexOf('--out') + 1] || '.demo/preview.html');

const getJson = async (p) => {
  const res = await fetch(base + p);
  if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status}`);
  return res.json();
};

const { skills } = await getJson('/api/skills');
const config = await getJson('/api/config');
const provider = config.providers[0];
const skill = skills.find((s) => s.id === 'weekly-report') || skills[0];
const model = provider?.models?.[0] || 'demo-large';

const input = '帮我把这周的数据整理成周报：新增用户 1284、活跃率 43.7%、平均时长 8.6 分钟';

const result = await (await fetch(`${base}/api/test`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ providerId: provider.id, skillId: skill.id, input, mode: 'instructions', overrides: { model, temperature: 0.7, maxTokens: 4096 } }),
})).json();

const css = await (await fetch(`${base}/styles.css`)).text();
const index = await (await fetch(`${base}/`)).text();

// 复用真实页面的结构，只替换动态部分（此处为静态快照，用于视觉校验）
const startMarker = '<div class="turns" id="turns"></div>';
const endMarker = '<footer class="composer">';
const start = index.indexOf(startMarker);
const end = index.indexOf(endMarker);
if (start < 0 || end < 0) throw new Error('无法从 index.html 定位 turns/composer 区块');

const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const images = result.images || [];
const metrics = [
  `<span><b>耗时</b> ${fmtMs(result.elapsedMs)}</span>`,
  result.usage?.inputTokens != null ? `<span><b>输入</b> ${result.usage.inputTokens} tok</span>` : '',
  result.usage?.outputTokens != null ? `<span><b>输出</b> ${result.usage.outputTokens} tok</span>` : '',
  `<span><b>速度</b> ${(result.usage?.outputTokens / (result.elapsedMs / 1000)).toFixed(1)} tok/s</span>`,
  result.stopReason ? `<span><b>结束</b> ${esc(result.stopReason)}</span>` : '',
  `<span><b>文本</b> ${(result.text || '').length} 字</span>`,
].filter(Boolean).join('');

const reasoning = result.reasoning || '';

const turnHtml = `
<article class="turn">
  <header class="turn-head">
    <span class="chip accent">${esc(skill.name)}</span>
    <span class="chip">${esc(provider.name)}</span>
    <span class="chip">${esc(result.model || model)}</span>
    <span class="chip">注入 Skill</span>
    <span class="spacer"></span>
    <span class="time">${new Date().toTimeString().slice(0, 8)}</span>
  </header>
  <div class="turn-body">
    <p class="prompt">${esc(input)}</p>
    ${reasoning ? `<details class="reasoning" open><summary class="reasoning-head"><span>推理过程</span><span class="spacer"></span><span class="rlen">${reasoning.length} 字</span><span>▾</span></summary><div class="reasoning-body">${esc(reasoning)}</div></details>` : ''}
    <div class="answer">${renderMarkdown(result.text || '')}</div>
    ${images.length ? `<div class="gallery">${images.map((img) => `
      <figure class="figure">
        <img src="${esc(img.url)}" alt="${esc(img.alt || '')}" />
        <div class="figure-bar"><span>${esc(img.source || 'image')}</span><span class="spacer"></span><button>放大</button><button>下载</button></div>
      </figure>`).join('')}</div>` : ''}
    <div class="metrics">${metrics}</div>
  </div>
</article>`;

const page = index
  .replace(/<link rel="stylesheet" href="\/styles\.css" \/>/, `<style>\n${css}\n</style>`)
  .replace(/<script src="\/app\.js" type="module"><\/script>/, '<!-- 静态预览：不加载脚本 -->')
  .replace('</body>', '<style>.figure-bar button{cursor:default}</style></body>')
  .replace(startMarker, `<div class="turns" id="turns">${turnHtml}</div>`)
  .replace('<div class="empty-state" id="empty-state">', '<div class="empty-state" id="empty-state" hidden>');

if (page === index) throw new Error('页面替换失败');
void (start, end);

await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, page, 'utf8');
console.log(`静态预览已生成：${outFile}`);
console.log(`  skill=${skill.name}  model=${result.model}  文本=${(result.text || '').length} 字  图片=${images.length}`);
