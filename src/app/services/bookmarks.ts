import type { BookmarkNode } from "../types";

export type BrowserBookmarkNode = chrome.bookmarks.BookmarkTreeNode & {
  type?: "bookmark" | "folder" | "separator";
  unmodifiable?: string;
};

function hasChromeBookmarks() {
  return typeof chrome !== "undefined" && Boolean(chrome.bookmarks);
}

function bookmarkPath(path: string[], title?: string) {
  return title ? [...path, title] : path;
}

let knownRootFolderIds = new Set<string>();

export function isSeparatorNode(node: BrowserBookmarkNode): boolean {
  return node.type === "separator";
}

export function isBookmarkFolder(node: BrowserBookmarkNode): boolean {
  return !node.url && !isSeparatorNode(node);
}

export function getBookmarkRootFolderIds(tree: BrowserBookmarkNode[]): Set<string> {
  const root = tree[0];
  if (!root) return new Set();

  return new Set([
    root.id,
    ...(root.children ?? [])
      .filter((node): node is BrowserBookmarkNode => isBookmarkFolder(node as BrowserBookmarkNode))
      .map((node) => node.id),
  ]);
}

function rememberRootFolderIds(tree: BrowserBookmarkNode[]) {
  knownRootFolderIds = getBookmarkRootFolderIds(tree);
}

export function isRootFolder(id: string, rootFolderIds = knownRootFolderIds): boolean {
  return rootFolderIds.has(id);
}

export function getDefaultBookmarkParentIdFromTree(tree: BrowserBookmarkNode[]): string | null {
  return tree[0]?.children?.find((node) => (
    isBookmarkFolder(node as BrowserBookmarkNode) && !(node as BrowserBookmarkNode).unmodifiable
  ))?.id ?? null;
}

export function flattenBookmarkTree(
  nodes: BrowserBookmarkNode[],
  path: string[] = [],
  rootFolderIds = getBookmarkRootFolderIds(nodes)
): BookmarkNode[] {
  return nodes.flatMap((node) => {
    if (isSeparatorNode(node)) return [];

    const isRoot = isRootFolder(node.id, rootFolderIds);
    const currentPath = isRoot || node.url ? path : bookmarkPath(path, node.title);

    if (node.url) {
      return [
        {
          id: node.id,
          parentId: node.parentId,
          title: node.title,
          url: node.url,
          index: node.index,
          dateAdded: node.dateAdded,
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
    const children = flattenBookmarkTree(node.children ?? [], currentPath, rootFolderIds);
    return folder ? [folder, ...children] : children;
  });
}

export function getUrlBookmarks(nodes: BrowserBookmarkNode[]) {
  return flattenBookmarkTree(nodes).filter((bookmark) => bookmark.type === "url" && bookmark.url);
}

export async function getBookmarkTree(): Promise<BrowserBookmarkNode[]> {
  if (!hasChromeBookmarks()) return [];

  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree((tree) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const typedTree = tree as BrowserBookmarkNode[];
      rememberRootFolderIds(typedTree);
      resolve(typedTree);
    });
  });
}

export async function getAllBookmarks(): Promise<BookmarkNode[]> {
  const tree = await getBookmarkTree();
  return getUrlBookmarks(tree);
}

function flattenBookmarkFolderNodes(
  nodes: BrowserBookmarkNode[],
  path: string[] = [],
  rootFolderIds = getBookmarkRootFolderIds(nodes)
): BookmarkNode[] {
  return nodes.flatMap((node) => {
    if (!isBookmarkFolder(node)) return [];

    const isBrowserRoot = isRootFolder(node.id, rootFolderIds);
    const currentPath = isBrowserRoot ? path : bookmarkPath(path, node.title);
    const folder: BookmarkNode | null = isBrowserRoot
      ? null
      : {
          id: node.id,
          parentId: node.parentId,
          title: node.title,
          index: node.index,
          path: currentPath,
          type: "folder" as const,
        };
    const children = flattenBookmarkFolderNodes(node.children ?? [], currentPath, rootFolderIds);
    return folder ? [folder, ...children] : children;
  });
}

export async function getAllBookmarkFolders(): Promise<BookmarkNode[]> {
  const tree = await getBookmarkTree();
  return flattenBookmarkFolderNodes(tree);
}

export function getBookmarkFaviconUrl(url: string, size = 32): string {
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime?.getURL ||
    /firefox/i.test(globalThis.navigator?.userAgent ?? "")
  ) return "";

  const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
  faviconUrl.searchParams.set("pageUrl", url);
  faviconUrl.searchParams.set("size", String(size));
  return faviconUrl.toString();
}

export async function getBookmark(id: string): Promise<BrowserBookmarkNode | null> {
  if (!hasChromeBookmarks()) return null;

  return new Promise((resolve) => {
    chrome.bookmarks.get(id, (nodes) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve((nodes[0] as BrowserBookmarkNode | undefined) ?? null);
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
  children: BrowserBookmarkNode[] | undefined,
  title: string
) {
  return children?.find((child) => isBookmarkFolder(child) && child.title === title) ?? null;
}

export async function getDefaultBookmarkParentId(): Promise<string> {
  const parentId = getDefaultBookmarkParentIdFromTree(await getBookmarkTree());
  if (!parentId) {
    throw new Error("未找到可写入的浏览器书签根目录");
  }
  return parentId;
}

export async function ensureFolderPath(path: string[], maxDepth = 2): Promise<string> {
  if (!hasChromeBookmarks()) return "";

  let safePath = normalizeFolderPath(path, maxDepth);
  let tree = await getBookmarkTree();
  const parentIdFromTree = getDefaultBookmarkParentIdFromTree(tree);
  if (!parentIdFromTree) {
    throw new Error("未找到可写入的浏览器书签根目录");
  }
  const rootFolder = tree[0]?.children?.find((child) => child.id === parentIdFromTree) as BrowserBookmarkNode | undefined;
  let parentId = parentIdFromTree;
  let siblings = rootFolder?.children as BrowserBookmarkNode[] | undefined;
  const existingTopLevelFolder = safePath[0] ? findFolderInChildren(siblings, safePath[0]) : null;

  if (existingTopLevelFolder) {
    parentId = existingTopLevelFolder.id;
    siblings = existingTopLevelFolder.children as BrowserBookmarkNode[] | undefined;
    safePath = safePath.slice(1);
  }
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

function flattenBookmarkFolders(nodes: BrowserBookmarkNode[]): BrowserBookmarkNode[] {
  return nodes.flatMap((node) => {
    if (!isBookmarkFolder(node)) return [];
    return [node, ...flattenBookmarkFolders(node.children ?? [])];
  });
}

export async function createBookmark(title: string, url: string, folderPath: string[]) {
  const parentId = await ensureFolderPath(folderPath);
  return createBookmarkNode({ parentId, title, url });
}

export async function createFolderInFolder(parentId: string, title: string, index?: number) {
  return createBookmarkNode({ parentId, title, index });
}

export async function createBookmarkInFolder(parentId: string, title: string, url: string, index?: number) {
  return createBookmarkNode({ parentId, title, url, index });
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
  if (isRootFolder(id)) {
    throw new Error("不能移动浏览器内置书签根目录");
  }

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

export async function sortFolderChildrenFoldersFirst(folderId: string): Promise<boolean> {
  if (!hasChromeBookmarks() || isRootFolder(folderId)) return false;

  const children = await getFolderChildren(folderId);
  if (children.length < 2 || children.some((child) => isSeparatorNode(child))) return false;

  const orderedChildren = [
    ...children.filter((child) => isBookmarkFolder(child)),
    ...children.filter((child) => child.url),
  ];
  const alreadyGrouped = children.every((child, index) => child.id === orderedChildren[index]?.id);
  if (alreadyGrouped) return false;

  const currentOrder = children.map((child) => child.id);
  for (let index = 0; index < orderedChildren.length; index += 1) {
    const targetId = orderedChildren[index]?.id;
    if (!targetId || currentOrder[index] === targetId) continue;

    await moveBookmark(targetId, folderId, index);
    const currentIndex = currentOrder.indexOf(targetId);
    if (currentIndex >= 0) {
      currentOrder.splice(currentIndex, 1);
      currentOrder.splice(index, 0, targetId);
    }
  }

  return true;
}

export async function sortFoldersAndAncestorsChildrenFoldersFirst(folderIds: string[]): Promise<number> {
  const idsToSort = new Set<string>();

  for (const folderId of folderIds) {
    let currentId: string | undefined = folderId;
    while (currentId && !isRootFolder(currentId)) {
      if (idsToSort.has(currentId)) break;
      const folder = await getBookmark(currentId);
      if (!folder || !isBookmarkFolder(folder as BrowserBookmarkNode)) break;
      idsToSort.add(currentId);
      currentId = folder.parentId;
    }
  }

  let changedCount = 0;
  for (const folderId of idsToSort) {
    try {
      if (await sortFolderChildrenFoldersFirst(folderId)) {
        changedCount += 1;
      }
    } catch {
      // 整理已完成时，排序失败不应回滚已确认的书签移动。
    }
  }

  return changedCount;
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
  if (isRootFolder(id)) {
    throw new Error("不能删除浏览器内置书签根目录");
  }

  const folder = await getBookmark(id);
  if (!folder || !isBookmarkFolder(folder as BrowserBookmarkNode)) {
    throw new Error("目标不是可删除的书签文件夹");
  }

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

export async function getFolderChildren(id: string): Promise<BrowserBookmarkNode[]> {
  if (!hasChromeBookmarks()) return [];

  return new Promise((resolve) => {
    chrome.bookmarks.getChildren(id, (children) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(children as BrowserBookmarkNode[]);
    });
  });
}

export async function isFolderEmpty(id: string): Promise<boolean> {
  const children = await getFolderChildren(id);
  return children.length === 0;
}
