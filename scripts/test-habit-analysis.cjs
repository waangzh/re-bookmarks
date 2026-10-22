const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const compiled = new Map();
for (const name of ["aiProvider", "habits"]) {
  const source = fs.readFileSync(path.join(root, `src/app/services/${name}.ts`), "utf8");
  compiled.set(name, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}

function load(name, dependencies, globals = {}) {
  const context = {
    exports: {},
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    Error,
    URL,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    console: { debug() {} },
    ...globals,
  };
  vm.runInNewContext(compiled.get(name), context, { filename: `${name}.ts` });
  return context.exports;
}

const aiProfile = {
  summary: "Technical reference folders",
  preferredTopLevelFolders: ["Docs"],
  folderRules: [{ folderPath: ["Docs"], pattern: "Technical documentation" }],
  avoidRules: [],
  promptHint: "Reuse the existing folders",
};
const existingProfile = {
  id: "existing",
  createdAt: 1,
  folderCount: 1,
  bookmarkCount: 1,
  ...aiProfile,
  summary: "Manually edited summary",
  folderRules: [{ folderPath: ["Manual"], pattern: "Manually edited rule" }],
  learning: { correctionCount: 3 },
};
const samples = [{
  folderPath: ["Docs"],
  bookmarkCount: 1,
  examples: [{ title: "Documentation", domain: "example.com", url: "https://example.com/docs" }],
}];
const fallback = { folderCount: 1, bookmarkCount: 1, ...aiProfile, summary: "Local summary" };

function harness(options = {}) {
  const state = {
    saved: [],
    cleared: 0,
    requests: [],
    entries: [],
    stored: options.stored ?? null,
  };
  const config = {
    type: "deepseek",
    model: "simulation-only",
    endpoint: "https://provider.invalid/v1",
    apiKey: "simulation-only",
    enabled: true,
    ...options.config,
  };
  const provider = load("aiProvider", {
    "./hostPermissions": { hasRequiredHostPermission: async () => true },
    "./impressionSearchPrompts": {},
  }, {
    fetch: async (_url, request) => {
      state.requests.push(JSON.parse(request.body));
      options.onResponse?.(state);
      if (options.networkError) throw new Error("Simulated network failure");
      return {
        ok: true,
        json: async () => ({
          choices: [{
            finish_reason: options.finishReason ?? "stop",
            message: {
              content: options.content ?? JSON.stringify(aiProfile),
              refusal: options.refusal,
            },
          }],
        }),
      };
    },
  });
  const habits = load("habits", {
    "./aiProvider": provider,
    "./bookmarks": {
      getAllBookmarks: async () => options.emptySamples ? [] : [{
        id: "b1",
        title: "Documentation",
        url: "https://example.com/docs?private=value#private",
        path: ["Docs"],
      }],
      getAllBookmarkFolders: async () => [],
    },
    "./rules": {
      getDomain: (url) => new URL(url).hostname,
      sanitizeUrl: (url) => {
        const sanitized = new URL(url);
        sanitized.search = "";
        sanitized.hash = "";
        return sanitized.href;
      },
    },
    "./whitelist": {
      filterAvailableBookmarks: (bookmarks) => bookmarks,
      getCurrentWhitelist: async () => ({ entries: state.entries, index: {} }),
      whitelistFingerprint: (entries) => entries.map((entry) => `${entry.type}:${entry.id}`).sort().join("|"),
    },
    "./storage": {
      getSettings: async () => ({ provider: config }),
      getFolderHabitProfile: async () => state.stored,
      getStoredFolderHabitProfile: async () => {
        if (options.readError) throw new Error("Simulated storage read failure");
        return state.stored;
      },
      saveFolderHabitProfile: async (profile) => {
        if (options.saveError) throw new Error("Simulated storage write failure");
        state.saved.push(profile);
      },
      clearPreviewPlan: async () => { state.cleared += 1; },
    },
  });
  return {
    state,
    analyze: () => habits.analyzeAndSaveFolderHabits(),
    analyzeAI: () => provider.analyzeFolderHabitsWithAI(config, samples, fallback),
  };
}

for (const [name, value] of [
  ["object", JSON.stringify(aiProfile)],
  ["code fence", `\`\`\`json\n${JSON.stringify(aiProfile)}\n\`\`\``],
  ["single-item array", JSON.stringify([aiProfile])],
  ["profile wrapper", JSON.stringify({ profile: aiProfile })],
  ["data wrapper", JSON.stringify({ data: aiProfile })],
  ["result wrapper", JSON.stringify({ result: aiProfile })],
]) {
  test(`accept a complete profile: ${name}`, async () => {
    const { analyzeAI } = harness({ content: value });
    const profile = await analyzeAI();
    assert.equal(profile.summary, aiProfile.summary);
    assert.equal(profile.folderRules[0].pattern, aiProfile.folderRules[0].pattern);
    assert.equal(profile.folderCount, fallback.folderCount);
    assert.equal(profile.avoidRules.length, 0);
  });
}

for (const [name, content, expected] of [
  ["truncated object containing arrays", '{"summary":"AI","preferredTopLevelFolders":["Docs"],"folderRules":[{"folderPath":["Docs"],"pattern":"unfinished', /JSON.*不完整/],
  ["unclosed code fence", '```json\n{"summary":"unfinished', /JSON.*不完整/],
  ["multiple profile objects", `${JSON.stringify(aiProfile)}\n${JSON.stringify(aiProfile)}`, /JSON.*格式无效/],
  ["multiple profiles in an array", JSON.stringify([aiProfile, aiProfile]), /单个 JSON 对象/],
  ["invalid field types", '{"summary":123,"folderRules":"invalid"}', /缺少有效的文件夹规则/],
  ["missing required fields", '{"summary":"AI summary","folderRules":[]}', /字段缺失/],
  ["empty profile", "{}", /缺少有效的文件夹规则/],
  ["empty content", "", /画像内容为空/],
  ["invalid folder path", JSON.stringify({ ...aiProfile, folderRules: [{ folderPath: [123], pattern: "Invalid" }] }), /无效的文件夹路径/],
  ["excessive path depth", JSON.stringify({ ...aiProfile, folderRules: [{ folderPath: ["a", "b", "c", "d"], pattern: "Invalid" }] }), /无效的文件夹路径/],
  ["invalid string array", JSON.stringify({ ...aiProfile, preferredTopLevelFolders: [{}] }), /字段缺失或类型不正确/],
  ["empty summary", JSON.stringify({ ...aiProfile, summary: "" }), /字段缺失或类型不正确/],
]) {
  test(`reject invalid AI output: ${name}`, async () => {
    await assert.rejects(harness({ content }).analyzeAI(), expected);
  });
}

test("reject length termination even when the content happens to be valid JSON", async () => {
  await assert.rejects(harness({ finishReason: "length" }).analyzeAI(), /长度限制.*未完成/);
});

test("reject filtered or refused output", async () => {
  await assert.rejects(harness({ finishReason: "content_filter" }).analyzeAI(), /未提供画像内容/);
  await assert.rejects(harness({ refusal: "Simulated refusal" }).analyzeAI(), /未提供画像内容/);
});

test("preserve the existing profile and preview after a failed refresh", async () => {
  const { analyze, state } = harness({ stored: existingProfile, finishReason: "length" });
  await assert.rejects(analyze(), /本次未更新画像.*保留原有分类偏好/);
  assert.equal(state.stored, existingProfile);
  assert.equal(state.saved.length, 0);
  assert.equal(state.cleared, 0);
  assert.equal(state.requests.length, 1);
});

test("first-time failure saves local rules with an explicit warning", async () => {
  const { analyze, state } = harness({ content: '{"summary":123,"folderRules":"invalid"}' });
  const profile = await analyze();
  assert.equal(profile.analysisSource, "fallback");
  assert.match(profile.analysisWarning, /非 AI 分析/);
  assert.notEqual(profile.summary, aiProfile.summary);
  assert.equal(state.saved.length, 1);
  assert.equal(state.cleared, 1);
});

for (const [name, options] of [
  ["missing key", { config: { apiKey: "" } }],
  ["missing authorization", { config: { enabled: false } }],
  ["no samples", { emptySamples: true }],
]) {
  test(`keep existing rules without a request: ${name}`, async () => {
    const { analyze, state } = harness({ ...options, stored: existingProfile });
    await assert.rejects(analyze(), /保留原有分类偏好/);
    assert.equal(state.requests.length, 0);
    assert.equal(state.saved.length, 0);
    assert.equal(state.cleared, 0);
  });
}

test("successful refresh preserves feedback recorded during the request", async () => {
  const { analyze, state } = harness({
    stored: existingProfile,
    onResponse(current) {
      current.stored = { ...existingProfile, learning: { correctionCount: 8 } };
    },
  });
  const profile = await analyze();
  assert.equal(profile.analysisSource, "ai");
  assert.equal(profile.analysisWarning, undefined);
  assert.equal(profile.learning.correctionCount, 8);
  assert.equal(state.saved.length, 1);
  assert.equal(state.cleared, 1);
  assert.ok(state.requests[0].messages[1].content.includes("https://example.com/docs"));
  assert.ok(!state.requests[0].messages[1].content.includes("private"));
});

test("whitelist changes prevent writes even when an old profile exists", async () => {
  const { analyze, state } = harness({
    stored: existingProfile,
    finishReason: "length",
    onResponse(current) { current.entries = [{ type: "folder", id: "protected" }]; },
  });
  await assert.rejects(analyze(), /白名单.*变化/);
  assert.equal(state.saved.length, 0);
  assert.equal(state.cleared, 0);
});

test("do not reuse a profile invalidated by the whitelist", async () => {
  const { analyze } = harness({
    stored: { ...existingProfile, whitelistFingerprint: "folder:previous" },
    finishReason: "length",
  });
  const profile = await analyze();
  assert.equal(profile.analysisSource, "fallback");
  assert.equal(profile.learning, undefined);
});

for (const [name, options] of [
  ["read failure", { readError: true }],
  ["write failure", { saveError: true }],
]) {
  test(`storage failure cannot report success: ${name}`, async () => {
    const { analyze, state } = harness(options);
    await assert.rejects(analyze(), /Simulated storage/);
    assert.equal(state.saved.length, 0);
    assert.equal(state.cleared, 0);
  });
}

test("network failure does not trigger a paid retry", async () => {
  const { analyze, state } = harness({ stored: existingProfile, networkError: true });
  await assert.rejects(analyze(), /保留原有分类偏好/);
  assert.equal(state.requests.length, 1);
  assert.equal(state.saved.length, 0);
});

test("retain JSON mode and the user-configured output limit", async () => {
  const { analyzeAI, state } = harness({ config: { maxTokens: 5000 } });
  await analyzeAI();
  assert.equal(state.requests[0].max_tokens, 5000);
  assert.equal(state.requests[0].response_format.type, "json_object");
  assert.match(state.requests[0].messages[0].content, /folderRules 最多 12 条/);
});
