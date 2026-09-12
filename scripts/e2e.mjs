/**
 * 端到端测试：用一个本地假模型服务模拟 OpenAI / Anthropic / Gemini 三种协议，
 * 验证「skill 注入 -> 流式请求 -> 事件解析 -> 结果汇总」全链路。
 * 用法：node scripts/e2e.mjs
 */

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { parseSkillText, buildSkillPrompt } from '../src/skill-format.mjs';
import { parseOpenAIResponseBody, completeChat, streamChat } from '../src/providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

/* ---------------------- 假模型服务 ---------------------- */

const seenRequests = [];

const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  seenRequests.push({ url: req.url, headers: req.headers, body });

  const reply = '这是结果：\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |\n\n![示意图](https://example.com/pic.png)\n\n```js\nconsole.log(1)\n```';

  // OpenAI 兼容
  if (req.url.includes('/chat/completions')) {
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
      }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ delta: { reasoning_content: '先想一下…' } }] });
    // 触发工具调用：验证 arguments 分片拼接与解析
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"pa' } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.md"}' } }] } }] });
    send({ choices: [{ delta: { content: '这是结果：\n\n' } }] });
    send({ choices: [{ delta: { content: '| 列 | 值 |\n| --- | --- |\n| a | 1 |\n\n' } }] });
    send({ choices: [{ delta: { content: '![示意图](https://example.com/pic.png)\n\n```js\nconsole.log(1)\n```' } }] });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // Anthropic
  if (req.url.includes('/messages')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ type: 'message_start', message: { usage: { input_tokens: 90 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 33 } });
    send({ type: 'message_stop' });
    return res.end();
  }

  // Gemini
  if (req.url.includes(':streamGenerateContent')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20, totalTokenCount: 100 } })}\n\n`);
    return res.end();
  }

  res.writeHead(404).end('nope');
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}`;

/* ---------------------- 纯函数检查 ---------------------- */

{
  const s = parseSkillText(`---\nname: pdf\ndescription: "处理 PDF"\nallowed-tools: Read, Bash\nmetadata:\n  author: me\n  tags: [a, b]\n---\n\n# 步骤\n\n1. 做这个\n2. 做那个\n`);
  check('frontmatter 基本字段', s.name === 'pdf' && s.description === '处理 PDF', `${s.name}/${s.description}`);
  check('allowed-tools 列表', JSON.stringify(s.allowedTools) === '["Read","Bash"]', JSON.stringify(s.allowedTools));
  check('metadata 嵌套块', s.metadata?.author === 'me' && JSON.stringify(s.metadata.tags) === '["a","b"]', JSON.stringify(s.metadata));
  check('正文不含 frontmatter', !s.instructions.includes('---') && s.instructions.includes('1. 做这个'));

  const noFm = parseSkillText('## 我的技能\n\n做一件很酷的事。\n');
  check('无 frontmatter 时用标题与首段推断', noFm.name === '我的技能' && noFm.description === '做一件很酷的事。', `${noFm.name}/${noFm.description}`);

  const prompt = buildSkillPrompt(s, { extra: '额外上下文' });
  check('system prompt 结构完整', prompt.includes('SKILL INSTRUCTIONS') && prompt.includes('处理 PDF') && prompt.includes('额外上下文'));
}

/* ---------------------- 服务级端到端 ---------------------- */

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-lab-e2e-'));
const { server } = await createApp({ dataDir: path.join(tmp, 'data'), logger: { error() {}, log() {} } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

/* ------------------ 兼容性：忽略 stream 参数的服务端 ------------------ */

{
  const sseForNonStream = [
    'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const parsed = parseOpenAIResponseBody(sseForNonStream, 'text/event-stream');
  check('解析 SSE 形式的非流式响应', parsed.text === '你好，世界' && parsed.reasoning === '思考中', JSON.stringify({ t: parsed.text, r: parsed.reasoning }));
  check('SSE 形式下统计 usage', parsed.usage.outputTokens === 4, JSON.stringify(parsed.usage));

  const plain = parseOpenAIResponseBody(JSON.stringify({
    choices: [{ message: { content: '整包 JSON' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }), 'application/json');
  check('解析整包 JSON 响应', plain.text === '整包 JSON' && plain.usage.totalTokens === 7, JSON.stringify(plain));

  const toolJson = parseOpenAIResponseBody(JSON.stringify({
    choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"p":"a"}' } }] }, finish_reason: 'tool_calls' }],
  }), 'application/json');
  check('整包 JSON 中的工具调用被解析', toolJson.toolCalls[0]?.name === 'read_file' && toolJson.toolCalls[0]?.arguments?.p === 'a', JSON.stringify(toolJson.toolCalls));

  // 服务端无视 stream:true 直接返回整包 JSON
  const jsonServer = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '无视流式' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((r) => jsonServer.listen(0, '127.0.0.1', r));
  const jsonBase = `http://127.0.0.1:${jsonServer.address().port}/v1`;
  const provider = { id: 't', name: 't', preset: 'custom', protocol: 'openai', baseUrl: jsonBase, apiKey: 'x', models: ['m'] };

  const streamed = [];
  for await (const evt of streamChat(provider, { messages: [{ role: 'user', content: 'hi' }], model: 'm' })) streamed.push(evt);
  check('streamChat 兼容返回整包 JSON 的服务', streamed.some((e) => e.type === 'text' && e.text === '无视流式') && streamed.some((e) => e.type === 'done'), JSON.stringify(streamed.map((e) => e.type)));

  const completed = await completeChat(provider, { messages: [{ role: 'user', content: 'hi' }], model: 'm' });
  check('completeChat 兼容返回整包 JSON 的服务', completed.text === '无视流式' && completed.usage.totalTokens === 2, JSON.stringify(completed));
  jsonServer.close();
}

// 服务端无视 stream:false 仍返回 SSE
{
  const sseServer = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"SSE-忽略流式参数"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":6,"total_tokens":9}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => sseServer.listen(0, '127.0.0.1', r));
  const provider = { id: 't2', name: 't2', preset: 'custom', protocol: 'openai', baseUrl: `http://127.0.0.1:${sseServer.address().port}/v1`, apiKey: 'x', models: ['m'] };
  const completed = await completeChat(provider, { messages: [{ role: 'user', content: 'hi' }], model: 'm' });
  check('completeChat 兼容返回 SSE 的服务（回归）', completed.text === 'SSE-忽略流式参数' && completed.usage.outputTokens === 6, JSON.stringify(completed));
  sseServer.close();
}

try {
  // 导入 skill
  const skillDir = path.join(tmp, 'imgs');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: 图表周报\ndescription: 输出带图表的周报\n---\n\n必须输出 markdown 表格与一张示意图。\n', 'utf8');
  const imported = await post('/api/skills/import/local', { path: skillDir });
  const skillId = imported.json.skill.id;

  // 三种协议的 provider
  const mk = async (preset, protocol) => (await post('/api/providers', {
    preset, protocol, name: preset, baseUrl: mockBase, apiKey: 'sk-mock', defaultModel: protocol === 'anthropic' ? 'claude-x' : protocol === 'gemini' ? 'gemini-x' : 'gpt-x',
  })).json.provider.id;
  const openaiId = await mk('custom', 'openai');
  const anthropicId = await mk('anthropic', 'anthropic');
  const geminiId = await mk('gemini', 'gemini');

  // 附件：三种协议各自的多模态注入格式
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const attachmentFixture = [
    { name: 'points.csv', mime: 'text/csv', size: 26, kind: 'text', text: 'day,value\n一,12\n二,19\n' },
    { name: 'shot.png', mime: 'image/png', size: 70, kind: 'image', dataUrl: `data:image/png;base64,${PNG_B64}` },
  ];

  for (const [label, pid] of [['OpenAI 兼容', openaiId], ['Anthropic', anthropicId], ['Gemini', geminiId]]) {
    seenRequests.length = 0;
    const res = await fetch(`${base}/api/test/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: pid, skillId, input: '做一份周报', mode: 'instructions', overrides: { temperature: 0.3, maxTokens: 512 } }),
    });
    const text = await res.text();
    const events = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const result = events.find((e) => e.type === 'result')?.result;
    const meta = events.find((e) => e.type === 'meta')?.meta;
    const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.text).join('');

    check(`${label}：流式返回 meta`, Boolean(meta?.model), meta?.model);
    check(`${label}：正文拼接正确`, Boolean(result?.text?.includes('这是结果')), `${result?.text?.length} 字符`);
    check(`${label}：识别出图片`, result?.images?.some((i) => i.url === 'https://example.com/pic.png'), JSON.stringify(result?.images?.map((i) => i.url)));
    check(`${label}：统计耗时与用量`, result?.elapsedMs >= 0 && result?.usage?.outputTokens > 0, JSON.stringify(result?.usage));

    // skill 是否真的进入了请求
    const payload = seenRequests[0]?.body || {};
    const injected = JSON.stringify(payload);
    check(`${label}：skill 指令已注入请求`, injected.includes('必须输出 markdown 表格'), injected.includes('图表周报') ? '含名称' : '缺名称');
    if (label === 'OpenAI 兼容') {
      check('OpenAI：请求路径正确', seenRequests[0].url === '/chat/completions', seenRequests[0].url);
      check('OpenAI：Bearer 鉴权头', seenRequests[0].headers.authorization === 'Bearer sk-mock');
      check('OpenAI：思考链事件', reasoning.includes('先想一下'), reasoning.slice(0, 20));
      check('OpenAI：temperature 透传', payload.temperature === 0.3 && payload.max_tokens === 512, `${payload.temperature}/${payload.max_tokens}`);
      const call = result?.toolCalls?.[0];
      check('OpenAI：工具调用分片被拼接', call?.name === 'read_file', JSON.stringify(call?.name));
      check('OpenAI：工具参数被解析为对象', call?.arguments?.path === 'a.md', JSON.stringify(call?.arguments));
      check('OpenAI：保留了原始参数串', call?.raw === '{"path":"a.md"}', call?.raw);
    }
    if (label === 'Anthropic') {
      check('Anthropic：system 独立字段', String(payload.system || '').includes('必须输出 markdown 表格'));
      check('Anthropic：x-api-key 头', seenRequests[0].headers['x-api-key'] === 'sk-mock');
    }
    if (label === 'Gemini') {
      check('Gemini：systemInstruction 字段', String(payload.systemInstruction?.parts?.[0]?.text || '').includes('必须输出 markdown 表格'));
      check('Gemini：URL 带模型与 SSE', /models\/gemini-x:streamGenerateContent/.test(seenRequests[0].url), seenRequests[0].url);
    }
  }

  /* -------------------- 附件注入（分协议多模态格式） -------------------- */
  for (const [label, pid] of [['OpenAI 兼容', openaiId], ['Anthropic', anthropicId], ['Gemini', geminiId]]) {
    seenRequests.length = 0;
    const res = await fetch(`${base}/api/test/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: pid, skillId, input: '按附件画图', mode: 'instructions', attachments: attachmentFixture }),
    });
    const text = await res.text();
    const events = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const meta = events.find((e) => e.type === 'meta')?.meta;
    const payload = seenRequests[0]?.body || {};
    const raw = JSON.stringify(payload);

    check(`${label}：meta 带附件清单`, meta?.attachments?.length === 2, JSON.stringify(meta?.attachments?.map((a) => a.name)));
    check(`${label}：文本附件内容进入提示词`, raw.includes('day,value'), '查找 CSV 内容');
    check(`${label}：附件清单进入提示词`, raw.includes('ATTACHED FILES'), '查找附件区块');
    check(`${label}：统计上下文规模`, meta?.context?.promptChars > 0 && meta?.context?.imageCount === 1, JSON.stringify(meta?.context));

    if (label === 'OpenAI 兼容') {
      const content = payload.messages?.find((m) => m.role === 'user')?.content;
      check('OpenAI：图片走 content 数组', Array.isArray(content) && content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')), JSON.stringify(content).slice(0, 120));
    }
    if (label === 'Anthropic') {
      const content = payload.messages?.[payload.messages.length - 1]?.content;
      check('Anthropic：图片走 image/source 块', Array.isArray(content) && content.some((b) => b.type === 'image' && b.source?.media_type === 'image/png'), JSON.stringify(content).slice(0, 160));
    }
    if (label === 'Gemini') {
      const parts = payload.contents?.[payload.contents.length - 1]?.parts;
      check('Gemini：图片走 inlineData', Array.isArray(parts) && parts.some((p) => p.inlineData?.mimeType === 'image/png'), JSON.stringify(parts).slice(0, 160));
    }
  }

  // 附件超限要明确报错，而不是把上下文撑爆
  {
    const big = await post('/api/test/stream', {
      providerId: openaiId,
      input: 'x',
      attachments: [{ name: 'huge.bin', mime: 'application/octet-stream', size: 9 * 1024 * 1024, kind: 'text', text: 'x' }],
    });
    check('附件超限时通过 error 事件报错', big.status === 400 && String(big.json.error).includes('超过单文件上限'), big.json.error);
  }

  // 非流式 /api/test
  const single = await post('/api/test', { providerId: openaiId, skillId, input: '周报' });
  check('POST /api/test 非流式返回文本', single.status === 200 && single.json.text?.includes('这是结果'), `status=${single.status}`);
  check('POST /api/test 返回图片数组', single.json.images?.length >= 1);

  // 连接测试
  const conn = await post('/api/providers/test', { providerId: openaiId, model: 'gpt-x' });
  check('POST /api/providers/test 连通性测试', conn.status === 200 && conn.json.ok === true && conn.json.elapsedMs >= 0, conn.json.reply);
  const badConn = await post('/api/providers/test', { provider: { preset: 'custom', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', models: ['m'] } });
  check('连不通时返回错误而不崩溃', badConn.status === 500, String(badConn.status));

  // 模型列表
  const models = await post('/api/providers/models', { provider: { preset: 'custom', protocol: 'openai', baseUrl: `${mockBase}`, apiKey: 'x', models: ['m'] } });
  check('POST /api/providers/models 处理无 /models 的服务', models.status >= 200, String(models.status));

  // 不使用 skill 的对照模式
  seenRequests.length = 0;
  await fetch(`${base}/api/test/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: openaiId, skillId, input: '周报', mode: 'none' }),
  }).then((r) => r.text());
  check('mode=none 时不注入 skill（对照组）', !JSON.stringify(seenRequests[0].body).includes('必须输出 markdown 表格'));

  // 错误传播
  const errRes = await fetch(`${base}/api/test/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: { preset: 'custom', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', models: ['m'] }, input: 'x' }),
  });
  const errEvents = (await errRes.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('上游不可达时通过 error 事件上报', errEvents.some((e) => e.type === 'error'), errEvents.find((e) => e.type === 'error')?.error?.slice(0, 60));
} catch (err) {
  check('未捕获异常', false, err.stack);
} finally {
  server.close();
  mock.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log('\nSkill Lab 端到端测试\n────────────────────────────');
console.log(results.join('\n'));
console.log(`────────────────────────────\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
