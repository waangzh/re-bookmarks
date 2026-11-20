import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { loadService } from "./load-service.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const { DEFAULT_SETTINGS } = await loadService("src/app/services/storage.ts");

function nodes(root, predicate) {
  if (Array.isArray(root)) return root.flatMap((child) => nodes(child, predicate));
  if (!root || typeof root !== "object" || !root.props) return [];
  return [...(predicate(root) ? [root] : []), ...nodes(root.props.children, predicate)];
}

function text(root) {
  if (Array.isArray(root)) return root.map(text).join("");
  return typeof root === "string" || typeof root === "number" ? String(root) : text(root?.props?.children ?? []);
}

function transpileComponent(relPath, dependencies, globals = {}) {
  const source = fs.readFileSync(path.resolve(relPath), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
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
  vm.runInNewContext(code, context, { filename: relPath });
  return context.exports;
}

function mountCascadeSelect() {
  const state = [];
  let cursor = 0;
  const timers = new Map();
  let nextTimerId = 1;
  const scheduled = [];

  const exports = transpileComponent("src/app/components/FolderCascadeSelect.tsx", {
    react: {
      useCallback: (fn) => fn,
      useEffect() {},
      useId: () => "cascade-test",
      useLayoutEffect() {},
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useState(initial) {
        const index = cursor++;
        if (state.length <= index) state[index] = typeof initial === "function" ? initial() : initial;
        return [state[index], (next) => {
          state[index] = typeof next === "function" ? next(state[index]) : next;
        }];
      },
    },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "lucide-react": require("lucide-react"),
  }, {
    window: {
      setTimeout(fn, delay) {
        const id = nextTimerId++;
        timers.set(id, { fn, delay });
        scheduled.push({ id, delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  });

  const render = (props) => { cursor = 0; return exports.FolderCascadeSelect(props); };
  return { exports, render, timers, scheduled };
}

function mountOptions(initialSettings, { failSave = false } = {}) {
  let persisted = structuredClone(initialSettings);
  const state = [];
  let cursor = 0;
  const MockSwitch = () => null;

  const exports = transpileComponent("src/app/components/Options.tsx", {
    react: {
      useState(initial) {
        const index = cursor++;
        if (state.length <= index) state[index] = index === 0 ? structuredClone(persisted) : typeof initial === "function" ? initial() : initial;
        return [state[index], (next) => {
          state[index] = typeof next === "function" ? next(state[index]) : next;
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
    "./Switch": { Switch: MockSwitch },
    "./AIProtocolFields": { AIProtocolFields: () => null },
    "../services/aiProvider": {
      AI_PROVIDER_OPTIONS: [{ type: "deepseek", label: "DeepSeek" }],
      AI_PROVIDER_PROFILES: { deepseek: { model: "deepseek-chat", endpoint: "https://api.deepseek.com/v1", supportsTemperature: true, defaultTemperature: 0.1, tokenParam: "max_tokens", supportsJsonMode: true } },
      modelListUrlFor: () => "https://api.deepseek.com/v1/models",
      protocolFor: () => "chat_completions",
      getAIOutputTokenLimit: () => undefined,
      listAIModels: async () => [],
      testAIConnection: async () => {},
    },
    "../services/history": { requestHistoryPermission: async () => false },
    "../services/previewTask": { requestClearPreviewTask: async () => {} },
    "../services/hostPermissions": { ensureRequiredHostPermission: async () => {} },
    "../services/storage": {
      clearPreviewPlan: async () => {},
      DEFAULT_CLASSIFY_PROMPT: "prompt",
      DEFAULT_SETTINGS,
      getModelCatalog: async () => null,
      MODEL_CATALOG_TTL_MS: 86400000,
      saveModelCatalog: async () => {},
    },
    "../store/useAppStore": {
      useAppStore: () => ({
        settings: persisted,
        loadSettings() {},
        saveSettings: async (next) => {
          if (failSave) throw new Error("写入失败");
          persisted = structuredClone(next);
        },
      }),
    },
  });

  const render = () => { cursor = 0; return exports.Options(); };
  return { exports, render, MockSwitch };
}

test("FolderCascadeSelect 安全三角区：斜向移入右侧子菜单时命中，垂直浏览一级目录时不拦截", () => {
  const { exports } = mountCascadeSelect();
  const { isPointInSafeTriangle } = exports;
  const secondaryRect = { left: 140, top: 80, bottom: 260, width: 160, height: 180 };
  const origin = { x: 40, y: 120 };

  assert.equal(isPointInSafeTriangle({ x: 100, y: 140 }, origin, secondaryRect), true);
  assert.equal(isPointInSafeTriangle({ x: 110, y: 200 }, origin, secondaryRect), true);
  assert.equal(isPointInSafeTriangle({ x: 40, y: 160 }, origin, secondaryRect), false);
  assert.equal(isPointInSafeTriangle({ x: 25, y: 125 }, origin, secondaryRect), false);
  assert.equal(isPointInSafeTriangle({ x: 100, y: 140 }, origin, { left: 140, top: 80, bottom: 80, width: 0, height: 0 }), false);
});

test("FolderCascadeSelect 悬停一级目录触发 95ms 延时切换，离开一级栏时取消待切换定时器", () => {
  const { render, timers, scheduled } = mountCascadeSelect();
  const folders = [
    { id: "1", title: "开发", type: "folder", path: ["开发"] },
    { id: "1-1", title: "前端", type: "folder", path: ["开发", "前端"] },
    { id: "2", title: "阅读", type: "folder", path: ["阅读"] },
    { id: "2-1", title: "文章", type: "folder", path: ["阅读", "文章"] },
  ];

  let tree = render({ value: ["开发", "前端"], folders, onChange() {} });
  const trigger = nodes(tree, (item) => item.type === "button" && String(item.props.className ?? "").includes("ui-select__trigger"))[0];
  trigger.props.onClick();

  tree = render({ value: ["开发", "前端"], folders, onChange() {} });
  const primaryList = nodes(tree, (item) => item.type === "ul" && String(item.props.className ?? "").includes("ui-cascade__column--primary"))[0];
  const primaryItems = nodes(primaryList, (item) => item.type === "li");
  assert.equal(primaryItems.length, 2);

  // 悬停到另一个一级目录，应先调度 80-120ms 延时，不立即切换
  primaryItems[1].props.onMouseEnter({ clientX: 40, clientY: 80 });
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].delay >= 80 && scheduled[0].delay <= 120);
  assert.equal(timers.size, 1);

  // 鼠标移出一级列表进入子菜单或菜单外时，取消待切换定时器
  primaryList.props.onMouseLeave();
  assert.equal(timers.size, 0);

  // 再次悬停并等待定时器执行，完成切换
  primaryItems[1].props.onMouseEnter({ clientX: 40, clientY: 80 });
  assert.equal(timers.size, 1);
  const [entry] = [...timers.values()];
  entry.fn();

  tree = render({ value: ["开发", "前端"], folders, onChange() {} });
  const secondaryList = nodes(tree, (item) => item.type === "ul" && String(item.props.className ?? "").includes("ui-cascade__column--secondary"))[0];
  assert.match(text(secondaryList), /文章/);
});

test("Options areSettingsEqual 忽略对象键顺序与 undefined 字段", () => {
  const { exports } = mountOptions(DEFAULT_SETTINGS);
  const { areSettingsEqual } = exports;
  const left = {
    ...DEFAULT_SETTINGS,
    provider: { ...DEFAULT_SETTINGS.provider, maxTokens: undefined, model: "gpt-4o-mini" },
    providerConfigs: { deepseek: { ...DEFAULT_SETTINGS.provider, model: "gpt-4o-mini" } },
  };
  const right = Object.fromEntries(
    Object.entries({
      ...left,
      provider: Object.fromEntries(Object.entries({ ...DEFAULT_SETTINGS.provider, model: "gpt-4o-mini" }).reverse()),
      providerConfigs: {
        deepseek: Object.fromEntries(Object.entries({ ...DEFAULT_SETTINGS.provider, model: "gpt-4o-mini" }).reverse()),
      },
    }).reverse()
  );
  assert.equal(areSettingsEqual(left, right), true);
  assert.equal(areSettingsEqual(left, { ...right, maxNestingLevel: 3 }), false);
});

test("Options 使用统一 Switch 控件并完整反映脏状态、还原与保存失败提示", async () => {
  const { render, MockSwitch } = mountOptions(DEFAULT_SETTINGS);
  let tree = render();

  const switches = nodes(tree, (item) => item.type === MockSwitch);
  assert.equal(switches.length, 4);

  const saveBarClean = nodes(tree, (item) => String(item.props.className ?? "").includes("settings-save-bar"))[0];
  assert.ok(!saveBarClean.props.className.includes("is-dirty"));
  assert.match(text(saveBarClean), /所有设置已同步/);

  const nestedSwitch = switches.find((item) => item.props["aria-label"] === "允许嵌套文件夹");
  assert.ok(nestedSwitch);
  nestedSwitch.props.onCheckedChange(!DEFAULT_SETTINGS.allowNestedFolders);

  tree = render();
  const saveBarDirty = nodes(tree, (item) => String(item.props.className ?? "").includes("settings-save-bar"))[0];
  assert.ok(saveBarDirty.props.className.includes("is-dirty"));
  assert.match(text(saveBarDirty), /有未保存的更改/);

  const discardBtn = nodes(saveBarDirty, (item) => item.type === "button" && text(item) === "还原")[0];
  assert.ok(discardBtn);
  discardBtn.props.onClick();

  tree = render();
  assert.match(text(nodes(tree, (item) => String(item.props.className ?? "").includes("settings-save-bar"))[0]), /所有设置已同步/);

  nodes(tree, (item) => item.type === MockSwitch && item.props["aria-label"] === "发送完整 URL")[0]
    .props.onCheckedChange(true);
  tree = render();
  const saveBtn = nodes(tree, (item) => item.type === "button" && text(item) === "保存设置")[0];
  await saveBtn.props.onClick();

  tree = render();
  assert.match(text(nodes(tree, (item) => String(item.props.className ?? "").includes("settings-save-bar"))[0]), /设置已保存/);

  const failing = mountOptions(DEFAULT_SETTINGS, { failSave: true });
  let failTree = failing.render();
  nodes(failTree, (item) => item.type === failing.MockSwitch && item.props["aria-label"] === "发送完整 URL")[0]
    .props.onCheckedChange(true);
  failTree = failing.render();
  await nodes(failTree, (item) => item.type === "button" && text(item) === "保存设置")[0].props.onClick();
  failTree = failing.render();
  const failBar = nodes(failTree, (item) => String(item.props.className ?? "").includes("settings-save-bar"))[0];
  assert.ok(failBar.props.className.includes("is-dirty"));
  assert.match(text(failBar), /写入失败/);
});
