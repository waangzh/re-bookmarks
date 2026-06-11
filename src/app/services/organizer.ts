import type {
  BookmarkForAI,
  BookmarkBackup,
  ClassificationResult,
  FailedMove,
  FolderHabitProfile,
  MovePlan,
  OrganizeReport,
  PendingRecommendation,
  OrganizeMode,
  PreviewTaskProgress,
  Settings,
  TokenUsage,
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
import { enrichBookmarksWithPageMetadata } from "./pageMetadata";
import { normalizeCategoryPath, sanitizeUrl, toBookmarkForAI } from "./rules";
import { getBookmarkTreeStats, saveBackupToHistory } from "./backups";
import {
  getLastBackup,
  getFolderHabitProfile,
  getPendingRecommendations,
  getSettings,
  saveLastBackup,
  saveReportToHistory,
  savePendingRecommendations,
} from "./storage";

type PreviewProgressUpdate = Omit<PreviewTaskProgress, "startedAt" | "updatedAt">;
type PreviewProgressReporter = (progress: PreviewTaskProgress) => void | Promise<void>;

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

function collectFolderPaths(
  tree: chrome.bookmarks.BookmarkTreeNode[]
): Array<{ id: string; path: string[] }> {
  const folders: Array<{ id: string; path: string[] }> = [];

  function visit(nodes: chrome.bookmarks.BookmarkTreeNode[], path: string[]) {
    for (const node of nodes) {
      if (node.url) continue;
      const currentPath = node.title && !isRootFolder(node.id) ? [...path, node.title] : path;
      if (node.id && !isRootFolder(node.id)) {
        folders.push({ id: node.id, path: currentPath });
      }
      if (node.children) visit(node.children, currentPath);
    }
  }

  visit(tree, []);
  return folders;
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

function classificationFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof SyntaxError || /JSON|Expected|Unexpected|unterminated|parse/i.test(message)) {
    return "AI 返回格式不完整，已暂放待整理";
  }
  return message || "AI 鍒嗙被澶辫触";
}

function createTokenUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function addTokenUsage(total: TokenUsage, usage: TokenUsage) {
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  total.totalTokens += usage.totalTokens;
}

function appendReason(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join("；");
}

function metadataReason(bookmark: BookmarkForAI) {
  if (!bookmark.metadata) return undefined;
  if (bookmark.metadata.available) return "已结合网页元数据";
  return `网页元数据不可用：${bookmark.metadata.reason ?? "抓取失败，已降级使用标题和 URL"}`;
}

function appendMetadataReasons(results: ClassificationResult[], bookmarks: BookmarkForAI[]) {
  const reasonById = new Map(
    bookmarks
      .map((bookmark) => [bookmark.id, metadataReason(bookmark)] as const)
      .filter(([, reason]) => Boolean(reason))
  );

  for (const result of results) {
    result.reason = appendReason(result.reason, reasonById.get(result.id));
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("整理任务已取消", "AbortError");
  }
}

function createProgressEmitter(
  onProgress?: PreviewProgressReporter,
  startedAt = Date.now()
) {
  return async (progress: PreviewProgressUpdate) => {
    try {
      await onProgress?.({
        ...progress,
        startedAt,
        updatedAt: Date.now(),
      });
    } catch {
      // 进度写入只影响 UI 状态，不应中断实际分类和预览生成。
    }
  };
}

async function prepareBookmarksForAI(
  batch: Awaited<ReturnType<typeof getAllBookmarks>>,
  sendFullUrl: boolean,
  organizeMode: OrganizeMode,
  signal?: AbortSignal
) {
  const aiBookmarks = batch.map((bookmark) => toBookmarkForAI(bookmark, sendFullUrl));
  return enrichBookmarksWithPageMetadata(aiBookmarks, batch, { sendFullUrl, mode: organizeMode, signal });
}

function buildMovePlan(
  bookmark: Awaited<ReturnType<typeof getAllBookmarks>>[number],
  classification: ClassificationResult,
  settings: Settings,
  duplicateReason?: string
): MovePlan {
  const lowConfidenceReason = classification.confidence < 0.55
    ? "置信度低于 55%，已暂放待整理"
    : undefined;
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
    reason: appendReason(classification.reason, lowConfidenceReason, duplicateReason),
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

function getProtectedTopLevelFolders(habitProfile?: FolderHabitProfile | null) {
  const folders = new Set<string>();
  for (const folder of habitProfile?.preferredTopLevelFolders ?? []) {
    const value = folder.trim();
    if (value) folders.add(value);
  }
  for (const rule of habitProfile?.folderRules ?? []) {
    const value = rule.folderPath[0]?.trim();
    if (value) folders.add(value);
  }
  return [...folders];
}

function compactClassificationResults(
  results: Map<string, ClassificationResult>,
  settings: Settings,
  habitProfile?: FolderHabitProfile | null
) {
  const validResults = [...results.values()].filter((result) => {
    const first = result.categoryPath?.[0];
    return first && first !== "待整理";
  });
  const topLevelCounts = countBy(validResults, (result) => result.categoryPath?.[0]);
  const hasTopLevelOverflow = topLevelCounts.size > settings.maxTopLevelFolders;
  const protectedTopLevels = getProtectedTopLevelFolders(habitProfile).filter((folder) => topLevelCounts.has(folder));
  const allowedTopLevels = topKeys(
    topLevelCounts,
    hasTopLevelOverflow && settings.maxTopLevelFolders > 1
      ? settings.maxTopLevelFolders - 1
      : settings.maxTopLevelFolders
  );
  for (const folder of protectedTopLevels.slice(0, Math.max(1, settings.maxTopLevelFolders - 1))) {
    allowedTopLevels.add(folder);
  }
  while (allowedTopLevels.size > Math.max(1, settings.maxTopLevelFolders - 1) && hasTopLevelOverflow) {
    const removable = [...allowedTopLevels].reverse().find((folder) => !protectedTopLevels.includes(folder));
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
  const result = await generateMovePlanPreviewForBookmarks(urlBookmarks);
  return result.movePlans;
}

export async function generateMovePlanPreviewForBookmarks(
  urlBookmarks: Awaited<ReturnType<typeof getAllBookmarks>>,
  organizeMode: OrganizeMode = "quick",
  options: { signal?: AbortSignal; onProgress?: PreviewProgressReporter; progressStartedAt?: number } = {}
): Promise<{ movePlans: MovePlan[]; tokenUsage?: TokenUsage }> {
  const [settings, habitProfile] = await Promise.all([
    getSettings(),
    getFolderHabitProfile(),
  ]);
  const results = new Map<string, ClassificationResult>();
  const failureReasons = new Map<string, string>();
  const tokenUsage = createTokenUsage();
  const emitProgress = createProgressEmitter(options.onProgress, options.progressStartedAt);
  let completedBatches = 0;
  let processedBookmarks = 0;
  let totalBatches = 0;

  const reportProgress = async (phase: PreviewTaskProgress["phase"], currentBatchSize?: number) => {
    await emitProgress({
      phase,
      completedBatches,
      totalBatches,
      processedBookmarks,
      totalBookmarks: urlBookmarks.length,
      currentBatchSize,
    });
  };

  if (urlBookmarks.length && settings.provider.apiKey) {
    // 阶段一：采样首次分类，建立统一分类体系
    const sampleSize = Math.min(30, urlBookmarks.length);
    const sample = urlBookmarks.slice(0, sampleSize);
    const restBookmarks = urlBookmarks.slice(sampleSize);
    const sampleBatches = chunkBookmarks(sample, 20);
    const restBatches = chunkBookmarks(restBookmarks, 20);
    let existingCategories: string[] = [];
    totalBatches = sampleBatches.length + restBatches.length;

    const classifyBatch = async (batch: typeof urlBookmarks, existingCategoriesForBatch?: string[]) => {
      throwIfAborted(options.signal);
      await reportProgress("preparing", batch.length);
      const aiBookmarks = await prepareBookmarksForAI(batch, settings.sendFullUrl, organizeMode, options.signal);
      throwIfAborted(options.signal);
      try {
        const requestedIds = new Set(batch.map((b) => b.id));
        const aiResults = await classifyWithAI(settings.provider, aiBookmarks, {
          allowNestedFolders: settings.allowNestedFolders,
          maxTopLevelFolders: settings.maxTopLevelFolders,
          maxSubfoldersPerFolder: settings.maxSubfoldersPerFolder,
          habitProfile,
          customPrompt: settings.customPrompt,
          existingCategories: existingCategoriesForBatch?.length ? existingCategoriesForBatch : undefined,
          signal: options.signal,
          onTokenUsage: (usage) => addTokenUsage(tokenUsage, usage),
          onStage: (stage) => reportProgress(stage, batch.length),
        });
        throwIfAborted(options.signal);
        appendMetadataReasons(aiResults, aiBookmarks);
        for (const result of aiResults) {
          if (requestedIds.has(result.id)) results.set(result.id, result);
        }

        const metadataReasons = new Map(aiBookmarks.map((bookmark) => [bookmark.id, metadataReason(bookmark)]));
        for (const b of batch) {
          if (!requestedIds.has(b.id)) continue;
          if (!results.has(b.id)) {
            failureReasons.set(b.id, appendReason("AI 未返回此书签的分类结果", metadataReasons.get(b.id)));
          }
        }
      } catch (error) {
        throwIfAborted(options.signal);
        const reason = classificationFailureReason(error);
        const metadataReasons = new Map(aiBookmarks.map((bookmark) => [bookmark.id, metadataReason(bookmark)]));
        for (const b of batch) failureReasons.set(b.id, appendReason(reason, metadataReasons.get(b.id)));
      }

      completedBatches += 1;
      processedBookmarks += batch.length;
      await reportProgress("parsing_results");
    };

    // 先分类采样
    for (const batch of sampleBatches) {
      await classifyBatch(batch);
    }

    // 提取已有的分类体系
    existingCategories = extractCategoryScheme(results);

    // 阶段二：用已有分类体系约束后续批次
    for (const batch of restBatches) {
      await classifyBatch(batch, existingCategories);
    }
  } else if (urlBookmarks.length) {
    for (const bookmark of urlBookmarks) {
      failureReasons.set(bookmark.id, "未配置 API Key，无法调用 AI");
    }
  }

  if (!settings.provider.apiKey) processedBookmarks = urlBookmarks.length;
  await reportProgress("generating_preview");
  compactClassificationResults(results, settings, habitProfile);

  const seenUrls = new Map<string, string>();

  const movePlans = urlBookmarks.map((bookmark) => {
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

  return {
    movePlans,
    tokenUsage: tokenUsage.totalTokens > 0 ? tokenUsage : undefined,
  };
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

async function saveBackupHistoryBestEffort(backup: BookmarkBackup) {
  try {
    await saveBackupToHistory(backup);
  } catch {
    // 整理前的 lastBackup 是撤销所需的关键保护点；历史列表写入失败不应阻断整理流程。
  }
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

async function cleanupAllEmptyFolders(): Promise<number> {
  const folders = await findAllFolderSnapshots();
  return cleanupEmptyFolders(new Set(folders.map((folder) => folder.id)));
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

async function findAllFolderSnapshots(): Promise<Array<{ id: string; path: string[] }>> {
  return collectFolderPaths(await getBookmarkTree());
}

export async function executeMovePlans(
  plans: MovePlan[],
  tokenUsage?: TokenUsage,
  options: { cleanupAllEmptyFolders?: boolean; reportKind?: OrganizeReport["kind"] } = {}
): Promise<OrganizeReport> {
  const [tree, settings] = await Promise.all([getBookmarkTree(), getSettings()]);
  const backupStats = getBookmarkTreeStats(tree);

  // 记录执行前的文件夹
  const foldersBefore = await findAllFolderIds();
  const backup: BookmarkBackup = {
    id: `backup-${Date.now()}`,
    kind: "organize",
    createdAt: Date.now(),
    tree,
    ...backupStats,
    movePlan: plans,
  };

  await saveLastBackup(backup);
  await saveBackupHistoryBestEffort(backup);

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
  const foldersAfterMove = await findAllFolderSnapshots();
  const createdTargetFolderIds = new Set(
    foldersAfterMove.filter((folder) => !foldersBefore.has(folder.id)).map((folder) => folder.id)
  );
  if (createdTargetFolderIds.size > 0) {
    removedFolders += await cleanupEmptyFolders(createdTargetFolderIds);
  }
  const createdTargetFolders = (await findAllFolderSnapshots()).filter(
    (folder) => !foldersBefore.has(folder.id)
  );
  const completedBackup = { ...backup, createdTargetFolders };
  await saveLastBackup(completedBackup);
  await saveBackupHistoryBestEffort(completedBackup);

  if (options.cleanupAllEmptyFolders) {
    removedFolders += await cleanupAllEmptyFolders();
  }

  const report: OrganizeReport = {
    id: `report-${Date.now()}`,
    kind: options.reportKind ?? "organize",
    createdAt: Date.now(),
    movedCount,
    folderCount: uniqueFolderCount(plans),
    removedFolders,
    failedItems,
    movePlan: plans,
    privacySummary: privacySummary(settings),
    tokenUsage,
  };

  await saveReportToHistory(report);
  return report;
}

export async function undoLastOrganize(): Promise<OrganizeReport | null> {
  const backup = await getLastBackup();
  if (!backup) return null;
  const movePlan = backup.movePlan ?? [];
  if (movePlan.length === 0) return null;

  const failedItems: FailedMove[] = [];
  let movedCount = 0;

  for (const plan of movePlan) {
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

  const removedFolders = await cleanupAllEmptyFolders();

  const report: OrganizeReport = {
    id: `undo-${Date.now()}`,
    kind: "undo",
    createdAt: Date.now(),
    movedCount,
    folderCount: uniqueFolderCount(movePlan),
    removedFolders,
    failedItems,
    movePlan,
    privacySummary: ["已按最近一次备份尝试恢复原位置"],
    undone: true,
  };

  await saveReportToHistory(report);
  return report;
}

export async function reapplyLastOrganize(): Promise<OrganizeReport | null> {
  const backup = await getLastBackup();
  if (!backup) return null;
  const movePlan = backup.movePlan ?? [];
  if (movePlan.length === 0) return null;

  return executeMovePlans(movePlan, undefined, {
    cleanupAllEmptyFolders: true,
    reportKind: "reapply",
  });
}

export async function createPendingRecommendation(bookmark: chrome.bookmarks.BookmarkTreeNode) {
  if (!bookmark.url) return null;

  const settings = await getSettings();
  const currentBookmark = await getBookmark(bookmark.id);
  if (!currentBookmark?.url) return null;
  const bookmarkNode = {
    id: currentBookmark.id,
    parentId: currentBookmark.parentId,
    title: currentBookmark.title,
    url: currentBookmark.url,
    path: [],
    type: "url" as const,
  };

  let classification = fallbackResult(bookmark.id, "新增书签等待 AI 分类");

  if (settings.provider.apiKey) {
    let aiBookmark: BookmarkForAI | undefined;
    try {
      [aiBookmark] = await prepareBookmarksForAI([bookmarkNode], settings.sendFullUrl, "quick");
      const [aiResult] = await classifyWithAI(settings.provider, [
        aiBookmark,
      ], {
        allowNestedFolders: settings.allowNestedFolders,
        maxTopLevelFolders: settings.maxTopLevelFolders,
        maxSubfoldersPerFolder: settings.maxSubfoldersPerFolder,
        habitProfile: await getFolderHabitProfile(),
        customPrompt: settings.customPrompt,
      });
      if (aiResult) {
        aiResult.reason = appendReason(aiResult.reason, metadataReason(aiBookmark));
        classification = aiResult;
      }
    } catch (error) {
      classification.reason = appendReason(classificationFailureReason(error), metadataReason(aiBookmark), classification.reason);
      // AI 分类失败时保留待整理建议
    }
  }

  const latestBookmark = await getBookmark(currentBookmark.id);
  if (!latestBookmark?.url) return null;

  const recommendation: PendingRecommendation = {
    id: `rec-${Date.now()}-${latestBookmark.id}`,
    bookmarkId: latestBookmark.id,
    bookmarkTitle: latestBookmark.title,
    bookmarkUrl: latestBookmark.url,
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
  await savePendingRecommendations([
    recommendation,
    ...recommendations.filter((item) => item.bookmarkId !== latestBookmark.id),
  ]);

  const savedBookmark = await getBookmark(latestBookmark.id);
  if (!savedBookmark?.url) {
    const savedRecommendations = await getPendingRecommendations();
    await savePendingRecommendations(savedRecommendations.filter((item) => item.bookmarkId !== latestBookmark.id));
    return null;
  }

  return recommendation;
}
