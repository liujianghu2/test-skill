#!/usr/bin/env node
/** Skill Lab 启动入口。 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = { port: 5177, host: '127.0.0.1', open: false, dataDir: path.join(ROOT, 'data') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--host') opts.host = argv[++i];
    else if (a.startsWith('--host=')) opts.host = a.slice(7);
    else if (a === '--data' || a === '--data-dir') opts.dataDir = path.resolve(argv[++i]);
    else if (a.startsWith('--data=')) opts.dataDir = path.resolve(a.slice(7));
    else if (a === '--open' || a === '-o') opts.open = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`Skill Lab — 本地 Skill 测试工具

用法：
  node bin/skill-lab.mjs [选项]

选项：
  -p, --port <n>      监听端口（默认 5177）
      --host <addr>   监听地址（默认 127.0.0.1，仅本机可访问）
      --data <dir>    数据目录（默认 ./data，存放 config.json 与导入的 skill）
  -o, --open          启动后自动打开浏览器
  -h, --help          显示帮助
`);
  process.exit(0);
}

if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
  console.error(`端口不合法：${opts.port}`);
  process.exit(1);
}

await fs.mkdir(opts.dataDir, { recursive: true });
const { server, config } = await createApp({ dataDir: opts.dataDir });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${opts.port} 已被占用。换一个端口：node bin/skill-lab.mjs --port ${opts.port + 1}\n`);
  } else {
    console.error('服务启动失败：', err);
  }
  process.exit(1);
});

server.listen(opts.port, opts.host, () => {
  const url = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${opts.port}`;
  const providers = config.data.providers.length;
  console.log(`
  Skill Lab 已启动
  ────────────────────────────────────────────
  界面地址   ${url}
  数据目录   ${opts.dataDir}
  模型服务   ${providers ? `${providers} 个已配置` : '尚未配置（在界面左侧添加）'}
  ────────────────────────────────────────────
  按 Ctrl+C 退出
`);
  if (opts.open) openBrowser(url);
});

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch { /* 打不开就算了 */ }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
