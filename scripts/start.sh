#!/usr/bin/env bash
# 启动 chat2api-slim（后台常驻，pid 写入 .server.pid）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .server.pid ] && kill -0 "$(cat .server.pid)" 2>/dev/null; then
  echo "已在运行，pid=$(cat .server.pid)"
  exit 0
fi

mkdir -p logs
if [ -x ./node_modules/.bin/tsx ]; then
  nohup ./node_modules/.bin/tsx src/main/index.ts >> logs/server.log 2>&1 &
else
  nohup npx --yes tsx src/main/index.ts >> logs/server.log 2>&1 &
fi
echo $! > .server.pid
sleep 2
if kill -0 "$(cat .server.pid)" 2>/dev/null; then
  echo "已启动，pid=$(cat .server.pid)，日志：logs/server.log"
else
  echo "启动失败，请查看 logs/server.log"
  tail -20 logs/server.log
  exit 1
fi
