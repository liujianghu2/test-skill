/**
 * 轻量 Markdown 渲染器（无依赖）。
 * 浏览器端通过 <script> 使用，Node 端用于生成静态预览。
 *
 * 支持：标题、代码块（含语言标签与复制按钮）、表格、有序/无序列表、引用、
 *      分隔线、段落、行内代码、加粗/斜体/删除线、链接、图片。
 */

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 行内渲染。链接与图片在转义之前先抽成占位符，
 * 否则 URL 里的 & < > 会被转义，导致链接/图片匹配失败。
 */
export function renderInline(text) {
  const tokens = [];
  const hold = (html) => {
    tokens.push(html);
    return `\u0000T${tokens.length - 1}\u0000`;
  };

  let out = String(text);
  // 行内代码
  out = out.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code class="inline">${escapeHtml(code)}</code>`));
  // 图片：![alt](url "title")
  out = out.replace(/!\[([^\]]*)\]\((https?:[^)\s]+|data:image\/[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g,
    (_, alt, src) => hold(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" />`));
  // 链接
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_, label, href) => hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`));

  out = escapeHtml(out);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000T(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
}

const inline = renderInline;

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let list = null;
  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const marker = fence[2][0].repeat(3);
      const lang = fence[3] || '';
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i])) buf.push(lines[i++]);
      i++;
      const code = buf.join('\n');
      html.push(
        `<div class="code-block">${lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : ''}` +
        `<button class="code-copy" data-copy="${encodeURIComponent(code)}">复制</button>` +
        `<pre><code>${escapeHtml(code)}</code></pre></div>`,
      );
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      closeList();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      html.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, idx) => `<td>${inline(r[idx] ?? '')}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeList(); html.push('<hr />'); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); html.push(`<${want}>`); list = want; }
      html.push(`<li>${inline((ul || ol)[1])}</li>`);
      i++;
      continue;
    }

    if (!line.trim()) { closeList(); i++; continue; }

    closeList();
    const buf = [];
    while (i < lines.length && lines[i].trim()
      && !/^(\s*)(```+|~~~+)/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
      && !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i]) && !/^\s*>/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    html.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }
  closeList();
  return html.join('\n');
}

/** 从模型输出里抽取图片（与后端 extractImages 保持一致的行为）。 */
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

if (typeof window !== 'undefined') {
  window.SkillLabMarkdown = { renderMarkdown, renderInline, extractImages, escapeHtml };
}
