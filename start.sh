#!/usr/bin/env bash
# Skill Lab一键启动（macOS / Linux）
# 需要 Node.js 18.17+（内置 fetch）。没有的话会提示安装方式。

set -e
cd "$(dirname "$0")"

PORT="${PORT:-5177}"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没有找到 Node.js。请先安装 18.17 或更高版本："
  echo "    macOS   brew install node"
  echo "    其他     https://nodejs.org/"
  echo ""
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$MAJOR" -lt 18 ] || { [ "$MAJOR" -eq 18 ] && [ "$MINOR" -lt 17 ]; }; then
  echo "  Node.js 版本过低（$(node -v)），需要 18.17 或更高。"
  exit 1
fi

echo ""
echo "  Skill Lab"
echo "  ────────────────────────────────────────────"
echo "  界面地址   http://127.0.0.1:${PORT}"
echo "  关闭窗口即停止服务"
echo "  ────────────────────────────────────────────"
echo ""

exec node bin/skill-lab.mjs --port "$PORT" --open
