import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  adminKey: process.env.ADMIN_KEY || process.env.API_KEY || "",
  accountStorePath: process.env.ACCOUNTS_FILE || "./data/accounts.json",
  workspaceId: process.env.CLICKUP_WORKSPACE_ID || "90141378436",
  conversationId: process.env.CLICKUP_CONVERSATION_ID || "",
  authCookie: process.env.CLICKUP_AUTH_COOKIE || "",
  clickupJwt: process.env.CLICKUP_JWT || "",
  defaultModel: process.env.CLICKUP_DEFAULT_MODEL || "Brain² Max",
  modelOwner: process.env.MODEL_OWNER || "clickup",
  timeoutMs: toPositiveInt(process.env.CLICKUP_TIMEOUT_MS, 120000),
  requestTimeoutMs: toPositiveInt(process.env.CLICKUP_REQUEST_TIMEOUT_MS, 30000),
  refreshSkewSeconds: toPositiveInt(process.env.CLICKUP_TOKEN_REFRESH_SKEW_SECONDS, 60),
  accountCooldownMs: toPositiveInt(process.env.CLICKUP_ACCOUNT_COOLDOWN_MS, 900000),
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

const accountState = {
  loaded: false,
  accounts: [],
  rrIndex: 0,
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
      return { id, selectedModel: selectedModel || slugModel(id) };
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

function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (key === name) return part.slice(index + 1).trim();
  }
  return "";
}

function isFresh(expiresAt, skewSeconds = config.refreshSkewSeconds) {
  return expiresAt && Date.now() + skewSeconds * 1000 < expiresAt;
}

function normalizeAccount(input = {}, index = 0, source = "file") {
  const id = String(input.id || input.name || `account-${index + 1}`).trim();
  return {
    id,
    name: String(input.name || id).trim(),
    enabled: input.enabled !== false,
    workspaceId: String(input.workspaceId || input.workspace_id || config.workspaceId).trim(),
    conversationId: String(
      input.conversationId || input.conversation_id || config.conversationId,
    ).trim(),
    authCookie: String(input.authCookie || input.auth_cookie || "").trim(),
    clickupJwt: String(input.clickupJwt || input.clickup_jwt || "").trim(),
    source,
    runtime: {
      workspaceJwt: String(input.clickupJwt || input.clickup_jwt || "").trim(),
      workspaceJwtExpiresAt: decodeJwtExpiry(input.clickupJwt || input.clickup_jwt || ""),
      frontdoorToken: "",
      frontdoorTokenExpiresAt: 0,
      requestCount: Number(input.requestCount || 0),
      failureCount: Number(input.failureCount || 0),
      lastUsedAt: Number(input.lastUsedAt || 0),
      disabledUntil: Number(input.disabledUntil || 0),
      lastError: String(input.lastError || ""),
    },
  };
}

function serializeAccount(account) {
  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    workspaceId: account.workspaceId,
    conversationId: account.conversationId,
    authCookie: account.authCookie,
    clickupJwt: account.clickupJwt,
    requestCount: account.runtime.requestCount,
    failureCount: account.runtime.failureCount,
    lastUsedAt: account.runtime.lastUsedAt,
    disabledUntil: account.runtime.disabledUntil,
    lastError: account.runtime.lastError,
  };
}

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    workspaceId: account.workspaceId,
    conversationId: account.conversationId,
    hasAuthCookie: Boolean(account.authCookie),
    hasClickupJwt: Boolean(account.clickupJwt || account.runtime.workspaceJwt),
    source: account.source,
    requestCount: account.runtime.requestCount,
    failureCount: account.runtime.failureCount,
    lastUsedAt: account.runtime.lastUsedAt || null,
    disabledUntil: account.runtime.disabledUntil || null,
    lastError: account.runtime.lastError || "",
    frontdoorTokenExpiresAt: account.runtime.frontdoorTokenExpiresAt || null,
  };
}

function envAccounts() {
  const accounts = [];
  if (process.env.CLICKUP_ACCOUNTS_JSON) {
    try {
      const parsed = JSON.parse(process.env.CLICKUP_ACCOUNTS_JSON);
      if (Array.isArray(parsed)) {
        parsed.forEach((item, index) => accounts.push(normalizeAccount(item, index, "env")));
      }
    } catch {
      // 启动时不因为 JSON 写错直接崩，管理页会显示单账号配置。
    }
  }

  if (config.authCookie || config.clickupJwt || config.conversationId) {
    accounts.push(normalizeAccount({
      id: "default",
      name: "默认账号",
      workspaceId: config.workspaceId,
      conversationId: config.conversationId,
      authCookie: config.authCookie,
      clickupJwt: config.clickupJwt,
      enabled: true,
    }, accounts.length, "env"));
  }

  return accounts;
}

async function loadStoredAccounts() {
  try {
    const text = await readFile(config.accountStorePath, "utf8");
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.accounts;
    return Array.isArray(rows)
      ? rows.map((item, index) => normalizeAccount(item, index, "file"))
      : [];
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function ensureAccountsLoaded() {
  if (accountState.loaded) return accountState.accounts;

  const stored = await loadStoredAccounts();
  const env = envAccounts();
  const merged = new Map();
  for (const account of env) merged.set(account.id, account);
  for (const account of stored) merged.set(account.id, account);
  accountState.accounts = [...merged.values()];
  accountState.loaded = true;
  return accountState.accounts;
}

async function persistFileAccounts() {
  const fileAccounts = accountState.accounts
    .filter((account) => account.source !== "env")
    .map(serializeAccount);
  await mkdir(dirname(config.accountStorePath), { recursive: true });
  await writeFile(
    config.accountStorePath,
    `${JSON.stringify({ accounts: fileAccounts }, null, 2)}\n`,
    "utf8",
  );
}

async function upsertAccount(input) {
  await ensureAccountsLoaded();
  const normalized = normalizeAccount(input, 0, "file");
  const index = accountState.accounts.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    const old = accountState.accounts[index];
    accountState.accounts[index] = {
      ...old,
      ...normalized,
      authCookie: normalized.authCookie || old.authCookie,
      clickupJwt: normalized.clickupJwt || old.clickupJwt,
      source: old.source === "env" ? "file" : old.source,
      runtime: {
        ...old.runtime,
        workspaceJwt: normalized.clickupJwt || old.runtime.workspaceJwt,
        workspaceJwtExpiresAt: normalized.clickupJwt
          ? decodeJwtExpiry(normalized.clickupJwt)
          : old.runtime.workspaceJwtExpiresAt,
      },
    };
  } else {
    accountState.accounts.push(normalized);
  }
  await persistFileAccounts();
  return accountState.accounts.find((item) => item.id === normalized.id);
}

async function deleteAccount(id) {
  await ensureAccountsLoaded();
  const index = accountState.accounts.findIndex((account) => account.id === id);
  if (index < 0) return false;
  accountState.accounts.splice(index, 1);
  await persistFileAccounts();
  return true;
}

function identityAccessTokenUrl(account) {
  return `${config.identityBaseUrl}/data/v3/workspaces/${account.workspaceId}/authentication/access_tokens?trigger_source=overview2api`;
}

function identityRefreshUrl() {
  return `${config.identityBaseUrl}/auth/v1/refresh_token`;
}

function frontdoorTokenUrl(account) {
  return config.frontdoorTokenUrl.replace("{workspaceId}", encodeURIComponent(account.workspaceId));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
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

function htmlResponse(res, body) {
  res.writeHead(200, {
    ...corsHeaders(),
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
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

function assertBearer(req, expected, label = "API Key") {
  if (!expected) return;
  const header = req.headers.authorization || "";
  if (header !== `Bearer ${expected}` && header !== expected) {
    const err = new Error(`${label} 不正确`);
    err.statusCode = 401;
    throw err;
  }
}

function assertAuthorized(req) {
  assertBearer(req, config.apiKey, "API Key");
}

function assertAdminAuthorized(req) {
  assertBearer(req, config.adminKey, "Admin Key");
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

async function readJsonBody(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const err = new Error("请求体不是合法 JSON");
    err.statusCode = 400;
    throw err;
  }
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

async function updateCookieJar(account, response) {
  const setCookie = response.headers.getSetCookie?.() || [];
  if (!setCookie.length) return;
  account.authCookie = mergeSetCookie(account.authCookie, setCookie);
  if (account.source !== "env") await persistFileAccounts();
}

async function refreshClickUpSession(account) {
  if (!account.authCookie) return;

  const response = await fetchWithTimeout(
    identityRefreshUrl(),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: account.authCookie,
      },
    },
    `${account.name} 登录续期`,
  );
  await updateCookieJar(account, response);
  await readJsonResponse(response, `${account.name} 登录续期`);
}

async function fetchWorkspaceJwtFromCookie(account, retried = false) {
  if (!account.authCookie) {
    throw new Error(`${account.name} 缺少 authCookie 或 clickupJwt`);
  }

  const response = await fetchWithTimeout(
    identityAccessTokenUrl(account),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: account.authCookie,
      },
    },
    `${account.name} Workspace JWT`,
  );
  await updateCookieJar(account, response);

  if ((response.status === 401 || response.status === 403) && !retried) {
    await refreshClickUpSession(account);
    return fetchWorkspaceJwtFromCookie(account, true);
  }

  const payload = await readJsonResponse(response, `${account.name} Workspace JWT`);
  if (!payload.token) throw new Error(`${account.name} 没有返回 workspace JWT`);

  account.runtime.workspaceJwt = payload.token;
  account.runtime.workspaceJwtExpiresAt =
    Number(payload.expiration || 0) * 1000 || decodeJwtExpiry(payload.token);
  return account.runtime.workspaceJwt;
}

async function getWorkspaceJwt(account) {
  if (account.runtime.workspaceJwt && isFresh(account.runtime.workspaceJwtExpiresAt)) {
    return account.runtime.workspaceJwt;
  }

  const cookieJwt = cookieValue(account.authCookie, "cu_jwt");
  const cookieJwtExpiresAt = decodeJwtExpiry(cookieJwt);
  if (cookieJwt && isFresh(cookieJwtExpiresAt)) {
    account.runtime.workspaceJwt = cookieJwt;
    account.runtime.workspaceJwtExpiresAt = cookieJwtExpiresAt;
    return account.runtime.workspaceJwt;
  }

  if (account.authCookie) return fetchWorkspaceJwtFromCookie(account);

  if (account.clickupJwt) {
    account.runtime.workspaceJwt = account.clickupJwt;
    account.runtime.workspaceJwtExpiresAt = decodeJwtExpiry(account.clickupJwt);
    if (isFresh(account.runtime.workspaceJwtExpiresAt)) return account.runtime.workspaceJwt;
    throw new Error(`${account.name} 的 clickupJwt 已过期`);
  }

  throw new Error(`${account.name} 缺少 authCookie 或 clickupJwt`);
}

async function getFrontdoorToken(account) {
  if (account.runtime.frontdoorToken && isFresh(account.runtime.frontdoorTokenExpiresAt, 30)) {
    return account.runtime.frontdoorToken;
  }

  const workspaceJwt = await getWorkspaceJwt(account);
  const response = await fetchWithTimeout(
    frontdoorTokenUrl(account),
    {
      headers: {
        authorization: `Bearer ${workspaceJwt}`,
      },
    },
    `${account.name} Frontdoor Token`,
  );
  const payload = await readJsonResponse(response, `${account.name} Frontdoor Token`);
  if (!payload.accessToken) throw new Error(`${account.name} 没有返回 frontdoor accessToken`);

  account.runtime.frontdoorToken = payload.accessToken;
  account.runtime.frontdoorTokenExpiresAt =
    Date.now() + Math.max(30, Number(payload.expiresIn || 300) - 20) * 1000;
  return account.runtime.frontdoorToken;
}

function markAccountSuccess(account) {
  account.runtime.requestCount += 1;
  account.runtime.lastUsedAt = Date.now();
  account.runtime.lastError = "";
}

function markAccountFailure(account, err) {
  account.runtime.failureCount += 1;
  account.runtime.lastError = err.message || String(err);
  account.runtime.disabledUntil = Date.now() + config.accountCooldownMs;
}

async function selectAccount(preferredAccountId = "") {
  const accounts = await ensureAccountsLoaded();
  const now = Date.now();
  const enabled = accounts.filter((account) => {
    return (
      account.enabled &&
      account.workspaceId &&
      account.conversationId &&
      (account.authCookie || account.clickupJwt || account.runtime.workspaceJwt) &&
      (!account.runtime.disabledUntil || account.runtime.disabledUntil <= now)
    );
  });

  if (!enabled.length) {
    throw new Error("没有可用 ClickUp 账号，请在 /admin 添加或修复账号凭据");
  }

  if (preferredAccountId) {
    const preferred = enabled.find((account) => account.id === preferredAccountId);
    if (preferred) return preferred;
  }

  const selected = enabled[accountState.rrIndex % enabled.length];
  accountState.rrIndex += 1;
  return selected;
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

async function preloadAiResult(account, selectedModel) {
  const frontdoorToken = await getFrontdoorToken(account);
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
          conversationID: account.conversationId,
          retried: false,
        },
      }),
    },
    `${account.name} AI 预加载`,
  );
  const payload = await readJsonResponse(response, `${account.name} AI 预加载`);
  if (payload.errors?.length) {
    const message = payload.errors.map((item) => item.message).join("\n");
    throw new Error(`${account.name} AI 预加载失败：${message}`);
  }
  return payload.data?.preloadAiResult;
}

async function askClickUpAiWithAccount(account, message, selectedModel) {
  if (!account.conversationId) throw new Error(`${account.name} 缺少 conversationId`);

  const frontdoorToken = await getFrontdoorToken(account);
  await preloadAiResult(account, selectedModel);

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
      finish(new Error(`等待 ${account.name} 回复超时：${config.timeoutMs}ms`));
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
              conversationID: account.conversationId,
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
        const err = new Error(
          `${account.name} WebSocket 错误：${JSON.stringify(sanitizeErrorPayload(frame.payload)).slice(0, 500)}`,
        );
        err.statusCode = 502;
        finish(err);
      }
    });

    ws.on("error", (err) => {
      finish(new Error(`${account.name} WebSocket 连接失败：${err.message || String(err)}`));
    });

    ws.on("close", () => {
      if (!resolved && answer) finish(null);
      if (!resolved) finish(new Error(`${account.name} WebSocket 提前关闭`));
    });
  });
}

async function askClickUpAi(message, selectedModel, preferredAccountId = "") {
  const tried = new Set();
  const errors = [];
  const accounts = await ensureAccountsLoaded();
  const maxAttempts = Math.max(1, accounts.length);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = await selectAccount(attempt === 0 ? preferredAccountId : "");
    if (tried.has(account.id)) continue;
    tried.add(account.id);

    try {
      const text = await askClickUpAiWithAccount(account, message, selectedModel);
      markAccountSuccess(account);
      return { text, account };
    } catch (err) {
      markAccountFailure(account, err);
      errors.push(`${account.name}: ${err.message || String(err)}`);
    }
  }

  const err = new Error(`所有 ClickUp 账号都调用失败：${errors.join(" | ")}`);
  err.statusCode = 502;
  throw err;
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
  return [model.id, slugModel(model.id), model.selectedModel].map((item) =>
    String(item || "").toLowerCase(),
  );
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
      clickup: { selected_model: model.selectedModel },
    })),
  };
}

async function handleReady(_req, res) {
  const accounts = await ensureAccountsLoaded();
  jsonResponse(res, 200, {
    ok: accounts.some((account) => account.enabled && (account.authCookie || account.clickupJwt)),
    service: "overview2api",
    accounts: accounts.map(publicAccount),
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
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
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
  const body = await readJsonBody(req);
  const selectedModel = resolveRequestedModel(body.model);
  const prompt = normalizeMessages(body.messages);
  const preferredAccountId =
    body.clickup_account_id ||
    body.account_id ||
    req.headers["x-clickup-account"] ||
    "";
  const result = await askClickUpAi(prompt, selectedModel.selectedModel, preferredAccountId);
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    writeOpenAiStream(res, id, selectedModel.id, created, result.text);
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
        message: { role: "assistant", content: result.text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    clickup: { account_id: result.account.id, account_name: result.account.name },
  });
}

async function handleAdminAccounts(req, res, url) {
  assertAdminAuthorized(req);
  const accounts = await ensureAccountsLoaded();

  if (req.method === "GET") {
    jsonResponse(res, 200, { accounts: accounts.map(publicAccount) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/api/accounts") {
    const body = await readJsonBody(req);
    const account = await upsertAccount(body);
    jsonResponse(res, 200, { account: publicAccount(account) });
    return;
  }

  const match = url.pathname.match(/^\/admin\/api\/accounts\/([^/]+)(?:\/(test))?$/);
  if (!match) {
    errorResponse(res, 404, "账号接口不存在");
    return;
  }

  const id = decodeURIComponent(match[1]);
  const action = match[2];
  const account = accounts.find((item) => item.id === id);
  if (!account) {
    errorResponse(res, 404, "账号不存在");
    return;
  }

  if (req.method === "POST" && action === "test") {
    const frontdoorToken = await getFrontdoorToken(account);
    account.runtime.lastError = "";
    jsonResponse(res, 200, {
      ok: true,
      account: publicAccount(account),
      frontdoorTokenCached: Boolean(frontdoorToken),
    });
    return;
  }

  if (req.method === "DELETE" && !action) {
    await deleteAccount(id);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  errorResponse(res, 405, "不支持的账号操作");
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

    if (req.method === "GET" && url.pathname === "/admin") {
      htmlResponse(res, ADMIN_HTML);
      return;
    }

    if (url.pathname.startsWith("/admin/api/accounts")) {
      await handleAdminAccounts(req, res, url);
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

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>overview2api 账号池</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f4; --ink:#1e2524; --muted:#68706f; --line:#d8ddd8; --accent:#147a63; --bad:#b42318; --warn:#9a6700; --panel:#ffffff; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family: "Segoe UI", "Microsoft YaHei", sans-serif; letter-spacing:0; }
    .shell { display:grid; grid-template-columns: 300px 1fr; min-height:100vh; }
    aside { border-right:1px solid var(--line); padding:28px 24px; background:#eef2ed; }
    main { padding:28px; max-width:1180px; width:100%; }
    h1 { margin:0 0 8px; font-size:28px; font-weight:750; }
    h2 { margin:0 0 14px; font-size:18px; }
    p { color:var(--muted); line-height:1.6; margin:0 0 16px; }
    .keybox { margin-top:24px; display:grid; gap:10px; }
    input, textarea { width:100%; border:1px solid var(--line); border-radius:6px; background:#fff; padding:11px 12px; font:inherit; letter-spacing:0; }
    textarea { min-height:112px; resize:vertical; font-family: ui-monospace, Consolas, monospace; font-size:13px; }
    label { display:block; font-size:13px; color:var(--muted); margin:12px 0 6px; }
    button { border:1px solid var(--line); border-radius:6px; background:#fff; padding:10px 13px; font:inherit; cursor:pointer; }
    button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
    button.danger { color:var(--bad); }
    .toolbar { display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:18px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap:14px; }
    .account { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; display:grid; gap:12px; }
    .row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .name { font-weight:700; font-size:17px; overflow-wrap:anywhere; }
    .pill { border-radius:999px; padding:4px 9px; font-size:12px; background:#e8f3ef; color:var(--accent); white-space:nowrap; }
    .pill.bad { background:#fff0ee; color:var(--bad); }
    .meta { display:grid; gap:6px; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    .editor { margin-top:18px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; }
    .formgrid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:8px 14px; }
    .wide { grid-column:1 / -1; }
    .status { margin-top:14px; color:var(--muted); min-height:22px; }
    code { background:#e9eee9; border-radius:4px; padding:2px 5px; }
    @media (max-width: 820px) { .shell { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } main { padding:18px; } .formgrid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>账号池</h1>
      <p>一个 OpenAI 兼容入口，背后自动轮询多个 ClickUp 账号。失败账号会临时冷却，避免一直打同一个坏凭据。</p>
      <div class="keybox">
        <label>Admin Key / API Key</label>
        <input id="adminKey" type="password" placeholder="填 Zeabur 里的 ADMIN_KEY 或 API_KEY">
        <button class="primary" onclick="loadAccounts()">连接管理页</button>
      </div>
      <p style="margin-top:22px">Cookie 不会展示回页面；保存后只显示是否已填写。建议给 Zeabur 挂载 <code>/app/data</code> 或设置 <code>ACCOUNTS_FILE</code> 到持久化目录。</p>
    </aside>
    <main>
      <div class="toolbar">
        <div>
          <h2>ClickUp 账号</h2>
          <p>粘贴每个账号自己的 Cookie 或短期 JWT，点击测试确认可换发 frontdoor token。</p>
        </div>
        <button onclick="resetForm()">新增账号</button>
      </div>
      <div id="accounts" class="grid"></div>
      <section class="editor">
        <h2>账号配置</h2>
        <div class="formgrid">
          <div><label>ID</label><input id="id" placeholder="account-1"></div>
          <div><label>名称</label><input id="name" placeholder="主账号 / 小号 A"></div>
          <div><label>Workspace ID</label><input id="workspaceId" value="90141378436"></div>
          <div><label>Conversation ID</label><input id="conversationId" value="4002128792162479189"></div>
          <div class="wide"><label>Auth Cookie</label><textarea id="authCookie" placeholder="只粘贴 Cookie: 后面的值，不要包含 Cookie:"></textarea></div>
          <div class="wide"><label>ClickUp JWT（备选，约 48 小时过期）</label><textarea id="clickupJwt" placeholder="access_tokens 响应里的 token 字段"></textarea></div>
        </div>
        <div class="actions" style="margin-top:14px">
          <button class="primary" onclick="saveAccount()">保存账号</button>
          <button onclick="testCurrent()">保存并测试</button>
        </div>
        <div id="status" class="status"></div>
      </section>
    </main>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    const auth = () => ({ authorization: 'Bearer ' + $('adminKey').value.trim(), 'content-type': 'application/json' });
    function setStatus(text, bad=false) { $('status').textContent = text; $('status').style.color = bad ? 'var(--bad)' : 'var(--muted)'; }
    async function api(path, options={}) {
      const res = await fetch(path, { ...options, headers: { ...auth(), ...(options.headers || {}) } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error?.message || '请求失败');
      return body;
    }
    function resetForm() { ['id','name','authCookie','clickupJwt'].forEach(id => $(id).value=''); $('workspaceId').value='90141378436'; $('conversationId').value='4002128792162479189'; setStatus(''); }
    function editAccount(a) {
      $('id').value = a.id; $('name').value = a.name; $('workspaceId').value = a.workspaceId; $('conversationId').value = a.conversationId;
      $('authCookie').value = ''; $('clickupJwt').value = ''; setStatus('编辑已有账号：密钥留空表示沿用已保存值。');
    }
    async function loadAccounts() {
      try {
        const data = await api('/admin/api/accounts');
        $('accounts').innerHTML = data.accounts.map(a => '<article class="account"><div class="row"><div class="name">'+escapeHtml(a.name)+'</div><span class="pill '+(a.enabled?'':'bad')+'">'+(a.enabled?'启用':'停用')+'</span></div><div class="meta"><div>ID: '+escapeHtml(a.id)+'</div><div>Workspace: '+escapeHtml(a.workspaceId)+'</div><div>Conversation: '+escapeHtml(a.conversationId)+'</div><div>Cookie: '+(a.hasAuthCookie?'已填写':'未填写')+' / JWT: '+(a.hasClickupJwt?'已填写':'未填写')+'</div><div>调用: '+a.requestCount+' / 失败: '+a.failureCount+'</div><div>错误: '+escapeHtml(a.lastError || '无')+'</div></div><div class="actions"><button onclick=\\'editById(\"'+escapeAttr(a.id)+'\")\\'>编辑</button><button onclick=\\'testAccount(\"'+escapeAttr(a.id)+'\")\\'>测试</button><button class="danger" onclick=\\'deleteAccount(\"'+escapeAttr(a.id)+'\")\\'>删除</button></div></article>').join('');
        window.__accounts = data.accounts; setStatus('账号列表已刷新。');
      } catch (e) { setStatus(e.message, true); }
    }
    function editById(id) { const a = (window.__accounts || []).find(x => x.id === id); if (a) editAccount(a); }
    function payload() { return { id:$('id').value.trim(), name:$('name').value.trim(), workspaceId:$('workspaceId').value.trim(), conversationId:$('conversationId').value.trim(), authCookie:$('authCookie').value.trim(), clickupJwt:$('clickupJwt').value.trim(), enabled:true }; }
    async function saveAccount() { try { await api('/admin/api/accounts', { method:'POST', body:JSON.stringify(payload()) }); setStatus('已保存。'); await loadAccounts(); } catch(e) { setStatus(e.message, true); } }
    async function testCurrent() { try { const saved = await api('/admin/api/accounts', { method:'POST', body:JSON.stringify(payload()) }); await testAccount(saved.account.id); } catch(e) { setStatus(e.message, true); } }
    async function testAccount(id) { try { setStatus('正在测试 '+id+' ...'); await api('/admin/api/accounts/'+encodeURIComponent(id)+'/test', { method:'POST', body:'{}' }); setStatus('测试通过：可以换发 ClickUp frontdoor token。'); await loadAccounts(); } catch(e) { setStatus(e.message, true); await loadAccounts().catch(()=>{}); } }
    async function deleteAccount(id) { if (!confirm('删除账号 '+id+'？')) return; try { await api('/admin/api/accounts/'+encodeURIComponent(id), { method:'DELETE' }); await loadAccounts(); } catch(e) { setStatus(e.message, true); } }
    function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
  </script>
</body>
</html>`;

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
  cookieValue,
  decodeJwtExpiry,
  mergeSetCookie,
  normalizeAccount,
  normalizeContent,
  normalizeMessages,
  parseModels,
  publicAccount,
  resolveRequestedModel,
  slugModel,
};
