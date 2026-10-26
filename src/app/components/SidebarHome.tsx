import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  Bookmark,
  ArrowLeft,
  ArrowRight,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  FileUp,
  Folder,
  Globe2,
  Grid2X2,
  History,
  Link2,
  Plus,
  Search,
  Settings,
  Sparkles,
  X,
  BrainCircuit,
  Zap,
} from "lucide-react";
import type { BookmarkImpressionMeta, BookmarkLinkHealthReport, BookmarkNode, FrequentBookmark, PreviewTaskCache } from "../types";
import { getFrequentBookmarks, hasHistoryPermission } from "../services/history";
import { getBookmarkFaviconUrl } from "../services/bookmarks";
import { getSemanticIndexMap, getTopImpressionKeywords } from "../services/semanticIndex";
import { getImpressionMatchIcon, isImpressionMatch, searchBookmarksByImpression } from "../services/impressionSearch";
import { useDeepImpressionSearch } from "../hooks/useDeepImpressionSearch";
import { ensureRequiredHostPermission } from "../services/hostPermissions";
import { countDuplicateGroups, getLinkHealthProblemResults } from "../services/bookmarkTasks";
import { saveCurrentPage } from "../services/currentPage";
import { getHomeTasks, getOrganizeAction } from "../services/homeTasks";
import { getIgnoredManualTaskBookmarkIds, getLinkHealthReport, getPreviewPlan } from "../services/storage";
import { getPreviewTask } from "../services/previewTask";
import { sanitizeUrl } from "../services/rules";
import { useAppStore } from "../store/useAppStore";
import { filterAvailableBookmarks, getCurrentWhitelist, whitelistFingerprint, type WhitelistIndex } from "../services/whitelist";

// 首页状态在子页面往返期间保留，避免返回时丢失滚动位置与展开的工具列表
const HOME_TOOLS_OPEN_KEY = "remarks.home.toolsOpen";
const HOME_SCROLL_KEY = "remarks.home.scrollY";
const HOME_RETURN_KEY = "remarks.home.returning";

function readHomeScroll(): number {
  try {
    const raw = sessionStorage.getItem(HOME_SCROLL_KEY);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** 只有从首页离开再返回时才恢复位置，避免从其它页面首次进入时误用旧值 */
function consumeHomeReturn(): number {
  try {
    if (sessionStorage.getItem(HOME_RETURN_KEY) !== "1") return 0;
    sessionStorage.removeItem(HOME_RETURN_KEY);
    return readHomeScroll();
  } catch {
    return 0;
  }
}

type PreviewState = "none" | "running" | "ready";
type CurrentPageState = {
  title: string;
  url: string;
  saved: boolean;
  savedPaths: string[];
  related: BookmarkNode[];
};

function getDomain(url?: string) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function MiniFavicon({ title, url }: { title: string; url?: string }) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = url && !failed ? getBookmarkFaviconUrl(url, 16) : "";

  return (
    <span className="sidebar-favicon" aria-hidden="true" title={title}>
      <Globe2 className="sidebar-favicon__fallback" />
      {faviconUrl && <img src={faviconUrl} alt="" draggable={false} onError={() => setFailed(true)} />}
    </span>
  );
}

// 当前网页卡片：优先显示站点图标，取不到时退回地球图标
function CurrentPageIcon({ title, url }: { title?: string; url?: string }) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = url && !failed ? getBookmarkFaviconUrl(url, 32) : "";

  return (
    <span className="home-current__icon" aria-hidden="true" title={title || undefined}>
      {faviconUrl ? <img src={faviconUrl} alt="" draggable={false} onError={() => setFailed(true)} /> : <Globe2 aria-hidden="true" />}
    </span>
  );
}

export async function getCurrentPage(bookmarks: BookmarkNode[]): Promise<CurrentPageState | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;

  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      const tab = tabs[0];
      if (!tab?.url || !/^https?:|^file:/.test(tab.url)) {
        resolve(null);
        return;
      }

      const currentUrl = sanitizeUrl(tab.url);
      const currentDomain = getDomain(tab.url);
      const savedBookmarks = bookmarks.filter((bookmark) => bookmark.url && sanitizeUrl(bookmark.url) === currentUrl);
      const related = currentDomain ? bookmarks
        .filter((bookmark) => bookmark.url && getDomain(bookmark.url) === currentDomain && sanitizeUrl(bookmark.url) !== currentUrl)
        .slice(0, 3) : [];

      resolve({
        title: tab.title || currentDomain || "当前网页",
        url: tab.url,
        saved: savedBookmarks.length > 0,
        savedPaths: [...new Set(savedBookmarks.map((bookmark) => bookmark.path.join(" / ") || "根目录"))],
        related,
      });
    });
  });
}

export function SidebarHome({ showAllTasks = false, compact = false }: { showAllTasks?: boolean; compact?: boolean }) {
  const { settings, bookmarks, pendingRecommendations, lastReport, loadAll, loading, error } = useAppStore();
  const [previewState, setPreviewState] = useState<PreviewState>("none");
  const [previewIdentity, setPreviewIdentity] = useState("");
  const [previewTask, setPreviewTask] = useState<PreviewTaskCache | null>(null);
  const [currentPage, setCurrentPage] = useState<CurrentPageState | null>(null);
  const [linkHealthReport, setLinkHealthReport] = useState<BookmarkLinkHealthReport | null>(null);
  const [ignoredManualTaskBookmarkIds, setIgnoredManualTaskBookmarkIds] = useState<string[]>([]);
  const [ignoredManualTaskLoaded, setIgnoredManualTaskLoaded] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [savingPage, setSavingPage] = useState(false);
  const [pageNotice, setPageNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [whitelistIndex, setWhitelistIndex] = useState<WhitelistIndex | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  // 记住「更多工具」的展开状态与离开时的滚动位置，返回首页时还原
  const [toolsOpen, setToolsOpen] = useState(() => {
    try {
      return sessionStorage.getItem(HOME_TOOLS_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [dismissedTask, setDismissedTask] = useState("");
  const [frequentBookmarks, setFrequentBookmarks] = useState<FrequentBookmark[]>([]);
  const [semanticIndex, setSemanticIndex] = useState<Record<string, BookmarkImpressionMeta>>({});
  const [searchFocused, setSearchFocused] = useState(false);
  const [historyGranted, setHistoryGranted] = useState(false);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  // 点击工具链接时立即快照滚动位置，并标记「从首页离开」
  const rememberHomeScroll = () => {
    try {
      sessionStorage.setItem(HOME_SCROLL_KEY, String(window.scrollY));
      sessionStorage.setItem(HOME_RETURN_KEY, "1");
    } catch {
      // 忽略存储失败
    }
  };

  // 记录工具列表展开状态
  useEffect(() => {
    try {
      sessionStorage.setItem(HOME_TOOLS_OPEN_KEY, toolsOpen ? "1" : "0");
    } catch {
      // 隐私模式等场景下 sessionStorage 不可用，忽略即可
    }
  }, [toolsOpen]);

  // 滚动时持续记录位置（点击链接时另有即时快照）
  useEffect(() => {
    const saveScroll = () => {
      try {
        sessionStorage.setItem(HOME_SCROLL_KEY, String(window.scrollY));
      } catch {
        // 忽略存储失败
      }
    };
    window.addEventListener("scroll", saveScroll, { passive: true });
    return () => window.removeEventListener("scroll", saveScroll);
  }, []);

  // 返回首页时还原上次的滚动位置；没有记录则回到顶部。只执行一次
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!ready || restoredRef.current) return;
    restoredRef.current = true;
    const target = consumeHomeReturn();
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo(0, target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ready]);

  useEffect(() => {
    let alive = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      setHistoryGranted(false);
      setFrequentBookmarks([]);
      if (!settings.enableHistory) return;
      try {
        if (!await hasHistoryPermission() || !alive || request !== revision) return;
        const items = await getFrequentBookmarks();
        if (alive && request === revision) { setHistoryGranted(true); setFrequentBookmarks(items); }
      } catch { /* 首页继续使用本地最近收藏，不阻断任务。 */ }
    };
    void refresh();
    // 当前 @types/chrome 的 permissions 事件缺少通用 Event 的清理方法。
    const permissionEvents = [chrome.permissions?.onRemoved, chrome.permissions?.onAdded] as Array<chrome.events.Event<() => void> | undefined>;
    permissionEvents.forEach((event) => event?.addListener(refresh));
    return () => {
      alive = false;
      permissionEvents.forEach((event) => event?.removeListener(refresh));
    };
  }, [settings.enableHistory, bookmarks]);

  useEffect(() => { setPageNotice(""); }, [currentPage?.url]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    let alive = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const [cache, task, report, protection, ignored] = await Promise.all([
          getPreviewPlan(), getPreviewTask(), getLinkHealthReport(), getCurrentWhitelist(), getIgnoredManualTaskBookmarkIds(),
        ]);
        if (!alive || request !== revision) return;
        setWhitelistIndex(protection.index);
        setLinkHealthReport(report);
        setPreviewTask(task);
        setPreviewIdentity(task?.id ?? cache?.id ?? "");
        setIgnoredManualTaskBookmarkIds(ignored);
        setIgnoredManualTaskLoaded(true);
        void getSemanticIndexMap().then((index) => { if (alive && request === revision) setSemanticIndex(index); }).catch(() => undefined);
        setPreviewState(task?.status === "running" ? "running" : task?.status === "failed" ? "none" :
          ((cache?.whitelistFingerprint === whitelistFingerprint(protection.entries) && cache.movePlan.length) || task?.movePlan?.length) ? "ready" : "none");
        setRefreshError("");
        setReady(true);
      } catch (cause) {
        if (alive) setRefreshError(cause instanceof Error ? cause.message : "任务加载失败，请重新打开首页");
      }
    };
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      void refresh();
      void loadAll();
    };
    const bookmarksChanged = () => { void refresh(); void loadAll(); };
    void refresh();
    chrome.storage?.onChanged?.addListener(changed);
    chrome.bookmarks?.onCreated?.addListener(bookmarksChanged);
    chrome.bookmarks?.onRemoved?.addListener(bookmarksChanged);
    chrome.bookmarks?.onChanged?.addListener(bookmarksChanged);
    chrome.bookmarks?.onMoved?.addListener(bookmarksChanged);
    return () => {
      alive = false;
      chrome.storage?.onChanged?.removeListener(changed);
      chrome.bookmarks?.onCreated?.removeListener(bookmarksChanged);
      chrome.bookmarks?.onRemoved?.removeListener(bookmarksChanged);
      chrome.bookmarks?.onChanged?.removeListener(bookmarksChanged);
      chrome.bookmarks?.onMoved?.removeListener(bookmarksChanged);
    };
  }, [loadAll]);

  useEffect(() => {
    let alive = true;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void getCurrentPage(bookmarks).then((page) => { if (alive && request === revision) setCurrentPage(page); });
    };
    const tabs = typeof chrome === "undefined" ? undefined : chrome.tabs;
    const windows = typeof chrome === "undefined" ? undefined : chrome.windows;
    refresh();
    tabs?.onActivated?.addListener(refresh);
    tabs?.onUpdated?.addListener(refresh);
    windows?.onFocusChanged?.addListener(refresh);
    return () => {
      alive = false;
      tabs?.onActivated?.removeListener(refresh);
      tabs?.onUpdated?.removeListener(refresh);
      windows?.onFocusChanged?.removeListener(refresh);
    };
  }, [bookmarks]);

  const actionableBookmarks = useMemo(() => whitelistIndex
    ? filterAvailableBookmarks(bookmarks, whitelistIndex) : bookmarks, [bookmarks, whitelistIndex]);

  const model = useMemo(() => getHomeTasks({
    bookmarks: actionableBookmarks, recommendations: pendingRecommendations,
    ignoredIds: ignoredManualTaskBookmarkIds, task: previewTask, hasPreview: previewState === "ready",
    failedCount: lastReport?.failedItems.length ?? 0,
    duplicateGroups: countDuplicateGroups(actionableBookmarks),
    linkProblems: linkHealthReport ? getLinkHealthProblemResults(linkHealthReport, actionableBookmarks).length : 0,
  }), [actionableBookmarks, pendingRecommendations, ignoredManualTaskBookmarkIds, previewTask, previewState, lastReport, linkHealthReport]);
  const action = getOrganizeAction(settings, previewTask, previewState === "ready");
  const busy = loading || !ready || !ignoredManualTaskLoaded;
  const primary = model.tasks[0] ?? (bookmarks.length === 0 ? {
    kind: "empty", title: "从第一个收藏开始", description: "收藏当前网页，或导入已有书签。搜索、编辑与本地维护都无需连接 AI。", cta: "导入已有书签", to: "/import",
  } : !settings.provider.apiKey.trim() || !settings.provider.enabled ? {
    kind: "local", title: "先从本地书签开始", description: "无需连接 AI，也能搜索、管理书签和检查重复项。需要智能分类时再配置模型。", cta: "查看我的书签", to: "/manage",
  } : {
    kind: "healthy", title: "当前没有待办事项", description: "暂时没有待审核建议或已检测出的异常。想让收藏更好找？可以生成一次整理方案。", cta: "生成整理方案", to: "/preview",
  });
  const taskKey = `${primary.kind}:${primary.title}:${primary.kind === "preview" ? previewIdentity : ""}`;
  const deferred = dismissedTask === taskKey;
  const queryText = query.trim();
  const searchableBookmarks = useMemo(() => bookmarks.flatMap((bookmark) => bookmark.url ? [{
    id: bookmark.id,
    title: bookmark.title,
    url: bookmark.url,
    folderPath: bookmark.path.join(" / "),
  }] : []), [bookmarks]);
  const existingTopFolders = useMemo(() => {
    const names = new Set<string>();
    bookmarks.forEach((bookmark) => {
      const top = bookmark.path[0];
      if (top) names.add(top);
    });
    return [...names].slice(0, 30);
  }, [bookmarks]);

  const {
    state: deepSearchState,
    run: runDeepSearch,
    cancel: cancelDeepSearch,
    hasResult: hasDeepResult,
    running: deepSearchRunning,
  } = useDeepImpressionSearch({
    bookmarks: searchableBookmarks,
    semanticIndexMap: semanticIndex,
    existingTopFolders,
  });

  const localSearchMatches = useMemo(() => queryText
    ? searchBookmarksByImpression(queryText, searchableBookmarks, semanticIndex)
    : [], [queryText, searchableBookmarks, semanticIndex]);
  const deepSearchActive = hasDeepResult && deepSearchState.query === queryText;
  const searchMatches = deepSearchActive
    ? deepSearchState.results ?? []
    : localSearchMatches;

  // 输入变化时中止上一次深度搜索，防止旧结果覆盖新列表。
  useEffect(() => {
    if (deepSearchState.query && deepSearchState.query !== queryText) cancelDeepSearch();
  }, [cancelDeepSearch, deepSearchState.query, queryText]);

  const handleDeepSearch = async () => {
    if (!queryText || deepSearchRunning) return;
    if (!settings.provider.apiKey.trim() || !settings.provider.enabled) {
      setPageNotice("使用“帮我找找”前，请先在设置中连接并授权 AI 服务");
      return;
    }
    // Firefox 必须在用户手势内请求权限，先于任何存储读取。
    try {
      await ensureRequiredHostPermission();
    } catch (error) {
      setPageNotice(error instanceof Error ? error.message : "未授予网站访问权限");
      return;
    }
    runDeepSearch(queryText);
  };
  const impressionSuggestions = useMemo(() => getTopImpressionKeywords(semanticIndex, 6), [semanticIndex]);
  const recentBookmarks = useMemo(() => [...bookmarks].sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0)).slice(0, 2), [bookmarks]);
  const TaskIcon = primary.kind === "links" || primary.kind === "duplicate" ? Link2 : primary.kind === "healthy" ? CheckCircle2 : Sparkles;
  const toolEntries = [
    { to: "/report", label: "整理报告", icon: FileText },
    { to: "/backups", label: "书签备份", icon: Archive },
    { to: "/import", label: "导入书签", icon: FileUp },
    { to: "/habits", label: "分类偏好", icon: Sparkles },
  ];

  return (
    <main className={`sidebar-home home-v2${compact ? " home-v2--compact" : ""}`}>
      <header className="home-heading">
        <Link to="/home" className="remarks-brand" aria-label="ReMarks 首页">
          <span className="remarks-brand__mark"><Bookmark aria-hidden="true" /></span>
          <span><strong>ReMarks</strong><small>{busy ? "正在读取书签…" : `${bookmarks.length} 个书签`}</small></span>
        </Link>
        <Link to="/options" className="sidebar-icon-button" aria-label="设置"><Settings aria-hidden="true" /></Link>
      </header>
      {showAllTasks && <div className="home-task-intro">
        <div className="remarks-page-intro__row">
          <button
            type="button"
            className="extension-page__back"
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/home"))}
            aria-label="返回上一页"
            title="返回上一页"
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <h1 className="extension-page__title">任务中心</h1>
        </div>
      </div>}
      <form className="home-search" role="search" onSubmit={(event) => { event.preventDefault(); window.location.hash = `/manage?search=${encodeURIComponent(query.trim() || "1")}`; }}>
        <Search aria-hidden="true" />
        <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { setQuery(""); return; }
          if (event.key === "Enter" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault();
            if (!event.repeat) void handleDeepSearch();
          }
        }} aria-label="搜索书签" placeholder="搜索标题、网址或用途" autoComplete="off" />
        {query ? <>
          <button type="button" className="home-search__ai" onClick={() => void handleDeepSearch()} disabled={!queryText || deepSearchRunning} aria-keyshortcuts="Alt+Enter" title="用 AI 根据描述查找书签（Alt + Enter）"><BrainCircuit aria-hidden="true" /><span>{deepSearchRunning ? "查找中…" : "帮我找找"}</span></button>
          <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="清除搜索"><X aria-hidden="true" /></button>
        </> : <kbd>Ctrl / ⌘ K</kbd>}
      </form>
      {!queryText && searchFocused && impressionSuggestions.length > 0 && <div className="home-impression-chips" aria-label="功能印象快捷搜索">
        {impressionSuggestions.map((keyword) => <button key={keyword} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { setQuery(keyword); searchRef.current?.focus(); }}>{keyword}</button>)}
      </div>}
      {queryText && (deepSearchState.stage !== "idle" || deepSearchState.error) && <div className={`home-deep-status home-deep-status--${deepSearchState.error ? "error" : deepSearchState.stage}`} role="status" aria-live="polite">
        <span>{deepSearchState.error ? `AI 查找失败：${deepSearchState.error}` : deepSearchState.stage === "expanding" ? <><BrainCircuit aria-hidden="true" />正在联想相关功能与常见网站…</> : deepSearchState.stage === "expanded_shown" ? <><BrainCircuit aria-hidden="true" />AI 已联想，正在筛选更匹配的书签…</> : <><CheckCircle2 aria-hidden="true" />AI 查找完成</>}</span>
        {deepSearchState.expandedTerms.length > 0 && deepSearchState.stage !== "error" && <span className="home-deep-status__terms">{deepSearchState.expandedTerms.map((term) => <b key={term}>{term}</b>)}</span>}
      </div>}
      {queryText && <section className="home-search-results" aria-label="搜索结果" aria-live="polite">
        {loading ? <p>正在读取书签…</p> : searchMatches.length ? <>
          {searchMatches.slice(0, 5).map((result) => {
            const bookmark = bookmarks.find((item) => item.id === result.bookmark.id);
            if (!bookmark) return null;
            return <a key={bookmark.id} href={bookmark.url} target="_blank" rel="noreferrer" className="home-search-result"><MiniFavicon title={bookmark.title} url={bookmark.url} /><span><strong>{bookmark.title || "未命名书签"}</strong><small>{bookmark.path.join(" / ") || getDomain(bookmark.url)}</small>{result.matchHint && isImpressionMatch(result) && <em className="home-search-result__match">{getImpressionMatchIcon(result)} {result.matchHint}{result.healed && <i className="impression-healed-badge"><Zap aria-hidden="true" />已记住该印象</i>}</em>}{!result.matchHint && result.displayTags.length > 0 && <span className="home-search-result__tags">{result.displayTags.slice(0, 3).map((tag) => <b key={tag}>{tag}</b>)}</span>}</span><ArrowRight aria-hidden="true" /></a>;
          })}
          <Link to={`/manage?search=${encodeURIComponent(queryText)}`} className="home-search-more">查看全部 {searchMatches.length} 条结果 <ArrowRight aria-hidden="true" /></Link>
        </> : deepSearchRunning ? <p>AI 正在根据描述查找书签…</p> : <>
          <p>没有找到匹配的书签</p>
          <button type="button" className="home-search-deep" onClick={() => void handleDeepSearch()}><BrainCircuit aria-hidden="true" />帮我找找「{queryText}」</button>
        </>}
      </section>}
      {(error || refreshError) && <p role="alert" className="home-notice">{error || refreshError}<button type="button" onClick={() => window.location.reload()}>重新加载</button></p>}
      {!showAllTasks && <section className="home-featured-task" aria-busy={busy} aria-labelledby="home-task-title">
        <div className="home-featured-task__heading"><span><TaskIcon aria-hidden="true" /> 下一步建议</span></div>
        <h1 id="home-task-title">{busy ? "正在读取你的任务…" : deferred ? "稍后再处理也没关系" : primary.title}</h1>
        <p>{busy ? "正在同步书签、分类建议和最近的执行记录。" : deferred ? "待办仍保留在任务中心。需要时，可重新显示刚才的建议。" : primary.description}</p>
        {!busy && <div className="home-featured-task__actions">
          {deferred ? <button type="button" className="home-primary" onClick={() => setDismissedTask("")}>重新显示建议 <ArrowRight aria-hidden="true" /></button> : <>
            <Link to={primary.to} className="home-primary">{primary.cta}<ArrowRight aria-hidden="true" /></Link>
            {model.tasks.length > 0 && !["running", "failed"].includes(primary.kind) && <button type="button" className="home-quiet-button" onClick={() => setDismissedTask(taskKey)}>稍后</button>}
          </>}
        </div>}
      </section>}
      {(showAllTasks || model.tasks.length > 1) && <section className="home-task-queue" aria-busy={busy}>
        <div className="home-section-heading"><h2>{showAllTasks ? "全部待办" : "其他待办"}</h2>{!showAllTasks && <Link to="/tasks">查看全部 <ArrowRight aria-hidden="true" /></Link>}</div>
        {busy ? <p className="sidebar-muted-copy">正在读取任务…</p> : (showAllTasks ? model.tasks : model.tasks.slice(1)).map((task) => <Link key={task.to} to={task.to} className="home-queue-row"><span className="home-queue-row__icon">{task.kind === "links" || task.kind === "duplicate" ? <Link2 aria-hidden="true" /> : <Folder aria-hidden="true" />}</span><span>{task.label}</span><ChevronRight aria-hidden="true" /></Link>)}
        {!busy && !model.tasks.length && <p className="sidebar-muted-copy">{bookmarks.length ? "目前没有待办，可以继续浏览书签。" : "还没有书签，可收藏网页或导入已有书签。"}</p>}
      </section>}
      {!showAllTasks && model.tasks.length <= 1 && <Link to="/tasks" className="home-task-center-link">查看任务中心 <ChevronRight aria-hidden="true" /></Link>}
      <section className="home-current" aria-label="当前网页">
        <CurrentPageIcon title={currentPage?.title} url={currentPage?.url} />
        <div className="home-current__main"><small>当前网页</small><strong title={currentPage?.title}>{currentPage ? getDomain(currentPage.url) || currentPage.title : "打开网页后可查看收藏状态"}</strong>
          {currentPage?.saved && <span title={currentPage.savedPaths.join("、")}>{currentPage.savedPaths.join("、")}</span>}
        </div>
        {currentPage && (currentPage.saved ? <Link to={`/manage?search=${encodeURIComponent(sanitizeUrl(currentPage.url))}`} className="home-current__saved" title="按忽略 query / hash 匹配，点击查看或编辑"><CheckCircle2 aria-hidden="true" />已收藏</Link> : <button type="button" className="home-current__save" disabled={savingPage || !/^https?:\/\//i.test(currentPage.url)} onClick={() => {
          setSavingPage(true);
          setPageNotice("");
          void saveCurrentPage(currentPage.title, currentPage.url).then(async (result) => { setPageNotice(result.created ? "已收藏，可继续选择归档目录" : "该完整 URL 已收藏，未重复创建"); await loadAll(); }).catch((cause) => setPageNotice(cause instanceof Error ? cause.message : "收藏失败")).finally(() => setSavingPage(false));
        }}><Plus aria-hidden="true" />{savingPage ? "收藏中…" : "收藏"}</button>)}
      </section>
      {pageNotice && <p className="home-inline-notice" role="status">{pageNotice} <Link to="/recommendations">选择目录</Link></p>}
      <section className="home-regular">
        <div className="home-section-heading"><h2>常用操作</h2></div>
        <div className="home-quick-grid">
          {(primary.kind === "healthy" || primary.to !== action.to) && <Link to={primary.kind === "healthy" ? "/history" : action.to} className="home-quick"><span className="home-quick__mark">{primary.kind === "healthy" ? <History aria-hidden="true" /> : <Sparkles aria-hidden="true" />}</span><span><strong>{primary.kind === "healthy" ? "常访问书签" : action.label}</strong></span></Link>}
          <Link to="/manage" className="home-quick"><span className="home-quick__mark"><Folder aria-hidden="true" /></span><span><strong>管理书签</strong></span></Link>
        </div>
      </section>
      {currentPage && currentPage.related.length > 0 && <details className="home-related"><summary>同网站的 {currentPage.related.length} 个书签</summary>{currentPage.related.map((bookmark) => <a key={bookmark.id} href={bookmark.url} target="_blank" rel="noreferrer" className="home-recent-row"><MiniFavicon title={bookmark.title} url={bookmark.url} /><span>{bookmark.title}</span><ChevronRight aria-hidden="true" /></a>)}</details>}
      <section className="home-regular">
        <div className="home-section-heading"><h2>{historyGranted ? "常访问书签" : "最近收藏"}</h2><Link to={historyGranted ? "/history" : "/manage"}>查看全部 <ArrowRight aria-hidden="true" /></Link></div>
        {(historyGranted ? frequentBookmarks.slice(0, 2) : recentBookmarks).map((bookmark) => <a key={bookmark.id} href={bookmark.url} target="_blank" rel="noreferrer" className="home-recent-row"><MiniFavicon title={bookmark.title} url={bookmark.url} /><span>{bookmark.title || "未命名书签"}</span><small>{getDomain(bookmark.url)}</small></a>)}
        {!(historyGranted ? frequentBookmarks.length : recentBookmarks.length) && <p className="sidebar-muted-copy">{busy ? "正在读取书签…" : historyGranted ? "暂时没有已收藏网站的访问记录" : "收藏网页后，会在这里显示"}</p>}
      </section>
      <div className="home-tools">
        <button type="button" className="home-tools__toggle" onClick={() => setToolsOpen((open) => !open)} aria-expanded={toolsOpen} aria-controls="home-tool-list"><Grid2X2 aria-hidden="true" /><strong>更多工具</strong><span>报告、备份、导入和偏好</span><ChevronDown aria-hidden="true" /></button>
        {toolsOpen && <nav id="home-tool-list" className="home-tool-list" aria-label="更多工具" onClickCapture={rememberHomeScroll}>{toolEntries.map(({ to, label, icon: Icon }) => <Link key={to} to={to}><Icon aria-hidden="true" /><span>{label}</span><ChevronRight aria-hidden="true" /></Link>)}<Link to="/more"><Grid2X2 aria-hidden="true" /><span>查看全部工具</span><ChevronRight aria-hidden="true" /></Link></nav>}
      </div>
    </main>
  );
}
