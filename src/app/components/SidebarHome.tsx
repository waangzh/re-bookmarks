import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Archive,
  Bookmark,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  FolderEdit,
  Globe2,
  History,
  Link2,
  Search,
  Settings,
  Sparkles,
  Tag,
} from "lucide-react";
import type { BookmarkLinkHealthReport, BookmarkNode, FrequentBookmark, PreviewTaskCache } from "../types";
import { getBookmarkFaviconUrl } from "../services/bookmarks";
import { countDuplicateGroups, getUnsortedTaskCount, isProblemLinkHealthResult } from "../services/bookmarkTasks";
import { getFrequentBookmarks, hasHistoryPermission } from "../services/history";
import { getLinkHealthReport, getPreviewPlan } from "../services/storage";
import { getPreviewTask } from "../services/previewTask";
import { sanitizeUrl } from "../services/rules";
import { useAppStore } from "../store/useAppStore";

type PreviewState = "none" | "running" | "ready";
type HistoryPreviewState = "checking" | "disabled" | "loading" | "ready";

const HISTORY_PREVIEW_ROW_COUNT = 3;

function getLinkHealthProblemCount(report: BookmarkLinkHealthReport) {
  return report.results.filter(isProblemLinkHealthResult).length;
}

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

function formatRelativeTime(timestamp: number) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
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

function RecentVisitSkeleton() {
  return (
    <div className="sidebar-mini-list" aria-hidden="true">
      {Array.from({ length: HISTORY_PREVIEW_ROW_COUNT }, (_, index) => (
        <span key={index} className="sidebar-mini-row sidebar-mini-row--placeholder">
          <span className="sidebar-favicon" />
          <span />
          <time />
        </span>
      ))}
    </div>
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

export function SidebarHome() {
  const { settings, bookmarks, pendingRecommendations, reportHistory, lastReport, loadAll, loading } = useAppStore();
  const [previewState, setPreviewState] = useState<PreviewState>("none");
  const [previewTask, setPreviewTask] = useState<PreviewTaskCache | null>(null);
  const [currentPage, setCurrentPage] = useState<CurrentPageState | null>(null);
  const [historyState, setHistoryState] = useState<HistoryPreviewState>("checking");
  const [frequentBookmarks, setFrequentBookmarks] = useState<FrequentBookmark[]>([]);
  const [linkHealthReport, setLinkHealthReport] = useState<BookmarkLinkHealthReport | null>(null);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    let alive = true;
    void Promise.all([getPreviewPlan(), getPreviewTask(), getLinkHealthReport()]).then(([cache, task, report]) => {
      if (!alive) return;
      setLinkHealthReport(report);
      setPreviewTask(task);
      if (task?.status === "running") {
        setPreviewState("running");
        return;
      }
      setPreviewState(cache?.movePlan?.length || task?.movePlan?.length ? "ready" : "none");
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void getCurrentPage(bookmarks).then((page) => {
      if (alive) setCurrentPage(page);
    });
    return () => {
      alive = false;
    };
  }, [bookmarks]);

  useEffect(() => {
    let alive = true;
    setHistoryState("checking");
    void hasHistoryPermission().then(async (granted) => {
      if (!alive) return;
      const enabled = settings.enableHistory && granted;
      if (!enabled) {
        setFrequentBookmarks([]);
        setHistoryState("disabled");
        return;
      }
      setHistoryState("loading");
      const frequent = await getFrequentBookmarks();
      if (!alive) return;
      setFrequentBookmarks(frequent.slice(0, HISTORY_PREVIEW_ROW_COUNT));
      setHistoryState("ready");
    });
    return () => {
      alive = false;
    };
  }, [settings.enableHistory]);

  const stats = useMemo(() => {
    return {
      bookmarkCount: bookmarks.length,
      unsortedTaskCount: getUnsortedTaskCount(bookmarks, pendingRecommendations),
      duplicateCount: countDuplicateGroups(bookmarks),
    };
  }, [bookmarks, pendingRecommendations]);

  const aiSuggestions = useMemo(() => {
    const suggestions: Array<{ label: string; to: string }> = [];
    if (pendingRecommendations.length > 0) {
      suggestions.push({
        label: `可将 ${pendingRecommendations.length} 个新书签归入建议文件夹`,
        to: "/recommendations",
      });
    }
    if (previewTask?.status === "completed" && previewTask.movePlan?.length) {
      suggestions.push({
        label: `已有 ${previewTask.movePlan.length} 条分类预览等待确认`,
        to: "/preview",
      });
    }
    if (lastReport?.failedItems.length) {
      suggestions.push({
        label: `${lastReport.failedItems.length} 个书签上次整理失败，建议复查`,
        to: "/report",
      });
    }
    if (suggestions.length === 0) {
      suggestions.push({
        label: "开始一次智能预览，生成新的分类建议",
        to: "/preview",
      });
    }
    return suggestions.slice(0, 2);
  }, [lastReport, pendingRecommendations.length, previewTask]);

  const previewLabel =
    previewState === "running" ? "继续智能整理" : previewState === "ready" ? "继续上次预览" : "开始智能整理";

  return (
    <main className="sidebar-home">
      <section className="sidebar-stat-card">
        <div className="sidebar-stat-card__main">
          <Bookmark className="sidebar-stat-card__icon" />
          <span>当前书签</span>
          <span className="sidebar-stat-card__count">
            <strong>{loading ? "..." : stats.bookmarkCount}</strong>
            <em>个</em>
          </span>
        </div>
        <div className="sidebar-stat-card__side">
          <span>
            <span className="sidebar-stat-card__side-label">
              <i className="sidebar-dot sidebar-dot--amber" />
              未分类
            </span>
            <strong>{stats.unsortedTaskCount}</strong>
          </span>
          <span>
            <span className="sidebar-stat-card__side-label">
              <i className="sidebar-dot sidebar-dot--red" />
              重复疑似
            </span>
            <strong>{stats.duplicateCount}</strong>
          </span>
        </div>
      </section>

      <Link to="/preview" className="sidebar-primary-action">
        <FileText className="w-4 h-4" />
        <span>{previewLabel}</span>
        <ChevronRight className="w-4 h-4" />
      </Link>

      <Link to="/manage?search=1" className="sidebar-search-link">
        <Search className="w-4 h-4" />
        <span>搜索书签 / 标题 / 链接</span>
        <kbd>⌘K</kbd>
      </Link>

      <section className="sidebar-panel sidebar-panel--green">
        <div className="sidebar-panel__head">
          <span><Globe2 className="w-4 h-4" />当前网页</span>
        </div>
        {currentPage ? (
          <>
            <div className="sidebar-current-page">
              <CheckCircle2 className="w-4 h-4" />
              <span>{currentPage.saved ? "本页已收藏" : "本页未收藏"}</span>
              <b>{currentPage.related.length ? `推荐相关书签 ${currentPage.related.length} 条` : getDomain(currentPage.url)}</b>
            </div>
            {currentPage.related.length > 0 && (
              <div className="sidebar-mini-list">
                {currentPage.related.map((bookmark) => (
                  <Link key={bookmark.id} to={`/manage?search=${encodeURIComponent(bookmark.title)}`} className="sidebar-mini-row">
                    <MiniFavicon title={bookmark.title} url={bookmark.url} />
                    <span>{bookmark.title}</span>
                  </Link>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="sidebar-muted-copy">打开网页后可查看收藏状态和相关书签。</p>
        )}
      </section>

      <section className="sidebar-panel">
        <div className="sidebar-panel__head">
          <span><Clock3 className="w-4 h-4" />最近访问</span>
          <Link to="/history">全部</Link>
        </div>
        <div className="sidebar-recent-body">
          {historyState === "checking" || historyState === "loading" ? (
            <RecentVisitSkeleton />
          ) : historyState === "ready" && frequentBookmarks.length > 0 ? (
            <div className="sidebar-mini-list">
              {frequentBookmarks.map((bookmark) => (
                <a key={bookmark.id} href={bookmark.url} target="_blank" rel="noreferrer" className="sidebar-mini-row">
                  <MiniFavicon title={bookmark.title} url={bookmark.url} />
                  <span>{bookmark.title}</span>
                  <time>{formatRelativeTime(bookmark.lastVisit)}</time>
                </a>
              ))}
            </div>
          ) : historyState === "ready" ? (
            <p className="sidebar-muted-copy">暂无常访问书签数据。</p>
          ) : (
            <Link to="/history" className="sidebar-muted-link">启用后显示本地常访问书签</Link>
          )}
        </div>
      </section>

      <section className="sidebar-panel">
        <div className="sidebar-panel__head">
          <span><Tag className="w-4 h-4" />待整理</span>
        </div>
        <div className="sidebar-task-grid">
          <Link to="/manage?task=unsorted" className="sidebar-task-card sidebar-task-card--amber">
            <span>未分类</span>
            <strong>{stats.unsortedTaskCount}</strong>
            <Tag className="w-4 h-4" />
          </Link>
          <Link to="/manage?task=duplicate" className="sidebar-task-card sidebar-task-card--red">
            <span>重复链接</span>
            <strong>{stats.duplicateCount}</strong>
            <Link2 className="w-4 h-4" />
          </Link>
          <Link to="/manage?task=invalid" className="sidebar-task-card sidebar-task-card--purple">
            <span>失效链接</span>
            <strong>{linkHealthReport ? getLinkHealthProblemCount(linkHealthReport) : "检测"}</strong>
            <Link2 className="w-4 h-4" />
          </Link>
        </div>
      </section>

      <section className="sidebar-panel">
        <div className="sidebar-panel__head">
          <span><Sparkles className="w-4 h-4" />AI 建议</span>
        </div>
        <div className="sidebar-suggestion-list">
          {aiSuggestions.map((suggestion) => (
            <Link key={suggestion.label} to={suggestion.to} className="sidebar-suggestion-row">
              <Sparkles className="w-4 h-4" />
              <span>{suggestion.label}</span>
              <ChevronRight className="w-4 h-4" />
            </Link>
          ))}
        </div>
      </section>

      <nav className="sidebar-entry-list" aria-label="功能入口">
        {reportHistory.length > 0 && (
          <Link to="/report" className="sidebar-entry-row">
            <FileText className="w-4 h-4" />
            <span>整理报告</span>
            <ChevronRight className="w-4 h-4" />
          </Link>
        )}
        <Link to="/history" className="sidebar-entry-row">
          <History className="w-4 h-4" />
          <span>常访问书签</span>
          <ChevronRight className="w-4 h-4" />
        </Link>
        <Link to="/manage" className="sidebar-entry-row">
          <FolderEdit className="w-4 h-4" />
          <span>管理书签</span>
          <ChevronRight className="w-4 h-4" />
        </Link>
        <Link to="/backups" className="sidebar-entry-row">
          <Archive className="w-4 h-4" />
          <span>书签备份</span>
          <ChevronRight className="w-4 h-4" />
        </Link>
        <Link to="/habits" className="sidebar-entry-row">
          <Sparkles className="w-4 h-4" />
          <span>分类习惯预设</span>
          <ChevronRight className="w-4 h-4" />
        </Link>
      </nav>

      <footer className="sidebar-home__footer">
        <span>使用 AI 智能分类您的书签</span>
        <Link to="/options" className="sidebar-icon-button" aria-label="设置">
          <Settings className="w-4 h-4" />
        </Link>
      </footer>
    </main>
  );
}
