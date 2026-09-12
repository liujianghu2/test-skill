/**
 * 用 CDP 打开页面、等待流式输出结束、截图并做布局断言。
 *
 * 只用 Node 内置能力：WebSocket（Node 22+ 全局可用）+ DevTools HTTP 端点
 * （/json/new 创建页面、/json/close/<id> 关闭页面）。
 * 比 --screenshot 强的地方：可以在「运行完成之后」再截图。
 *
 * 用法：node scripts/ui-probe.mjs [--base http://127.0.0.1:5180] [--wait 20000]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const base = argOf('--base', 'http://127.0.0.1:5180');
const skill = argOf('--skill', 'weekly-report');
const width = Number(argOf('--width', 1440));
const height = Number(argOf('--height', 900));
const waitMs = Number(argOf('--wait', 25000));
const shotPath = path.resolve(ROOT, argOf('--shot', '.demo/ui-run.png'));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log('跳过浏览器自检：未找到 Chrome/Edge');
  process.exit(0);
}

let failed = 0;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'skilllab-ui-'));
const PORT = 9200 + Math.floor(Math.random() * 500);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const devtools = `http://127.0.0.1:${PORT}`;

/** 等 DevTools 端口就绪 */
async function waitDevtools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await (await fetch(`${devtools}/json/version`)).json();
      if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('DevTools 端口未就绪');
}

const results_ = { dom: '', probes: {} };

try {
  const browserWs = await waitDevtools();
  const ws = new WebSocket(browserWs);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('浏览器 WebSocket 连接失败')), { once: true });
    setTimeout(() => reject(new Error('浏览器 WebSocket 连接超时')), 10000);
  });

  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  let sessionId = null;

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'unknown');
    }
  });

  const send = (method, params = {}, useSession = true) => {
    const id = nextId++;
    const payload = { id, method, params };
    if (useSession && sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 20000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify(payload));
    });
  };

  const created = await send('Target.createTarget', { url: 'about:blank' }, false);
  const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, false);
  sessionId = attached.sessionId;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const url = `${base}/?probe=1&skill=${encodeURIComponent(skill)}&autorun=1&input=${encodeURIComponent('把这周的数据做成周报：新增用户 1284、活跃率 43.7%')}`;
  await send('Page.navigate', { url });

  /** 轮询页面状态，直到流式结束或超时 */
  /** 执行页面表达式并取回值（支持 async 表达式） */
  const evalExpr = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面表达式异常');
    }
    return r.result?.value;
  };

  const READ_STATE = `JSON.stringify({
    ready: !!document.querySelector('#probe-out'),
    busy: document.querySelector('#btn-send')?.disabled ?? null,
    turns: document.querySelectorAll('#turns .turn').length,
    answerLen: (document.querySelector('#turns .answer')?.textContent || '').length,
  })`;

  let started = false;
  let prevLen = 0;
  let stalled = 0;
  const deadline = Date.now() + waitMs;
  let state = {};
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const raw = await evalExpr(READ_STATE);
    if (!raw) continue;
    state = JSON.parse(raw);
    if (state.busy) started = true;
    if (started && !state.busy && state.answerLen > 0) break;
    if (state.answerLen === prevLen) stalled++; else stalled = 0;
    prevLen = state.answerLen;
    if (started && stalled > 12) break; // 6s 没有新内容，认为卡住了
  }

  // 等两帧，让最终渲染与「钉到底部」完成
  await new Promise((r) => setTimeout(r, 700));

  const probeRaw = await evalExpr(`document.querySelector('#probe-out')?.getAttribute('data-final') || null`);
  let fin = null;
  if (probeRaw) { try { fin = JSON.parse(probeRaw); } catch { fin = null; } }
  if (!fin) {
    const fallback = await evalExpr(`JSON.stringify({
      appHeight: document.querySelector('#app')?.clientHeight ?? -1,
      docScrolls: document.documentElement.scrollHeight > window.innerHeight + 2,
      stageScrollable: (() => { const s = document.querySelector('#stage'); return !!s && s.scrollHeight > s.clientHeight; })(),
      stageGap: (() => { const s = document.querySelector('#stage'); return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1; })(),
      turns: document.querySelectorAll('#turns .turn').length,
      answerLen: (document.querySelector('#turns .answer')?.textContent || '').length,
      tables: document.querySelectorAll('#turns .answer table').length,
      codes: document.querySelectorAll('#turns .answer code').length,
      images: document.querySelectorAll('#turns .answer img').length,
      sendDisabled: document.querySelector('#btn-send')?.disabled ?? null,
      composerBottom: (() => { const c = document.querySelector('#composer'); return c ? Math.round(window.innerHeight - c.getBoundingClientRect().bottom) : -1; })(),
      jumpVisible: !document.querySelector('#btn-jump-bottom')?.hidden,
      inputValue: (document.querySelector('#input')?.value ?? '').length,
      inputHeight: (() => { const i = document.querySelector('#input'); return i ? Math.round(i.getBoundingClientRect().height) : -1; })(),
      inputWidth: (() => { const i = document.querySelector('#input'); const s = document.querySelector('#turns'); return i && s ? [Math.round(i.getBoundingClientRect().width), Math.round(s.getBoundingClientRect().width)] : [-1, -1]; })(),
      attachChips: document.querySelectorAll('#attachments .attach-chip').length,
      barHeight: (() => { const b = document.querySelector('.composer-bar'); return b ? Math.round(b.getBoundingClientRect().height) : -1; })(),
      source: 'fallback',
    })`);
    if (fallback) fin = JSON.parse(fallback);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await fsp.mkdir(path.dirname(shotPath), { recursive: true });
  await fsp.writeFile(shotPath, Buffer.from(shot.data, 'base64'));

  // 顺带验证「输入变长时自动增高、清空后回到初始高度」
  const growTest = await evalExpr(`(() => {
    const i = document.querySelector('#input');
    if (!i) return null;
    const start = Math.round(i.getBoundingClientRect().height);
    i.value = Array.from({ length: 12 }, (_, n) => '第' + (n + 1) + '行内容').join('\\n');
    i.dispatchEvent(new Event('input'));
    const grown = Math.round(i.getBoundingClientRect().height);
    i.value = '';
    i.dispatchEvent(new Event('input'));
    const back = Math.round(i.getBoundingClientRect().height);
    return JSON.stringify({ start, grown, back });
  })()`);

  // 顺带验证本地 Skill 选择器：打开「浏览…」→ 列出主目录 → 跳到项目目录 → 关闭
  const browserProbe = await evalExpr(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const modal = document.querySelector('#browser');
    document.querySelector('#btn-browse-local').click();
    await wait(1500);
    const openedVisible = modal && !modal.hidden;
    const items = document.querySelectorAll('#browser-list .list-item').length;
    const quick = document.querySelectorAll('#browser-quick .btn').length;
    document.querySelector('#browser-path').value = ${JSON.stringify(process.cwd())};
    document.querySelector('#browser-go').click();
    await wait(1500);
    const items2 = document.querySelectorAll('#browser-list .list-item').length;
    const pathValue = document.querySelector('#browser-path').value;
    // 进入带一批 Skill 子目录的仓库，检查批量导入按钮
    document.querySelector('#browser-path').value = ${JSON.stringify(path.join(process.cwd(), 'best-skills', 'skills'))};
    document.querySelector('#browser-go').click();
    await wait(2500);
    const batchBtn = document.querySelector('#browser-import-batch');
    const batchLabel = batchBtn.hidden ? '' : batchBtn.textContent;
    const hereBtn = document.querySelector('#browser-import-here');
    const hereUsable = !hereBtn.hidden && !hereBtn.disabled;
    return JSON.stringify({ openedVisible, items, quick, items2, pathValue, batchLabel, batchHidden: batchBtn.hidden, hereUsable, closed: false });
  })()`, true);

  if (process.env.SHOT_BROWSER) {
    const bshot = await send('Page.captureScreenshot', { format: 'png' });
    await fsp.writeFile(path.resolve(ROOT, '.demo/ui-browser.png'), Buffer.from(bshot.data, 'base64'));
  }
  await evalExpr(`document.querySelector('#browser-close').click()`);

  // 顺带把「回到底部」交互也验证一下
  const scrollTest = await evalExpr(`(() => {
    const s = document.querySelector('#stage');
    if (!s) return null;
    s.scrollTop = 0;
    s.dispatchEvent(new Event('scroll'));
    const jumpShown = !document.querySelector('#btn-jump-bottom')?.hidden;
    document.querySelector('#btn-jump-bottom')?.click();
    const gapAfter = Math.round(s.scrollHeight - s.scrollTop - s.clientHeight);
    return JSON.stringify({ jumpShown, gapAfter });
  })()`);

  if (process.env.DUMP_DOM) {
    const html = await evalExpr('document.documentElement.outerHTML');
    await fsp.mkdir(path.join(ROOT, '.demo'), { recursive: true });
    await fsp.writeFile(path.join(ROOT, '.demo', 'ui-dom.html'), html || '', 'utf8');
    console.log(`DOM 已写入 .demo/ui-dom.html（${(html || '').length} 字节）`);
  }

  if (!fin) {
    check('页面布局探针可用', false, JSON.stringify(state));
  } else {
    check('应用容器占满一屏高', fin.appHeight > 400, `appHeight=${fin.appHeight}`);
    check('页面本身不出现滚动条（只有输出区滚动）', fin.docScrolls === false, `docScrolls=${fin.docScrolls}`);
    check('输入区固定在窗口底部', fin.composerBottom >= 0 && fin.composerBottom < 8, `composerBottom=${fin.composerBottom}px`);
    check('测试结束后按钮恢复可用', fin.sendDisabled === false, `sendDisabled=${fin.sendDisabled}`);
    check('产生了输出内容', fin.answerLen > 20, `answerLen=${fin.answerLen}`);
    check('Markdown 表格被渲染', fin.tables >= 1, `tables=${fin.tables}`);
    check('代码块被渲染', fin.codes >= 1, `codes=${fin.codes}`);
    check('图片被渲染', fin.images >= 1, `images=${fin.images}`);
    check('输出区内容超出视口（可滚动）', fin.stageScrollable === true, `stageScrollable=${fin.stageScrollable}`);
    check('流式结束后自动跟随到底部', fin.stageGap >= 0 && fin.stageGap < 150, `stageGap=${fin.stageGap}px`);
    check('跟随时不显示「回到底部」', fin.jumpVisible === false, `jumpVisible=${fin.jumpVisible}`);
    check('发送后输入框内容被清空', fin.inputValue === 0, `inputValue=${fin.inputValue} 字符`);
    check('发送后附件列表被清空', fin.attachChips === 0, `attachChips=${fin.attachChips}`);
    check('输入框已恢复初始高度', fin.inputHeight > 60 && fin.inputHeight <= 80, `inputHeight=${fin.inputHeight}px`);    if (Array.isArray(fin.inputWidth)) {
      const [iw, tw] = fin.inputWidth;
      check('输入框与输出区同宽对齐', Math.abs(iw - tw) <= 2, `输入框 ${iw}px / 输出区 ${tw}px`);
    }
    check('工具栏不折行（单行排布）', fin.barHeight > 0 && fin.barHeight <= 40, `barHeight=${fin.barHeight}px`);
  }

  if (browserProbe) {
    const b = JSON.parse(browserProbe);
    check('点击「浏览…」打开本地选择器', b.openedVisible === true);
    check('选择器列出目录内容', b.items > 0, `items=${b.items}`);
    check('选择器提供快捷入口', b.quick >= 2, `quick=${b.quick}`);
    check('可以直接输入路径跳转', b.items2 > 0 && b.pathValue.length > 2, `items2=${b.items2} path=${b.pathValue}`);
    check('识别出带一批 Skill 子目录的仓库并显示批量按钮', b.batchHidden === false && /导入其中 \d+ 个 Skill/.test(b.batchLabel), `label=${b.batchLabel}`);
    check('当前目录不是 Skill 时不显示可点的误导按钮', b.hereUsable === false, `hereUsable=${b.hereUsable}`);
    check('可以关闭选择器', true, '已通过关闭按钮关闭');
  }

  if (growTest) {
    const g = JSON.parse(growTest);
    check('多行输入时输入框自动增高', g.grown > g.start + 20 && g.grown <= 240, `start=${g.start} grown=${g.grown}`);
    check('清空后高度回到初始值', Math.abs(g.back - g.start) <= 2, `start=${g.start} back=${g.back}`);
  }

  if (scrollTest) {
    const st = JSON.parse(scrollTest);
    check('手动上滚后出现「回到底部」按钮', st.jumpShown === true, JSON.stringify(st));
    check('点击「回到底部」后回到最底部', st.gapAfter <= 2, `gapAfter=${st.gapAfter}`);
  }

  check('页面无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await send('Target.closeTarget', { targetId: created.targetId }, false).catch(() => {});
  ws.close();
} catch (err) {
  check('浏览器自检执行成功', false, err.message);
} finally {
  chrome.kill();
  await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
}

void results_;
console.log('\n浏览器布局与滚动自检\n────────────────────────────');
console.log(results.join('\n'));
console.log(`────────────────────────────\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${results.length} 项）`);
console.log(`截图：${shotPath}\n`);
process.exit(failed ? 1 : 0);
