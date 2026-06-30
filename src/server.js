import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const DEFAULT_MODELS = [
  { id: "Brain² Max", selectedModel: "auto" },
  { id: "GPT-5.5", selectedModel: "gpt-5.5" },
  { id: "Claude Opus 4.8", selectedModel: "claude-opus-4.8" },
  { id: "Gemini 3.1 Pro", selectedModel: "gemini-3.1-pro" },
  { id: "GPT-5.4", selectedModel: "gpt-5.4" },
  { id: "GPT-5.2", selectedModel: "gpt-5.2" },
  { id: "GPT-5.1", selectedModel: "gpt-5.1" },
  { id: "GPT-5.4 mini", selectedModel: "gpt-5.4-mini" },
  { id: "Claude Opus 4.6", selectedModel: "claude-opus-4.6" },
  { id: "Claude Sonnet 4.6", selectedModel: "claude-sonnet-4.6" },
  { id: "Claude Haiku 4.5", selectedModel: "claude-haiku-4.5" },
  { id: "Gemini 3.5 Flash", selectedModel: "gemini-3.5-flash" },
  { id: "Gemini 3 Flash", selectedModel: "gemini-3-flash" },
  { id: "Gemini 3.1 Flash Lite", selectedModel: "gemini-3.1-flash-lite" },
];

const config = {
  port: toPositiveInt(process.env.PORT, 3000),
  apiKey: process.env.API_KEY || "",
  workspaceId: process.env.CLICKUP_WORKSPACE_ID || "90141378436",
  conversationId: process.env.CLICKUP_CONVERSATION_ID || "",
  authCookie: process.env.CLICKUP_AUTH_COOKIE || "",
  clickupJwt: process.env.CLICKUP_JWT || "",
  defaultModel: process.env.CLICKUP_DEFAULT_MODEL || "Brain² Max",
  modelOwner: process.env.MODEL_OWNER || "clickup",
  timeoutMs: toPositiveInt(process.env.CLICKUP_TIMEOUT_MS, 120000),
  requestTimeoutMs: toPositiveInt(process.env.CLICKUP_REQUEST_TIMEOUT_MS, 30000),
  refreshSkewSeconds: toPositiveInt(process.env.CLICKUP_TOKEN_REFRESH_SKEW_SECONDS, 60),
  identityBaseUrl: process.env.CLICKUP_IDENTITY_BASE_URL || "https://id.app.clickup.com",
  frontdoorTokenUrl:
    process.env.CLICKUP_FRONTDOOR_TOKEN_URL ||
    "https://frontdoor-prod-us-east-2-2.clickup.com/v2/sd/team/{workspaceId}/access-token",
  graphqlHttpEndpoint:
    process.env.CLICKUP_GRAPHQL_HTTP_ENDPOINT ||
    "https://frontdoor-search.clickup-prod.com/graphql/gateway",
  graphqlWsEndpoint:
    process.env.CLICKUP_GRAPHQL_WS_ENDPOINT ||
    "wss://frontdoor-search.clickup-prod.com/graphql/gateway",
  models: parseModels(process.env.CLICKUP_MODELS || ""),
};

const state = {
  cookieHeader: config.authCookie,
  workspaceJwt: config.clickupJwt,
  workspaceJwtExpiresAt: decodeJwtExpiry(config.clickupJwt),
  frontdoorToken: "",
  frontdoorTokenExpiresAt: 0,
};

const PRELOAD_AI_RESULT_MUTATION = `
mutation PreloadAiResult($q: String!, $conversationID: String, $retried: Boolean) {
  preloadAiResult(q: $q, conversationID: $conversationID, retried: $retried) {
    success
    preloadId
    reason
  }
}
`;

const ASK_AI_SUBSCRIPTION = `
subscription AskAISubscription(
  $q: String!
  $conversationID: String
  $jwt: String
  $retried: Boolean
  $selectedItems: String
  $triggeredAtMs: String
) {
  aiResult(
    q: $q
    conversationID: $conversationID
    jwt: $jwt
    retried: $retried
    selectedItems: $selectedItems
    triggeredAtMs: $triggeredAtMs
  ) {
    answerChunk
    answerComplete
    title
    conversationID
  }
}
`;

function toPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseModels(value) {
  if (!value.trim()) return DEFAULT_MODELS;

  const items = value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [id, selectedModel] = item.split("=").map((part) => part.trim());
      return {
        id,
        selectedModel: selectedModel || slugModel(id),
      };
    });

  return items.length ? items : DEFAULT_MODELS;
}

function slugModel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/²/g, "2")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "brain2-max" ? "auto" : normalized;
}

function decodeJwtExpiry(token) {
  if (!token || !token.includes(".")) return 0;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function isFresh(expiresAt, skewSeconds = config.refreshSkewSeconds) {
  return expiresAt && Date.now() + skewSeconds * 1000 < expiresAt;
}

function identityAccessTokenUrl() {
  return `${config.identityBaseUrl}/data/v3/workspaces/${config.workspaceId}/authentication/access_tokens?trigger_source=overview2api`;
}

function identityRefreshUrl() {
  return `${config.identityBaseUrl}/auth/v1/refresh_token`;
}

function frontdoorTokenUrl() {
  return config.frontdoorTokenUrl.replace("{workspaceId}", encodeURIComponent(config.workspaceId));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

function jsonResponse(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function errorResponse(res, statusCode, message, details) {
  jsonResponse(res, statusCode, {
    error: {
      message,
      type: "overview2api_error",
      details,
    },
  });
}

function assertAuthorized(req) {
  if (!config.apiKey) return;
  const header = req.headers.authorization || "";
  if (header !== `Bearer ${config.apiKey}` && header !== config.apiKey) {
    const err = new Error("API Key 不正确");
    err.statusCode = 401;
    throw err;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        const err = new Error("请求体过大");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function fetchWithTimeout(url, options = {}, label = "ClickUp") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`${label} 请求超时：${config.requestTimeoutMs}ms`);
    }
    throw new Error(`${label} 请求失败：${err.message || String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} 返回了非 JSON 响应：${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    const err = new Error(`${label} 请求失败：HTTP ${response.status}`);
    err.statusCode = response.status;
    err.details = sanitizeErrorPayload(payload);
    throw err;
  }

  return payload;
}

function sanitizeErrorPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  return JSON.parse(
    JSON.stringify(payload, (key, value) => {
      if (/token|jwt|cookie|secret|password/i.test(key)) return "[redacted]";
      return value;
    }),
  );
}

function mergeSetCookie(cookieHeader, setCookieHeaders) {
  const jar = new Map();
  for (const part of String(cookieHeader || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }

  for (const header of setCookieHeaders || []) {
    const first = String(header).split(";")[0];
    const index = first.indexOf("=");
    if (index > 0) jar.set(first.slice(0, index).trim(), first.slice(index + 1).trim());
  }

  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function updateCookieJar(response) {
  const setCookie = response.headers.getSetCookie?.() || [];
  if (setCookie.length) state.cookieHeader = mergeSetCookie(state.cookieHeader, setCookie);
}

async function refreshClickUpSession() {
  if (!state.cookieHeader) return;

  const response = await fetchWithTimeout(
    identityRefreshUrl(),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: state.cookieHeader,
      },
    },
    "ClickUp 登录续期",
  );
  updateCookieJar(response);
  await readJsonResponse(response, "ClickUp 登录续期");
}

async function fetchWorkspaceJwtFromCookie() {
  if (!state.cookieHeader) {
    throw new Error("缺少 CLICKUP_JWT 或 CLICKUP_AUTH_COOKIE 环境变量");
  }

  const response = await fetchWithTimeout(
    identityAccessTokenUrl(),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: state.cookieHeader,
      },
    },
    "ClickUp Workspace JWT",
  );
  updateCookieJar(response);

  if (response.status === 401 || response.status === 403) {
    await refreshClickUpSession();
    return fetchWorkspaceJwtFromCookie();
  }

  const payload = await readJsonResponse(response, "ClickUp Workspace JWT");
  if (!payload.token) throw new Error("ClickUp 没有返回 workspace JWT");

  state.workspaceJwt = payload.token;
  state.workspaceJwtExpiresAt =
    Number(payload.expiration || 0) * 1000 || decodeJwtExpiry(payload.token);
  return state.workspaceJwt;
}

async function getWorkspaceJwt() {
  if (state.workspaceJwt && isFresh(state.workspaceJwtExpiresAt)) {
    return state.workspaceJwt;
  }

  if (state.cookieHeader) {
    return fetchWorkspaceJwtFromCookie();
  }

  if (state.workspaceJwt) {
    throw new Error("CLICKUP_JWT 已过期，请更新；建议改用 CLICKUP_AUTH_COOKIE 自动续期");
  }

  throw new Error("缺少 CLICKUP_JWT 或 CLICKUP_AUTH_COOKIE 环境变量");
}

async function getFrontdoorToken() {
  if (state.frontdoorToken && isFresh(state.frontdoorTokenExpiresAt, 30)) {
    return state.frontdoorToken;
  }

  const workspaceJwt = await getWorkspaceJwt();
  const response = await fetchWithTimeout(
    frontdoorTokenUrl(),
    {
      headers: {
        authorization: `Bearer ${workspaceJwt}`,
      },
    },
    "ClickUp Frontdoor Token",
  );
  const payload = await readJsonResponse(response, "ClickUp Frontdoor Token");
  if (!payload.accessToken) throw new Error("ClickUp 没有返回 frontdoor accessToken");

  state.frontdoorToken = payload.accessToken;
  state.frontdoorTokenExpiresAt = Date.now() + Math.max(30, Number(payload.expiresIn || 300) - 20) * 1000;
  return state.frontdoorToken;
}

function buildAiQuery(message, selectedModel, includeKeywords = true) {
  const params = new URLSearchParams({
    shouldTriage: "false",
    createLink: "false",
    uiSurface: "ai_full_page",
    selectedModel,
  });
  if (includeKeywords) params.set("keywords", message);
  return `/?${params.toString()}`;
}

async function preloadAiResult(selectedModel) {
  const frontdoorToken = await getFrontdoorToken();
  const response = await fetchWithTimeout(
    `${config.graphqlHttpEndpoint}?q=PreloadAiResult`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${frontdoorToken}`,
      },
      body: JSON.stringify({
        operationName: "PreloadAiResult",
        query: PRELOAD_AI_RESULT_MUTATION,
        variables: {
          q: buildAiQuery("", selectedModel, false),
          conversationID: config.conversationId,
          retried: false,
        },
      }),
    },
    "ClickUp AI 预加载",
  );
  const payload = await readJsonResponse(response, "ClickUp AI 预加载");
  if (payload.errors?.length) {
    const message = payload.errors.map((item) => item.message).join("\n");
    throw new Error(`ClickUp AI 预加载失败：${message}`);
  }
  return payload.data?.preloadAiResult;
}

async function askClickUpAi(message, selectedModel) {
  if (!config.conversationId) throw new Error("缺少 CLICKUP_CONVERSATION_ID 环境变量");

  const frontdoorToken = await getFrontdoorToken();
  await preloadAiResult(selectedModel);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.graphqlWsEndpoint, "graphql-transport-ws");
    const startedAt = Date.now();
    let resolved = false;
    let subscribed = false;
    let answer = "";

    const finish = (err, text = answer) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(text);
    };

    const timer = setTimeout(() => {
      finish(new Error(`等待 ClickUp AI 回复超时：${config.timeoutMs}ms`));
    }, config.timeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "connection_init",
        payload: { authorization: `Bearer ${frontdoorToken}` },
      }));
    });

    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      if (frame.type === "connection_ack" && !subscribed) {
        subscribed = true;
        ws.send(JSON.stringify({
          id: randomUUID(),
          type: "subscribe",
          payload: {
            operationName: "AskAISubscription",
            query: ASK_AI_SUBSCRIPTION,
            variables: {
              q: buildAiQuery(message, selectedModel, true),
              conversationID: config.conversationId,
              jwt: frontdoorToken,
              retried: false,
              selectedItems: "[]",
              triggeredAtMs: String(startedAt),
            },
            extensions: {
              queryId: "62e02a3a-a349-4792-bb84-71890e4f6300",
            },
          },
        }));
        return;
      }

      if (frame.type === "next") {
        const result = frame.payload?.data?.aiResult;
        if (typeof result?.answerChunk === "string") answer += result.answerChunk;
        if (result?.answerComplete) finish(null);
        return;
      }

      if (frame.type === "complete") {
        finish(null);
        return;
      }

      if (frame.type === "error") {
        const err = new Error(`ClickUp AI WebSocket 错误：${JSON.stringify(sanitizeErrorPayload(frame.payload)).slice(0, 500)}`);
        err.statusCode = 502;
        finish(err);
      }
    });

    ws.on("error", (err) => {
      finish(new Error(`ClickUp AI WebSocket 连接失败：${err.message || String(err)}`));
    });

    ws.on("close", () => {
      if (!resolved && answer) finish(null);
      if (!resolved) finish(new Error("ClickUp AI WebSocket 提前关闭"));
    });
  });
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    const err = new Error("messages 必须是非空数组");
    err.statusCode = 400;
    throw err;
  }

  const prompt = messages
    .map((message) => {
      const role = message.role || "user";
      const content = normalizeContent(message.content).trim();
      return content ? `${role.toUpperCase()}:\n${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (!prompt) {
    const err = new Error("messages 没有可发送的文本内容");
    err.statusCode = 400;
    throw err;
  }

  return prompt;
}

function modelAliases(model) {
  return [
    model.id,
    slugModel(model.id),
    model.selectedModel,
  ].map((item) => String(item || "").toLowerCase());
}

function resolveRequestedModel(requestedModel) {
  const wanted = String(requestedModel || config.defaultModel || config.models[0].id).toLowerCase();
  return (
    config.models.find((model) => modelAliases(model).includes(wanted)) ||
    config.models[0]
  );
}

function openAiModelPayload() {
  return {
    object: "list",
    data: config.models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: config.modelOwner,
      clickup: {
        selected_model: model.selectedModel,
      },
    })),
  };
}

async function handleReady(_req, res) {
  const frontdoorToken = await getFrontdoorToken();
  jsonResponse(res, 200, {
    ok: true,
    service: "overview2api",
    clickup: {
      workspace_id: config.workspaceId,
      conversation_id: config.conversationId,
      graphql_http_endpoint: config.graphqlHttpEndpoint,
      graphql_ws_endpoint: config.graphqlWsEndpoint,
      frontdoor_token_cached: Boolean(frontdoorToken),
      frontdoor_token_expires_at: state.frontdoorTokenExpiresAt
        ? new Date(state.frontdoorTokenExpiresAt).toISOString()
        : null,
    },
  });
}

function writeOpenAiStream(res, id, model, created, text) {
  res.writeHead(200, {
    ...corsHeaders(),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  res.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  })}\n\n`);

  res.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function handleChatCompletions(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    const err = new Error("请求体不是合法 JSON");
    err.statusCode = 400;
    throw err;
  }

  const selectedModel = resolveRequestedModel(body.model);
  const prompt = normalizeMessages(body.messages);
  const text = await askClickUpAi(prompt, selectedModel.selectedModel);
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    writeOpenAiStream(res, id, selectedModel.id, created, text);
    return;
  }

  jsonResponse(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: selectedModel.id,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      jsonResponse(res, 200, {
        ok: true,
        service: "overview2api",
        mode: "openai-compatible-chat",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/ready") {
      assertAuthorized(req);
      await handleReady(req, res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      assertAuthorized(req);
      jsonResponse(res, 200, openAiModelPayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      assertAuthorized(req);
      await handleChatCompletions(req, res);
      return;
    }

    errorResponse(res, 404, "接口不存在");
  } catch (err) {
    const statusCode = err.statusCode && err.statusCode < 600 ? err.statusCode : 500;
    errorResponse(res, statusCode, err.message || "服务异常", err.details);
  }
}

function createServer() {
  return http.createServer(handleRequest);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const server = createServer();
  server.listen(config.port, () => {
    console.log(`overview2api listening on :${config.port}`);
  });
}

export {
  DEFAULT_MODELS,
  buildAiQuery,
  createServer,
  decodeJwtExpiry,
  mergeSetCookie,
  normalizeContent,
  normalizeMessages,
  parseModels,
  resolveRequestedModel,
  slugModel,
};
