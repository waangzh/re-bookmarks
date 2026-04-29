import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router";
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
  moveBookmark,
  parseFolderPath,
  removeBookmark,
  updateBookmark,
} from "../services/bookmarks";
import { useAppStore } from "../store/useAppStore";

type BookmarkFolderNode = {
  key: string;
  title: string;
  path: string[];
  count: number;
  children: BookmarkFolderNode[];
  bookmarks: BookmarkNode[];
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

export function ManageBookmarks() {
  const { bookmarks, loadBookmarks, settings } = useAppStore();
  const [searchQuery, setSearchQuery] = useState("");
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

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  const filteredBookmarks = useMemo(
    () =>
      bookmarks.filter(
        (bookmark) =>
          bookmark.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          bookmark.url?.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [bookmarks, searchQuery]
  );

  const folderTree = useMemo(() => buildBookmarkFolderTree(filteredBookmarks), [filteredBookmarks]);

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

  const toggleFolder = (folder: BookmarkFolderNode) => {
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
      await loadBookmarks();
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
      await loadBookmarks();
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

    return (
      <div key={folder.key}>
        <button
          type="button"
          className={`bookmark-tree-row bookmark-tree-row--folder ${isSelected ? "is-selected" : ""}`}
          style={{ "--tree-depth": depth } as CSSProperties}
          aria-expanded={isExpanded}
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
      className="bookmark-tree-row bookmark-tree-row--bookmark"
      style={{ "--tree-depth": depth } as CSSProperties}
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
          <Bookmark className="bookmark-tree-row__bookmark-icon" />
          <span className="bookmark-tree-row__title" title={bookmark.title}>{bookmark.title}</span>
          {bookmark.url && (
            <a href={bookmark.url} target="_blank" rel="noopener noreferrer" className="extension-link-icon">
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
      await loadBookmarks();
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
      </div>
    </div>
  );
}
