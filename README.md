# Chat2API Worker

![CI](https://github.com/laninenterline/Chat2API/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-GPL--3.0-blue) ![Platform](https://img.shields.io/badge/platform-Cloudflare%20Workers-orange)

中文 | [English](README_EN.md)


> 一个 **Cloudflare Worker**，把 **DeepSeek / GLM / MiniMax** 三家网页版模型统一成
> **OpenAI ChatCompletions / Anthropic Messages / OpenAI Responses** 三种兼容 API。
> 单文件部署、免费额度可跑，配合 KV 实现多账号池与负载均衡。

由前作的单供应商版本（已合并到本仓库的 [`deepseek`](https://github.com/laninenterline/Chat2API/tree/deepseek) /
[`glm`](https://github.com/laninenterline/Chat2API/tree/glm) /
[`minimax`](https://github.com/laninenterline/Chat2API/tree/minimax) 分支）抽取合并而来，
GLM 适配器复用 [HelloGML](https://github.com/LLM-Red-Team/glm-free-api) 系在 Workers 上验证过的实现。

> **License: GPL-3.0**（继承上游）。仅供个人研究，网页版接口非官方、不稳定、有封号风险。

## 分支一览

四个相关项目已合并进本仓库，用分支区分（原仓库仍然保留，可随时归档/删除）：

| 分支 | 内容 |
|---|---|
| [`main`](https://github.com/laninenterline/Chat2API) | 三合一 Cloudflare Worker（本仓库默认分支） |
| [`deepseek`](https://github.com/laninenterline/Chat2API/tree/deepseek) | DeepSeek 单供应商 Node 版（原 DeepSeek-Free-API） |
| [`glm`](https://github.com/laninenterline/Chat2API/tree/glm) | GLM 单供应商 Node 版（原 GLM-Free-API） |
| [`minimax`](https://github.com/laninenterline/Chat2API/tree/minimax) | MiniMax 单供应商 Node 版（原 MiniMax-Free-API） |
| [`deepseek-worker`](https://github.com/laninenterline/Chat2API/tree/deepseek-worker) | DeepSeek 单供应商 Cloudflare Worker 版 |
| [`glm-worker`](https://github.com/laninenterline/Chat2API/tree/glm-worker) | GLM 单供应商 Cloudflare Worker 版 |
| [`minimax-worker`](https://github.com/laninenterline/Chat2API/tree/minimax-worker) | MiniMax 单供应商 Cloudflare Worker 版 |

```bash
git clone -b deepseek https://github.com/laninenterline/Chat2API.git   # Node 版
git clone -b glm-worker https://github.com/laninenterline/Chat2API.git # Worker 版
```

## 特性

- **四协议入口**：`/v1/chat/completions`、`/v1/messages`（Claude Code / DSH）、`/v1/responses`（Codex）、`/v1beta/models/*`（Gemini）
- **`/v1/models` 双形状**：带 `anthropic-version` 头时返回 Anthropic 形状（Claude Code / DSH 探测用）
- **三供应商**：DeepSeek（wasm PoW）、GLM（sign 签名）、MiniMax（设备注册 + 轮询）
- **多账号池**：KV 存账号，`round-robin` / `fill-first` / `failover`，失败账号 60s 冷却
- **模型映射**：支持精确与 `*` 通配符，客户端可用 `claude-*` / `gpt-*` 等名字路由
- **工具调用**：网页版没有原生 function calling，统一「提示词注入 + 输出解析」方案（支持 `[function_calls]`、XML、Anthropic、JSON 四种格式）
- **管理接口**：`/admin/api/*` 增删账号、查状态、改配置（带脱敏）
- **零 Node 依赖**：DeepSeek 的 wasm 通过 `CompiledWasm` 打包进 Worker

## 目录结构

```
src/
├── worker/                  # Worker 入口与核心层
│   ├── index.ts             # fetch 路由 + CORS + 鉴权
│   ├── protocols.ts         # 三协议入口（OpenAI / Anthropic / Responses）
│   ├── completion.ts        # 模型映射 → 选账号 → 工具注入 → 调 provider
│   ├── store.ts             # KV 账号池 / 负载均衡 / 配置 / 统计
│   ├── tools.ts             # 工具提示注入 + 输出解析
│   ├── admin.ts             # /admin/api/* 管理接口 + HTML 面板
│   ├── sse.ts               # Web Stream SSE 解析
│   ├── providers/
│   │   ├── deepseek.ts      # DeepSeek 网页版（PoW 用 wasm）
│   │   ├── glm.ts           # GLM 包装（复用 glm-legacy）
│   │   ├── minimax.ts       # MiniMax 设备注册 + 轮询
│   │   ├── glm-legacy/      # HelloGML 的 Workers 版 GLM 实现
│   │   └── catalog.ts       # 模型元数据
│   └── types.ts
├── main/                    # 从 Node 版复用的纯逻辑：协议转换、工具解析、类型
│   ├── proxy/convert/       # OpenAI → Anthropic / Responses 转换与流式编码
│   ├── proxy/toolCalling/   # 工具提示词协议
│   ├── proxy/utils/         # 工具解析器（bracket/xml/anthropic/json）
│   └── store/types.ts
└── shared/                  # 共享类型
assets/sha3_wasm_bg.*.wasm   # DeepSeek PoW wasm
```

## 部署

### 一键脚本（推荐）

```bash
export CLOUDFLARE_API_TOKEN=...      # Workers + KV 编辑权限
export API_KEYS="sk-a,sk-b"          # 可选
export ADMIN_KEY="your-admin-key"    # 可选
./scripts/deploy.sh                  # 自动建/绑定 KV、写 Secret、部署
```

其它变量：`CLOUDFLARE_ACCOUNT_ID`、`KV_NAME`（默认 `KV`）、`SIGN_SECRET`、`SKIP_SECRETS=1`、`SKIP_KV=1`。

### 手动步骤

### 1. 准备

```bash
npm install
npx wrangler login            # 或设置 CLOUDFLARE_API_TOKEN
npx wrangler kv namespace create KV
# 把输出里的 id 填到 wrangler.toml 的 [[kv_namespaces]] 下
```

### 2. 配置 Secrets（推荐）

```bash
npx wrangler secret put API_KEYS      # 例：sk-your-key,sk-team
npx wrangler secret put ADMIN_KEY     # 管理接口用
# 可选
npx wrangler secret put SIGN_SECRET   # 覆盖 GLM 默认签名 secret
```

也可以不设 Key（放开访问，但不建议）。

### 3. 部署

```bash
npm run deploy
# 输出 https://chat2api-worker.<your-subdomain>.workers.dev
```

### 4. 添加账号

账号存在 KV（`accounts` key），通过管理接口操作：

```bash
BASE=https://chat2api-worker.<your-subdomain>.workers.dev
KEY=你的 ADMIN_KEY

# DeepSeek：浏览器 localStorage 的 userToken
curl -X POST $BASE/admin/api/accounts -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","name":"ds-1","credentials":{"token":"<userToken>"}}'

# GLM：chatglm.cn 的 refresh_token
curl -X POST $BASE/admin/api/accounts -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"glm","name":"glm-1","credentials":{"refresh_token":"<refresh_token>"}}'

# MiniMax：agent.minimax.cn 的 _token（realUserID 可选，会自动从 JWT 解析）
curl -X POST $BASE/admin/api/accounts -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"minimax","name":"mm-1","credentials":{"token":"<jwt>","realUserID":"<id>"}}'

# 查看
curl $BASE/admin/api/status  -H "Authorization: Bearer $KEY"
curl $BASE/admin/api/accounts -H "Authorization: Bearer $KEY"
```

管理页面：浏览器打开 `$BASE/admin`。

## 客户端接入

### Claude Code

```bash
export ANTHROPIC_BASE_URL=https://chat2api-worker.xxx.workers.dev
export ANTHROPIC_AUTH_TOKEN=sk-your-key
export ANTHROPIC_MODEL=GLM-5.3
claude
```

### DeepSeek Harness (DSH)

`~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    baseURL: https://chat2api-worker.xxx.workers.dev
    apiKeyEnv: WORKER_API_KEY
    models:
      - id: GLM-5.3
```

`~/.dsh/.credentials.yaml` 的 `refs` 里加 `WORKER_API_KEY: sk-your-key`。

### Codex CLI

`~/.codex/config.toml`：

```toml
model = "GLM-5.3"
model_provider = "worker"
[model_providers.worker]
base_url = "https://chat2api-worker.xxx.workers.dev/v1"
wire_api = "responses"
env_key = "WORKER_API_KEY"
```

### Gemini

```bash
curl "https://chat2api-worker.xxx.workers.dev/v1beta/models/GLM-5.3:generateContent?key=sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```

流式：把 `:generateContent` 换成 `:streamGenerateContent`（SSE，`alt=sse` 客户端直接可用），
模型列表 `GET /v1beta/models`。

### OpenAI SDK

```python
from openai import OpenAI
client = OpenAI(base_url="https://chat2api-worker.xxx.workers.dev/v1", api_key="sk-your-key")
print(client.chat.completions.create(model="MiniMax-M3.1-Flash",
      messages=[{"role":"user","content":"hi"}]).choices[0].message.content)
```

## 支持模型与映射

| Provider | 模型 |
|---|---|
| DeepSeek | `deepseek-v4.1-flash`（别名 `deepseek-v4-flash`、`deepseek-v4-pro`） |
| GLM | `GLM-5.3-Flash`、`GLM-5.3`（别名 `GLM-5.1`、`glm-4`） |
| MiniMax | `MiniMax-M3.1-Flash`（别名 `MiniMax-M2.7`） |

模型名对网页端大多是「路由标签」，真正决定效果的是账号本身。
可以在 `/admin/api/config` 里覆盖 `modelMappings`，例如：

```bash
curl -X POST $BASE/admin/api/config -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"strategy":"round-robin","modelMappings":{"claude-*":"GLM-5.3","gpt-4o":"deepseek-v4.1-flash"}}'
```

## 管理接口

| Method | Path | 说明 |
|---|---|---|
| GET | `/admin` | 管理页面 |
| GET | `/admin/api/status` | 服务状态、账号统计、模型列表 |
| GET | `/admin/api/accounts` | 账号列表（凭证脱敏） |
| POST | `/admin/api/accounts` | 添加账号 `{provider, credentials, name?}` |
| PATCH | `/admin/api/accounts/:id` | 改凭证 / 状态 |
| DELETE | `/admin/api/accounts/:id` | 删除账号 |
| GET | `/admin/api/config` | 查看配置 |
| POST | `/admin/api/config` | 修改 `apiKeys` / `adminKey` / `strategy` / `modelMappings` |

鉴权：`Authorization: Bearer <ADMIN_KEY>`（或任一 API Key）。

## 本地开发与测试

```bash
npm run typecheck    # tsc
npm test             # 14 个单测：工具注入/解析、OpenAI/Anthropic/Responses/Gemini 转换、账号池、GLM 适配器 mock
npm run dev          # wrangler dev（本机 workerd）
npm run build        # wrangler dry-run 打包检查
```

## 已知限制

- **工具调用是缓冲式的**：为了让网页版模型也能稳定产出 `tool_calls`，请求带 `tools` 时会先收完整段回答再解析，客户端看到的工具调用不是逐字流式（SSE 仍然合法）。
- 只做文本对话：不含图片 / 视频 / 音频生成。

- MiniMax 账号需要积分，且只实现「单轮新会话」流程。
- 网页版接口随时可能变更，失效时需要跟着改。

## License & credits

- **GPL-3.0**，继承自 [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API)。
- GLM 适配器来自 [HelloGML](https://github.com/LLM-Red-Team/glm-free-api) 系列（其 Worker 版实现）。
- 协议转换 / 工具解析 / 类型定义复用本项目 Node 版 `chat2api-slim`。
- 与 DeepSeek / 智谱 / MiniMax 官方无关，使用风险自负。
