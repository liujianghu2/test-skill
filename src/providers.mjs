/**
 * 大模型适配层。
 *
 * 统一事件协议（async iterable）：
 *   { type: 'reasoning', text }   思考链增量
 *   { type: 'text', text }        正文增量
 *   { type: 'tool_call', call }   { id, name, arguments }
 *   { type: 'usage', usage }      { inputTokens, outputTokens, totalTokens }
 *   { type: 'done', stopReason }
 *
 * 协议：openai（OpenAI 兼容：DeepSeek/Qwen/Kimi/GLM/MiniMax/SiliconFlow/OpenRouter/Ollama/vLLM…）
 *      anthropic（Claude Messages）、gemini（Google generateContent）、
 *      image（OpenAI 兼容图片生成，/images/generations）。
 */

import { joinUrl, readSse } from './http.mjs';

export const PROVIDER_PRESETS = [
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'] },
  { id: 'anthropic', label: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-haiku-4-5-20251001', 'claude-3-7-sonnet-20250219'] },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'qwen', label: '阿里云百炼 / 通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen3-max', 'qwen-vl-max'] },
  { id: 'moonshot', label: 'Moonshot Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0905-preview', 'moonshot-v1-128k'] },
  { id: 'zhipu', label: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4.5', 'glm-4-plus'] },
  { id: 'minimax', label: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.chat/v1', models: ['MiniMax-Text-01', 'abab6.5s-chat'] },
  { id: 'siliconflow', label: 'SiliconFlow 硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3.2-Exp', 'Qwen/Qwen3-235B-A22B-Instruct-2507'] },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'openai/gpt-5'] },
  { id: 'gemini', label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'] },
  { id: 'ollama', label: '本地 Ollama', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3:8b', 'llama3.2', 'deepseek-r1:7b'], apiKeyOptional: true },
  { id: 'custom', label: '自定义（OpenAI 兼容）', protocol: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', models: [], apiKeyOptional: true },
  { id: 'custom-image', label: '自定义（图片生成）', protocol: 'image', baseUrl: 'https://api.openai.com/v1', models: ['gpt-image-1', 'dall-e-3'] },
];

export function presetById(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS.find((p) => p.id === 'custom');
}

export function authHeaders(provider) {
  const key = provider.apiKey || '';
  switch (provider.protocol) {
    case 'anthropic':
      return { 'x-api-key': key, 'anthropic-version': provider.anthropicVersion || '2023-06-01' };
    case 'gemini':
      return { 'x-goog-api-key': key };
    default:
      return key ? { authorization: `Bearer ${key}` } : {};
  }
}

export function commonHeaders(provider) {
  const h = { 'content-type': 'application/json', ...authHeaders(provider) };
  if (provider.headers && typeof provider.headers === 'object') Object.assign(h, provider.headers);
  return h;
}

/** 归一化 provider，补齐 preset 默认值并做一次配置校验。 */
export function normalizeProvider(input = {}) {
  const preset = presetById(input.preset || input.id);
  const provider = {
    id: input.id,
    name: input.name || preset.label,
    preset: input.preset || preset.id,
    protocol: input.protocol || preset.protocol,
    baseUrl: (input.baseUrl || preset.baseUrl || '').trim(),
    apiKey: input.apiKey || '',
    models: Array.isArray(input.models) && input.models.length ? input.models : [...preset.models],
    defaultModel: input.defaultModel || '',
    chatPath: input.chatPath || '',
    anthropicVersion: input.anthropicVersion || '',
    headers: input.headers || undefined,
    extraBody: input.extraBody || undefined,
  };
  return provider;
}

export function validateProvider(provider) {
  const preset = presetById(provider.preset);
  const problems = [];
  if (!provider.baseUrl) problems.push('Base URL 不能为空');
  if (!provider.apiKey && !preset.apiKeyOptional && !provider.allowEmptyKey) problems.push('API Key 不能为空');
  try { new URL(provider.baseUrl); } catch { problems.push(`Base URL 不是合法地址：${provider.baseUrl}`); }
  if (!provider.defaultModel && !provider.models?.length) problems.push('至少需要一个模型名');
  return problems;
}

/** 流式对话入口。 */
export async function* streamChat(provider, req) {
  const protocol = provider.protocol || 'openai';
  if (protocol === 'anthropic') yield* streamAnthropic(provider, req);
  else if (protocol === 'gemini') yield* streamGemini(provider, req);
  else yield* streamOpenAI(provider, req);
}

/* ------------------------------- OpenAI ------------------------------- */

/** 把「纯文本 + 图片」内容块按 OpenAI 兼容格式合并进消息。 */
export function applyOpenAIContentBlocks(messages, contentBlocks) {
  if (!contentBlocks?.length) return messages;
  const hasImage = contentBlocks.some((b) => b.type === 'image_url');
  if (!hasImage) return messages;
  const parts = contentBlocks.map((b) => (b.type === 'image_url' ? b : { type: 'text', text: b.text }));
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      out[i] = { ...out[i], content: parts };
      return out;
    }
  }
  out.push({ role: 'user', content: parts });
  return out;
}

export async function* streamOpenAI(provider, { messages, contentBlocks, model, temperature, maxTokens, signal, extraBody }) {
  const url = joinUrl(provider.baseUrl, provider.chatPath || '/chat/completions');
  const finalMessages = applyOpenAIContentBlocks(messages, contentBlocks);
  const body = { model, messages: finalMessages, stream: true, stream_options: { include_usage: true } };
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (provider.extraBody) Object.assign(body, provider.extraBody);
  if (extraBody) Object.assign(body, extraBody);

  const res = await fetch(url, { method: 'POST', headers: commonHeaders(provider), body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}：${text.slice(0, 600)}`);
  }

  // 部分兼容服务会忽略 stream:true 直接返回整包 JSON，这里按 content-type 分流
  if (!/event-stream/i.test(res.headers.get('content-type') || '')) {
    const parsed = parseOpenAIResponseBody(await res.text(), res.headers.get('content-type') || 'application/json');
    if (parsed.reasoning) yield { type: 'reasoning', text: parsed.reasoning };
    if (parsed.text) yield { type: 'text', text: parsed.text };
    for (const call of parsed.toolCalls) yield { type: 'tool_call', call };
    if (Object.keys(parsed.usage).length) yield { type: 'usage', usage: parsed.usage };
    yield { type: 'done', stopReason: parsed.stopReason || 'stop' };
    return;
  }

  const toolAcc = new Map();
  const pending = [];
  let stopReason = '';
  let sawChunk = false;

  await readSse(res, (data) => {
    if (data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { return; }
    sawChunk = true;
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const choice = json.choices?.[0];
    const delta = choice?.delta || choice?.message || {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) pending.push({ type: 'reasoning', text: String(reasoning) });
    if (delta.content) pending.push({ type: 'text', text: typeof delta.content === 'string' ? delta.content : JSON.stringify(delta.content) });
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = toolAcc.get(idx) || { id: tc.id || `call_${idx}`, name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        toolAcc.set(idx, cur);
      }
    }
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    if (json.usage) {
      pending.push({
        type: 'usage',
        usage: { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens, totalTokens: json.usage.total_tokens },
      });
    }
  });

  while (pending.length) yield pending.shift();
  for (const call of toolAcc.values()) yield { type: 'tool_call', call: normalizeCall(call) };
  if (!sawChunk) {
    yield* nonStreamFallback(provider, { messages, model, temperature, maxTokens, signal, url });
    return;
  }
  yield { type: 'done', stopReason: stopReason || 'stop' };
}

/** 归一化工具调用：把 arguments 尽力解析成对象，同时保留原始字符串。 */
function normalizeCall(call) {
  let args = call.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* 保留原始字符串 */ }
  }
  return {
    id: call.id,
    name: call.name,
    arguments: args,
    raw: call.raw ?? (typeof args === 'string' ? args : JSON.stringify(args ?? {})),
  };
}

/**
 * 解析一段「可能是 SSE、也可能是整包 JSON」的响应体。
 * 用于服务端忽略 stream 参数的情况（Ollama、部分网关与国产兼容层）。
 */
export function parseOpenAIResponseBody(raw, contentType = '') {
  const out = { text: '', reasoning: '', toolCalls: [], usage: {}, stopReason: '' };
  const text = String(raw ?? '');
  const isSse = /event-stream/i.test(contentType) || /^\s*data:\s*\{/m.test(text);

  if (isSse) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      accumulateChatChunk(out, json);
    }
  } else {
    let json;
    try { json = JSON.parse(text); } catch {
      throw new Error(`无法解析响应：${text.slice(0, 300)}`);
    }
    accumulateChatChunk(out, json);
  }

  out.toolCalls = out.toolCalls.filter(Boolean).map(normalizeCall);
  return out;
}

/** 把一条 OpenAI 风格的 chunk（流式 delta 或整包 message）累加进结果。 */
export function accumulateChatChunk(out, json) {
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  const choice = json.choices?.[0] || {};
  const msg = choice.delta || choice.message || {};
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (reasoning) out.reasoning += String(reasoning);
  if (msg.content) out.text += typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  for (const tc of msg.tool_calls || []) {
    const idx = tc.index ?? out.toolCalls.length;
    const cur = out.toolCalls[idx] || { id: tc.id || `call_${idx}`, name: '', arguments: '', raw: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name += tc.function.name;
    if (tc.function?.arguments) cur.raw = (cur.raw || '') + tc.function.arguments;
    cur.arguments = cur.raw;
    out.toolCalls[idx] = cur;
  }
  if (choice.finish_reason) out.stopReason = choice.finish_reason;
  if (json.usage) {
    out.usage = {
      inputTokens: json.usage.prompt_tokens,
      outputTokens: json.usage.completion_tokens,
      totalTokens: json.usage.total_tokens,
    };
  }
  return out;
}

async function* nonStreamFallback(provider, { messages, model, temperature, maxTokens, signal, url }) {
  const body = { model, messages, stream: false };
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (provider.extraBody) Object.assign(body, provider.extraBody);
  const res = await fetch(url, { method: 'POST', headers: commonHeaders(provider), body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}（该服务不支持 SSE 流式，非流式兜底同样失败）：${text.slice(0, 500)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`无法解析响应：${text.slice(0, 500)}`); }
  const msg = json.choices?.[0]?.message || {};
  if (msg.reasoning_content) yield { type: 'reasoning', text: msg.reasoning_content };
  if (msg.content) yield { type: 'text', text: msg.content };
  for (const tc of msg.tool_calls || []) {
    let args = tc.function?.arguments;
    try { args = JSON.parse(args); } catch { /* 保留原始 */ }
    yield { type: 'tool_call', call: { id: tc.id, name: tc.function?.name, arguments: args, raw: tc.function?.arguments } };
  }
  if (json.usage) yield { type: 'usage', usage: { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens, totalTokens: json.usage.total_tokens } };
  yield { type: 'done', stopReason: json.choices?.[0]?.finish_reason || 'stop' };
}

/* ------------------------------ Anthropic ------------------------------ */

/** 把内容块转成 Anthropic 的 image/text 块。 */
export function toAnthropicBlocks(contentBlocks) {
  return (contentBlocks || []).map((b) => {
    if (b.type !== 'image_url') return { type: 'text', text: b.text || '' };
    const url = b.image_url?.url || '';
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (!m) return { type: 'text', text: `（图片链接，未内联）${url}` };
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  });
}

export async function* streamAnthropic(provider, { messages, contentBlocks, model, temperature, maxTokens, signal, system }) {
  const url = joinUrl(provider.baseUrl, provider.chatPath || '/messages');
  const sys = system ?? messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const mapped = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
  const hasImage = (contentBlocks || []).some((b) => b.type === 'image_url');
  if (hasImage) {
    const blocks = toAnthropicBlocks(contentBlocks);
    if (mapped.length) mapped[mapped.length - 1] = { role: 'user', content: blocks };
    else mapped.push({ role: 'user', content: blocks });
  }
  const body = { model, max_tokens: maxTokens || 4096, stream: true, messages: mapped };
  if (sys) body.system = sys;
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) body.temperature = temperature;
  if (provider.extraBody) Object.assign(body, provider.extraBody);

  const res = await fetch(url, { method: 'POST', headers: commonHeaders(provider), body: JSON.stringify(body), signal });
  const blocks = new Map();
  let stopReason = '';
  const pending = [];

  await readSse(res, (data) => {
    let json;
    try { json = JSON.parse(data); } catch { return; }
    switch (json.type) {
      case 'content_block_start': {
        blocks.set(json.index, { type: json.content_block?.type, name: json.content_block?.name, id: json.content_block?.id, json: '' });
        break;
      }
      case 'content_block_delta': {
        const d = json.delta || {};
        if (d.type === 'thinking_delta' && d.thinking) pending.push({ type: 'reasoning', text: d.thinking });
        else if (d.type === 'text_delta' && d.text) pending.push({ type: 'text', text: d.text });
        else if (d.type === 'input_json_delta') {
          const b = blocks.get(json.index) || { json: '' };
          b.json += d.partial_json || '';
          blocks.set(json.index, b);
        }
        break;
      }
      case 'message_delta': {
        if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
        if (json.usage) pending.push({ type: 'usage', usage: { outputTokens: json.usage.output_tokens } });
        break;
      }
      case 'message_start': {
        if (json.message?.usage) pending.push({ type: 'usage', usage: { inputTokens: json.message.usage.input_tokens } });
        break;
      }
      case 'error': throw new Error(json.error?.message || JSON.stringify(json.error));
      default: break;
    }
  });

  while (pending.length) yield pending.shift();
  for (const [idx, b] of blocks) {
    if (b.type !== 'tool_use') continue;
    let args = b.json;
    try { args = JSON.parse(b.json || '{}'); } catch { /* 原始字符串 */ }
    yield { type: 'tool_call', call: { id: b.id || `tool_${idx}`, name: b.name, arguments: args, raw: b.json } };
  }
  yield { type: 'done', stopReason: stopReason || 'end_turn' };
}

/* -------------------------------- Gemini -------------------------------- */

export async function* streamGemini(provider, { messages, contentBlocks, model, temperature, maxTokens, signal, system }) {
  const base = joinUrl(provider.baseUrl, '');
  const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const sys = system ?? messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] }));
  const hasImage = (contentBlocks || []).some((b) => b.type === 'image_url');
  if (hasImage) {
    const parts = (contentBlocks || []).map((b) => {
      if (b.type !== 'image_url') return { text: b.text || '' };
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(b.image_url?.url || '');
      if (!m) return { text: `（图片链接，未内联）${b.image_url?.url || ''}` };
      return { inlineData: { mimeType: m[1], data: m[2] } };
    });
    if (contents.length) contents[contents.length - 1] = { role: 'user', parts };
    else contents.push({ role: 'user', parts });
  }
  const body = { contents };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  const gen = {};
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) gen.temperature = temperature;
  if (maxTokens) gen.maxOutputTokens = maxTokens;
  if (Object.keys(gen).length) body.generationConfig = gen;
  if (provider.extraBody) Object.assign(body, provider.extraBody);

  const res = await fetch(url, { method: 'POST', headers: commonHeaders(provider), body: JSON.stringify(body), signal });
  let stopReason = '';
  const pending = [];

  await readSse(res, (data) => {
    let json;
    try { json = JSON.parse(data); } catch { return; }
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const cand = json.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      if (part.text && !part.thought) pending.push({ type: 'text', text: part.text });
      else if (part.text && part.thought) pending.push({ type: 'reasoning', text: part.text });
      else if (part.functionCall) pending.push({ type: 'tool_call', call: { id: part.functionCall.name, name: part.functionCall.name, arguments: part.functionCall.args } });
    }
    if (cand?.finishReason) stopReason = cand.finishReason;
    if (json.usageMetadata) {
      pending.push({ type: 'usage', usage: { inputTokens: json.usageMetadata.promptTokenCount, outputTokens: json.usageMetadata.candidatesTokenCount, totalTokens: json.usageMetadata.totalTokenCount } });
    }
  });

  while (pending.length) yield pending.shift();
  yield { type: 'done', stopReason: stopReason || 'STOP' };
}

/* ----------------------------- 图片生成（可选） ----------------------------- */

export async function generateImage(provider, { prompt, model, size = '1024x1024', n = 1, signal }) {
  const url = joinUrl(provider.baseUrl, provider.imagePath || '/images/generations');
  const body = { model, prompt, n, size };
  if (provider.extraBody) Object.assign(body, provider.extraBody);
  const res = await fetch(url, { method: 'POST', headers: commonHeaders(provider), body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  const images = (json.data || []).map((d) => {
    if (d.b64_json) return { url: `data:image/png;base64,${d.b64_json}`, kind: 'base64' };
    if (d.url) return { url: d.url, kind: 'url' };
    return null;
  }).filter(Boolean);
  return { images, raw: json };
}

/* ------------------------- 非流式完整调用（连接测试/批量） ------------------------- */

/**
 * 一次性取回完整回答，返回统一结果对象。
 * @returns {Promise<{text:string, reasoning:string, toolCalls:Array, usage:object, stopReason:string}>}
 */
export async function completeChat(provider, { messages, contentBlocks, model, temperature, maxTokens, signal, system, extraBody } = {}) {
  const protocol = provider.protocol || 'openai';
  if (protocol === 'openai') return completeOpenAI(provider, { messages, contentBlocks, model, temperature, maxTokens, signal, extraBody });
  if (protocol === 'anthropic') return completeViaStream(streamAnthropic, provider, { messages, contentBlocks, model, temperature, maxTokens, signal, system, extraBody });
  if (protocol === 'gemini') return completeViaStream(streamGemini, provider, { messages, contentBlocks, model, temperature, maxTokens, signal, system, extraBody });
  throw new Error(`不支持的协议：${protocol}`);
}

async function completeOpenAI(provider, { messages, contentBlocks, model, temperature, maxTokens, signal, extraBody }) {
  const url = joinUrl(provider.baseUrl, provider.chatPath || '/chat/completions');
  const body = { model, messages: applyOpenAIContentBlocks(messages, contentBlocks), stream: false };
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (provider.extraBody) Object.assign(body, provider.extraBody);
  if (extraBody) Object.assign(body, extraBody);

  const res = await fetch(url, { method: 'POST', headers: commonHeaders(provider), body: JSON.stringify(body), signal });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${raw.slice(0, 600)}`);
  // 兼容「请求非流式、服务端仍返回 SSE」的实现
  return parseOpenAIResponseBody(raw, res.headers.get('content-type') || '');
}

async function completeViaStream(gen, provider, opts) {
  const out = { text: '', reasoning: '', toolCalls: [], usage: {}, stopReason: '' };
  for await (const evt of gen(provider, opts)) {
    if (evt.type === 'text') out.text += evt.text;
    else if (evt.type === 'reasoning') out.reasoning += evt.text;
    else if (evt.type === 'tool_call') out.toolCalls.push(evt.call);
    else if (evt.type === 'usage') Object.assign(out.usage, Object.fromEntries(Object.entries(evt.usage).filter(([, v]) => v != null)));
    else if (evt.type === 'done') out.stopReason = evt.stopReason;
  }
  return out;
}

/** 连通性测试：发一条极短消息，返回耗时与回显。 */
export async function testConnection(provider, { model, signal } = {}) {
  const started = Date.now();
  const target = model || provider.defaultModel || provider.models?.[0];
  if (!target) throw new Error('没有可用模型名，请先填写模型');
  const result = await completeChat(provider, {
    messages: [
      { role: 'system', content: 'You are a connectivity probe. Answer with exactly: OK' },
      { role: 'user', content: 'ping' },
    ],
    model: target,
    maxTokens: 32,
    temperature: 0,
    signal,
  });
  return {
    model: target,
    elapsedMs: Date.now() - started,
    reply: (result.text || result.reasoning || '').trim().slice(0, 200),
    usage: result.usage,
    stopReason: result.stopReason,
  };
}

/** 拉取可用模型列表（OpenAI 兼容 /models、Gemini /models、Ollama /api/tags）。 */
export async function listModels(provider) {
  if (provider.protocol === 'anthropic') {
    return { models: [], note: 'Anthropic 不提供公开的模型列表接口，请手动填写模型名。' };
  }
  const headers = commonHeaders(provider);
  delete headers['content-type'];
  if (provider.protocol === 'gemini') {
    const json = await fetchJson(`${joinUrl(provider.baseUrl, '')}/models`, { headers });
    const models = (json.models || []).map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
    return { models };
  }
  const json = await fetchJson(joinUrl(provider.baseUrl, provider.modelsPath || '/models'), { headers });
  const models = (json.data || json.models || [])
    .map((m) => (typeof m === 'string' ? m : m.id || m.name))
    .filter(Boolean)
    .sort();
  return { models };
}

async function fetchJson(url, { headers }) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`无法解析模型列表：${text.slice(0, 300)}`); }
}
