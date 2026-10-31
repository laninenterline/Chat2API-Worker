# GLM Free API (slim)

![CI](https://github.com/laninenterline/Chat2API/actions/workflows/ci.yml/badge.svg?branch=glm) ![License](https://img.shields.io/badge/license-GPL--3.0-blue) ![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

中文 | [English](README_EN.md)


glm 网页版 → **OpenAI ChatCompletions / Anthropic Messages / OpenAI Responses** 三协议兼容 API。

从 [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API)（Electron 桌面应用，GPL-3.0）里剥离出来的**单供应商精简版**：
纯 Node 服务、无 GUI、只保留 glm 一家，代码可读可改，可直接给 Claude Code / DeepSeek Harness / Codex CLI / 任何 OpenAI 兼容客户端使用。

> **许可证 GPL-3.0**（沿用上游）。仅供自用/研究，请勿对外提供服务；逆向网页接口有封号风险，商用请走官方 API。

## 支持模型

| 模型 ID | 显示名 |
|---|---|
| `GLM-5.3-Flash` | GLM-5.3-Flash |
| `GLM-5.3` | GLM-5.3 |

模型名在网页端并不真的决定模型（网页接口按会话/智能体走），这里的作用是**路由 + 客户端显示**。
旧模型名和编码客户端的默认模型名已配好别名映射：

| 别名 | 映射到 |
|---|---|
| `GLM-5.1` | `GLM-5.3` |
| `claude-3-5-haiku-*` | `GLM-5.3-Flash` |
| `claude-*` | `GLM-5.3` |
| `gpt-5-codex*` | `GLM-5.3` |
| `gpt-*` | `GLM-5.3` |
| `o3*` | `GLM-5.3` |
| `o4*` | `GLM-5.3` |

## 特性

- 三协议入口：`/v1/chat/completions`、`/v1/messages`（Claude Code / DSH）、`/v1/responses`（Codex）
- 流式输出、工具调用（prompt 注入 + 多格式解析）
- 模型映射（支持通配符）、多账号轮询 / fill-first / failover
- 上下文管理（滑窗 / token 上限 / 摘要）
- 管理接口 `/v0/management/*`
- Docker / Termux 均可运行

## 快速开始

```bash
npm install
cp config.example.json config.json   # 填 token
npm start                            # http://127.0.0.1:8080
```


### 获取 token

chatglm.cn 登录 → F12 → Application → Local Storage（或 Cookies）→ `chatglm_refresh_token`，填入 `refresh_token` 字段

### Node 版本兼容

| Node 版本 | 状态 |
|---|---|
| 18（已 EOL） | ✅ 代码兼容，CI 覆盖 |
| 20 LTS | ✅ CI 覆盖 |
| 22 LTS | ✅ CI 覆盖（推荐） |
| 24 LTS | ✅ CI 覆盖 |

启动脚本使用项目内的 `tsx`（不再依赖 `node --import`，因此 18 也能跑）；`npm start` 同样适用。
Docker 构建可通过 `--build-arg NODE_VERSION=20` / `22` / `24` 切换基础镜像（默认 22）。

## Docker

```bash
cp config.example.json config.json     # 填 token
docker build -t glm-free-api .
docker run -d --name glm-free-api -p 8080:8080 \
  -v $PWD/config.json:/app/config.json glm-free-api
```

- 基础镜像版本可切换：`docker build --build-arg NODE_VERSION=20|22|24 -t glm-free-api .`（默认 22）
- 镜像自带 `HEALTHCHECK`（`wget /health`），`docker ps` 能看到 healthy/unhealthy
- 也可以直接 `docker compose up -d`（仓库内含 `docker-compose.yml`）
- `config.json` 需要**可写**（GLM 刷新 token 后会回写文件），所以挂载不要加 `:ro`
- 也可用 `HOST` / `PORT` 环境变量覆盖监听地址（镜像默认 `HOST=0.0.0.0`，否则端口映射访问不到）
- 想以非 root 运行：`--user 1000:1000`，并保证宿主机 `config.json` 属主是 1000

预构建镜像（GitHub Actions 自动发布到 GHCR，tag `v*` 触发，支持 amd64/arm64）：

```bash
docker pull ghcr.io/laninenterline/glm-free-api:latest
# 或指定版本
docker pull ghcr.io/laninenterline/glm-free-api:1.0.6
```

## 客户端接入

**Claude Code**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=sk-local-test
export ANTHROPIC_MODEL=GLM-5.3-Flash
claude
```

**DeepSeek Harness (DSH)**（`~/.dsh/profiles/<profile>/cordis.patch.yml`）

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    baseURL: http://127.0.0.1:8080
    apiKeyEnv: SLIM_API_KEY
    models:
      - id: GLM-5.3-Flash
        name: GLM-5.3-Flash (slim)
        description: 经 Chat2API 转发
        contextWindow: 131072
        maxTokens: 8192
        inputModalities: [text]
        systemPromptUpdate: in-history
        toolUpdate: in-history
      - id: GLM-5.3
        name: GLM-5.3 (slim)
        description: 经 Chat2API 转发
        contextWindow: 131072
        maxTokens: 8192
        inputModalities: [text]
        systemPromptUpdate: in-history
        toolUpdate: in-history
```

凭据写进 `~/.dsh/.credentials.yaml` 的 `refs`：`SLIM_API_KEY: sk-local-test`

**Codex CLI**（`~/.codex/config.toml`）

```toml
model = "GLM-5.3-Flash"
model_provider = "slim"
[model_providers.slim]
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "SLIM_API_KEY"
```

**OpenAI SDK**

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="sk-local-test")
print(client.chat.completions.create(model="GLM-5.3-Flash", messages=[{"role": "user", "content": "hi"}]).choices[0].message.content)
```

## 配置说明

| 字段 | 说明 |
|---|---|
| `host` / `port` | 监听地址，默认 `127.0.0.1:8080` |
| `apiKeys` | 调用 `/v1/*` 的 key（`Authorization: Bearer` 或 `x-api-key`）；为空不校验 |
| `adminKey` | 管理接口 key；为空则 `/v0/management` 返回 404 |
| `loadBalanceStrategy` | `round-robin` / `fill-first` / `failover` |
| `mode` | `single`（每次请求后清上游会话）/ `multi` |
| `modelMappings` | 别名 → 真实模型，支持 `*` 通配符 |
| `accounts` | 账号数组，可多账号自动轮询 |

## 管理接口

鉴权：`X-Admin-Key` 或 `Authorization: Bearer <adminKey>`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/v0/management/accounts` | 账号列表 / 新增 |
| PATCH/DELETE | `/v0/management/accounts/:id` | 改凭据 / 删除 |
| GET | `/v0/management/providers` | 供应商与模型 |
| GET | `/v0/management/models` | 全部模型 |
| GET | `/v0/management/stats` | 请求统计 |
| GET | `/v0/management/logs` | 最近请求日志 |
| GET/PATCH | `/v0/management/config` | 查看 / 热改配置 |

还有 `GET /health`、`GET /stats`。

## 验证状态

✅ 已用真实账号验证：非流式、流式、工具调用

```bash
npx tsc --noEmit          # 类型检查
npm test                  # 协议转换单测
bash scripts/smoke-test.sh # 冒烟测试（需服务已启动）
```

- GLM 的 refresh_token 有效期约 180 天，access_token 24 小时，服务端会自动刷新。
- GLM-5.3 在流式工具调用时偶尔会输出损坏的 XML 标记（模型侧偶发），重试通常即可成功。

## 目录结构（简）

```
src/main/
├── index.ts                 # 入口
├── store/                   # 账号池、配置、会话
├── providers/builtin/       # glm 供应商配置
├── lib/challenge.ts         # （仅 DeepSeek）PoW 解算
└── proxy/
    ├── server.ts            # Koa 服务与中间件
    ├── completion.ts        # 选账号/映射/重试
    ├── forwarder.ts         # 转发到 adapter
    ├── adapters/            # glm 网页端协议适配（核心）
    ├── convert/             # Anthropic / Responses 协议转换
    ├── routes/              # chat / messages / responses / models / admin
    ├── toolCalling/         # 工具调用引擎
    └── ...
```

## 许可证与致谢

- 本项目为 [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API) 的衍生物，按 **GPL-3.0** 发布，见 [LICENSE](LICENSE)。
- Chat2API 又源自 [LLM-Red-Team](https://github.com/LLM-Red-Team) 的 glm-free-api / deepseek-free-api / minimax-free-api 改造版，感谢原作者。
- 本项目与 glm 官方无任何关联，仅用于学习研究。请遵守目标站点的服务条款，不要用于商业用途或对外提供服务。
