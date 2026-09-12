/** 测试执行：把 skill 与附件注入上下文，流式产出统一事件。 */

import { buildSkillPrompt, listBodyFiles } from './skill-format.mjs';
import { streamChat, normalizeProvider, validateProvider, generateImage } from './providers.mjs';
import { extractImages } from './http.mjs';

/** 附件体积上限（解码后字节），超过就拒绝而不是把上下文撑爆。 */
export const ATTACHMENT_LIMITS = {
  maxFiles: 12,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxInlineTextChars: 300_000,
};

/** 粗略估算 token：中文按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
    else if (code >= 0xf900 && code <= 0xfaff) cjk++;
    else if (code >= 0xff00 && code <= 0xffef) cjk++;
  }
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 校验并归一化前端传来的附件。
 * 每项：{ name, mime, size, kind, text?, dataUrl? }
 */
export function normalizeAttachments(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const out = [];
  let total = 0;
  for (const raw of list) {
    if (out.length >= ATTACHMENT_LIMITS.maxFiles) break;
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || 'file').slice(0, 200);
    const dataUrl = typeof raw.dataUrl === 'string' && raw.dataUrl.length > 0 ? raw.dataUrl : '';
    const text = typeof raw.text === 'string' ? raw.text : '';
    const b64 = dataUrl.startsWith('data:') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
    const size = Number(raw.size) || (b64 ? Math.floor(b64.length * 0.75) : text.length);
    if (size > ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error(`附件「${name}」${formatBytes(size)} 超过单文件上限 ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)}`);
    }
    total += size;
    if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new Error(`附件总大小超过 ${formatBytes(ATTACHMENT_LIMITS.maxTotalBytes)}`);
    }
    const kind = ['image', 'text', 'binary'].includes(raw.kind)
      ? raw.kind
      : (String(raw.mime || '').startsWith('image/') ? 'image' : 'binary');
    out.push({
      name,
      mime: String(raw.mime || (kind === 'text' ? 'text/plain' : 'application/octet-stream')),
      size,
      kind,
      text,
      dataUrl,
      source: raw.source ? String(raw.source).slice(0, 300) : '',
    });
  }
  return out;
}

/** 生成给模型看的附件说明区块；文本类附件直接内联内容。 */
export function buildAttachmentSection(attachments) {
  if (!attachments?.length) return '';
  const lines = ['=== ATTACHED FILES ==='];
  let budget = ATTACHMENT_LIMITS.maxInlineTextChars;
  attachments.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.name}（${a.mime}，${formatBytes(a.size)}）`);
    if (a.source) lines.push(`   来源：${a.source}`);
    if (a.kind === 'text' && a.text) {
      const body = a.text.length > budget ? `${a.text.slice(0, budget)}\n…（内容过长已截断）` : a.text;
      budget -= body.length;
      lines.push(`--- ${a.name} 开始 ---`, body, `--- ${a.name} 结束 ---`);
    } else if (a.kind === 'image') {
      lines.push('   （图片内容随消息一并发送；如当前模型不支持读图，请提示用户改用支持视觉的模型）');
    } else {
      lines.push('   （二进制文件，未内联内容；请基于文件名与用户说明作答，必要时提示用户提供文本版本）');
    }
  });
  lines.push('=== END ATTACHED FILES ===');
  return lines.join('\n');
}

/** 组装一次测试的全部消息（含附件），供流式与非流式共用。 */
export function buildRequestMessages({ provider, skill, input, mode = 'instructions', overrides = {}, attachments = [] }) {
  const useSkill = skill && mode !== 'none';
  const systemParts = [];
  if (useSkill) systemParts.push(buildSkillPrompt(skill, { mode, extra: overrides.systemExtra || '' }));
  else if (overrides.systemExtra) systemParts.push(overrides.systemExtra);
  const attachSection = buildAttachmentSection(attachments);
  if (attachSection) systemParts.push(attachSection);

  const system = systemParts.join('\n\n');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });

  // 多模态内容块（OpenAI 兼容格式，由适配层按协议转换）
  const contentBlocks = [];
  if (input) contentBlocks.push({ type: 'text', text: input });
  for (const a of attachments) {
    if (a.kind === 'image' && a.dataUrl) contentBlocks.push({ type: 'image_url', image_url: { url: a.dataUrl } });
  }
  messages.push({ role: 'user', content: input || '' });
  return { messages, system, contentBlocks, useSkill };
}

export function describeAttachments(attachments) {
  return (attachments || []).map((a) => ({ name: a.name, mime: a.mime, size: a.size, kind: a.kind, source: a.source }));
}

/**
 * @param {object} opts
 * @param {object} opts.provider    已归一化的服务商配置
 * @param {object} opts.skill       skill 记录（可为 null，表示不使用 skill）
 * @param {string} opts.input       用户输入
 * @param {string} opts.mode        instructions | raw | none
 * @param {object} opts.overrides   { model, temperature, maxTokens, systemExtra }
 * @param {Array}  opts.attachments 附件（见 normalizeAttachments）
 * @param {AbortSignal} opts.signal
 */
export async function* runTest({ provider, skill, input, mode = 'instructions', overrides = {}, attachments = [], toolHints = null, signal }) {
  const start = Date.now();
  const model = overrides.model || provider.defaultModel || provider.models?.[0];
  const files = normalizeAttachments(attachments);
  const { messages, system, contentBlocks, useSkill } = buildRequestMessages({
    provider, skill, input, mode, overrides, attachments: files,
  });

  const systemChars = system.length;
  const attachmentChars = files.reduce((n, a) => n + (a.kind === 'text' ? a.text.length : 0), 0);
  yield {
    type: 'meta',
    meta: {
      model,
      providerId: provider.id,
      providerName: provider.name,
      skill: useSkill ? { id: skill.id, name: skill.name } : null,
      mode,
      startedAt: new Date(start).toISOString(),
      attachments: describeAttachments(files),
      context: {
        systemChars,
        attachmentChars,
        inputChars: String(input || '').length,
        promptChars: systemChars + String(input || '').length + attachmentChars,
        estimatedPromptTokens: estimateTokens(system) + estimateTokens(input) + estimateTokens(files.filter((f) => f.kind === 'text').map((f) => f.text).join('\n')),
        imageCount: files.filter((f) => f.kind === 'image').length,
      },
    },
  };

  const toolDefs = useSkill ? buildToolDefs(skill, toolHints) : [];
  let text = '';
  let reasoning = '';
  let usage = {};
  let stopReason = '';
  const toolCalls = [];

  for await (const evt of streamChat(provider, {
    messages,
    contentBlocks,
    model,
    temperature: overrides.temperature,
    maxTokens: overrides.maxTokens,
    system,
    signal,
    extraBody: toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' } : undefined,
  })) {
    if (evt.type === 'text') { text += evt.text; yield evt; }
    else if (evt.type === 'reasoning') { reasoning += evt.text; yield evt; }
    else if (evt.type === 'tool_call') { toolCalls.push(evt.call); yield evt; }
    else if (evt.type === 'usage') { usage = { ...usage, ...stripUndef(evt.usage) }; yield evt; }
    else if (evt.type === 'done') { stopReason = evt.stopReason; }
  }

  const images = extractImages(text);
  const elapsedMs = Date.now() - start;
  const summary = {
    text,
    reasoning,
    usage,
    stopReason,
    elapsedMs,
    images,
    toolCalls,
    model,
    attachments: describeAttachments(files),
    outputTokensPerSecond: usage.outputTokens && elapsedMs ? +(usage.outputTokens / (elapsedMs / 1000)).toFixed(1) : null,
  };
  yield { type: 'result', result: summary };
}

function stripUndef(obj = {}) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

/** 依据 skill 的 allowed-tools 生成宽松的工具声明，用于观察模型是否会发起工具调用。 */
function buildToolDefs(skill, hints) {
  const names = skill.allowedTools?.length ? skill.allowedTools : [];
  if (!names.length) return [];
  const map = hints && typeof hints === 'object' ? hints : {};
  return names.slice(0, 20).map((name) => ({
    type: 'function',
    function: {
      name: String(name).replace(/[^\w.-]/g, '_').slice(0, 64),
      description: map[name] || `Skill「${skill.name}」声明的能力：${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  }));
}

/** 纯图片生成测试（服务商协议为 image 时）。 */
export async function runImageTest({ provider, skill, input, overrides = {}, signal }) {
  const start = Date.now();
  const prompt = skill && overrides.mode !== 'none'
    ? `${buildSkillPrompt(skill, { mode: overrides.mode || 'instructions', extra: overrides.systemExtra || '' })}\n\n=== USER REQUEST ===\n${input}`
    : input;
  const { images, raw } = await generateImage(provider, {
    prompt,
    model: overrides.model || provider.defaultModel || provider.models?.[0],
    size: overrides.size || '1024x1024',
    signal,
  });
  return {
    elapsedMs: Date.now() - start,
    model: overrides.model || provider.defaultModel,
    images: images.map((i) => ({ ...i, alt: input.slice(0, 80) })),
    raw,
  };
}

export { normalizeProvider, validateProvider, listBodyFiles };
