import { PageHeading } from "./PageHeading";
import { TopNotice, TopNotices } from "./TopNotice";
import { RecommendationActionHelp } from "./RecommendationActionHelp";
import { SearchKeywordDropdown } from "./SearchKeywordDropdown";
import { BookmarkRowActionMenu } from "./BookmarkRowActionMenu";
import { BookmarkTaskHeader } from "./BookmarkTaskHeader";
import { RecommendationRowActionMenu } from "./RecommendationRowActionMenu";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router";
import {
  Plus,
  Search,
  Trash2,
  ExternalLink,
  Copy,
  Unlink,
  Folder,
  FolderInput,
  FolderPlus,
  Bookmark,
  ChevronDown,
  ChevronRight,
  EyeOff,
  X,
  Check,
  RefreshCw,
  Sparkles,
  Shield,
  ShieldCheck,
  BrainCircuit,
  Zap,
  GripVertical,
} from "lucide-react";
import type { BookmarkImpressionMeta, BookmarkLinkHealthReport, BookmarkLinkHealthResult, BookmarkNode, BookmarkWhitelistEntry, PendingRecommendation } from "../types";
import {
  createBookmark,
  ensureFolderPath,
  getAllBookmarkFolders,
  getBookmarkFaviconUrl,
  getUrlBookmarks,
  moveBookmark,
  parseFolderPath,
  removeBookmark,
  updateBookmark,
} from "../services/bookmarks";
import {
  deleteLinkHealthBookmarks,
  getDuplicateBookmarkGroups,
  getIgnoredBookmarkUrlIds,
  getLinkHealthProblemResults,
  getUnsortedTaskCount,
  getVisibleUnsortedBookmarks,
  isSuggestedLinkHealthCleanup,
  isUnsortedBookmark,
  NOT_FOUND_RECHECK_MINUTES,
  recheckLinkHealthBookmark,
  startLinkHealthScan,
} from "../services/bookmarkTasks";
import type { DuplicateBookmarkGroup } from "../services/bookmarkTasks";
import { createDuplicateDeleteBackup } from "../services/backups";
import { acceptRecommendation, acceptRecommendations, getRecommendationKind, getRecommendationSignalLabel, isActionableRecommendation, isBatchSafeRecommendation, removeRecommendation, retryRecommendation, updateRecommendationFolderPath } from "../services/recommendations";
import { recordHabitFeedback } from "../services/habits";
import { appendFolderImpression, getSemanticIndexCoverage, getSemanticIndexMap } from "../services/semanticIndex";
import { backfillImpressions, getImpressionBackfillBatchSize, getMissingImpressionBookmarks, type ImpressionBackfillFailure, type ImpressionBackfillProgress } from "../services/impressionBackfill";
import { getImpressionMatchIcon, isImpressionMatch, searchBookmarksByImpression } from "../services/impressionSearch";
import { useDeepImpressionSearch } from "../hooks/useDeepImpressionSearch";
import { useDuplicateBookmarkIgnores, useLinkHealthBookmarkIgnores } from "../hooks/useDuplicateBookmarkIgnores";
import {
  STORAGE_KEYS,
  getDuplicateBookmarkIgnores,
  getIgnoredManualTaskBookmarkIds,
  getLinkHealthReport,
  removeBookmarkFromLinkHealthReport,
  saveIgnoredManualTaskBookmarkIds,
  updateDuplicateBookmarkIgnores,
  updateBookmarkCheckIgnores,
} from "../services/storage";
import { useAppStore } from "../store/useAppStore";
import { ensureRequiredHostPermission, hasRequiredHostPermission } from "../services/hostPermissions";
import {
  addBookmarkWhitelistEntry,
  addBookmarkWhitelistEntries,
  getCurrentWhitelist,
  removeBookmarkWhitelistEntry,
  removeBookmarkWhitelistEntries,
  type WhitelistIndex,
} from "../services/whitelist";

type TaskMode = "unsorted" | "duplicate" | "invalid";
type LinkHealthGroupKey = "broken" | "restricted" | "suspicious" | "temporary_failed";

type BookmarkFolderNode = {
  id?: string;
  parentId?: string;
  key: string;
  title: string;
  path: string[];
  count: number;
  children: BookmarkFolderNode[];
  bookmarks: BookmarkNode[];
};

type DragSession = {
  bookmark: BookmarkNode;
  active: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  timer: number;
};

const DEFAULT_EXPANDED_ROOT_FOLDER_TITLES = new Set(["收藏夹栏", "书签栏", "Bookmarks Bar", "Favorites Bar"]);

function createFolderNode(title: string, path: string[], id?: string, parentId?: string): BookmarkFolderNode {
  return {
    id,
    parentId,
    key: id ? `folder:${id}` : "__root__",
    title,
    path,
    count: 0,
    children: [],
    bookmarks: [],
  };
}

function buildBookmarkFolderTree(bookmarks: BookmarkNode[], folders: BookmarkNode[]) {
  const root = createFolderNode("全部书签", []);
  const folderMap = new Map(
    folders.map((folder) => [
      folder.id,
      createFolderNode(folder.title, folder.path, folder.id, folder.parentId),
    ])
  );

  folderMap.forEach((folder) => {
    const parent = folder.parentId ? folderMap.get(folder.parentId) : null;
    (parent ?? root).children.push(folder);
  });

  bookmarks.forEach((bookmark) => {
    root.count += 1;
    let current = bookmark.parentId ? folderMap.get(bookmark.parentId) : undefined;

    if (!current) {
      root.bookmarks.push(bookmark);
      return;
    }

    current.bookmarks.push(bookmark);
    while (current) {
      current.count += 1;
      current = current.parentId ? folderMap.get(current.parentId) : undefined;
    }
  });

  const sortTree = (node: BookmarkFolderNode) => {
    node.children = node.children.filter((child) => child.count > 0);
    node.children.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    node.bookmarks.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    node.children.forEach(sortTree);
  };

  sortTree(root);
  return root;
}

function collectFolderLookup(root: BookmarkFolderNode) {
  const lookup = new Map<string, BookmarkFolderNode>();
  const collect = (folder: BookmarkFolderNode) => {
    lookup.set(folder.key, folder);
    folder.children.forEach(collect);
  };
  collect(root);
  return lookup;
}

function findDefaultExpandedRootFolder(root: BookmarkFolderNode) {
  return root.children.find((folder) => DEFAULT_EXPANDED_ROOT_FOLDER_TITLES.has(folder.title));
}

function BookmarkFavicon({
  title,
  url,
  className = "bookmark-tree-row__favicon",
  fallbackClassName = "bookmark-tree-row__bookmark-icon",
}: {
  title: string;
  url?: string;
  className?: string;
  fallbackClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = url && !failed ? getBookmarkFaviconUrl(url) : "";

  if (!faviconUrl) {
    return <Bookmark className={fallbackClassName} />;
  }

  return (
    <img
      src={faviconUrl}
      alt=""
      title={title}
      className={className}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function getTaskMode(searchParams: URLSearchParams): TaskMode | null {
  const task = searchParams.get("task");
  if (task === "unsorted" || task === "duplicate" || task === "invalid") return task;
  return searchParams.get("search") === "duplicate" ? "duplicate" : null;
}

function formatScanTime(timestamp: number) {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getLinkHealthGroupKey(result: BookmarkLinkHealthResult): LinkHealthGroupKey | null {
  if (result.status === "broken" || result.status === "restricted" || result.status === "suspicious") return result.status;
  if (result.status === "temporary_failed" || result.status === "rate_limited") return "temporary_failed";
  return null;
}

function getLinkHealthGroupMeta(group: LinkHealthGroupKey) {
  if (group === "broken") {
    return {
      title: "页面未找到或已移除",
      description: `建议间隔至少 ${NOT_FOUND_RECHECK_MINUTES} 分钟复测 404 链接。`,
      className: "bookmark-health-group--broken",
    };
  }
  if (group === "restricted") {
    return { title: "访问受限", description: "可在浏览器中打开，核对登录或网络条件。", className: "bookmark-health-group--suspicious" };
  }
  if (group === "suspicious") {
    return {
      title: "可疑结果",
      description: "返回了非标准成功状态，可能是站点限制、跳转异常或需要特殊访问条件。",
      className: "bookmark-health-group--suspicious",
    };
  }
  return {
    title: "暂时无法确认",
    description: "站点限流、请求超时或网络和服务器异常，可稍后复测。",
    className: "bookmark-health-group--temporary",
  };
}

export function ManageBookmarks() {
  const { bookmarks, pendingRecommendations, loadBookmarks, loadRecommendations, loadReports, settings } = useAppStore();
  const [searchParams] = useSearchParams();
  const taskMode = useMemo(() => getTaskMode(searchParams), [searchParams]);
  const { entries: duplicateIgnores, error: duplicateIgnoresError } = useDuplicateBookmarkIgnores(taskMode === "duplicate");
  const { entries: linkHealthIgnores, error: linkHealthIgnoresError } = useLinkHealthBookmarkIgnores(taskMode === "invalid");
  const [folders, setFolders] = useState<BookmarkNode[]>([]);
  const [searchQuery, setSearchQuery] = useState(() => {
    const value = searchParams.get("search") ?? "";
    return value === "1" || value === "duplicate" || searchParams.get("task") ? "" : value;
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: "", url: "", path: "" });
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({ title: "", url: "", path: "" });
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(["__root__"])
  );
  const [selectedFolder, setSelectedFolder] = useState<string>("__root__");
  const feedbackSequence = useRef(0);
  const [feedback, setFeedback] = useState<{ id: number; text: string; kind: "info" | "success" | "error" } | null>(null);
  const setMessage = useCallback((text: string, kind: "info" | "success" | "error" = "info") => {
    setFeedback(text ? { id: ++feedbackSequence.current, text, kind } : null);
  }, []);
  const [busy, setBusy] = useState(false);
  const [busyRecommendationId, setBusyRecommendationId] = useState<string | null>(null);
  const [ignoringManualSelection, setIgnoringManualSelection] = useState(false);
  const [bulkRecommendationAction, setBulkRecommendationAction] = useState<"accept" | "ignore" | null>(null);
  const [editingRecommendationId, setEditingRecommendationId] = useState<string | null>(null);
  const [recommendationPathDraft, setRecommendationPathDraft] = useState("");
  const [draggedBookmark, setDraggedBookmark] = useState<BookmarkNode | null>(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [linkHealthReport, setLinkHealthReport] = useState<BookmarkLinkHealthReport | null>(null);
  const [scanProgress, setScanProgress] = useState({ checked: 0, total: 0 });
  const [scanningLinks, setScanningLinks] = useState(false);
  const [linkScanActive, setLinkScanActive] = useState(false);
  const [linkScanNeedsPermission, setLinkScanNeedsPermission] = useState(false);
  const [selectedDuplicateBookmarkIds, setSelectedDuplicateBookmarkIds] = useState<Set<string>>(() => new Set());
  const [selectedInvalidBookmarkIds, setSelectedInvalidBookmarkIds] = useState<Set<string>>(() => new Set());
  const [selectedManualTaskBookmarkIds, setSelectedManualTaskBookmarkIds] = useState<Set<string>>(() => new Set());
  const [ignoredManualTaskBookmarkIds, setIgnoredManualTaskBookmarkIds] = useState<Set<string>>(() => new Set());
  const [whitelistEntries, setWhitelistEntries] = useState<BookmarkWhitelistEntry[]>([]);
  const [semanticIndex, setSemanticIndex] = useState<Record<string, BookmarkImpressionMeta>>({});
  const [backfillProgress, setBackfillProgress] = useState<ImpressionBackfillProgress | null>(null);
  const [backfillFailures, setBackfillFailures] = useState<ImpressionBackfillFailure[]>([]);
  const backfillAbortRef = useRef<AbortController | null>(null);
  const [whitelistSearchQuery, setWhitelistSearchQuery] = useState("");
  const [selectedWhitelistKeys, setSelectedWhitelistKeys] = useState<Set<string>>(() => new Set());
  const [whitelistIndex, setWhitelistIndex] = useState<WhitelistIndex>(() => ({
    protectedBookmarkIds: new Set(), protectedFolderIds: new Set(), reasonById: new Map(),
  }));
  const [collapsedLinkHealthGroups, setCollapsedLinkHealthGroups] = useState<Set<LinkHealthGroupKey>>(
    () => new Set()
  );
  const dragSessionRef = useRef<DragSession | null>(null);
  const folderLookupRef = useRef<Map<string, BookmarkFolderNode>>(new Map());
  const activeDropFolderRef = useRef<BookmarkFolderNode | null>(null);
  const suppressNextFolderClickRef = useRef(false);
  const hoverExpandTimerRef = useRef<number | null>(null);
  const hoverExpandFolderKeyRef = useRef<string | null>(null);
  const didApplyDefaultExpandedFolderRef = useRef(false);
  const resumedLinkScanIdsRef = useRef<Set<string>>(new Set());

  const loadManagedBookmarks = useCallback(async () => {
    const [, , nextFolders, protection, nextSemanticIndex] = await Promise.all([
      loadBookmarks(), loadRecommendations(), getAllBookmarkFolders(), getCurrentWhitelist(), getSemanticIndexMap(),
    ]);
    setFolders(nextFolders);
    setWhitelistEntries(protection.entries);
    setWhitelistIndex(protection.index);
    setSemanticIndex(nextSemanticIndex);
  }, [loadBookmarks, loadRecommendations]);

  useEffect(() => {
    void loadManagedBookmarks();
  }, [loadManagedBookmarks]);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === "local" && (changes[STORAGE_KEYS.bookmarkWhitelist] || changes[STORAGE_KEYS.pendingRecommendations] || changes[STORAGE_KEYS.folderHabitProfile] || changes[STORAGE_KEYS.fixedDomainRules] || changes[STORAGE_KEYS.semanticIndex])) void loadManagedBookmarks();
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, [loadManagedBookmarks]);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.bookmarks) return;
    const refresh = () => { void loadManagedBookmarks().catch((error) => setMessage(error instanceof Error ? error.message : "刷新书签失败")); };
    chrome.bookmarks.onCreated.addListener(refresh);
    chrome.bookmarks.onRemoved.addListener(refresh);
    chrome.bookmarks.onChanged.addListener(refresh);
    chrome.bookmarks.onMoved.addListener(refresh);
    return () => {
      chrome.bookmarks.onCreated.removeListener(refresh);
      chrome.bookmarks.onRemoved.removeListener(refresh);
      chrome.bookmarks.onChanged.removeListener(refresh);
      chrome.bookmarks.onMoved.removeListener(refresh);
    };
  }, [loadManagedBookmarks]);

  useEffect(() => {
    void loadManagedBookmarks().catch((error) => setMessage(error instanceof Error ? error.message : "刷新任务失败"));
  }, [taskMode, loadManagedBookmarks]);

  useEffect(() => {
    let active = true;
    let changed = false;
    void getLinkHealthReport().then((report) => {
      if (!active || changed) return;
      setLinkHealthReport(report);
      if (report?.status === "running") {
        const checked = report.results.length;
        setScanProgress({ checked, total: report.totalCount ?? checked });
        setScanningLinks(true);
      }
    }).catch((error: unknown) => {
      if (active && !changed) setMessage(error instanceof Error ? error.message : "读取链接检测报告失败");
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const change = changes[STORAGE_KEYS.linkHealthReport];
      if (area !== "local" || !change) return;
      changed = true;
      setLinkHealthReport((current) => current?.status === "running" ? current : change.newValue ?? null);
    };
    const events = typeof chrome === "undefined" ? undefined : chrome.storage?.onChanged;
    events?.addListener(onChanged);
    return () => {
      active = false;
      events?.removeListener(onChanged);
    };
  }, []);

  useEffect(() => {
    if (linkHealthReport?.status !== "running") return;

    let canceled = false;
    let readFailed = false;
    const poll = async () => {
      while (!canceled) {
        const report = await getLinkHealthReport().then((current) => {
          readFailed = false;
          return current;
        }).catch((error: unknown) => {
          if (!canceled && !readFailed) {
            setMessage(error instanceof Error ? error.message : "读取链接检测报告失败");
            readFailed = true;
          }
          return null;
        });
        if (canceled) return;
        if (report) {
          setLinkHealthReport(report);
          const checked = report.results.length;
          setScanProgress({ checked, total: report.totalCount ?? checked });
          if (report.status === "completed") {
            setScanningLinks(false);
            setLinkScanActive(false);
            setMessage(`链接检测完成，已检测 ${report.checkedCount} 个网页链接。`);
            return;
          }
          if (report.status === "failed") {
            setScanningLinks(false);
            setLinkScanActive(false);
            setMessage("链接检测未完成，请稍后重试。");
            return;
          }
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1000));
      }
    };

    void poll();
    return () => {
      canceled = true;
    };
  }, [linkHealthReport?.id, linkHealthReport?.status]);

  useEffect(() => {
    if (taskMode !== "invalid") return;
    if (!bookmarks.length || linkHealthReport?.status !== "running") return;
    if (resumedLinkScanIdsRef.current.has(linkHealthReport.id)) return;

    resumedLinkScanIdsRef.current.add(linkHealthReport.id);
    void hasRequiredHostPermission().then((granted) => {
      if (!granted) {
        setScanningLinks(false);
        setLinkScanNeedsPermission(true);
        return;
      }

      setLinkScanNeedsPermission(false);
      setScanningLinks(true);
      setLinkScanActive(true);
      return startLinkHealthScan(bookmarks)
        .then((report) => {
          setLinkHealthReport(report);
          const checked = report.results.length;
          setScanProgress({ checked, total: report.totalCount ?? bookmarks.length });
        })
        .catch((error: unknown) => {
          setScanningLinks(false);
          setMessage(error instanceof Error ? error.message : "链接检测续扫失败");
        })
        .finally(() => {
          setLinkScanActive(false);
        });
    });
  }, [bookmarks, linkHealthReport?.id, linkHealthReport?.status, taskMode]);

  useEffect(() => {
    if (taskMode !== "unsorted") return;
    void getIgnoredManualTaskBookmarkIds().then((ids) => setIgnoredManualTaskBookmarkIds(new Set(ids)));
  }, [taskMode]);

  useEffect(() => {
    if (taskMode) setSearchQuery("");
  }, [taskMode]);

  const linkHealthResultById = useMemo(() => {
    if (taskMode !== "invalid" || !linkHealthReport || !linkHealthIgnores) return new Map<string, BookmarkLinkHealthResult>();
    const available = bookmarks.filter(({ id }) => !whitelistIndex.protectedBookmarkIds.has(id));
    return new Map(getLinkHealthProblemResults(linkHealthReport, available, linkHealthIgnores)
      .map((result) => [result.bookmarkId, result]));
  }, [bookmarks, linkHealthIgnores, linkHealthReport, taskMode, whitelistIndex]);

  const ignoredLinkHealthBookmarks = useMemo(() => {
    if (taskMode !== "invalid" || !linkHealthIgnores?.length) return [];
    const ids = getIgnoredBookmarkUrlIds(bookmarks, linkHealthIgnores);
    return bookmarks.filter(({ id }) => ids.has(id));
  }, [bookmarks, linkHealthIgnores, taskMode]);

  const duplicateGroups = useMemo(() => {
    if (taskMode !== "duplicate" || !duplicateIgnores) return [];
    return getDuplicateBookmarkGroups(bookmarks, duplicateIgnores, whitelistIndex.protectedBookmarkIds);
  }, [bookmarks, duplicateIgnores, taskMode, whitelistIndex]);

  const ignoredDuplicateBookmarks = useMemo(() => {
    if (taskMode !== "duplicate" || !duplicateIgnores?.length) return [];
    const ignoredIds = getIgnoredBookmarkUrlIds(bookmarks, duplicateIgnores);
    return bookmarks.filter((bookmark) => ignoredIds.has(bookmark.id));
  }, [bookmarks, duplicateIgnores, taskMode]);

  const taskBookmarks = useMemo(() => {
    if (taskMode === "unsorted") return bookmarks.filter((bookmark) => isUnsortedBookmark(bookmark) && !whitelistIndex.protectedBookmarkIds.has(bookmark.id));
    if (taskMode === "duplicate") return duplicateGroups.flatMap((group) => group.items);
    if (taskMode === "invalid") return bookmarks.filter(({ id }) => linkHealthResultById.has(id));
    return bookmarks;
  }, [bookmarks, duplicateGroups, linkHealthResultById, taskMode, whitelistIndex]);

  const visibleTaskBookmarks = useMemo(() => {
    if (taskMode !== "unsorted") return taskBookmarks;
    return getVisibleUnsortedBookmarks(bookmarks, pendingRecommendations, ignoredManualTaskBookmarkIds)
      .filter((bookmark) => !whitelistIndex.protectedBookmarkIds.has(bookmark.id));
  }, [bookmarks, ignoredManualTaskBookmarkIds, pendingRecommendations, taskBookmarks, taskMode, whitelistIndex]);

  const unsortedTaskTotal = useMemo(() => {
    if (taskMode !== "unsorted") return taskBookmarks.length;
    return getUnsortedTaskCount(
      bookmarks.filter((bookmark) => !whitelistIndex.protectedBookmarkIds.has(bookmark.id)),
      pendingRecommendations.filter((item) => !whitelistIndex.protectedBookmarkIds.has(item.bookmarkId)),
      ignoredManualTaskBookmarkIds
    );
  }, [bookmarks, ignoredManualTaskBookmarkIds, pendingRecommendations, taskBookmarks.length, taskMode, whitelistIndex]);

  const searchableBookmarks = useMemo(() => visibleTaskBookmarks.map((bookmark) => ({
    id: bookmark.id,
    title: bookmark.title,
    url: bookmark.url ?? "",
    folderPath: bookmark.path.join(" / "),
  })), [visibleTaskBookmarks]);

  const localImpressionResults = useMemo(
    () => searchQuery.trim()
      ? searchBookmarksByImpression(searchQuery, searchableBookmarks, semanticIndex)
      : [],
    [searchQuery, searchableBookmarks, semanticIndex]
  );

  const existingTopFolders = useMemo(() => {
    const names = new Set<string>();
    folders.forEach((folder) => {
      const name = folder.path[folder.path.length - 1] || folder.title;
      if (name) names.add(name);
    });
    return [...names].slice(0, 30);
  }, [folders]);

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

  // 深度搜索结果只在搜索词未变化时生效，避免旧请求结果覆盖新输入。
  const deepSearchActive = hasDeepResult && deepSearchState.query === searchQuery.trim();
  const impressionResults = deepSearchActive
    ? deepSearchState.results ?? []
    : localImpressionResults;

  const impressionResultById = useMemo(
    () => new Map(impressionResults.map((result) => [result.bookmark.id, result])),
    [impressionResults]
  );

  const filteredBookmarks = useMemo(() => {
    const query = searchQuery.trim();
    const matchedIds = query ? new Set(impressionResults.map((result) => result.bookmark.id)) : null;
    return visibleTaskBookmarks.filter((bookmark) => !matchedIds || matchedIds.has(bookmark.id));
  }, [impressionResults, visibleTaskBookmarks, searchQuery]);

  const semanticCoverage = useMemo(
    () => getSemanticIndexCoverage(bookmarks, semanticIndex),
    [bookmarks, semanticIndex]
  );
  const missingImpressionCount = useMemo(
    () => getMissingImpressionBookmarks(bookmarks, semanticIndex).length,
    [bookmarks, semanticIndex]
  );
  const backfillRunning = backfillProgress !== null;

  const visibleManualTaskBookmarkIds = useMemo(() => {
    if (taskMode !== "unsorted") return [];
    return filteredBookmarks.map((bookmark) => bookmark.id);
  }, [filteredBookmarks, taskMode]);

  const filteredDuplicateGroups = useMemo(() => {
    if (taskMode !== "duplicate") return [];
    if (!searchQuery.trim()) return duplicateGroups;

    return duplicateGroups.filter((group) => group.items.some((bookmark) => impressionResultById.has(bookmark.id)));
  }, [duplicateGroups, impressionResultById, searchQuery, taskMode]);

  const filteredDuplicateBookmarkCount = useMemo(() => {
    return filteredDuplicateGroups.reduce((total, group) => total + group.items.length, 0);
  }, [filteredDuplicateGroups]);

  const visibleDuplicateBookmarkIds = useMemo(() => {
    return filteredDuplicateGroups.flatMap((group) => group.items
      .filter((bookmark) => !whitelistIndex.protectedBookmarkIds.has(bookmark.id))
      .map((bookmark) => bookmark.id));
  }, [filteredDuplicateGroups, whitelistIndex]);

  const visibleDuplicateAutoSelectIds = useMemo(() => {
    return filteredDuplicateGroups.flatMap((group) => {
      const visibleIds = new Set(group.items.map((bookmark) => bookmark.id));
      return group.suggestedDeleteIds.filter((id) => visibleIds.has(id) && !whitelistIndex.protectedBookmarkIds.has(id));
    });
  }, [filteredDuplicateGroups, whitelistIndex]);

  const selectedDuplicateCount = useMemo(() => {
    return visibleDuplicateBookmarkIds.filter((id) => selectedDuplicateBookmarkIds.has(id)).length;
  }, [selectedDuplicateBookmarkIds, visibleDuplicateBookmarkIds]);

  const selectedAutoDuplicateCount = useMemo(() => {
    return visibleDuplicateAutoSelectIds.filter((id) => selectedDuplicateBookmarkIds.has(id)).length;
  }, [selectedDuplicateBookmarkIds, visibleDuplicateAutoSelectIds]);

  const areAllVisibleDuplicatesSelected = visibleDuplicateAutoSelectIds.length > 0 &&
    selectedAutoDuplicateCount === visibleDuplicateAutoSelectIds.length;

  const filteredPendingRecommendations = useMemo(() => {
    if (taskMode !== "unsorted") return [];
    const visibleRecommendations = pendingRecommendations.filter((item) => !whitelistIndex.protectedBookmarkIds.has(item.bookmarkId));
    if (!searchQuery.trim()) return visibleRecommendations;

    // 深度搜索已给出候选集时直接复用，避免本地检索与 AI 结果不一致。
    if (deepSearchActive) {
      const matchedIds = new Set(impressionResults.map((result) => result.bookmark.id));
      return visibleRecommendations.filter((recommendation) => matchedIds.has(recommendation.bookmarkId));
    }

    // 建议项的书签可能不在“未分类”列表中，需单独按印象检索。
    const matchedIds = new Set(searchBookmarksByImpression(
      searchQuery,
      visibleRecommendations.flatMap((item) => item.bookmarkUrl ? [{
        id: item.bookmarkId,
        title: item.bookmarkTitle,
        url: item.bookmarkUrl,
        folderPath: item.suggestedFolderPath.join(" / "),
      }] : []),
      semanticIndex
    ).map((result) => result.bookmark.id));
    return visibleRecommendations.filter((recommendation) => matchedIds.has(recommendation.bookmarkId));
  }, [deepSearchActive, impressionResults, pendingRecommendations, searchQuery, semanticIndex, taskMode, whitelistIndex]);

  const actionablePendingRecommendations = useMemo(
    () => filteredPendingRecommendations.filter(isBatchSafeRecommendation),
    [filteredPendingRecommendations]
  );
  const batchArchiveHint = actionablePendingRecommendations.length === 0
    ? "当前建议需逐条确认"
    : `归档当前列表中可批量处理的 ${actionablePendingRecommendations.length} 条建议，其余建议需逐条确认`;

  const groupedInvalidBookmarks = useMemo(() => {
    const groups: Record<LinkHealthGroupKey, BookmarkNode[]> = {
      broken: [],
      restricted: [],
      suspicious: [],
      temporary_failed: [],
    };

    filteredBookmarks.forEach((bookmark) => {
      const result = linkHealthResultById.get(bookmark.id);
      const group = result ? getLinkHealthGroupKey(result) : null;
      if (group) groups[group].push(bookmark);
    });

    return groups;
  }, [filteredBookmarks, linkHealthResultById]);

  const visibleInvalidBookmarkIds = useMemo(() => {
    if (taskMode !== "invalid") return [];
    return filteredBookmarks.map((bookmark) => bookmark.id);
  }, [filteredBookmarks, taskMode]);

  const selectedInvalidCount = useMemo(() => {
    return visibleInvalidBookmarkIds.filter((id) => selectedInvalidBookmarkIds.has(id)).length;
  }, [selectedInvalidBookmarkIds, visibleInvalidBookmarkIds]);

  const suggestedLinkHealthIds = useMemo(() => visibleInvalidBookmarkIds.filter((id) => {
    const result = linkHealthResultById.get(id);
    return result && isSuggestedLinkHealthCleanup(result);
  }), [linkHealthResultById, visibleInvalidBookmarkIds]);
  const areAllSuggestedLinkHealthSelected = suggestedLinkHealthIds.length > 0 &&
    suggestedLinkHealthIds.every((id) => selectedInvalidBookmarkIds.has(id));
  const linkHealthActionsDisabled = busy || scanningLinks || linkHealthReport?.status === "running";
  const selectedVisibleManualTaskIds = useMemo(() => {
    return visibleManualTaskBookmarkIds.filter((id) => selectedManualTaskBookmarkIds.has(id));
  }, [selectedManualTaskBookmarkIds, visibleManualTaskBookmarkIds]);


  const pageTitle = useMemo(() => {
    if (taskMode === "unsorted") return "待整理书签";
    if (taskMode === "duplicate") return "重复链接";
    if (taskMode === "invalid") return "失效链接";
    return "管理书签";
  }, [taskMode]);

  const pageSubtitle = useMemo(() => {
    if (taskMode === "duplicate") {
      if (!duplicateIgnores) return undefined;
      return duplicateGroups.length
        ? `${duplicateGroups.length} 组重复链接，涉及 ${taskBookmarks.length} 个书签`
        : "未发现重复链接";
    }
    if (taskMode === "unsorted") return `${unsortedTaskTotal} 项待处理`;
    if (taskMode === "invalid") {
      if (!linkHealthReport) return "手动检测书签链接状态";
      return `已检测 ${linkHealthReport.checkedCount} 个，需要复查 ${linkHealthResultById.size} 个`;
    }
    return `${bookmarks.length} 个本地书签`;
  }, [bookmarks.length, duplicateGroups.length, duplicateIgnores, linkHealthReport, linkHealthResultById.size, taskBookmarks.length, taskMode, unsortedTaskTotal]);

  const folderTree = useMemo(() => buildBookmarkFolderTree(filteredBookmarks, folders), [filteredBookmarks, folders]);
  const folderLookup = useMemo(() => collectFolderLookup(folderTree), [folderTree]);
  const visibleWhitelistEntries = useMemo(() => {
    const query = whitelistSearchQuery.trim().toLowerCase();
    if (!query) return whitelistEntries;
    return whitelistEntries.filter((entry) => {
      const item = entry.type === "folder"
        ? folders.find((folder) => folder.id === entry.id)
        : bookmarks.find((bookmark) => bookmark.id === entry.id);
      return [item?.title, item?.url, item?.path.join(" / "), entry.type === "folder" ? "文件夹" : "书签"]
        .some((value) => value?.toLowerCase().includes(query));
    });
  }, [bookmarks, folders, whitelistEntries, whitelistSearchQuery]);
  const selectedVisibleWhitelistEntries = visibleWhitelistEntries.filter((entry) =>
    selectedWhitelistKeys.has(entry.type + ":" + entry.id)
  );

  useEffect(() => {
    folderLookupRef.current = folderLookup;
  }, [folderLookup]);

  useEffect(() => {
    const visibleIds = new Set(visibleDuplicateBookmarkIds);
    setSelectedDuplicateBookmarkIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      const unchanged = next.size === prev.size && [...next].every((id) => prev.has(id));
      return unchanged ? prev : next;
    });
  }, [visibleDuplicateBookmarkIds]);

  useEffect(() => {
    const visibleIds = new Set(visibleInvalidBookmarkIds);
    setSelectedInvalidBookmarkIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      const unchanged = next.size === prev.size && [...next].every((id) => prev.has(id));
      return unchanged ? prev : next;
    });
  }, [visibleInvalidBookmarkIds]);

  useEffect(() => {
    const visibleIds = new Set(visibleManualTaskBookmarkIds);
    setSelectedManualTaskBookmarkIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      const unchanged = next.size === prev.size && [...next].every((id) => prev.has(id));
      return unchanged ? prev : next;
    });
  }, [visibleManualTaskBookmarkIds]);

  useEffect(() => {
    if (didApplyDefaultExpandedFolderRef.current) return;

    const defaultExpandedFolder = findDefaultExpandedRootFolder(folderTree);
    if (!defaultExpandedFolder) return;

    didApplyDefaultExpandedFolderRef.current = true;
    setExpandedFolders((prev) => {
      if (prev.has(defaultExpandedFolder.key)) return prev;
      const next = new Set(prev);
      next.add(defaultExpandedFolder.key);
      return next;
    });
  }, [folderTree]);

  const visibleExpandedFolders = useMemo(() => {
    if (!searchQuery && !taskMode) return expandedFolders;

    const keys = new Set<string>();
    const collect = (node: BookmarkFolderNode) => {
      keys.add(node.key);
      node.children.forEach(collect);
    };
    collect(folderTree);
    return keys;
  }, [expandedFolders, folderTree, searchQuery, taskMode]);

  useEffect(() => {
    const clearPendingTimer = () => {
      const session = dragSessionRef.current;
      if (session) {
        window.clearTimeout(session.timer);
      }
    };

    const clearHoverExpandTimer = () => {
      if (hoverExpandTimerRef.current !== null) {
        window.clearTimeout(hoverExpandTimerRef.current);
        hoverExpandTimerRef.current = null;
      }
      hoverExpandFolderKeyRef.current = null;
    };

    const resetDrag = () => {
      clearPendingTimer();
      clearHoverExpandTimer();
      dragSessionRef.current = null;
      activeDropFolderRef.current = null;
      setDraggedBookmark(null);
      setDragOverFolder(null);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session) return;

      const movement = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
      if (!session.active && movement > 8) {
        resetDrag();
        return;
      }

      if (!session.active) return;

      event.preventDefault();
      session.x = event.clientX;
      session.y = event.clientY;
      setDragPosition({ x: event.clientX, y: event.clientY });

      const element = document.elementFromPoint(event.clientX, event.clientY);
      const row = element instanceof Element ? element.closest<HTMLElement>("[data-bookmark-folder-key]") : null;
      const folderKey = row?.dataset.bookmarkFolderKey;
      const folder = folderKey ? folderLookupRef.current.get(folderKey) : null;

      if (folder?.id && folder.id !== session.bookmark.parentId) {
        activeDropFolderRef.current = folder;
        setDragOverFolder(folder.key);
        if (hoverExpandFolderKeyRef.current !== folder.key) {
          clearHoverExpandTimer();
          hoverExpandFolderKeyRef.current = folder.key;
          hoverExpandTimerRef.current = window.setTimeout(() => {
            setExpandedFolders((prev) => {
              if (prev.has(folder.key)) return prev;
              const next = new Set(prev);
              next.add(folder.key);
              return next;
            });
            hoverExpandTimerRef.current = null;
          }, 1500);
        }
      } else {
        clearHoverExpandTimer();
        activeDropFolderRef.current = null;
        setDragOverFolder(null);
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session) return;

      const wasActive = session.active;
      const bookmark = session.bookmark;
      const targetFolder = activeDropFolderRef.current;
      if (wasActive) {
        suppressNextFolderClickRef.current = true;
        window.setTimeout(() => {
          suppressNextFolderClickRef.current = false;
        }, 100);
      }
      resetDrag();

      if (!wasActive || !targetFolder?.id || targetFolder.id === bookmark.parentId) return;
      const targetFolderId = targetFolder.id;

      event.preventDefault();
      void (async () => {
        setBusy(true);
        setMessage("");
        try {
          await moveBookmark(bookmark.id, targetFolderId);
          const [learningNotice] = await Promise.all([
            recordHabitFeedback({
              type: "category_override",
              bookmarkTitle: bookmark.title,
              bookmarkUrl: bookmark.url,
              suggestedFolderPath: bookmark.path,
              chosenFolderPath: targetFolder.path,
            }).catch(() => null),
            appendFolderImpression(bookmark.url, targetFolder.path).catch(() => undefined),
          ]);
          await loadManagedBookmarks();
          setMessage(learningNotice ?? `已移动到 ${targetFolder.path.join(" / ") || targetFolder.title}`, "success");
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "移动失败", "error");
        } finally {
          setBusy(false);
        }
      })();
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", resetDrag);

    return () => {
      clearPendingTimer();
      clearHoverExpandTimer();
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", resetDrag);
    };
  }, [loadManagedBookmarks]);

  const toggleFolder = (folder: BookmarkFolderNode) => {
    if (suppressNextFolderClickRef.current) {
      suppressNextFolderClickRef.current = false;
      return;
    }

    setSelectedFolder(folder.key);
    if (folder.path.length) {
      setAddForm((prev) => ({ ...prev, path: folder.path.join(" / ") }));
    }
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder.key)) {
        next.delete(folder.key);
      } else {
        next.add(folder.key);
      }
      return next;
    });
  };

  const toggleLinkHealthGroup = (group: LinkHealthGroupKey) => {
    setCollapsedLinkHealthGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  const toggleDuplicateBookmarkSelection = (bookmarkId: string) => {
    setSelectedDuplicateBookmarkIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookmarkId)) {
        next.delete(bookmarkId);
      } else {
        next.add(bookmarkId);
      }
      return next;
    });
  };

  const toggleSuggestedDuplicateSelection = () => {
    setSelectedDuplicateBookmarkIds((prev) => {
      const next = new Set(prev);
      if (areAllVisibleDuplicatesSelected) {
        visibleDuplicateAutoSelectIds.forEach((id) => next.delete(id));
      } else {
        visibleDuplicateAutoSelectIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const toggleInvalidBookmarkSelection = (bookmarkId: string) => {
    setSelectedInvalidBookmarkIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookmarkId)) {
        next.delete(bookmarkId);
      } else {
        next.add(bookmarkId);
      }
      return next;
    });
  };

  const toggleLinkHealthSelection = (ids: string[]) => {
    setSelectedInvalidBookmarkIds((prev) => {
      const next = new Set(prev);
      if (ids.every((id) => prev.has(id))) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const toggleManualTaskBookmarkSelection = (bookmarkId: string) => {
    setSelectedManualTaskBookmarkIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookmarkId)) {
        next.delete(bookmarkId);
      } else {
        next.add(bookmarkId);
      }
      return next;
    });
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确认删除此书签？")) return;
    setBusy(true);
    setMessage("");
    try {
      await removeBookmark(id);
      const [nextReport] = await Promise.all([
        removeBookmarkFromLinkHealthReport(id),
        loadManagedBookmarks(),
      ]);
      setLinkHealthReport(nextReport);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSelectedDuplicates = async () => {
    const selectedIds = new Set(
      visibleDuplicateBookmarkIds.filter((id) => selectedDuplicateBookmarkIds.has(id))
    );
    const selectedBookmarks = bookmarks.filter((bookmark) => selectedIds.has(bookmark.id));

    if (!selectedBookmarks.length) {
      setMessage("请先勾选要删除的重复书签");
      return;
    }

    const fullySelectedGroup = duplicateGroups.find((group) => {
      return group.items.length > 1 && group.items.every((bookmark) => selectedIds.has(bookmark.id));
    });

    if (fullySelectedGroup) {
      setMessage(`不能删除「${fullySelectedGroup.key}」的全部副本，请至少保留一个书签`);
      return;
    }

    const confirmed = confirm(
      `确认删除选中的 ${selectedBookmarks.length} 个书签吗？\n\n删除前会自动保存完整书签备份，可在“书签备份”中恢复。`
    );
    if (!confirmed) return;

    setBusy(true);
    setMessage("");
    try {
      await createDuplicateDeleteBackup();

      const [protection, ignored] = await Promise.all([getCurrentWhitelist(), getDuplicateBookmarkIgnores()]);
      const currentGroups = getDuplicateBookmarkGroups(getUrlBookmarks(protection.tree), ignored, protection.index.protectedBookmarkIds);
      const currentTargets = new Map(currentGroups
        .filter((group) => group.items.some(({ id }) => !selectedIds.has(id)))
        .flatMap((group) => group.items.map((bookmark) => [bookmark.id, bookmark] as const)));
      const deletedIds = new Set<string>();
      const failedItems: string[] = [];
      let nextReport = linkHealthReport;

      for (const bookmark of selectedBookmarks) {
        try {
          const current = currentTargets.get(bookmark.id);
          if (!current || current.url !== bookmark.url || current.parentId !== bookmark.parentId) {
            throw new Error("书签或保留副本已变化，请重新核对");
          }
          await removeBookmark(bookmark.id);
          deletedIds.add(bookmark.id);
          nextReport = await removeBookmarkFromLinkHealthReport(bookmark.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "删除失败";
          failedItems.push(`${bookmark.title}：${reason}`);
        }
      }

      await loadManagedBookmarks();
      setLinkHealthReport(nextReport);
      setSelectedDuplicateBookmarkIds((prev) => {
        const next = new Set(prev);
        deletedIds.forEach((id) => next.delete(id));
        return next;
      });
      if (failedItems.length > 0) {
        setMessage(`已删除 ${deletedIds.size} 个重复书签，${failedItems.length} 个失败：${failedItems.slice(0, 2).join("；")}`);
      } else {
        setMessage(`已删除 ${deletedIds.size} 个重复书签，并已创建删除前备份`, "success");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量删除重复书签失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDuplicateIgnore = async (items: BookmarkNode[], ignore: boolean) => {
    const entries = items.flatMap(({ id, url }) => url ? [{ id, url }] : []);
    if (!entries.length) return;
    setBusy(true);
    setMessage("");
    try {
      await updateDuplicateBookmarkIgnores(entries, ignore);
      setSelectedDuplicateBookmarkIds(new Set());
      setMessage(ignore ? `已在重复检测中忽略 ${entries.length} 个书签` : "已恢复重复检测", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新重复检测忽略记录失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteLinkHealthBookmarks = async (single?: BookmarkLinkHealthResult) => {
    if (!linkHealthReport || linkHealthActionsDisabled) return;
    const selected = single ? [single] : visibleInvalidBookmarkIds.flatMap((id) => {
      const result = linkHealthResultById.get(id);
      return selectedInvalidBookmarkIds.has(id) && result ? [result] : [];
    });
    if (!selected.length) return;

    const target = single
      ? `「${single.bookmarkTitle}」${single.httpStatus ? `（HTTP ${single.httpStatus}）` : ""}`
      : `选中的 ${selected.length} 个书签`;
    const confirmed = confirm(`确认删除${target}吗？\n\n检测结果仅供核对。删除前会创建完整书签备份。`);
    if (!confirmed) return;

    setBusy(true);
    setMessage("");
    try {
      const { deletedIds, failedItems } = await deleteLinkHealthBookmarks(linkHealthReport.id, selected);
      const [nextReport] = await Promise.all([getLinkHealthReport(), loadManagedBookmarks()]);
      setLinkHealthReport(nextReport);
      setSelectedInvalidBookmarkIds((prev) => {
        const next = new Set(prev);
        deletedIds.forEach((id) => next.delete(id));
        return next;
      });
      if (failedItems.length > 0) {
        setMessage(`已删除 ${deletedIds.size} 个书签，${failedItems.length} 个失败：${failedItems.slice(0, 2).join("；")}`);
      } else {
        setMessage(`已删除 ${deletedIds.size} 个书签，并已创建备份`, "success");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除书签失败");
    } finally {
      setBusy(false);
    }
  };

  const handleLinkHealthIgnore = async (items: BookmarkNode[], ignore: boolean) => {
    const entries = items.flatMap(({ id, url }) => url ? [{ id, url }] : []);
    if (!entries.length || linkHealthActionsDisabled) return;
    setBusy(true);
    try {
      await updateBookmarkCheckIgnores("linkHealthBookmarkIgnores", entries, ignore);
      setSelectedInvalidBookmarkIds(new Set());
      setMessage(ignore ? `已在失效检测中忽略 ${entries.length} 个书签` : "已恢复失效检测", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新失效检测忽略记录失败");
    } finally {
      setBusy(false);
    }
  };

  const handleLinkHealthRecheck = async (result: BookmarkLinkHealthResult) => {
    if (!linkHealthReport || linkHealthActionsDisabled) return;
    setBusy(true);
    setMessage("");
    try {
      await ensureRequiredHostPermission();
      const report = await recheckLinkHealthBookmark(linkHealthReport.id, result);
      setLinkHealthReport(report);
      const checked = report?.results.find(({ bookmarkId }) => bookmarkId === result.bookmarkId);
      setMessage(checked?.status === "ok" ? "复测成功，已移出复查列表" : "已更新复测结果", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "复测失败");
    } finally {
      setBusy(false);
    }
  };

  const handleEditStart = (bookmark: BookmarkNode) => {
    setEditingId(bookmark.id);
    setEditForm({
      title: bookmark.title,
      url: bookmark.url || "",
      path: bookmark.path.join(" / "),
    });
  };

  const handleEditSave = async () => {
    if (!editingId || !editForm.title || !editForm.url) {
      setMessage("请填写标题和网址");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const originalBookmark = bookmarks.find((bookmark) => bookmark.id === editingId);
      await updateBookmark(editingId, editForm.title, editForm.url);
      const folderPath = parseFolderPath(editForm.path, settings.maxNestingLevel);
      const parentId = await ensureFolderPath(folderPath, settings.maxNestingLevel);
      await moveBookmark(editingId, parentId);
      const [learningNotice] = await Promise.all([
        originalBookmark
          ? recordHabitFeedback({
              type: "category_override",
              bookmarkTitle: editForm.title,
              bookmarkUrl: editForm.url,
              suggestedFolderPath: originalBookmark.path,
              chosenFolderPath: folderPath,
            }).catch(() => null)
          : Promise.resolve(null),
        appendFolderImpression(editForm.url, folderPath).catch(() => undefined),
      ]);
      await loadManagedBookmarks();
      setEditingId(null);
      setMessage(learningNotice ?? "书签修改已保存", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleEditRecommendationStart = (recommendation: PendingRecommendation) => {
    setEditingRecommendationId(recommendation.id);
    setRecommendationPathDraft(recommendation.suggestedFolderPath.join(" / "));
    setMessage("");
  };

  const handleSaveRecommendationPath = async (recommendation: PendingRecommendation) => {
    const folderPath = parseFolderPath(recommendationPathDraft, settings.maxNestingLevel);
    if (folderPath.length === 0) {
      setMessage("请填写目标文件夹");
      return;
    }

    setBusyRecommendationId(recommendation.id);
    setMessage("");
    try {
      await updateRecommendationFolderPath(recommendation.id, folderPath);
      const learningNotice = await recordHabitFeedback({
        type: "category_override",
        bookmarkTitle: recommendation.bookmarkTitle,
        bookmarkUrl: recommendation.bookmarkUrl,
        suggestedFolderPath: recommendation.suggestedFolderPath,
        chosenFolderPath: folderPath,
      }).catch(() => null);
      await loadManagedBookmarks();
      setEditingRecommendationId(null);
      setRecommendationPathDraft("");
      setMessage(learningNotice ?? `已更新推荐目标：${folderPath.join(" / ")}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存推荐目标失败");
    } finally {
      setBusyRecommendationId(null);
    }
  };

  const handleAcceptRecommendation = async (recommendation: PendingRecommendation) => {
    if (getRecommendationKind(recommendation) === "create_folder" && !confirm(`将创建文件夹“${recommendation.suggestedFolderPath.join(" / ")}”并归档此书签。执行前会创建完整备份，是否继续？`)) return;
    setBusyRecommendationId(recommendation.id);
    setMessage("");
    try {
      const report = await acceptRecommendation(recommendation);
      await Promise.all([loadManagedBookmarks(), loadReports()]);
      setEditingRecommendationId(null);
      setRecommendationPathDraft("");
      setMessage(
        report.failedItems.length > 0
          ? `推荐移动失败：${report.failedItems[0].reason}；详情已写入整理报告`
          : `已移动到 ${recommendation.suggestedFolderPath.join(" / ")}，操作前备份和整理报告已保存`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "接受推荐失败");
      await loadRecommendations().catch(() => undefined);
    } finally {
      setBusyRecommendationId(null);
    }
  };

  const handleIgnoreRecommendation = async (recommendation: PendingRecommendation) => {
    setBusyRecommendationId(recommendation.id);
    setMessage("");
    try {
      await removeRecommendation(recommendation.id);
      await loadManagedBookmarks();
      setMessage("已跳过这条建议，分类偏好保持原样");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "跳过建议失败");
    } finally {
      setBusyRecommendationId(null);
    }
  };

  const handleRetryRecommendation = async (recommendation: PendingRecommendation) => {
    setBusyRecommendationId(recommendation.id);
    setMessage("");
    try {
      await retryRecommendation(recommendation);
      await loadManagedBookmarks();
      setMessage("已重新判断该书签；书签位置未改变");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重新分类失败");
      await loadManagedBookmarks();
    } finally {
      setBusyRecommendationId(null);
    }
  };

  const handleRejectRecommendationCategory = async (recommendation: PendingRecommendation) => {
    setBusyRecommendationId(recommendation.id);
    setMessage("");
    try {
      await removeRecommendation(recommendation.id);
      const learningNotice = await recordHabitFeedback({
        type: "folder_rejected",
        bookmarkTitle: recommendation.bookmarkTitle,
        bookmarkUrl: recommendation.bookmarkUrl,
        suggestedFolderPath: recommendation.suggestedFolderPath,
      }).catch(() => null);
      await loadManagedBookmarks();
      setMessage(learningNotice ?? "建议已移除，但未能记录分类偏好");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "记录分类反馈失败");
    } finally {
      setBusyRecommendationId(null);
    }
  };

  const handleIgnoreSelectedManualTaskBookmarks = async () => {
    const targetBookmarks = filteredBookmarks.filter((bookmark) => selectedManualTaskBookmarkIds.has(bookmark.id));

    if (!targetBookmarks.length) {
      setMessage("请先选择要忽略的手动归档书签");
      return;
    }

    setIgnoringManualSelection(true);
    setMessage("");
    try {
      const nextIds = new Set(ignoredManualTaskBookmarkIds);
      targetBookmarks.forEach((bookmark) => nextIds.add(bookmark.id));
      const nextList = [...nextIds];
      await saveIgnoredManualTaskBookmarkIds(nextList);
      setIgnoredManualTaskBookmarkIds(nextIds);
      setSelectedManualTaskBookmarkIds((prev) => {
        const nextSelected = new Set(prev);
        targetBookmarks.forEach((bookmark) => nextSelected.delete(bookmark.id));
        return nextSelected;
      });
      setMessage(`已忽略 ${targetBookmarks.length} 个手动归档书签`, "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "忽略手动归档项失败");
    } finally {
      setIgnoringManualSelection(false);
    }
  };

  const handleAcceptVisibleRecommendations = async () => {
    setBulkRecommendationAction("accept");
    setMessage("");

    try {
      const report = await acceptRecommendations(actionablePendingRecommendations);
      await Promise.all([loadManagedBookmarks(), loadReports()]);
      const result = report.failedItems.length > 0
        ? `已移动 ${report.movedCount} 个，${report.failedItems.length} 个失败，详情已写入整理报告`
        : `已归档 ${report.movePlan.length} 条分类建议，操作前备份和整理报告已保存`;
      const skipped = actionablePendingRecommendations.length - report.movePlan.length;
      setMessage(skipped > 0 ? `${result}。已跳过 ${skipped} 条失效或已更新的建议。` : result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量归档失败");
      await loadRecommendations().catch(() => undefined);
    } finally {
      setBulkRecommendationAction(null);
    }
  };

  const handleIgnoreVisibleRecommendations = async () => {
    setBulkRecommendationAction("ignore");
    setMessage("");
    const failed: string[] = [];

    try {
      for (const recommendation of filteredPendingRecommendations) {
        try {
          await removeRecommendation(recommendation.id);
        } catch {
          failed.push(recommendation.bookmarkTitle || recommendation.bookmarkId);
        }
      }

      await loadManagedBookmarks();
      setMessage(
        failed.length > 0
          ? `部分建议跳过失败：${failed.slice(0, 3).join("、")}${failed.length > 3 ? " 等" : ""}`
          : `已跳过 ${filteredPendingRecommendations.length} 条分类建议，分类偏好保持原样`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量跳过建议失败");
    } finally {
      setBulkRecommendationAction(null);
    }
  };

  const protectSelectedBookmarks = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await addBookmarkWhitelistEntries(ids);
      const addedCount = next.length - whitelistEntries.length;
      await loadManagedBookmarks();
      setMessage(addedCount > 0 ? `已保护 ${addedCount} 个书签` : "所选书签均已受到保护", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量加入白名单失败");
    } finally {
      setBusy(false);
    }
  };

  const toggleWhitelist = async (type: BookmarkWhitelistEntry["type"], id: string) => {
    setBusy(true);
    setMessage("");
    try {
      const hasDirectRule = whitelistEntries.some((entry) => entry.type === type && entry.id === id);
      if (hasDirectRule) await removeBookmarkWhitelistEntry(type, id);
      else await addBookmarkWhitelistEntry(type, id);
      await loadManagedBookmarks();
      const protectedItems = type === "folder" ? "此文件夹及其内容" : "此书签";
      setMessage(hasDirectRule ? "已移除保护规则" : `已保护${protectedItems}`, "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新白名单失败");
    } finally {
      setBusy(false);
    }
  };

  const removeSelectedWhitelistEntries = async () => {
    if (!selectedVisibleWhitelistEntries.length) return;
    setBusy(true);
    setMessage("");
    try {
      await removeBookmarkWhitelistEntries(selectedVisibleWhitelistEntries);
      setSelectedWhitelistKeys(new Set());
      await loadManagedBookmarks();
      setMessage("已解除所选项目的白名单保护", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量解除保护失败");
    } finally {
      setBusy(false);
    }
  };

  const locateWhitelistEntry = (entry: BookmarkWhitelistEntry) => {
    const item = entry.type === "folder"
      ? folders.find((folder) => folder.id === entry.id)
      : bookmarks.find((bookmark) => bookmark.id === entry.id);
    if (!item) {
      setMessage("原项目已不存在，可从白名单中移除这条规则");
      return;
    }
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const folderId = entry.type === "folder" ? item.id : item.parentId;
    const keys = new Set(["__root__"]);
    let currentId = folderId;
    while (currentId && folderById.has(currentId)) {
      keys.add("folder:" + currentId);
      currentId = folderById.get(currentId)?.parentId;
    }
    setSearchQuery("");
    setExpandedFolders((current) => new Set([...current, ...keys]));
    setSelectedFolder(folderId && folderById.has(folderId) ? "folder:" + folderId : "__root__");
    window.setTimeout(() => {
      const attribute = entry.type === "folder" ? "data-bookmark-folder-key" : "data-bookmark-id";
      const value = entry.type === "folder" ? "folder:" + entry.id : entry.id;
      const row = [...document.querySelectorAll<HTMLElement>("[" + attribute + "]")]
        .find((element) => element.getAttribute(attribute) === value);
      row?.scrollIntoView({ block: "center" });
    }, 0);
  };

  const renderFolderNode = (folder: BookmarkFolderNode, depth = 0) => {
    const isExpanded = visibleExpandedFolders.has(folder.key);
    const isSelected = selectedFolder === folder.key;
    const hasChildren = folder.children.length > 0 || folder.bookmarks.length > 0;
    const isDropTarget = Boolean(draggedBookmark && folder.id && folder.id !== draggedBookmark.parentId);
    const isDragOver = dragOverFolder === folder.key;

    return (
      <div key={folder.key}>
        <div className="bookmark-whitelist-folder-row">
        <button
          type="button"
          className={`bookmark-tree-row bookmark-tree-row--folder ${isSelected ? "is-selected" : ""} ${isDropTarget ? "is-drop-target" : ""} ${isDragOver ? "is-drag-over" : ""}`}
          style={{ "--tree-depth": depth } as CSSProperties}
          aria-expanded={isExpanded}
          data-bookmark-folder-key={folder.id ? folder.key : undefined}
          onClick={() => toggleFolder(folder)}
        >
          <span className="bookmark-tree-row__chevron">
            {hasChildren ? (
              isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
            ) : null}
          </span>
          <Folder className="bookmark-tree-row__folder-icon" />
          <span className="bookmark-tree-row__title">{folder.title}</span>
          <span className="bookmark-tree-row__count">{folder.count}</span>
        </button>
        {folder.id && (
          <button
            type="button"
            className="extension-icon-action bookmark-whitelist-action"
            disabled={busy || (whitelistIndex.protectedFolderIds.has(folder.id) &&
              !whitelistEntries.some((entry) => entry.type === "folder" && entry.id === folder.id))}
            title={whitelistIndex.reasonById.get(folder.id) ?? "保护此文件夹及其中的书签和子文件夹"}
            aria-label={whitelistEntries.some((entry) => entry.type === "folder" && entry.id === folder.id) ? "解除文件夹白名单" : "保护此文件夹及其中的书签和子文件夹"}
            onClick={() => void toggleWhitelist("folder", folder.id!)}
          >
            {whitelistIndex.protectedFolderIds.has(folder.id) ? <ShieldCheck className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
          </button>
        )}
        </div>

        {isExpanded && (
          <>
            {folder.children.map((child) => renderFolderNode(child, depth + 1))}
            {folder.bookmarks.map((bookmark) => renderBookmarkRow(bookmark, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const canDragBookmark = (bookmarkId: string) =>
    !busy && editingId !== bookmarkId && !whitelistIndex.protectedBookmarkIds.has(bookmarkId);

  const renderBookmarkRow = (bookmark: BookmarkNode, depth: number) => (
    <div
      key={bookmark.id}
      className={`bookmark-tree-row bookmark-tree-row--bookmark${canDragBookmark(bookmark.id) ? " bookmark-tree-row--draggable" : ""}${draggedBookmark?.id === bookmark.id ? " is-dragging" : ""}`}
      data-bookmark-id={bookmark.id}
      style={{ "--tree-depth": depth } as CSSProperties}
      onPointerDown={(event) => {
        if (busy || editingId === bookmark.id || whitelistIndex.protectedBookmarkIds.has(bookmark.id) || event.button !== 0) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("a,button,input,select,textarea")) return;

        event.preventDefault();
        window.getSelection()?.removeAllRanges();

        const session: DragSession = {
          bookmark,
          active: false,
          startX: event.clientX,
          startY: event.clientY,
          x: event.clientX,
          y: event.clientY,
          timer: window.setTimeout(() => {
            const current = dragSessionRef.current;
            if (!current || current.bookmark.id !== bookmark.id) return;
            current.active = true;
            window.getSelection()?.removeAllRanges();
            setDraggedBookmark(bookmark);
            setDragPosition({ x: current.x, y: current.y });
          }, 250),
        };

        dragSessionRef.current = session;
      }}
    >
      {editingId === bookmark.id ? (
        <div className="bookmark-tree-edit">
          <input type="text" value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} className="extension-control" />
          <input type="url" value={editForm.url} onChange={(event) => setEditForm({ ...editForm, url: event.target.value })} className="extension-control" />
          <input type="text" value={editForm.path} onChange={(event) => setEditForm({ ...editForm, path: event.target.value })} className="extension-control" />
          <div className="extension-button-row">
            <button onClick={handleEditSave} disabled={busy} className="extension-page__wide-primary">
              <Check className="w-4 h-4" />
              保存
            </button>
            <button onClick={() => setEditingId(null)} className="extension-page__wide-secondary">
              <X className="w-4 h-4" />
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          <span
            className={canDragBookmark(bookmark.id) ? "bookmark-tree-row__chevron bookmark-tree-row__grip" : "bookmark-tree-row__chevron"}
            title={canDragBookmark(bookmark.id) ? "按住拖拽到其他文件夹" : undefined}
          >
            {canDragBookmark(bookmark.id) ? <GripVertical aria-hidden="true" /> : null}
          </span>
          <BookmarkFavicon title={bookmark.title} url={bookmark.url} />
          <span className="bookmark-tree-row__title" title={bookmark.title}>{bookmark.title}</span>
          {(() => {
            const match = impressionResultById.get(bookmark.id);
            if (!match?.matchHint || !isImpressionMatch(match)) return null;
            return (
              <span className="bookmark-tree-row__match" title={match.matchHint}>
                <span>{getImpressionMatchIcon(match)} {match.matchHint}</span>
                {match.healed && <i className="impression-healed-badge"><Zap aria-hidden="true" />已记住该印象</i>}
              </span>
            );
          })()}
          {bookmark.url && (
            <a href={bookmark.url} target="_blank" rel="noopener noreferrer" className="extension-link-icon" aria-label="打开书签">
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <BookmarkRowActionMenu
            bookmarkTitle={bookmark.title}
            isProtected={whitelistIndex.protectedBookmarkIds.has(bookmark.id)}
            hasDirectWhitelistEntry={whitelistEntries.some((entry) => entry.type === "bookmark" && entry.id === bookmark.id)}
            protectionReason={whitelistIndex.reasonById.get(bookmark.id)}
            busy={busy}
            onToggleProtection={() => void toggleWhitelist("bookmark", bookmark.id)}
            onEdit={() => handleEditStart(bookmark)}
            onDelete={() => void handleDelete(bookmark.id)}
          />
        </>
      )}
    </div>
  );

  const renderUnsortedBookmarkRow = (bookmark: BookmarkNode) => {
    const isSelected = selectedManualTaskBookmarkIds.has(bookmark.id);
    const disabled = busy || ignoringManualSelection;
    const match = impressionResultById.get(bookmark.id);
    const bookmarkPath = bookmark.path.join(" / ") || "根目录";

    return (
      <div key={bookmark.id} className={`bookmark-tree-row bookmark-tree-row--bookmark bookmark-tree-row--selectable bookmark-task-row ${isSelected ? "is-selected" : ""}`}>
        {editingId === bookmark.id ? (
          <div className="bookmark-tree-edit bookmark-task-row__edit">
            <label>标题
              <input type="text" value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} className="extension-control" disabled={disabled} />
            </label>
            <label>网址
              <input type="url" value={editForm.url} onChange={(event) => setEditForm({ ...editForm, url: event.target.value })} className="extension-control" disabled={disabled} />
            </label>
            <label>目标文件夹路径
              <input type="text" autoFocus value={editForm.path} onChange={(event) => setEditForm({ ...editForm, path: event.target.value })} className="extension-control" placeholder="例如：工作 / 文档" disabled={disabled} />
            </label>
            <div className="extension-button-row">
              <button type="button" onClick={handleEditSave} disabled={disabled} className="extension-page__wide-primary">
                <Check className="w-4 h-4" />
                保存归档
              </button>
              <button type="button" onClick={() => setEditingId(null)} disabled={disabled} className="extension-page__wide-secondary">
                <X className="w-4 h-4" />
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="bookmark-task-row__label">
              <input
                type="checkbox"
                checked={isSelected}
                disabled={disabled}
                onChange={() => toggleManualTaskBookmarkSelection(bookmark.id)}
                className="extension-checkbox bookmark-tree-row__checkbox"
                aria-label={`选择书签：${bookmark.title}`}
              />
              <BookmarkFavicon title={bookmark.title} url={bookmark.url} />
              <span className="bookmark-task-row__identity">
                <span className="bookmark-tree-row__title" title={bookmark.title}>{bookmark.title}</span>
                <span className="bookmark-task-row__path" title={bookmarkPath}>{bookmarkPath}</span>
                {match?.matchHint && isImpressionMatch(match) && (
                  <span className="bookmark-unsorted-card__meta bookmark-unsorted-card__match">
                    {getImpressionMatchIcon(match)} {match.matchHint}
                    {match.healed && <i className="impression-healed-badge"><Zap aria-hidden="true" />已记住该印象</i>}
                  </span>
                )}
              </span>
            </label>
            {bookmark.url && (
              <a href={bookmark.url} target="_blank" rel="noopener noreferrer" className="extension-link-icon"
                aria-label={`打开书签：${bookmark.title}`} title={bookmark.url}>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
            <BookmarkRowActionMenu
              bookmarkTitle={bookmark.title}
              busy={disabled}
              onArchive={() => handleEditStart(bookmark)}
              onToggleProtection={() => void toggleWhitelist("bookmark", bookmark.id)}
              onDelete={() => void handleDelete(bookmark.id)}
            />
          </>
        )}
      </div>
    );
  };

  const renderRecommendationCard = (recommendation: PendingRecommendation) => {
    const isBusy = busyRecommendationId === recommendation.id;
    const isEditingRecommendation = editingRecommendationId === recommendation.id;
    const kind = getRecommendationKind(recommendation);
    const isActionable = isActionableRecommendation(recommendation);
    const isNewFolder = kind === "create_folder";
    const hasError = kind === "error";
    const signalLabel = getRecommendationSignalLabel(recommendation);
    const showSignal = isActionable && !isEditingRecommendation && signalLabel !== "需要确认";
    const actionDisabled = busy || Boolean(busyRecommendationId || bulkRecommendationAction || editingRecommendationId);
    const primaryLabel = isActionable ? (isNewFolder ? "创建目录并归档" : "归档书签") : "重新分类";
    const PrimaryIcon = isBusy || !isActionable ? RefreshCw : isNewFolder ? FolderPlus : Check;

    return (
      <article key={recommendation.id} className={`bookmark-task-recommendation${isEditingRecommendation ? " is-editing" : ""}`}>
          <BookmarkFavicon
            title={recommendation.bookmarkTitle}
            url={recommendation.bookmarkUrl}
            className="bookmark-unsorted-card__favicon"
            fallbackClassName="bookmark-unsorted-card__icon"
          />
          <h4 title={recommendation.bookmarkTitle}>{recommendation.bookmarkTitle}</h4>
          <div className="bookmark-task-recommendation__details">
            {recommendation.bookmarkUrl && <p className="bookmark-unsorted-card__url">{recommendation.bookmarkUrl}</p>}
            {(() => {
              const match = impressionResultById.get(recommendation.bookmarkId);
              if (!match?.matchHint || !isImpressionMatch(match)) return null;
              return (
                <p className="bookmark-unsorted-card__meta bookmark-unsorted-card__match">
                  {getImpressionMatchIcon(match)} {match.matchHint}
                  {match.healed && <i className="impression-healed-badge"><Zap aria-hidden="true" />已记住该印象</i>}
                </p>
              );
            })()}
            {isEditingRecommendation ? (
              <label className="bookmark-recommendation-edit">
                <span>目标文件夹</span>
                <input
                  type="text"
                  autoFocus
                  value={recommendationPathDraft}
                  onChange={(event) => setRecommendationPathDraft(event.target.value)}
                  className="extension-control"
                  placeholder="例如：工作 / 文档"
                  disabled={isBusy}
                />
              </label>
            ) : isActionable ? (
              <div className={["bookmark-unsorted-target", isNewFolder ? "bookmark-unsorted-target--new" : ""].filter(Boolean).join(" ")}>
                <Folder className="w-4 h-4" aria-hidden="true" />
                <span>{isNewFolder ? "归档至新文件夹：" : "归档至："}{recommendation.suggestedFolderPath.join(" / ")}</span>
              </div>
            ) : (
              <div className={["bookmark-unsorted-target", hasError ? "bookmark-unsorted-target--error" : "bookmark-unsorted-target--manual"].join(" ")}>
                <RefreshCw className="w-4 h-4" />
                <span>{hasError ? "分类失败，书签保持原位" : "需要手动判断，书签保持原位"}</span>
              </div>
            )}
            {(showSignal || recommendation.reason) && (
              <p className="bookmark-unsorted-card__meta">
                {showSignal && (
                  <strong className="recommendation-signal" title="依据仅作相对参考，不代表分类正确率">
                    {signalLabel}{recommendation.reason && "："}
                  </strong>
                )}
                {recommendation.reason}
              </p>
            )}
          </div>
        <div className="bookmark-task-recommendation__actions">
          {isEditingRecommendation ? (
            <>
              <button
                type="button"
                onClick={() => void handleSaveRecommendationPath(recommendation)}
                disabled={isBusy || Boolean(bulkRecommendationAction)}
                className="extension-page__wide-primary"
              >
                <Check className="w-4 h-4" />
                保存分类
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingRecommendationId(null);
                  setRecommendationPathDraft("");
                }}
                disabled={isBusy || Boolean(bulkRecommendationAction)}
                className="extension-page__wide-secondary"
              >
                <X className="w-4 h-4" />
                取消
              </button>
            </>
          ) : (
            <>
              {recommendation.bookmarkUrl && (
                <a href={recommendation.bookmarkUrl} target="_blank" rel="noopener noreferrer" className="extension-link-icon"
                  aria-label={`打开书签：${recommendation.bookmarkTitle}`} title={recommendation.bookmarkUrl}>
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
              <button
                type="button"
                onClick={() => void (isActionable ? handleAcceptRecommendation(recommendation) : handleRetryRecommendation(recommendation))}
                disabled={actionDisabled}
                className="extension-icon-action extension-icon-action--blue"
                aria-label={`${primaryLabel}：${recommendation.bookmarkTitle}`}
                title={primaryLabel}
              >
                <PrimaryIcon className={`w-4 h-4${isBusy ? " bookmark-task-panel__spin" : ""}`} aria-hidden="true" />
              </button>
              <RecommendationRowActionMenu bookmarkTitle={recommendation.bookmarkTitle} busy={actionDisabled}
                editLabel={isActionable ? "修改目录" : "指定目录"}
                rejectLabel={isNewFolder ? "减少建议创建此目录" : "减少推荐到此目录"}
                onEdit={() => handleEditRecommendationStart(recommendation)}
                onProtect={() => void toggleWhitelist("bookmark", recommendation.bookmarkId)}
                onSkip={() => void handleIgnoreRecommendation(recommendation)}
                onReject={isActionable ? () => void handleRejectRecommendationCategory(recommendation) : undefined}
              />
            </>
          )}
        </div>
      </article>
    );
  };

  const renderUnsortedTasks = () => {
    const hasVisibleItems = filteredPendingRecommendations.length > 0 || filteredBookmarks.length > 0;

    return (
      <>
        {filteredPendingRecommendations.length > 0 && (
          <section className="bookmark-health-panel">
            <BookmarkTaskHeader title="分类建议" icon={<Sparkles aria-hidden="true" />}
              summary={`${filteredPendingRecommendations.length} 条建议`}>
              <button
                type="button"
                onClick={() => void handleIgnoreVisibleRecommendations()}
                disabled={busy || Boolean(bulkRecommendationAction || busyRecommendationId || editingRecommendationId)}
                className="extension-page__wide-secondary"
                title={`跳过当前列表中的 ${filteredPendingRecommendations.length} 条建议，分类偏好保持原样`}
              >
                {bulkRecommendationAction === "ignore" ? "跳过中" : "批量跳过"}
              </button>
              <div className="bookmark-unsorted-batch-action" role="group" title={batchArchiveHint} aria-label={batchArchiveHint} tabIndex={actionablePendingRecommendations.length === 0 ? 0 : undefined}>
                <button
                  type="button"
                  onClick={() => void handleAcceptVisibleRecommendations()}
                  disabled={busy || Boolean(bulkRecommendationAction || busyRecommendationId || editingRecommendationId) || actionablePendingRecommendations.length === 0}
                  className="extension-page__wide-primary"
                >
                  <Check className="w-4 h-4" />
                  {bulkRecommendationAction === "accept" ? "归档中" : `批量归档（${actionablePendingRecommendations.length}）`}
                </button>
              </div>
            </BookmarkTaskHeader>
            <div className="bookmark-task-list">
              <RecommendationActionHelp />
              {filteredPendingRecommendations.map(renderRecommendationCard)}
            </div>
          </section>
        )}

        {filteredBookmarks.length > 0 && (
          <section className="bookmark-health-panel">
            <BookmarkTaskHeader title="待手动分类" icon={<FolderInput aria-hidden="true" />}
              summary={`已选 ${selectedVisibleManualTaskIds.length} / ${filteredBookmarks.length}`}>
              <button
                type="button"
                onClick={() => void handleIgnoreSelectedManualTaskBookmarks()}
                disabled={busy || ignoringManualSelection || selectedVisibleManualTaskIds.length === 0}
                className="extension-page__wide-secondary"
              >
                {ignoringManualSelection ? "忽略中" : "忽略所选"}
              </button>
              <button type="button" onClick={() => void protectSelectedBookmarks(selectedVisibleManualTaskIds)}
                disabled={busy || ignoringManualSelection || selectedVisibleManualTaskIds.length === 0} className="extension-page__wide-primary">
                <ShieldCheck className="w-4 h-4" />保护所选
              </button>
            </BookmarkTaskHeader>
            <div className="bookmark-health-group__list">
              {filteredBookmarks.map(renderUnsortedBookmarkRow)}
            </div>
          </section>
        )}

        {!hasVisibleItems && (
          <div className="extension-empty extension-empty--compact">
            {emptyMessage}
          </div>
        )}
      </>
    );
  };

  const renderDuplicateBookmarkRow = (bookmark: BookmarkNode, group: DuplicateBookmarkGroup) => {
    const isSelected = selectedDuplicateBookmarkIds.has(bookmark.id);
    const isProtected = whitelistIndex.protectedBookmarkIds.has(bookmark.id);
    const hasFolderProtection = Boolean(bookmark.parentId && whitelistIndex.protectedFolderIds.has(bookmark.parentId));
    const isRecommendedKeep = bookmark.id === group.recommendedKeepId;
    const duplicateActionLabel = isRecommendedKeep
      ? "建议保留"
      : group.suggestedDeleteIds.includes(bookmark.id)
        ? "建议删除"
        : "待复核";
    const bookmarkPath = bookmark.path.join(" / ") || "根目录";
    const RowContent = isProtected ? "div" : "label";
    const protectionActionClass = "bookmark-tree-row__status bookmark-duplicates__protection-action";

    return (
      <div
        key={bookmark.id}
        className={`bookmark-tree-row bookmark-tree-row--bookmark bookmark-tree-row--selectable bookmark-task-row ${isSelected ? "is-selected" : ""}`}
      >
        <RowContent className="bookmark-task-row__label">
          {!isProtected && (
            <input
              type="checkbox"
              checked={isSelected}
              disabled={busy}
              onChange={() => toggleDuplicateBookmarkSelection(bookmark.id)}
              className="extension-checkbox bookmark-tree-row__checkbox"
              aria-label={`选择书签：${bookmark.title}`}
            />
          )}
          <BookmarkFavicon title={bookmark.title} url={bookmark.url} />
          <span className="bookmark-duplicates__identity">
            <span className="bookmark-tree-row__title" title={bookmark.title}>{bookmark.title}</span>
            <span className="bookmark-tree-row__meta" title={bookmarkPath}>{bookmarkPath}</span>
            {isProtected ? (
              hasFolderProtection ? (
                <Link
                  to="/manage?view=whitelist"
                  className={protectionActionClass}
                  title={whitelistIndex.reasonById.get(bookmark.id)}
                >
                  <ShieldCheck className="w-3 h-3" aria-hidden="true" />
                  管理文件夹保护
                </Link>
              ) : (
                <button
                  type="button"
                  className={protectionActionClass}
                  aria-label={`解除保护：${bookmark.title}`}
                  disabled={busy}
                  onClick={() => void toggleWhitelist("bookmark", bookmark.id)}
                >
                  <ShieldCheck className="w-3 h-3" aria-hidden="true" />
                  解除保护
                </button>
              )
            ) : (
              <span className="bookmark-tree-row__status">{duplicateActionLabel}</span>
            )}
          </span>
        </RowContent>
        {bookmark.url && (
          <a
            href={bookmark.url}
            target="_blank"
            rel="noopener noreferrer"
            className="extension-link-icon"
            aria-label={`打开书签：${bookmark.title}`}
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    );
  };

  const renderDuplicateTasks = () => {
    if (!filteredDuplicateGroups.length) return null;

    const selectableCount = visibleDuplicateBookmarkIds.length;
    const protectedCount = filteredDuplicateBookmarkCount - selectableCount;

    return (
      <section className="bookmark-health-panel">
        <BookmarkTaskHeader title="重复检测结果" icon={<Copy aria-hidden="true" />}
          summary={selectableCount
            ? `已选 ${selectedDuplicateCount} / ${selectableCount}${protectedCount ? `，${protectedCount} 个已保护` : ""}`
            : `${protectedCount} 个书签均已保护`}>
          {selectableCount > 0 && (
            <>
              {visibleDuplicateAutoSelectIds.length > 0 && (
                <button
                  type="button"
                  onClick={toggleSuggestedDuplicateSelection}
                  disabled={busy}
                  className="extension-page__wide-secondary"
                  title="仅勾选当前列表中建议删除的书签"
                >
                  {areAllVisibleDuplicatesSelected ? "取消建议项" : "勾选建议项"}
                </button>
              )}
              <button type="button" onClick={() => {
                const ids = new Set(visibleDuplicateBookmarkIds.filter((id) => selectedDuplicateBookmarkIds.has(id)));
                void handleDuplicateIgnore(taskBookmarks.filter(({ id }) => ids.has(id)), true);
              }}
                disabled={busy || selectedDuplicateCount === 0} className="extension-page__wide-secondary"
                title="仅在重复检测中忽略所选书签">
                忽略所选
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteSelectedDuplicates()}
                disabled={busy || selectedDuplicateCount === 0}
                className="extension-page__wide-primary bookmark-tree-panel__delete-button"
              >
                <Trash2 className="w-4 h-4" />
                {busy ? "删除中" : "删除所选"}
              </button>
            </>
          )}
        </BookmarkTaskHeader>
        <div className="bookmark-health-groups">
          {filteredDuplicateGroups.map((group) => (
            <details key={group.key} open className="bookmark-health-group bookmark-duplicates__group">
              <summary className="bookmark-duplicates__group-summary" title={group.key}>
                <ChevronRight className="bookmark-health-group__chevron" aria-hidden="true" />
                <span className="bookmark-duplicates__group-url">{group.key}</span>
                <span className="bookmark-health-group__count">{group.items.length}</span>
              </summary>
              <div className="bookmark-health-group__list">
                {group.items.map((bookmark) => renderDuplicateBookmarkRow(bookmark, group))}
                <details className="bookmark-duplicates__links">
                  <summary>对比原始链接</summary>
                  <ul>
                    {group.items.map((bookmark) => (
                      <li key={bookmark.id}>
                        <strong>{bookmark.title}</strong>
                        <span>{bookmark.url}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            </details>
          ))}
        </div>
      </section>
    );
  };

  const renderIgnoredBookmarks = (items: BookmarkNode[], restore: (bookmark: BookmarkNode) => void, disabled: boolean) => items.length > 0 && (
    <section className="bookmark-health-panel bookmark-ignored-panel">
      <details className="bookmark-ignored__details">
        <summary className="bookmark-ignored__summary">
          <span className="bookmark-ignored__summary-main">
            <ChevronRight className="bookmark-ignored__chevron" aria-hidden="true" />
            <EyeOff className="bookmark-ignored__icon" aria-hidden="true" />
            <span>已忽略的书签</span>
          </span>
          <span className="bookmark-ignored__count">{items.length}</span>
        </summary>
        <ul className="bookmark-ignored__list">
          {items.map((bookmark) => {
            const folderPath = bookmark.path.join(" / ") || "根目录";
            return (
              <li key={bookmark.id} className="bookmark-ignored__item">
                <div className="bookmark-ignored__row">
                  <BookmarkFavicon title={bookmark.title} url={bookmark.url} />
                  <div className="bookmark-ignored__main">
                    <div className="bookmark-ignored__title-line">
                      <strong className="bookmark-ignored__title" title={bookmark.title || bookmark.url}>
                        {bookmark.title || bookmark.url}
                      </strong>
                      {bookmark.url && (
                        <a
                          href={bookmark.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="extension-link-icon bookmark-ignored__link"
                          aria-label={`打开书签：${bookmark.title}`}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                    <div className="bookmark-ignored__meta">
                      <span className="bookmark-ignored__path" title={folderPath}>
                        <Folder aria-hidden="true" />
                        <span>{folderPath}</span>
                      </span>
                      {bookmark.url && (
                        <span className="bookmark-ignored__url" title={bookmark.url}>
                          {bookmark.url}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="bookmark-ignored__restore"
                    disabled={disabled}
                    aria-label={`恢复检测：${bookmark.title}`}
                    onClick={() => restore(bookmark)}
                  >
                    恢复检测
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );

  const renderInvalidBookmarkRow = (bookmark: BookmarkNode) => {
    if (editingId === bookmark.id) return renderBookmarkRow(bookmark, 0);

    const result = linkHealthResultById.get(bookmark.id);
    if (!result) return null;
    const isSelected = selectedInvalidBookmarkIds.has(bookmark.id);
    const evidence = [
      `${result.httpStatus ? `HTTP ${result.httpStatus}` : "请求未完成"}，${formatScanTime(result.checkedAt)}`,
      result.reason,
      result.finalUrl ? `跳转地址：${result.finalUrl}` : undefined,
    ].filter(Boolean).join("\n");

    return (
      <div key={bookmark.id} className="bookmark-health-item" title={`${bookmark.title}\n${evidence}`}>
        <div
          className={`bookmark-tree-row bookmark-tree-row--bookmark bookmark-tree-row--selectable ${isSelected ? "is-selected" : ""}`}
          onClick={(event) => {
            if (linkHealthActionsDisabled) return;
            const target = event.target instanceof Element ? event.target : null;
            if (!target || !event.currentTarget.contains(target) || target.closest("a,button,input,select,textarea")) return;
            toggleInvalidBookmarkSelection(bookmark.id);
          }}
        >
          <input type="checkbox" checked={isSelected} disabled={linkHealthActionsDisabled}
            onChange={() => toggleInvalidBookmarkSelection(bookmark.id)}
            className="extension-checkbox bookmark-tree-row__checkbox" aria-label={`选择书签：${bookmark.title}`}
            aria-description={evidence} />
          <BookmarkFavicon title={bookmark.title} url={bookmark.url} />
          <span className="bookmark-tree-row__title">{bookmark.title}</span>
          {bookmark.url && (
            <a href={bookmark.url} target="_blank" rel="noopener noreferrer" className="extension-link-icon"
              aria-label={`打开书签：${bookmark.title}`}>
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <BookmarkRowActionMenu
            bookmarkTitle={bookmark.title}
            busy={linkHealthActionsDisabled}
            onEdit={() => handleEditStart(bookmark)}
            onRecheck={() => void handleLinkHealthRecheck(result)}
            onDelete={() => void handleDeleteLinkHealthBookmarks(result)}
          />
        </div>
      </div>
    );
  };

  const renderLinkHealthGroups = () => {
    const groupOrder: LinkHealthGroupKey[] = ["broken", "restricted", "suspicious", "temporary_failed"];
    const visibleGroups = groupOrder.filter((group) => groupedInvalidBookmarks[group].length > 0);

    if (!visibleGroups.length) return null;

    return (
      <section className="bookmark-health-panel">
        <BookmarkTaskHeader title="任务结果" icon={<Unlink aria-hidden="true" />}
          summary={`已选 ${selectedInvalidCount} / ${filteredBookmarks.length}`}>
            {suggestedLinkHealthIds.length > 0 && (
              <button
                type="button"
                onClick={() => toggleLinkHealthSelection(suggestedLinkHealthIds)}
                disabled={linkHealthActionsDisabled}
                className="extension-page__wide-secondary"
                title="仅勾选符合建议清理条件的链接"
              >
                {areAllSuggestedLinkHealthSelected ? "取消建议项" : "勾选建议项"}
              </button>
            )}
            <button type="button" onClick={() => void handleLinkHealthIgnore(
                filteredBookmarks.filter(({ id }) => selectedInvalidBookmarkIds.has(id)), true)}
              disabled={linkHealthActionsDisabled || selectedInvalidCount === 0} className="extension-page__wide-secondary"
              title="仅在失效检测中忽略所选书签">
              忽略所选
            </button>
            <button
              type="button"
              onClick={() => void handleDeleteLinkHealthBookmarks()}
              disabled={linkHealthActionsDisabled || selectedInvalidCount === 0}
              className="extension-page__wide-primary bookmark-tree-panel__delete-button"
            >
              <Trash2 className="w-4 h-4" />
              {busy ? "删除中" : "删除所选"}
            </button>
        </BookmarkTaskHeader>
        <div className="bookmark-health-groups">
          {visibleGroups.map((group) => {
            const meta = getLinkHealthGroupMeta(group);
            const groupBookmarks = groupedInvalidBookmarks[group];
            const isCollapsed = collapsedLinkHealthGroups.has(group);
            const groupIds = groupBookmarks.map(({ id }) => id);
            const selectedInGroup = groupIds.filter((id) => selectedInvalidBookmarkIds.has(id)).length;
            const isGroupSelected = selectedInGroup === groupIds.length;

            return (
              <section key={group} className={`bookmark-health-group ${meta.className} ${isCollapsed ? "is-collapsed" : ""}`}>
                <div className="bookmark-health-group__head" title={meta.description}>
                  <h4>
                    <button type="button" className="bookmark-health-group__toggle"
                      aria-expanded={!isCollapsed}
                      aria-description={meta.description}
                      onClick={() => toggleLinkHealthGroup(group)}>
                      <span className="bookmark-health-group__chevron" aria-hidden="true">
                        {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </span>
                      <span>{meta.title}</span>
                    </button>
                  </h4>
                  <span className="bookmark-health-group__count">{groupBookmarks.length}</span>
                  <label className="bookmark-health-group__select">
                    <input
                      type="checkbox"
                      className="extension-checkbox"
                      aria-label={`全选「${meta.title}」`}
                      checked={isGroupSelected}
                      disabled={linkHealthActionsDisabled}
                      ref={(input) => { if (input) input.indeterminate = selectedInGroup > 0 && !isGroupSelected; }}
                      onChange={() => toggleLinkHealthSelection(groupIds)}
                    />
                  </label>
                </div>
                {!isCollapsed && (
                  <div className="bookmark-health-group__list">
                    {groupBookmarks.map(renderInvalidBookmarkRow)}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </section>
    );
  };

  const handleAdd = async () => {
    if (!addForm.title || !addForm.url) {
      setMessage("请填写标题和网址");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      await createBookmark(addForm.title, addForm.url, parseFolderPath(addForm.path, settings.maxNestingLevel));
      await loadManagedBookmarks();
      setAddForm({ title: "", url: "", path: "" });
      setShowAddForm(false);
      setMessage("书签已添加", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "添加失败");
    } finally {
      setBusy(false);
    }
  };

  const handleLinkScan = async () => {
    setScanningLinks(true);
    setLinkScanActive(true);
    setMessage("");
    setScanProgress({ checked: 0, total: bookmarks.length });
    let keepScanning = false;
    try {
      await ensureRequiredHostPermission();
      setLinkScanNeedsPermission(false);
      const report = await startLinkHealthScan(bookmarks);
      keepScanning = true;
      setLinkHealthReport(report);
      resumedLinkScanIdsRef.current.add(report.id);
      setScanProgress({ checked: report.results.length, total: report.totalCount ?? bookmarks.length });
      setMessage("链接检测已在后台开始，可返回首页后稍后查看进度。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "链接检测失败");
    } finally {
      if (!keepScanning) setScanningLinks(false);
      setLinkScanActive(false);
    }
  };

  const handleBackfillImpressions = async () => {
    if (backfillRunning || backfillAbortRef.current) return;
    if (!settings.provider.apiKey.trim() || !settings.provider.enabled) {
      setMessage("补充书签用途前，请先在设置中连接并授权 AI 服务。");
      return;
    }
    if (missingImpressionCount === 0) {
      setMessage("全部网页书签已支持按用途搜索。");
      return;
    }
    if (!confirm(
      `将用 AI 为剩余 ${missingImpressionCount} 个书签补充用途信息，方便按用途搜索。\n\n` +
      "只会写入本地印象索引，不会移动、删除或改写任何书签，也不会创建备份或整理报告。\n\n" +
      `每批最多 ${getImpressionBackfillBatchSize(settings.provider)} 个书签。遗漏或无效结果最多自动重试一次，每批最多 5 个，追加请求可能增加费用。是否继续？`
    )) return;

    const controller = new AbortController();
    backfillAbortRef.current = controller;
    setBackfillProgress({ phase: "preparing", processed: 0, total: missingImpressionCount, indexed: 0, failed: 0, retried: 0 });
    setBackfillFailures([]);
    setMessage("");
    try {
      // Firefox 需要权限请求保持在用户手势内，先于任何存储读取调用。
      await ensureRequiredHostPermission();
      const summary = await backfillImpressions({
        signal: controller.signal,
        bookmarks,
        onProgress: setBackfillProgress,
      });
      setBackfillFailures(summary.failures);
      setSemanticIndex(await getSemanticIndexMap());
      if (summary.canceled) {
        setMessage(`已停止补充：本次已为 ${summary.indexed} 个书签补充用途，${summary.failed} 个处理失败，其余未处理的可下次继续。`);
      } else if (summary.total === 0) {
        setMessage("全部网页书签已支持按用途搜索。");
      } else {
        setMessage(
          `用途信息${summary.failed ? "部分完成" : "补充完成"}：已为 ${summary.indexed} 个书签补充用途` +
          (summary.retried ? `（重试 ${summary.retried} 个，其中 ${summary.recovered} 个补充成功）` : "") +
          (summary.failed ? `，${summary.failed} 个失败，可展开查看原因。` : "。")
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "补充书签用途失败");
    } finally {
      backfillAbortRef.current = null;
      setBackfillProgress(null);
    }
  };

  useEffect(() => {
    // 离开页面时停止补全，避免后台继续产生 AI 调用费用。
    return () => { backfillAbortRef.current?.abort(); };
  }, []);

  // 搜索词变化时取消进行中的深度搜索，避免旧请求结果覆盖新列表。
  useEffect(() => {
    const current = searchQuery.trim();
    if (deepSearchState.query && deepSearchState.query !== current) cancelDeepSearch();
  }, [cancelDeepSearch, deepSearchState.query, searchQuery]);

  const handleDeepSearch = async () => {
    const query = searchQuery.trim();
    if (!query || deepSearchRunning) return;
    if (!settings.provider.apiKey.trim() || !settings.provider.enabled) {
      setMessage("使用“帮我找找”前，请先在设置中连接并授权 AI 服务。");
      return;
    }
    // Firefox 要求权限请求保持在用户手势内，必须早于任何 await 存储读取。
    try {
      await ensureRequiredHostPermission();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "未授予网站访问权限");
      return;
    }
    runDeepSearch(query);
  };

  const emptyMessage = useMemo(() => {
    if (taskMode === "duplicate") return searchQuery.trim() ? "未找到匹配的重复链接" : "暂无重复链接";
    if (searchQuery) {
      if (deepSearchRunning) return "AI 正在根据描述查找书签…";
      if (deepSearchActive) return "AI 没有找到更匹配的书签，可换个说法再试";
      return "未找到匹配的书签，可点击“帮我找找”或按 Alt + Enter 用 AI 查找";
    }
    if (taskMode === "unsorted") {
      return "暂无待整理书签";
    }
    if (taskMode === "invalid") {
      return linkHealthReport ? "未发现需要复查的链接" : "尚未检测链接，点击开始检测后查看结果";
    }
    return "暂无书签";
  }, [deepSearchActive, deepSearchRunning, linkHealthReport, pendingRecommendations.length, searchQuery, taskMode]);

  return (
    <div className="extension-page">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <PageHeading title={pageTitle} subtitle={pageSubtitle} />
          {!taskMode && (
            <button onClick={() => setShowAddForm(true)} className="extension-page__primary-button">
              <Plus className="w-4 h-4" />
              添加书签
            </button>
          )}
        </div>

        {backfillFailures.length > 0 && (
          <details className="extension-section">
            <summary>上次用途识别：{backfillFailures.length} 个失败，查看原因</summary>
            <ul className="mt-2 space-y-2" style={{ overflowWrap: "anywhere" }}>
              {backfillFailures.map((failure) => (
                <li key={failure.bookmarkId}>
                  <strong>{failure.title}</strong>
                  <p>{failure.reason}</p>
                </li>
              ))}
            </ul>
          </details>
        )}

        {!taskMode && (
          <details className="bookmark-whitelist-panel" open={searchParams.get("view") === "whitelist" || undefined}>
            <summary><ShieldCheck className="w-4 h-4" />白名单 <span>{whitelistEntries.length} 条规则</span></summary>
            <p>ReMarks 会跳过受保护项目的整理、推荐和清理，并限制编辑、移动和删除。保护文件夹时也保护其中的书签和子文件夹。点击旁边的盾牌可添加保护，也可在这里解除保护。</p>
            {whitelistEntries.length > 0 && (
              <>
                <input type="search" className="extension-control bookmark-whitelist-search"
                  aria-label="搜索白名单" placeholder="搜索书签、文件夹或网址"
                  value={whitelistSearchQuery}
                  onChange={(event) => {
                    setWhitelistSearchQuery(event.target.value);
                    setSelectedWhitelistKeys(new Set());
                  }}
                />
                {visibleWhitelistEntries.length > 0 ? (
                  <>
                    <div className="bookmark-whitelist-tools">
                      <button type="button" disabled={busy} onClick={() => setSelectedWhitelistKeys(
                        selectedVisibleWhitelistEntries.length === visibleWhitelistEntries.length
                          ? new Set()
                          : new Set(visibleWhitelistEntries.map((entry) => entry.type + ":" + entry.id))
                      )}>
                        {selectedVisibleWhitelistEntries.length === visibleWhitelistEntries.length ? "取消全选" : "全选结果"}
                      </button>
                      <button type="button" disabled={busy || selectedVisibleWhitelistEntries.length === 0}
                        onClick={() => void removeSelectedWhitelistEntries()}>
                        解除所选 ({selectedVisibleWhitelistEntries.length})
                      </button>
                    </div>
                    <div className="bookmark-whitelist-list">
                      {visibleWhitelistEntries.map((entry) => {
                        const item = entry.type === "folder"
                          ? folders.find((folder) => folder.id === entry.id)
                          : bookmarks.find((bookmark) => bookmark.id === entry.id);
                        const key = entry.type + ":" + entry.id;
                        return (
                          <div key={key}>
                            <input type="checkbox" checked={selectedWhitelistKeys.has(key)}
                              aria-label={"选择" + (item?.title ?? "已删除的项目")}
                              onChange={() => setSelectedWhitelistKeys((current) => {
                                const next = new Set(current);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              })}
                            />
                            <span title={item?.path.join(" / ")}>{entry.type === "folder" ? "文件夹" : "书签"}，{item?.title ?? "已删除的项目"}</span>
                            <button type="button" disabled={!item} onClick={() => locateWhitelistEntry(entry)}>定位</button>
                            <button type="button" disabled={busy} onClick={() => void toggleWhitelist(entry.type, entry.id)}>解除</button>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : <p>没有匹配的白名单规则</p>}
              </>
            )}
          </details>
        )}

        {taskMode === "invalid" && (
          <section className="bookmark-task-panel">
            <div className="bookmark-task-panel__main">
              <strong>手动检测链接</strong>
              <p>
                检测 HTTP 和 HTTPS 书签的响应状态。受限和临时异常可逐条复测。
              </p>
              {linkHealthReport && (
                <span>上次检测：{formatScanTime(linkHealthReport.createdAt)}</span>
              )}
              {linkHealthReport?.status === "running" && !linkScanActive && (
                <p>{linkScanNeedsPermission
                  ? "请重新授权网站访问权限后继续检测。"
                  : "检测尚未完成，已保留现有检测结果。"}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleLinkScan()}
              disabled={busy || !linkHealthIgnores || linkScanActive || bookmarks.length === 0}
              className="extension-page__wide-primary bookmark-task-panel__button"
            >
              <RefreshCw className={`w-4 h-4 ${linkScanActive ? "bookmark-task-panel__spin" : ""}`} />
              {linkScanActive
                ? `检测中 ${scanProgress.checked}/${scanProgress.total}`
                : scanningLinks
                  ? "继续检测"
                  : linkHealthReport
                    ? "重新检测"
                    : "开始检测"}
            </button>
            {scanningLinks && scanProgress.total > 0 && (
              <div className="bookmark-task-progress" aria-hidden="true">
                <span style={{ width: `${Math.round((scanProgress.checked / scanProgress.total) * 100)}%` }} />
              </div>
            )}
          </section>
        )}

        {taskMode !== "invalid" && (
          <div className="impression-search-bar">
            <SearchKeywordDropdown className="manage-search-shell" query={searchQuery} onQueryChange={setSearchQuery} semanticIndex={semanticIndex}>
            {(inputProps) => (
            <div className="extension-search-field manage-bookmarks-search">
              <Search className="extension-search-field__icon" />
              <input
                {...inputProps}
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                    event.preventDefault();
                    if (!event.repeat) void handleDeepSearch();
                  }
                }}
                placeholder={taskMode === "unsorted" ? "搜索当前列表…" : taskMode ? "在当前任务中搜索..." : "搜索标题、网址，或输入功能印象（如：视频网站、图片压缩）"}
                className="extension-control extension-control--search"
                aria-label="搜索书签"
              />
            </div>
            )}
            </SearchKeywordDropdown>
            {searchQuery.trim() && <button
              type="button"
              className="impression-search-bar__ai"
              onClick={() => void handleDeepSearch()}
              disabled={!searchQuery.trim() || deepSearchRunning}
              title="用 AI 根据描述查找书签（Alt + Enter）"
              aria-keyshortcuts="Alt+Enter"
            >
              <BrainCircuit aria-hidden="true" />
              <span>{deepSearchRunning ? "查找中…" : "帮我找找"}</span>
              {!deepSearchRunning && <kbd>Alt + Enter</kbd>}
            </button>}
          </div>
        )}
        {taskMode !== "invalid" && searchQuery.trim() && (
          (deepSearchState.stage !== "idle" || deepSearchState.error) ? (
            <div
              className={`impression-deep-status impression-deep-status--${deepSearchState.error ? "error" : deepSearchState.stage}`}
              role="status"
              aria-live="polite"
            >
              <span className="impression-deep-status__lead">
                {deepSearchState.error
                  ? <>AI 查找失败：{deepSearchState.error}</>
                  : deepSearchState.stage === "expanding"
                    ? <><BrainCircuit aria-hidden="true" />正在联想相关功能与常见网站…</>
                    : deepSearchState.stage === "expanded_shown"
                      ? <><BrainCircuit aria-hidden="true" />AI 已联想，正在筛选更匹配的书签…</>
                      : <><Check aria-hidden="true" />AI 查找完成</>}
              </span>
              {deepSearchState.expandedTerms.length > 0 && deepSearchState.stage !== "error" && (
                <span className="impression-deep-status__terms" aria-label="AI 联想词">
                  {deepSearchState.expandedTerms.map((term) => <b key={term}>{term}</b>)}
                </span>
              )}
              {deepSearchRunning && (
                <button type="button" className="extension-text-button" onClick={cancelDeepSearch}>停止</button>
              )}
            </div>
          ) : null
        )}
        {taskMode !== "invalid" && taskMode !== "unsorted" && taskMode !== "duplicate" && (
          <div className="impression-coverage" role="status">
            <p className="impression-coverage__text">
              <Sparkles className="impression-coverage__icon" aria-hidden="true" />
              <span>
                用途索引 <strong>{semanticCoverage.indexed}</strong> / {semanticCoverage.total}
              </span>
            </p>
            {backfillRunning ? (
              <div className="impression-backfill">
                <div className="impression-backfill__head">
                  <span>
                    {backfillProgress.phase === "retrying_ai" ? "正在小批量重试未完成的书签…" : backfillProgress.phase === "requesting_ai" ? "正在分析书签用途…" : backfillProgress.phase === "saving" ? "正在保存用途信息…" : "正在准备…"}
                    {" "}{backfillProgress.processed}/{backfillProgress.total}，已完成 {backfillProgress.indexed} 个
                    {backfillProgress.failed > 0 && `，${backfillProgress.failed} 条失败`}
                  </span>
                  <button type="button" onClick={() => backfillAbortRef.current?.abort()} className="extension-text-button">停止</button>
                </div>
                <div className="bookmark-task-progress" aria-hidden="true">
                  <span style={{ width: `${Math.round((backfillProgress.processed / Math.max(1, backfillProgress.total)) * 100)}%` }} />
                </div>
              </div>
            ) : missingImpressionCount > 0 ? (
              <button
                type="button"
                className="extension-page__wide-secondary impression-coverage__action"
                disabled={busy}
                onClick={() => void handleBackfillImpressions()}
                title={`用 AI 为剩余 ${missingImpressionCount} 个书签补充用途信息，会产生 AI 使用量，不会移动或改写书签`}
              >
                <Sparkles aria-hidden="true" />
                补充用途（{missingImpressionCount}）
              </button>
            ) : (
              <span className="impression-coverage__done"><Check aria-hidden="true" />已完成</span>
            )}
          </div>
        )}

        {searchQuery && <button type="button" className="extension-text-button" onClick={() => setSearchQuery("")}>清除搜索</button>}
        {taskMode === "invalid" ? (
          <>
            {renderLinkHealthGroups()}
            {renderIgnoredBookmarks(ignoredLinkHealthBookmarks, (bookmark) => void handleLinkHealthIgnore([bookmark], false), linkHealthActionsDisabled)}
          </>
        ) : taskMode === "unsorted" ? (
          renderUnsortedTasks()
        ) : taskMode === "duplicate" ? (
          <>
            {renderDuplicateTasks()}
            {renderIgnoredBookmarks(ignoredDuplicateBookmarks, (bookmark) => void handleDuplicateIgnore([bookmark], false), busy)}
          </>
        ) : (
          <section className="bookmark-tree-panel">
            <div className="bookmark-tree-panel__head">
              <h3 className="bookmark-section-heading">
                <Folder aria-hidden="true" />
                文件夹
              </h3>
              <span>{filteredBookmarks.length}</span>
            </div>
            <div className="bookmark-tree">{renderFolderNode(folderTree)}</div>
          </section>
        )}

        {!taskMode && showAddForm && (
          <section className="extension-section extension-section--accent">
            <div className="extension-section__bar extension-section__bar--plain">
              <h3 className="extension-section__title">添加新书签</h3>
              <button onClick={() => setShowAddForm(false)} className="extension-page__back" aria-label="关闭">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="extension-form">
              <div className="extension-field">
                <label>标题</label>
                <input type="text" value={addForm.title} onChange={(event) => setAddForm({ ...addForm, title: event.target.value })} placeholder="书签标题" className="extension-control" />
              </div>
              <div className="extension-field">
                <label>网址</label>
                <input type="url" value={addForm.url} onChange={(event) => setAddForm({ ...addForm, url: event.target.value })} placeholder="https://example.com" className="extension-control" />
              </div>
              <div className="extension-field">
                <label>文件夹路径</label>
                <input type="text" value={addForm.path} onChange={(event) => setAddForm({ ...addForm, path: event.target.value })} placeholder="开发 / 文档" className="extension-control" />
              </div>
              <button onClick={handleAdd} disabled={busy} className="extension-page__wide-primary">
                添加
              </button>
            </div>
          </section>
        )}

        {taskMode !== "unsorted" && (taskMode === "duplicate" ? filteredDuplicateGroups.length === 0 : filteredBookmarks.length === 0) && (
          <div className="extension-empty extension-empty--compact">
            {taskMode === "duplicate" && !duplicateIgnores
              ? duplicateIgnoresError || "正在读取重复检测记录…"
              : taskMode === "invalid" && !linkHealthIgnores
                ? linkHealthIgnoresError || "正在读取失效检测记录…"
                : emptyMessage}
          </div>
        )}
        {draggedBookmark && (
          <div
            className="bookmark-drag-preview"
            style={{ left: dragPosition.x, top: dragPosition.y } as CSSProperties}
          >
            <BookmarkFavicon title={draggedBookmark.title} url={draggedBookmark.url} />
            <span>{draggedBookmark.title}</span>
          </div>
        )}
      </div>
      <TopNotices>
        {feedback && <TopNotice key={feedback.id} message={feedback.text} tone={feedback.kind} />}
      </TopNotices>
    </div>
  );
}
