import { PageHeading } from "./PageHeading";
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
  Folder,
  ExternalLink,
  Check,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Cpu,
  Globe2,
  RefreshCw,
  Zap,
} from "lucide-react";
import type {
  BookmarkNode,
  FixedDomainRule,
  PreviewPlanDecision,
  PreviewFrameworkDecision,
  FolderHabitProfile,
  MovePlan,
  OrganizeMode,
  PreviewTaskCache,
  PreviewTaskProgress,
  TokenUsage,
} from "../types";
import { executeMovePlans } from "../services/organizer";
import { useAppStore } from "../store/useAppStore";
import { STORAGE_KEYS, clearPreviewPlan, getFolderHabitProfile, getStoredFolderHabitProfile, getPreviewPlan, savePreviewPlan, getStorageValue, setStorageValue } from "../services/storage";
import { getPreviewTask, requestClearPreviewTask, resumePreviewTask, startPreviewTask } from "../services/previewTask";
import { ensureRequiredHostPermission } from "../services/hostPermissions";
import { getAllBookmarkFolders, getAllBookmarks, getBookmarkFaviconUrl, parseFolderPath } from "../services/bookmarks";
import { AI_PROVIDER_PROFILES, listAIModels, type AIModelOption } from "../services/aiProvider";
import { recordHabitFeedback } from "../services/habits";
import { appendFolderImpression } from "../services/semanticIndex";
import { CollapsibleSection } from "./CollapsibleSection";
import { PreviewDialog } from "./PreviewDialog";
import { filterAvailableBookmarks, getCurrentWhitelist, whitelistFingerprint } from "../services/whitelist";

import { getPlanChangeReason, getPlanSummary, parsePreviewReview } from "../services/previewSafety";
import { getFixedDomainRules } from "../services/fixedRules";
import { getPreferenceConflict, getPreferenceFingerprint } from "../services/preferenceSafety";
import { ReviewWorkbench } from "./ReviewWorkbench";
import { buildPreviewRiskAnalysis, derivePreviewReview, groupRiskItemsByTarget, pathKey } from "../services/previewReview";
import "../../styles/preview-review.css";
export { buildPreviewRiskAnalysis } from "../services/previewReview";

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
const STRONG_MODEL_SIGNAL = 0.9;
const WEAK_MODEL_SIGNAL = 0.7;

function ConfidenceSignal({ plan }: { plan: MovePlan }) {
  if (plan.source === "manual") {
    return (
      <span className="extension-confidence extension-confidence--signal text-blue-600 bg-blue-50">
        人工调整
      </span>
    );
  }

  const level = plan.confidence >= STRONG_MODEL_SIGNAL
    ? { label: "依据较充分", className: "text-green-600 bg-green-50" }
    : plan.confidence >= WEAK_MODEL_SIGNAL
      ? { label: "需要确认", className: "text-blue-600 bg-blue-50" }
      : { label: "依据不足", className: "text-amber-600 bg-amber-50" };
  const detail = `模型自评 ${plan.confidence.toFixed(2)}，仅作相对排序参考，不代表正确率`;

  return (
    <span
      className={`extension-confidence extension-confidence--signal ${level.className}`}
      title={detail}
      aria-label={`${detail}，信号${level.label}`}
    >
      {level.label}
    </span>
  );
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
      return "正在准备书签数据";
    case "requesting_ai":
      return "正在请求 AI";
    case "parsing_results":
      return "正在解析结果";
    case "generating_preview":
      return "正在整理分类结果";
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
  const [existingFolders, setExistingFolders] = useState<BookmarkNode[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<MovePlan | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const { loadAll, loadSettings, settings } = useAppStore();
  const [phase, setPhase] = useState<PreviewPhase>("selection");
  const [allBookmarks, setAllBookmarks] = useState<BookmarkNode[]>([]);
  const [folderHabitProfile, setFolderHabitProfile] = useState<FolderHabitProfile | null>(null);
  const [preferenceProfile, setPreferenceProfile] = useState<FolderHabitProfile | null>(null);
  const [fixedRules, setFixedRules] = useState<FixedDomainRule[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<MovePlan[]>([]);
  const [planDecisions, setPlanDecisions] = useState<Record<string, PreviewPlanDecision>>({});
  const [frameworkDecisions, setFrameworkDecisions] = useState<Record<string, PreviewFrameworkDecision>>({});
  const [treeQuery, setTreeQuery] = useState("");
  const [reviewLoaded, setReviewLoaded] = useState(false);
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
    const [bookmarks, habitProfile, protection, rules, storedProfile] = await Promise.all([
      getAllBookmarks(),
      getFolderHabitProfile(),
      getCurrentWhitelist(),
      getFixedDomainRules(),
      getStoredFolderHabitProfile(),
    ]);
    const urlBookmarks = filterAvailableBookmarks(bookmarks.filter((b) => b.url), protection.index);
    setExistingFolders(await getAllBookmarkFolders());
    setAllBookmarks(urlBookmarks);
    setFolderHabitProfile(habitProfile);
    setFixedRules(rules);
    setPreferenceProfile(storedProfile);
    setSelectedIds(new Set(urlBookmarks.map((b) => b.id)));
    return urlBookmarks;
  };

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local" || !(changes[STORAGE_KEYS.bookmarkWhitelist] || changes[STORAGE_KEYS.folderHabitProfile] || changes[STORAGE_KEYS.fixedDomainRules])) return;
      void loadSelectableBookmarks().then(() => {
        void getPreviewPlan().then((cache) => { if (cache) setPlans(cache.movePlan); });
        setCacheMessage("保护或分类偏好已更新：重新校验受影响项，其余审核进度保留。");
      }).catch((error) => setError(error instanceof Error ? error.message : "读取白名单失败"));
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.bookmarks) return;
    let alive = true;
    const refresh = async () => {
      try {
        const [bookmarks, folders] = await Promise.all([getAllBookmarks(), getAllBookmarkFolders()]);
        if (!alive) return;
        setAllBookmarks(bookmarks);
        setExistingFolders(folders);
        setPlans((previous) => previous.map((plan) => {
          const reason = getPlanChangeReason(plan, bookmarks.find((item) => item.id === plan.bookmarkId), folders, settings);
          return reason ? { ...plan, keepInPlace: true, reason } : plan;
        }));
        setCacheMessage("书签状态已更新；变化项保持原位，其他审核决定保留。可重新生成受影响项。");
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : "刷新书签失败"); }
    };
    chrome.bookmarks.onChanged.addListener(refresh);
    chrome.bookmarks.onMoved.addListener(refresh);
    chrome.bookmarks.onRemoved.addListener(refresh);
    return () => { alive = false; chrome.bookmarks.onChanged.removeListener(refresh); chrome.bookmarks.onMoved.removeListener(refresh); chrome.bookmarks.onRemoved.removeListener(refresh); };
  }, [settings]);

  const restoreCompletedTask = (task: PreviewTaskCache) => {
    if (!task.movePlan?.length) return false;

    setPlans(task.movePlan);
    setTokenUsage(task.tokenUsage);
    setOrganizeMode(task.organizeMode ?? "quick");
    if (task.model) setSelectedModel(task.model);
    setProcessingBookmarkCount(0);
    setTaskProgress(undefined);
    setCacheMessage(`已恢复 ${new Date(task.updatedAt).toLocaleString()} 生成的整理方案`);
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
    setCacheMessage(`正在生成 ${task.bookmarkCount} 个书签的整理方案，可收起后稍后返回`);
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
        const selectableBookmarks = await loadSelectableBookmarks();
        if (!alive) return;
        const task = await getPreviewTask();
        if (!alive) return;
        if (task?.status === "running") {
          keepLoading = true;
          restoreRunningTask(task);
          void resumePreviewTask(task, selectableBookmarks);
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
        if (cached?.movePlan.length && cached.whitelistFingerprint ===
            whitelistFingerprint((await getCurrentWhitelist()).entries)) {
          setPlans(cached.movePlan);
          setTokenUsage(cached.tokenUsage);
          setOrganizeMode(cached.organizeMode ?? "quick");
          if (cached.model) setSelectedModel(cached.model);
          setProcessingBookmarkCount(0);
          setCacheMessage(`已恢复 ${new Date(cached.createdAt).toLocaleString()} 生成的整理方案`);
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
  const deepSelectionLimitMessage = `“更细致地分析网页”单次最多建议选择 ${DEEP_ORGANIZE_BOOKMARK_LIMIT} 个书签。当前已选 ${selectedIds.size} 个，请减少选择或改用快速分类。`;

  const quickSelectionLargeMessage = `当前选择 ${selectedIds.size} 个书签，快速分类建议单次不超过 ${QUICK_ORGANIZE_BOOKMARK_RECOMMENDED_LIMIT} 个。数量较大时建议按文件夹分批整理，避免 AI 请求排队过久。`;

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
    if (!settings.provider.apiKey.trim() || !settings.provider.enabled) {
      setError("请先连接并授权 AI 服务；本地搜索和手动归档无需 AI");
      return;
    }
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
    if (settings.provider.apiKey && settings.provider.enabled) {
      try {
        await ensureRequiredHostPermission();
      } catch (error) {
        setError(error instanceof Error ? error.message : "无法取得网站访问权限");
        return;
      }
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
    setReviewLoaded(false);
    await setStorageValue(STORAGE_KEYS.previewReview, null);
    setExpandedPreviewFolders(new Set());
    setPlanDecisions({});
    setFrameworkDecisions({});
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

  useEffect(() => {
    if (phase !== "preview" || loading || reviewLoaded || !plans.length) return;
    let alive = true;
    void getStorageValue<unknown>(STORAGE_KEYS.previewReview, null).then((value) => {
      if (!alive) return;
      const saved = parsePreviewReview(value);
      if (saved) {
        const valid = plans.filter((plan) => saved.signatures[plan.bookmarkId] === JSON.stringify(plan) &&
          !(plan.preferenceFingerprint === undefined && getPreferenceConflict(plan, preferenceProfile, fixedRules)));
        setPlanDecisions((previous) => ({ ...previous, ...Object.fromEntries(valid.filter((plan) => saved.plans[plan.bookmarkId]).map((plan) => [plan.bookmarkId, saved.plans[plan.bookmarkId]])) }));
        const validIds = new Set(valid.map((plan) => plan.bookmarkId));
        const groups = buildPreviewRiskAnalysis(plans, allBookmarks, folderHabitProfile, fixedRules, preferenceProfile, existingFolders).frameworkGroups;
        setFrameworkDecisions(Object.fromEntries(groups
          .filter((group) => saved.frameworks[group.key] && group.items.every((item) => validIds.has(item.plan.bookmarkId)))
          .map((group) => [group.key, saved.frameworks[group.key]])));
      }
      setReviewLoaded(true);
    });
    return () => { alive = false; };
  }, [phase, loading, plans, reviewLoaded, allBookmarks, existingFolders, folderHabitProfile, preferenceProfile, fixedRules]);
  useEffect(() => {
    if (phase !== "preview" || loading || !plans.length) return;
    setPlans((previous) => {
      let changed = false;
      const next = previous.map((plan) => {
        const reason = getPlanChangeReason(plan, allBookmarks.find((bookmark) => bookmark.id === plan.bookmarkId), existingFolders, settings, preferenceProfile, fixedRules);
        if (!reason || (plan.keepInPlace && plan.reason === reason)) return plan;
        changed = true;
        return { ...plan, keepInPlace: true, reason };
      });
      return changed ? next : previous;
    });
  }, [phase, loading, allBookmarks, existingFolders, settings, plans, folderHabitProfile, preferenceProfile, fixedRules]);
  useEffect(() => {
    if (!reviewLoaded || phase !== "preview" || loading || savingPreviewDrop) return;
    void setStorageValue(STORAGE_KEYS.previewReview, { signatures: Object.fromEntries(plans.map((plan) => [plan.bookmarkId, JSON.stringify(plan)])), plans: planDecisions, frameworks: frameworkDecisions })
      .catch(() => setError("审核决定保存失败，关闭后可能需要重新审核"));
  }, [plans, planDecisions, frameworkDecisions, phase, loading, reviewLoaded, savingPreviewDrop]);
  const riskAnalysis = useMemo(
    () => buildPreviewRiskAnalysis(plans, allBookmarks, folderHabitProfile, fixedRules, preferenceProfile, existingFolders),
    [plans, allBookmarks, folderHabitProfile, fixedRules, preferenceProfile, existingFolders]
  );
  const review = useMemo(() => derivePreviewReview(riskAnalysis, planDecisions, frameworkDecisions), [riskAnalysis, planDecisions, frameworkDecisions]);
  const approvedPlans = review.approvedPlans;
  const assignmentGroups = groupRiskItemsByTarget([
    ...riskAnalysis.batchGroups.flatMap((group) => group.items),
    ...riskAnalysis.frameworkGroups.filter((group) => frameworkDecisions[group.key] === "approve")
      .flatMap((group) => group.items.filter((item) => item.level === "framework")),
  ]);
  const pendingDecisionCount = review.pending.length + review.pendingFrameworks.length;
  const summary = getPlanSummary(review.items.map((item) => item.plan), allBookmarks, existingFolders);
  const executionSummary = getPlanSummary(approvedPlans, allBookmarks, existingFolders);
  const previewTree = useMemo(() => buildMovePlanFolderTree(approvedPlans.filter((plan) =>
    [plan.bookmarkTitle, plan.bookmarkUrl, pathKey(plan.toFolderPath)].join(" ").toLocaleLowerCase().includes(treeQuery.trim().toLocaleLowerCase())
  )), [approvedPlans, treeQuery]);
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
    event: ReactPointerEvent<HTMLDivElement>,
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

  const handlePreviewRowPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
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
    const previousDecisions = planDecisions;
    const nextPlans = plans.map((plan) =>
      plan.bookmarkId === sourcePlan.bookmarkId
        ? {
            ...plan,
            toFolderPath: targetPath,
            expectedTargetId: existingFolders.find((folder) => JSON.stringify(folder.path) === JSON.stringify(targetPath))?.id ?? null,
            preferenceFingerprint: getPreferenceFingerprint({ ...plan, toFolderPath: targetPath, source: "manual",
              expectedTargetId: existingFolders.find((folder) => JSON.stringify(folder.path) === JSON.stringify(targetPath))?.id ?? null }, preferenceProfile, fixedRules),
            confidence: 1,
            reason: `人工修改目标目录：${targetPath.join(" / ")}`,
            source: "manual" as const,
            keepInPlace: false,
          }
        : plan
    );

    setPlans(nextPlans);
    setPlanDecisions((previous) => {
      const next = { ...previous };
      delete next[sourcePlan.bookmarkId];
      return next;
    });
    setSavingPreviewDrop(true);
    setExpandedPreviewFolders((prev) => {
      const next = new Set(prev);
      targetPath.forEach((_, index) => {
        next.add(targetPath.slice(0, index + 1).join("/"));
      });
      return next;
    });
    setCacheMessage("已更新整理方案，正在保存调整...");

    try {
      const fingerprint = whitelistFingerprint((await getCurrentWhitelist()).entries);
      await Promise.all([
        requestClearPreviewTask(),
        savePreviewPlan({
          id: `preview-drag-${Date.now()}`,
          createdAt: Date.now(),
          bookmarkCount: nextPlans.length,
          whitelistFingerprint: fingerprint,
          organizeMode,
          movePlan: nextPlans,
          tokenUsage,
        }),
      ]);

      const [learningNotice] = await Promise.all([
        recordHabitFeedback({
          type: "category_override",
          bookmarkTitle: sourcePlan.bookmarkTitle,
          bookmarkUrl: sourcePlan.bookmarkUrl,
          suggestedFolderPath: sourcePlan.toFolderPath,
          chosenFolderPath: targetPath,
        }).catch(() => null),
        appendFolderImpression(sourcePlan.bookmarkUrl, targetPath).catch(() => undefined),
      ]);
      setCacheMessage(learningNotice ?? "目标已更新，请重新确认该条建议；书签尚未移动");
      return true;
    } catch (err) {
      setPlans(previousPlans);
      setPlanDecisions(previousDecisions);
      setCacheMessage("");
      setError(err instanceof Error ? err.message : "保存手动调整失败");
      return false;
    } finally {
      setSavingPreviewDrop(false);
    }
  };

  const handlePreviewRowPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
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
    if (!reviewLoaded || savingPreviewDrop || phase === "submitting") return;
    if (pendingDecisionCount > 0) {
      setError(`还有 ${pendingDecisionCount} 个审核决定需要完成`);
      return;
    }
    if (!approvedPlans.length) {
      setError("当前没有已批准移动的书签");
      return;
    }
    setPhase("submitting");
    try {
      await executeMovePlans(review.items.map(({ plan }) => ({ ...plan, keepInPlace: review.effective[plan.bookmarkId] !== "move",
        preferenceFingerprint: plan.preferenceFingerprint ?? getPreferenceFingerprint(plan, preferenceProfile, fixedRules) })), tokenUsage);
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
    <div role="button" tabIndex={0}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEditingPlan(plan); setFolderDraft(pathKey(plan.toFolderPath)); } }}
      key={plan.bookmarkId}
      className={`preview-tree-row preview-tree-row--bookmark ${
        selectedPlan === plan.bookmarkId ? "is-selected" : ""
      } ${draggedPlan?.bookmarkId === plan.bookmarkId ? "is-dragging" : ""}`}
      style={{ "--tree-depth": depth } as CSSProperties}
      aria-label={`修改 ${plan.bookmarkTitle} 的目标目录，也可长按拖动`}
      onPointerDown={(event) => handlePreviewRowPointerDown(event, plan)}
      onPointerMove={handlePreviewRowPointerMove}
      onPointerUp={handlePreviewRowPointerUp}
      onPointerCancel={resetPreviewDrag}
      onClick={() => {
        if (suppressNextPreviewClickRef.current) return;
        setSelectedPlan(plan.bookmarkId);
        setEditingPlan(plan); setFolderDraft(pathKey(plan.toFolderPath));
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
      <ConfidenceSignal plan={plan} />
    </div>
  );

  const setPlanDecision = (bookmarkIds: string[], decision: PreviewPlanDecision) => {
    if (decision === "move") setPlans((previous) => previous.map((plan) => bookmarkIds.includes(plan.bookmarkId) && plan.preferenceFingerprint === undefined
      ? { ...plan, preferenceFingerprint: getPreferenceFingerprint(plan, preferenceProfile, fixedRules) } : plan));
    setPlanDecisions((previous) => {
      const next = { ...previous };
      for (const bookmarkId of bookmarkIds) next[bookmarkId] = decision;
      return next;
    });
    setError("");
  };

  const setFrameworkDecision = (
    group: (typeof riskAnalysis.frameworkGroups)[number],
    decision: PreviewFrameworkDecision
  ) => {
    setFrameworkDecisions((previous) => ({ ...previous, [group.key]: decision }));
    setPlanDecisions((previous) => {
      const next = { ...previous };
      for (const item of group.items) {
        if (decision === "keep") next[item.plan.bookmarkId] = "keep";
        else delete next[item.plan.bookmarkId];
      }
      return next;
    });
    setError("");
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === allBookmarks.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allBookmarks.map((b) => b.id)));
    }
  };

  const isReviewComplete = pendingDecisionCount === 0;
  const pageTitle = phase === "selection"
    ? "选择书签"
    : loading
      ? "正在生成整理方案"
      : plans.length === 0
        ? "整理方案"
        : "审核整理方案";
  const pageSubtitle = phase === "selection"
    ? `已选 ${selectedIds.size}/${allBookmarks.length} 个书签`
    : loading
      ? "生成建议不会移动书签"
      : plans.length === 0
        ? "可返回上一步重新选择书签"
        : !isReviewComplete
          ? `${review.pending.length} 条书签待决定${review.pendingFrameworks.length ? `，${review.pendingFrameworks.length} 个目录待确认` : ""}`
          : approvedPlans.length > 0
            ? `已批准移动 ${approvedPlans.length} 个书签`
            : "所有书签保持原位";

  return (
    <div className={`extension-page extension-page--preview${phase === "preview" && !loading && plans.length ? " review-page" : ""}`}>
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <PageHeading title={pageTitle} subtitle={pageSubtitle} />
          <p className="sr-only" role="status">{pageTitle}。{pageSubtitle}</p>

        </div>

        {error && (
          <div className="extension-notice extension-notice--amber" role="alert">
            <p>{error}</p>
          </div>
        )}

        {cacheMessage && phase !== "preview" && (
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
                  <strong>快速分类</strong>
                  <small>更快生成分类建议，较少等待网页信息</small>
                </span>
              </button>
              <button
                type="button"
                className={`organize-mode-picker__button ${organizeMode === "deep" ? "is-active" : ""}`}
                onClick={() => setOrganizeMode("deep")}
              >
                <Globe2 className="w-4 h-4" />
                <span>
                  <strong>更细致地分析网页</strong>
                  <small>多等一会，尝试获取更多网页信息后再分类</small>
                </span>
              </button>
            </div>

            {(!settings.provider.apiKey.trim() || !settings.provider.enabled) && <div className="extension-notice extension-notice--blue">
              <p>{settings.provider.apiKey.trim() ? "尚未授权向 AI 发送分类数据。" : "尚未连接 AI 服务。"} <Link to="/options">连接与授权</Link>，或 <Link to="/manage?task=unsorted">先使用本地归档</Link>。</p>
            </div>}
            <CollapsibleSection title="AI 服务与模型（可选）" hint={selectedModel || settings.provider.model}>
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
            </CollapsibleSection>

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
              disabled={selectedIds.size === 0 || isDeepSelectionTooLarge || !settings.provider.apiKey.trim() || !settings.provider.enabled}
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
            {loading ? (
              <div className="extension-empty extension-empty--progress">
                <p>{progressPhaseLabel}</p>
                <span>{organizeMode === "deep" ? "正在尝试获取更多网页信息，再生成分类建议..." : "AI 正在分析书签内容..."}</span>
                <span>{remainingTimeText}</span>
                <span>{progressBatchText}</span>
                <span>{progressBookmarkText}</span>
                <div className="preview-task-progress" aria-label="整理方案生成进度">
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
              <ReviewWorkbench
                analysis={riskAnalysis} review={review} groups={assignmentGroups}
                frameworks={frameworkDecisions}
                busy={savingPreviewDrop || !reviewLoaded} cacheMessage={cacheMessage}
                summary={summary} tree={previewTree.children.map((folder) => renderPreviewTreeNode(folder))}
                treeQuery={treeQuery} onTreeQuery={setTreeQuery} folderCount={previewFolderCount}
                tokenUsage={tokenUsage} model={selectedModel} unclassifiedHandling={settings.unclassifiedHandling}
                onDecision={setPlanDecision} onFramework={setFrameworkDecision}
                onEdit={(plan) => { setEditingPlan(plan); setFolderDraft(pathKey(plan.toFolderPath)); }}
                onRegenerate={() => void handleRegenerate()} onConfirm={() => setConfirmOpen(true)}
                onKeepRemaining={() => {
                  setFrameworkDecisions((previous) => ({ ...previous, ...Object.fromEntries(review.pendingFrameworks.map((group) => [group.key, "keep"])) }));
                  setPlanDecisions((previous) => ({ ...previous, ...Object.fromEntries(review.pending.map((item) => [item.plan.bookmarkId, "keep"])) }));
                }}
              />
            )}
          </>
        )}

        {confirmOpen && <PreviewDialog
          label="最终执行确认"
          title="确认本次变更"
          description="确认变更范围后，先创建备份，再执行移动。可返回审核。"
          busy={phase === "submitting" || savingPreviewDrop}
          onClose={() => setConfirmOpen(false)}
          actions={<>
            <button type="button" data-dialog-return className="extension-page__wide-secondary" onClick={() => setConfirmOpen(false)}>返回审核</button>
            <button type="button" className="extension-page__wide-primary" disabled={phase === "submitting" || savingPreviewDrop || pendingDecisionCount > 0 || !approvedPlans.length} onClick={() => void handleConfirm()}>{phase === "submitting" ? "正在备份并移动…" : `确认移动 ${executionSummary.moveCount} 个书签`}</button>
          </>}
        >
          <dl className="preview-dialog__metrics">
            <div><dt>移动</dt><dd>{executionSummary.moveCount} 条</dd></div>
            <div><dt>新建目录</dt><dd>{executionSummary.newFolders.length} 个</dd></div>
            <div><dt>复用目录</dt><dd>{executionSummary.reusedCount} 个</dd></div>
            <div><dt>保持原位</dt><dd>{review.keepCount} 条</dd></div>
            <div><dt>跨一级目录</dt><dd>{executionSummary.crossTopLevelCount} 条</dd></div>
          </dl>
          <p className="preview-dialog__note">先创建完整本地备份，备份失败则停止。可将最近一次整理移回原目录，但不恢复原排序。会清理本次移动后变空的源目录、空祖先及新建空目录；外部变化项会停止移动并写入失败原因。</p>
        </PreviewDialog>}
        {editingPlan && <PreviewDialog
          label="修改目标目录"
          title="修改目录"
          description="搜索已有目录或输入新路径，仅修改整理方案，不移动书签。"
          busy={savingPreviewDrop}
          onClose={() => setEditingPlan(null)}
          actions={<>
            <button type="button" data-dialog-return className="extension-page__wide-secondary" disabled={savingPreviewDrop} onClick={() => setEditingPlan(null)}>取消</button>
            <button type="button" className="extension-page__wide-primary" disabled={savingPreviewDrop || !folderDraft.trim()} onClick={() => {
              const path = parseFolderPath(folderDraft, settings.maxNestingLevel);
              if (!path.length) { setError("请填写有效目录"); return; }
              void applyPreviewDrop(editingPlan, { path, key: path.join("/") } as PreviewFolderNode).then((saved) => { if (saved) setEditingPlan(null); });
            }}>确认修改</button>
          </>}
        >
          <div className="preview-dialog__bookmark">
            <BookmarkFavicon title={editingPlan.bookmarkTitle} url={editingPlan.bookmarkUrl} className="preview-dialog__favicon" />
            <div>
              <strong title={editingPlan.bookmarkTitle}>{editingPlan.bookmarkTitle}</strong>
              <span title={editingPlan.bookmarkUrl}>{editingPlan.bookmarkUrl}</span>
            </div>
          </div>
          <label className="preview-dialog__field">
            <span>目标目录</span>
            <input className="extension-control" list="preview-folder-choices" value={folderDraft} onChange={(event) => setFolderDraft(event.target.value)} placeholder="例如：开发 / 文档" />
          </label>
          <datalist id="preview-folder-choices">{existingFolders.map((folder) => <option key={folder.id} value={folder.path.join(" / ")} />)}</datalist>
          <p className="preview-dialog__note">不存在的目录会在最终确认后创建。</p>
        </PreviewDialog>}
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
