#!/usr/bin/env bash
#
# 一键部署 Chat2API Worker 到 Cloudflare
#
# 用法：
#   export CLOUDFLARE_API_TOKEN=...            # 必需（Workers 编辑权限 + KV 编辑权限）
#   export CLOUDFLARE_ACCOUNT_ID=...           # 可选，多账号时建议设置
#   export API_KEYS="sk-a,sk-b"                # 可选，会写入 Worker Secret
#   export ADMIN_KEY="your-admin-key"          # 可选，会写入 Worker Secret
#   export SIGN_SECRET="..."                   # 可选，覆盖 GLM 默认签名密钥
#   ./scripts/deploy.sh
#
# 其它环境变量：
#   KV_NAME=KV              KV 命名空间名称（默认 KV）
#   WORKER_NAME             覆盖 Worker 名称（默认读 wrangler.toml）
#   SKIP_SECRETS=1          跳过 Secret 写入（只部署）
#   SKIP_KV=1               跳过 KV 创建/绑定（wrangler.toml 里已手动配好）
#
set -euo pipefail

cd "$(dirname "$0")/.."

KV_NAME="${KV_NAME:-KV}"
SKIP_SECRETS="${SKIP_SECRETS:-0}"
SKIP_KV="${SKIP_KV:-0}"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v npx >/dev/null || die "需要 Node.js / npx"
[ -f package.json ] || die "请在仓库根目录运行（找不到 package.json）"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if [ "${SKIP_SECRETS}" != "1" ] || [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    die "请先 export CLOUDFLARE_API_TOKEN=...（Cloudflare Dashboard → My Profile → API Tokens）"
  fi
fi

[ -d node_modules ] || { log "安装依赖..."; npm install; }

# 1) 创建 KV 并写入 wrangler.toml
if [ "${SKIP_KV}" != "1" ]; then
  log "查找 KV 命名空间 '${KV_NAME}'..."
  KV_ID="$(KV_NAME="${KV_NAME}" npx wrangler kv namespace list --json 2>/dev/null | node -e '
    let raw = ""
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      try {
        const list = JSON.parse(raw);
        const hit = list.find((x) => (x.title || x.name) === process.env.KV_NAME);
        if (hit) process.stdout.write(hit.id);
      } catch {}
    });
  ' 2>/dev/null || true)"

  if [ -z "${KV_ID}" ]; then
    log "创建 KV 命名空间 '${KV_NAME}'..."
    KV_ID="$(npx wrangler kv namespace create "${KV_NAME}" --json 2>/dev/null | node -e '
      let raw = ""
      process.stdin.on("data", (c) => (raw += c)).on("end", () => {
        try { process.stdout.write(JSON.parse(raw).id || ""); } catch {}
      });
    ')"
  fi
  [ -n "${KV_ID}" ] || die "KV 创建/查询失败，请手动执行 npx wrangler kv namespace create ${KV_NAME}"

  log "绑定 KV id=${KV_ID}"
  KV_NAME="${KV_NAME}" KV_ID="${KV_ID}" node -e '
    const fs = require("fs");
    const path = "wrangler.toml";
    let text = fs.readFileSync(path, "utf8");
    if (!/\[\[kv_namespaces\]\]/.test(text)) {
      text += `\n[[kv_namespaces]]\nbinding = "KV"\nid = "${process.env.KV_ID}"\n`;
    } else {
      text = text.replace(/(\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*")[^"]*(")/, `$1${process.env.KV_ID}$2`);
    }
    fs.writeFileSync(path, text);
  '
fi

# 2) 写入 Secrets
if [ "${SKIP_SECRETS}" != "1" ]; then
  if [ -n "${API_KEYS:-}" ]; then
    log "写入 API_KEYS secret"
    printf '%s' "${API_KEYS}" | npx wrangler secret put API_KEYS >/dev/null
  fi
  if [ -n "${ADMIN_KEY:-}" ]; then
    log "写入 ADMIN_KEY secret"
    printf '%s' "${ADMIN_KEY}" | npx wrangler secret put ADMIN_KEY >/dev/null
  fi
  if [ -n "${SIGN_SECRET:-}" ]; then
    log "写入 SIGN_SECRET secret"
    printf '%s' "${SIGN_SECRET}" | npx wrangler secret put SIGN_SECRET >/dev/null
  fi
fi

# 3) 部署
log "部署 Worker..."
npx wrangler deploy

log "完成 ✅"
log "管理面板: https://<worker>.<subdomain>.workers.dev/admin"
log "添加账号示例:"
echo '  curl -X POST https://<worker>.workers.dev/admin/api/accounts \'
echo '    -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \'
echo '    -d '"'"'{"provider":"glm","credentials":{"refresh_token":"..."}}'"'"''
