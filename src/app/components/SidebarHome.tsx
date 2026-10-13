import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Bookmark,
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
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { BookmarkLinkHealthReport, BookmarkNode, FrequentBookmark, PreviewTaskCache } from "../types";
import { getFrequentBookmarks, hasHistoryPermission } from "../services/history";
import { getBookmarkFaviconUrl } from "../services/bookmarks";
import { countDuplicateGroups, getLinkHealthProblemResults } from "../services/bookmarkTasks";
import { saveCurrentPage } from "../services/currentPage";
import { getHomeTasks, getOrganizeAction } from "../services/homeTasks";
import { getIgnoredManualTaskBookmarkIds, getLinkHealthReport, getPreviewPlan } from "../services/storage";
import { getPreviewTask } from "../services/previewTask";
import { sanitizeUrl } from "../services/rules";
import { useAppStore } from "../store/useAppStore";
import { filterAvailableBookmarks, getCurrentWhitelist, whitelistFingerprint, type WhitelistIndex } from "../services/whitelist";

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
  const [toolsOpen, setToolsOpen] = useState(false);
  const [dismissedTask, setDismissedTask] = useState("");
  const [frequentBookmarks, setFrequentBookmarks] = useState<FrequentBookmark[]>([]);
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
    kind: "healthy", title: "当前没有待办事项", description: "暂时没有待审核建议或已检测出的异常。想让收藏更好找？可以生成一次分类预览。", cta: "生成智能整理预览", to: "/preview",
  });
  const taskKey = `${primary.kind}:${primary.title}:${primary.kind === "preview" ? previewIdentity : ""}`;
  const deferred = dismissedTask === taskKey;
  const queryText = query.trim().toLocaleLowerCase();
  const searchMatches = useMemo(() => queryText ? bookmarks.filter((bookmark) =>
    [bookmark.title, bookmark.url, bookmark.path.join(" / ")].some((value) => value?.toLocaleLowerCase().includes(queryText))) : [], [bookmarks, queryText]);
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
          <span><strong>ReMarks</strong><small>{busy ? "正在读取书签…" : `${bookmarks.length} 个书签 · 轻松打理`}</small></span>
        </Link>
        <Link to="/options" className="sidebar-icon-button" aria-label="设置"><Settings aria-hidden="true" /></Link>
      </header>
      {showAllTasks && <div className="home-task-intro"><Link to="/home">← 返回首页</Link><h1>任务中心</h1><p>查看待办，按需继续处理。</p></div>}
      <form className="home-search" role="search" onSubmit={(event) => { event.preventDefault(); window.location.hash = `/manage?search=${encodeURIComponent(query.trim() || "1")}`; }}>
        <Search aria-hidden="true" />
        <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} aria-label="搜索书签" placeholder="搜索书签、标题或网址…" autoComplete="off" />
        {query ? <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="清除搜索"><X aria-hidden="true" /></button> : <kbd>Ctrl / ⌘ K</kbd>}
      </form>
      {queryText && <section className="home-search-results" aria-label="搜索结果" aria-live="polite">
        {loading ? <p>正在读取书签…</p> : searchMatches.length ? <>
          {searchMatches.slice(0, 5).map((bookmark) => <a key={bookmark.id} href={bookmark.url} target="_blank" rel="noreferrer" className="home-search-result"><MiniFavicon title={bookmark.title} url={bookmark.url} /><span><strong>{bookmark.title || "未命名书签"}</strong><small>{bookmark.path.join(" / ") || getDomain(bookmark.url)}</small></span><ArrowRight aria-hidden="true" /></a>)}
          <Link to={`/manage?search=${encodeURIComponent(query.trim())}`} className="home-search-more">查看全部 {searchMatches.length} 条结果 <ArrowRight aria-hidden="true" /></Link>
        </> : <p>没有找到匹配的书签，试试标题、网址或目录名称。</p>}
      </section>}
      {(error || refreshError) && <p role="alert" className="home-notice">{error || refreshError}<button type="button" onClick={() => window.location.reload()}>重新加载</button></p>}
      {!showAllTasks && <section className="home-featured-task" aria-busy={busy} aria-labelledby="home-task-title">
        <div className="home-featured-task__heading"><span><TaskIcon aria-hidden="true" /> 下一步建议</span><small>聚焦一件事</small></div>
        <h1 id="home-task-title">{busy ? "正在读取你的任务…" : deferred ? "稍后再处理也没关系" : primary.title}</h1>
        <p>{busy ? "正在同步书签、分类建议和最近的执行记录。" : deferred ? "待办仍保留在任务中心。需要时，可重新显示刚才的建议。" : primary.description}</p>
        {!busy && <div className="home-featured-task__actions">
          {deferred ? <button type="button" className="home-primary" onClick={() => setDismissedTask("")}>重新显示建议 <ArrowRight aria-hidden="true" /></button> : <>
            <Link to={primary.to} className="home-primary">{primary.cta}<ArrowRight aria-hidden="true" /></Link>
            {model.tasks.length > 0 && !["running", "failed"].includes(primary.kind) && <button type="button" className="home-quiet-button" onClick={() => setDismissedTask(taskKey)}>稍后</button>}
          </>}
        </div>}
        <div className="home-safety-note"><ShieldCheck aria-hidden="true" /><span>敏感操作需确认，批量更改前自动备份</span></div>
      </section>}
      {(showAllTasks || model.tasks.length > 1) && <section className="home-task-queue" aria-busy={busy}>
        <div className="home-section-heading"><h2>{showAllTasks ? "全部待办" : "其他待办"}</h2>{!showAllTasks && <Link to="/tasks">查看全部 <ArrowRight aria-hidden="true" /></Link>}</div>
        {busy ? <p className="sidebar-muted-copy">正在读取任务…</p> : (showAllTasks ? model.tasks : model.tasks.slice(1)).map((task) => <Link key={task.to} to={task.to} className="home-queue-row"><span className="home-queue-row__icon">{task.kind === "links" || task.kind === "duplicate" ? <Link2 aria-hidden="true" /> : <Folder aria-hidden="true" />}</span><span>{task.label}</span><ChevronRight aria-hidden="true" /></Link>)}
        {!busy && !model.tasks.length && <p className="sidebar-muted-copy">{bookmarks.length ? "目前没有待办，可以继续浏览书签。" : "还没有书签，可收藏网页或导入已有书签。"}</p>}
      </section>}
      {!showAllTasks && model.tasks.length <= 1 && <Link to="/tasks" className="home-task-center-link">查看任务中心 <ChevronRight aria-hidden="true" /></Link>}
      <section className="home-current" aria-label="当前网页">
        <span className="home-current__icon"><Globe2 aria-hidden="true" /></span>
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
          <Link to={primary.kind === "healthy" ? "/history" : action.to} className="home-quick"><span className="home-quick__mark">{primary.kind === "healthy" ? <History aria-hidden="true" /> : <Sparkles aria-hidden="true" />}</span><span><strong>{primary.kind === "healthy" ? "常访问书签" : action.label}</strong><small>{primary.kind === "healthy" ? "本地访问统计" : "先预览，再确认"}</small></span></Link>
          <Link to="/manage" className="home-quick"><span className="home-quick__mark"><Folder aria-hidden="true" /></span><span><strong>管理书签</strong><small>搜索、编辑与保护</small></span></Link>
        </div>
      </section>
      {currentPage && currentPage.related.length > 0 && <details className="home-related"><summary>同网站的 {currentPage.related.length} 个书签</summary>{currentPage.related.map((bookmark) => <a key={bookmark.id} href={bookmark.url} target="_blank" rel="noreferrer" className="home-recent-row"><MiniFavicon title={bookmark.title} url={bookmark.url} /><span>{bookmark.title}</span><ChevronRight aria-hidden="true" /></a>)}</details>}
      <section className="home-regular">
        <div className="home-section-heading"><h2>{historyGranted ? "常访问书签" : "最近收藏"}</h2><Link to={historyGranted ? "/history" : "/manage"}>查看全部 <ArrowRight aria-hidden="true" /></Link></div>
        {(historyGranted ? frequentBookmarks.slice(0, 2) : recentBookmarks).map((bookmark) => <a key={bookmark.id} href={bookmark.url} target="_blank" rel="noreferrer" className="home-recent-row"><MiniFavicon title={bookmark.title} url={bookmark.url} /><span>{bookmark.title || "未命名书签"}</span><small>{getDomain(bookmark.url)}</small></a>)}
        {!(historyGranted ? frequentBookmarks.length : recentBookmarks.length) && <p className="sidebar-muted-copy">{busy ? "正在读取书签…" : historyGranted ? "暂时没有已收藏网站的访问记录" : "收藏网页后，会在这里显示"}</p>}
      </section>
      <div className="home-tools">
        <button type="button" className="home-tools__toggle" onClick={() => setToolsOpen((open) => !open)} aria-expanded={toolsOpen} aria-controls="home-tool-list"><Grid2X2 aria-hidden="true" /><strong>更多工具</strong><span>报告 · 备份 · 导入 · 偏好</span><ChevronDown aria-hidden="true" /></button>
        {toolsOpen && <nav id="home-tool-list" className="home-tool-list" aria-label="更多工具">{toolEntries.map(({ to, label, icon: Icon }) => <Link key={to} to={to}><Icon aria-hidden="true" /><span>{label}</span><ChevronRight aria-hidden="true" /></Link>)}<Link to="/more"><Grid2X2 aria-hidden="true" /><span>查看全部工具</span><ChevronRight aria-hidden="true" /></Link></nav>}
      </div>
      <footer className="home-footer"><ShieldCheck aria-hidden="true" /><span>分类建议由你审核，批量操作可回退</span></footer>
    </main>
  );
}
