# overview2API

给 SillyTavern / new-api 用的 ClickUp Brain 代理。

它提供 OpenAI 兼容接口，底层调用 ClickUp AI 的 GraphQL HTTP + WebSocket。

- `GET /health`：进程健康检查
- `GET /ready`：检查 ClickUp token 换发和上游连通性
- `GET /v1/models`：OpenAI 兼容模型列表
- `GET /models`：兼容部分中转面板的模型列表路径
- `POST /v1/chat/completions`：OpenAI 兼容聊天接口

不支持工具调用、函数调用、多模态上传。角色扮演聊天够用。


## 已确认的 ClickUp 信息

这次已经用你的登录账号真实确认过：

```bash
CLICKUP_WORKSPACE_ID=90141378436
CLICKUP_CONVERSATION_ID=4002128792162479189
CLICKUP_GRAPHQL_HTTP_ENDPOINT=https://frontdoor-search.clickup-prod.com/graphql/gateway
CLICKUP_GRAPHQL_WS_ENDPOINT=wss://frontdoor-search.clickup-prod.com/graphql/gateway
```

真实页面已验证：

- `请只回复 pong` -> `pong`
- `请只回复 ping` -> `ping`
- 服务端直连 WebSocket 已确认能收到分块回复


## 模型列表

页面模型菜单已确认包含：

```text
Brain² Max
GPT-5.5
Claude Opus 4.8
Gemini 3.1 Pro
GPT-5.4
GPT-5.2
GPT-5.1
GPT-5.4 mini
Claude Opus 4.6
Claude Sonnet 4.6
Claude Haiku 4.5
Gemini 3.5 Flash
Gemini 3 Flash
Gemini 3.1 Flash Lite
```

默认模型是 `Brain² Max`，实际请求参数是 `selectedModel=auto`。

如果后续 ClickUp 改了内部参数，可以用环境变量覆盖：

```bash
CLICKUP_MODELS=Brain² Max=auto,GPT-5.5=gpt-5.5,Claude Opus 4.8=claude-opus-4.8
```


## 获取部署凭据

推荐用 `CLICKUP_AUTH_COOKIE`。这样服务可以自动换发：

```text
浏览器 Cookie -> workspace JWT -> frontdoor accessToken -> AI WebSocket
```

操作步骤：

1. 用 Chrome 登录 ClickUp。
2. 打开开发者工具，切到 `Network`。
3. 在 ClickUp 页面刷新一下。
4. 搜索 `access_tokens` 或 `refresh_token`。
5. 点开这个请求，找到 `Request Headers` 里的 `Cookie`。
6. 只复制 `Cookie:` 后面的值。
7. 填到 Zeabur 环境变量 `CLICKUP_AUTH_COOKIE`。

注意：这是网页登录态，权限很高。只放在 Zeabur 的 Secret 环境变量里，不要提交到 GitHub。

备选方案是 `CLICKUP_JWT`：

1. 在 Network 搜索 `access_tokens`。
2. 看它的 Response，复制 `token` 字段。
3. 填到 `CLICKUP_JWT`。

这个 JWT 通常约 48 小时过期，过期后必须手动更新，不推荐长期部署。


## Zeabur 部署

从 GitHub 导入仓库，部署方式选 Dockerfile。

最小必填环境变量：

```bash
API_KEY=给 SillyTavern 或 new-api 填的代理密钥
CLICKUP_WORKSPACE_ID=90141378436
CLICKUP_CONVERSATION_ID=4002128792162479189
CLICKUP_AUTH_COOKIE=你手动复制的 Cookie 请求头值
```

建议完整填写：

```bash
CLICKUP_DEFAULT_MODEL=Brain² Max
CLICKUP_TIMEOUT_MS=120000
CLICKUP_REQUEST_TIMEOUT_MS=30000
CLICKUP_TOKEN_REFRESH_SKEW_SECONDS=60
MODEL_OWNER=clickup
```

端口不用改。服务读取 Zeabur 自动注入的 `PORT`，本地默认 `3000`。

不需要挂载卷。服务无状态，不保存聊天记录、不写数据库。


## 部署后检查

假设 Zeabur 域名是：

```text
https://overview2api.example.zeabur.app
```

检查进程：

```bash
curl https://overview2api.example.zeabur.app/health
```

检查 ClickUp 配置：

```bash
curl https://overview2api.example.zeabur.app/ready \
  -H "authorization: Bearer 你设置的 API_KEY"
```

检查模型：

```bash
curl https://overview2api.example.zeabur.app/v1/models \
  -H "authorization: Bearer 你设置的 API_KEY"
```

测试聊天：

```bash
curl https://overview2api.example.zeabur.app/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer 你设置的 API_KEY" \
  -d '{"model":"Brain² Max","messages":[{"role":"user","content":"请只回复 ping"}]}'
```


## new-api 配置

在 new-api 新增 OpenAI 兼容渠道：

- 类型：OpenAI 或 OpenAI Compatible
- Base URL：`https://你的-zeabur域名`
- API Key：填 Zeabur 里的 `API_KEY`
- 模型：从模型获取接口同步，或手动填 `Brain² Max`

如果 new-api 要求 Base URL 必须带 `/v1`，就填：

```text
https://你的-zeabur域名/v1
```

模型获取接口支持：

```text
GET /v1/models
GET /models
```


## SillyTavern 配置

在 SillyTavern 里选 OpenAI 兼容接口：

- API 类型：OpenAI Compatible
- Base URL：`https://你的-zeabur域名/v1`
- API Key：填 Zeabur 里的 `API_KEY`
- Model：选择 `/v1/models` 返回的模型，例如 `Brain² Max`

流式输出可以开。内部仍是等 ClickUp 完整回复后一次性推给 SillyTavern。
