import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowLeft,
  Folder,
  ExternalLink,
  Check,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Cpu,
  Globe2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Layers3,
  PauseCircle,
  Zap,
} from "lucide-react";
import type {
  BookmarkNode,
  FolderHabitProfile,
  MovePlan,
  OrganizeMode,
  PreviewTaskCache,
  PreviewTaskProgress,
  TokenUsage,
} from "../types";
import { executeMovePlans } from "../services/organizer";
import { useAppStore } from "../store/useAppStore";
import { clearPreviewPlan, getFolderHabitProfile, getPreviewPlan, savePreviewPlan } from "../services/storage";
import { getPreviewTask, requestClearPreviewTask, startPreviewTask } from "../services/previewTask";
import { getAllBookmarks, getBookmarkFaviconUrl } from "../services/bookmarks";
import { AI_PROVIDER_PROFILES, listAIModels, type AIModelOption } from "../services/aiProvider";
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

type PreviewRiskLevel = "auto" | "batch" | "review" | "keep";
type PreviewPlanDecision = "move" | "keep";

type PreviewRiskItem = {
  plan: MovePlan;
  level: PreviewRiskLevel;
  reasons: string[];
  sourcePath: string[];
};

type PreviewBatchGroup = {
  key: string;
  targetPath: string[];
  items: PreviewRiskItem[];
};

const DEEP_ORGANIZE_BOOKMARK_LIMIT = 100;
const QUICK_ORGANIZE_BOOKMARK_RECOMMENDED_LIMIT = 300;
const STALLED_PROGRESS_WARNING_MS = 2 * 60 * 1000;
const AUTO_ACCEPT_CONFIDENCE = 0.9;
const DEFAULT_EXPANDED_RISK_GROUPS = ["__batch__", "__review__"];

function pathKey(path: string[]) {
  return path.map((part) => part.trim()).filter(Boolean).join(" / ");
}

function isSamePath(left: string[], right: string[]) {
  return pathKey(left) === pathKey(right);
}

function buildPreviewRiskAnalysis(
  plans: MovePlan[],
  bookmarks: BookmarkNode[],
  habitProfile: FolderHabitProfile | null
) {
  const bookmarkById = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
  const existingPathCounts = new Map<string, number>();
  const existingTopLevels = new Set<string>();

  for (const bookmark of bookmarks) {
    bookmark.path.forEach((_, index) => {
      const key = pathKey(bookmark.path.slice(0, index + 1));
      if (key) existingPathCounts.set(key, (existingPathCounts.get(key) ?? 0) + 1);
    });
    if (bookmark.path[0]) existingTopLevels.add(bookmark.path[0]);
  }

  const habitPaths = new Set(
    (habitProfile?.folderRules ?? []).map((rule) => pathKey(rule.folderPath)).filter(Boolean)
  );
  const preferredTopLevels = new Set(habitProfile?.preferredTopLevelFolders ?? []);
  const auto: PreviewRiskItem[] = [];
  const review: PreviewRiskItem[] = [];
  const keep: PreviewRiskItem[] = [];
  const batchCandidates: PreviewRiskItem[] = [];

  for (const plan of plans) {
    const sourcePath = bookmarkById.get(plan.bookmarkId)?.path ?? [];
    const targetPath = plan.toFolderPath;
    const targetKey = pathKey(targetPath);
    const targetExists = existingPathCounts.has(targetKey);
    const habitMatches = (existingPathCounts.get(targetKey) ?? 0) >= 2 ||
      habitPaths.has(targetKey) ||
      Boolean(targetPath[0] && preferredTopLevels.has(targetPath[0]));
    const keepsTopLevel = Boolean(sourcePath[0] && targetPath[0] && sourcePath[0] === targetPath[0]);
    const crossesTopLevel = Boolean(sourcePath[0] && targetPath[0] && sourcePath[0] !== targetPath[0]);
    const createsTopLevel = Boolean(targetPath[0] && !existingTopLevels.has(targetPath[0]));
    const possibleDuplicate = /重复|duplicate/i.test(plan.reason ?? "");
    const keepsOriginalPosition = Boolean(
      plan.keepInPlace ||
      (sourcePath.length > 0 && isSamePath(sourcePath, targetPath))
    );

    if (keepsOriginalPosition) {
      keep.push({
        plan,
        level: "keep",
        sourcePath,
        reasons: [
          plan.keepInPlace ? "置信度不足，按当前默认策略不移动" : "目标与原目录一致",
        ],
      });
      continue;
    }

    if (
      plan.source === "manual" ||
      (
        plan.confidence >= AUTO_ACCEPT_CONFIDENCE &&
        targetExists &&
        habitMatches &&
        keepsTopLevel
      )
    ) {
      auto.push({
        plan,
        level: "auto",
        sourcePath,
        reasons: [
          plan.source === "manual"
            ? "已由你手动调整"
            : "高置信度、复用现有目录且符合已有分类习惯",
        ],
      });
      continue;
    }

    const reviewReasons = [
      createsTopLevel ? "将新建一级文件夹" : "",
      crossesTopLevel ? "将跨一级目录移动" : "",
      possibleDuplicate ? "检测到可能重复；本次不会删除" : "",
      plan.confidence < 0.7 ? "分类依据较弱" : "",
    ].filter(Boolean);

    if (reviewReasons.length > 0) {
      review.push({ plan, level: "review", sourcePath, reasons: reviewReasons });
      continue;
    }

    batchCandidates.push({
      plan,
      level: "batch",
      sourcePath,
      reasons: [targetExists ? "同一主题，目标目录已存在" : "同一主题，建议批量确认"],
    });
  }

  const batchGroupsByPath = new Map<string, PreviewBatchGroup>();
  for (const item of batchCandidates) {
    const key = pathKey(item.plan.toFolderPath) || "待整理";
    const group = batchGroupsByPath.get(key) ?? {
      key,
      targetPath: item.plan.toFolderPath,
      items: [],
    };
    group.items.push(item);
    batchGroupsByPath.set(key, group);
  }

  const sortByConfidence = (left: PreviewRiskItem, right: PreviewRiskItem) =>
    right.plan.confidence - left.plan.confidence ||
    left.plan.bookmarkTitle.localeCompare(right.plan.bookmarkTitle, "zh-CN");

  auto.sort(sortByConfidence);
  review.sort(sortByConfidence);
  keep.sort(sortByConfidence);
  const batchGroups = [...batchGroupsByPath.values()]
    .map((group) => ({ ...group, items: group.items.sort(sortByConfidence) }))
    .sort((left, right) => right.items.length - left.items.length || left.key.localeCompare(right.key, "zh-CN"));

  return { auto, batchGroups, review, keep };
}

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
  const { loadAll, loadSettings, settings } = useAppStore();
  const [phase, setPhase] = useState<PreviewPhase>("selection");
  const [allBookmarks, setAllBookmarks] = useState<BookmarkNode[]>([]);
  const [folderHabitProfile, setFolderHabitProfile] = useState<FolderHabitProfile | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<MovePlan[]>([]);
  const [planDecisions, setPlanDecisions] = useState<Record<string, PreviewPlanDecision>>({});
  const [expandedRiskGroups, setExpandedRiskGroups] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPANDED_RISK_GROUPS)
  );
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
  const [selectedModel, setSelectedModel] = useState("");
  const [availableModels, setAvailableModels] = useState<AIModelOption[]>([]);
  const [modelListStatus, setModelListStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [modelListError, setModelListError] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [isModelFiltering, setIsModelFiltering] = useState(false);
  const [highlightedModelIndex, setHighlightedModelIndex] = useState(0);
  const [expandedPreviewFolders, setExpandedPreviewFolders] = useState<Set<string>>(new Set());
  const [expandedSelectionFolders, setExpandedSelectionFolders] = useState<Set<string>>(
    () => new Set(["__root__"])
  );
  const longPressSessionRef = useRef<LongPressSession | null>(null);
  const previewFolderLookupRef = useRef<Map<string, PreviewFolderNode>>(new Map());
  const activeDropFolderRef = useRef<PreviewFolderNode | null>(null);
  const suppressNextPreviewClickRef = useRef(false);
  const modelPickerRef = useRef<HTMLDivElement | null>(null);
  const providerProfile = AI_PROVIDER_PROFILES[settings.provider.type];
  const displayedModels = useMemo(() => {
    if (!isModelFiltering) return availableModels;
    const query = selectedModel.trim().toLocaleLowerCase();
    if (!query) return availableModels;
    return availableModels.filter((model) => model.id.toLocaleLowerCase().includes(query));
  }, [availableModels, isModelFiltering, selectedModel]);

  const openModelMenu = (filtering = false) => {
    if (!availableModels.length) return;
    const models = filtering
      ? availableModels.filter((model) => model.id.toLocaleLowerCase().includes(selectedModel.trim().toLocaleLowerCase()))
      : availableModels;
    const selectedIndex = models.findIndex((model) => model.id === selectedModel);
    setIsModelFiltering(filtering);
    setHighlightedModelIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setModelMenuOpen(true);
  };

  const chooseModel = (modelId: string) => {
    setSelectedModel(modelId);
    setIsModelFiltering(false);
    setModelMenuOpen(false);
  };

  const handleModelKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!modelMenuOpen) {
        openModelMenu(false);
        return;
      }
      if (!displayedModels.length) return;
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedModelIndex((current) =>
        (current + offset + displayedModels.length) % displayedModels.length
      );
      return;
    }
    if (event.key === "Enter" && modelMenuOpen && displayedModels[highlightedModelIndex]) {
      event.preventDefault();
      chooseModel(displayedModels[highlightedModelIndex].id);
      return;
    }
    if (event.key === "Escape") {
      setModelMenuOpen(false);
    }
  };

  const refreshAvailableModels = async () => {
    if (!settings.provider.apiKey) {
      setModelListStatus("error");
      setModelListError("请先在设置页配置 API Key，之后即可查询可用模型");
      return;
    }

    setModelListStatus("loading");
    setModelListError("");
    try {
      const models = await listAIModels(settings.provider);
      setAvailableModels(models);
      setModelListStatus("success");
      if (!models.length) setModelListError("服务商未返回可用模型，可继续手动输入模型名");
    } catch (err) {
      setAvailableModels([]);
      setModelListStatus("error");
      setModelListError(err instanceof Error ? err.message : "模型列表查询失败，可继续手动输入模型名");
    }
  };

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setSelectedModel(settings.provider.model);
    setAvailableModels([]);
    setModelMenuOpen(false);
    setModelListError("");
    if (!settings.provider.apiKey) {
      setModelListStatus("idle");
      return;
    }
    void refreshAvailableModels();
  }, [settings.provider.type, settings.provider.apiKey, settings.provider.endpoint, settings.provider.model]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [modelMenuOpen]);

  const loadSelectableBookmarks = async () => {
    const [bookmarks, habitProfile] = await Promise.all([
      getAllBookmarks(),
      getFolderHabitProfile(),
    ]);
    const urlBookmarks = bookmarks.filter((b) => b.url);
    setAllBookmarks(urlBookmarks);
    setFolderHabitProfile(habitProfile);
    setSelectedIds(new Set(urlBookmarks.map((b) => b.id)));
  };

  const restoreCompletedTask = (task: PreviewTaskCache) => {
    if (!task.movePlan?.length) return false;

    setPlans(task.movePlan);
    setTokenUsage(task.tokenUsage);
    setOrganizeMode(task.organizeMode ?? "quick");
    if (task.model) setSelectedModel(task.model);
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
    if (task.model) setSelectedModel(task.model);
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
        await loadSelectableBookmarks();
        if (!alive) return;
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
          return;
        }

        // 先检查是否有缓存的预览
        const cached = await getPreviewPlan();
        if (!alive) return;
        if (cached?.movePlan.length) {
          setPlans(cached.movePlan);
          setTokenUsage(cached.tokenUsage);
          setOrganizeMode(cached.organizeMode ?? "quick");
          if (cached.model) setSelectedModel(cached.model);
          setProcessingBookmarkCount(0);
          setCacheMessage(`已恢复 ${new Date(cached.createdAt).toLocaleString()} 生成的预览结果`);
          setPhase("preview");
          setLoading(false);
          return;
        }

        // 没有缓存，使用已经加载的书签列表供选择
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
    const model = selectedModel.trim();
    if (settings.provider.apiKey && !model) {
      setError("请选择或输入本次整理使用的模型");
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
      const task = await startPreviewTask(bookmarksToClassify, organizeMode, model || undefined);
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
    setExpandedRiskGroups(new Set(DEFAULT_EXPANDED_RISK_GROUPS));
    setPlanDecisions({});
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
  const riskAnalysis = useMemo(
    () => buildPreviewRiskAnalysis(plans, allBookmarks, folderHabitProfile),
    [plans, allBookmarks, folderHabitProfile]
  );
  const batchRiskCount = riskAnalysis.batchGroups.reduce((total, group) => total + group.items.length, 0);
  const actionableRiskItems = useMemo(
    () => [
      ...riskAnalysis.auto,
      ...riskAnalysis.batchGroups.flatMap((group) => group.items),
      ...riskAnalysis.review,
      ...riskAnalysis.keep,
    ],
    [riskAnalysis]
  );
  const approvedPlans = useMemo(
    () => plans.filter((plan) => planDecisions[plan.bookmarkId] === "move"),
    [plans, planDecisions]
  );
  const pendingDecisionCount = actionableRiskItems.filter(
    (item) =>
      (item.level === "batch" || item.level === "review") &&
      !planDecisions[item.plan.bookmarkId]
  ).length;
  const keptPlanCount = actionableRiskItems.filter(
    (item) => planDecisions[item.plan.bookmarkId] === "keep"
  ).length;
  const forceReviewPlanIds = riskAnalysis.review.map((item) => item.plan.bookmarkId);
  const allForceReviewItemsApproved = forceReviewPlanIds.length > 0 &&
    forceReviewPlanIds.every((bookmarkId) => planDecisions[bookmarkId] === "move");
  const allForceReviewItemsIgnored = forceReviewPlanIds.length > 0 &&
    forceReviewPlanIds.every((bookmarkId) => planDecisions[bookmarkId] === "keep");
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
    setPlanDecisions((previous) => {
      const next: Record<string, PreviewPlanDecision> = {};
      for (const item of actionableRiskItems) {
        if (item.level === "keep") {
          next[item.plan.bookmarkId] = "keep";
        } else if (item.level === "auto") {
          next[item.plan.bookmarkId] = "move";
        } else if (previous[item.plan.bookmarkId]) {
          next[item.plan.bookmarkId] = previous[item.plan.bookmarkId];
        }
      }
      return next;
    });
  }, [actionableRiskItems]);

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
            keepInPlace: false,
          }
        : plan
    );

    setPlans(nextPlans);
    setPlanDecisions((previous) => ({
      ...previous,
      [sourcePlan.bookmarkId]: "move",
    }));
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
    if (pendingDecisionCount > 0) {
      setError(`还有 ${pendingDecisionCount} 个风险项需要确认`);
      return;
    }
    if (!approvedPlans.length) {
      setError("当前没有已批准移动的书签");
      return;
    }
    setPhase("submitting");
    try {
      await executeMovePlans(approvedPlans, tokenUsage);
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

  const setPlanDecision = (bookmarkIds: string[], decision: PreviewPlanDecision) => {
    setPlanDecisions((previous) => {
      const next = { ...previous };
      for (const bookmarkId of bookmarkIds) next[bookmarkId] = decision;
      return next;
    });
    setError("");
  };

  const toggleRiskGroup = (key: string) => {
    setExpandedRiskGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const renderRiskPlanItem = (
    item: PreviewRiskItem,
    options: { showDecision?: boolean } = {}
  ) => {
    const { plan, sourcePath, reasons } = item;
    const decision = planDecisions[plan.bookmarkId];

    return (
      <div
        key={plan.bookmarkId}
        className={`preview-risk-item${decision ? ` is-${decision}` : ""}`}
      >
        <BookmarkFavicon
          title={plan.bookmarkTitle}
          url={plan.bookmarkUrl}
          className="preview-risk-item__favicon"
        />
        <div className="preview-risk-item__body">
          <div className="preview-risk-item__title-line">
            <strong title={plan.bookmarkTitle}>{plan.bookmarkTitle}</strong>
            <span className={`extension-confidence ${getConfidenceColor(plan.confidence)}`}>
              {Math.round(plan.confidence * 100)}%
            </span>
          </div>
          <div className="preview-risk-item__route">
            <span title={sourcePath.join(" / ") || "当前根目录"}>
              {sourcePath.join(" / ") || "当前根目录"}
            </span>
            <ChevronRight aria-hidden="true" />
            <span title={plan.toFolderPath.join(" / ")}>
              {plan.toFolderPath.join(" / ") || "保持原位"}
            </span>
          </div>
          <p>{reasons.join("；")}</p>
        </div>
        {options.showDecision && (
          <div className="preview-risk-item__actions" aria-label={`${plan.bookmarkTitle} 的处理方式`}>
            <button
              type="button"
              className={decision === "move" ? "is-active" : ""}
              onClick={() => setPlanDecision([plan.bookmarkId], "move")}
            >
              移动
            </button>
            <button
              type="button"
              className={decision === "keep" ? "is-active" : ""}
              onClick={() => setPlanDecision([plan.bookmarkId], "keep")}
            >
              保留
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderBatchRiskGroup = (group: PreviewBatchGroup) => {
    const isExpanded = expandedRiskGroups.has(group.key);
    const bookmarkIds = group.items.map((item) => item.plan.bookmarkId);
    const movedCount = bookmarkIds.filter((id) => planDecisions[id] === "move").length;
    const pendingCount = bookmarkIds.filter((id) => !planDecisions[id]).length;

    return (
      <div key={group.key} className="preview-batch-group">
        <div className="preview-batch-group__summary">
          <div>
            <strong>{group.items.length} 个同主题书签</strong>
            <span>建议放入：{group.targetPath.join(" / ")}</span>
          </div>
          <span className={`preview-batch-group__status${pendingCount ? "" : " is-decided"}`}>
            {pendingCount ? `${pendingCount} 个待确认` : movedCount ? `已接受 ${movedCount} 个` : "全部保留"}
          </span>
        </div>
        <div className="preview-batch-group__actions">
          <button
            type="button"
            className="preview-risk-action preview-risk-action--primary"
            onClick={() => setPlanDecision(bookmarkIds, "move")}
          >
            接受全部
          </button>
          <button
            type="button"
            className="preview-risk-action"
            onClick={() => toggleRiskGroup(group.key)}
            aria-expanded={isExpanded}
          >
            {isExpanded ? "收起检查" : "展开检查"}
            {isExpanded ? <ChevronDown /> : <ChevronRight />}
          </button>
        </div>
        {isExpanded && (
          <div className="preview-risk-list">
            {group.items.map((item) => renderRiskPlanItem(item, { showDecision: true }))}
          </div>
        )}
      </div>
    );
  };

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
                {phase === "selection" ? "选择书签" : "风险预览"}
              </h1>
              <p className="extension-page__subtitle">
                {loading
                  ? "正在处理..."
                  : phase === "selection"
                    ? `已选 ${selectedIds.size}/${allBookmarks.length} 个书签`
                    : pendingDecisionCount
                      ? `${pendingDecisionCount} 个风险项待确认`
                      : `已批准移动 ${approvedPlans.length} 个书签`}
              </p>
            </div>
          </div>
          {phase === "preview" && !loading && (
            <button
              onClick={handleConfirm}
              disabled={!approvedPlans.length || pendingDecisionCount > 0 || savingPreviewDrop}
              className="extension-page__primary-button"
            >
              <Check className="w-4 h-4" />
              {pendingDecisionCount ? `待确认 ${pendingDecisionCount}` : "确认整理"}
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

            <section
              className={`organize-model-picker${modelMenuOpen ? " is-open" : ""}`}
              aria-labelledby="organize-model-title"
            >
              <div className="organize-model-picker__header">
                <div className="organize-model-picker__title">
                  <Cpu className="w-4 h-4" />
                  <span>
                    <strong id="organize-model-title">本次整理模型</strong>
                    <small>{providerProfile.label}</small>
                  </span>
                </div>
                <button
                  type="button"
                  className="organize-model-picker__refresh"
                  onClick={() => void refreshAvailableModels()}
                  disabled={!settings.provider.apiKey || modelListStatus === "loading"}
                  aria-label="刷新可用模型"
                >
                  <RefreshCw className={modelListStatus === "loading" ? "organize-model-picker__spin" : ""} />
                  <span>{modelListStatus === "loading" ? "查询中" : "刷新模型"}</span>
                </button>
              </div>

              <div className="organize-model-picker__control" ref={modelPickerRef}>
                <input
                  className="extension-control organize-model-picker__input"
                  value={selectedModel}
                  onClick={() => openModelMenu(false)}
                  onChange={(event) => {
                    setSelectedModel(event.target.value);
                    setIsModelFiltering(true);
                    setHighlightedModelIndex(0);
                    if (availableModels.length) setModelMenuOpen(true);
                  }}
                  onKeyDown={handleModelKeyDown}
                  placeholder="选择或输入模型名称"
                  autoComplete="off"
                  role="combobox"
                  aria-expanded={modelMenuOpen}
                  aria-controls="remarks-available-models"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    modelMenuOpen && displayedModels[highlightedModelIndex]
                      ? `remarks-model-${highlightedModelIndex}`
                      : undefined
                  }
                  aria-describedby="organize-model-help"
                />
                <button
                  type="button"
                  className={`organize-model-picker__toggle ${modelMenuOpen ? "is-open" : ""}`}
                  onClick={() => {
                    if (modelMenuOpen) {
                      setModelMenuOpen(false);
                    } else {
                      openModelMenu(false);
                    }
                  }}
                  disabled={!availableModels.length}
                  aria-label={modelMenuOpen ? "收起模型列表" : "展开模型列表"}
                  tabIndex={-1}
                >
                  <ChevronDown />
                </button>

                {modelMenuOpen && (
                  <ul id="remarks-available-models" className="organize-model-picker__menu" role="listbox">
                    {displayedModels.length ? displayedModels.map((model, index) => {
                      const isSelected = model.id === selectedModel;
                      const isHighlighted = index === highlightedModelIndex;
                      return (
                        <li
                          id={`remarks-model-${index}`}
                          key={model.id}
                          className={`organize-model-picker__option${isSelected ? " is-selected" : ""}${isHighlighted ? " is-highlighted" : ""}`}
                          role="option"
                          aria-selected={isSelected}
                          onMouseEnter={() => setHighlightedModelIndex(index)}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            chooseModel(model.id);
                          }}
                        >
                          <span>{model.id}</span>
                          <Check />
                        </li>
                      );
                    }) : (
                      <li className="organize-model-picker__empty">
                        未找到匹配模型，可直接使用当前输入值
                      </li>
                    )}
                  </ul>
                )}
              </div>

              <p
                id="organize-model-help"
                className={modelListStatus === "error" ? "organize-model-picker__help is-error" : "organize-model-picker__help"}
              >
                {!settings.provider.apiKey ? (
                  <>
                    尚未配置 API Key，<Link to="/options">前往设置</Link>后可查询模型。
                  </>
                ) : modelListStatus === "loading" ? (
                  "正在从服务商查询可用模型…"
                ) : modelListStatus === "success" && availableModels.length ? (
                  `已查询到 ${availableModels.length} 个模型，也可以手动输入其他兼容模型。`
                ) : modelListError ? (
                  `${modelListError}；仍可手动输入模型名。`
                ) : (
                  "本次选择仅用于当前整理，不会修改设置页的默认模型。"
                )}
              </p>
            </section>

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
                <span>只审核有风险的变更</span>
              </div>
              <p>
                当前批准移动 {approvedPlans.length} 个，保持原位 {keptPlanCount} 个，另有 {pendingDecisionCount} 个需要决定。确认前不会修改任何书签。
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
              <div className="preview-risk-board">
                <div className="preview-risk-overview" aria-label="整理风险概览">
                  <div>
                    <span>自动接受</span>
                    <strong>{riskAnalysis.auto.length}</strong>
                  </div>
                  <div>
                    <span>批量确认</span>
                    <strong>{batchRiskCount}</strong>
                  </div>
                  <div>
                    <span>强制审核</span>
                    <strong>{riskAnalysis.review.length}</strong>
                  </div>
                  <div>
                    <span>保持原位</span>
                    <strong>{riskAnalysis.keep.length}</strong>
                  </div>
                </div>

                <section className="preview-risk-section preview-risk-section--auto">
                  <div className="preview-risk-section__header">
                    <div className="preview-risk-section__icon"><ShieldCheck /></div>
                    <div className="preview-risk-section__heading">
                      <strong>自动接受候选</strong>
                      <span>
                        {riskAnalysis.auto.length} 个高可信书签，将移动到 {
                          new Set(riskAnalysis.auto.map((item) => pathKey(item.plan.toFolderPath))).size
                        } 个现有文件夹
                      </span>
                    </div>
                    <button
                      type="button"
                      className="preview-risk-section__toggle"
                      onClick={() => toggleRiskGroup("__auto__")}
                      aria-expanded={expandedRiskGroups.has("__auto__")}
                    >
                      {expandedRiskGroups.has("__auto__")
                        ? "收起"
                        : riskAnalysis.auto.length > 0
                          ? `抽查 ${Math.min(5, riskAnalysis.auto.length)} 个`
                          : "展开"}
                      {expandedRiskGroups.has("__auto__") ? <ChevronDown /> : <ChevronRight />}
                    </button>
                  </div>
                  {expandedRiskGroups.has("__auto__") && (
                    riskAnalysis.auto.length > 0 ? (
                      <div className="preview-risk-list">
                        {riskAnalysis.auto.slice(0, 5).map((item) => renderRiskPlanItem(item))}
                      </div>
                    ) : (
                      <p className="preview-risk-section__empty">没有自动接受的候选项目</p>
                    )
                  )}
                </section>

                <section className="preview-risk-section preview-risk-section--batch">
                  <div className="preview-risk-section__header">
                    <div className="preview-risk-section__icon"><Layers3 /></div>
                    <div className="preview-risk-section__heading">
                      <strong>批量确认</strong>
                      <span>{batchRiskCount} 个中等风险书签，已按目标主题聚合</span>
                    </div>
                    <button
                      type="button"
                      className="preview-risk-section__toggle"
                      onClick={() => toggleRiskGroup("__batch__")}
                      aria-expanded={expandedRiskGroups.has("__batch__")}
                    >
                      {expandedRiskGroups.has("__batch__") ? "收起" : "展开"}
                      {expandedRiskGroups.has("__batch__") ? <ChevronDown /> : <ChevronRight />}
                    </button>
                  </div>
                  {expandedRiskGroups.has("__batch__") && (
                    riskAnalysis.batchGroups.length > 0 ? (
                      <div className="preview-batch-groups">
                        {riskAnalysis.batchGroups.map(renderBatchRiskGroup)}
                      </div>
                    ) : (
                      <p className="preview-risk-section__empty">没有需要批量确认的项目</p>
                    )
                  )}
                </section>

                <section className="preview-risk-section preview-risk-section--review">
                  <div className="preview-risk-section__header">
                    <div className="preview-risk-section__icon"><ShieldAlert /></div>
                    <div className="preview-risk-section__heading">
                      <strong>强制审核</strong>
                      <span>{riskAnalysis.review.length} 个高风险变更，必须逐项决定</span>
                    </div>
                    <div className="preview-risk-section__actions">
                      <button
                        type="button"
                        className="preview-risk-action preview-risk-action--primary"
                        onClick={() => setPlanDecision(forceReviewPlanIds, "move")}
                        disabled={forceReviewPlanIds.length === 0 || allForceReviewItemsApproved}
                        title="批准移动全部强制审核项，仍需最终确认"
                      >
                        {allForceReviewItemsApproved ? "已全部移动" : "全部移动"}
                      </button>
                      <button
                        type="button"
                        className="preview-risk-action preview-risk-action--ignore"
                        onClick={() => setPlanDecision(forceReviewPlanIds, "keep")}
                        disabled={forceReviewPlanIds.length === 0 || allForceReviewItemsIgnored}
                        title="将全部强制审核项设为保留原位"
                      >
                        {allForceReviewItemsIgnored ? "已全部忽略" : "忽略全部"}
                      </button>
                      <button
                        type="button"
                        className="preview-risk-section__toggle"
                        onClick={() => toggleRiskGroup("__review__")}
                        aria-expanded={expandedRiskGroups.has("__review__")}
                      >
                        {expandedRiskGroups.has("__review__") ? "收起" : "展开"}
                        {expandedRiskGroups.has("__review__") ? <ChevronDown /> : <ChevronRight />}
                      </button>
                    </div>
                  </div>
                  {expandedRiskGroups.has("__review__") && (
                    riskAnalysis.review.length > 0 ? (
                      <div className="preview-risk-list">
                        {riskAnalysis.review.map((item) => renderRiskPlanItem(item, { showDecision: true }))}
                      </div>
                    ) : (
                      <p className="preview-risk-section__empty">没有跨目录、新建一级目录或疑似重复的项目</p>
                    )
                  )}
                </section>

                <section className="preview-risk-section preview-risk-section--keep">
                  <div className="preview-risk-section__header">
                    <div className="preview-risk-section__icon"><PauseCircle /></div>
                    <div className="preview-risk-section__heading">
                      <strong>保持原位</strong>
                      <span>{riskAnalysis.keep.length} 个低可信或无需移动的书签，不会执行移动</span>
                    </div>
                    <button
                      type="button"
                      className="preview-risk-section__toggle"
                      onClick={() => toggleRiskGroup("__keep__")}
                      aria-expanded={expandedRiskGroups.has("__keep__")}
                    >
                      {expandedRiskGroups.has("__keep__")
                        ? "收起"
                        : riskAnalysis.keep.length > 0
                          ? `查看 ${Math.min(5, riskAnalysis.keep.length)} 个`
                          : "展开"}
                      {expandedRiskGroups.has("__keep__") ? <ChevronDown /> : <ChevronRight />}
                    </button>
                  </div>
                  {expandedRiskGroups.has("__keep__") && (
                    riskAnalysis.keep.length > 0 ? (
                      <div className="preview-risk-list">
                        {riskAnalysis.keep.slice(0, 5).map((item) => renderRiskPlanItem(item))}
                      </div>
                    ) : (
                      <p className="preview-risk-section__empty">没有保持原位的项目</p>
                    )
                  )}
                </section>
              </div>
            )}

            {!loading && plans.length > 0 && (
              <CollapsibleSection title="完整目标树" hint={`${plans.length} 个建议 / ${previewFolderCount} 个目标文件夹`}>
                <p className="preview-tree-help">需要微调时，可长按书签并拖到目标文件夹。</p>
                <div className="preview-tree-panel">
                  <div className="preview-tree">
                    {previewTree.children.map((folder) => renderPreviewTreeNode(folder))}
                  </div>
                </div>
              </CollapsibleSection>
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
              disabled={!approvedPlans.length || pendingDecisionCount > 0 || loading || savingPreviewDrop}
              className="extension-page__wide-primary"
            >
              <Check className="w-5 h-5" />
              {pendingDecisionCount > 0
                ? `先处理 ${pendingDecisionCount} 个风险项`
                : `确认移动 ${approvedPlans.length} 个书签`}
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
