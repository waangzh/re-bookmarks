import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";

const provider = await loadService("src/app/services/aiProvider.ts");
const storage = await loadService("src/app/services/storage.ts");
const originalFetch = globalThis.fetch;
globalThis.__REMARKS_BROWSER_TARGET__ = "chromium";
afterEach(() => { globalThis.fetch = originalFetch; globalThis.__REMARKS_BROWSER_TARGET__ = "chromium"; });

const config = {
  type: "custom", apiKey: "simulation-only", model: "simulation-model",
  endpoint: "http://localhost:18317/v1", enabled: true,
};
const bookmarks = [{ id: "b1", title: "文档", domain: "example.test", path: "开发", sanitizedUrl: "https://example.test/" }];
const answer = JSON.stringify({ results: [{ id: "b1", categoryPath: ["开发", "文档"], confidence: 0.9, reason: "文档参考", keywords: ["API 文档"] }] });
const chatAnswer = (content = "ok", extra = {}) => ({ choices: [{ finish_reason: "stop", message: { content } }], ...extra });
const responsesAnswer = (text = "ok", extra = {}) => ({
  status: "completed", output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "not the answer" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  ], ...extra,
});

function network(payload, { status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options, body: options.body && JSON.parse(options.body) });
    return typeof payload === "string" ? new Response(payload, { status }) : Response.json(payload, { status });
  };
  return calls;
}

test("default Chat Completions preserves the request and classification contract", async () => {
  const calls = network(chatAnswer(answer));
  const result = await provider.classifyWithAI(config, bookmarks);
  assert.equal(calls[0].url, "http://localhost:18317/v1/chat/completions");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.messages[0].role, "system");
  assert.equal(calls[0].body.max_completion_tokens, 4000);
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(calls[0].body.input, undefined);
  assert.equal(result[0].id, "b1");
  assert.deepEqual(result[0].categoryPath, ["开发", "文档"]);
});

test("Responses constructs input, JSON format and task budgets and normalizes usage", async () => {
  const calls = network(responsesAnswer(answer, { usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } }));
  let usage;
  const result = await provider.classifyWithAI({ ...config, apiProtocol: "responses", classificationMaxTokens: 6000, tokenParam: "max_tokens", sendTemperature: false }, bookmarks, { onTokenUsage: (value) => { usage = value; } });
  const body = calls[0].body;
  assert.equal(calls[0].url, "http://localhost:18317/v1/responses");
  assert.equal(body.input[0].role, "system");
  assert.match(body.input[1].content, /b1/);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.max_output_tokens, 6000);
  assert.deepEqual(body.text, { format: { type: "json_object" } });
  for (const key of ["messages", "max_tokens", "max_completion_tokens", "response_format", "temperature"]) assert.equal(body[key], undefined);
  assert.deepEqual(usage, { promptTokens: 80, completionTokens: 20, totalTokens: 100 });
  assert.equal(result[0].id, "b1");
  assert.deepEqual(result[0].categoryPath, ["开发", "文档"]);
});

test("Responses joins all assistant text parts while ignoring reasoning and other items", async () => {
  const calls = network(responsesAnswer("", { output: [
    { type: "reasoning", content: [{ type: "output_text", text: "not JSON" }] },
    { type: "message", role: "user", content: [{ type: "output_text", text: "not JSON" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: answer.slice(0, 30) }, { type: "output_text", text: answer.slice(30) }] },
  ] }));
  assert.equal((await provider.classifyWithAI({ ...config, apiProtocol: "responses" }, bookmarks))[0].id, "b1");
  assert.equal(calls.length, 1);
});

test("each protocol retains its own custom path; paths append to Base URL without stripping /v1", async () => {
  const settings = { ...config, chatCompletionsPath: "/custom/chat", responsesPath: "/custom/responses?api-version=test", modelsPath: "catalog/models" };
  assert.equal(provider.requestUrlFor(settings), "http://localhost:18317/v1/custom/chat");
  assert.equal(provider.requestUrlFor({ ...settings, apiProtocol: "responses" }), "http://localhost:18317/v1/custom/responses?api-version=test");
  const calls = network({ data: [{ id: "m2" }, { id: "m1" }, { id: "m1" }] });
  assert.deepEqual((await provider.listAIModels(settings)).map((model) => model.id), ["m1", "m2"]);
  assert.equal(calls[0].url, "http://localhost:18317/v1/catalog/models");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Authorization, "Bearer simulation-only");
  assert.equal(provider.requestUrlFor({ ...config, endpoint: "  http://127.0.0.1:3425/v1///  ", responsesPath: "  ", apiProtocol: "responses" }), "http://127.0.0.1:3425/v1/responses");
  assert.equal(provider.requestUrlFor({ ...config, type: "deepseek" }), "http://localhost:18317/chat/completions");
});

test("unsafe path/base values are rejected before a key-bearing request can be sent", async () => {
  const calls = network(chatAnswer());
  for (const path of ["https://other.test/chat", "//other.test/chat", "../chat", "%2e%2e/chat", "\\other.test", "/chat#fragment"]) {
    await assert.rejects(provider.testAIConnection({ ...config, chatCompletionsPath: path }));
  }
  for (const endpoint of ["ftp://host.test/v1", "https://user:pass@host.test/v1", "https://host.test/v1?key=test", "https://host.test/v1#part"]) {
    await assert.rejects(provider.testAIConnection({ ...config, endpoint }));
  }
  assert.equal(calls.length, 0);
});

for (const protocol of ["chat_completions", "responses"]) {
  test(`${protocol}: connection succeeds only for nonempty text and preserves JSON mode configuration`, async () => {
    const make = protocol === "responses" ? responsesAnswer : chatAnswer;
    const calls = network(make('{"status":"ok"}'));
    assert.equal(await provider.testAIConnection({ ...config, apiProtocol: protocol, jsonMode: "on" }), true);
    const body = calls[0].body;
    assert.match((body.input ?? body.messages)[0].content, /JSON/);
    if (protocol === "responses") assert.equal(body.max_output_tokens, 256);
    network(make(" "));
    await assert.rejects(provider.testAIConnection({ ...config, apiProtocol: protocol }), /有效测试文本/);
    network({ unexpected: true });
    await assert.rejects(provider.testAIConnection({ ...config, apiProtocol: protocol }), /所选 API 协议/);
    network("not JSON");
    await assert.rejects(provider.testAIConnection({ ...config, apiProtocol: protocol }), /未返回有效 JSON/);
    network({ error: { message: "simulation failure" } });
    await assert.rejects(provider.testAIConnection({ ...config, apiProtocol: protocol }), /错误状态/);
  });
}

test("Responses refusals, truncation, filtering and unfinished/error states cannot pass a connection test", async () => {
  const cases = [
    [responsesAnswer("", { output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "refused" }] }] }), /拒绝/],
    [responsesAnswer("partial", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), /回复上限/],
    [responsesAnswer("", { status: "incomplete", incomplete_details: { reason: "content_filter" } }), /拒绝/],
    [responsesAnswer("ok", { status: "in_progress" }), /尚未完成/],
    [responsesAnswer("ok", { status: "failed" }), /错误状态/],
    [responsesAnswer("ok", { status: "incomplete", incomplete_details: { reason: "other" } }), /未完成/],
  ];
  for (const [payload, reason] of cases) {
    const calls = network(payload);
    await assert.rejects(provider.testAIConnection({ ...config, apiProtocol: "responses" }), reason);
    assert.equal(calls.length, 1, "must not fall back to a different protocol or send a paid retry");
  }
});

test("Responses truncation reaches existing impression partial-result handling", async () => {
  network(responsesAnswer(answer, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
  const result = await provider.extractImpressionsWithAI({ ...config, apiProtocol: "responses" }, bookmarks);
  assert.match(result.incompleteReason, /上限|截断|长度/);
});

test("Responses enforces its token minimum and honors disabled JSON mode", async () => {
  const calls = network(responsesAnswer());
  await provider.testAIConnection({ ...config, apiProtocol: "responses", maxTokens: 1, jsonMode: "off" });
  assert.equal(calls[0].body.max_output_tokens, 16);
  assert.equal(calls[0].body.text, undefined);
});

test("a missing model list does not prevent manual model selection and generation", async () => {
  const calls = network("404 page not found", { status: 404 });
  await assert.rejects(provider.listAIModels(config), /不支持模型列表接口/);
  assert.equal(calls.length, 1);
  network(chatAnswer());
  assert.equal(await provider.testAIConnection(config), true);
});

test("404 generation errors identify the selected request path without automatic fallback", async () => {
  const calls = network("404 page not found", { status: 404 });
  await assert.rejects(provider.testAIConnection({ ...config, apiProtocol: "responses", responsesPath: "/generate" }), /API 协议.*\/v1\/generate/);
  assert.equal(calls.length, 1);
});

test("cancellation before or during a response is preserved for either protocol", async () => {
  for (const apiProtocol of ["chat_completions", "responses"]) {
    const before = new AbortController();
    before.abort();
    const calls = network(chatAnswer(answer));
    await assert.rejects(provider.classifyWithAI({ ...config, apiProtocol }, bookmarks, { signal: before.signal }), { name: "AbortError" });
    assert.equal(calls.length, 0);
    const during = new AbortController();
    let started;
    const bodyStarted = new Promise((resolve) => { started = resolve; });
    globalThis.fetch = async (_url, { signal }) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }) });
    const pending = provider.classifyWithAI({ ...config, apiProtocol }, bookmarks, { signal: during.signal });
    await bodyStarted;
    during.abort();
    await assert.rejects(pending, { name: "AbortError" });
  }
});

test("Firefox permission checks gate both protocols before network access", async () => {
  setupBrowser();
  globalThis.__REMARKS_BROWSER_TARGET__ = "firefox";
  const calls = network(responsesAnswer());
  for (const apiProtocol of ["chat_completions", "responses"]) {
    await assert.rejects(provider.testAIConnection({ ...config, apiProtocol }), /网站访问权限/);
  }
  assert.equal(calls.length, 0);
});

test("storage persists protocol, independent paths and temperature choice without altering default configs", async () => {
  setupBrowser();
  const initial = await storage.getSettings();
  assert.equal(provider.protocolFor(initial.provider), "chat_completions");
  const updated = { ...config, apiProtocol: "responses", responsesPath: "/generate", chatCompletionsPath: "/chat", modelsPath: "/catalog", sendTemperature: false };
  await storage.saveSettings({ ...initial, provider: updated, providerConfigs: { custom: updated } });
  const reloaded = await storage.getSettings();
  for (const field of ["apiProtocol", "responsesPath", "chatCompletionsPath", "modelsPath", "sendTemperature"]) {
    assert.equal(reloaded.provider[field], updated[field]);
    assert.equal(reloaded.providerConfigs.custom[field], updated[field]);
  }
});
