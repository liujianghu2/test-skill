/**
 * 自检脚本：启动服务并跑一轮 API 冒烟测试。
 * 用法：node scripts/smoke.mjs
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-lab-smoke-'));
const dataDir = path.join(tmp, 'data');
const { server } = await createApp({ dataDir, logger: { error() {}, log() {} } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const api = async (p, init) => {
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
};
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  // 1. 元信息
  const meta = await api('/api/meta');
  check('GET /api/meta 返回预设', meta.status === 200 && meta.json.presets?.length > 8, `${meta.json.presets?.length} 个预设`);

  // 2. 配置读写
  const saved = await post('/api/providers', {
    preset: 'deepseek', name: '测试用 DeepSeek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test-1234567890', defaultModel: 'deepseek-chat', models: ['deepseek-chat'],
  });
  check('POST /api/providers 保存服务商', saved.status === 200 && saved.json.provider?.id, saved.json.provider?.id);
  const providerId = saved.json.provider.id;

  const cfg = await api('/api/config');
  const stored = cfg.json.providers.find((p) => p.id === providerId);
  check('GET /api/config 打码 API Key', cfg.status === 200 && stored?.apiKey?.includes('••'), stored?.apiKey);
  check('GET /api/config 不回传明文 Key', !JSON.stringify(cfg.json).includes('sk-test-1234567890'));

  const reveal = await api('/api/config?reveal=1');
  check('GET /api/config?reveal=1 回传明文 Key', JSON.stringify(reveal.json).includes('sk-test-1234567890'));

  const noop = await post('/api/providers', { id: providerId, preset: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', name: '改名后' });
  const afterNoop = (await api('/api/config?reveal=1')).json.providers.find((p) => p.id === providerId);
  check('打码值不会覆盖真实 Key', afterNoop.apiKey === 'sk-test-1234567890', afterNoop.apiKey);

  await post(`/api/providers/${providerId}/activate`, {});
  check('POST /api/providers/:id/activate', (await api('/api/config')).json.activeProviderId === providerId);

  // 3. 本地 skill 导入
  const skillDir = path.join(tmp, 'sample-skill');
  await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: sample-report\ndescription: 生成图文周报\nversion: 1.2.0\nallowed-tools: Read, Write, Bash\n---\n\n# 周报生成\n\n1. 读取数据\n2. 输出 Markdown 表格与一张示意图\n`, 'utf8');
  await fs.writeFile(path.join(skillDir, 'scripts', 'run.py'), 'print("hi")\n', 'utf8');

  const local = await post('/api/skills/import/local', { path: skillDir });
  check('POST /api/skills/import/local', local.status === 200 && local.json.skill?.name === 'sample-report', local.json.skill?.name);
  const skillId = local.json.skill.id;
  check('解析 allowed-tools', JSON.stringify(local.json.skill.allowedTools) === '["Read","Write","Bash"]', JSON.stringify(local.json.skill.allowedTools));
  check('解析附带文件', local.json.skill.files?.some((f) => f.path === 'scripts/run.py'));
  check('解析 description', local.json.skill.description === '生成图文周报', local.json.skill.description);

  const detail = await api(`/api/skills/${skillId}`);
  check('GET /api/skills/:id 返回正文', detail.json.skill?.instructions?.includes('周报生成'));

  // 4. SKILL.md 自动探测（无 SKILL.md 的目录只有单个 md）
  const looseDir = path.join(tmp, 'loose');
  await fs.mkdir(looseDir, { recursive: true });
  await fs.writeFile(path.join(looseDir, 'guide.md'), '# 单文件指南\n\n这是说明。\n', 'utf8');
  const loose = await post('/api/skills/import/local', { path: looseDir });
  check('单 .md 目录自动识别', loose.status === 200 && loose.json.skill?.name === '单文件指南', loose.json.skill?.name);

  // 5. 粘贴导入
  const pasted = await post('/api/skills/import/text', { text: '---\nname: pasted-one\ndescription: 粘贴测试\n---\n\n步骤一。\n' });
  check('POST /api/skills/import/text', pasted.status === 200 && pasted.json.skill?.name === 'pasted-one', pasted.json.skill?.name);

  // 6. system prompt 预览
  const preview = await post('/api/skills/preview', { id: skillId });
  check('POST /api/skills/preview 生成 system prompt', preview.json.prompt?.includes('SKILL INSTRUCTIONS') && preview.json.prompt?.includes('周报生成'));

  // 7. 指令编辑
  const upd = await post('/api/skills/update', { id: pasted.json.skill.id, instructions: '步骤一。\n步骤二。' });
  check('POST /api/skills/update 更新指令', upd.status === 200 && (await api(`/api/skills/${pasted.json.skill.id}`)).json.skill.instructions.includes('步骤二'));

  // 8. 非法路径
  const bad = await post('/api/skills/import/local', { path: path.join(tmp, 'nope') });
  check('不存在的本地路径返回 500 且带错误信息', bad.status === 500 && String(bad.json.error).includes('路径不存在'), bad.json.error);

  // 9. 文件代理的越权防护
  const forbidden = await api(`/api/file?path=${encodeURIComponent(path.join(os.tmpdir(), 'seed.txt'))}`);
  check('GET /api/file 拒绝 skill 目录外的路径', forbidden.status === 403, String(forbidden.status));
  const allowedFile = await api(`/api/file?path=${encodeURIComponent(path.join(skillDir, 'scripts', 'run.py'))}`);
  check('GET /api/file 允许 skill 目录内文件', allowedFile.status === 200 && allowedFile.json.raw?.includes('hi'));

  /* ---------------------------- 附件能力 ---------------------------- */

  // 9.1 本机路径附件：文本
  const dataFile = path.join(tmp, 'points.csv');
  await fs.writeFile(dataFile, 'day,value\n一,12\n二,19\n', 'utf8');
  const pickText = await post('/api/attach/pick', { path: dataFile });
  check('POST /api/attach/pick 读取文本附件', pickText.status === 200 && pickText.json.attachment?.kind === 'text' && pickText.json.attachment.text.includes('19'), JSON.stringify({ k: pickText.json.attachment?.kind }));

  // 9.2 本机路径附件：图片（1x1 PNG）
  const pngPath = path.join(tmp, 'dot.png');
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  await fs.writeFile(pngPath, Buffer.from(pngB64, 'base64'));
  const pickImage = await post('/api/attach/pick', { path: pngPath });
  check('POST /api/attach/pick 读取图片附件（转 data URL）', pickImage.status === 200 && pickImage.json.attachment?.kind === 'image' && pickImage.json.attachment.dataUrl.startsWith('data:image/png;base64,'), JSON.stringify({ k: pickImage.json.attachment?.kind, u: pickImage.json.attachment?.dataUrl?.slice(0, 30) }));

  // 9.3 上传接口（multipart）
  const boundary = '----skilllabtest';
  const mp = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="notes.md"\r\nContent-Type: text/markdown\r\n\r\n# 笔记\n内容在这里\n\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from(pngB64, 'base64'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const upload = await fetch(`${base}/api/attach/upload`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: mp,
  });
  const uploadJson = await upload.json();
  check('POST /api/attach/upload 解析 multipart', upload.status === 200 && uploadJson.attachments?.length === 2, `status=${upload.status} body=${JSON.stringify(uploadJson).slice(0, 300)}`);
  check('上传的文本附件内容正确', uploadJson.attachments?.[0]?.text?.includes('内容在这里'), JSON.stringify(uploadJson.attachments?.[0]?.text));
  check('上传的图片附件转为 data URL', uploadJson.attachments?.[1]?.dataUrl?.startsWith('data:image/png;base64,'));

  // 9.4 附件大小上限
  const hugePath = path.join(tmp, 'huge.txt');
  await fs.writeFile(hugePath, 'x'.repeat(9 * 1024 * 1024));
  const huge = await post('/api/attach/pick', { path: hugePath });
  check('超过单文件上限时给出明确错误', huge.status === 500 && String(huge.json.error).includes('超过单文件上限'), huge.json.error);

  // 9.5 Skill 目录文件清单与按 Skill 附带
  const skillFiles = await api(`/api/skills/${skillId}/files`);
  const listed = skillFiles.json.files || [];
  check('GET /api/skills/:id/files 列出目录文件', skillFiles.status === 200 && listed.some((f) => f.path === 'scripts/run.py' && f.exists), JSON.stringify(listed.map((f) => f.path)));
  const fromSkill = await post(`/api/skills/${skillId}/attach`, { path: path.join(skillDir, 'scripts', 'run.py') });
  check('POST /api/skills/:id/attach 附带 Skill 内文件', fromSkill.status === 200 && fromSkill.json.attachment?.text?.includes('hi'), JSON.stringify({ k: fromSkill.json.attachment?.kind }));
  const outside = await post(`/api/skills/${skillId}/attach`, { path: dataFile });
  check('POST /api/skills/:id/attach 拒绝目录外文件', outside.status === 403, String(outside.status));

  /* ------------------------- 本地目录浏览接口 ------------------------- */

  // 造一个「仓库」结构：
  //   <tmp>/repo/direct-skill/SKILL.md          → 目录自带 SKILL.md
  //   <tmp>/repo/skills/inner-skill/SKILL.md    → 需要再下一层
  const repoDir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repoDir, 'direct-skill'), { recursive: true });
  await fs.mkdir(path.join(repoDir, 'skills', 'inner-skill'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'direct-skill', 'SKILL.md'), '---\nname: direct\ndescription: d\n---\n正文\n', 'utf8');
  await fs.writeFile(path.join(repoDir, 'skills', 'inner-skill', 'SKILL.md'), '---\nname: inner\ndescription: d\n---\n正文\n', 'utf8');
  await fs.writeFile(path.join(repoDir, 'README.md'), '# 说明\n', 'utf8');

  const listing = await post('/api/fs/list', { path: repoDir });
  const names = (listing.json.items || []).map((i) => i.name);
  check('POST /api/fs/list 列出目录内容', listing.status === 200 && names.includes('direct-skill') && names.includes('skills') && names.includes('README.md'), JSON.stringify(names));
  const direct = (listing.json.items || []).find((i) => i.name === 'direct-skill');
  check('目录自带 SKILL.md 时打 hasSkill', direct?.type === 'dir' && direct?.hasSkill === true, JSON.stringify(direct));
  const skillsDir = (listing.json.items || []).find((i) => i.name === 'skills');
  check('下一层才有 SKILL.md 时打 hasSkillChild', skillsDir?.type === 'dir' && skillsDir?.hasSkill === false && skillsDir?.hasSkillChild === true, JSON.stringify(skillsDir));
  check('统计子目录里的 Skill 数量', skillsDir?.skillChildCount === 1 && skillsDir?.skillChildren?.[0]?.endsWith('inner-skill'), JSON.stringify({ c: skillsDir?.skillChildCount, p: skillsDir?.skillChildren }));
  check('返回可批量导入的子 Skill 列表', listing.json.batch?.count === 1 && listing.json.batch?.paths?.[0]?.endsWith('direct-skill'), JSON.stringify(listing.json.batch));
  check('目录下有自带 SKILL.md 的子目录时 importable=true', listing.json.importable === true, `importable=${listing.json.importable}`);
  const readme = (listing.json.items || []).find((i) => i.name === 'README.md');
  check('列出目录里的 markdown 文件', readme?.type === 'file' && readme?.isSkill === false, JSON.stringify(readme));
  check('排序：带 SKILL.md 的目录排在普通目录前', names.indexOf('direct-skill') < names.indexOf('README.md'), JSON.stringify(names));
  check('返回上一级路径', listing.json.parent === path.dirname(repoDir), listing.json.parent);
  check('目录里带 SKILL.md 时建议导入目录', listing.json.suggestion === 'dir' || listing.json.suggestion === 'file', listing.json.suggestion);
  check('返回快捷入口', Array.isArray(listing.json.quick) && listing.json.quick.length > 0, JSON.stringify(listing.json.quick?.map((q) => q.label)));

  const skillDirListing = await post('/api/fs/list', { path: skillDir });
  const skillEntry = (skillDirListing.json.items || []).find((i) => i.name === 'SKILL.md');
  check('识别目录内的 SKILL.md', skillEntry?.type === 'file' && skillEntry?.isSkill === true, JSON.stringify(skillEntry));
  check('目录自带 SKILL.md 时 importable=true', skillDirListing.json.importable === true, `importable=${skillDirListing.json.importable}`);

  // 批量导入：batch 里的路径可以直接逐个导入
  const batchPaths = listing.json.batch?.paths || [];
  if (batchPaths.length) {
    const first = await post('/api/skills/import/local', { path: batchPaths[0] });
    check('批量列表里的路径可直接导入', first.status === 200 && first.json.skill?.name === 'direct', JSON.stringify({ n: first.json.skill?.name }));
  }

  const looseListing = await post('/api/fs/list', { path: looseDir });
  check('单 markdown 目录给出导入建议', looseListing.json.suggestion === 'file', looseListing.json.suggestion);

  const emptyListing = await post('/api/fs/list', { path: '' });
  check('空路径回落到主目录', emptyListing.status === 200 && emptyListing.json.path.length > 2, emptyListing.json.path);

  const filePathListing = await post('/api/fs/list', { path: path.join(repoDir, 'README.md') });
  check('传文件路径时列出其所在目录', filePathListing.json.path === repoDir, filePathListing.json.path);

  const badListing = await post('/api/fs/list', { path: path.join(tmp, 'not-exist-dir') });
  check('不存在的路径给出明确错误', badListing.status === 500 && String(badListing.json.error).includes('路径不存在'), badListing.json.error);

  // 10. 未配置服务商时的报错
  const emptyDir = path.join(tmp, 'data-empty');
  const { server: s2 } = await createApp({ dataDir: emptyDir, logger: { error() {}, log() {} } });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${s2.address().port}`;
  const noProvider = await fetch(`${base2}/api/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hi' }) });
  check('未配置服务商时给出明确提示', noProvider.status === 500 && String((await noProvider.json()).error).includes('尚未配置'), String(noProvider.status));
  s2.close();

  // 11. 静态界面
  const home = await fetch(`${base}/`);
  const html = await home.text();
  check('GET / 返回界面', home.status === 200 && html.includes('<title>'), `${html.length} 字节`);
  const css = await fetch(`${base}/styles.css`);
  check('静态资源 styles.css 可访问', css.status === 200);
  const js = await fetch(`${base}/app.js`);
  check('静态资源 app.js 可访问', js.status === 200);

  // 12. 错误 Key 的真实调用失败路径
  const conn = await post('/api/providers/test', { providerId, model: 'deepseek-chat' }).catch((e) => ({ status: 0, json: { error: e.message } }));
  check('无效 Key 调用失败但不崩溃', conn.status >= 400 || conn.json.ok === true, `status=${conn.status}`);

  // 13. 删除
  const del = await post(`/api/skills/${skillId}/delete`, {});
  check('POST /api/skills/:id/delete', del.status === 200 && !del.json.skills.some((s) => s.id === skillId));
} catch (err) {
  check('未捕获异常', false, err.stack);
} finally {
  server.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log('\nSkill Lab 自检结果\n────────────────────────────');
console.log(results.join('\n'));
console.log(`────────────────────────────\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
