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
  getFolderHabitProfile,
  getPendingRecommendations,
  getSettings,
  saveLastBackup,
  saveLastReport,
  savePendingRecommendations,
} from "./storage";

function findFolderPathById(tree: chrome.bookmarks.BookmarkTreeNode[], targetId: string): string[] | null {
  function search(nodes: chrome.bookmarks.BookmarkTreeNode[], path: string[]): string[] | null {
    for (const node of nodes) {
      // 构建到当前节点的路径（如果不是根节点且是文件夹）
      const currentPath = node.title && !node.url && !isRootFolder(node.id) ? [...path, node.title] : path;

      if (node.id === targetId) {
        return currentPath;
      }
      if (node.children) {
        const result = search(node.children, currentPath);
        if (result) return result;
      }
    }
    return null;
  }
  return search(tree, []);
}

function fallbackResult(id: string, reason = "未能可靠分类，已放入待整理"): ClassificationResult {
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

function countBy<T>(items: T[], getKey: (item: T) => string | undefined) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function topKeys(counts: Map<string, number>, limit: number) {
  return new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
      .slice(0, Math.max(1, limit))
      .map(([key]) => key)
  );
}

function compactClassificationResults(
  results: Map<string, ClassificationResult>,
  settings: Settings,
  preferredTopLevelFolders: string[] = []
) {
  const validResults = [...results.values()].filter((result) => {
    const first = result.categoryPath?.[0];
    return first && first !== "待整理";
  });
  const topLevelCounts = countBy(validResults, (result) => result.categoryPath?.[0]);
  const hasTopLevelOverflow = topLevelCounts.size > settings.maxTopLevelFolders;
  const preferred = preferredTopLevelFolders.filter((folder) => topLevelCounts.has(folder));
  const allowedTopLevels = topKeys(
    topLevelCounts,
    hasTopLevelOverflow && settings.maxTopLevelFolders > 1
      ? settings.maxTopLevelFolders - 1
      : settings.maxTopLevelFolders
  );
  for (const folder of preferred.slice(0, Math.max(1, settings.maxTopLevelFolders - 1))) {
    allowedTopLevels.add(folder);
  }
  while (allowedTopLevels.size > Math.max(1, settings.maxTopLevelFolders - 1) && hasTopLevelOverflow) {
    const removable = [...allowedTopLevels].reverse().find((folder) => !preferred.includes(folder));
    if (!removable) break;
    allowedTopLevels.delete(removable);
  }
  const overflowTopLevel = settings.maxTopLevelFolders > 1 ? "其他" : [...allowedTopLevels][0] ?? "其他";

  for (const result of validResults) {
    const first = result.categoryPath?.[0];
    if (!first || allowedTopLevels.has(first)) continue;
    result.categoryPath = [overflowTopLevel];
    result.category = overflowTopLevel;
    result.reason = [result.reason, "长尾分类已合并，避免创建过多一级文件夹"].filter(Boolean).join("；");
  }

  if (!settings.allowNestedFolders || settings.maxNestingLevel < 2 || settings.maxSubfoldersPerFolder <= 0) {
    for (const result of results.values()) {
      if (!result.categoryPath?.length) continue;
      result.categoryPath = [result.categoryPath[0]];
      result.category = result.categoryPath[0];
    }
    return;
  }

  const grouped = new Map<string, ClassificationResult[]>();
  for (const result of results.values()) {
    const first = result.categoryPath?.[0];
    const second = result.categoryPath?.[1];
    if (!first || !second) continue;
    if (!grouped.has(first)) grouped.set(first, []);
    grouped.get(first)?.push(result);
  }

  for (const [first, group] of grouped) {
    const subCounts = countBy(group, (result) => result.categoryPath?.[1]);
    const allowedSubfolders = topKeys(subCounts, settings.maxSubfoldersPerFolder);

    for (const result of group) {
      const second = result.categoryPath?.[1];
      if (!second || allowedSubfolders.has(second)) continue;
      result.categoryPath = [first];
      result.category = first;
      result.reason = [result.reason, "细分子类已合并到父文件夹，减少整理负担"].filter(Boolean).join("；");
    }
  }
}

function extractCategoryScheme(results: Map<string, ClassificationResult>) {
  const topLevelSet = new Set<string>();
  for (const result of results.values()) {
    const first = result.categoryPath?.[0];
    if (first && first !== "待整理") {
      topLevelSet.add(first);
    }
  }
  return [...topLevelSet];
}

export async function generateMovePlans(): Promise<MovePlan[]> {
  const bookmarks = await getAllBookmarks();
  const urlBookmarks = bookmarks.filter((bookmark) => bookmark.url);
  return generateMovePlansForBookmarks(urlBookmarks);
}

export async function generateMovePlansForBookmarks(
  urlBookmarks: Awaited<ReturnType<typeof getAllBookmarks>>
): Promise<MovePlan[]> {
  const [settings, habitProfile] = await Promise.all([
    getSettings(),
    getFolderHabitProfile(),
  ]);
  const results = new Map<string, ClassificationResult>();
  const failureReasons = new Map<string, string>();

  if (urlBookmarks.length && settings.provider.apiKey) {
    // 阶段一：采样首次分类，建立统一分类体系
    const sampleSize = Math.min(30, urlBookmarks.length);
    const sample = urlBookmarks.slice(0, sampleSize);
    const restBookmarks = urlBookmarks.slice(sampleSize);
    let existingCategories: string[] = [];

    // 先分类采样
    for (const batch of chunkBookmarks(sample, 20)) {
      try {
        const requestedIds = new Set(batch.map((b) => b.id));
        const aiBookmarks = batch.map((b) => toBookmarkForAI(b, settings.sendFullUrl));
        const aiResults = await classifyWithAI(settings.provider, aiBookmarks, {
          allowNestedFolders: settings.allowNestedFolders,
          maxTopLevelFolders: settings.maxTopLevelFolders,
          maxSubfoldersPerFolder: settings.maxSubfoldersPerFolder,
          habitProfile,
          customPrompt: settings.customPrompt,
        });
        for (const result of aiResults) {
          if (requestedIds.has(result.id)) results.set(result.id, result);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "AI 分类失败";
        for (const b of batch) failureReasons.set(b.id, reason);
      }
    }

    // 提取已有的分类体系
    existingCategories = extractCategoryScheme(results);

    // 阶段二：用已有分类体系约束后续批次
    for (const batch of chunkBookmarks(restBookmarks, 20)) {
      try {
        const requestedIds = new Set(batch.map((b) => b.id));
        const aiBookmarks = batch.map((b) => toBookmarkForAI(b, settings.sendFullUrl));
        const aiResults = await classifyWithAI(settings.provider, aiBookmarks, {
          allowNestedFolders: settings.allowNestedFolders,
          maxTopLevelFolders: settings.maxTopLevelFolders,
          maxSubfoldersPerFolder: settings.maxSubfoldersPerFolder,
          habitProfile,
          customPrompt: settings.customPrompt,
          existingCategories: existingCategories.length > 0 ? existingCategories : undefined,
        });
        for (const result of aiResults) {
          if (requestedIds.has(result.id)) results.set(result.id, result);
        }

        for (const b of batch) {
          if (!requestedIds.has(b.id)) continue;
          if (!results.has(b.id)) {
            failureReasons.set(b.id, "AI 未返回此书签的分类结果");
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "AI 分类失败";
        for (const b of batch) failureReasons.set(b.id, reason);
      }
    }
  } else if (urlBookmarks.length) {
    for (const bookmark of urlBookmarks) {
      failureReasons.set(bookmark.id, "未配置 API Key，无法调用 AI");
    }
  }

  compactClassificationResults(results, settings, habitProfile?.preferredTopLevelFolders);

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
      let targetParentId = plan.fromParentId;
      // 检查原文件夹是否仍然存在（可能被清理逻辑删除了）
      const existing = await getBookmark(targetParentId);
      if (!existing) {
        const folderPath = findFolderPathById(backup.tree, targetParentId);
        if (folderPath && folderPath.length > 0) {
          targetParentId = await ensureFolderPath(folderPath);
        } else {
          // 无法恢复原文件夹，放入书签栏根目录
          targetParentId = "1";
        }
      }
      // 不指定 index，让书签添加到文件夹末尾，避免 Index out of bounds
      await moveBookmark(plan.bookmarkId, targetParentId);
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
      ], {
        allowNestedFolders: settings.allowNestedFolders,
        maxTopLevelFolders: settings.maxTopLevelFolders,
        maxSubfoldersPerFolder: settings.maxSubfoldersPerFolder,
        habitProfile: await getFolderHabitProfile(),
        customPrompt: settings.customPrompt,
      });
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
