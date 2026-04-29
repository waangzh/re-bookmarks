import type {
  ClassificationResult,
  FailedMove,
  MovePlan,
  OrganizeReport,
  PendingRecommendation,
  Settings,
} from "../types";
import {
  ensureFolderPath,
  getAllBookmarks,
  getBookmarkTree,
  getBookmark,
  isFolderEmpty,
  isRootFolder,
  moveBookmark,
  normalizeFolderPath,
  removeFolder,
} from "./bookmarks";
import { classifyWithAI } from "./aiProvider";
import { normalizeCategoryPath, sanitizeUrl, toBookmarkForAI } from "./rules";
import {
  getLastBackup,
  getPendingRecommendations,
  getSettings,
  saveLastBackup,
  saveLastReport,
  savePendingRecommendations,
} from "./storage";

function fallbackResult(id: string, reason = "未能可靠分类，已放入待整理") {
  return {
    id,
    category: "待整理",
    categoryPath: ["待整理"],
    confidence: 0.5,
    reason,
    source: "rule" as const,
  };
}

function buildMovePlan(
  bookmark: Awaited<ReturnType<typeof getAllBookmarks>>[number],
  classification: ClassificationResult,
  settings: Settings,
  duplicateReason?: string
): MovePlan {
  const path = normalizeCategoryPath(
    classification.confidence < 0.55 ? ["待整理"] : classification.categoryPath,
    settings.allowNestedFolders,
    settings.maxNestingLevel
  );

  return {
    bookmarkId: bookmark.id,
    bookmarkTitle: bookmark.title,
    bookmarkUrl: bookmark.url,
    fromParentId: bookmark.parentId ?? "1",
    fromIndex: bookmark.index,
    toFolderPath: path,
    confidence: classification.confidence,
    reason: [classification.reason, duplicateReason].filter(Boolean).join("；"),
    source: classification.source,
  };
}

function chunkBookmarks<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function generateMovePlans(): Promise<MovePlan[]> {
  const [settings, bookmarks] = await Promise.all([
    getSettings(),
    getAllBookmarks(),
  ]);
  const urlBookmarks = bookmarks.filter((bookmark) => bookmark.url);
  const results = new Map<string, ClassificationResult>();
  const failureReasons = new Map<string, string>();

  if (urlBookmarks.length && settings.provider.apiKey) {
    for (const batch of chunkBookmarks(urlBookmarks, 20)) {
      try {
        const requestedIds = new Set(batch.map((bookmark) => bookmark.id));
        const aiBookmarks = batch.map((bookmark) => toBookmarkForAI(bookmark, settings.sendFullUrl));
        const aiResults = await classifyWithAI(settings.provider, aiBookmarks);
        const returnedIds = new Set<string>();

        for (const result of aiResults) {
          if (requestedIds.has(result.id)) {
            results.set(result.id, result);
            returnedIds.add(result.id);
          }
        }

        for (const bookmark of batch) {
          if (!returnedIds.has(bookmark.id)) {
            failureReasons.set(bookmark.id, "AI 未返回此书签的分类结果");
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "AI 分类失败";
        for (const bookmark of batch) {
          failureReasons.set(bookmark.id, reason);
        }
      }
    }
  } else if (urlBookmarks.length) {
    for (const bookmark of urlBookmarks) {
      failureReasons.set(bookmark.id, "未配置 API Key，无法调用 AI");
    }
  }

  const seenUrls = new Map<string, string>();

  return urlBookmarks.map((bookmark) => {
    const normalizedUrl = bookmark.url ? sanitizeUrl(bookmark.url) : "";
    const firstSameUrl = normalizedUrl ? seenUrls.get(normalizedUrl) : undefined;
    if (normalizedUrl && !firstSameUrl) seenUrls.set(normalizedUrl, bookmark.title);

    const duplicateReason = firstSameUrl ? `可能与「${firstSameUrl}」重复` : undefined;
    return buildMovePlan(
      bookmark,
      results.get(bookmark.id) ?? fallbackResult(bookmark.id, failureReasons.get(bookmark.id) || undefined),
      settings,
      duplicateReason
    );
  });
}

function uniqueFolderCount(plans: MovePlan[]) {
  return new Set(plans.map((plan) => normalizeFolderPath(plan.toFolderPath).join("/"))).size;
}

function privacySummary(settings: Settings) {
  return [
    settings.sendFullUrl
      ? "已按设置允许向 AI 发送完整 URL"
      : "默认仅向 AI 发送去除 query/hash 后的 URL",
    "浏览历史不会发送给 AI",
    "API Key 仅保存到 chrome.storage.local",
    "整理前已保存完整书签备份",
  ];
}

async function cleanupEmptyFolders(folderIds: Set<string>): Promise<number> {
  let removedCount = 0;

  // 按层级深度排序：先处理深层文件夹，再处理浅层
  // 通过获取每个文件夹的信息来确定深度
  const foldersWithDepth: Array<{ id: string; depth: number }> = [];

  for (const id of folderIds) {
    let depth = 0;
    let currentId: string | undefined = id;
    while (currentId && !isRootFolder(currentId)) {
      const folder = await getBookmark(currentId);
      currentId = folder?.parentId;
      depth++;
    }
    foldersWithDepth.push({ id, depth });
  }

  // 按深度降序排列，深层文件夹先处理
  foldersWithDepth.sort((a, b) => b.depth - a.depth);

  const processed = new Set<string>();

  for (const { id } of foldersWithDepth) {
    if (processed.has(id) || isRootFolder(id)) continue;

    try {
      if (await isFolderEmpty(id)) {
        const folder = await getBookmark(id);
        await removeFolder(id);
        removedCount++;
        processed.add(id);

        // 父文件夹可能也变空了，加入待检查队列
        if (folder?.parentId && !isRootFolder(folder.parentId)) {
          folderIds.add(folder.parentId);
        }
      }
    } catch {
      // 删除失败（可能文件夹已不存在或有其他问题），忽略
    }
  }

  return removedCount;
}

async function findAllFolderIds(): Promise<Set<string>> {
  const tree = await getBookmarkTree();
  const folderIds = new Set<string>();

  function collectFolders(nodes: chrome.bookmarks.BookmarkTreeNode[]) {
    for (const node of nodes) {
      if (!node.url && node.id && !isRootFolder(node.id)) {
        folderIds.add(node.id);
      }
      if (node.children) {
        collectFolders(node.children);
      }
    }
  }

  collectFolders(tree);
  return folderIds;
}

export async function executeMovePlans(plans: MovePlan[]): Promise<OrganizeReport> {
  const [tree, settings] = await Promise.all([getBookmarkTree(), getSettings()]);

  // 记录执行前的文件夹
  const foldersBefore = await findAllFolderIds();

  await saveLastBackup({
    id: `backup-${Date.now()}`,
    createdAt: Date.now(),
    tree,
    movePlan: plans,
  });

  const failedItems: FailedMove[] = [];
  let movedCount = 0;
  const sourceFolderIds = new Set<string>();

  for (const plan of plans) {
    try {
      const parentId = await ensureFolderPath(plan.toFolderPath, settings.maxNestingLevel);
      await moveBookmark(plan.bookmarkId, parentId);
      movedCount += 1;
      if (plan.fromParentId) {
        sourceFolderIds.add(plan.fromParentId);
      }
    } catch (error) {
      failedItems.push({
        bookmarkId: plan.bookmarkId,
        bookmarkTitle: plan.bookmarkTitle,
        reason: error instanceof Error ? error.message : "移动失败",
      });
    }
  }

  // 清理源文件夹中变空的
  let removedFolders = 0;
  if (sourceFolderIds.size > 0) {
    removedFolders = await cleanupEmptyFolders(sourceFolderIds);
  }

  // 清理新建的目标文件夹中为空的（可能是移动失败导致的）
  const foldersAfter = await findAllFolderIds();
  const newFolders = new Set<string>();
  for (const id of foldersAfter) {
    if (!foldersBefore.has(id)) {
      newFolders.add(id);
    }
  }
  if (newFolders.size > 0) {
    removedFolders += await cleanupEmptyFolders(newFolders);
  }

  const report: OrganizeReport = {
    id: `report-${Date.now()}`,
    createdAt: Date.now(),
    movedCount,
    folderCount: uniqueFolderCount(plans),
    removedFolders,
    failedItems,
    movePlan: plans,
    privacySummary: privacySummary(settings),
  };

  await saveLastReport(report);
  return report;
}

export async function undoLastOrganize(): Promise<OrganizeReport | null> {
  const backup = await getLastBackup();
  if (!backup) return null;

  const failedItems: FailedMove[] = [];
  let movedCount = 0;

  for (const plan of backup.movePlan) {
    try {
      await moveBookmark(plan.bookmarkId, plan.fromParentId, plan.fromIndex);
      movedCount += 1;
    } catch (error) {
      failedItems.push({
        bookmarkId: plan.bookmarkId,
        bookmarkTitle: plan.bookmarkTitle,
        reason: error instanceof Error ? error.message : "撤销失败",
      });
    }
  }

  const report: OrganizeReport = {
    id: `undo-${Date.now()}`,
    createdAt: Date.now(),
    movedCount,
    folderCount: uniqueFolderCount(backup.movePlan),
    failedItems,
    movePlan: backup.movePlan,
    privacySummary: ["已按最近一次备份尝试恢复原位置"],
    undone: true,
  };

  await saveLastReport(report);
  return report;
}

export async function createPendingRecommendation(bookmark: chrome.bookmarks.BookmarkTreeNode) {
  if (!bookmark.url) return null;

  const settings = await getSettings();
  const bookmarkNode = {
    id: bookmark.id,
    parentId: bookmark.parentId,
    title: bookmark.title,
    url: bookmark.url,
    path: [],
    type: "url" as const,
  };

  let classification = fallbackResult(bookmark.id, "新增书签等待 AI 分类");

  if (settings.provider.apiKey) {
    try {
      const [aiResult] = await classifyWithAI(settings.provider, [
        toBookmarkForAI(bookmarkNode, settings.sendFullUrl),
      ]);
      if (aiResult) classification = aiResult;
    } catch {
      // AI 分类失败时保留待整理建议
    }
  }

  const recommendation: PendingRecommendation = {
    id: `rec-${Date.now()}-${bookmark.id}`,
    bookmarkId: bookmark.id,
    bookmarkTitle: bookmark.title,
    bookmarkUrl: bookmark.url,
    createdAt: Date.now(),
    suggestedFolderPath: normalizeCategoryPath(
      classification.categoryPath,
      settings.allowNestedFolders,
      settings.maxNestingLevel
    ),
    confidence: classification.confidence,
    reason: classification.reason,
  };

  const recommendations = await getPendingRecommendations();
  await savePendingRecommendations([recommendation, ...recommendations]);
  return recommendation;
}
