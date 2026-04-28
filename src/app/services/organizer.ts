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
  moveBookmark,
  normalizeFolderPath,
} from "./bookmarks";
import { classifyWithAI } from "./aiProvider";
import { classifyWithRules, normalizeCategoryPath, sanitizeUrl, toBookmarkForAI } from "./rules";
import {
  getClassificationRules,
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
  const [settings, learnedRules, bookmarks] = await Promise.all([
    getSettings(),
    getClassificationRules(),
    getAllBookmarks(),
  ]);
  const urlBookmarks = bookmarks.filter((bookmark) => bookmark.url);
  const localResults = new Map<string, ClassificationResult>();
  const needsAI = [];

  for (const bookmark of urlBookmarks) {
    const local = classifyWithRules(bookmark, learnedRules);
    if (local) {
      localResults.set(bookmark.id, local);
    } else {
      needsAI.push(bookmark);
    }
  }

  const aiFailureReasons = new Map<string, string>();

  if (needsAI.length && settings.provider.apiKey) {
    for (const batch of chunkBookmarks(needsAI, 20)) {
      try {
        const requestedIds = new Set(batch.map((bookmark) => bookmark.id));
        const aiBookmarks = batch.map((bookmark) => toBookmarkForAI(bookmark, settings.sendFullUrl));
        const aiResults = await classifyWithAI(settings.provider, aiBookmarks);
        const returnedIds = new Set<string>();

        for (const result of aiResults) {
          if (requestedIds.has(result.id)) {
            localResults.set(result.id, result);
            returnedIds.add(result.id);
          }
        }

        for (const bookmark of batch) {
          if (!returnedIds.has(bookmark.id)) {
            aiFailureReasons.set(bookmark.id, "AI 未返回此书签的分类结果");
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "AI 分类失败";
        for (const bookmark of batch) {
          aiFailureReasons.set(bookmark.id, reason);
        }
      }
    }
  } else if (needsAI.length) {
    for (const bookmark of needsAI) {
      aiFailureReasons.set(bookmark.id, "未配置 API Key，无法调用 AI");
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
      localResults.get(bookmark.id) ?? fallbackResult(bookmark.id, aiFailureReasons.get(bookmark.id) || undefined),
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

export async function executeMovePlans(plans: MovePlan[]): Promise<OrganizeReport> {
  const [tree, settings] = await Promise.all([getBookmarkTree(), getSettings()]);
  await saveLastBackup({
    id: `backup-${Date.now()}`,
    createdAt: Date.now(),
    tree,
    movePlan: plans,
  });

  const failedItems: FailedMove[] = [];
  let movedCount = 0;

  for (const plan of plans) {
    try {
      const parentId = await ensureFolderPath(plan.toFolderPath, settings.maxNestingLevel);
      await moveBookmark(plan.bookmarkId, parentId);
      movedCount += 1;
    } catch (error) {
      failedItems.push({
        bookmarkId: plan.bookmarkId,
        bookmarkTitle: plan.bookmarkTitle,
        reason: error instanceof Error ? error.message : "移动失败",
      });
    }
  }

  const report: OrganizeReport = {
    id: `report-${Date.now()}`,
    createdAt: Date.now(),
    movedCount,
    folderCount: uniqueFolderCount(plans),
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
  const local = classifyWithRules(bookmarkNode);
  let classification = local ?? fallbackResult(bookmark.id, "新增书签暂未匹配本地规则");

  if (!local && settings.provider.apiKey) {
    try {
      const [aiResult] = await classifyWithAI(settings.provider, [
        toBookmarkForAI(bookmarkNode, settings.sendFullUrl),
      ]);
      if (aiResult) classification = aiResult;
    } catch {
      // 新增推荐失败时保留本地待整理建议。
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
