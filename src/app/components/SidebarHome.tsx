import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Bookmark,
  CheckCircle2,
  ChevronRight,
  FileText,
  Globe2,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import type { BookmarkLinkHealthReport, BookmarkNode, PreviewTaskCache } from "../types";
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

async function getCurrentPage(bookmarks: BookmarkNode[]): Promise<CurrentPageState | null> {
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
      const saved = bookmarks.some((bookmark) => bookmark.url && sanitizeUrl(bookmark.url) === currentUrl);
      const related = bookmarks
        .filter((bookmark) => bookmark.url && getDomain(bookmark.url) === currentDomain && sanitizeUrl(bookmark.url) !== currentUrl)
        .slice(0, 3);

      resolve({
        title: tab.title || currentDomain || "当前网页",
        url: tab.url,
        saved,
        related,
      });
    });
  });
}

export function SidebarHome({ showAllTasks = false, compact = false }: { showAllTasks?: boolean; compact?: boolean }) {
  const { settings, bookmarks, pendingRecommendations, lastReport, loadAll, loading, error } = useAppStore();
  const [previewState, setPreviewState] = useState<PreviewState>("none");
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
    void getCurrentPage(bookmarks).then((page) => {
      if (alive) setCurrentPage(page);
    });
    return () => {
      alive = false;
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
  const reviewCount = new Set([
    ...(lastReport?.failedItems.map((item) => item.bookmarkId) ?? []),
    ...(linkHealthReport ? getLinkHealthProblemResults(linkHealthReport, actionableBookmarks).map((item) => item.bookmarkId) : []),
  ]).size;
  const action = getOrganizeAction(settings, previewTask, previewState === "ready");
  const busy = loading || !ready || !ignoredManualTaskLoaded;

  return (
    <main className="sidebar-home home-v2">
      <header className="home-heading"><span><Bookmark className="w-5 h-5" /> {showAllTasks ? "任务中心" : "ReMarks"}</span><Link to="/options" className="sidebar-icon-button" aria-label="设置"><Settings className="w-4 h-4" /></Link></header>
      <Link to="/manage?search=1" className="sidebar-search-link"><Search className="w-4 h-4" /><span>搜索书签标题、网址或文件夹</span></Link>
      {(error || refreshError) && <p role="alert" className="home-notice">{error || refreshError}<button type="button" onClick={() => window.location.reload()}>重新加载</button></p>}
      <section className="home-stats" aria-label="书签状态" aria-busy={busy}>
        {[{ label: "书签总数", count: bookmarks.length, to: "/manage" }, { label: "待处理", count: model.pendingCount, to: "/recommendations" }, { label: "需复查", count: reviewCount, to: "/tasks" }].map((item) =>
          <Link key={item.label} to={item.to}><span>{item.label}</span><strong className={busy ? "home-skeleton" : ""}>{busy ? "…" : item.count}</strong></Link>)}
      </section>
      <section className="sidebar-panel">
        <div className="sidebar-panel__head"><span><Sparkles className="w-4 h-4" />建议处理</span><Link to="/tasks">全部任务</Link></div>
        {busy ? <p className="sidebar-muted-copy">正在读取任务…</p> : model.tasks.length ? <div className="sidebar-suggestion-list">{model.tasks.slice(0, showAllTasks ? undefined : compact ? 1 : 3).map((task) =>
          <Link key={task.to} to={task.to} className="sidebar-suggestion-row"><span>{task.label}</span><ChevronRight className="w-4 h-4" /></Link>)}</div> : <p className="sidebar-muted-copy">{bookmarks.length ? "目前没有需要处理的书签" : "先收藏一个网页，或从更多工具导入书签"}</p>}
        <p className="sidebar-muted-copy">{linkHealthReport ? "链接检测结果可能受网络和登录状态影响" : "链接健康尚未检测"}</p>
      </section>
      <Link to={action.to} className="sidebar-primary-action"><FileText className="w-4 h-4" /><span>{action.label}</span><ChevronRight className="w-4 h-4" /></Link>
      <p className="sidebar-muted-copy">本地搜索和维护无需 AI；生成建议后仍需你确认。</p>
      <section className="sidebar-panel sidebar-panel--green">
        <div className="sidebar-panel__head"><span><Globe2 className="w-4 h-4" />当前网页</span></div>
        {currentPage ? <>
          <div className="sidebar-current-page"><CheckCircle2 className="w-4 h-4" /><span>{currentPage.saved ? "本页已收藏（忽略 query / hash 匹配）" : "本页未收藏"}</span></div>
          {!currentPage.saved && <button type="button" className="extension-page__wide-secondary" disabled={savingPage} onClick={() => {
            setSavingPage(true);
            void saveCurrentPage(currentPage.title, currentPage.url).then(async (result) => { setPageNotice(result.created ? "已收藏，归档建议可在任务中心处理" : "该完整 URL 已收藏，未重复创建"); await loadAll(); }).catch((cause) => setPageNotice(cause instanceof Error ? cause.message : "收藏失败")).finally(() => setSavingPage(false));
          }}>{savingPage ? "正在收藏…" : "收藏此页"}</button>}
          <p className="sidebar-muted-copy">状态按忽略 query / hash 匹配；创建时检查完整 URL。</p>
          {pageNotice && <p role="status">{pageNotice} <Link to="/recommendations">选择归档目录</Link></p>}
          <Link to={`/manage?search=${encodeURIComponent(currentPage.title)}`} className="sidebar-muted-link">在书签管理中查看</Link>
          {currentPage.related.length > 0 && <><p className="sidebar-muted-copy">同网站书签</p><div className="sidebar-mini-list">{currentPage.related.map((bookmark) =>
            <a key={bookmark.id} href={bookmark.url} target="_blank" rel="noreferrer" className="sidebar-mini-row"><MiniFavicon title={bookmark.title} url={bookmark.url} /><span>{bookmark.title}</span></a>)}</div></>}
        </> : <p className="sidebar-muted-copy">打开网页后可查看收藏状态和同网站书签。</p>}
      </section>
      <nav className="home-nav" aria-label="主导航"><Link to="/" aria-current="page">首页</Link><Link to="/manage">书签</Link><Link to="/preview">整理</Link><Link to="/more">更多</Link></nav>
    </main>
  );
}
