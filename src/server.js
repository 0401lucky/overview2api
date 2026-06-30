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
  <title>overview2api — 账号池管理</title>
  <style>
    :root {
      --bg: #f6f7f4;
      --surface: #ffffff;
      --sidebar-bg: #eef2ed;
      --sidebar-ink: #1e2524;
      --sidebar-muted: #5a6b65;
      --sidebar-border: #d5ddd6;
      --ink: #1e2524;
      --ink-secondary: #3d4a45;
      --muted: #68706f;
      --border: #d8ddd8;
      --border-light: #eef2ed;
      --primary: #147a63;
      --primary-hover: #0f5f4d;
      --primary-light: #e8f3ef;
      --success: #147a63;
      --success-light: #e8f3ef;
      --danger: #b42318;
      --danger-hover: #991b13;
      --danger-light: #fff0ee;
      --warning: #9a6700;
      --warning-light: #fef9ee;
      --radius: 10px;
      --radius-sm: 6px;
      --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.04);
      --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06);
      --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.06), 0 2px 4px -2px rgb(0 0 0 / 0.06);
      --transition: 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    * { box-sizing: border-box; margin: 0; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: "Inter", "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    /* ── 布局 ── */
    .shell { display: grid; grid-template-columns: 280px 1fr; min-height: 100vh; }
    /* ── 侧边栏 ── */
    aside {
      background: var(--sidebar-bg);
      color: var(--sidebar-ink);
      padding: 32px 24px;
      display: flex;
      flex-direction: column;
      gap: 28px;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      border-right: 1px solid var(--sidebar-border);
    }
    aside .brand { display: flex; align-items: center; gap: 10px; }
    aside .brand .logo {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #147a63, #38a885);
      border-radius: var(--radius-sm);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; font-weight: 700;
      color: #fff;
    }
    aside h1 { font-size: 20px; font-weight: 750; letter-spacing: -0.3px; }
    aside .desc { font-size: 13px; color: var(--sidebar-muted); line-height: 1.7; }
    aside .keybox { display: flex; flex-direction: column; gap: 10px; }
    aside .keybox label { font-size: 12px; font-weight: 600; color: var(--sidebar-muted); }
    aside .keybox .input-row { display: flex; gap: 0; }
    aside .keybox input {
      flex: 1;
      border: 1px solid var(--sidebar-border);
      border-radius: var(--radius-sm) 0 0 var(--radius-sm);
      background: #fff;
      color: var(--ink);
      padding: 10px 12px;
      font-size: 13px;
      font-family: "SF Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace;
      outline: none;
      transition: border var(--transition), box-shadow var(--transition);
    }
    aside .keybox input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgb(20 122 99 / 0.1); }
    aside .keybox input::placeholder { color: #9aada6; }
    aside .keybox .connect-btn {
      border: 1px solid var(--sidebar-border);
      border-left: none;
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      background: var(--primary);
      color: #fff;
      padding: 10px 14px;
      cursor: pointer;
      font-size: 15px;
      display: flex; align-items: center;
      transition: background var(--transition);
    }
    aside .keybox .connect-btn:hover { background: var(--primary-hover); }
    aside .footer { margin-top: auto; font-size: 12px; color: var(--sidebar-muted); padding-top: 20px; border-top: 1px solid var(--sidebar-border); }
    aside .footer code { background: #dce6e0; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
    /* ── 主内容区 ── */
    main { padding: 32px 36px; max-width: 1200px; width: 100%; }
    .page-header { margin-bottom: 28px; }
    .page-header h2 { font-size: 24px; font-weight: 700; letter-spacing: -0.3px; margin-bottom: 6px; }
    .page-header p { color: var(--muted); font-size: 14px; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 22px; flex-wrap: wrap; }
    .stats { display: flex; gap: 16px; font-size: 13px; color: var(--muted); }
    .stats strong { color: var(--ink); }
    /* ── 按钮 ── */
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 8px 16px;
      font-size: 13px; font-weight: 500;
      cursor: pointer;
      background: var(--surface);
      color: var(--ink);
      transition: all var(--transition);
      white-space: nowrap;
      font-family: inherit;
    }
    .btn:hover { background: #f5f8f6; border-color: #bcc7c1; }
    .btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
    .btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
    .btn-danger { color: var(--danger); border-color: transparent; background: transparent; }
    .btn-danger:hover { background: var(--danger-light); color: var(--danger-hover); }
    .btn-ghost { border-color: transparent; background: transparent; color: var(--muted); }
    .btn-ghost:hover { background: #eef2ed; color: var(--ink); }
    .btn-sm { padding: 5px 10px; font-size: 12px; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    /* ── 账号卡片网格 ── */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .grid:empty::after {
      content: "暂无账号，点击「新增账号」添加第一个";
      display: block;
      padding: 64px 16px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
      grid-column: 1 / -1;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      display: flex; flex-direction: column; gap: 14px;
      box-shadow: var(--shadow-sm);
      transition: box-shadow var(--transition), border-color var(--transition);
    }
    .card:hover { box-shadow: var(--shadow); border-color: #bcc7c1; }
    .card-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .card-title { font-weight: 700; font-size: 16px; overflow-wrap: anywhere; }
    .badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 10px; border-radius: 999px;
      font-size: 12px; font-weight: 600;
      white-space: nowrap;
    }
    .badge-success { background: var(--success-light); color: #059669; }
    .badge-danger { background: var(--danger-light); color: #dc2626; }
    .badge-warning { background: var(--warning-light); color: #d97706; }
    .badge .dot { width: 6px; height: 6px; border-radius: 50%; }
    .badge-success .dot { background: var(--success); }
    .badge-danger .dot { background: var(--danger); }
    .badge-warning .dot { background: var(--warning); }
    .card-body { display: flex; flex-direction: column; gap: 8px; }
    .info-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 13px; }
    .info-label { color: var(--muted); flex-shrink: 0; }
    .info-value { color: var(--ink-secondary); text-align: right; overflow-wrap: anywhere; font-family: ui-monospace, "SF Mono", "Cascadia Code", monospace; font-size: 12px; }
    .cred-badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .cred-badge {
      font-size: 11px; padding: 2px 8px; border-radius: 999px;
      border: 1px solid var(--border); color: var(--muted);
    }
    .cred-badge.ok { border-color: #a7f3d0; color: #059669; background: #ecfdf5; }
    .cred-badge.missing { border-color: #fecaca; color: #dc2626; background: #fef2f2; }
    .card-footer { display: flex; gap: 8px; flex-wrap: wrap; }
    .error-preview { font-size: 12px; color: var(--danger); background: var(--danger-light); padding: 8px 10px; border-radius: var(--radius-sm); overflow-wrap: anywhere; max-height: 48px; overflow: hidden; }
    /* ── 编辑器 ── */
    .editor {
      margin-top: 28px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      box-shadow: var(--shadow-sm);
    }
    .editor h3 { font-size: 17px; font-weight: 700; margin-bottom: 18px; }
    .formgrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
    .formgrid .wide { grid-column: 1 / -1; }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field label { font-size: 12px; font-weight: 600; color: var(--ink-secondary); text-transform: uppercase; letter-spacing: 0.3px; }
    .field input, .field textarea {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 9px 12px;
      font-size: 14px;
      font-family: inherit;
      background: #fafbfc;
      transition: border var(--transition), box-shadow var(--transition);
      outline: none;
    }
    .field input:focus, .field textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgb(20 122 99 / 0.1); background: #fff; }
    .field textarea { min-height: 100px; resize: vertical; font-family: "SF Mono", "Fira Code", ui-monospace, monospace; font-size: 13px; }
    .field input::placeholder, .field textarea::placeholder { color: #94a3b8; }
    .editor-actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
    /* ── Toast 通知 ── */
    .toast-container { position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .toast {
      pointer-events: auto;
      padding: 12px 18px;
      border-radius: var(--radius-sm);
      font-size: 13px; font-weight: 500;
      box-shadow: var(--shadow-md);
      animation: slideIn 0.25s ease-out;
      max-width: 380px;
      display: flex; align-items: center; gap: 10px;
    }
    .toast-success { background: #147a63; color: #fff; }
    .toast-error { background: #b42318; color: #fff; }
    .toast-info { background: #3d6b5e; color: #fff; }
    .toast-out { animation: slideOut 0.2s ease-in forwards; }
    @keyframes slideIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(120%); opacity: 0; } }
    /* ── 加载骨架 ── */
    .loading .card { opacity: 0.5; pointer-events: none; }
    /* ── spinner ── */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner { width: 16px; height: 16px; border: 2px solid rgb(255 255 255 / 0.3); border-top-color: #fff; border-radius: 50%; animation: spin 0.6s linear infinite; display: inline-block; }
    /* ── 响应式 ── */
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid rgb(255 255 255 / 0.06); }
      main { padding: 20px; }
      .formgrid { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">
        <div class="logo">⚡</div>
        <h1>overview2api</h1>
      </div>
      <p class="desc">OpenAI 兼容入口，自动轮询多个 ClickUp 账号。失败账号会临时冷却，避免一直消耗坏凭据。</p>
      <div class="keybox">
        <label>管理密钥</label>
        <div class="input-row">
          <input id="adminKey" type="password" placeholder="ADMIN_KEY 或 API_KEY" autocomplete="off">
          <button class="connect-btn" onclick="loadAccounts()" title="连接">→</button>
        </div>
      </div>
      <div class="footer">
        <p>密钥自动保存在浏览器本地存储，下次打开无需重新输入。</p>
        <p style="margin-top:8px">持久化建议：给 Zeabur 挂载 <code>/app/data</code> 或设置 <code>ACCOUNTS_FILE</code>。</p>
      </div>
    </aside>
    <main>
      <div class="page-header">
        <h2>ClickUp 账号池</h2>
        <p>管理每个账号的 Cookie 或短期 JWT，测试确认可换发 frontdoor token。</p>
      </div>
      <div class="toolbar">
        <div class="stats" id="stats"></div>
        <button class="btn" onclick="resetForm()">＋ 新增账号</button>
      </div>
      <div id="accounts" class="grid"></div>
      <section class="editor">
        <h3 id="editorTitle">新增账号</h3>
        <div class="formgrid">
          <div class="field"><label>账号 ID</label><input id="id" placeholder="account-1"></div>
          <div class="field"><label>名称</label><input id="name" placeholder="主账号 / 小号 A"></div>
          <div class="field"><label>Workspace ID</label><input id="workspaceId" value="90141378436"></div>
          <div class="field"><label>Conversation ID</label><input id="conversationId" value="4002128792162479189"></div>
          <div class="field wide"><label>Auth Cookie</label><textarea id="authCookie" placeholder="只粘贴 Cookie: 后面的值，不含 Cookie: 前缀"></textarea></div>
          <div class="field wide"><label>ClickUp JWT（备选，约 48 小时过期）</label><textarea id="clickupJwt" placeholder="access_tokens 响应里的 token 字段"></textarea></div>
        </div>
        <div class="editor-actions">
          <button class="btn btn-primary" onclick="saveAccount()">💾 保存账号</button>
          <button class="btn" onclick="testCurrent()">🔍 保存并测试</button>
        </div>
      </section>
    </main>
  </div>
  <div class="toast-container" id="toasts"></div>
  <script>
    const $ = function (id) { return document.getElementById(id); };
    var __accounts = [];
    var __editingId = null;

    /* ── Admin Key 持久化 ── */
    (function initKey() {
      var saved = null;
      try { saved = localStorage.getItem('overview2api_admin_key'); } catch (_) {}
      if (saved) {
        $('adminKey').value = saved;
        loadAccounts();
      }
    })();

    function saveKey() {
      try { localStorage.setItem('overview2api_admin_key', $('adminKey').value.trim()); } catch (_) {}
    }

    /* ── Toast ── */
    function toast(msg, type) {
      type = type || 'info';
      var container = $('toasts');
      var el = document.createElement('div');
      el.className = 'toast toast-' + type;
      var icons = { success: '✓', error: '✗', info: 'ℹ' };
      el.textContent = (icons[type] || '') + ' ' + msg;
      container.appendChild(el);
      setTimeout(function () {
        el.classList.add('toast-out');
        setTimeout(function () { el.remove(); }, 200);
      }, 3500);
    }

    /* ── API ── */
    function auth() {
      return { authorization: 'Bearer ' + $('adminKey').value.trim(), 'content-type': 'application/json' };
    }
    async function api(path, options) {
      options = options || {};
      var res = await fetch(path, Object.assign({}, options, { headers: Object.assign({}, auth(), options.headers || {}) }));
      var body = null;
      try { body = await res.json(); } catch (_) { body = {}; }
      if (!res.ok) throw new Error((body.error && body.error.message) || '请求失败 (' + res.status + ')');
      return body;
    }

    /* ── 表单 ── */
    function resetForm() {
      ['id', 'name', 'authCookie', 'clickupJwt'].forEach(function (id) { $(id).value = ''; });
      $('workspaceId').value = '90141378436';
      $('conversationId').value = '4002128792162479189';
      __editingId = null;
      $('editorTitle').textContent = '新增账号';
    }

    function editAccount(a) {
      $('id').value = a.id;
      $('name').value = a.name;
      $('workspaceId').value = a.workspaceId;
      $('conversationId').value = a.conversationId;
      $('authCookie').value = '';
      $('clickupJwt').value = '';
      __editingId = a.id;
      $('editorTitle').textContent = '编辑账号：' + escapeHtml(a.name);
      toast('编辑已有账号，密钥留空则沿用已保存值。', 'info');
      $('editorTitle').scrollIntoView({ behavior: 'smooth' });
    }

    function payload() {
      return {
        id: $('id').value.trim(),
        name: $('name').value.trim(),
        workspaceId: $('workspaceId').value.trim(),
        conversationId: $('conversationId').value.trim(),
        authCookie: $('authCookie').value.trim(),
        clickupJwt: $('clickupJwt').value.trim(),
        enabled: true
      };
    }

    /* ── 渲染 ── */
    function renderAccounts(accounts) {
      if (!accounts.length) {
        $('accounts').innerHTML = '';
        $('stats').innerHTML = '';
        return;
      }
      var enabled = accounts.filter(function (a) { return a.enabled; });
      var total = accounts.length;
      $('stats').innerHTML = '<span>共 <strong>' + total + '</strong> 个账号</span><span>启用 <strong>' + enabled.length + '</strong> 个</span>';

      $('accounts').innerHTML = accounts.map(function (a) {
        var statusHtml;
        if (a.enabled) {
          statusHtml = '<span class="badge badge-success"><span class="dot"></span>启用</span>';
        } else {
          statusHtml = '<span class="badge badge-danger"><span class="dot"></span>停用</span>';
        }
        if (a.disabledUntil && a.disabledUntil > Date.now()) {
          statusHtml = '<span class="badge badge-warning"><span class="dot"></span>冷却中</span>';
        }

        var cookieBadge = a.hasAuthCookie
          ? '<span class="cred-badge ok">Cookie 已填写</span>'
          : '<span class="cred-badge missing">Cookie 未填写</span>';
        var jwtBadge = a.hasClickupJwt
          ? '<span class="cred-badge ok">JWT 已填写</span>'
          : '<span class="cred-badge missing">JWT 未填写</span>';

        var errorHtml = a.lastError
          ? '<div class="error-preview" title="' + escapeAttr(a.lastError) + '">⚠ ' + escapeHtml(a.lastError) + '</div>'
          : '';

        var lastUsed = a.lastUsedAt
          ? '<div class="info-row"><span class="info-label">最近使用</span><span class="info-value">' + timeAgo(a.lastUsedAt) + '</span></div>'
          : '';

        return '<article class="card">'
          + '<div class="card-header"><div class="card-title">' + escapeHtml(a.name) + '</div>' + statusHtml + '</div>'
          + '<div class="card-body">'
          + '<div class="info-row"><span class="info-label">ID</span><span class="info-value">' + escapeHtml(a.id) + '</span></div>'
          + '<div class="info-row"><span class="info-label">Workspace</span><span class="info-value">' + escapeHtml(a.workspaceId) + '</span></div>'
          + '<div class="info-row"><span class="info-label">Conversation</span><span class="info-value">' + escapeHtml(a.conversationId) + '</span></div>'
          + '<div class="cred-badges">' + cookieBadge + jwtBadge + '</div>'
          + '<div class="info-row"><span class="info-label">调用 / 失败</span><span class="info-value">' + a.requestCount + ' / ' + a.failureCount + '</span></div>'
          + lastUsed
          + errorHtml
          + '</div>'
          + '<div class="card-footer">'
          + '<button class="btn btn-sm" onclick="editById(\\'' + escapeAttr(a.id) + '\\')">编辑</button>'
          + '<button class="btn btn-sm" onclick="testAccount(\\'' + escapeAttr(a.id) + '\\')">测试</button>'
          + '<button class="btn btn-sm btn-danger" onclick="deleteAccount(\\'' + escapeAttr(a.id) + '\\')">删除</button>'
          + '</div></article>';
      }).join('');
    }

    function editById(id) {
      var a = __accounts.find(function (x) { return x.id === id; });
      if (a) editAccount(a);
    }

    /* ── 操作 ── */
    async function loadAccounts() {
      try {
        var data = await api('/admin/api/accounts');
        __accounts = data.accounts;
        renderAccounts(__accounts);
        saveKey();
        toast('账号列表已刷新', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    async function saveAccount() {
      try {
        var result = await api('/admin/api/accounts', { method: 'POST', body: JSON.stringify(payload()) });
        toast('账号「' + escapeHtml(result.account.name) + '」已保存', 'success');
        resetForm();
        await loadAccounts();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function testCurrent() {
      try {
        var result = await api('/admin/api/accounts', { method: 'POST', body: JSON.stringify(payload()) });
        saveKey();
        await testAccount(result.account.id);
      } catch (e) { toast(e.message, 'error'); }
    }

    async function testAccount(id) {
      try {
        toast('正在测试 ' + id + ' ...', 'info');
        await api('/admin/api/accounts/' + encodeURIComponent(id) + '/test', { method: 'POST', body: '{}' });
        toast('✓ 测试通过：' + id + ' 可以换发 frontdoor token', 'success');
        await loadAccounts();
      } catch (e) {
        toast(e.message, 'error');
        await loadAccounts().catch(function () {});
      }
    }

    async function deleteAccount(id) {
      if (!confirm('确定要删除账号「' + id + '」吗？此操作不可撤销。')) return;
      try {
        await api('/admin/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
        toast('账号「' + id + '」已删除', 'success');
        if (__editingId === id) resetForm();
        await loadAccounts();
      } catch (e) { toast(e.message, 'error'); }
    }

    /* ── 工具函数 ── */
    function escapeHtml(s) {
      return String(s || '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
    function timeAgo(ts) {
      var diff = Date.now() - ts;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
      return Math.floor(diff / 86400000) + ' 天前';
    }
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
