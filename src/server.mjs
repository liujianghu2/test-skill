/** HTTP 服务：静态界面 + JSON API + NDJSON 流式测试。 */

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.mjs';
import { SkillsStore } from './skills.mjs';
import { normalizeProvider, validateProvider, listModels, testConnection, PROVIDER_PRESETS, completeChat } from './providers.mjs';
import { runTest, runImageTest, normalizeAttachments, formatBytes, ATTACHMENT_LIMITS, buildRequestMessages } from './runner.mjs';
import { buildSkillPrompt } from './skill-format.mjs';
import { extractImages } from './http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 可直接当文本读入上下文的扩展名 */
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cs', '.php', '.sh', '.bash', '.ps1', '.bat', '.sql', '.ini', '.cfg', '.conf', '.toml', '.env', '.log', '.srt', '.vtt', '.tex', '.rst']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

async function readAsAttachment(filePath, { name, source = '' } = {}) {
  const st = await fs.stat(filePath);
  if (!st.isFile()) throw new Error(`不是文件：${filePath}`);
  if (st.size > ATTACHMENT_LIMITS.maxFileBytes) {
    throw new Error(`文件 ${formatBytes(st.size)} 超过单文件上限 ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const baseName = name || path.basename(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  if (IMAGE_EXT.has(ext)) {
    const buf = await fs.readFile(filePath);
    return { name: baseName, mime, size: st.size, kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, source };
  }
  if (TEXT_EXT.has(ext) || mime.startsWith('text/')) {
    const text = await fs.readFile(filePath, 'utf8');
    return { name: baseName, mime, size: st.size, kind: 'text', text, source };
  }
  return { name: baseName, mime, size: st.size, kind: 'binary', source };
}

export async function createApp({ dataDir, logger = console } = {}) {
  const config = new ConfigStore({ dir: dataDir });
  await config.init();
  const skills = new SkillsStore({ dir: path.join(dataDir, 'skills') });
  await skills.init();

  const activeRequests = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url);
      }
    } catch (err) {
      logger.error(`[http] ${req.method} ${url.pathname} ->`, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message || String(err), stack: err.stack }));
      } else {
        res.end();
      }
    }
  });

  async function readBody(req, limitBytes = 25 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limitBytes) throw new Error(`请求体过大（> ${Math.round(limitBytes / 1024 / 1024)}MB）`);
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(text); } catch { throw new Error('请求体不是合法 JSON'); }
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  function resolveProvider(input = {}) {
    let provider = input.providerId ? config.getProvider(input.providerId) : null;
    if (!provider && input.provider && typeof input.provider === 'object') {
      // 允许前端直接传一份临时配置（不会落盘）
      provider = normalizeProvider(input.provider);
      if (!provider.apiKey && input.providerId) provider.apiKey = config.getProvider(input.providerId)?.apiKey || '';
    }
    if (!provider) provider = config.activeProvider();
    if (!provider) throw new Error('尚未配置任何模型服务商，请先在左侧「模型服务」里添加');
    return provider;
  }

  async function handleApi(req, res, url) {
    const p = url.pathname.replace(/\/+$/, '') || '/api';
    const m = req.method.toUpperCase();

    /* ----------------------------- 元信息 ----------------------------- */
    if (p === '/api/meta' && m === 'GET') {
      return sendJson(res, 200, {
        presets: PROVIDER_PRESETS,
        dataDir,
        node: process.version,
        version: '0.1.0',
      });
    }

    /* ----------------------------- 配置 ----------------------------- */
    if (p === '/api/config' && m === 'GET') {
      return sendJson(res, 200, config.publicConfig({ revealKeys: url.searchParams.get('reveal') === '1' }));
    }

    if (p === '/api/config/settings' && m === 'PATCH') {
      const patch = await readBody(req);
      const settings = await config.updateSettings(patch);
      return sendJson(res, 200, { settings: config.publicConfig().settings, ok: true });
    }

    if (p === '/api/providers' && m === 'POST') {
      const body = await readBody(req);
      const provider = await config.upsertProvider(body);
      return sendJson(res, 200, { provider: { ...provider, apiKey: config.publicConfig().providers.find((x) => x.id === provider.id)?.apiKey }, ok: true });
    }

    if (p.startsWith('/api/providers/')) {
      const id = decodeURIComponent(p.slice('/api/providers/'.length));
      if (id.endsWith('/activate') && m === 'POST') {
        await config.setActiveProvider(id.slice(0, -'/activate'.length));
        return sendJson(res, 200, { ok: true });
      }
      if (m === 'DELETE') {
        await config.removeProvider(id);
        return sendJson(res, 200, { ok: true });
      }
      if (m === 'GET') {
        const provider = config.getProvider(id);
        if (!provider) return sendJson(res, 404, { error: '服务商不存在' });
        return sendJson(res, 200, { provider });
      }
    }

    if (p === '/api/providers/test' && m === 'POST') {
      const body = await readBody(req);
      const provider = resolveProvider(body);
      const problems = validateProvider(provider);
      if (problems.length) return sendJson(res, 400, { error: problems.join('；') });
      if (provider.protocol === 'image') {
        const started = Date.now();
        const r = await runImageTest({ provider, skill: null, input: 'a small red dot on white background', overrides: { model: body.model } });
        return sendJson(res, 200, { ok: true, model: r.model, elapsedMs: Date.now() - started, images: r.images.length, reply: `已生成 ${r.images.length} 张图片` });
      }
      const result = await testConnection(provider, { model: body.model });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (p === '/api/providers/models' && m === 'POST') {
      const body = await readBody(req);
      const provider = resolveProvider(body);
      const result = await listModels(provider);
      return sendJson(res, 200, result);
    }

    /* ------------------------------ Skills ------------------------------ */
    if (p === '/api/skills' && m === 'GET') {
      return sendJson(res, 200, { skills: skills.list() });
    }

    if (p === '/api/skills/import/local' && m === 'POST') {
      const body = await readBody(req);
      const skill = await skills.importLocal(body.path);
      return sendJson(res, 200, { skill: summarize(skill), skills: skills.list() });
    }

    if (p === '/api/skills/import/git' && m === 'POST') {
      const body = await readBody(req);
      const token = body.apiKey || config.data.settings.gitToken || '';
      const skill = await skills.importFromGit(body.url, { apiKey: token });
      return sendJson(res, 200, { skill: summarize(skill), skills: skills.list() });
    }

    if (p === '/api/skills/import/text' && m === 'POST') {
      const body = await readBody(req);
      const skill = await skills.importText(body.text, { name: body.name });
      return sendJson(res, 200, { skill: summarize(skill), skills: skills.list() });
    }

    if (p.startsWith('/api/skills/')) {
      const rest = p.slice('/api/skills/'.length);
      const [id, action] = rest.split('/');
      const skillId = decodeURIComponent(id);
      if (!action && m === 'GET') {
        const skill = skills.get(skillId);
        if (!skill) return sendJson(res, 404, { error: 'skill 不存在' });
        return sendJson(res, 200, { skill: { ...summarize(skill), raw: skill.raw, instructions: skill.instructions, origin: skill.origin } });
      }
      if (action === 'delete' && m === 'POST') {
        const ok = await skills.remove(skillId);
        return sendJson(res, ok ? 200 : 404, { ok, skills: skills.list() });
      }
      if (action === 'refresh' && m === 'POST') {
        const skill = await skills.refresh(skillId, { apiKey: config.data.settings.gitToken || '' });
        return sendJson(res, 200, { skill: summarize(skill), skills: skills.list() });
      }
      if (action === 'content' && m === 'GET') {
        const skill = skills.get(skillId);
        if (!skill) return sendJson(res, 404, { error: 'skill 不存在' });
        return sendJson(res, 200, { raw: skill.raw, instructions: skill.instructions });
      }
      if (action === 'files' && m === 'GET') {
        const skill = skills.get(skillId);
        if (!skill) return sendJson(res, 404, { error: 'skill 不存在' });
        return sendJson(res, 200, { dir: skill.dir, files: await listSkillFiles(skill) });
      }
      if (action === 'attach' && m === 'POST') {
        const skill = skills.get(skillId);
        if (!skill) return sendJson(res, 404, { error: 'skill 不存在' });
        const body = await readBody(req);
        const root = path.resolve(skill.dir || '');
        const target = path.resolve(String(body.path || ''));
        const rel = path.relative(root, target);
        if (!skill.dir || (!rel || rel.startsWith('..') || path.isAbsolute(rel))) {
          return sendJson(res, 403, { error: '只能读取该 Skill 目录内的文件' });
        }
        return sendJson(res, 200, { attachment: await readAsAttachment(target, { source: `skill:${skill.name}` }) });
      }
    }

    /* ------------------------------ 附件 ------------------------------ */
    if (p === '/api/attach/pick' && m === 'POST') {
      const body = await readBody(req);
      const target = String(body.path || '').trim().replace(/^"|"$/g, '');
      if (!target) throw new Error('请填写文件路径');
      return sendJson(res, 200, { attachment: await readAsAttachment(path.resolve(target), { source: 'local' }) });
    }

    if (p === '/api/attach/upload' && m === 'POST') {
      // Node 的 IncomingMessage 没有 formData()，需要包一层 Web Request
      // 注意：只复制 content-type，不能带 content-length（流式请求不得带该头）
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        throw new Error('上传需要使用 multipart/form-data');
      }
      let form;
      try {
        const webReq = new Request('http://localhost/api/attach/upload', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: req,
          duplex: 'half',
        });
        form = await webReq.formData();
      } catch (err) {
        throw new Error(`无法解析上传内容：${err.message}`);
      }
      const files = form.getAll('files').filter((f) => typeof f === 'object' && f !== null && typeof f.arrayBuffer === 'function');
      if (!files.length) throw new Error('没有收到文件');
      const out = [];
      let total = 0;
      for (const file of files) {
        if (out.length >= ATTACHMENT_LIMITS.maxFiles) break;
        const name = String(file.name || 'file').slice(0, 200);
        const mime = file.type || 'application/octet-stream';
        const buf = Buffer.from(await file.arrayBuffer());
        if (buf.length > ATTACHMENT_LIMITS.maxFileBytes) {
          throw new Error(`文件「${name}」${formatBytes(buf.length)} 超过单文件上限 ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)}`);
        }
        total += buf.length;
        if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
          throw new Error(`附件总大小超过 ${formatBytes(ATTACHMENT_LIMITS.maxTotalBytes)}`);
        }
        const ext = path.extname(name).toLowerCase();
        if (IMAGE_EXT.has(ext) || mime.startsWith('image/')) {
          const useMime = mime.startsWith('image/') ? mime : (MIME[ext] || 'image/png');
          out.push({ name, mime: useMime, size: buf.length, kind: 'image', dataUrl: `data:${useMime};base64,${buf.toString('base64')}`, source: 'upload' });
        } else if (TEXT_EXT.has(ext) || mime.startsWith('text/')) {
          out.push({ name, mime, size: buf.length, kind: 'text', text: buf.toString('utf8'), source: 'upload' });
        } else {
          out.push({ name, mime, size: buf.length, kind: 'binary', source: 'upload' });
        }
      }
      return sendJson(res, 200, { attachments: out });
    }

    /* --------------------------- 本地目录浏览 --------------------------- */
    // 浏览器出于安全限制拿不到文件夹的绝对路径，这里由本机后端列出目录，
    // 供界面上「浏览…」选择要导入的 Skill。
    if (p === '/api/fs/list' && m === 'POST') {
      const body = await readBody(req);
      const home = os.homedir();
      let target = String(body.path || '').trim().replace(/^"|"$/g, '');
      if (!target) target = home;
      if (target.startsWith('~')) target = path.join(home, target.slice(1));
      target = path.resolve(target);

      let stat;
      try {
        stat = await fs.stat(target);
      } catch {
        throw new Error(`路径不存在或不可访问：${target}`);
      }
      if (!stat.isDirectory()) target = path.dirname(target);

      const SKILL_NAMES = new Set(['skill.md', 'skill.markdown']);
      const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
      const items = [];
      const batchSkills = []; // 当前目录下「自带 SKILL.md」的子目录，可批量导入
      let mdCandidates = 0;

      for (const entry of entries) {
        if (entry.name.startsWith('.') && !['.claude'].includes(entry.name)) continue;
        if (['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build'].includes(entry.name)) continue;
        const full = path.join(target, entry.name);
        if (entry.isDirectory()) {
          let hasSkill = false;
          const skillChildren = [];
          try {
            hasSkill = (await fs.readdir(full)).some((n) => SKILL_NAMES.has(n.toLowerCase()));
          } catch { /* 无权限就算了 */ }
          if (!hasSkill) {
            // 常见布局：<repo>/skills/<name>/SKILL.md，向下再看一层
            try {
              const sub = (await fs.readdir(full, { withFileTypes: true })).filter((s) => s.isDirectory());
              for (const s of sub) {
                if (skillChildren.length >= 60) break;
                const inner = await fs.readdir(path.join(full, s.name)).catch(() => []);
                if (inner.some((n) => SKILL_NAMES.has(n.toLowerCase()))) skillChildren.push(path.join(full, s.name));
              }
            } catch { /* 忽略 */ }
          }
          if (hasSkill) batchSkills.push(full);
          items.push({
            name: entry.name,
            path: full,
            type: 'dir',
            hasSkill,
            hasSkillChild: skillChildren.length > 0,
            skillChildCount: skillChildren.length,
            skillChildren,
          });
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          const isSkill = SKILL_NAMES.has(lower);
          const isMd = /\.(md|markdown)$/.test(lower);
          if (!isSkill && !isMd) continue;
          const st = await fs.stat(full).catch(() => null);
          if (!isSkill) mdCandidates++;
          items.push({ name: entry.name, path: full, type: 'file', size: st?.size ?? 0, isSkill });
        }
      }

      items.sort((a, b) => {
        // SKILL.md 最前，其次带 SKILL 的目录，再是普通目录，最后其他 md
        const rank = (x) => (x.type === 'file' && x.isSkill ? 0 : x.type === 'dir' && x.hasSkill ? 1 : x.type === 'dir' ? 2 : 3);
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh');
      });

      const quick = [
        { label: '主目录', path: home },
        { label: '桌面', path: path.join(home, 'Desktop') },
        { label: '文档', path: path.join(home, 'Documents') },
        { label: '下载', path: path.join(home, 'Downloads') },
      ];
      if (process.platform === 'win32') {
        for (const drive of ['D:', 'E:', 'F:']) {
          if (existsSync(`${drive}\\`)) quick.push({ label: `${drive}\\`, path: `${drive}\\` });
        }
      }
      quick.push({ label: '项目目录', path: path.resolve(__dirname, '..') });

      const existing = await Promise.all(quick.map(async (q) => {
        try {
          return (await fs.stat(q.path)).isDirectory() ? q : null;
        } catch { return null; }
      }));

      return sendJson(res, 200, {
        path: target,
        parent: path.dirname(target) === target ? '' : path.dirname(target),
        items,
        quick: existing.filter(Boolean),
        // 当前目录自身可否导入 / 是否有一批可直接导入的子 Skill
        importable: items.some((i) => i.type === 'file' && i.isSkill) || mdCandidates === 1,
        batch: { count: batchSkills.length, paths: batchSkills },
        suggestion: batchSkills.length || items.some((i) => i.type === 'file' && i.isSkill) ? 'dir' : (mdCandidates === 1 ? 'file' : 'none'),
      });
    }

    if (p === '/api/skills/update' && m === 'POST') {
      const body = await readBody(req);
      const skill = await skills.updateInstructions(body.id, body);
      return sendJson(res, 200, { skill: summarize(skill), skills: skills.list() });
    }

    if (p === '/api/skills/preview' && m === 'POST') {
      const body = await readBody(req);
      const skill = skills.get(body.id);
      if (!skill) return sendJson(res, 404, { error: 'skill 不存在' });
      return sendJson(res, 200, { prompt: buildSkillPrompt(skill, { mode: body.mode || 'instructions', extra: body.systemExtra || '' }) });
    }

    /* ------------------------------- 测试 ------------------------------- */
    if (p === '/api/test' && m === 'POST') {
      const body = await readBody(req);
      const provider = resolveProvider(body);
      const problems = validateProvider(provider);
      if (problems.length) return sendJson(res, 400, { error: problems.join('；') });
      const skill = body.skillId ? skills.get(body.skillId) : null;
      if (body.skillId && !skill) return sendJson(res, 404, { error: `skill 不存在：${body.skillId}` });
      const attachments = normalizeAttachments(body.attachments);

      if (provider.protocol === 'image') {
        const r = await runImageTest({ provider, skill, input: mergeAttachmentText(body.input || '', attachments), overrides: body.overrides || {} });
        return sendJson(res, 200, { mode: 'image', ...r });
      }

      const ac = new AbortController();
      activeRequests.add(ac);
      req.on('close', () => ac.abort(new Error('客户端断开')));
      try {
        const model = body.overrides?.model || provider.defaultModel || provider.models?.[0];
        const { messages, system, contentBlocks } = buildRequestMessages({
          provider,
          skill,
          input: body.input || '',
          mode: body.mode || 'instructions',
          overrides: body.overrides || {},
          attachments,
        });
        const started = Date.now();
        const result = await completeChat(provider, {
          messages,
          contentBlocks,
          system,
          model,
          temperature: body.overrides?.temperature,
          maxTokens: body.overrides?.maxTokens,
          signal: ac.signal,
        });
        return sendJson(res, 200, {
          mode: 'text',
          model,
          elapsedMs: Date.now() - started,
          ...result,
          images: extractImages(result.text),
        });
      } finally {
        activeRequests.delete(ac);
      }
    }

    if (p === '/api/test/stream' && m === 'POST') {
      const body = await readBody(req);
      const provider = resolveProvider(body);
      const problems = validateProvider(provider);
      if (problems.length) return sendJson(res, 400, { error: problems.join('；') });
      const skill = body.skillId ? skills.get(body.skillId) : null;
      if (body.skillId && !skill) return sendJson(res, 404, { error: `skill 不存在：${body.skillId}` });

      // 附件先校验：超限等错误要在开流之前以 400 返回，而不是流里报错
      let attachments;
      try {
        attachments = normalizeAttachments(body.attachments);
      } catch (err) {
        return sendJson(res, 400, { error: err.message || String(err) });
      }

      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const write = (obj) => {
        if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
      };
      const ac = new AbortController();
      activeRequests.add(ac);
      req.on('close', () => ac.abort(new Error('客户端断开')));

      try {
        if (provider.protocol === 'image') {
          write({ type: 'meta', meta: { model: body.overrides?.model || provider.defaultModel, providerName: provider.name, skill: skill ? { id: skill.id, name: skill.name } : null, mode: 'image' } });
          const r = await runImageTest({ provider, skill, input: mergeAttachmentText(body.input || '', attachments), overrides: body.overrides || {}, signal: ac.signal });
          write({ type: 'result', result: { text: `已生成 ${r.images.length} 张图片`, images: r.images, elapsedMs: r.elapsedMs, model: r.model, usage: {}, toolCalls: [] } });
        } else {
          for await (const evt of runTest({
            provider,
            skill,
            input: body.input || '',
            mode: body.mode || 'instructions',
            overrides: body.overrides || {},
            attachments,
            toolHints: body.toolHints || null,
            signal: ac.signal,
          })) write(evt);
        }
      } catch (err) {
        write({ type: 'error', error: err.message || String(err) });
      } finally {
        activeRequests.delete(ac);
        if (!res.writableEnded) res.end();
      }
      return undefined;
    }

    /* --------------------------- 本地文件代理 --------------------------- */
    if (p === '/api/file' && m === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return sendJson(res, 400, { error: '缺少 path 参数' });
      const resolved = path.resolve(filePath);
      const allowed = skills.list().some((s) => {
        if (!s.dir) return resolved === path.resolve(s.source || '');
        const rel = path.relative(path.resolve(s.dir), resolved);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      });
      if (!allowed) return sendJson(res, 403, { error: '只允许读取已导入 skill 目录内的文件' });
      const buf = await fs.readFile(resolved);
      res.writeHead(200, { 'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(buf);
    }

    return sendJson(res, 404, { error: `未知接口：${m} ${p}` });
  }

  async function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.resolve(PUBLIC_DIR, `.${rel}`);
    if (!target.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const data = await fs.readFile(target);
      res.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    }
  }

  return { server, config, skills, activeRequests };
}

function summarize(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    license: skill.license,
    allowedTools: skill.allowedTools,
    metadata: skill.metadata,
    sourceType: skill.sourceType,
    source: skill.source,
    dir: skill.dir,
    files: skill.files,
    importedAt: skill.importedAt,
    instructionsLength: (skill.instructions || '').length,
  };
}

/** 列出 Skill 目录下可作为附件的文件（本地目录才有意义；远程导入的只有清单名字）。 */
async function listSkillFiles(skill) {
  const root = skill.dir ? path.resolve(skill.dir) : '';
  const declared = Array.isArray(skill.files) ? skill.files : [];
  const out = [];
  for (const entry of declared.slice(0, 300)) {
    const rel = entry.path;
    const abs = root ? path.resolve(root, rel) : '';
    let exists = false;
    let size = entry.size || 0;
    if (abs) {
      try {
        const st = await fs.stat(abs);
        exists = st.isFile();
        size = st.size;
      } catch { exists = false; }
    }
    const ext = path.extname(rel).toLowerCase();
    out.push({
      path: rel,
      abs,
      size,
      exists,
      kind: IMAGE_EXT.has(ext) ? 'image' : (TEXT_EXT.has(ext) ? 'text' : 'binary'),
    });
  }
  return out;
}

/** 图片生成没有消息概念，把附件说明并入提示词。 */
function mergeAttachmentText(input, attachments) {
  const section = buildAttachmentSectionForImage(attachments);
  return section ? `${input}\n\n${section}` : input;
}

function buildAttachmentSectionForImage(attachments) {
  if (!attachments?.length) return '';
  return ['=== ATTACHED FILES (仅文件名，图片生成接口不支持文件上传) ===',
    ...attachments.map((a, i) => `${i + 1}. ${a.name}（${a.mime}，${formatBytes(a.size)}）`)].join('\n');
}

export { readAsAttachment, listSkillFiles };

export { PUBLIC_DIR };
