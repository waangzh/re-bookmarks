import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  ArrowRight,
  BrainCircuit,
  ChevronRight,
  Folder,
  Globe2,
  LoaderCircle,
  PanelRightOpen,
  Search,
  Settings,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import type { BookmarkImpressionMeta, BookmarkLinkHealthReport, PreviewTaskCache } from "../types";
import { getBookmarkFaviconUrl } from "../services/bookmarks";
import { countDuplicateGroups, getLinkHealthProblemResults } from "../services/bookmarkTasks";
import { getHomeTasks, getOrganizeAction } from "../services/homeTasks";
import { ensureRequiredHostPermission } from "../services/hostPermissions";
import { getImpressionMatchIcon, isImpressionMatch, searchBookmarksByImpression } from "../services/impressionSearch";
import { getPreviewTask } from "../services/previewTask";
import { getSemanticIndexMap } from "../services/semanticIndex";
import { canOpenExtensionSidebar, openExtensionSidebar } from "../services/sidePanel";
import { getIgnoredManualTaskBookmarkIds, getLinkHealthReport, getPreviewPlan } from "../services/storage";
import { filterAvailableBookmarks, getCurrentWhitelist, whitelistFingerprint, type WhitelistIndex } from "../services/whitelist";
import { useDeepImpressionSearch } from "../hooks/useDeepImpressionSearch";
import { useDuplicateBookmarkIgnores, useLinkHealthBookmarkIgnores } from "../hooks/useDuplicateBookmarkIgnores";
import { useAppStore } from "../store/useAppStore";
import { PopupQuickCard } from "./PopupQuickCard";
import { SearchKeywordDropdown } from "./SearchKeywordDropdown";
import { getCurrentPage, getHomeTaskVisual } from "./SidebarHome";
import { resolvePopupQuickTarget, type PopupCurrentPage } from "../services/popupQuickCard";
import { TopNotice, TopNotices } from "./TopNotice";

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

/**
 * 360px Popup 主入口：
 * 聚焦「置顶刚收藏 / 当前页快捷操作卡 + 快速搜索 + 高频快捷跳转」，其余完整管理与待办统一交由侧边栏承载。
 */
export function PopupHome() {
  const { settings, bookmarks, pendingRecommendations, lastReport, loadAll, loading, error } = useAppStore();
  const { entries: duplicateIgnores } = useDuplicateBookmarkIgnores();
  const { entries: linkHealthIgnores } = useLinkHealthBookmarkIgnores();
  const [currentPage, setCurrentPage] = useState<PopupCurrentPage | null>(null);
  const [analyzingBookmarkIds, setAnalyzingBookmarkIds] = useState<string[]>([]);
  const [previewState, setPreviewState] = useState<"none" | "running" | "ready">("none");
  const [previewTask, setPreviewTask] = useState<PreviewTaskCache | null>(null);
  const [linkHealthReport, setLinkHealthReport] = useState<BookmarkLinkHealthReport | null>(null);
  const [ignoredManualTaskBookmarkIds, setIgnoredManualTaskBookmarkIds] = useState<string[]>([]);
  const [whitelistIndex, setWhitelistIndex] = useState<WhitelistIndex | null>(null);
  const [semanticIndex, setSemanticIndex] = useState<Record<string, BookmarkImpressionMeta>>({});
  const [query, setQuery] = useState("");
  const [searchNotice, setSearchNotice] = useState<{ query: string; message: string } | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const startingSearch = useRef(false);

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
          getPreviewPlan(),
          getPreviewTask(),
          getLinkHealthReport(),
          getCurrentWhitelist(),
          getIgnoredManualTaskBookmarkIds(),
        ]);
        if (!alive || request !== revision) return;
        setWhitelistIndex(protection.index);
        setLinkHealthReport(report);
        setPreviewTask(task);
        setIgnoredManualTaskBookmarkIds(ignored);
        void getSemanticIndexMap()
          .then((index) => {
            if (alive && request === revision) setSemanticIndex(index);
          })
          .catch(() => undefined);
        setPreviewState(
          task?.status === "running"
            ? "running"
            : task?.status === "failed"
              ? "none"
              : (cache?.whitelistFingerprint === whitelistFingerprint(protection.entries) && cache.movePlan.length) ||
                  task?.movePlan?.length
                ? "ready"
                : "none"
        );
        setRefreshError("");
      } catch (cause) {
        if (alive) setRefreshError(cause instanceof Error ? cause.message : "数据读取失败");
      }
    };
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      void refresh();
      void loadAll();
    };
    const bookmarksChanged = () => {
      void refresh();
      void loadAll();
    };
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
      void getCurrentPage(bookmarks).then((page) => {
        if (alive && request === revision) setCurrentPage(page);
      });
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

  const actionableBookmarks = useMemo(
    () => (whitelistIndex ? filterAvailableBookmarks(bookmarks, whitelistIndex) : bookmarks),
    [bookmarks, whitelistIndex]
  );

  const taskSummary = useMemo(
    () =>
      getHomeTasks({
        bookmarks: actionableBookmarks,
        recommendations: pendingRecommendations,
        ignoredIds: ignoredManualTaskBookmarkIds,
        task: previewTask,
        hasPreview: previewState === "ready",
        failedCount: lastReport?.failedItems.length ?? 0,
        duplicateGroups:
          duplicateIgnores && whitelistIndex
            ? countDuplicateGroups(bookmarks, duplicateIgnores, whitelistIndex.protectedBookmarkIds)
            : 0,
        linkProblems:
          linkHealthReport && linkHealthIgnores
            ? getLinkHealthProblemResults(linkHealthReport, actionableBookmarks, linkHealthIgnores).length
            : 0,
      }),
    [
      actionableBookmarks,
      bookmarks,
      duplicateIgnores,
      ignoredManualTaskBookmarkIds,
      lastReport,
      linkHealthIgnores,
      linkHealthReport,
      pendingRecommendations,
      previewState,
      previewTask,
      whitelistIndex,
    ]
  );

  const organizeAction = getOrganizeAction(settings, previewTask, previewState === "ready");
  const sidebarAvailable = canOpenExtensionSidebar();
  const extraSidebarTasks = useMemo(
    () => taskSummary.tasks.filter((task) => task.kind !== "archive" && task.to !== organizeAction.to),
    [organizeAction.to, taskSummary.tasks]
  );
  const quickTarget = useMemo(
    () =>
      resolvePopupQuickTarget({
        currentPage,
        bookmarks,
        pendingRecommendations,
        analyzingBookmarkIds,
      }),
    [analyzingBookmarkIds, bookmarks, currentPage, pendingRecommendations]
  );
  const hasQuickArchiveTask = Boolean(
    quickTarget.isAnalyzingCurrent ||
      quickTarget.currentRecommendation ||
      quickTarget.latestOtherRecommendation
  );
  const primaryTodoTask = !hasQuickArchiveTask ? extraSidebarTasks[0] ?? null : null;
  const todoVisual = primaryTodoTask ? getHomeTaskVisual(primaryTodoTask.kind) : null;
  const TodoIcon = todoVisual?.icon ?? null;

  const queryText = query.trim();
  const searchableBookmarks = useMemo(
    () =>
      bookmarks.flatMap((bookmark) =>
        bookmark.url
          ? [
              {
                id: bookmark.id,
                title: bookmark.title,
                url: bookmark.url,
                folderPath: bookmark.path.join(" / "),
              },
            ]
          : []
      ),
    [bookmarks]
  );
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

  const localSearchMatches = useMemo(
    () => (queryText ? searchBookmarksByImpression(queryText, searchableBookmarks, semanticIndex) : []),
    [queryText, searchableBookmarks, semanticIndex]
  );
  const searchIsCurrent = deepSearchState.query === queryText;
  const searching = searchIsCurrent && deepSearchRunning;
  const deepSearchActive =
    searchIsCurrent &&
    hasDeepResult &&
    (!deepSearchState.error || Boolean(deepSearchState.results?.length)) &&
    (!searching || Boolean(deepSearchState.results?.length));
  const searchMatches = deepSearchActive ? deepSearchState.results ?? [] : localSearchMatches;
  const searchError =
    searchNotice?.query === queryText ? searchNotice.message : searchIsCurrent ? deepSearchState.error : "";

  const changeQuery = (value: string) => {
    setQuery(value);
    setSearchNotice(null);
  };

  useEffect(() => {
    if (deepSearchState.query && deepSearchState.query !== queryText) cancelDeepSearch();
  }, [cancelDeepSearch, deepSearchState.query, queryText]);

  const handleDeepSearch = async () => {
    if (!queryText || searching || startingSearch.current) return;
    setSearchNotice(null);
    if (!settings.provider.apiKey.trim() || !settings.provider.enabled) {
      setSearchNotice({ query: queryText, message: "请先在设置中连接并授权 AI 服务" });
      return;
    }
    startingSearch.current = true;
    try {
      await ensureRequiredHostPermission();
      if (searchRef.current?.value.trim() === queryText) runDeepSearch(queryText);
    } catch (cause) {
      if (searchRef.current?.value.trim() === queryText) {
        setSearchNotice({
          query: queryText,
          message: cause instanceof Error ? cause.message : "未授予网站访问权限",
        });
      }
    } finally {
      startingSearch.current = false;
    }
  };

  const handleOpenSidebar = async (targetTo?: string) => {
    try {
      await openExtensionSidebar(currentPage?.windowId, targetTo);
      window.close();
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : "打开侧边栏失败");
    }
  };

  return (
    <main className="sidebar-home home-v2 home-v2--compact popup-home">
      <header className="home-heading">
        <Link to="/home" className="remarks-brand" aria-label="ReMarks 首页">
          <span className="remarks-brand__mark">
            <img src="../icons/icon48.png" alt="" />
          </span>
          <span>
            <strong>ReMarks</strong>
          </span>
        </Link>
        <div className="popup-header-actions">
          <Link to="/options" className="popup-header-icon-btn" aria-label="设置" title="设置">
            <Settings aria-hidden="true" />
          </Link>
          {sidebarAvailable && (
            <button
              type="button"
              className="home-sidebar-button"
              onClick={() => void handleOpenSidebar()}
              title="在浏览器侧边栏中打开全部功能"
            >
              <PanelRightOpen aria-hidden="true" />
              <span>侧边栏</span>
            </button>
          )}
        </div>
      </header>

      <PopupQuickCard
        currentPage={currentPage}
        bookmarks={bookmarks}
        pendingRecommendations={pendingRecommendations}
        maxNestingLevel={settings.maxNestingLevel}
        onRefresh={loadAll}
        onCurrentPageSaved={(url) => setCurrentPage((page) => (page?.url === url ? { ...page, saved: true } : page))}
        onAnalyzingIdsChange={setAnalyzingBookmarkIds}
      />

      {primaryTodoTask && TodoIcon && todoVisual && (
        <section className={`popup-todo-card popup-todo-card--${todoVisual.tone}`} aria-label="待办任务">
          <div className="popup-todo-card__top">
            <span className="popup-todo-card__badge">
              <TodoIcon className={todoVisual.spin ? "home-action-spinner" : undefined} aria-hidden="true" />
              <span>待办任务</span>
            </span>
            {extraSidebarTasks.length > 1 &&
              (sidebarAvailable ? (
                <button
                  type="button"
                  className="popup-quick-card__more"
                  onClick={() => void handleOpenSidebar("/tasks")}
                >
                  全部 {extraSidebarTasks.length} 项
                  <ChevronRight aria-hidden="true" />
                </button>
              ) : (
                <Link to="/tasks" className="popup-quick-card__more">
                  全部 {extraSidebarTasks.length} 项
                  <ChevronRight aria-hidden="true" />
                </Link>
              ))}
          </div>
          <div className="popup-todo-card__body">
            <strong className="popup-todo-card__title">{primaryTodoTask.title}</strong>
            <p className="popup-todo-card__desc">{primaryTodoTask.description}</p>
          </div>
          <div className="popup-todo-card__actions">
            {sidebarAvailable ? (
              <button
                type="button"
                className="popup-quick-card__btn popup-quick-card__btn--primary"
                onClick={() => void handleOpenSidebar(primaryTodoTask.to)}
              >
                <PanelRightOpen aria-hidden="true" />
                <span>{primaryTodoTask.cta}</span>
              </button>
            ) : (
              <Link to={primaryTodoTask.to} className="popup-quick-card__btn popup-quick-card__btn--primary">
                <span>{primaryTodoTask.cta}</span>
                <ArrowRight aria-hidden="true" />
              </Link>
            )}
          </div>
        </section>
      )}

      <div className={`home-search-panel${queryText ? " home-search-panel--results" : ""}`}>
        <SearchKeywordDropdown query={query} onQueryChange={changeQuery} semanticIndex={semanticIndex} inputRef={searchRef}>
          {(inputProps) => (
            <form
              className="home-search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                window.location.hash = `/manage?search=${encodeURIComponent(query.trim() || "1")}`;
              }}
            >
              <Search aria-hidden="true" />
              <input
                {...inputProps}
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                    event.preventDefault();
                    if (!event.repeat) void handleDeepSearch();
                  }
                }}
                aria-label="搜索书签"
                placeholder="搜索标题、网址或用途"
              />
              {query ? (
                <>
                  <button
                    type="button"
                    className="home-search__ai"
                    onClick={() => void handleDeepSearch()}
                    aria-disabled={!queryText || searching}
                    aria-keyshortcuts="Alt+Enter"
                    title="用 AI 根据描述查找书签（Alt + Enter）"
                  >
                    {searching ? (
                      <LoaderCircle className="home-action-spinner" aria-hidden="true" />
                    ) : (
                      <BrainCircuit aria-hidden="true" />
                    )}
                    <span>帮我找找</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      changeQuery("");
                      searchRef.current?.focus();
                    }}
                    aria-label="清除搜索"
                  >
                    <X aria-hidden="true" />
                  </button>
                </>
              ) : (
                <kbd>Ctrl / ⌘ K</kbd>
              )}
            </form>
          )}
        </SearchKeywordDropdown>
        {queryText && (
          <section className="home-search-results" aria-label="搜索结果" aria-live="polite">
            {searchMatches.length ? (
              <>
                {searchMatches.slice(0, 4).map((result) => {
                  const bookmark = bookmarks.find((item) => item.id === result.bookmark.id);
                  if (!bookmark) return null;
                  const path = bookmark.path.join(" / ") || getDomain(bookmark.url);
                  return (
                    <a
                      key={bookmark.id}
                      href={bookmark.url}
                      target="_blank"
                      rel="noreferrer"
                      className="home-search-result"
                    >
                      <MiniFavicon title={bookmark.title} url={bookmark.url} />
                      <span>
                        <strong title={bookmark.title}>{bookmark.title || "未命名书签"}</strong>
                        <small title={path}>{path}</small>
                        {result.matchHint && isImpressionMatch(result) && (
                          <em className="home-search-result__match">
                            {getImpressionMatchIcon(result)} {result.matchHint}
                            {result.healed && (
                              <i className="impression-healed-badge">
                                <Zap aria-hidden="true" />
                                已记住该印象
                              </i>
                            )}
                          </em>
                        )}
                        {!result.matchHint && result.displayTags.length > 0 && (
                          <span className="home-search-result__tags">
                            {result.displayTags.slice(0, 3).map((tag) => (
                              <b key={tag}>{tag}</b>
                            ))}
                          </span>
                        )}
                      </span>
                      <ArrowRight aria-hidden="true" />
                    </a>
                  );
                })}
                <Link to={`/manage?search=${encodeURIComponent(queryText)}`} className="home-search-more">
                  查看全部 {searchMatches.length} 条结果 <ArrowRight aria-hidden="true" />
                </Link>
              </>
            ) : (
              <p>{loading ? "正在读取书签…" : searching ? "本地未找到匹配的书签" : "没有找到匹配的书签"}</p>
            )}
          </section>
        )}
        {queryText && (searchError || (searchIsCurrent && deepSearchState.stage !== "idle")) && (
          <div className={`home-deep-status${searchError ? " home-deep-status--error" : ""}`} role="status">
            <span>
              {searchError
                ? `AI 查找失败：${searchError}`
                : searching
                  ? deepSearchState.stage === "expanding"
                    ? "正在联想相关网站…"
                    : "正在筛选更匹配的书签…"
                  : "AI 查找完成"}
            </span>
            {!searchError && deepSearchState.expandedTerms.length > 0 && (
              <span className="home-deep-status__terms">
                {deepSearchState.expandedTerms.map((term) => (
                  <b key={term}>{term}</b>
                ))}
              </span>
            )}
          </div>
        )}
      </div>

      <TopNotices>
        <TopNotice
          message={error || refreshError || ""}
          tone="error"
          action={
            <button type="button" onClick={() => window.location.reload()}>
              重新加载
            </button>
          }
        />
      </TopNotices>

      <section className="popup-quick-shortcuts" aria-label="快捷入口">
        <nav className="home-quick-list">
          <Link to={organizeAction.to} className="home-quick">
            <span className="home-quick__mark" aria-hidden="true">
              <Sparkles aria-hidden="true" />
            </span>
            <strong>{organizeAction.label}</strong>
            <ChevronRight className="home-row-chevron" aria-hidden="true" />
          </Link>
          <Link to="/manage" className="home-quick">
            <span className="home-quick__mark" aria-hidden="true">
              <Folder aria-hidden="true" />
            </span>
            <strong>管理书签</strong>
            <ChevronRight className="home-row-chevron" aria-hidden="true" />
          </Link>
        </nav>
      </section>
    </main>
  );
}
