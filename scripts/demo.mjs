/**
 * 演示/可视化校验环境：启动一个假模型服务 + Skill Lab，并预置示例 skill。
 * 用于截屏检查界面，也方便在没有真实 API Key 时体验完整流程。
 *
 * 用法：node scripts/demo.mjs [--port 5179] [--data .demo/data]
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 5179;
const dataDir = path.resolve(ROOT, args[args.indexOf('--data') + 1] || '.demo/data');

/* ------------------------------ 假模型服务 ------------------------------ */

// 内联一张 SVG 折线图，让演示环境不依赖外网也能展示「图片输出」能力
const CHART_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="190" viewBox="0 0 440 190">'
  + '<rect width="440" height="190" rx="10" fill="#ffffff" stroke="#e3e6ec"/>'
  + '<text x="20" y="28" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="#1a1d23">本周新增用户趋势</text>'
  + '<g stroke="#eef0f6"><line x1="46" y1="60" x2="420" y2="60"/><line x1="46" y1="95" x2="420" y2="95"/><line x1="46" y1="130" x2="420" y2="130"/></g>'
  + '<polyline points="60,132 128,116 196,124 264,100 332,72" fill="none" stroke="#4f46e5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<g fill="#4f46e5"><circle cx="60" cy="132" r="4"/><circle cx="128" cy="116" r="4"/><circle cx="196" cy="124" r="4"/><circle cx="264" cy="100" r="4"/><circle cx="332" cy="72" r="4"/></g>'
  + '<g font-family="system-ui,sans-serif" font-size="11" fill="#8b93a1" text-anchor="middle"><text x="60" y="158">一</text><text x="128" y="158">二</text><text x="196" y="158">三</text><text x="264" y="158">四</text><text x="332" y="158">五</text></g>'
  + '<text x="344" y="70" font-family="system-ui,sans-serif" font-size="11" font-weight="600" fill="#4f46e5">1,284</text></svg>';

const CHART_URL = `data:image/svg+xml;base64,${Buffer.from(CHART_SVG, 'utf8').toString('base64').replace(/\+/g, '%2B')}`;

const REPLY = [
  '已完成周报整理，共 3 个要点。',
  '',
  '| 指标 | 本周 | 环比 |',
  '| --- | --- | --- |',
  '| 新增用户 | 1,284 | +12.4% |',
  '| 活跃率 | 43.7% | -1.2pp |',
  '| 平均时长 | 8.6 分钟 | +0.4 |',
  '',
  '### 趋势图',
  '',
  `![本周新增用户趋势](${CHART_URL} "本周趋势图")`,
  '',
  '> 结论：新增用户增速稳定，活跃率小幅回落需关注次日留存。',
  '',
  '```json',
  '{ "highlights": ["拉新稳定", "留存承压"] }',
  '```',
].join('\n');

const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }

  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'demo-large' }, { id: 'demo-fast' }, { id: 'demo-vision' }] }));
  }

  if (req.url.includes('/chat/completions')) {
    const used = JSON.stringify(body.messages || []).includes('SKILL INSTRUCTIONS');
    const head = used ? '（已应用 skill 指令）\n\n' : '（未注入 skill 的对照组）\n\n';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const full = head + REPLY;
    send({ choices: [{ delta: { reasoning_content: '先确认用户想要的是周报结构，再整理指标…' } }] });
    for (let i = 0; i < full.length; i += 24) {
      send({ choices: [{ delta: { content: full.slice(i, i + 24) } }] });
      await new Promise((r) => setTimeout(r, 12));
    }
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 612, completion_tokens: 268, total_tokens: 880 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(404).end('not found');
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}/v1`;

/* ------------------------------- 预置数据 ------------------------------- */

const configFile = path.join(dataDir, 'config.json');
await fs.mkdir(path.join(dataDir, 'skills'), { recursive: true });

// 演示环境每次启动都把内置的演示服务商指向本次的假模型端口（不影响用户自建的服务商）
let existing = null;
try { existing = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch { /* 首次运行 */ }

const demoProvider = {
  id: 'p_demo', name: '演示模型（本地模拟）', preset: 'custom', protocol: 'openai',
  baseUrl: mockBase, apiKey: 'sk-demo', models: ['demo-large', 'demo-fast', 'demo-vision'],
  defaultModel: 'demo-large', allowEmptyKey: true,
};

if (existing) {
  existing.providers = [demoProvider, ...(existing.providers || []).filter((p) => p.id !== 'p_demo')];
  existing.activeProviderId = 'p_demo';
  await fs.writeFile(configFile, JSON.stringify(existing, null, 2), 'utf8');
  console.log('已更新演示服务商端口', mockBase);
} else {
  await fs.writeFile(configFile, JSON.stringify({
    version: 1,
    activeProviderId: 'p_demo',
    providers: [demoProvider],
    settings: { temperature: 0.7, maxTokens: 4096, systemExtra: '', gitToken: '', requestTimeoutMs: 300000 },
  }, null, 2), 'utf8');

  const samples = [
    ['weekly-report', `---\nname: 图表周报\ndescription: 把原始指标整理成带表格与趋势图的周报\nversion: 1.1.0\nallowed-tools: Read, Write\n---\n\n# 图表周报\n\n## 步骤\n1. 汇总用户给出的指标\n2. 输出 Markdown 表格，包含环比列\n3. 用一张趋势图说明变化\n4. 用一句话给出结论\n\n## 约束\n- 数字必须来自用户输入，不得编造\n`],
    ['pdf-extract', `---\nname: PDF 内容提取\ndescription: 从 PDF 中提取正文、表格并输出结构化 Markdown\nallowed-tools: Read, Bash\n---\n\n# PDF 内容提取\n\n1. 逐页读取文本层\n2. 表格转 Markdown 对齐输出\n3. 扫描件标注需要 OCR 的页码\n`],
    ['code-review', `---\nname: 代码评审\ndescription: 按严重级别输出问题清单与修改建议\n---\n\n# 代码评审\n\n按 [阻塞] / [建议] / [疑问] 三级输出，每条包含位置、原因、改法。\n`],
  ];
  for (const [id, raw] of samples) await fs.writeFile(path.join(dataDir, 'skills', `${id}.md`), raw, 'utf8');
  await fs.writeFile(path.join(dataDir, 'skills', 'index.json'), JSON.stringify({
    version: 1,
    skills: samples.map(([id], i) => ({
      id,
      name: ['图表周报', 'PDF 内容提取', '代码评审'][i],
      description: ['把原始指标整理成带表格与趋势图的周报', '从 PDF 中提取正文、表格并输出结构化 Markdown', '按严重级别输出问题清单与修改建议'][i],
      version: i === 0 ? '1.1.0' : '',
      allowedTools: i === 0 ? ['Read', 'Write'] : i === 1 ? ['Read', 'Bash'] : [],
      sourceType: i === 0 ? 'git' : 'local',
      source: i === 0 ? 'https://github.com/example/skills/tree/main/weekly-report' : `E:\\tools\\test-skill\\.demo\\${id}`,
      dir: '', files: [], importedAt: new Date(Date.now() - i * 86400000).toISOString(),
      instructionsLength: samples[i][1].replace(/^---[\s\S]*?---\n/, '').trim().length,
    })),
  }, null, 2), 'utf8');
  console.log('已写入演示数据', dataDir);
}

const { server } = await createApp({ dataDir });
await new Promise((r) => server.listen(port, '127.0.0.1', r));

console.log(`\n  演示环境已就绪`);
console.log(`  ────────────────────────────────`);
console.log(`  界面     http://127.0.0.1:${port}`);
console.log(`  假模型   ${mockBase}`);
console.log(`  数据     ${dataDir}`);
console.log(`  ────────────────────────────────\n`);
void ROOT;
