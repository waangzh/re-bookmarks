import type { BookmarkNode } from "../types";

function hasChromeBookmarks() {
  return typeof chrome !== "undefined" && Boolean(chrome.bookmarks);
}

function bookmarkPath(path: string[], title?: string) {
  return title ? [...path, title] : path;
}

const ROOT_FOLDER_IDS = new Set(["0", "1", "2", "3"]);

export function isRootFolder(id: string): boolean {
  return ROOT_FOLDER_IDS.has(id);
}

export function flattenBookmarkTree(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  path: string[] = []
): BookmarkNode[] {
  return nodes.flatMap((node) => {
    const isRoot = isRootFolder(node.id);
    const currentPath = isRoot || node.url ? path : bookmarkPath(path, node.title);

    if (node.url) {
      return [
        {
          id: node.id,
          parentId: node.parentId,
          title: node.title,
          url: node.url,
          index: node.index,
          path,
          type: "url" as const,
        },
      ];
    }

    const folder: BookmarkNode | null = isRoot
      ? null
      : {
          id: node.id,
          parentId: node.parentId,
          title: node.title,
          index: node.index,
          path: currentPath,
          type: "folder" as const,
        };
    const children = flattenBookmarkTree(node.children ?? [], currentPath);
    return folder ? [folder, ...children] : children;
  });
}

export function getUrlBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[]) {
  return flattenBookmarkTree(nodes).filter((bookmark) => bookmark.type === "url" && bookmark.url);
}

export async function getBookmarkTree(): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  if (!hasChromeBookmarks()) return [];

  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree((tree) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tree);
    });
  });
}

export async function getAllBookmarks(): Promise<BookmarkNode[]> {
  const tree = await getBookmarkTree();
  return getUrlBookmarks(tree);
}

export async function getBookmark(id: string): Promise<chrome.bookmarks.BookmarkTreeNode | null> {
  if (!hasChromeBookmarks()) return null;

  return new Promise((resolve) => {
    chrome.bookmarks.get(id, (nodes) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(nodes[0] ?? null);
    });
  });
}

export function normalizeFolderPath(path: string[], maxDepth = 2): string[] {
  return path.map((part) => part.trim()).filter(Boolean).slice(0, Math.max(1, maxDepth));
}

export function parseFolderPath(path: string, maxDepth = 2): string[] {
  return normalizeFolderPath(path.split("/").flatMap((part) => part.split(" / ")), maxDepth);
}

async function createBookmarkNode(createDetails: chrome.bookmarks.BookmarkCreateArg) {
  return new Promise<chrome.bookmarks.BookmarkTreeNode>((resolve, reject) => {
    chrome.bookmarks.create(createDetails, (node) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(node);
    });
  });
}

function findFolderInChildren(
  children: chrome.bookmarks.BookmarkTreeNode[] | undefined,
  title: string
) {
  return children?.find((child) => !child.url && child.title === title) ?? null;
}

function defaultParentId(tree: chrome.bookmarks.BookmarkTreeNode[]) {
  return tree[0]?.children?.[0]?.id ?? "1";
}

export async function ensureFolderPath(path: string[], maxDepth = 2): Promise<string> {
  if (!hasChromeBookmarks()) return "";

  let safePath = normalizeFolderPath(path, maxDepth);
  let tree = await getBookmarkTree();
  const rootChildren = tree[0]?.children ?? [];
  const rootFolder = rootChildren.find((child) => !child.url && child.title === safePath[0]);
  let parentId = rootFolder?.id ?? defaultParentId(tree);
  let siblings = rootFolder?.children ?? rootChildren.find((child) => child.id === parentId)?.children;

  if (rootFolder) safePath = safePath.slice(1);
  if (!safePath.length) return parentId;

  for (const folderName of safePath) {
    const existing = findFolderInChildren(siblings, folderName);
    if (existing) {
      parentId = existing.id;
      siblings = existing.children;
      continue;
    }

    const created = await createBookmarkNode({ parentId, title: folderName });
    parentId = created.id;
    tree = await getBookmarkTree();
    siblings = flattenBookmarkFolders(tree).find((folder) => folder.id === parentId)?.children;
  }

  return parentId;
}

function flattenBookmarkFolders(nodes: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.url) return [];
    return [node, ...flattenBookmarkFolders(node.children ?? [])];
  });
}

export async function createBookmark(title: string, url: string, folderPath: string[]) {
  const parentId = await ensureFolderPath(folderPath);
  return createBookmarkNode({ parentId, title, url });
}

export async function updateBookmark(id: string, title: string, url: string) {
  if (!hasChromeBookmarks()) return null;

  return new Promise<chrome.bookmarks.BookmarkTreeNode>((resolve, reject) => {
    chrome.bookmarks.update(id, { title, url }, (node) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(node);
    });
  });
}

export async function moveBookmark(id: string, parentId: string, index?: number) {
  if (!hasChromeBookmarks()) return null;

  return new Promise<chrome.bookmarks.BookmarkTreeNode>((resolve, reject) => {
    chrome.bookmarks.move(id, { parentId, index }, (node) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(node);
    });
  });
}

export async function removeBookmark(id: string) {
  if (!hasChromeBookmarks()) return;

  return new Promise<void>((resolve, reject) => {
    chrome.bookmarks.remove(id, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function removeFolder(id: string): Promise<void> {
  if (!hasChromeBookmarks()) return;

  return new Promise<void>((resolve, reject) => {
    chrome.bookmarks.removeTree(id, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function getFolderChildren(id: string): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  if (!hasChromeBookmarks()) return [];

  return new Promise((resolve) => {
    chrome.bookmarks.getChildren(id, (children) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(children);
    });
  });
}

export async function isFolderEmpty(id: string): Promise<boolean> {
  const children = await getFolderChildren(id);
  return children.length === 0;
}
