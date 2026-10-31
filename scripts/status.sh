#!/usr/bin/env bash
# 查看 chat2api-slim 状态
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f .server.pid ] && kill -0 "$(cat .server.pid)" 2>/dev/null; then
  echo "运行中，pid=$(cat .server.pid)"
  curl -sS --max-time 3 http://127.0.0.1:8080/health || true
  echo
else
  echo "未运行"
fi
