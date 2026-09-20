import type { BookmarkBackup, BookmarkRestoreReport, FailedMove } from "../types";
import {
  type BrowserBookmarkNode,
  getBookmarkRootFolderIds,
  getBookmarkTree,
  getDefaultBookmarkParentIdFromTree,
  isBookmarkFolder,
  isRootFolder,
  isSeparatorNode,
  moveBookmark,
  updateBookmark,
} from "./bookmarks";
import {
  BACKUP_HISTORY_LIMIT,
  STORAGE_KEYS,
  getStorageValue,
  setStorageValue,
} from "./storage";

type FolderSnapshot = {
  id: string;
  parentId?: string;
  rootId: string;
  title: string;
  index?: number;
  path: string[];
};

type BookmarkSnapshot = {
  id: string;
  parentId?: string;
  rootId: string;
  title: string;
  url: string;
  index?: number;
  parentPath: string[];
};

type SeparatorSnapshot = {
  id: string;
  parentId?: string;
  rootId: string;
  index?: number;
  parentPath: string[];
};

type BookmarkLookup = {
  byId: Map<string, BrowserBookmarkNode>;
  byIdentity: Map<string, BrowserBookmarkNode[]>;
};

type CurrentTree = {
  tree: BrowserBookmarkNode[];
  rootFolderIds: Set<string>;
  foldersById: Map<string, BrowserBookmarkNode>;
  foldersByPath: Map<string, BrowserBookmarkNode>;
  separatorsById: Map<string, BrowserBookmarkNode>;
  bookmarkLookup: BookmarkLookup;
};

function identityKey(title: string, url: string) {
  return `${url}\u0000${title}`;
}

function pathKey(rootId: string, path: string[]) {
  return `${rootId}:${path.join("/")}`;
}

type BookmarkCreateDetails = chrome.bookmarks.BookmarkCreateArg & { type?: "separator" };

function createNode(createDetails: BookmarkCreateDetails) {
  return new Promise<BrowserBookmarkNode>((resolve, reject) => {
    chrome.bookmarks.create(createDetails, (node) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(node as BrowserBookmarkNode);
    });
  });
}

function updateNodeTitle(id: string, title: string) {
  return new Promise<BrowserBookmarkNode>((resolve, reject) => {
    chrome.bookmarks.update(id, { title }, (node) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(node as BrowserBookmarkNode);
    });
  });
}

async function createNodeBestEffort(createDetails: BookmarkCreateDetails) {
  try {
    return await createNode(createDetails);
  } catch (error) {
    if (createDetails.index === undefined) throw error;
    const { index: _index, ...fallbackDetails } = createDetails;
    return createNode(fallbackDetails);
  }
}

async function moveBookmarkBestEffort(id: string, parentId: string, index?: number) {
  try {
    await moveBookmark(id, parentId, index);
  } catch (error) {
    if (index === undefined) throw error;
    await moveBookmark(id, parentId);
  }
}

export function getBookmarkTreeStats(tree: BrowserBookmarkNode[]) {
  let bookmarkCount = 0;
  let folderCount = 0;
  const rootFolderIds = getBookmarkRootFolderIds(tree);

  function visit(nodes: BrowserBookmarkNode[]) {
    for (const node of nodes) {
      if (node.url) {
        bookmarkCount += 1;
      } else if (isBookmarkFolder(node) && !isRootFolder(node.id, rootFolderIds)) {
        folderCount += 1;
      }
      if (node.children) visit(node.children as BrowserBookmarkNode[]);
    }
  }

  visit(tree);
  return { bookmarkCount, folderCount };
}

function normalizeBackup(backup: BookmarkBackup): BookmarkBackup {
  const stats = getBookmarkTreeStats(backup.tree);
  return {
    ...backup,
    kind: backup.kind ?? "organize",
    bookmarkCount: backup.bookmarkCount ?? stats.bookmarkCount,
    folderCount: backup.folderCount ?? stats.folderCount,
    movePlan: backup.movePlan ?? [],
  };
}

export async function getBackupHistory(): Promise<BookmarkBackup[]> {
  const backups = await getStorageValue<BookmarkBackup[] | null>(STORAGE_KEYS.backupHistory, null);
  if (backups) {
    return backups.map(normalizeBackup).slice(0, BACKUP_HISTORY_LIMIT);
  }

  const legacyBackup = await getStorageValue<BookmarkBackup | null>(STORAGE_KEYS.lastBackup, null);
  if (!legacyBackup) return [];

  const migratedBackups = [normalizeBackup(legacyBackup)];
  await setStorageValue(STORAGE_KEYS.backupHistory, migratedBackups);
  return migratedBackups;
}

async function writeBackupHistory(backups: BookmarkBackup[]) {
  let nextBackups = backups.slice(0, BACKUP_HISTORY_LIMIT);
  while (nextBackups.length > 0) {
    try {
      await setStorageValue(STORAGE_KEYS.backupHistory, nextBackups);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/quota|storage/i.test(message) || nextBackups.length === 1) throw error;
      nextBackups = nextBackups.slice(0, -1);
    }
  }
}

export async function saveBackupToHistory(backup: BookmarkBackup): Promise<void> {
  const normalizedBackup = normalizeBackup(backup);
  const backups = await getBackupHistory();
  const nextBackups = [
    normalizedBackup,
    ...backups.filter((item) => item.id !== normalizedBackup.id),
  ];
  await writeBackupHistory(nextBackups);
}

export async function deleteBackup(backupId: string): Promise<void> {
  const backups = await getBackupHistory();
  await setStorageValue(
    STORAGE_KEYS.backupHistory,
    backups.filter((backup) => backup.id !== backupId)
  );
}

async function createBackup(kind: BookmarkBackup["kind"], restoreSourceId?: string): Promise<BookmarkBackup> {
  const tree = await getBookmarkTree();
  const stats = getBookmarkTreeStats(tree);
  return {
    id: `${kind}-backup-${Date.now()}`,
    kind,
    createdAt: Date.now(),
    tree,
    ...stats,
    movePlan: [],
    restoreSourceId,
  };
}

export async function createManualBackup(): Promise<BookmarkBackup> {
  const backup = await createBackup("manual");
  await saveBackupToHistory(backup);
  return backup;
}

export async function createPreImportBackup(): Promise<BookmarkBackup> {
  const backup = await createBackup("pre-import");
  await saveBackupToHistory(backup);
  return backup;
}

export async function createDuplicateDeleteBackup(): Promise<BookmarkBackup> {
  const backup = await createBackup("duplicate-delete");
  await saveBackupToHistory(backup);
  return backup;
}

export async function createInvalidDeleteBackup(): Promise<BookmarkBackup> {
  const backup = await createBackup("invalid-delete");
  await saveBackupToHistory(backup);
  return backup;
}

function collectSnapshots(tree: BrowserBookmarkNode[]) {
  const folders: FolderSnapshot[] = [];
  const bookmarks: BookmarkSnapshot[] = [];
  const separators: SeparatorSnapshot[] = [];
  const rootFolderIds = getBookmarkRootFolderIds(tree);

  function visit(nodes: BrowserBookmarkNode[], path: string[], rootId: string) {
    for (const node of nodes) {
      if (node.url) {
        bookmarks.push({
          id: node.id,
          parentId: node.parentId,
          rootId,
          title: node.title,
          url: node.url,
          index: node.index,
          parentPath: path,
        });
        continue;
      }

      if (isSeparatorNode(node)) {
        separators.push({
          id: node.id,
          parentId: node.parentId,
          rootId,
          index: node.index,
          parentPath: path,
        });
        continue;
      }

      const isRoot = isRootFolder(node.id, rootFolderIds);
      const nextRootId = isRoot ? node.id : rootId;
      const nextPath = isRoot ? [] : [...path, node.title];
      if (!isRoot) {
        folders.push({
          id: node.id,
          parentId: node.parentId,
          rootId,
          title: node.title,
          index: node.index,
          path: nextPath,
        });
      }
      visit((node.children ?? []) as BrowserBookmarkNode[], nextPath, nextRootId);
    }
  }

  visit(tree, [], tree[0]?.id ?? "");
  return { folders, bookmarks, separators };
}

function collectCurrentTree(tree: BrowserBookmarkNode[]): CurrentTree {
  const rootFolderIds = getBookmarkRootFolderIds(tree);
  const foldersById = new Map<string, BrowserBookmarkNode>();
  const foldersByPath = new Map<string, BrowserBookmarkNode>();
  const separatorsById = new Map<string, BrowserBookmarkNode>();
  const bookmarkLookup: BookmarkLookup = {
    byId: new Map(),
    byIdentity: new Map(),
  };

  function visit(nodes: BrowserBookmarkNode[], path: string[], rootId: string) {
    for (const node of nodes) {
      if (node.url) {
        bookmarkLookup.byId.set(node.id, node);
        const key = identityKey(node.title, node.url);
        const group = bookmarkLookup.byIdentity.get(key) ?? [];
        group.push(node);
        bookmarkLookup.byIdentity.set(key, group);
        continue;
      }

      if (isSeparatorNode(node)) {
        separatorsById.set(node.id, node);
        continue;
      }

      const isRoot = isRootFolder(node.id, rootFolderIds);
      const nextRootId = isRoot ? node.id : rootId;
      const nextPath = isRoot ? [] : [...path, node.title];
      if (!isRoot) {
        foldersById.set(node.id, node);
        foldersByPath.set(pathKey(rootId, nextPath), node);
      }
      visit((node.children ?? []) as BrowserBookmarkNode[], nextPath, nextRootId);
    }
  }

  visit(tree, [], tree[0]?.id ?? "");
  return { tree, rootFolderIds, foldersById, foldersByPath, separatorsById, bookmarkLookup };
}

function getWritableRootId(rootId: string, current: CurrentTree) {
  if (isRootFolder(rootId, current.rootFolderIds)) return rootId;

  const fallbackRootId = getDefaultBookmarkParentIdFromTree(current.tree);
  if (!fallbackRootId) {
    throw new Error("未找到可写入的浏览器书签根目录");
  }
  return fallbackRootId;
}

async function ensureFolderPathFromSnapshot(
  rootId: string,
  path: string[],
  folderIndex: number | undefined,
  current: CurrentTree
) {
  let parentId = getWritableRootId(rootId, current);

  for (let index = 0; index < path.length; index += 1) {
    const partialPath = path.slice(0, index + 1);
    const key = pathKey(rootId, partialPath);
    const existing = current.foldersByPath.get(key);
    if (existing) {
      parentId = existing.id;
      continue;
    }

    const created = await createNodeBestEffort({
      parentId,
      title: partialPath[partialPath.length - 1],
      index: index === path.length - 1 ? folderIndex : undefined,
    });
    current.foldersById.set(created.id, created);
    current.foldersByPath.set(key, created);
    parentId = created.id;
  }

  return parentId;
}

async function resolveParentId(
  snapshot: { parentId?: string; rootId: string; parentPath: string[] },
  current: CurrentTree
) {
  if (snapshot.parentId && isRootFolder(snapshot.parentId, current.rootFolderIds)) {
    return snapshot.parentId;
  }

  if (snapshot.parentId) {
    const existingParent = current.foldersById.get(snapshot.parentId);
    if (existingParent) return existingParent.id;
  }

  const existingByPath = current.foldersByPath.get(pathKey(snapshot.rootId, snapshot.parentPath));
  if (existingByPath) return existingByPath.id;

  return ensureFolderPathFromSnapshot(snapshot.rootId, snapshot.parentPath, undefined, current);
}

function pickMatchingBookmark(snapshot: BookmarkSnapshot, lookup: BookmarkLookup, usedBookmarkIds: Set<string>) {
  const group = lookup.byIdentity.get(identityKey(snapshot.title, snapshot.url)) ?? [];
  return group.find((node) => !usedBookmarkIds.has(node.id)) ?? null;
}

export async function restoreBackup(backupId: string): Promise<BookmarkRestoreReport> {
  const backups = await getBackupHistory();
  const backup = backups.find((item) => item.id === backupId);
  if (!backup) throw new Error("未找到备份记录");

  const preRestoreBackup = await createBackup("pre-restore", backup.id);
  await saveBackupToHistory(preRestoreBackup);

  const snapshots = collectSnapshots(backup.tree);
  let current = collectCurrentTree(await getBookmarkTree());
  const failedItems: FailedMove[] = [];
  const usedBookmarkIds = new Set<string>();
  let restoredCount = 0;
  let recreatedCount = 0;

  for (const folder of snapshots.folders) {
    try {
      const existingFolder = current.foldersById.get(folder.id);
      if (existingFolder) {
        let changed = false;
        const parentId = await resolveParentId(
          {
            parentId: folder.parentId,
            rootId: folder.rootId,
            parentPath: folder.path.slice(0, -1),
          },
          current
        );
        if (existingFolder.title !== folder.title) {
          await updateNodeTitle(folder.id, folder.title);
          changed = true;
        }
        if (existingFolder.parentId !== parentId || existingFolder.index !== folder.index) {
          await moveBookmarkBestEffort(folder.id, parentId, folder.index);
          changed = true;
        }
        if (changed) {
          current = collectCurrentTree(await getBookmarkTree());
        }
        continue;
      }
      await ensureFolderPathFromSnapshot(folder.rootId, folder.path, folder.index, current);
    } catch (error) {
      failedItems.push({
        bookmarkId: folder.id,
        bookmarkTitle: folder.title,
        reason: error instanceof Error ? error.message : "恢复文件夹失败",
      });
    }
  }

  current = collectCurrentTree(await getBookmarkTree());

  for (const separator of snapshots.separators) {
    try {
      const parentId = await resolveParentId(separator, current);
      const existing = current.separatorsById.get(separator.id);
      if (existing) {
        if (existing.parentId !== parentId || existing.index !== separator.index) {
          await moveBookmarkBestEffort(existing.id, parentId, separator.index);
        }
        continue;
      }

      const created = await createNodeBestEffort({
        parentId,
        index: separator.index,
        type: "separator",
      });
      current.separatorsById.set(created.id, created);
    } catch (error) {
      failedItems.push({
        bookmarkId: separator.id,
        bookmarkTitle: "分隔线",
        reason: error instanceof Error ? error.message : "恢复分隔线失败",
      });
    }
  }

  current = collectCurrentTree(await getBookmarkTree());

  for (const bookmark of snapshots.bookmarks) {
    try {
      const parentId = await resolveParentId(bookmark, current);
      const existing = current.bookmarkLookup.byId.get(bookmark.id);
      const target = existing ?? pickMatchingBookmark(bookmark, current.bookmarkLookup, usedBookmarkIds);

      if (target) {
        usedBookmarkIds.add(target.id);
        if (target.title !== bookmark.title || target.url !== bookmark.url) {
          await updateBookmark(target.id, bookmark.title, bookmark.url);
        }
        await moveBookmarkBestEffort(target.id, parentId, bookmark.index);
        restoredCount += 1;
        continue;
      }

      const created = await createNodeBestEffort({
        parentId,
        title: bookmark.title,
        url: bookmark.url,
        index: bookmark.index,
      });
      current.bookmarkLookup.byId.set(created.id, created);
      usedBookmarkIds.add(created.id);
      recreatedCount += 1;
    } catch (error) {
      failedItems.push({
        bookmarkId: bookmark.id,
        bookmarkTitle: bookmark.title,
        reason: error instanceof Error ? error.message : "恢复书签失败",
      });
    }
  }

  return {
    id: `restore-${Date.now()}`,
    createdAt: Date.now(),
    backupId: backup.id,
    backupCreatedAt: backup.createdAt,
    restoredCount,
    recreatedCount,
    folderCount: snapshots.folders.length,
    failedItems,
    preRestoreBackupId: preRestoreBackup.id,
  };
}
