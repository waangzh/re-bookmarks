import type { BookmarkWhitelistEntry } from "../types";
import {
  getBookmark,
  getBookmarkRootFolderIds,
  getBookmarkTree,
  getDefaultBookmarkParentIdFromTree,
  isBookmarkFolder,
  type BrowserBookmarkNode,
} from "./bookmarks";
import {
  clearPreviewPlan,
  getBookmarkWhitelist,
  saveBookmarkWhitelist,
  updatePendingRecommendations,
} from "./storage";

export type WhitelistIndex = {
  protectedBookmarkIds: Set<string>;
  protectedFolderIds: Set<string>;
  reasonById: Map<string, string>;
};

let updateQueue: Promise<void> = Promise.resolve();

function queueWhitelistUpdate<T>(update: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (globalThis.navigator?.locks?.request) {
      return await globalThis.navigator.locks.request("remarks-bookmark-whitelist", update);
    }
    return update();
  };
  const result = updateQueue.then(run);
  updateQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function buildWhitelistIndex(tree: BrowserBookmarkNode[], entries: BookmarkWhitelistEntry[]): WhitelistIndex {
  const bookmarkRules = new Set(entries.filter((entry) => entry.type === "bookmark").map((entry) => entry.id));
  const folderRules = new Set(entries.filter((entry) => entry.type === "folder").map((entry) => entry.id));
  const protectedBookmarkIds = new Set<string>();
  const protectedFolderIds = new Set<string>();
  const reasonById = new Map<string, string>();

  const visit = (node: BrowserBookmarkNode, inheritedReason?: string) => {
    const folder = isBookmarkFolder(node);
    const reason = folderRules.has(node.id) ? node.title || "受保护文件夹" : inheritedReason;
    if (folder && reason) protectedFolderIds.add(node.id);
    if (!folder && (reason || bookmarkRules.has(node.id))) protectedBookmarkIds.add(node.id);
    if (reason || bookmarkRules.has(node.id)) {
      reasonById.set(node.id, reason ? "受“" + reason + "”文件夹保护" : "已加入白名单");
    }
    for (const child of node.children ?? []) visit(child as BrowserBookmarkNode, reason);
  };

  tree.forEach((node) => visit(node));
  return { protectedBookmarkIds, protectedFolderIds, reasonById };
}

export async function getCurrentWhitelist() {
  const [tree, entries] = await Promise.all([getBookmarkTree(), getBookmarkWhitelist()]);
  return { tree, entries, index: buildWhitelistIndex(tree, entries) };
}

export function protectedNodeReason(id: string, tree: BrowserBookmarkNode[], index: WhitelistIndex) {
  if (index.reasonById.has(id)) return index.reasonById.get(id);
  const visit = (nodes: BrowserBookmarkNode[]): boolean => nodes.some((node) =>
    node.id === id
      ? (node.children ?? []).some((child) => hasProtectedDescendant(child as BrowserBookmarkNode, index))
      : visit((node.children ?? []) as BrowserBookmarkNode[])
  );
  return visit(tree) ? "文件夹中含有受保护书签或子目录" : undefined;
}

function hasProtectedDescendant(node: BrowserBookmarkNode, index: WhitelistIndex): boolean {
  return index.reasonById.has(node.id) || (node.children ?? []).some((child) =>
    hasProtectedDescendant(child as BrowserBookmarkNode, index)
  );
}

export function isProtectedTargetPath(path: string[], tree: BrowserBookmarkNode[], index: WhitelistIndex) {
  const rootId = getDefaultBookmarkParentIdFromTree(tree);
  if (!rootId) return false;
  let children = (tree[0]?.children?.find((node) => node.id === rootId) as BrowserBookmarkNode | undefined)?.children;
  for (const title of path) {
    const folder = children?.find((node) => isBookmarkFolder(node as BrowserBookmarkNode) && node.title === title) as BrowserBookmarkNode | undefined;
    if (!folder) return false;
    if (index.protectedFolderIds.has(folder.id)) return true;
    children = folder.children;
  }
  return false;
}

export function getAvailableFolderPaths(tree: BrowserBookmarkNode[], index: WhitelistIndex) {
  const rootIds = getBookmarkRootFolderIds(tree);
  const paths: string[][] = [];
  const visit = (node: BrowserBookmarkNode, parentPath: string[]) => {
    if (!isBookmarkFolder(node) || index.protectedFolderIds.has(node.id)) return;
    const path = rootIds.has(node.id) ? parentPath : [...parentPath, node.title];
    if (!rootIds.has(node.id)) paths.push(path);
    for (const child of node.children ?? []) visit(child as BrowserBookmarkNode, path);
  };
  tree.forEach((node) => visit(node, []));
  return paths;
}

export function filterAvailableBookmarks<T extends { id: string }>(bookmarks: T[], index: WhitelistIndex) {
  return bookmarks.filter((bookmark) => !index.protectedBookmarkIds.has(bookmark.id));
}

export { whitelistFingerprint } from "./storage";

async function invalidateWhitelistDerivedData(entries: BookmarkWhitelistEntry[]) {
  const tree = await getBookmarkTree();
  const index = buildWhitelistIndex(tree, entries);
  await Promise.all([
    clearPreviewPlan(),
    import("./previewTask").then(({ requestClearPreviewTask }) => requestClearPreviewTask()),
    updatePendingRecommendations((recommendations) => recommendations.filter((item) =>
      !index.protectedBookmarkIds.has(item.bookmarkId) &&
      !isProtectedTargetPath(item.suggestedFolderPath, tree, index)
    )),
  ]);
  await import("./recommendations").then(({ updateRecommendationBadge }) => updateRecommendationBadge());
}

export async function addBookmarkWhitelistEntry(type: BookmarkWhitelistEntry["type"], id: string) {
  return queueWhitelistUpdate(async () => {
    const [node, tree, entries] = await Promise.all([getBookmark(id), getBookmarkTree(), getBookmarkWhitelist()]);
    if (!node) throw new Error("书签或文件夹已不存在");
    if (type === "folder") {
      if (!isBookmarkFolder(node as BrowserBookmarkNode)) throw new Error("所选项目不是文件夹");
      if (getBookmarkRootFolderIds(tree).has(id)) throw new Error("不能保护浏览器内置根目录");
    } else if (!node.url) {
      throw new Error("所选项目不是书签");
    }
    if (entries.some((entry) => entry.type === type && entry.id === id)) return entries;
    const next = [...entries, { type, id, addedAt: Date.now() }];
    await saveBookmarkWhitelist(next);
    await invalidateWhitelistDerivedData(next);
    return next;
  });
}

export async function addBookmarkWhitelistEntries(ids: string[]) {
  return queueWhitelistUpdate(async () => {
    const [tree, entries] = await Promise.all([getBookmarkTree(), getBookmarkWhitelist()]);
    const bookmarkIds = new Set<string>();
    const visit = (nodes: BrowserBookmarkNode[]) => {
      for (const node of nodes) {
        if (node.url) bookmarkIds.add(node.id);
        if (node.children) visit(node.children as BrowserBookmarkNode[]);
      }
    };
    visit(tree);
    const existing = new Set(entries.filter((entry) => entry.type === "bookmark").map((entry) => entry.id));
    const newIds = [...new Set(ids)].filter((id) => bookmarkIds.has(id) && !existing.has(id));
    if (!newIds.length) return entries;
    const next: BookmarkWhitelistEntry[] = [
      ...entries,
      ...newIds.map((id) => ({ type: "bookmark" as const, id, addedAt: Date.now() })),
    ];
    await saveBookmarkWhitelist(next);
    await invalidateWhitelistDerivedData(next);
    return next;
  });
}

export async function remapBookmarkWhitelistEntries(idMap: Map<string, string>) {
  if (!idMap.size) return;
  return queueWhitelistUpdate(async () => {
    const entries = await getBookmarkWhitelist();
    if (!entries.some((entry) => idMap.has(entry.id))) return;
    const seen = new Set<string>();
    const next = entries.flatMap((entry) => {
      const mapped = { ...entry, id: idMap.get(entry.id) ?? entry.id };
      const key = mapped.type + ":" + mapped.id;
      if (seen.has(key)) return [];
      seen.add(key);
      return [mapped];
    });
    await saveBookmarkWhitelist(next);
    await invalidateWhitelistDerivedData(next);
  });
}

export async function removeBookmarkWhitelistEntries(targets: Array<Pick<BookmarkWhitelistEntry, "type" | "id">>) {
  return queueWhitelistUpdate(async () => {
    const entries = await getBookmarkWhitelist();
    const keys = new Set(targets.map((target) => target.type + ":" + target.id));
    const next = entries.filter((entry) => !keys.has(entry.type + ":" + entry.id));
    if (next.length === entries.length) return entries;
    await saveBookmarkWhitelist(next);
    await invalidateWhitelistDerivedData(next);
    return next;
  });
}

export function removeBookmarkWhitelistEntry(type: BookmarkWhitelistEntry["type"], id: string) {
  return removeBookmarkWhitelistEntries([{ type, id }]);
}