#!/usr/bin/env bash
# 停止 chat2api-slim
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ ! -f .server.pid ]; then
  echo "没有 .server.pid，可能未运行"
  exit 0
fi
PID="$(cat .server.pid)"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  sleep 1
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
  echo "已停止 pid=$PID"
else
  echo "进程不存在 pid=$PID"
fi
rm -f .server.pid
