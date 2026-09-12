/** 通用 HTTP 小工具：JSON 请求、超时、SSE 逐行解析。 */

export class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} from ${url}: ${typeof body === 'string' ? body.slice(0, 800) : JSON.stringify(body).slice(0, 800)}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, url);
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）：${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取一个 SSE / 流式响应，按行回调。
 * @param {Response} res
 * @param {(data: string, event: string) => void} onLine
 */
export async function readSse(res, onLine) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, text, res.url);
  }
  if (!res.body) throw new Error('该响应没有可读流（stream body missing）');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.trim()) { event = 'message'; continue; }
      if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '');
        onLine(data, event);
      }
    }
  }
  if (buf.trim().startsWith('data:')) onLine(buf.trim().slice(5).trim(), event);
}

export function joinUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path;
}

/** 从模型输出里抽取所有可用图片（markdown / HTML / 裸链接）。与 public/markdown.js 保持一致。 */
export function extractImages(text) {
  const out = [];
  const seen = new Set();
  const push = (url, alt = '', source = 'markdown') => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, alt, source });
  };
  const src = String(text ?? '');
  let m;
  const md = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
  while ((m = md.exec(src))) push(m[2], m[1], 'markdown');
  const tag = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((m = tag.exec(src))) push(m[1], '', 'html');
  const bare = /https?:\/\/[^\s"'<>)]+\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?[^\s"'<>)]*)?/gi;
  while ((m = bare.exec(src))) push(m[0], '', 'url');
  return out;
}
