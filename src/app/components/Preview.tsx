import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
} from "lucide-react";
import type { BookmarkNode, MovePlan, TokenUsage } from "../types";
import { executeMovePlans, generateMovePlanPreviewForBookmarks } from "../services/organizer";
import { useAppStore } from "../store/useAppStore";
import { clearPreviewPlan, getPreviewPlan, savePreviewPlan } from "../services/storage";
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

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cacheMessage, setCacheMessage] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [expandedSelectionFolders, setExpandedSelectionFolders] = useState<Set<string>>(
    () => new Set(["__root__"])
  );

  const loadSelectableBookmarks = async () => {
    const bookmarks = await getAllBookmarks();
    const urlBookmarks = bookmarks.filter((b) => b.url);
    setAllBookmarks(urlBookmarks);
    setSelectedIds(new Set(urlBookmarks.map((b) => b.id)));
  };

  // 加载所有书签
  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        // 先检查是否有缓存的预览
        const cached = await getPreviewPlan();
        if (cached?.movePlan.length) {
          setPlans(cached.movePlan);
          setTokenUsage(cached.tokenUsage);
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
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  const selectionTree = useMemo(() => buildBookmarkFolderTree(allBookmarks), [allBookmarks]);

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
    setPhase("preview");
    setLoading(true);
    setError("");
    setTokenUsage(undefined);

    try {
      const bookmarksToClassify = allBookmarks.filter((b) => selectedIds.has(b.id));
      const previewResult = await generateMovePlanPreviewForBookmarks(bookmarksToClassify);
      const movePlans = previewResult.movePlans;
      setPlans(movePlans);
      setTokenUsage(previewResult.tokenUsage);
      await savePreviewPlan({
        id: `preview-${Date.now()}`,
        createdAt: Date.now(),
        bookmarkCount: movePlans.length,
        movePlan: movePlans,
        tokenUsage: previewResult.tokenUsage,
      });
      setCacheMessage("预览结果已保存，返回后可继续查看");
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成分类失败");
      setPhase("selection");
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerate = async () => {
    setCollapsedFolders(new Set());
    setSelectedPlan(null);
    setCacheMessage("");
    setTokenUsage(undefined);
    setLoading(true);
    setError("");
    try {
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

  const handleConfirm = async () => {
    if (!plans.length) return;
    setPhase("submitting");
    try {
      await executeMovePlans(plans, tokenUsage);
      await clearPreviewPlan();
      await loadAll();
      navigate("/report");
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行整理失败");
      setPhase("preview");
    }
  };

  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders((prev) => {
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
    const isCollapsed = collapsedFolders.has(folder.key);
    const hasChildren = folder.children.length > 0 || folder.plans.length > 0;
    const folderPath = folder.path.join(" / ");

    return (
      <div key={folder.key} className="preview-tree-node">
        <button
          type="button"
          className="preview-tree-row preview-tree-row--folder"
          style={{ "--tree-depth": depth } as CSSProperties}
          aria-expanded={!isCollapsed}
          onClick={() => toggleFolder(folder.key)}
        >
          <span className="preview-tree-row__expand">
            {hasChildren ? (
              isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />
            ) : null}
          </span>
          <Folder className="preview-tree-row__folder-icon" />
          <span className="preview-tree-row__title" title={folderPath}>{folder.title}</span>
          <span className="preview-tree-row__count">{folder.count} 个</span>
        </button>

        {!isCollapsed && (
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
      }`}
      style={{ "--tree-depth": depth } as CSSProperties}
      onClick={() => setSelectedPlan(plan.bookmarkId)}
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
              disabled={!plans.length}
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

            <section className="selection-tree-panel">
              <div className="selection-tree">
                {renderSelectionTreeNode(selectionTree)}
              </div>
            </section>

            <button
              onClick={handleStartClassify}
              disabled={selectedIds.size === 0}
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
                将移动 {plans.length} 个书签到 {previewFolderCount} 个文件夹。确认前不会修改任何书签。
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
              <div className="extension-empty">
                <p>正在生成分类建议</p>
                <span>AI 正在分析书签内容...</span>
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
              disabled={!plans.length || loading}
              className="extension-page__wide-primary"
            >
              <Check className="w-5 h-5" />
              确认整理 {plans.length} 个书签
            </button>
          </>
        )}
      </div>
    </div>
  );
}
