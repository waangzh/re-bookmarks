const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const compiled = new Map([
  ["provider", "services/aiProvider.ts"],
  ["storage", "services/storage.ts"],
  ["options", "components/Options.tsx"],
].map(([name, file]) => [
  name,
  ts.transpileModule(fs.readFileSync(path.join(root, "src/app", file), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    },
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
  vm.runInNewContext(compiled.get(name), context, { filename: name });
  return context.exports;
}

const config = {
  type: "deepseek", apiKey: "simulation-only", model: "simulation-only",
  endpoint: "https://provider.invalid/v1", enabled: true,
};
const bookmark = { id: "b1", title: "Reference", url: "https://example.test/", path: ["Docs"] };

function providerHarness() {
  const requests = [];
  const provider = load("provider", {
    "./hostPermissions": { hasRequiredHostPermission: async () => true },
    "./impressionSearchPrompts": {},
  }, {
    fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return {
        ok: true,
        json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          results: [{
            id: bookmark.id, categoryPath: ["Docs"], confidence: 0.9, reason: "Reference tool",
            summary: "Reference tool", keywords: ["reference"],
          }],
        }) } }] }),
      };
    },
  });
  return { provider, requests };
}

function storageHarness(initial) {
  const values = { "remarks.settings": initial && JSON.parse(JSON.stringify(initial)) };
  const storage = load("storage", { "./storageMutation": {} }, {
    chrome: {
      runtime: {},
      storage: { local: {
        get(key, callback) { callback({ [key]: values[key] }); },
        set(data, callback) {
          Object.assign(values, JSON.parse(JSON.stringify(data)));
          callback();
        },
        remove(key, callback) { delete values[key]; callback(); },
      } },
    },
  });
  return { storage };
}

test("classification and impression requests independently override the default", async () => {
  const { provider, requests } = providerHarness();
  const settings = { ...config, maxTokens: 2000, classificationMaxTokens: 5000, impressionMaxTokens: 900 };
  await provider.classifyWithAI(settings, [bookmark]);
  await provider.extractImpressionsWithAI(settings, [bookmark]);
  await provider.testAIConnection(settings);
  assert.deepEqual(requests.map((request) => request.max_tokens), [5000, 900, 2000]);
});

test("legacy default values still apply to every request without overrides", async () => {
  const { provider, requests } = providerHarness();
  const settings = { ...config, maxTokens: 2200 };
  await provider.classifyWithAI(settings, [bookmark]);
  await provider.extractImpressionsWithAI(settings, [bookmark]);
  await provider.testAIConnection(settings);
  assert.deepEqual(requests.map((request) => request.max_tokens), [2200, 2200, 2200]);
});

test("empty default and task limits preserve each request's automatic budget", async () => {
  const { provider, requests } = providerHarness();
  await provider.classifyWithAI(config, [bookmark]);
  await provider.extractImpressionsWithAI(config, [bookmark]);
  await provider.testAIConnection(config);
  assert.deepEqual(requests.map((request) => request.max_tokens), [4000, 1200, 8]);
});

test("one task's override never leaks into another task or the default", async () => {
  const { provider, requests } = providerHarness();
  const settings = { ...config, classificationMaxTokens: 7000 };
  await provider.classifyWithAI(settings, [bookmark]);
  await provider.extractImpressionsWithAI(settings, [bookmark]);
  await provider.testAIConnection(settings);
  assert.deepEqual(requests.map((request) => request.max_tokens), [7000, 1200, 8]);
});

test("clearing an override restores inheritance immediately", async () => {
  const { provider, requests } = providerHarness();
  const settings = { ...config, maxTokens: 2400, classificationMaxTokens: 6000 };
  await provider.classifyWithAI(settings, [bookmark]);
  settings.classificationMaxTokens = undefined;
  await provider.classifyWithAI(settings, [bookmark]);
  settings.maxTokens = undefined;
  await provider.classifyWithAI(settings, [bookmark]);
  assert.deepEqual(requests.map((request) => request.max_tokens), [6000, 2400, 4000]);
});

test("invalid task limits inherit a valid default, and invalid defaults use automatic budgets", () => {
  const { provider } = providerHarness();
  for (const value of [0, -1, NaN, Infinity, "900"]) {
    assert.equal(provider.getAIOutputTokenLimit({ ...config, maxTokens: 2000, impressionMaxTokens: value }, "impression"), 2000);
    assert.equal(provider.getAIOutputTokenLimit({ ...config, maxTokens: value }, "classification"), undefined);
  }
  assert.equal(provider.getAIOutputTokenLimit({ ...config, impressionMaxTokens: 900.6 }, "impression"), 901);
});

test("task limits keep the selected OpenAI-compatible token parameter", async () => {
  const { provider, requests } = providerHarness();
  const settings = { ...config, tokenParam: "max_completion_tokens", maxTokens: 2000, impressionMaxTokens: 1400 };
  await provider.extractImpressionsWithAI(settings, [bookmark]);
  assert.equal(requests[0].max_completion_tokens, 1400);
  assert.equal(requests[0].max_tokens, undefined);
});

test("save and reload preserve task overrides for each provider without migrating old settings", async () => {
  const { storage } = storageHarness({ provider: { ...config, maxTokens: 2000 } });
  const legacy = await storage.getSettings();
  assert.equal(legacy.provider.maxTokens, 2000);
  assert.equal(legacy.provider.classificationMaxTokens, undefined);
  assert.equal(legacy.provider.impressionMaxTokens, undefined);
  const provider = { ...legacy.provider, classificationMaxTokens: 5000, impressionMaxTokens: 900 };
  await storage.saveSettings({
    ...legacy, provider,
    providerConfigs: { custom: { ...config, type: "custom", maxTokens: 3000, impressionMaxTokens: 1500 } },
  });
  const reloaded = await storage.getSettings();
  assert.equal(reloaded.provider.classificationMaxTokens, 5000);
  assert.equal(reloaded.provider.impressionMaxTokens, 900);
  assert.equal(reloaded.providerConfigs.deepseek.impressionMaxTokens, 900);
  assert.equal(reloaded.providerConfigs.custom.impressionMaxTokens, 1500);
  reloaded.provider.impressionMaxTokens = undefined;
  await storage.saveSettings(reloaded);
  const cleared = await storage.getSettings();
  assert.equal(cleared.provider.impressionMaxTokens, undefined);
  assert.equal(cleared.providerConfigs.deepseek.impressionMaxTokens, undefined);
  assert.equal(cleared.provider.maxTokens, 2000);
  assert.equal(cleared.providerConfigs.custom.impressionMaxTokens, 1500);
});

function nodes(root, predicate) {
  if (Array.isArray(root)) return root.flatMap((child) => nodes(child, predicate));
  if (!root || typeof root !== "object" || !root.props) return [];
  return [...(predicate(root) ? [root] : []), ...nodes(root.props.children, predicate)];
}

function text(root) {
  if (Array.isArray(root)) return root.map(text).join("");
  return typeof root === "string" || typeof root === "number" ? String(root) : text(root?.props?.children ?? []);
}

function optionsHarness(settings, storage, provider) {
  const state = [];
  let cursor = 0;
  const component = load("options", {
    react: {
      useState(initial) {
        const index = cursor++;
        if (state.length <= index) state[index] = index === 0
          ? structuredClone(settings) : typeof initial === "function" ? initial() : initial;
        return [state[index], (value) => {
          state[index] = typeof value === "function" ? value(state[index]) : value;
        }];
      },
      useEffect() {},
      useRef: (value) => ({ current: value }),
    },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "react-router": { useNavigate: () => () => {} },
    "lucide-react": require("lucide-react"),
    "./PageHeading": { PageHeading: () => null },
    "./Select": { Select: () => null },
    "./AIProtocolFields": { AIProtocolFields: () => null },
    "../services/aiProvider": provider,
    "../services/history": {},
    "../services/previewTask": { requestClearPreviewTask: async () => {} },
    "../services/hostPermissions": {},
    "../services/storage": storage,
    "../store/useAppStore": { useAppStore: () => ({ settings, loadSettings() {}, saveSettings: storage.saveSettings }) },
  });
  const render = () => { cursor = 0; return component.Options(); };
  const input = (id) => {
    const node = nodes(render(), (item) => item.type === "input" && item.props.id === id)[0];
    assert.ok(node, `Missing input: ${id}`);
    return node;
  };
  return {
    input,
    change(id, value) { input(id).props.onChange({ target: { value } }); },
    switchProvider(type) {
      const select = nodes(render(), (item) => item.props.options?.some((option) => option.value === "deepseek"))[0];
      assert.ok(select, "Missing provider select");
      select.props.onChange(type);
    },
    save: () => nodes(render(), (item) => item.type === "button" && text(item) === "保存设置")[0].props.onClick(),
  };
}

test("advanced controls edit drafts, clear overrides, inherit defaults and retain each provider's values", async () => {
  const { provider } = providerHarness();
  const { storage } = storageHarness({
    provider: { ...config, maxTokens: 1800, classificationMaxTokens: 5000, impressionMaxTokens: 900 },
    providerConfigs: { custom: { ...config, type: "custom", maxTokens: 3000, classificationMaxTokens: 6000 } },
  });
  const view = optionsHarness(await storage.getSettings(), storage, provider);
  assert.equal(view.input("provider-classification-max-tokens").props.value, 5000);
  view.change("provider-classification-max-tokens", "");
  view.change("provider-max-tokens", "2000");
  view.change("provider-impression-max-tokens", "720");
  assert.equal(view.input("provider-classification-max-tokens").props.placeholder, "继承默认：2000");
  assert.equal((await storage.getSettings()).provider.impressionMaxTokens, 900);
  view.switchProvider("custom");
  assert.equal(view.input("provider-classification-max-tokens").props.value, 6000);
  view.change("provider-classification-max-tokens", "7000");
  await view.save();
  const switched = await storage.getSettings();
  assert.equal(switched.provider.type, "custom");
  assert.equal(switched.provider.classificationMaxTokens, 7000);
  assert.equal(switched.providerConfigs.deepseek.maxTokens, 2000);
  assert.equal(switched.providerConfigs.deepseek.impressionMaxTokens, 720);
  assert.equal(switched.providerConfigs.deepseek.classificationMaxTokens, undefined);
  view.switchProvider("deepseek");
  assert.equal(view.input("provider-classification-max-tokens").props.value, "");
  assert.equal(view.input("provider-impression-max-tokens").props.value, 720);
  view.change("provider-max-tokens", "");
  assert.equal(view.input("provider-classification-max-tokens").props.placeholder, "继承默认（按任务自动）");
  await view.save();
  const reloaded = optionsHarness(await storage.getSettings(), storage, provider);
  assert.equal(reloaded.input("provider-classification-max-tokens").props.value, "");
  assert.equal(reloaded.input("provider-impression-max-tokens").props.value, 720);
});
