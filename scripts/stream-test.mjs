/**
 * 流式渲染器测试：用极简 DOM 打桩，验证
 *   1) 分块喂入的最终结构与一次性渲染一致（标签序列相同）
 *   2) 尾部不完整的行只出现在 live 预览里，不会变成错误的结构
 *   3) 表格按行增量追加（不会整表重建）
 *   4) 代码块就地增长
 *
 * 用法：node scripts/stream-test.mjs
 */

import { renderMarkdown, renderInline } from '../public/markdown.js';
import { StreamRenderer } from '../public/stream-render.js';

/* ------------------------------ 极简 DOM ------------------------------ */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input']);

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this._text = '';
    this._html = null;
    this.parent = null;
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  get classList() {
    const self = this;
    const list = () => String(self.attrs.class || '').split(/\s+/).filter(Boolean);
    return {
      add(...names) { self.attrs.class = [...new Set([...list(), ...names])].join(' '); },
      remove(...names) { self.attrs.class = list().filter((c) => !names.includes(c)).join(' '); },
      contains(name) { return list().includes(name); },
    };
  }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) { this.children = []; this._html = null; this._text = String(v); }
  set innerHTML(html) {
    this.children = [];
    this._text = '';
    this._html = String(html);
    parseInto(this, String(html));
  }
  get innerHTML() { return this.serialize(); }
  /** 序列化当前子树（模拟浏览器：innerHTML 反映真实 DOM，支持 += 追加） */
  serialize() {
    return this.children.map((c) => {
      if (!c.tagName) return c.textContent;
      if (VOID_TAGS.has(c.tagName.toLowerCase())) return `<${c.tagName.toLowerCase()} />`;
      return `<${c.tagName.toLowerCase()}${c.attrs.class ? ` class="${c.attrs.class}"` : ''}>${c.serialize ? c.serialize() : c.textContent}</${c.tagName.toLowerCase()}>`;
    }).join('');
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n) { n.parent = this; this.children.push(n); }
    }
  }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    // 支持「祖先 后代」形式的选择器
    const parts = String(sel).trim().split(/\s+/);
    const lastPart = parts[parts.length - 1];
    const ancestors = parts.slice(0, -1);
    const matchesAncestors = (el) => {
      let node = el.parent;
      for (let i = ancestors.length - 1; i >= 0; i--) {
        while (node && !matches(node, ancestors[i])) node = node.parent;
        if (!node) return false;
        node = node.parent;
      }
      return true;
    };
    const walk = (node) => {
      for (const c of node.children) {
        if (c.tagName && matches(c, lastPart) && matchesAncestors(c)) out.push(c);
        if (c.children.length) walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function matches(el, sel) {
  return String(sel).split(',').map((s) => s.trim()).filter(Boolean).some((s) => {
    // 支持 tag、.class、tag.class 三种简单形式
    const m = /^([a-zA-Z][\w-]*)?(?:\.([\w-]+))?$/.exec(s);
    if (!m) return false;
    const [, tag, cls] = m;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    if (cls && !el.className.split(/\s+/).includes(cls)) return false;
    return Boolean(tag || cls);
  });
}

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>/g;

function parseInto(root, html) {
  const stack = [root];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html))) {
    const text = html.slice(last, m.index);
    if (text.trim()) {
      const parent = stack[stack.length - 1];
      const textNode = { textContent: text, children: [], className: '', tagName: null, attrs: {}, parent, remove() {}, querySelectorAll: () => [], querySelector: () => null, innerHTML: '' };
      parent.children.push(textNode);
    }
    last = TAG_RE.lastIndex;
    const [full, closing, tag, attrStr, selfClose] = m;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new El(tag);
    for (const a of attrStr.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.attrs[a[1]] = a[2] ?? '';
    const parent = stack[stack.length - 1];
    el.parent = parent;
    parent.children.push(el);
    if (!selfClose && !VOID_TAGS.has(tag.toLowerCase())) stack.push(el);
  }
  const tail = html.slice(last);
  if (tail.trim()) {
    const parent = stack[stack.length - 1];
    parent.children.push({ textContent: tail, children: [], className: '', tagName: null, attrs: {}, parent, remove() {}, querySelectorAll: () => [], querySelector: () => null, innerHTML: '' });
  }
}

function makeRoot() {
  const root = new El('div');
  root.className = 'answer';
  return root;
}

// stream-render.js 依赖浏览器的 document.createElement，这里注入最小实现
globalThis.document = { createElement: (tag) => new El(tag) };

/** 结构指纹：只看标签与文本，忽略 live / partial / code-pending / code-copy 这些流式辅助节点。 */
function fingerprint(node) {
  const out = [];
  const walk = (n) => {
    // 元素用 textContent 赋值时（如代码块）没有子节点，直接取文本
    if (n.tagName && n.tagName !== '#text' && !n.children.length && n.textContent) {
      out.push(`#${n.textContent.replace(/\s+/g, ' ').trim()}`);
      return;
    }
    for (const c of n.children) {
      const tag = c.tagName;
      if (!tag) {
        if (c.textContent.trim()) out.push(`#${c.textContent.trim().replace(/\s+/g, ' ')}`);
        continue;
      }
      if (c.className.includes('live')) continue;
      if (c.className.includes('code-pending')) continue;
      if (c.className.includes('partial')) continue;
      if (c.className.includes('code-copy')) continue;
      out.push(`<${tag.toLowerCase()} class="${c.className.replace(/\bdone\b/g, '').trim()}">`);
      walk(c);
      out.push(`</${tag.toLowerCase()}>`);
    }
  };
  walk(node);
  return out.join('');
}

/* ------------------------------- 测试 ------------------------------- */

let failed = 0;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const SAMPLES = {
  '基础段落与标题': '# 标题\n\n第一段的第一行\n第二行\n\n## 小标题\n\n结尾。',
  '表格': '说明如下：\n\n| 指标 | 本周 | 环比 |\n| --- | --- | --- |\n| 新增 | 1,284 | +12.4% |\n| 活跃 | 43.7% | -1.2pp |\n\n表格结束后的段落。',
  '列表与引用': '要点：\n\n- 第一项\n- 第二项\n\n> 一句引用\n\n1. 甲\n2. 乙\n\n收尾。',
  '代码块': '代码如下：\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\n结束。',
  '图片与行内': '见图：\n\n![示意图](https://x.com/a.png?w=1&h=2 "标题")\n\n**粗体** 与 `代码` 与 [链接](https://x.com/b?c=1&d=2)。',
  '无空行紧凑结构': '## 直接开始\n- a\n- b\n| x | y |\n| --- | --- |\n| 1 | 2 |',
};

for (const [name, text] of Object.entries(SAMPLES)) {
  // 一次性渲染作为基准；去掉流式路径特有的 code-copy 按钮后对比
  const batchRoot = makeRoot();
  batchRoot.innerHTML = renderMarkdown(text);
  const expected = fingerprint(batchRoot);

  // 分块流式渲染：2~7 字符一刀，模拟真实 SSE 分片
  for (const chunkSize of [2, 3, 5, 7]) {
    const root = makeRoot();
    const sr = new StreamRenderer(root);
    for (let i = 0; i < text.length; i += chunkSize) sr.append(text.slice(i, i + chunkSize));
    sr.finish();
    const actual = fingerprint(root);
    check(`${name}（${chunkSize} 字符/块）`, actual === expected, actual === expected ? '' : `\n      期望 ${expected.slice(0, 150)}\n      实际 ${actual.slice(0, 150)}`);
  }

  // 逐字符喂入（最极端情况）
  const root = makeRoot();
  const sr = new StreamRenderer(root);
  for (const ch of text) sr.append(ch);
  sr.finish();
  check(`${name}（逐字符）`, fingerprint(root) === expected, fingerprint(root) === expected ? '' : `\n      期望 ${expected.slice(0, 150)}\n      实际 ${fingerprint(root).slice(0, 150)}`);
}

// 表格增量：body 行不应该重建表头
{
  const root = makeRoot();
  const sr = new StreamRenderer(root);
  sr.append('| a | b |\n| --- | --- |\n');
  const table = root.querySelector('table');
  sr.append('| 1 | 2 |\n');
  sr.append('| 3 | 4 |\n');
  sr.finish();
  check('表格节点复用（未整表重建）', root.querySelector('table') === table, root.querySelector('table') === table ? '' : '表节点被替换');
  check('表格 body 行数正确', root.querySelectorAll('tbody tr').length === 2, String(root.querySelectorAll('tbody tr').length));
  check('表头单元格正确', root.querySelectorAll('thead th').length === 2, String(root.querySelectorAll('thead th').length));
}

// 代码块就地增长
{
  const root = makeRoot();
  const sr = new StreamRenderer(root);
  sr.append('```py\n');
  const codeEl = root.querySelector('code');
  sr.append('print(1)\n');
  sr.append('print(2)\n');
  sr.finish();
  check('代码块节点复用', root.querySelector('code') === codeEl);
  check('代码内容完整', root.querySelector('code').textContent === 'print(1)\nprint(2)\n', JSON.stringify(root.querySelector('code').textContent));
  check('闭合后移除 pending 标记', root.querySelectorAll('.code-pending').length === 0, `${root.querySelectorAll('.code-pending').length} 个残留`);
}

// 不完整行只进入 live 预览，收尾时转正
{
  const root = makeRoot();
  const sr = new StreamRenderer(root);
  sr.append('| a | b |\n| --- | --- |\n| 半');
  check('不完整的表格行先在 liveRow 预览', sr.open?.liveRow != null, `open=${sr.open?.type} buf=${JSON.stringify(sr.buf)} html=${root.innerHTML.slice(0, 120)}`);
  check('预览行标记为 partial', root.querySelectorAll('.partial').length > 0, `partial=${root.querySelectorAll('.partial').length} td=${root.querySelectorAll('td').length} class=${root.querySelector('td')?.className}`);
  sr.finish();
  check('收尾后 partial 标记被清理', root.querySelectorAll('td.partial').length === 0, `${root.querySelectorAll('td.partial').length} 个残留`);
  check('收尾后数据行已落地', root.querySelectorAll('tbody tr').length === 1, `html=${root.innerHTML.slice(0, 160)}`);
  check('收尾后不再有段落残留', root.querySelectorAll('p').length === 0, String(root.querySelectorAll('p').length));
}

// 引用块内的行内格式
{
  const root = makeRoot();
  const sr = new StreamRenderer(root);
  sr.append('> **重要**：见 `x`\n');
  sr.finish();
  check('引用块行内格式', root.querySelector('blockquote')?.innerHTML.includes('<strong>重要</strong>'), root.querySelector('blockquote')?.innerHTML);
}

console.log('\n流式渲染器测试\n────────────────────────────');
console.log(results.join('\n'));
console.log(`────────────────────────────\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）\n`);
process.exit(failed ? 1 : 0);
