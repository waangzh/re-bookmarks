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
} from "lucide-react";
import type { BookmarkNode } from "../types";
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
import { useAppStore } from "../store/useAppStore";

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

function BookmarkFavicon({ title, url }: { title: string; url?: string }) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = url && !failed ? getBookmarkFaviconUrl(url) : "";

  if (!faviconUrl) {
    return <Bookmark className="bookmark-tree-row__bookmark-icon" />;
  }

  return (
    <img
      src={faviconUrl}
      alt=""
      title={title}
      className="bookmark-tree-row__favicon"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export function ManageBookmarks() {
  const { bookmarks, loadBookmarks, settings } = useAppStore();
  const [searchParams] = useSearchParams();
  const [folders, setFolders] = useState<BookmarkNode[]>([]);
  const [searchQuery, setSearchQuery] = useState(() => {
    const value = searchParams.get("search") ?? "";
    return value === "1" || value === "duplicate" ? "" : value;
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
  const [draggedBookmark, setDraggedBookmark] = useState<BookmarkNode | null>(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const folderLookupRef = useRef<Map<string, BookmarkFolderNode>>(new Map());
  const activeDropFolderRef = useRef<BookmarkFolderNode | null>(null);
  const suppressNextFolderClickRef = useRef(false);
  const hoverExpandTimerRef = useRef<number | null>(null);
  const hoverExpandFolderKeyRef = useRef<string | null>(null);

  const loadManagedBookmarks = useCallback(async () => {
    const [, nextFolders] = await Promise.all([loadBookmarks(), getAllBookmarkFolders()]);
    setFolders(nextFolders);
  }, [loadBookmarks]);

  useEffect(() => {
    void loadManagedBookmarks();
  }, [loadManagedBookmarks]);

  const duplicateMode = searchParams.get("search") === "duplicate" && !searchQuery;

  const duplicateUrls = useMemo(() => {
    const counts = new Map<string, number>();
    const normalize = (url: string) => {
      try {
        const parsed = new URL(url);
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return url;
      }
    };

    bookmarks.forEach((bookmark) => {
      if (!bookmark.url) return;
      const key = normalize(bookmark.url);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });

    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([url]) => url));
  }, [bookmarks]);

  const filteredBookmarks = useMemo(() => {
    const normalize = (url: string) => {
      try {
        const parsed = new URL(url);
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return url;
      }
    };

    if (duplicateMode) {
      return bookmarks.filter((bookmark) => bookmark.url && duplicateUrls.has(normalize(bookmark.url)));
    }

    const query = searchQuery.toLowerCase();
    return bookmarks.filter(
      (bookmark) =>
        bookmark.title.toLowerCase().includes(query) ||
        bookmark.url?.toLowerCase().includes(query)
    );
  }, [bookmarks, duplicateMode, duplicateUrls, searchQuery]);

  const folderTree = useMemo(() => buildBookmarkFolderTree(filteredBookmarks, folders), [filteredBookmarks, folders]);
  const folderLookup = useMemo(() => collectFolderLookup(folderTree), [folderTree]);

  useEffect(() => {
    folderLookupRef.current = folderLookup;
  }, [folderLookup]);

  const visibleExpandedFolders = useMemo(() => {
    if (!searchQuery) return expandedFolders;

    const keys = new Set<string>();
    const collect = (node: BookmarkFolderNode) => {
      keys.add(node.key);
      node.children.forEach(collect);
    };
    collect(folderTree);
    return keys;
  }, [expandedFolders, folderTree, searchQuery]);

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

  const handleDelete = async (id: string) => {
    if (!confirm("确认删除此书签？")) return;
    setBusy(true);
    setMessage("");
    try {
      await removeBookmark(id);
      await loadManagedBookmarks();
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

  return (
    <div className="extension-page">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">管理书签</h1>
              <p className="extension-page__subtitle">{bookmarks.length} 个本地书签</p>
            </div>
          </div>
          <button onClick={() => setShowAddForm(true)} className="extension-page__primary-button">
            <Plus className="w-4 h-4" />
            添加书签
          </button>
        </div>

        {message && (
          <div className="extension-notice extension-notice--amber">
            <p>{message}</p>
          </div>
        )}

        <div className="extension-search-field manage-bookmarks-search">
          <Search className="extension-search-field__icon" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索书签..."
            className="extension-control extension-control--search"
          />
        </div>

        <section className="bookmark-tree-panel">
          <div className="bookmark-tree-panel__head">
            <h3>文件夹</h3>
            <span>{bookmarks.length}</span>
          </div>
          <div className="bookmark-tree">{renderFolderNode(folderTree)}</div>
        </section>

        {showAddForm && (
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

        {filteredBookmarks.length === 0 && (
          <div className="extension-empty extension-empty--compact">
            {searchQuery ? "未找到匹配的书签" : "暂无书签"}
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
