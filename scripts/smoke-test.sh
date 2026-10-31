#!/usr/bin/env bash
# 冒烟测试：验证服务能起来、鉴权生效、模型列表/管理接口可用
# 用法：先 `npm start`，另开终端执行 `bash scripts/smoke-test.sh`
set -u

BASE="${BASE:-http://127.0.0.1:8080}"
API_KEY="${API_KEY:-sk-local-test}"
ADMIN_KEY="${ADMIN_KEY:-change-me-admin}"

pass=0; fail=0
check() {
  local name="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "PASS  $name"
    pass=$((pass+1))
  else
    echo "FAIL  $name  (got: ${actual:0:120})"
    fail=$((fail+1))
  fi
}

check "health"            '"status":"ok"'      "$(curl -sS --max-time 5 "$BASE/health")"
check "v1/models"         'MiniMax-M3.1-Flash'    "$(curl -sS --max-time 5 "$BASE/v1/models" -H "Authorization: Bearer $API_KEY")"
check "auth reject"       'invalid_api_key'    "$(curl -sS --max-time 5 "$BASE/v1/models" -H "Authorization: Bearer wrong-key")"
check "admin accounts"    '"success":true'     "$(curl -sS --max-time 5 "$BASE/v0/management/accounts" -H "X-Admin-Key: $ADMIN_KEY")"
check "admin stats"       '"totalRequests"'    "$(curl -sS --max-time 5 "$BASE/v0/management/stats" -H "X-Admin-Key: $ADMIN_KEY")"
check "admin auth reject" 'UNAUTHORIZED'       "$(curl -sS --max-time 5 "$BASE/v0/management/accounts" -H "X-Admin-Key: wrong")"

echo
echo "结果：$pass passed, $fail failed"
[ "$fail" -eq 0 ]
