import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowLeft,
  Folder,
  ExternalLink,
  Check,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Globe2,
  RefreshCw,
  Zap,
} from "lucide-react";
import type { BookmarkNode, MovePlan, OrganizeMode, PreviewTaskCache, PreviewTaskProgress, TokenUsage } from "../types";
import { executeMovePlans } from "../services/organizer";
import { useAppStore } from "../store/useAppStore";
import { clearPreviewPlan, getPreviewPlan, savePreviewPlan } from "../services/storage";
import { getPreviewTask, requestClearPreviewTask, startPreviewTask } from "../services/previewTask";
import { getAllBookmarks, getBookmarkFaviconUrl } from "../services/bookmarks";
import { CollapsibleSection } from "./CollapsibleSection";

type PreviewPhase = "selection" | "preview" | "submitting";

type BookmarkFolderNode = {
  key: string;
  title: string;
  path: string[];
  count: number;
  children: BookmarkFolderNode[];
  bookmarks: BookmarkNode[];
};

type PreviewFolderNode = {
  key: string;
  title: string;
  path: string[];
  count: number;
  children: PreviewFolderNode[];
  plans: MovePlan[];
};

type LongPressSession = {
  plan: MovePlan;
  active: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  timer: number;
};

const DEEP_ORGANIZE_BOOKMARK_LIMIT = 100;
const QUICK_ORGANIZE_BOOKMARK_RECOMMENDED_LIMIT = 300;
const STALLED_PROGRESS_WARNING_MS = 2 * 60 * 1000;

function createFolderNode(title: string, path: string[]): BookmarkFolderNode {
  return {
    key: path.join("/") || "__root__",
    title,
    path,
    count: 0,
    children: [],
    bookmarks: [],
  };
}

function buildBookmarkFolderTree(bookmarks: BookmarkNode[]) {
  const root = createFolderNode("全部书签", []);
  const folderMap = new Map<string, BookmarkFolderNode>([[root.key, root]]);

  bookmarks.forEach((bookmark) => {
    const folderPath = bookmark.path;
    let current = root;
    current.count += 1;

    folderPath.forEach((folderName, index) => {
      const path = folderPath.slice(0, index + 1);
      const key = path.join("/");
      let folder = folderMap.get(key);

      if (!folder) {
        folder = createFolderNode(folderName, path);
        folderMap.set(key, folder);
        current.children.push(folder);
      }

      folder.count += 1;
      current = folder;
    });

    current.bookmarks.push(bookmark);
  });

  const sortTree = (node: BookmarkFolderNode) => {
    node.children.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    node.bookmarks.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    node.children.forEach(sortTree);
  };

  sortTree(root);
  return root;
}

function createPreviewFolderNode(title: string, path: string[]): PreviewFolderNode {
  return {
    key: path.join("/") || "__preview_root__",
    title,
    path,
    count: 0,
    children: [],
    plans: [],
  };
}

function buildMovePlanFolderTree(plans: MovePlan[]) {
  const root = createPreviewFolderNode("Root", []);
  const folderMap = new Map<string, PreviewFolderNode>([[root.key, root]]);

  plans.forEach((plan) => {
    const folderPath = plan.toFolderPath.length ? plan.toFolderPath : ["待整理"];
    let current = root;
    current.count += 1;

    folderPath.forEach((folderName, index) => {
      const path = folderPath.slice(0, index + 1);
      const key = path.join("/");
      let folder = folderMap.get(key);

      if (!folder) {
        folder = createPreviewFolderNode(folderName, path);
        folderMap.set(key, folder);
        current.children.push(folder);
      }

      folder.count += 1;
      current = folder;
    });

    current.plans.push(plan);
  });

  const sortTree = (node: PreviewFolderNode) => {
    node.children.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    node.plans.sort((a, b) => a.bookmarkTitle.localeCompare(b.bookmarkTitle, "zh-CN"));
    node.children.forEach(sortTree);
  };

  sortTree(root);
  return root;
}

function countPreviewFolders(root: PreviewFolderNode) {
  let count = 0;
  const walk = (node: PreviewFolderNode) => {
    if (node.plans.length > 0) count += 1;
    node.children.forEach((child) => {
      walk(child);
    });
  };
  walk(root);
  return count;
}

function collectPreviewFolderLookup(root: PreviewFolderNode) {
  const lookup = new Map<string, PreviewFolderNode>();
  const collect = (folder: PreviewFolderNode) => {
    if (folder.path.length > 0) lookup.set(folder.key, folder);
    folder.children.forEach(collect);
  };
  collect(root);
  return lookup;
}

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "不足 1 分钟";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `约 ${hours} 小时 ${restMinutes} 分钟` : `约 ${hours} 小时`;
}

function getProgressPhaseLabel(phase?: PreviewTaskProgress["phase"]) {
  switch (phase) {
    case "queued":
      return "等待开始";
    case "preparing":
      return "正在生成预览";
    case "requesting_ai":
      return "正在请求 AI";
    case "parsing_results":
      return "正在解析结果";
    case "generating_preview":
      return "正在生成预览";
    default:
      return "正在处理";
  }
}

function getRemainingTimeText(progress: PreviewTaskProgress | undefined, now: number) {
  if (!progress) return "预计剩余时间：正在估算";
  if (progress.totalBatches > 0) {
    if (progress.completedBatches <= 0) return "预计剩余时间：正在估算";
    const elapsed = Math.max(1, now - progress.startedAt);
    const averageBatchMs = elapsed / progress.completedBatches;
    const remainingBatches = Math.max(0, progress.totalBatches - progress.completedBatches);
    return `预计剩余时间：${formatDuration(averageBatchMs * remainingBatches)}`;
  }

  if (progress.totalBookmarks > 0 && progress.processedBookmarks > 0) {
    const elapsed = Math.max(1, now - progress.startedAt);
    const averageBookmarkMs = elapsed / progress.processedBookmarks;
    const remainingBookmarks = Math.max(0, progress.totalBookmarks - progress.processedBookmarks);
    return `预计剩余时间：${formatDuration(averageBookmarkMs * remainingBookmarks)}`;
  }

  return "预计剩余时间：正在估算";
}

function getProgressPercent(progress: PreviewTaskProgress | undefined) {
  if (!progress) return 0;
  if (progress.totalBatches > 0) {
    return Math.min(100, Math.round((progress.completedBatches / progress.totalBatches) * 100));
  }
  if (progress.totalBookmarks > 0) {
    return Math.min(100, Math.round((progress.processedBookmarks / progress.totalBookmarks) * 100));
  }
  return 0;
}

export function Preview() {
  const navigate = useNavigate();
  const { loadAll } = useAppStore();
  const [phase, setPhase] = useState<PreviewPhase>("selection");
  const [allBookmarks, setAllBookmarks] = useState<BookmarkNode[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<MovePlan[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | undefined>();
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [draggedPlan, setDraggedPlan] = useState<MovePlan | null>(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [savingPreviewDrop, setSavingPreviewDrop] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cacheMessage, setCacheMessage] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [processingBookmarkCount, setProcessingBookmarkCount] = useState(0);
  const [taskProgress, setTaskProgress] = useState<PreviewTaskProgress | undefined>();
  const [now, setNow] = useState(Date.now());
  const [organizeMode, setOrganizeMode] = useState<OrganizeMode>("quick");
  const [expandedPreviewFolders, setExpandedPreviewFolders] = useState<Set<string>>(new Set());
  const [expandedSelectionFolders, setExpandedSelectionFolders] = useState<Set<string>>(
    () => new Set(["__root__"])
  );
  const longPressSessionRef = useRef<LongPressSession | null>(null);
  const previewFolderLookupRef = useRef<Map<string, PreviewFolderNode>>(new Map());
  const activeDropFolderRef = useRef<PreviewFolderNode | null>(null);
  const suppressNextPreviewClickRef = useRef(false);

  const loadSelectableBookmarks = async () => {
    const bookmarks = await getAllBookmarks();
    const urlBookmarks = bookmarks.filter((b) => b.url);
    setAllBookmarks(urlBookmarks);
    setSelectedIds(new Set(urlBookmarks.map((b) => b.id)));
  };

  const restoreCompletedTask = (task: PreviewTaskCache) => {
    if (!task.movePlan?.length) return false;

    setPlans(task.movePlan);
    setTokenUsage(task.tokenUsage);
    setOrganizeMode(task.organizeMode ?? "quick");
    setProcessingBookmarkCount(0);
    setTaskProgress(undefined);
    setCacheMessage(`已恢复 ${new Date(task.updatedAt).toLocaleString()} 生成的预览结果`);
    setPhase("preview");
    setLoading(false);
    setActiveTaskId(null);
    return true;
  };

  const restoreRunningTask = (task: PreviewTaskCache) => {
    setPlans([]);
    setTokenUsage(undefined);
    setActiveTaskId(task.id);
    setProcessingBookmarkCount(task.bookmarkCount);
    setTaskProgress(task.progress);
    setOrganizeMode(task.organizeMode ?? "quick");
    setCacheMessage(`正在生成 ${task.bookmarkCount} 个书签的分类建议，可收起后稍后返回`);
    setPhase("preview");
    setLoading(true);
  };

  // 加载所有书签
  useEffect(() => {
    let alive = true;
    const load = async () => {
      let keepLoading = false;
      setLoading(true);
      try {
        const task = await getPreviewTask();
        if (!alive) return;
        if (task?.status === "running") {
          keepLoading = true;
          restoreRunningTask(task);
          return;
        }
        if (task?.status === "completed" && restoreCompletedTask(task)) {
          return;
        }
        if (task?.status === "failed" && task.error) {
          setError(task.error);
          await loadSelectableBookmarks();
          return;
        }

        // 先检查是否有缓存的预览
        const cached = await getPreviewPlan();
        if (!alive) return;
        if (cached?.movePlan.length) {
          setPlans(cached.movePlan);
          setTokenUsage(cached.tokenUsage);
          setOrganizeMode(cached.organizeMode ?? "quick");
          setProcessingBookmarkCount(0);
          setCacheMessage(`已恢复 ${new Date(cached.createdAt).toLocaleString()} 生成的预览结果`);
          setPhase("preview");
          setLoading(false);
          return;
        }

        // 没有缓存，加载书签列表供选择
        await loadSelectableBookmarks();
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载书签失败");
      } finally {
        if (alive && !keepLoading) setLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!activeTaskId || !loading || phase !== "preview") return;

    let alive = true;
    const pollTask = async () => {
      const task = await getPreviewTask();
      if (!alive) return;
      if (!task) {
        setActiveTaskId(null);
        setCacheMessage("");
        setPlans([]);
        setTaskProgress(undefined);
        setPhase("selection");
        setLoading(true);
        try {
          await loadSelectableBookmarks();
        } finally {
          if (alive) setLoading(false);
        }
        return;
      }
      if (task.id !== activeTaskId) return;
      setTaskProgress(task.progress);

      if (task.status === "completed") {
        restoreCompletedTask(task);
        return;
      }

      if (task.status === "failed") {
        setActiveTaskId(null);
        setError(task.error ?? "生成分类失败");
        setCacheMessage("");
        setPlans([]);
        setTaskProgress(undefined);
        setPhase("selection");
        setLoading(true);
        try {
          await loadSelectableBookmarks();
        } finally {
          if (alive) setLoading(false);
        }
      }
    };

    void pollTask();
    const timer = window.setInterval(() => {
      void pollTask();
    }, 1500);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [activeTaskId, loading, phase]);

  useEffect(() => {
    if (!loading || phase !== "preview") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [loading, phase]);

  useEffect(() => {
    return () => {
      if (longPressSessionRef.current) {
        window.clearTimeout(longPressSessionRef.current.timer);
      }
    };
  }, []);

  const selectionTree = useMemo(() => buildBookmarkFolderTree(allBookmarks), [allBookmarks]);
  const isDeepSelectionTooLarge = organizeMode === "deep" && selectedIds.size > DEEP_ORGANIZE_BOOKMARK_LIMIT;
  const isQuickSelectionLarge = organizeMode === "quick" && selectedIds.size > QUICK_ORGANIZE_BOOKMARK_RECOMMENDED_LIMIT;
  const deepSelectionLimitMessage = `深度整理单次最多建议选择 ${DEEP_ORGANIZE_BOOKMARK_LIMIT} 个书签。当前已选 ${selectedIds.size} 个，请减少选择或改用快速整理。`;

  const quickSelectionLargeMessage = `当前选择 ${selectedIds.size} 个书签，快速整理建议单次不超过 ${QUICK_ORGANIZE_BOOKMARK_RECOMMENDED_LIMIT} 个。数量较大时建议按文件夹分批整理，避免 AI 请求排队过久。`;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleFolderSelect = (folder: BookmarkFolderNode) => {
    const collectBookmarkIds = (node: BookmarkFolderNode): string[] => {
      const ids = node.bookmarks.map((b) => b.id);
      return node.children.reduce((acc, child) => acc.concat(collectBookmarkIds(child)), ids);
    };
    const ids = collectBookmarkIds(folder);
    const allSelected = ids.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  };

  const toggleFolderExpand = (key: string) => {
    setExpandedSelectionFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const getFolderSelectedCount = (folder: BookmarkFolderNode): number => {
    const collectBookmarkIds = (node: BookmarkFolderNode): string[] => {
      const ids = node.bookmarks.map((b) => b.id);
      return node.children.reduce((acc, child) => acc.concat(collectBookmarkIds(child)), ids);
    };
    return collectBookmarkIds(folder).filter((id) => selectedIds.has(id)).length;
  };

  // 开始分类
  const handleStartClassify = async () => {
    if (selectedIds.size === 0) {
      setError("请至少选择一个书签");
      return;
    }
    if (isDeepSelectionTooLarge) {
      setError(deepSelectionLimitMessage);
      return;
    }
    setPhase("preview");
    setLoading(true);
    setError("");
    setTokenUsage(undefined);
    setTaskProgress(undefined);

    try {
      const bookmarksToClassify = allBookmarks.filter((b) => selectedIds.has(b.id));
      setProcessingBookmarkCount(bookmarksToClassify.length);
      const task = await startPreviewTask(bookmarksToClassify, organizeMode);
      if (task?.status === "completed" && restoreCompletedTask(task)) return;
      if (task?.status === "failed") {
        throw new Error(task.error ?? "生成分类失败");
      }
      if (task) {
        restoreRunningTask(task);
        return;
      }
      throw new Error("生成分类失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成分类失败");
      setPhase("selection");
      setLoading(false);
    }
  };

  const handleRegenerate = async () => {
    setExpandedPreviewFolders(new Set());
    setSelectedPlan(null);
    setDraggedPlan(null);
    setDragOverFolder(null);
    setSavingPreviewDrop(false);
    setCacheMessage("");
    setTokenUsage(undefined);
    setActiveTaskId(null);
    setProcessingBookmarkCount(0);
    setTaskProgress(undefined);
    setLoading(true);
    setError("");
    try {
      await Promise.all([clearPreviewPlan(), requestClearPreviewTask()]);
      await loadSelectableBookmarks();
      setPlans([]);
      setPhase("selection");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载书签失败");
    } finally {
      setLoading(false);
    }
  };

  const previewTree = useMemo(() => buildMovePlanFolderTree(plans), [plans]);
  const previewFolderCount = useMemo(() => countPreviewFolders(previewTree), [previewTree]);
  const previewFolderLookup = useMemo(() => collectPreviewFolderLookup(previewTree), [previewTree]);
  const progressPercent = getProgressPercent(taskProgress);
  const progressPhaseLabel = getProgressPhaseLabel(taskProgress?.phase);
  const progressBatchText = taskProgress?.totalBatches
    ? `已完成 ${taskProgress.completedBatches}/${taskProgress.totalBatches} 批次`
    : "正在准备批次";
  const progressBookmarkText = taskProgress
    ? `已处理 ${taskProgress.processedBookmarks}/${taskProgress.totalBookmarks} 个书签`
    : `待处理 ${processingBookmarkCount || selectedIds.size} 个书签`;
  const remainingTimeText = getRemainingTimeText(taskProgress, now);
  const isTaskProgressStalled = Boolean(
    loading && taskProgress && now - taskProgress.updatedAt > STALLED_PROGRESS_WARNING_MS
  );

  useEffect(() => {
    previewFolderLookupRef.current = previewFolderLookup;
  }, [previewFolderLookup]);

  const clearLongPressSession = () => {
    if (!longPressSessionRef.current) return;
    window.clearTimeout(longPressSessionRef.current.timer);
    longPressSessionRef.current = null;
  };

  const resetPreviewDrag = () => {
    clearLongPressSession();
    activeDropFolderRef.current = null;
    setDraggedPlan(null);
    setDragOverFolder(null);
  };

  const handlePreviewRowPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    plan: MovePlan
  ) => {
    if (loading || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a,input,select,textarea")) return;

    clearLongPressSession();
    event.currentTarget.setPointerCapture(event.pointerId);

    longPressSessionRef.current = {
      plan,
      active: false,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        const session = longPressSessionRef.current;
        if (!session || session.plan.bookmarkId !== plan.bookmarkId) return;
        session.active = true;
        window.getSelection()?.removeAllRanges();
        setSelectedPlan(plan.bookmarkId);
        setDraggedPlan(plan);
        setDragPosition({ x: session.x, y: session.y });
      }, 420),
    };
  };

  const handlePreviewRowPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = longPressSessionRef.current;
    if (!session) return;

    const movement = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (!session.active && movement > 8) {
      resetPreviewDrag();
      return;
    }
    if (!session.active) return;

    event.preventDefault();
    session.x = event.clientX;
    session.y = event.clientY;
    setDragPosition({ x: event.clientX, y: event.clientY });

    const element = document.elementFromPoint(event.clientX, event.clientY);
    const row = element instanceof Element ? element.closest<HTMLElement>("[data-preview-folder-key]") : null;
    const folderKey = row?.dataset.previewFolderKey;
    const folder = folderKey ? previewFolderLookupRef.current.get(folderKey) : null;
    const currentTargetKey = session.plan.toFolderPath.join("/");

    if (folder && folder.key !== currentTargetKey) {
      activeDropFolderRef.current = folder;
      setDragOverFolder(folder.key);
    } else {
      activeDropFolderRef.current = null;
      setDragOverFolder(null);
    }
  };

  const applyPreviewDrop = async (sourcePlan: MovePlan, targetFolder: PreviewFolderNode) => {
    const targetPath = targetFolder.path;
    const previousPlans = plans;
    const nextPlans = plans.map((plan) =>
      plan.bookmarkId === sourcePlan.bookmarkId
        ? {
            ...plan,
            toFolderPath: targetPath,
            confidence: 1,
            reason: `手动拖动到预览文件夹：${targetPath.join(" / ")}`,
            source: "manual" as const,
          }
        : plan
    );

    setPlans(nextPlans);
    setSavingPreviewDrop(true);
    setExpandedPreviewFolders((prev) => {
      const next = new Set(prev);
      targetPath.forEach((_, index) => {
        next.add(targetPath.slice(0, index + 1).join("/"));
      });
      return next;
    });
    setCacheMessage("已更新预览计划，正在保存调整...");

    try {
      await Promise.all([
        requestClearPreviewTask(),
        savePreviewPlan({
          id: `preview-drag-${Date.now()}`,
          createdAt: Date.now(),
          bookmarkCount: nextPlans.length,
          organizeMode,
          movePlan: nextPlans,
          tokenUsage,
        }),
      ]);

      setCacheMessage("已更新预览计划，确认整理前不会移动书签");
    } catch (err) {
      setPlans(previousPlans);
      setCacheMessage("");
      setError(err instanceof Error ? err.message : "保存手动调整失败");
    } finally {
      setSavingPreviewDrop(false);
    }
  };

  const handlePreviewRowPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = longPressSessionRef.current;
    if (!session) return;

    const wasActive = session.active;
    const sourcePlan = session.plan;
    const targetFolder = activeDropFolderRef.current;
    if (wasActive) {
      event.preventDefault();
      suppressNextPreviewClickRef.current = true;
      window.setTimeout(() => {
        suppressNextPreviewClickRef.current = false;
      }, 100);
    }

    resetPreviewDrag();
    if (wasActive && targetFolder) {
      void applyPreviewDrop(sourcePlan, targetFolder);
    }
  };

  const handleConfirm = async () => {
    if (!plans.length) return;
    setPhase("submitting");
    try {
      await executeMovePlans(plans, tokenUsage);
      await Promise.all([clearPreviewPlan(), requestClearPreviewTask()]);
      await loadAll();
      navigate("/report");
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行整理失败");
      setPhase("preview");
    }
  };

  const toggleFolder = (folderPath: string) => {
    setExpandedPreviewFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.9) return "text-green-600 bg-green-50";
    if (confidence >= 0.8) return "text-blue-600 bg-blue-50";
    return "text-amber-600 bg-amber-50";
  };

  const BookmarkFavicon = ({
    title,
    url,
    className = "selection-tree-row__favicon",
  }: {
    title: string;
    url?: string;
    className?: string;
  }) => {
    const [failed, setFailed] = useState(false);
    const faviconUrl = url && !failed ? getBookmarkFaviconUrl(url) : "";

    return (
      <span className={`extension-favicon ${className}`} aria-hidden="true" title={title}>
        <Globe2 className="extension-favicon__fallback" />
        {faviconUrl && (
          <img
            src={faviconUrl}
            alt=""
            draggable={false}
            onError={() => setFailed(true)}
          />
        )}
      </span>
    );
  };

  const renderSelectionTreeNode = (folder: BookmarkFolderNode, depth = 0) => {
    const isExpanded = expandedSelectionFolders.has(folder.key);
    const selectedCount = getFolderSelectedCount(folder);
    const allSelected = folder.count > 0 && selectedCount === folder.count;
    const hasChildren = folder.children.length > 0 || folder.bookmarks.length > 0;

    return (
      <div key={folder.key}>
        <div
          className={`selection-tree-row selection-tree-row--folder ${allSelected ? "is-selected" : ""}`}
          style={{ "--tree-depth": depth } as CSSProperties}
        >
          <button
            type="button"
            className="selection-tree-row__expand"
            onClick={() => toggleFolderExpand(folder.key)}
            aria-expanded={isExpanded}
          >
            {hasChildren ? (
              isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
            ) : null}
          </button>
          <label className="selection-tree-row__checkbox">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = selectedCount > 0 && selectedCount < folder.count;
              }}
              onChange={() => toggleFolderSelect(folder)}
            />
          </label>
          <Folder className="selection-tree-row__folder-icon" />
          <span className="selection-tree-row__title">{folder.title}</span>
          <span className="selection-tree-row__count">{selectedCount}/{folder.count}</span>
        </div>

        {isExpanded && (
          <>
            {folder.children.map((child) => renderSelectionTreeNode(child, depth + 1))}
            {folder.bookmarks.map((bookmark) => renderSelectionBookmarkRow(bookmark, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderSelectionBookmarkRow = (bookmark: BookmarkNode, depth: number) => (
    <label
      key={bookmark.id}
      className={`selection-tree-row selection-tree-row--bookmark ${selectedIds.has(bookmark.id) ? "is-selected" : ""}`}
      style={{ "--tree-depth": depth } as CSSProperties}
    >
      <span className="selection-tree-row__expand" />
      <span className="selection-tree-row__checkbox">
        <input
          type="checkbox"
          checked={selectedIds.has(bookmark.id)}
          onChange={() => toggleSelect(bookmark.id)}
        />
      </span>
      <BookmarkFavicon title={bookmark.title} url={bookmark.url} />
      <span className="selection-tree-row__title" title={bookmark.title}>{bookmark.title}</span>
      {bookmark.url && (
        <a
          href={bookmark.url}
          target="_blank"
          rel="noopener noreferrer"
          className="extension-link-icon"
          aria-label="打开书签"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </label>
  );

  const renderPreviewTreeNode = (folder: PreviewFolderNode, depth = 0) => {
    const isExpanded = expandedPreviewFolders.has(folder.key);
    const hasChildren = folder.children.length > 0 || folder.plans.length > 0;
    const folderPath = folder.path.join(" / ");
    const isDropTarget = Boolean(draggedPlan && folder.key !== draggedPlan.toFolderPath.join("/"));
    const isDragOver = dragOverFolder === folder.key;

    return (
      <div key={folder.key} className="preview-tree-node">
        <button
          type="button"
          className={`preview-tree-row preview-tree-row--folder ${isDropTarget ? "is-drop-target" : ""} ${isDragOver ? "is-drag-over" : ""}`}
          style={{ "--tree-depth": depth } as CSSProperties}
          aria-expanded={isExpanded}
          data-preview-folder-key={folder.key}
          onClick={() => toggleFolder(folder.key)}
        >
          <span className="preview-tree-row__expand">
            {hasChildren ? (
              isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
            ) : null}
          </span>
          <Folder className="preview-tree-row__folder-icon" />
          <span className="preview-tree-row__title" title={folderPath}>{folder.title}</span>
          <span className="preview-tree-row__count">{folder.count} 个</span>
        </button>

        {isExpanded && (
          <>
            {folder.children.map((child) => renderPreviewTreeNode(child, depth + 1))}
            {folder.plans.map((plan) => renderPreviewPlanRow(plan, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderPreviewPlanRow = (plan: MovePlan, depth: number) => (
    <button
      key={plan.bookmarkId}
      className={`preview-tree-row preview-tree-row--bookmark ${
        selectedPlan === plan.bookmarkId ? "is-selected" : ""
      } ${draggedPlan?.bookmarkId === plan.bookmarkId ? "is-dragging" : ""}`}
      style={{ "--tree-depth": depth } as CSSProperties}
      aria-label={`长按并拖动 ${plan.bookmarkTitle} 到预览文件夹`}
      onPointerDown={(event) => handlePreviewRowPointerDown(event, plan)}
      onPointerMove={handlePreviewRowPointerMove}
      onPointerUp={handlePreviewRowPointerUp}
      onPointerCancel={resetPreviewDrag}
      onClick={() => {
        if (suppressNextPreviewClickRef.current) return;
        setSelectedPlan(plan.bookmarkId);
      }}
    >
      <span className="preview-tree-row__expand" />
      <BookmarkFavicon
        title={plan.bookmarkTitle}
        url={plan.bookmarkUrl}
        className="preview-tree-row__favicon"
      />
      <span className="preview-tree-row__content">
        <span className="preview-tree-row__title-line">
          <span className="preview-tree-row__title" title={plan.bookmarkTitle}>{plan.bookmarkTitle}</span>
          {plan.bookmarkUrl && (
            <a
              href={plan.bookmarkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="extension-link-icon"
              aria-label="打开书签"
              onClick={(event) => event.stopPropagation()}
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </span>
        {plan.reason && (
          <span className="preview-tree-row__note">{plan.reason}</span>
        )}
      </span>
      <span className={`extension-confidence ${getConfidenceColor(plan.confidence)}`}>
        {Math.round(plan.confidence * 100)}%
      </span>
    </button>
  );

  const toggleSelectAll = () => {
    if (selectedIds.size === allBookmarks.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allBookmarks.map((b) => b.id)));
    }
  };

  return (
    <div className="extension-page extension-page--preview">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">
                {phase === "selection" ? "选择书签" : "整理预览"}
              </h1>
              <p className="extension-page__subtitle">
                {loading
                  ? "正在处理..."
                  : phase === "selection"
                    ? `已选 ${selectedIds.size}/${allBookmarks.length} 个书签`
                    : `${plans.length} 个书签待确认`}
              </p>
            </div>
          </div>
          {phase === "preview" && !loading && (
            <button
              onClick={handleConfirm}
              disabled={!plans.length || savingPreviewDrop}
              className="extension-page__primary-button"
            >
              <Check className="w-4 h-4" />
              确认整理
            </button>
          )}
        </div>

        {error && (
          <div className="extension-notice extension-notice--amber">
            <p>{error}</p>
          </div>
        )}

        {cacheMessage && (
          <div className="extension-notice extension-notice--blue">
            <p>{cacheMessage}</p>
          </div>
        )}

        {/* 选择阶段 */}
        {phase === "selection" && !loading && (
          <>
            <div className="extension-notice extension-notice--blue">
              <div className="extension-notice__title">
                <AlertCircle className="extension-notice__icon" />
                <span>选择要整理的书签</span>
              </div>
              <p>勾选需要整理的书签，未勾选的书签将保持原位置不变。</p>
            </div>

            <div className="extension-selection-actions">
              <button onClick={toggleSelectAll} className="extension-text-button">
                {selectedIds.size === allBookmarks.length ? "取消全选" : "全选"}
              </button>
              <span className="extension-selection-count">
                已选 {selectedIds.size} 个
              </span>
            </div>

            <div className="organize-mode-picker" role="group" aria-label="选择整理模式">
              <button
                type="button"
                className={`organize-mode-picker__button ${organizeMode === "quick" ? "is-active" : ""}`}
                onClick={() => setOrganizeMode("quick")}
              >
                <Zap className="w-4 h-4" />
                <span>
                  <strong>快速整理</strong>
                  <small>更快生成，网页元数据等待较短</small>
                </span>
              </button>
              <button
                type="button"
                className={`organize-mode-picker__button ${organizeMode === "deep" ? "is-active" : ""}`}
                onClick={() => setOrganizeMode("deep")}
              >
                <Globe2 className="w-4 h-4" />
                <span>
                  <strong>深度整理</strong>
                  <small>等待更久，尽量抓取更多网页元数据</small>
                </span>
              </button>
            </div>

            {isDeepSelectionTooLarge && (
              <div className="extension-notice extension-notice--amber">
                <p>{deepSelectionLimitMessage}</p>
              </div>
            )}

            {isQuickSelectionLarge && (
              <div className="extension-notice extension-notice--amber">
                <p>{quickSelectionLargeMessage}</p>
              </div>
            )}

            <section className="selection-tree-panel">
              <div className="selection-tree">
                {renderSelectionTreeNode(selectionTree)}
              </div>
            </section>

            <button
              onClick={handleStartClassify}
              disabled={selectedIds.size === 0 || isDeepSelectionTooLarge}
              className="extension-page__wide-primary"
            >
              <Check className="w-5 h-5" />
              开始分类 ({selectedIds.size} 个书签)
            </button>
          </>
        )}

        {/* 预览阶段 */}
        {phase === "preview" && (
          <>
            {!loading && plans.length > 0 && (
              <button onClick={handleRegenerate} className="extension-page__wide-secondary">
                <RefreshCw className="w-4 h-4" />
                重新选择书签
              </button>
            )}

            <div className="extension-notice extension-notice--blue">
              <div className="extension-notice__title">
                <AlertCircle className="extension-notice__icon" />
                <span>整理前预览</span>
              </div>
              <p>
                将移动 {plans.length} 个书签到 {previewFolderCount} 个文件夹。长按书签可拖到任意预览文件夹，确认前不会修改任何书签。
              </p>
            </div>

            {!loading && tokenUsage && (
              <div className="token-usage-highlight" aria-label="本次智能整理 token 消耗">
                <span className="token-usage-highlight__label">Token 消耗</span>
                <strong>{formatTokenCount(tokenUsage.totalTokens)}</strong>
                <span>输入 {formatTokenCount(tokenUsage.promptTokens)} / 输出 {formatTokenCount(tokenUsage.completionTokens)}</span>
              </div>
            )}

            {loading ? (
              <div className="extension-empty extension-empty--progress">
                <p>{progressPhaseLabel}</p>
                <span>{organizeMode === "deep" ? "深度整理会等待更多网页元数据..." : "AI 正在分析书签内容..."}</span>
                <span>{remainingTimeText}</span>
                <span>{progressBatchText}</span>
                <span>{progressBookmarkText}</span>
                <div className="preview-task-progress" aria-label="整理预览生成进度">
                  <span style={{ width: `${progressPercent}%` }} />
                </div>
                {isTaskProgressStalled && (
                  <span className="preview-task-warning">
                    后台任务超过 2 分钟没有进度更新，建议取消后重试或减少本次整理数量。
                  </span>
                )}
                <button onClick={handleRegenerate} className="extension-page__wide-secondary">
                  <RefreshCw className="w-4 h-4" />
                  取消并重新选择
                </button>
              </div>
            ) : plans.length === 0 ? (
              <div className="extension-empty">
                <p>暂无可整理书签</p>
                <span>请先在浏览器中添加书签</span>
              </div>
            ) : (
              <div className="preview-tree-panel">
                <div className="preview-tree">
                  {previewTree.children.map((folder) => renderPreviewTreeNode(folder))}
                </div>
              </div>
            )}

            <CollapsibleSection title="整理说明" hint="备份、撤销和文件夹复用规则">
              <ul className="extension-copy-list">
                <li>· 整理前会自动备份当前书签结构</li>
                <li>· 支持撤销最近一次整理操作</li>
                <li>· 已存在的文件夹会复用，不会重复创建</li>
              </ul>
            </CollapsibleSection>

            <button
              onClick={handleConfirm}
              disabled={!plans.length || loading || savingPreviewDrop}
              className="extension-page__wide-primary"
            >
              <Check className="w-5 h-5" />
              确认整理 {plans.length} 个书签
            </button>
          </>
        )}

        {draggedPlan && (
          <div
            className="preview-drag-ghost"
            style={{ left: dragPosition.x, top: dragPosition.y } as CSSProperties}
            aria-hidden="true"
          >
            <BookmarkFavicon
              title={draggedPlan.bookmarkTitle}
              url={draggedPlan.bookmarkUrl}
              className="preview-tree-row__favicon"
            />
            <span>{draggedPlan.bookmarkTitle}</span>
          </div>
        )}
      </div>
    </div>
  );
}
