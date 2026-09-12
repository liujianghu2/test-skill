/**
 * 流式 Markdown 渲染器。
 *
 * 设计要点：
 * - 稳定行（后面还有换行的行）立即转成真实 DOM；最后一段可能被截断，留在 buf 里做预览
 * - 状态只有 5 个字段：buf / open / para / pendingTableHeader / live
 * - 表格：表头行需要看下一行才能确定，因此先渲染成段落占位，下一行是分隔行时就地升级成表格
 * - 代码块就地增长；列表按项追加；都不整块重建
 *
 * 与 markdown.js 的 renderMarkdown 保持结构一致（由 scripts/stream-test.mjs 对拍验证）。
 */

import { renderInline, escapeHtml } from './markdown.js';

const FENCE = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])\s*(\1\s*){2,}$/;
const QUOTE = /^\s*>\s?/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
// 分隔行：每个单元格只由 - : 空格组成，且至少有一个 -
const TABLE_SEP = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

export class StreamRenderer {
  constructor(root) {
    this.root = root;
    this.buf = '';
    this.open = null; // { type:'code' } | { type:'table', tbody, cols } | { type:'list', el, kind }
    this.para = null; // 当前段落元素（连续行合并）
    this.pendingTableHeader = null; // 上一行看起来是表格头，等下一行确认
    this.live = null; // 待定行的预览元素
  }

  append(text) {
    this.buf += text;
    this.drainComplete();
    this.renderLive();
  }

  finish() {
    this.drainAll();
    this.clearLive();
    if (this.open?.type === 'code') this.finishCode();
    this.open = null;
    this.pendingTableHeader = null;
  }

  /** 把「已经确定完结」的行交给状态机；最后一段留在 buf 里。 */
  drainComplete() {
    const parts = this.buf.split('\n');
    if (parts.length === 1) return; // 还没有换行，整段都待定
    const complete = parts.slice(0, -1);
    this.buf = parts[parts.length - 1];
    for (let i = 0; i < complete.length; i++) {
      const next = i + 1 < complete.length ? complete[i + 1] : (this.buf !== '' ? this.buf : null);
      this.consume(complete[i], next);
    }
  }

  /** 收尾：把 buf 里剩下的行（可能只有一行）按完结处理。 */
  drainAll() {
    if (!this.buf) return;
    const parts = this.buf.split('\n');
    this.buf = '';
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast && line === '') break;
      this.consume(line, isLast ? null : parts[i + 1]);
    }
  }

  clearLive() {
    if (this.live) {
      this.live.remove();
      this.live = null;
    }
  }

  /** 待定行的预览：只读 buf，绝不修改它。 */
  renderLive() {
    const text = this.buf;
    if (!text) {
      this.clearLive();
      return;
    }
    if (this.open?.type === 'code') {
      // 代码块内的半行等行结束再落地，避免重复追加
      this.clearLive();
      return;
    }
    if (this.open?.type === 'table') {
      this.clearLive();
      this.replaceLiveRow(text);
      return;
    }
    if (!this.live) {
      this.live = document.createElement('div');
      this.live.className = 'live';
      this.root.append(this.live);
    }
    this.live.innerHTML = `<p>${renderInline(text)}</p>`;
  }

  replaceLiveRow(text) {
    if (this.open.liveRow) {
      this.open.liveRow.remove();
      this.open.liveRow = null;
    }
    const cells = TABLE_ROW.test(text) ? splitRow(text) : [text];
    const tr = document.createElement('tr');
    for (let i = 0; i < (this.open.cols || cells.length); i++) {
      const td = document.createElement('td');
      td.className = 'partial';
      td.innerHTML = renderInline(cells[i] ?? '');
      tr.append(td);
    }
    this.open.liveRow = tr;
    this.open.tbody.append(tr);
  }

  closeGroup() {
    if (this.open?.liveRow) {
      this.open.liveRow.remove();
      this.open.liveRow = null;
    }
    this.open = null;
    this.para = null;
  }

  block(html, { keepPara = false } = {}) {
    this.clearLive();
    const host = document.createElement('div');
    host.innerHTML = html;
    const node = host.firstElementChild;
    this.root.append(node);
    this.para = keepPara ? node : null;
    return node;
  }

  /**
   * 行状态机。
   * 表格判定必须排在代码围栏之前：分隔行（|---|）本身也能被围栏正则误判。
   */
  consume(line, nextLine) {
    const row = TABLE_ROW.test(line);
    const sep = TABLE_SEP.test(line);
    const nextIsSep = nextLine != null && TABLE_SEP.test(nextLine);
    const pendingHeader = this.pendingTableHeader;
    this.pendingTableHeader = null;

    /* ---- 1. 代码块内部 ---- */
    if (this.open?.type === 'code') {
      if (FENCE.test(line)) {
        this.finishCode();
        return;
      }
      this.open.codeEl.textContent += `${line}\n`;
      return;
    }

    /* ---- 2. 表格内部 ---- */
    if (this.open?.type === 'table') {
      if (this.open.liveRow) {
        this.open.liveRow.remove();
        this.open.liveRow = null;
      }
      if (this.open.expectSep && sep) {
        this.open.expectSep = false;
        return;
      }
      this.open.expectSep = false;
      if (row || line.includes('|')) {
        this.appendTableRow(splitRow(line), this.open.cols);
        return;
      }
      this.closeGroup();
    }

    /* ---- 3. 空行 ---- */
    if (!line.trim()) {
      this.closeGroup();
      this.clearLive();
      return;
    }

    /* ---- 4. 表格：表头 + 下一行是分隔行 ---- */
    if (row && nextIsSep) {
      if (this.para?.tagName === 'P') this.para.remove();
      this.para = null;
      this.open = null;
      this.startTable(splitRow(line));
      return;
    }

    /* ---- 5. 表格：上一行是表头，这一行是分隔行（且还没建表） ---- */
    if (row && sep && pendingHeader && !this.open) {
      if (this.para?.tagName === 'P') this.para.remove();
      this.para = null;
      this.open = null;
      this.startTable(splitRow(pendingHeader));
      return;
    }

    /* ---- 6. 表格：刚建好表，当前行是数据行 ---- */
    if (row && this.open?.type === 'table' && this.open.expectSep === false) {
      this.appendTableRow(splitRow(line), this.open.cols);
      return;
    }

    /* ---- 7. 代码围栏 ---- */
    if (FENCE.test(line)) {
      this.closeGroup();
      this.startCode(FENCE.exec(line)[3] || '');
      return;
    }

    /* ---- 8. 标题 ---- */
    const heading = HEADING.exec(line);
    if (heading) {
      this.closeGroup();
      this.block(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      return;
    }

    /* ---- 9. 分隔线 ---- */
    if (HR.test(line)) {
      this.closeGroup();
      this.block('<hr />');
      return;
    }

    /* ---- 10. 引用 ---- */
    if (QUOTE.test(line)) {
      this.closeGroup();
      this.block(`<blockquote>${renderInline(line.replace(QUOTE, ''))}</blockquote>`);
      return;
    }

    /* ---- 11. 列表 ---- */
    const ul = UL.exec(line);
    const ol = OL.exec(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (!this.open || this.open.type !== 'list' || this.open.kind !== kind) {
        this.closeGroup();
        const el = this.block(`<${kind}></${kind}>`);
        this.open = { type: 'list', el, kind };
      }
      const li = document.createElement('li');
      li.innerHTML = renderInline((ul || ol)[1]);
      this.open.el.append(li);
      return;
    }

    /* ---- 12. 段落 ---- */
    if (this.open?.type === 'list') this.closeGroup();
    if (this.para) {
      this.para.innerHTML += `<br />${renderInline(line)}`;
      this.clearLive();
    } else {
      this.para = this.block(`<p>${renderInline(line)}</p>`, { keepPara: true });
    }
    // 可能是一张表的表头：记下来，等下一行确认
    if (row) this.pendingTableHeader = line;
  }

  startTable(cells) {
    this.clearLive();
    this.para = null;
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const cell of cells) {
      const th = document.createElement('th');
      th.innerHTML = renderInline(cell);
      tr.append(th);
    }
    thead.append(tr);
    const tbody = document.createElement('tbody');
    table.append(thead, tbody);
    this.root.append(table);
    this.open = { type: 'table', table, tbody, cols: cells.length, liveRow: null, expectSep: true };
    return this.open;
  }

  appendTableRow(cells, cols) {
    const count = cols || this.open?.cols || cells.length;
    const tr = document.createElement('tr');
    for (let i = 0; i < count; i++) {
      const td = document.createElement('td');
      td.innerHTML = renderInline(cells[i] ?? '');
      tr.append(td);
    }
    this.open.tbody.append(tr);
  }

  startCode(lang) {
    this.clearLive();
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    wrap.innerHTML = `${lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : ''}<pre><code></code></pre>`;
    const marker = document.createElement('div');
    marker.className = 'code-pending';
    this.root.append(wrap, marker);
    this.open = { type: 'code', el: wrap, marker, codeEl: wrap.querySelector('code') };
    return this.open;
  }

  finishCode() {
    if (this.open?.type !== 'code') return;
    this.open.marker.remove();
    this.open.el.classList.add('done');
    this.open = null;
  }
}
