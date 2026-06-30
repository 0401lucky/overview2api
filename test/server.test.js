import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODELS,
  buildAiQuery,
  cookieValue,
  decodeJwtExpiry,
  mergeSetCookie,
  normalizeAccount,
  normalizeContent,
  normalizeMessages,
  parseModels,
  publicAccount,
  slugModel,
} from "../src/server.js";

test("合并 OpenAI 消息为 ClickUp 单轮输入", () => {
  const prompt = normalizeMessages([
    { role: "system", content: "你是角色扮演助手。" },
    { role: "user", content: "你好" },
  ]);

  assert.equal(prompt, "SYSTEM:\n你是角色扮演助手。\n\nUSER:\n你好");
});

test("支持 OpenAI 多段文本 content", () => {
  const content = normalizeContent([
    { type: "text", text: "第一段" },
    { type: "text", text: "第二段" },
    { type: "image_url", image_url: { url: "https://example.com/a.png" } },
  ]);

  assert.equal(content, "第一段\n第二段");
});

test("拒绝空 messages", () => {
  assert.throws(
    () => normalizeMessages([{ role: "user", content: "" }]),
    /没有可发送的文本内容/,
  );
});

test("模型列表默认包含页面已确认的 ClickUp 模型", () => {
  assert.deepEqual(
    DEFAULT_MODELS.slice(0, 4).map((item) => item.id),
    ["Brain² Max", "GPT-5.5", "Claude Opus 4.8", "Gemini 3.1 Pro"],
  );
});

test("解析自定义模型映射", () => {
  assert.deepEqual(parseModels("A=a-model\nB").map((item) => item.selectedModel), [
    "a-model",
    "b",
  ]);
});

test("生成 ClickUp AI 查询参数", () => {
  const query = buildAiQuery("请只回复 ping", "auto", true);
  assert.equal(
    query,
    "/?shouldTriage=false&createLink=false&uiSurface=ai_full_page&selectedModel=auto&keywords=%E8%AF%B7%E5%8F%AA%E5%9B%9E%E5%A4%8D+ping",
  );
});

test("模型名 slug 化并处理 Brain² Max", () => {
  assert.equal(slugModel("Brain² Max"), "auto");
  assert.equal(slugModel("Claude Opus 4.8"), "claude-opus-4.8");
});

test("合并 Set-Cookie 到 Cookie 请求头", () => {
  const merged = mergeSetCookie("a=1; b=2", ["b=3; Path=/; HttpOnly", "c=4; Secure"]);
  assert.equal(merged, "a=1; b=3; c=4");
});

test("从 Cookie 请求头读取指定值", () => {
  assert.equal(cookieValue("a=1; cu_jwt=jwt.value; b=2", "cu_jwt"), "jwt.value");
  assert.equal(cookieValue("a=1; b=2", "cu_jwt"), "");
});

test("解析 JWT 过期时间", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1893456000 })).toString("base64url");
  assert.equal(decodeJwtExpiry(`x.${payload}.y`), 1893456000000);
  assert.equal(decodeJwtExpiry("not-a-jwt"), 0);
});

test("账号公开信息不泄露 Cookie 和 JWT", () => {
  const account = normalizeAccount({
    id: "a1",
    name: "账号 1",
    workspaceId: "90141378436",
    conversationId: "4002128792162479189",
    authCookie: "session=secret",
    clickupJwt: "jwt.secret.value",
  });

  assert.deepEqual(publicAccount(account), {
    id: "a1",
    name: "账号 1",
    enabled: true,
    workspaceId: "90141378436",
    conversationId: "4002128792162479189",
    hasAuthCookie: true,
    hasClickupJwt: true,
    source: "file",
    requestCount: 0,
    failureCount: 0,
    lastUsedAt: null,
    disabledUntil: null,
    lastError: "",
    frontdoorTokenExpiresAt: null,
  });
});
