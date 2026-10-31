# GLM Free API — Cloudflare Worker 版

[GLM](https://chatglm.cn) 网页版 → **OpenAI / Anthropic / Responses / Gemini** 兼容 API。

这是 [ GLM-Free-API ](https://github.com/laninenterline/GLM-Free-API) 的 **单供应商 Cloudflare Worker 版**，
位于 **`cf-worker` 分支**；`main` 分支是 Node 版，两者功能对齐、互不影响。

> **License: GPL-3.0**（继承上游）。仅供个人研究，网页版接口非官方、不稳定、有封号风险。

## 特性

- 四协议入口：`/v1/chat/completions`、`/v1/messages`（Claude Code / DSH）、`/v1/responses`（Codex）、`/v1beta/models/*`（Gemini）
- `/v1/models` 带 `anthropic-version` 时返回 Anthropic 形状
- KV 多账号池：`round-robin` / `fill-first` / `failover`，失败账号 60s 冷却
- 模型映射（`claude-*` / `gpt-*` 通配符）、工具调用（提示词注入 + 统一解析）
- 管理接口 `/admin/api/*` + 简易面板 `/admin`
- 零 Node 运行时依赖（纯 fetch 实现）

## 模型

| 模型 ID | 别名 |
|---|---|
| GLM-5.3-Flash | GLM-5.1, glm-4, glm-4-flash |

模型名对网页端大多只是路由标签，实际效果由账号本身决定。

## 部署

```bash
npm install
npx wrangler login
npx wrangler kv namespace create KV     # 把 id 填进 wrangler.toml
npx wrangler secret put API_KEYS        # sk-a,sk-b
npx wrangler secret put ADMIN_KEY
npm run deploy
```

或一键脚本：

```bash
export CLOUDFLARE_API_TOKEN=...
export API_KEYS=... ADMIN_KEY=...
./scripts/deploy.sh
```

### 添加账号

```bash
BASE=https://glm-free-api.<subdomain>.workers.dev
curl -X POST $BASE/admin/api/accounts -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"glm","name":"glm-1","credentials":{"refresh_token":"<refresh_token>"}}'

curl $BASE/admin/api/status -H "Authorization: Bearer $ADMIN_KEY"
curl $BASE/admin/api/accounts -H "Authorization: Bearer $ADMIN_KEY"
```

凭证来源：chatglm.cn 的 `refresh_token`。

## 客户端接入

```bash
# Claude Code
export ANTHROPIC_BASE_URL=https://glm-free-api.<subdomain>.workers.dev
export ANTHROPIC_AUTH_TOKEN=sk-your-key
export ANTHROPIC_MODEL=GLM-5.3-Flash

# Codex CLI (~/.codex/config.toml)
model = "GLM-5.3-Flash"
model_provider = "worker"
[model_providers.worker]
base_url = "https://glm-free-api.<subdomain>.workers.dev/v1"
wire_api = "responses"
env_key = "WORKER_API_KEY"

# OpenAI SDK
client = OpenAI(base_url="https://glm-free-api.<subdomain>.workers.dev/v1", api_key="sk-your-key")

# Gemini
curl "https://glm-free-api.<subdomain>.workers.dev/v1beta/models/GLM-5.3-Flash:generateContent?key=sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```

## 管理接口

| Method | Path | 说明 |
|---|---|---|
| GET | `/admin` | 管理面板 |
| GET | `/admin/api/status` | 状态 / 账号统计 / 模型列表 |
| GET/POST | `/admin/api/accounts` | 账号列表（脱敏）/ 添加账号 |
| PATCH/DELETE | `/admin/api/accounts/:id` | 修改 / 删除账号 |
| GET/POST | `/admin/api/config` | 查看 / 修改策略、Key、模型映射 |

## 本地开发与测试

```bash
npm run typecheck
npm test
npm run build      # wrangler dry-run 打包检查
```

## 已知限制

- 工具调用是缓冲式的（请求带 `tools` 时先收完整段回答再解析 `tool_calls`）
- 仅文本对话，不含图片 / 视频 / 音频
- 网页版接口随时可能变更

## License & credits

- **GPL-3.0**，继承自 [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API)。
- 协议转换 / 工具解析 / 核心逻辑来自 [Chat2API-Worker](https://github.com/laninenterline/Chat2API-Worker)。
- 与 GLM 官方无关，使用风险自负。
