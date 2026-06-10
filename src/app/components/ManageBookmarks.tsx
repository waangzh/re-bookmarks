import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router";
import {
  ArrowLeft,
  Plus,
  Search,
  Edit2,
  Trash2,
  ExternalLink,
  Folder,
  Bookmark,
  ChevronDown,
  ChevronRight,
  X,
  Check,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { BookmarkLinkHealthReport, BookmarkLinkHealthResult, BookmarkNode, PendingRecommendation } from "../types";
import {
  createBookmark,
  ensureFolderPath,
  getAllBookmarkFolders,
  getBookmarkFaviconUrl,
  moveBookmark,
  parseFolderPath,
  removeBookmark,
  updateBookmark,
} from "../services/bookmarks";
import {
  checkBookmarkLinks,
  filterDuplicateBookmarks,
  getDuplicateBookmarkGroups,
  getLinkHealthProblemCount as countLinkHealthProblems,
  isProblemLinkHealthResult,
  isUnsortedBookmark,
} from "../services/bookmarkTasks";
import type { DuplicateBookmarkGroup } from "../services/bookmarkTasks";
import { acceptRecommendation, removeRecommendation } from "../services/recommendations";
import { getLinkHealthReport, removeBookmarkFromLinkHealthReport } from "../services/storage";
import { useAppStore } from "../store/useAppStore";

type TaskMode = "unsorted" | "duplicate" | "invalid";
type LinkHealthGroupKey = "broken" | "suspicious" | "temporary_failed";

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

function countLinkHealthStatus(report: BookmarkLinkHealthReport, status: BookmarkLinkHealthResult["status"]) {
  return report.results.filter((result) => result.status === status).length;
}

function formatLinkHealthSummary(report: BookmarkLinkHealthReport) {
  const brokenCount = report.brokenCount ?? countLinkHealthStatus(report, "broken") + countLinkHealthStatus(report, "invalid");
  const suspiciousCount = report.suspiciousCount ?? countLinkHealthStatus(report, "suspicious");
  const temporaryFailedCount = report.temporaryFailedCount ?? countLinkHealthStatus(report, "temporary_failed");
  return `明确失效 ${brokenCount} 个，可疑 ${suspiciousCount} 个，暂时无法确认 ${temporaryFailedCount} 个`;
}

function getLinkHealthGroupKey(result: BookmarkLinkHealthResult): LinkHealthGroupKey | null {
  if (result.status === "broken" || result.status === "invalid") return "broken";
  if (result.status === "suspicious") return "suspicious";
  if (result.status === "temporary_failed") return "temporary_failed";
  return null;
}

function getLinkHealthGroupMeta(group: LinkHealthGroupKey) {
  if (group === "broken") {
    return {
      title: "明确失效",
      description: "返回 404、410、451 等明确不可用状态，优先人工复查。",
      className: "bookmark-health-group--broken",
    };
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
    description: "请求超时、网络失败或服务端临时错误，建议稍后重试。",
    className: "bookmark-health-group--temporary",
  };
}

function bookmarkMatchesQuery(bookmark: BookmarkNode, query: string) {
  return (
    bookmark.title.toLowerCase().includes(query) ||
    bookmark.url?.toLowerCase().includes(query) ||
    bookmark.path.join(" / ").toLowerCase().includes(query)
  );
}

function getDuplicateGroupLabel() {
  return "精确重复";
}

function getDuplicateGroupDescription(group: DuplicateBookmarkGroup) {
  if (group.kind === "exact") return group.key;
  return group.domain || group.key;
}

export function ManageBookmarks() {
  const { bookmarks, pendingRecommendations, loadBookmarks, loadRecommendations, settings } = useAppStore();
  const [searchParams] = useSearchParams();
  const taskMode = useMemo(() => getTaskMode(searchParams), [searchParams]);
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
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyRecommendationId, setBusyRecommendationId] = useState<string | null>(null);
  const [draggedBookmark, setDraggedBookmark] = useState<BookmarkNode | null>(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [linkHealthReport, setLinkHealthReport] = useState<BookmarkLinkHealthReport | null>(null);
  const [scanProgress, setScanProgress] = useState({ checked: 0, total: 0 });
  const [scanningLinks, setScanningLinks] = useState(false);
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

  const loadManagedBookmarks = useCallback(async () => {
    const [, , nextFolders] = await Promise.all([loadBookmarks(), loadRecommendations(), getAllBookmarkFolders()]);
    setFolders(nextFolders);
  }, [loadBookmarks, loadRecommendations]);

  useEffect(() => {
    void loadManagedBookmarks();
  }, [loadManagedBookmarks]);

  useEffect(() => {
    void getLinkHealthReport().then(setLinkHealthReport);
  }, []);

  useEffect(() => {
    if (taskMode) setSearchQuery("");
  }, [taskMode]);

  const invalidBookmarkIds = useMemo(() => {
    return new Set(
      linkHealthReport?.results
        .filter(isProblemLinkHealthResult)
        .map((result) => result.bookmarkId) ?? []
    );
  }, [linkHealthReport]);

  const taskBookmarks = useMemo(() => {
    if (taskMode === "unsorted") return bookmarks.filter(isUnsortedBookmark);
    if (taskMode === "duplicate") return filterDuplicateBookmarks(bookmarks);
    if (taskMode === "invalid") return bookmarks.filter((bookmark) => invalidBookmarkIds.has(bookmark.id));
    return bookmarks;
  }, [bookmarks, invalidBookmarkIds, taskMode]);

  const duplicateGroups = useMemo(() => {
    if (taskMode !== "duplicate") return [];
    return getDuplicateBookmarkGroups(bookmarks);
  }, [bookmarks, taskMode]);

  const pendingRecommendationBookmarkIds = useMemo(() => {
    return new Set(pendingRecommendations.map((recommendation) => recommendation.bookmarkId));
  }, [pendingRecommendations]);

  const visibleTaskBookmarks = useMemo(() => {
    if (taskMode !== "unsorted") return taskBookmarks;
    return taskBookmarks.filter((bookmark) => !pendingRecommendationBookmarkIds.has(bookmark.id));
  }, [pendingRecommendationBookmarkIds, taskBookmarks, taskMode]);

  const unsortedTaskTotal = useMemo(() => {
    if (taskMode !== "unsorted") return taskBookmarks.length;
    const ids = new Set(taskBookmarks.map((bookmark) => bookmark.id));
    pendingRecommendations.forEach((recommendation) => ids.add(recommendation.bookmarkId));
    return ids.size;
  }, [pendingRecommendations, taskBookmarks, taskMode]);

  const filteredBookmarks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return visibleTaskBookmarks;

    return visibleTaskBookmarks.filter((bookmark) => bookmarkMatchesQuery(bookmark, query));
  }, [searchQuery, visibleTaskBookmarks]);

  const filteredDuplicateGroups = useMemo(() => {
    if (taskMode !== "duplicate") return [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return duplicateGroups;

    return duplicateGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((bookmark) => bookmarkMatchesQuery(bookmark, query)),
      }))
      .filter((group) => group.items.length > 0);
  }, [duplicateGroups, searchQuery, taskMode]);

  const filteredDuplicateBookmarkCount = useMemo(() => {
    return filteredDuplicateGroups.reduce((total, group) => total + group.items.length, 0);
  }, [filteredDuplicateGroups]);

  const filteredPendingRecommendations = useMemo(() => {
    if (taskMode !== "unsorted") return [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return pendingRecommendations;

    return pendingRecommendations.filter((recommendation) => {
      return (
        recommendation.bookmarkTitle.toLowerCase().includes(query) ||
        recommendation.bookmarkUrl?.toLowerCase().includes(query) ||
        recommendation.suggestedFolderPath.join(" / ").toLowerCase().includes(query) ||
        recommendation.reason?.toLowerCase().includes(query)
      );
    });
  }, [pendingRecommendations, searchQuery, taskMode]);

  const linkHealthResultById = useMemo(() => {
    const lookup = new Map<string, BookmarkLinkHealthResult>();
    linkHealthReport?.results.forEach((result) => {
      if (isProblemLinkHealthResult(result)) lookup.set(result.bookmarkId, result);
    });
    return lookup;
  }, [linkHealthReport]);

  const groupedInvalidBookmarks = useMemo(() => {
    const groups: Record<LinkHealthGroupKey, BookmarkNode[]> = {
      broken: [],
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

  const pageTitle = useMemo(() => {
    if (taskMode === "unsorted") return "未分类书签";
    if (taskMode === "duplicate") return "重复链接";
    if (taskMode === "invalid") return "失效链接";
    return "管理书签";
  }, [taskMode]);

  const pageSubtitle = useMemo(() => {
    if (taskMode === "duplicate") return `${duplicateGroups.length} 组重复 URL，涉及 ${taskBookmarks.length} 个书签`;
    if (taskMode === "unsorted") return `${unsortedTaskTotal} 项待处理：${pendingRecommendations.length} 条 AI 建议，${visibleTaskBookmarks.length} 个待手动归档`;
    if (taskMode === "invalid") {
      if (!linkHealthReport) return "手动检测书签链接状态";
      return `上次检测 ${linkHealthReport.checkedCount} 个，需要复查 ${countLinkHealthProblems(linkHealthReport, bookmarks)} 个`;
    }
    return `${bookmarks.length} 个本地书签`;
  }, [bookmarks, duplicateGroups.length, linkHealthReport, pendingRecommendations.length, taskBookmarks.length, taskMode, unsortedTaskTotal, visibleTaskBookmarks.length]);

  const folderTree = useMemo(() => buildBookmarkFolderTree(filteredBookmarks, folders), [filteredBookmarks, folders]);
  const folderLookup = useMemo(() => collectFolderLookup(folderTree), [folderTree]);

  useEffect(() => {
    folderLookupRef.current = folderLookup;
  }, [folderLookup]);

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

      event.preventDefault();
      void (async () => {
        setBusy(true);
        setMessage("");
        try {
          await moveBookmark(bookmark.id, targetFolder.id);
          await loadManagedBookmarks();
          setMessage(`已移动到 ${targetFolder.path.join(" / ") || targetFolder.title}`);
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "移动失败");
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
      await updateBookmark(editingId, editForm.title, editForm.url);
      const folderPath = parseFolderPath(editForm.path, settings.maxNestingLevel);
      const parentId = await ensureFolderPath(folderPath, settings.maxNestingLevel);
      await moveBookmark(editingId, parentId);
      await loadManagedBookmarks();
      setEditingId(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const handleAcceptRecommendation = async (recommendation: PendingRecommendation) => {
    setBusyRecommendationId(recommendation.id);
    setMessage("");
    try {
      await acceptRecommendation(recommendation);
      await loadManagedBookmarks();
      setMessage(`已移动到 ${recommendation.suggestedFolderPath.join(" / ")}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "接受推荐失败");
    } finally {
      setBusyRecommendationId(null);
    }
  };

  const handleRejectRecommendation = async (id: string) => {
    setBusyRecommendationId(id);
    setMessage("");
    try {
      await removeRecommendation(id);
      await loadManagedBookmarks();
      setMessage("已忽略这条 AI 建议");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "忽略推荐失败");
    } finally {
      setBusyRecommendationId(null);
    }
  };

  const renderFolderNode = (folder: BookmarkFolderNode, depth = 0) => {
    const isExpanded = visibleExpandedFolders.has(folder.key);
    const isSelected = selectedFolder === folder.key;
    const hasChildren = folder.children.length > 0 || folder.bookmarks.length > 0;
    const isDropTarget = Boolean(draggedBookmark && folder.id && folder.id !== draggedBookmark.parentId);
    const isDragOver = dragOverFolder === folder.key;

    return (
      <div key={folder.key}>
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

        {isExpanded && (
          <>
            {folder.children.map((child) => renderFolderNode(child, depth + 1))}
            {folder.bookmarks.map((bookmark) => renderBookmarkRow(bookmark, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderBookmarkRow = (bookmark: BookmarkNode, depth: number) => (
    <div
      key={bookmark.id}
      className={`bookmark-tree-row bookmark-tree-row--bookmark ${draggedBookmark?.id === bookmark.id ? "is-dragging" : ""}`}
      style={{ "--tree-depth": depth } as CSSProperties}
      onPointerDown={(event) => {
        if (busy || editingId === bookmark.id || event.button !== 0) return;
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
          <span className="bookmark-tree-row__chevron" />
          <BookmarkFavicon title={bookmark.title} url={bookmark.url} />
          <span className="bookmark-tree-row__title" title={bookmark.title}>{bookmark.title}</span>
          {bookmark.url && (
            <a href={bookmark.url} target="_blank" rel="noopener noreferrer" className="extension-link-icon" aria-label="打开书签">
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <div className="extension-row-actions">
            <button onClick={() => handleEditStart(bookmark)} className="extension-icon-action extension-icon-action--blue" aria-label="编辑">
              <Edit2 className="w-4 h-4" />
            </button>
            <button onClick={() => void handleDelete(bookmark.id)} disabled={busy} className="extension-icon-action extension-icon-action--red" aria-label="删除">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );

  const renderUnsortedBookmarkCard = (bookmark: BookmarkNode) => {
    const isEditing = editingId === bookmark.id;

    return (
      <article key={bookmark.id} className="bookmark-unsorted-card">
        {isEditing ? (
          <div className="bookmark-tree-edit">
            <input type="text" value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} className="extension-control" />
            <input type="url" value={editForm.url} onChange={(event) => setEditForm({ ...editForm, url: event.target.value })} className="extension-control" />
            <input type="text" value={editForm.path} onChange={(event) => setEditForm({ ...editForm, path: event.target.value })} className="extension-control" placeholder="目标文件夹路径，例如：工作 / 文档" />
            <div className="extension-button-row">
              <button onClick={handleEditSave} disabled={busy} className="extension-page__wide-primary">
                <Check className="w-4 h-4" />
                保存归档
              </button>
              <button onClick={() => setEditingId(null)} className="extension-page__wide-secondary">
                <X className="w-4 h-4" />
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="bookmark-unsorted-card__main">
              <BookmarkFavicon
                title={bookmark.title}
                url={bookmark.url}
                className="bookmark-unsorted-card__favicon"
                fallbackClassName="bookmark-unsorted-card__icon"
              />
              <div className="bookmark-unsorted-card__content">
                <div className="bookmark-unsorted-card__title-row">
                  <h4 title={bookmark.title}>{bookmark.title}</h4>
                  {bookmark.url && (
                    <a href={bookmark.url} target="_blank" rel="noopener noreferrer" className="extension-link-icon" aria-label="打开书签">
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
                {bookmark.url && <p className="bookmark-unsorted-card__url">{bookmark.url}</p>}
                <p className="bookmark-unsorted-card__meta">当前位置：{bookmark.path.join(" / ") || "根目录"}</p>
              </div>
            </div>
            <div className="bookmark-unsorted-card__actions">
              <button type="button" onClick={() => handleEditStart(bookmark)} className="extension-page__wide-primary">
                <Folder className="w-4 h-4" />
                选择归档位置
              </button>
              <button type="button" onClick={() => void handleDelete(bookmark.id)} disabled={busy} className="extension-page__wide-secondary">
                <Trash2 className="w-4 h-4" />
                删除
              </button>
            </div>
          </>
        )}
      </article>
    );
  };

  const renderRecommendationCard = (recommendation: PendingRecommendation) => {
    const isBusy = busyRecommendationId === recommendation.id;

    return (
      <article key={recommendation.id} className="bookmark-unsorted-card bookmark-unsorted-card--recommendation">
        <div className="bookmark-unsorted-card__main">
          <BookmarkFavicon
            title={recommendation.bookmarkTitle}
            url={recommendation.bookmarkUrl}
            className="bookmark-unsorted-card__favicon"
            fallbackClassName="bookmark-unsorted-card__icon"
          />
          <div className="bookmark-unsorted-card__content">
            <div className="bookmark-unsorted-card__title-row">
              <h4 title={recommendation.bookmarkTitle}>{recommendation.bookmarkTitle}</h4>
              {recommendation.bookmarkUrl && (
                <a href={recommendation.bookmarkUrl} target="_blank" rel="noopener noreferrer" className="extension-link-icon" aria-label="打开书签">
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
            {recommendation.bookmarkUrl && <p className="bookmark-unsorted-card__url">{recommendation.bookmarkUrl}</p>}
            <div className="bookmark-unsorted-target">
              <Folder className="w-4 h-4" />
              <span>{recommendation.suggestedFolderPath.join(" / ")}</span>
              <b>{Math.round(recommendation.confidence * 100)}%</b>
            </div>
            {recommendation.reason && <p className="bookmark-unsorted-card__meta">{recommendation.reason}</p>}
          </div>
        </div>
        <div className="bookmark-unsorted-card__actions">
          <button
            type="button"
            onClick={() => void handleAcceptRecommendation(recommendation)}
            disabled={isBusy || Boolean(busyRecommendationId)}
            className="extension-page__wide-primary"
          >
            <Check className="w-4 h-4" />
            接受并移动
          </button>
          <button
            type="button"
            onClick={() => void handleRejectRecommendation(recommendation.id)}
            disabled={isBusy || Boolean(busyRecommendationId)}
            className="extension-page__wide-secondary"
          >
            <X className="w-4 h-4" />
            忽略
          </button>
        </div>
      </article>
    );
  };

  const renderUnsortedTasks = () => {
    const hasVisibleItems = filteredPendingRecommendations.length > 0 || filteredBookmarks.length > 0;

    return (
      <div className="bookmark-unsorted-layout">
        <section className="bookmark-unsorted-summary">
          <div className="bookmark-unsorted-summary__item bookmark-unsorted-summary__item--ai">
            <Sparkles className="w-4 h-4" />
            <span>AI 建议</span>
            <strong>{pendingRecommendations.length}</strong>
          </div>
          <div className="bookmark-unsorted-summary__item bookmark-unsorted-summary__item--manual">
            <Folder className="w-4 h-4" />
            <span>待手动归档</span>
            <strong>{visibleTaskBookmarks.length}</strong>
          </div>
        </section>

        {filteredPendingRecommendations.length > 0 && (
          <section className="bookmark-unsorted-section">
            <div className="bookmark-unsorted-section__head">
              <div>
                <h3>待确认 AI 推荐</h3>
                <p>接受后会移动到建议文件夹；忽略只移除这条推荐，不删除书签。</p>
              </div>
              <span>{filteredPendingRecommendations.length}</span>
            </div>
            <div className="bookmark-unsorted-list">
              {filteredPendingRecommendations.map(renderRecommendationCard)}
            </div>
          </section>
        )}

        {filteredBookmarks.length > 0 && (
          <section className="bookmark-unsorted-section">
            <div className="bookmark-unsorted-section__head">
              <div>
                <h3>待整理位置中的书签</h3>
                <p>这些书签仍在根目录、待整理或未分类文件夹中，可直接指定目标路径。</p>
              </div>
              <span>{filteredBookmarks.length}</span>
            </div>
            <div className="bookmark-unsorted-list">
              {filteredBookmarks.map(renderUnsortedBookmarkCard)}
            </div>
          </section>
        )}

        {!hasVisibleItems && (
          <div className="extension-empty extension-empty--compact">
            {emptyMessage}
          </div>
        )}
      </div>
    );
  };

  const renderDuplicateTasks = () => {
    if (!filteredDuplicateGroups.length) return null;

    return (
      <section className="bookmark-health-panel">
        <div className="bookmark-tree-panel__head">
          <h3>重复检测结果</h3>
          <span>{filteredDuplicateBookmarkCount}</span>
        </div>
        <div className="bookmark-unsorted-list">
          {filteredDuplicateGroups.map((group) => (
            <article key={group.id} className="bookmark-unsorted-card">
              <div className="bookmark-unsorted-card__content">
                <div className="bookmark-unsorted-card__title-row">
                  <h4>{getDuplicateGroupLabel()}</h4>
                  <span>{group.items.length} 个</span>
                </div>
                <p className="bookmark-unsorted-card__url">{getDuplicateGroupDescription(group)}</p>
              </div>
              <div className="bookmark-tree">
                {group.items.map((bookmark) => renderBookmarkRow(bookmark, 0))}
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  };

  const renderLinkHealthGroups = () => {
    const groupOrder: LinkHealthGroupKey[] = ["broken", "suspicious", "temporary_failed"];
    const visibleGroups = groupOrder.filter((group) => groupedInvalidBookmarks[group].length > 0);

    if (!visibleGroups.length) return null;

    return (
      <section className="bookmark-health-panel">
        <div className="bookmark-tree-panel__head">
          <h3>任务结果</h3>
          <span>{filteredBookmarks.length}</span>
        </div>
        <div className="bookmark-health-groups">
          {visibleGroups.map((group) => {
            const meta = getLinkHealthGroupMeta(group);
            const groupBookmarks = groupedInvalidBookmarks[group];
            const isCollapsed = collapsedLinkHealthGroups.has(group);

            return (
              <section key={group} className={`bookmark-health-group ${meta.className} ${isCollapsed ? "is-collapsed" : ""}`}>
                <button
                  type="button"
                  className="bookmark-health-group__head"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleLinkHealthGroup(group)}
                >
                  <span className="bookmark-health-group__chevron">
                    {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </span>
                  <div>
                    <h4>{meta.title}</h4>
                    <p>{meta.description}</p>
                  </div>
                  <span className="bookmark-health-group__count">{groupBookmarks.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="bookmark-health-group__list">
                    {groupBookmarks.map((bookmark) => renderBookmarkRow(bookmark, 0))}
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "添加失败");
    } finally {
      setBusy(false);
    }
  };

  const handleLinkScan = async () => {
    setScanningLinks(true);
    setMessage("");
    setScanProgress({ checked: 0, total: bookmarks.length });
    try {
      const report = await checkBookmarkLinks(bookmarks, (checked, total) => {
        setScanProgress({ checked, total });
      });
      setLinkHealthReport(report);
      setMessage(`检测完成：${formatLinkHealthSummary(report)}，跳过 ${report.skippedCount} 个非网页链接。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "链接检测失败");
    } finally {
      setScanningLinks(false);
    }
  };

  const emptyMessage = useMemo(() => {
    if (searchQuery) return "未找到匹配的书签";
    if (taskMode === "unsorted") {
      return pendingRecommendations.length > 0 ? "暂无未分类文件夹书签，可先处理上方 AI 推荐" : "暂无未分类书签";
    }
    if (taskMode === "duplicate") return "暂无重复链接";
    if (taskMode === "invalid") {
      return linkHealthReport ? "未发现需要复查的链接" : "尚未检测链接，点击开始检测后查看结果";
    }
    return "暂无书签";
  }, [linkHealthReport, pendingRecommendations.length, searchQuery, taskMode]);

  return (
    <div className="extension-page">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">{pageTitle}</h1>
              <p className="extension-page__subtitle">{pageSubtitle}</p>
            </div>
          </div>
          {!taskMode && (
            <button onClick={() => setShowAddForm(true)} className="extension-page__primary-button">
              <Plus className="w-4 h-4" />
              添加书签
            </button>
          )}
        </div>

        {message && (
          <div className="extension-notice extension-notice--amber">
            <p>{message}</p>
          </div>
        )}

        {taskMode === "invalid" && (
          <section className="bookmark-task-panel">
            <div className="bookmark-task-panel__main">
              <strong>手动检测链接</strong>
              <p>
                仅检测 http/https 书签。401、403、429 视为可到达；超时和 5xx 会标记为暂时无法确认。
              </p>
              {linkHealthReport && (
                <span>上次检测：{formatScanTime(linkHealthReport.createdAt)}，{formatLinkHealthSummary(linkHealthReport)}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleLinkScan()}
              disabled={scanningLinks || bookmarks.length === 0}
              className="extension-page__wide-primary bookmark-task-panel__button"
            >
              <RefreshCw className={`w-4 h-4 ${scanningLinks ? "bookmark-task-panel__spin" : ""}`} />
              {scanningLinks ? `检测中 ${scanProgress.checked}/${scanProgress.total}` : linkHealthReport ? "重新检测" : "开始检测"}
            </button>
            {scanningLinks && scanProgress.total > 0 && (
              <div className="bookmark-task-progress" aria-hidden="true">
                <span style={{ width: `${Math.round((scanProgress.checked / scanProgress.total) * 100)}%` }} />
              </div>
            )}
          </section>
        )}

        {taskMode !== "invalid" && (
          <div className="extension-search-field manage-bookmarks-search">
            <Search className="extension-search-field__icon" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={taskMode ? "在当前任务中搜索..." : "搜索书签..."}
              className="extension-control extension-control--search"
            />
          </div>
        )}

        {taskMode === "invalid" ? (
          renderLinkHealthGroups()
        ) : taskMode === "unsorted" ? (
          renderUnsortedTasks()
        ) : taskMode === "duplicate" ? (
          renderDuplicateTasks()
        ) : (
          <section className="bookmark-tree-panel">
            <div className="bookmark-tree-panel__head">
              <h3>{taskMode ? "任务结果" : "文件夹"}</h3>
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
                <X className="w-5 h-5 text-gray-500" />
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
            {emptyMessage}
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
    </div>
  );
}
