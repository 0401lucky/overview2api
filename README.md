# overview2API

给 SillyTavern / new-api 用的 ClickUp Brain 代理。

它提供 OpenAI 兼容接口，底层调用 ClickUp AI 的 GraphQL HTTP + WebSocket。

- `GET /health`：进程健康检查
- `GET /ready`：检查 ClickUp token 换发和上游连通性
- `GET /v1/models`：OpenAI 兼容模型列表
- `GET /models`：兼容部分中转面板的模型列表路径
- `POST /v1/chat/completions`：OpenAI 兼容聊天接口
- `GET /admin`：账号池管理页

不支持工具调用、函数调用、多模态上传。角色扮演聊天够用。


## 多账号账号池

现在支持多个 ClickUp 账号轮询调用：

- new-api / SillyTavern 仍然只填一个 `API_KEY`
- 后端自动从账号池里选择可用账号
- 单个账号失败后会进入临时冷却，默认 15 分钟
- 管理页支持新增、编辑、删除、测试账号
- 默认每次请求自动创建新的 ClickUp AI 会话，避免不同角色卡串上下文
- 管理页提供总统计面板：总请求、成功率、今日请求、上游尝试、最近调用
- 每个账号可设置预估额度提醒阈值，默认 50；达到阈值只提醒，不会强制停用

部署后打开：

```text
https://你的-zeabur域名/admin
```

在页面左侧填 `ADMIN_KEY`。如果没有单独设置 `ADMIN_KEY`，就填 `API_KEY`。

账号信息默认保存到：

```bash
ACCOUNTS_FILE=./data/accounts.json
```

账号配置和统计都保存在这个文件里。只要这个文件所在目录是持久化的，
容器重启后累计调用次数不会丢。

如果你希望在 Zeabur 重启后账号仍然保留，需要给服务挂载持久化卷，并把：

```bash
ACCOUNTS_FILE=/app/data/accounts.json
```

不想挂载卷也可以，把账号写到环境变量 `CLICKUP_ACCOUNTS_JSON`，只是编辑不如管理页方便。


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

如果要多账号，更推荐打开 `/admin`，在每个账号里分别粘贴 Cookie，然后点“测试”。

你截图里的 Cookie 看起来可能复制到了普通页面请求或统计请求的 Cookie，
不一定包含 `id.app.clickup.com` 身份接口需要的登录 Cookie。
要优先复制下面这类请求的 Request Headers：

```text
https://id.app.clickup.com/data/v3/workspaces/.../authentication/access_tokens
https://id.app.clickup.com/auth/v1/refresh_token
```

只复制 `Cookie:` 后面的值，不要包含 `Cookie:` 这几个字。

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
ADMIN_KEY=管理页密钥，不填则默认等于 API_KEY
CLICKUP_WORKSPACE_ID=90141378436
CLICKUP_AUTH_COOKIE=你手动复制的 Cookie 请求头值
```

建议完整填写：

```bash
CLICKUP_DEFAULT_MODEL=Brain² Max
CLICKUP_TIMEOUT_MS=120000
CLICKUP_REQUEST_TIMEOUT_MS=30000
CLICKUP_TOKEN_REFRESH_SKEW_SECONDS=60
CLICKUP_ACCOUNT_COOLDOWN_MS=900000
CLICKUP_ACCOUNT_QUOTA_LIMIT=50
ACCOUNTS_FILE=/app/data/accounts.json
MODEL_OWNER=clickup
CLICKUP_REUSE_CONVERSATION=false
```

`CLICKUP_ACCOUNT_QUOTA_LIMIT` 只是提醒阈值，不是硬限制。比如新账号可以填 `50`，
会员或试用 credits 更多的账号可以在管理页改成 `1500`，填 `0` 表示不提醒。
真正会让账号暂停参与轮询的是上游调用报错，账号会进入临时冷却。

端口不用改。服务读取 Zeabur 自动注入的 `PORT`，本地默认 `3000`。

单账号环境变量模式不需要挂载卷。

如果使用 `/admin` 管理多账号，建议挂载卷到：

```text
/app/data
```

否则 Zeabur 重建容器后，管理页新增的账号和累计统计都会丢失。


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


## 会话隔离

默认情况下，聊天请求不会复用账号里的 `Conversation ID`。

服务会在每次 `/v1/chat/completions` 调用时让 ClickUp 自动创建新会话，
并从 WebSocket 回复里拿到本次的 `conversation_id`。这样 SillyTavern 或
new-api 已经传来的完整 `messages` 就是上下文来源，不会再被 ClickUp 旧会话污染。

只有下面两种情况才会复用固定会话：

```bash
CLICKUP_REUSE_CONVERSATION=true
```

或者请求里显式传：

```json
{
  "clickup_conversation_id": "4002128792162479189"
}
```

管理页里的 `固定 Conversation ID` 可以留空。


## SillyTavern 配置

在 SillyTavern 里选 OpenAI 兼容接口：

- API 类型：OpenAI Compatible
- Base URL：`https://你的-zeabur域名/v1`
- API Key：填 Zeabur 里的 `API_KEY`
- Model：选择 `/v1/models` 返回的模型，例如 `Brain² Max`

流式输出可以开。内部仍是等 ClickUp 完整回复后一次性推给 SillyTavern。
