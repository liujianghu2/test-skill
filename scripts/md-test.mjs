/**
 * Markdown 渲染器单元测试：node scripts/md-test.mjs
 */

import { renderMarkdown, renderInline, extractImages } from '../public/markdown.js';

let failed = 0;
const results = [];
const check = (name, cond, detail = '') => {
  results.push(`${cond ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

// 表格
const table = renderMarkdown('| 指标 | 本周 |\n| --- | --- |\n| 新增 | 1,284 |');
check('表格渲染', table.includes('<table>') && table.includes('<th>指标</th>') && table.includes('<td>1,284</td>'), table.slice(0, 60));

// 代码块
const code = renderMarkdown('```json\n{ "a": 1 }\n```');
check('代码块渲染', code.includes('code-block') && code.includes('data-copy') && code.includes('{ &quot;a&quot;: 1 }'), code.slice(0, 80));

// 标题与列表
const md = renderMarkdown('## 标题\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 引用\n\n---\n\n**粗** *斜* ~~删~~ `码`');
check('标题', md.includes('<h2>标题</h2>'));
check('无序列表', md.includes('<ul>') && md.includes('<li>一</li>'));
check('有序列表', md.includes('<ol>') && md.includes('<li>甲</li>'));
check('引用', md.includes('<blockquote>引用</blockquote>'));
check('分隔线', md.includes('<hr />'));
check('行内样式', md.includes('<strong>粗</strong>') && md.includes('<em>斜</em>') && md.includes('<del>删</del>') && md.includes('<code class="inline">码</code>'));

// 图片：URL 中含 & 必须仍能匹配
const img = renderInline('![趋势](https://host/chart?a=1&b=2 "标题")');
check('图片（URL 含 &）', img.includes('<img src="https://host/chart?a=1&amp;b=2"') && img.includes('alt="趋势"'), img);

// 链接
const link = renderInline('见 [文档](https://x.com/a?b=1&c=2)');
check('链接（URL 含 &）', link.includes('<a href="https://x.com/a?b=1&amp;c=2"') && link.includes('>文档</a>'), link);

// data URL 图片
const dataImg = renderInline('![x](data:image/png;base64,iVBORw0KGgo=)');
check('data URL 图片', dataImg.includes('<img src="data:image/png;base64,iVBORw0KGgo="'), dataImg);

// 转义：内容中的 HTML 不应生效
const unsafe = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
check('HTML 被转义', unsafe.includes('&lt;script&gt;') && !unsafe.includes('<script>'), unsafe.slice(0, 80));
check('事件属性被转义', !unsafe.includes('onerror=alert(1)>'), unsafe.slice(0, 120));

// 段落内换行
const para = renderMarkdown('第一行\n第二行');
check('段落内软换行', para.includes('第一行<br />第二行'), para);

// 图片抽取
const images = extractImages('![a](https://x.com/1.png)\n<img src="https://x.com/2.jpg">\nhttps://x.com/3.webp "标题"');
check('抽取 markdown/HTML/裸链接图片', images.length === 3 && images[0].source === 'markdown' && images[1].source === 'html' && images[2].source === 'url', JSON.stringify(images.map((i) => i.source)));

const cc = renderMarkdown('```\nline1\nline2\n```');
check('多行代码保留换行', cc.includes('line1\nline2'), JSON.stringify(cc.slice(0, 90)));

console.log('\nMarkdown 渲染器测试\n────────────────────────────');
console.log(results.join('\n'));
console.log(`────────────────────────────\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）\n`);
process.exit(failed ? 1 : 0);
