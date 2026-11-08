const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const compiled = new Map(["aiProvider", "impressionBackfill"].map((name) => [
  name,
  ts.transpileModule(fs.readFileSync(path.join(root, `src/app/services/${name}.ts`), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
]));

function load(name, dependencies, globals = {}) {
  const context = {
    exports: {},
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    Error, URL, AbortController, DOMException, setTimeout, clearTimeout,
    console: { debug() {} },
    ...globals,
  };
  vm.runInNewContext(compiled.get(name), context, { filename: `${name}.ts` });
  return context.exports;
}

function rows(bookmarks) {
  return bookmarks.map(({ id }) => ({ id, keywords: ["reference"], summary: "Reference tool" }));
}

function harness(options = {}) {
  const bookmarks = options.bookmarks ?? Array.from({ length: options.count ?? 3 }, (_, i) => ({
    id: `b${i + 1}`, title: `Bookmark ${i + 1}`,
    url: `https://example.test/${i + 1}?private=value#private`, path: ["Docs"],
  }));
  const state = { requests: [], writes: [], progress: [], metadata: [], index: {} };
  const config = {
    type: "deepseek", model: "simulation-only", endpoint: "https://provider.invalid/v1",
    apiKey: "simulation-only-secret", enabled: true, ...options.config,
  };
  const provider = load("aiProvider", {
    "./hostPermissions": { hasRequiredHostPermission: async () => true },
    "./impressionSearchPrompts": {},
  }, {
    fetch: async (_url, request) => {
      const body = JSON.parse(request.body);
      const inputs = JSON.parse(body.messages[1].content.split("\n").slice(1).join("\n"));
      const call = { body, inputs };
      state.requests.push(call);
      const response = await options.respond?.(call, state.requests.length, state) ?? {};
      return {
        ok: response.status === undefined,
        status: response.status,
        text: async () => response.detail ?? "",
        json: async () => ({
          choices: [{
            finish_reason: response.finishReason ?? "stop",
            message: {
              content: response.content ?? JSON.stringify({ results: response.results ?? rows(inputs) }),
              refusal: response.refusal,
            },
          }],
        }),
      };
    },
  });
  const normalizeUrl = (value) => {
    try { const url = new URL(value); url.hash = ""; return url.href; } catch { return ""; }
  };
  const service = load("impressionBackfill", {
    "./bookmarks": { getAllBookmarks: async () => bookmarks },
    "./aiProvider": provider,
    "./pageMetadata": {
      enrichBookmarksWithPageMetadata: async (inputs, _source, metadataOptions) => {
        state.metadata.push({ inputs, mode: metadataOptions.mode });
        await options.onMetadata?.(state.metadata.length);
        return inputs.map((input) => ({ ...input, metadata: {
          available: !options.unavailableMetadata,
          title: options.unavailableMetadata ? undefined : "Reference website",
        } }));
      },
    },
    "./rules": {
      toBookmarkForAI: (bookmark) => {
        const url = new URL(bookmark.url);
        url.search = ""; url.hash = "";
        return { id: bookmark.id, title: bookmark.title, url: url.href };
      },
    },
    "./semanticIndex": {
      getSemanticIndexMap: async () => options.index ?? state.index,
      hasUsableImpression: (meta) => Boolean(meta?.summary || meta?.keywords?.length),
      normalizeUrl,
      upsertBatchImpressions: async (inputs) => {
        if (options.saveError) throw new Error("Simulated storage error");
        state.writes.push(inputs);
        inputs.forEach((input) => { state.index[normalizeUrl(input.url)] = input; });
        options.onSave?.();
      },
    },
    "./storage": { getSettings: async () => ({ provider: config, sendFullUrl: false }) },
    "./hostPermissions": { hasRequiredHostPermission: async () => true },
  });
  return {
    state, bookmarks, config, service,
    run: () => service.backfillImpressions({
      signal: options.signal,
      onProgress: (progress) => state.progress.push(progress),
    }),
    extract: () => provider.extractImpressionsWithAI(config, bookmarks),
  };
}

test("complete batches use a proportional budget and save once per bookmark", async () => {
  const h = harness({ count: 35 });
  const result = await h.run();
  assert.equal(result.indexed, 35);
  assert.equal(result.failed, 0);
  assert.equal(result.retried, 0);
  assert.deepEqual(h.state.requests.map((call) => call.inputs.length), [20, 15]);
  assert.deepEqual(h.state.requests.map((call) => call.body.max_tokens), [3600, 2700]);
  assert.ok(h.state.requests.every((call) => call.inputs.every((input) => !input.url.includes("private"))));
  const progress = h.state.progress.at(-1);
  assert.equal(progress.processed, progress.total);
});

test("configured token caps reduce batches without overriding the user setting", async () => {
  const h = harness({ count: 12, config: { maxTokens: 900 } });
  const result = await h.run();
  assert.equal(result.indexed, 12);
  assert.deepEqual(h.state.requests.map((call) => call.inputs.length), [5, 5, 2]);
  assert.ok(h.state.requests.every((call) => call.body.max_tokens === 900));
  assert.equal(h.service.getImpressionBackfillBatchSize({ ...h.config, maxTokens: 1 }), 1);
  assert.equal(h.service.getImpressionBackfillBatchSize({ ...h.config, maxTokens: NaN }), 20);
});

test("impression overrides determine both batch size and request caps, independently of classification", async () => {
  const h = harness({
    count: 12,
    config: { maxTokens: 3600, classificationMaxTokens: 180, impressionMaxTokens: 900 },
  });
  const result = await h.run();
  assert.equal(result.indexed, 12);
  assert.deepEqual(h.state.requests.map((call) => call.inputs.length), [5, 5, 2]);
  assert.ok(h.state.requests.every((call) => call.body.max_tokens === 900));
});

test("clearing an impression override restores the default cap and corresponding batch size", async () => {
  const h = harness({ count: 12, config: { maxTokens: 1800, impressionMaxTokens: undefined } });
  const result = await h.run();
  assert.equal(result.indexed, 12);
  assert.deepEqual(h.state.requests.map((call) => call.inputs.length), [10, 2]);
  assert.ok(h.state.requests.every((call) => call.body.max_tokens === 1800));
});

test("missing items retry once in groups of five, without resending successful items", async () => {
  const h = harness({
    count: 20,
    respond: ({ inputs }, call) => call === 1 ? { results: rows(inputs.slice(0, 8)) } : {},
  });
  const result = await h.run();
  assert.equal(result.indexed, 20);
  assert.equal(result.retried, 12);
  assert.equal(result.recovered, 12);
  assert.equal(result.failed, 0);
  assert.deepEqual(h.state.requests.map((call) => call.inputs.length), [20, 5, 5, 2]);
  const retriedIds = h.state.requests.slice(1).flatMap((call) => call.inputs.map((input) => input.id));
  assert.equal(new Set(retriedIds).size, 12);
  assert.ok(!retriedIds.includes("b1"));
  assert.ok(h.state.progress.some((item) => item.phase === "retrying_ai"));
});

test("a length-limited response preserves complete items and retries only the remainder", async () => {
  const h = harness({
    count: 4,
    respond: ({ inputs }, call) => call === 1 ? {
      finishReason: "length",
      content: `{"results":[${JSON.stringify(rows(inputs)[0])},{"id":"b2","summary":"unfinished`,
    } : {},
  });
  const result = await h.run();
  assert.equal(result.indexed, 4);
  assert.equal(result.recovered, 3);
  assert.equal(h.state.requests[1].inputs.length, 3);
  assert.equal(h.state.writes[0][0].bookmarkId, "b1");
});

test("duplicates and unknown IDs never inflate success or enter storage", async () => {
  const h = harness({
    respond: ({ inputs }, call) => call === 1 ? {
      results: [...rows(inputs.slice(0, 1)), ...rows(inputs.slice(0, 1)), ...rows([{ id: "unknown" }])],
    } : {},
  });
  const result = await h.run();
  assert.equal(result.indexed, 3);
  assert.equal(result.retried, 2);
  assert.equal(h.state.writes.flat().length, 3);
  assert.ok(!h.state.writes.flat().some((item) => item.bookmarkId === "unknown"));
});

test("invalid fields remain failures with bookmark identity and a metadata warning", async () => {
  const h = harness({
    count: 1, unavailableMetadata: true,
    respond: () => ({ results: [{ id: "b1", keywords: [123, {}], summary: "" }] }),
  });
  const result = await h.run();
  assert.equal(result.indexed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.retried, 1);
  assert.equal(h.state.requests.length, 2);
  assert.equal(result.failures[0].bookmarkId, "b1");
  assert.equal(result.failures[0].title, "Bookmark 1");
  assert.match(result.failures[0].reason, /有效用途信息/);
  assert.match(result.failures[0].reason, /网页摘要/);
  assert.deepEqual(h.state.metadata.map((item) => item.mode), ["quick", "deep"]);
  assert.equal(h.state.writes.length, 0);
});

test("persistent truncation reports the output cap and has no third attempt", async () => {
  const h = harness({ count: 1, respond: () => ({ content: '{"results":[', finishReason: "length" }) });
  const result = await h.run();
  assert.equal(h.state.requests.length, 2);
  assert.equal(result.failed, 1);
  assert.match(result.failures[0].reason, /输出上限/);
});

for (const response of [
  { finishReason: "content_filter", results: rows([{ id: "b1" }]) },
  { refusal: "simulated refusal", results: rows([{ id: "b1" }]) },
]) {
  test(`refusal is visible and does not trigger more paid requests: ${Object.keys(response)[0]}`, async () => {
    const h = harness({ respond: () => response });
    const result = await h.run();
    assert.equal(result.failed, 3);
    assert.equal(result.indexed, 0);
    assert.equal(h.state.requests.length, 1);
    assert.match(result.failures[0].reason, /拒绝|过滤/);
  });
}

test("network failures do not retry and never expose raw errors", async () => {
  const h = harness({ respond: () => { throw new Error("simulation-only-secret"); } });
  const result = await h.run();
  assert.equal(result.failed, 3);
  assert.equal(h.state.requests.length, 1);
  assert.match(result.failures[0].reason, /网络/);
  assert.ok(!JSON.stringify(result).includes("simulation-only-secret"));
});

test("HTTP failures expose a safe category instead of the provider response", async () => {
  const h = harness({ respond: () => ({ status: 500, detail: "simulation-only-secret" }) });
  const result = await h.run();
  assert.equal(result.failed, 3);
  assert.equal(h.state.requests.length, 1);
  assert.ok(!JSON.stringify(result).includes("simulation-only-secret"));
});

test("save failures are not counted as successes and do not call AI again", async () => {
  const h = harness({ saveError: true });
  const result = await h.run();
  assert.equal(result.indexed, 0);
  assert.equal(result.failed, 3);
  assert.equal(result.retried, 0);
  assert.equal(h.state.requests.length, 1);
  assert.match(result.failures[0].reason, /保存失败/);
});

test("retry network errors keep the already saved successes", async () => {
  const h = harness({
    respond: ({ inputs }, call) => {
      if (call > 1) throw new Error("Simulated network failure");
      return { results: rows(inputs.slice(0, 1)) };
    },
  });
  const result = await h.run();
  assert.equal(result.indexed, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.recovered, 0);
  assert.equal(result.retried, 2);
  assert.equal(h.state.requests.length, 2);
});

test("cancel after saving keeps successes and leaves pending items unprocessed", async () => {
  const controller = new AbortController();
  const h = harness({
    signal: controller.signal,
    respond: ({ inputs }) => ({ results: rows(inputs.slice(0, 1)) }),
    onSave: () => controller.abort(),
  });
  const result = await h.run();
  assert.equal(result.canceled, true);
  assert.equal(result.indexed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.retried, 0);
  assert.equal(h.state.requests.length, 1);
});

test("cancel during AI response is cancellation even if the provider throws an ordinary Error", async () => {
  const controller = new AbortController();
  const h = harness({
    signal: controller.signal,
    respond: () => { controller.abort(); throw new Error("Simulated aborted response"); },
  });
  const result = await h.run();
  assert.equal(result.canceled, true);
  assert.equal(result.indexed, 0);
  assert.equal(result.failed, 0);
  assert.equal(h.state.requests.length, 1);
});

test("retry metadata errors preserve prior saves and count only remaining items", async () => {
  const h = harness({
    unavailableMetadata: true,
    respond: ({ inputs }) => ({ results: rows(inputs.slice(0, 1)) }),
    onMetadata: (call) => { if (call === 2) throw new Error("Simulated metadata error"); },
  });
  const result = await h.run();
  assert.equal(result.indexed, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.failures.length, 2);
});

test("indexed URLs, duplicate URLs and non-web bookmarks make no extra AI requests", async () => {
  const h = harness({
    bookmarks: [
      { id: "done", title: "Indexed", url: "https://example.test/done", path: [] },
      { id: "b1", title: "New", url: "https://example.test/new", path: [] },
      { id: "b2", title: "Duplicate", url: "https://example.test/new#section", path: [] },
      { id: "b3", title: "Browser", url: "chrome://bookmarks", path: [] },
    ],
    index: { "https://example.test/done": { summary: "Existing impression" } },
  });
  const result = await h.run();
  assert.equal(result.total, 1);
  assert.equal(result.indexed, 1);
  assert.equal(h.state.requests[0].inputs[0].id, "b1");
});

test("an empty library makes no metadata, AI or storage writes", async () => {
  const h = harness({ count: 0 });
  const result = await h.run();
  assert.equal(result.total, 0);
  assert.equal(h.state.requests.length, 0);
  assert.equal(h.state.metadata.length, 0);
  assert.equal(h.state.writes.length, 0);
});
