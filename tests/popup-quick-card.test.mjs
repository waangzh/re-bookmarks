import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { loadService } from "./load-service.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const { resolvePopupQuickTarget } = await loadService("src/app/services/popupQuickCard.ts");
const {
  canOpenExtensionSidebar,
  openExtensionSidebar,
  getPendingAnalysisBookmarkIds,
  PENDING_ANALYSIS_STATUS_MESSAGE,
} = await loadService("src/app/services/sidePanel.ts");

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
    Error,
    URL,
    Promise,
    Set,
    console: { debug() {}, error() {} },
    ...globals,
  };
  vm.runInNewContext(code, context, { filename: relPath });
  return context.exports;
}

function mountPopupQuickCard(overrides = {}) {
  const state = [];
  let cursor = 0;
  const calls = {
    savedPages: [],
    accepted: [],
    updatedPaths: [],
    habitFeedbacks: [],
    removed: [],
    protectedIds: [],
    retried: [],
    refreshed: 0,
    currentPageSaved: [],
  };
  const MockFolderPathSelect = () => null;
  const recommendation = (id, overridesRec = {}) => ({
    id: `rec-${id}`,
    bookmarkId: id,
    bookmarkTitle: `书签 ${id}`,
    bookmarkUrl: `https://${id}.test/docs`,
    createdAt: 100,
    suggestedFolderPath: ["开发", "文档"],
    currentFolderPath: ["书签栏"],
    sourceParentId: "1",
    source: "ai",
    expectedTargetId: "target",
    confidence: 0.9,
    kind: "move",
    reason: "根据网页主题匹配现有开发文档目录",
    ...overridesRec,
  });

  const exports = transpileComponent("src/app/components/PopupQuickCard.tsx", {
    react: {
      useCallback: (fn) => fn,
      useEffect() {},
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useState(initial) {
        const index = cursor++;
        if (state.length <= index) state[index] = typeof initial === "function" ? initial() : initial;
        return [
          state[index],
          (next) => {
            state[index] = typeof next === "function" ? next(state[index]) : next;
          },
        ];
      },
    },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "react-router": { Link: ({ to, children, ...props }) => ({ type: "a", props: { href: to, ...props, children } }) },
    "lucide-react": require("lucide-react"),
    "../services/recommendations": {
      acceptRecommendation: async (rec) => {
        calls.accepted.push(rec.id);
        return overrides.acceptResult ?? { failedItems: [], movedCount: 1 };
      },
      getRecommendationKind: (rec) => rec.kind ?? "move",
      getRecommendationSignalLabel: (rec) => (rec.source === "manual" ? "你已指定" : "依据较充分"),
      isActionableRecommendation: (rec) => (rec.kind === "move" || rec.kind === "create_folder") && rec.suggestedFolderPath.length > 0,
      removeRecommendation: async (id) => {
        calls.removed.push(id);
      },
      retryRecommendation: async (rec) => {
        calls.retried.push(rec.id);
        return rec;
      },
      updateRecommendationFolderPath: async (id, folderPath) => {
        calls.updatedPaths.push({ id, folderPath });
        return [];
      },
    },
    "../services/bookmarks": {
      getAllBookmarkFolders: async () => [],
      getBookmarkFaviconUrl: () => "",
      parseFolderPath: (draft) => draft.split("/").map((item) => item.trim()).filter(Boolean),
    },
    "../services/currentPage": {
      saveCurrentPage: async (title, url) => {
        calls.savedPages.push({ title, url });
        return { created: true, id: "bm-new-1" };
      },
    },
    "../services/habits": {
      recordHabitFeedback: async (payload) => {
        calls.habitFeedbacks.push(payload);
        return "已记录这次目录修正";
      },
    },
    "../services/rules": {
      sanitizeUrl: (raw) => {
        const parsed = new URL(raw);
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      },
    },
    "../services/sidePanel": {
      getPendingAnalysisBookmarkIds: async () => [],
      isPendingAnalysisUpdatedMessage: () => false,
    },
    "../services/popupQuickCard": { resolvePopupQuickTarget },
    "../services/whitelist": {
      addBookmarkWhitelistEntry: async (_type, id) => {
        calls.protectedIds.push(id);
      },
    },
    "./FolderPathSelect": { FolderPathSelect: MockFolderPathSelect },
    "./RecommendationActionHelp": {
      protectBookmarkHelp: "保护帮助",
      skipRecommendationHelp: "跳过帮助",
    },
  });

  const render = (props) => {
    cursor = 0;
    return exports.PopupQuickCard({
      maxNestingLevel: 2,
      onRefresh: () => {
        calls.refreshed += 1;
      },
      onCurrentPageSaved: (url) => {
        calls.currentPageSaved.push(url);
      },
      ...props,
    });
  };

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  return { render, state, calls, recommendation, MockFolderPathSelect, flush };
}

test("resolvePopupQuickTarget 优先匹配当前页推荐与分析中状态，并兜底最新刚收藏推荐", () => {
  const bookmarks = [
    { id: "bm-1", title: "文档", url: "https://a.test/guide?from=nav", path: ["书签栏"], type: "url" },
    { id: "bm-2", title: "工具", url: "https://b.test/tool", path: ["书签栏"], type: "url" },
  ];
  const recOld = {
    id: "rec-old",
    bookmarkId: "bm-2",
    bookmarkTitle: "工具",
    bookmarkUrl: "https://b.test/tool",
    createdAt: 100,
    suggestedFolderPath: ["工具"],
    confidence: 0.8,
  };
  const recCurrent = {
    id: "rec-curr",
    bookmarkId: "bm-1",
    bookmarkTitle: "文档",
    bookmarkUrl: "https://a.test/guide?saved=1",
    createdAt: 200,
    suggestedFolderPath: ["开发"],
    confidence: 0.9,
  };

  const matched = resolvePopupQuickTarget({
    currentPage: {
      title: "当前文档",
      url: "https://a.test/guide?view=2#top",
      saved: true,
      savedPaths: ["书签栏"],
      related: [],
    },
    bookmarks,
    pendingRecommendations: [recOld, recCurrent],
    analyzingBookmarkIds: [],
  });
  assert.equal(matched.currentRecommendation?.id, "rec-curr");
  assert.equal(matched.isAnalyzingCurrent, false);
  assert.equal(matched.latestOtherRecommendation?.id, "rec-old");

  const analyzing = resolvePopupQuickTarget({
    currentPage: {
      title: "当前文档",
      url: "https://a.test/guide",
      saved: true,
      savedPaths: ["书签栏"],
      related: [],
    },
    bookmarks,
    pendingRecommendations: [recOld],
    analyzingBookmarkIds: ["bm-1"],
  });
  assert.equal(analyzing.currentRecommendation, null);
  assert.equal(analyzing.isAnalyzingCurrent, true);

  const crossTab = resolvePopupQuickTarget({
    currentPage: {
      title: "未收藏页面",
      url: "https://c.test/",
      saved: false,
      savedPaths: [],
      related: [],
    },
    bookmarks,
    pendingRecommendations: [recOld, recCurrent],
    analyzingBookmarkIds: [],
  });
  assert.equal(crossTab.currentRecommendation, null);
  assert.equal(crossTab.latestOtherRecommendation?.id, "rec-curr");
});

test("PopupQuickCard 支持未收藏页一键收藏并立即进入分析态，且支持归档、新建确认、改目录、跳过与保护", async () => {
  // 1. 未收藏当前页 -> 点击收藏
  {
    const { render, calls, flush } = mountPopupQuickCard();
    let tree = render({
      currentPage: {
        title: "React 文档",
        url: "https://react.dev/learn",
        saved: false,
        savedPaths: [],
        related: [],
      },
      bookmarks: [],
      pendingRecommendations: [],
    });
    const saveBtn = nodes(tree, (item) => item.type === "button" && text(item).includes("收藏"))[0];
    assert.ok(saveBtn);
    saveBtn.props.onClick();
    await flush();

    assert.equal(calls.savedPages.length, 1);
    assert.deepEqual(calls.currentPageSaved, ["https://react.dev/learn"]);

    tree = render({
      currentPage: {
        title: "React 文档",
        url: "https://react.dev/learn",
        saved: true,
        savedPaths: ["书签栏"],
        related: [],
      },
      bookmarks: [{ id: "bm-new-1", title: "React 文档", url: "https://react.dev/learn", path: ["书签栏"], type: "url" }],
      pendingRecommendations: [],
    });
    assert.match(text(tree), /正在分析/);
  }

  // 2. move 推荐一键归档 -> 成功反馈 / 失败不报成功
  {
    const { render, calls, recommendation, flush } = mountPopupQuickCard();
    const rec = recommendation("a");
    let tree = render({
      currentPage: { title: "文档", url: "https://a.test/docs", saved: true, savedPaths: ["书签栏"], related: [] },
      bookmarks: [{ id: "a", title: "书签 a", url: "https://a.test/docs", path: ["书签栏"], type: "url" }],
      pendingRecommendations: [rec],
    });
    assert.match(text(tree), /当前网页 归档建议/);
    const archiveBtn = nodes(tree, (item) => item.type === "button" && text(item).includes("归档"))[0];
    archiveBtn.props.onClick();
    await flush();
    assert.deepEqual(calls.accepted, ["rec-a"]);
    tree = render({
      currentPage: { title: "文档", url: "https://a.test/docs", saved: true, savedPaths: ["开发", "文档"], related: [] },
      bookmarks: [{ id: "a", title: "书签 a", url: "https://a.test/docs", path: ["开发", "文档"], type: "url" }],
      pendingRecommendations: [],
    });
    assert.match(text(tree), /已归档至 开发 \/ 文档/);
    assert.match(text(tree), /查看报告/);
  }

  {
    const { render, recommendation, flush } = mountPopupQuickCard({
      acceptResult: { failedItems: [{ bookmarkId: "a", bookmarkTitle: "书签 a", reason: "目标目录受保护" }], movedCount: 0 },
    });
    const rec = recommendation("a");
    let tree = render({
      currentPage: null,
      bookmarks: [{ id: "a", title: "书签 a", url: "https://a.test/docs", path: ["书签栏"], type: "url" }],
      pendingRecommendations: [rec],
    });
    const archiveBtn = nodes(tree, (item) => item.type === "button" && text(item).includes("归档"))[0];
    archiveBtn.props.onClick();
    await flush();
    tree = render({
      currentPage: null,
      bookmarks: [{ id: "a", title: "书签 a", url: "https://a.test/docs", path: ["书签栏"], type: "url" }],
      pendingRecommendations: [rec],
    });
    assert.match(text(tree), /归档失败：目标目录受保护/);
  }

  // 3. create_folder 保留二次确认，改目录/跳过/保护正常触发
  {
    const { render, calls, recommendation, MockFolderPathSelect, flush } = mountPopupQuickCard();
    const rec = recommendation("newdir", { kind: "create_folder", suggestedFolderPath: ["新分类", "资料"] });
    const props = {
      currentPage: null,
      bookmarks: [{ id: "newdir", title: "书签 newdir", url: "https://newdir.test/docs", path: ["书签栏"], type: "url" }],
      pendingRecommendations: [rec],
    };
    let tree = render(props);
    const firstBtn = nodes(tree, (item) => item.type === "button" && text(item) === "将创建目录")[0];
    assert.ok(firstBtn);
    firstBtn.props.onClick();
    await flush();
    assert.deepEqual(calls.accepted, []);

    tree = render(props);
    const confirmBtn = nodes(tree, (item) => item.type === "button" && text(item) === "确认创建并归档")[0];
    assert.ok(confirmBtn);

    const editBtn = nodes(tree, (item) => item.type === "button" && text(item) === "改目录")[0];
    editBtn.props.onClick();
    tree = render(props);
    const folderSelect = nodes(tree, (item) => item.type === MockFolderPathSelect)[0];
    assert.ok(folderSelect);
    folderSelect.props.onChange("开发 / 工具");
    tree = render(props);
    const savePathBtn = nodes(tree, (item) => item.type === "button" && text(item) === "保存目标")[0];
    savePathBtn.props.onClick();
    await flush();
    assert.deepEqual(calls.updatedPaths, [{ id: "rec-newdir", folderPath: ["开发", "工具"] }]);
    assert.equal(calls.habitFeedbacks.length, 1);

    tree = render(props);
    nodes(tree, (item) => item.type === "button" && text(item) === "跳过建议")[0].props.onClick();
    nodes(tree, (item) => item.type === "button" && text(item) === "保护此书签")[0].props.onClick();
    await flush();
    assert.deepEqual(calls.removed, ["rec-newdir"]);
    assert.deepEqual(calls.protectedIds, ["newdir"]);
  }
});

test("sidePanel 服务适配 Chromium sidePanel.open、Firefox sidebarAction.open 与分析状态查询", async () => {
  const prevChrome = globalThis.chrome;
  const prevBrowser = globalThis.browser;
  try {
    let openedWindowId = null;
    globalThis.browser = undefined;
    globalThis.chrome = {
      sidePanel: {
        open: async ({ windowId }) => {
          openedWindowId = windowId;
        },
      },
      runtime: {
        sendMessage: async (msg) => {
          assert.equal(msg.type, PENDING_ANALYSIS_STATUS_MESSAGE);
          return { bookmarkIds: ["bm-1", "", 123] };
        },
      },
    };
    assert.equal(canOpenExtensionSidebar(), true);
    await openExtensionSidebar(42);
    assert.equal(openedWindowId, 42);
    assert.deepEqual(await getPendingAnalysisBookmarkIds(), ["bm-1"]);

    let firefoxOpened = false;
    globalThis.chrome = undefined;
    globalThis.browser = {
      sidebarAction: {
        open: async () => {
          firefoxOpened = true;
        },
      },
    };
    assert.equal(canOpenExtensionSidebar(), true);
    await openExtensionSidebar();
    assert.equal(firefoxOpened, true);
  } finally {
    globalThis.chrome = prevChrome;
    globalThis.browser = prevBrowser;
  }
});

test("PopupHome 仅保留快捷卡、搜索与高频入口，省略完整待办大卡与工具长菜单", () => {
  const state = [];
  let cursor = 0;
  const MockQuickCard = () => ({ type: "MockQuickCard", props: {} });
  const exports = transpileComponent("src/app/components/PopupHome.tsx", {
    react: {
      useEffect() {},
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useState(initial) {
        const index = cursor++;
        if (state.length <= index) state[index] = typeof initial === "function" ? initial() : initial;
        return [
          state[index],
          (next) => {
            state[index] = typeof next === "function" ? next(state[index]) : next;
          },
        ];
      },
    },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "react-router": { Link: ({ to, children, ...props }) => ({ type: "a", props: { href: to, ...props, children } }) },
    "lucide-react": require("lucide-react"),
    "../services/bookmarks": { getBookmarkFaviconUrl: () => "" },
    "../services/bookmarkTasks": { countDuplicateGroups: () => 1, getLinkHealthProblemResults: () => [] },
    "../services/homeTasks": {
      getHomeTasks: () => ({
        pendingCount: 2,
        tasks: [
          { kind: "archive", label: "2 个书签待归档", to: "/manage?task=unsorted", title: "待归档", description: "", cta: "" },
          { kind: "duplicate", label: "1 组重复链接", to: "/manage?task=duplicate", title: "重复", description: "", cta: "" },
        ],
      }),
      getOrganizeAction: () => ({ label: "开始智能整理", to: "/preview" }),
    },
    "../services/hostPermissions": { ensureRequiredHostPermission: async () => {} },
    "../services/impressionSearch": {
      getImpressionMatchIcon: () => "",
      isImpressionMatch: () => false,
      searchBookmarksByImpression: () => [],
    },
    "../services/previewTask": { getPreviewTask: async () => null },
    "../services/semanticIndex": { getSemanticIndexMap: async () => ({}) },
    "../services/sidePanel": { canOpenExtensionSidebar: () => true, openExtensionSidebar: async () => {} },
    "../services/storage": {
      getIgnoredManualTaskBookmarkIds: async () => [],
      getLinkHealthReport: async () => null,
      getPreviewPlan: async () => null,
    },
    "../services/whitelist": {
      filterAvailableBookmarks: (items) => items,
      getCurrentWhitelist: async () => ({ entries: [], index: null }),
      whitelistFingerprint: () => "",
    },
    "../hooks/useDeepImpressionSearch": {
      useDeepImpressionSearch: () => ({
        state: { query: "", stage: "idle", expandedTerms: [] },
        run() {},
        cancel() {},
        hasResult: false,
        running: false,
      }),
    },
    "../hooks/useDuplicateBookmarkIgnores": {
      useDuplicateBookmarkIgnores: () => ({ entries: [], error: "" }),
      useLinkHealthBookmarkIgnores: () => ({ entries: [], error: "" }),
    },
    "../store/useAppStore": {
      useAppStore: () => ({
        settings: { maxNestingLevel: 2, provider: { apiKey: "k", enabled: true } },
        bookmarks: [{ id: "1", title: "示例", url: "https://example.test/", path: [], type: "url" }],
        pendingRecommendations: [],
        lastReport: null,
        loadAll() {},
        loading: false,
        error: "",
      }),
    },
    "./PopupQuickCard": { PopupQuickCard: MockQuickCard },
    "./SearchKeywordDropdown": { SearchKeywordDropdown: () => null },
    "./SidebarHome": { getCurrentPage: async () => null },
    "./TopNotice": { TopNotice: () => null, TopNotices: () => null },
  });

  const tree = exports.PopupHome();
  assert.equal(nodes(tree, (item) => item.type === MockQuickCard).length, 1);
  assert.equal(nodes(tree, (item) => String(item.props.className ?? "").includes("home-featured-task")).length, 0);
  assert.equal(nodes(tree, (item) => String(item.props.className ?? "").includes("home-recent-row")).length, 0);
  assert.equal(nodes(tree, (item) => String(item.props.className ?? "").includes("home-tool-list")).length, 0);
  assert.equal(nodes(tree, (item) => item.props.className === "home-quick").length, 2);
  assert.match(text(tree), /另有 1 项待办，去侧边栏处理/);
});
