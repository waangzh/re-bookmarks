import type { MovePlan, OrganizeReport, PendingRecommendation } from "../types";
import {
  type BrowserBookmarkNode,
  getBookmark,
  getBookmarkRootFolderIds,
  getBookmarkTree,
  isBookmarkFolder,
  isRootFolder,
  normalizeFolderPath,
} from "./bookmarks";
import { createPendingRecommendation, executeMovePlans } from "./organizer";
import { getSettings, getPendingRecommendations, updatePendingRecommendations } from "./storage";
import { ensureRequiredHostPermission } from "./hostPermissions";
import { getCurrentWhitelist, isProtectedTargetPath } from "./whitelist";

function hasChromeAction() {
  return typeof chrome !== "undefined" && Boolean(chrome.action);
}

function hasChromeBookmarks() {
  return typeof chrome !== "undefined" && Boolean(chrome.bookmarks);
}

export function getRecommendationKind(recommendation: PendingRecommendation) {
  if (recommendation.kind) return recommendation.kind;
  const firstFolder = recommendation.suggestedFolderPath[0]?.trim();
  if (recommendation.confidence < 0.55 || firstFolder === "待整理" || firstFolder === "未分类") {
    return "manual_review" as const;
  }
  return "move" as const;
}

export function isActionableRecommendation(recommendation: PendingRecommendation) {
  const kind = getRecommendationKind(recommendation);
  return (kind === "move" || kind === "create_folder") && recommendation.suggestedFolderPath.length > 0;
}

function pathKey(path: string[]) {
  return normalizeFolderPath(path, Math.max(1, path.length)).join("\u0000");
}

function collectFolderPathKeys(tree: BrowserBookmarkNode[]) {
  const keys = new Set<string>();
  const rootFolderIds = getBookmarkRootFolderIds(tree);

  function visit(nodes: BrowserBookmarkNode[], path: string[]) {
    for (const node of nodes) {
      if (!isBookmarkFolder(node)) continue;
      const isRoot = isRootFolder(node.id, rootFolderIds);
      const currentPath = isRoot ? path : [...path, node.title];
      if (!isRoot && currentPath.length > 0) keys.add(pathKey(currentPath));
      if (node.children) visit(node.children as BrowserBookmarkNode[], currentPath);
    }
  }

  visit(tree, []);
  return keys;
}

async function bookmarkExists(bookmarkId: string) {
  const bookmark = await getBookmark(bookmarkId);
  return Boolean(bookmark?.url);
}

export async function getActivePendingRecommendations() {
  const recommendations = await getPendingRecommendations();
  if (!hasChromeBookmarks() || recommendations.length === 0) return recommendations;

  const protection = await getCurrentWhitelist();
  const checks = await Promise.all(
    recommendations.map(async (recommendation) => ({
      recommendation,
      active: await bookmarkExists(recommendation.bookmarkId) &&
        !protection.index.protectedBookmarkIds.has(recommendation.bookmarkId) &&
        !isProtectedTargetPath(recommendation.suggestedFolderPath, protection.tree, protection.index),
    }))
  );
  const activeRecommendations = checks
    .filter((check) => check.active)
    .map((check) => check.recommendation);

  if (activeRecommendations.length !== recommendations.length) {
    const removedRecommendationIds = new Set(
      checks.filter((check) => !check.active).map((check) => check.recommendation.id)
    );
    return updatePendingRecommendations((latestRecommendations) =>
      latestRecommendations.filter((recommendation) => !removedRecommendationIds.has(recommendation.id))
    );
  }

  return activeRecommendations;
}

export async function updateRecommendationBadge() {
  if (!hasChromeAction()) return;
  const count = (await getActivePendingRecommendations()).length;
  chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

export async function removeRecommendation(id: string) {
  const next = await updatePendingRecommendations((recommendations) =>
    recommendations.filter((recommendation) => recommendation.id !== id)
  );
  await updateRecommendationBadge();
  return next;
}

export async function removeRecommendationsForBookmark(bookmarkId: string) {
  const next = await updatePendingRecommendations((recommendations) => {
    const filtered = recommendations.filter((recommendation) => recommendation.bookmarkId !== bookmarkId);
    return filtered.length === recommendations.length ? recommendations : filtered;
  });
  await updateRecommendationBadge();
  return next;
}

export async function updateRecommendationFolderPath(id: string, folderPath: string[]) {
  const settings = await getSettings();
  const safeFolderPath = normalizeFolderPath(folderPath, settings.maxNestingLevel);
  if (safeFolderPath.length === 0) {
    throw new Error("请填写目标文件夹");
  }

  const tree = await getBookmarkTree();
  const existingPathKeys = collectFolderPathKeys(tree);
  let matched = false;
  const next = await updatePendingRecommendations((recommendations) =>
    recommendations.map((recommendation) => {
      if (recommendation.id !== id) return recommendation;
      matched = true;
      return {
        ...recommendation,
        suggestedFolderPath: safeFolderPath,
        kind: existingPathKeys.has(pathKey(safeFolderPath)) ? "move" as const : "create_folder" as const,
        errorCode: undefined,
        reason: "已由用户指定目标目录",
        confidence: 1,
      };
    })
  );

  if (!matched) {
    throw new Error("推荐已不存在");
  }
  await updateRecommendationBadge();
  return next;
}

export async function retryRecommendation(recommendation: PendingRecommendation) {
  const settings = await getSettings();
  if (settings.provider.apiKey && settings.provider.enabled) {
    await ensureRequiredHostPermission();
  }
  const bookmark = await getBookmark(recommendation.bookmarkId);
  if (!bookmark?.url) {
    await removeRecommendation(recommendation.id);
    throw new Error("书签已不存在");
  }

  const next = await createPendingRecommendation(bookmark);
  await updateRecommendationBadge();
  return next;
}

async function removeCompletedRecommendations(ids: Set<string>) {
  if (ids.size === 0) return getPendingRecommendations();

  const next = await updatePendingRecommendations((recommendations) =>
    recommendations.filter((recommendation) => !ids.has(recommendation.id))
  );
  await updateRecommendationBadge();
  return next;
}

export async function acceptRecommendations(
  recommendations: PendingRecommendation[]
): Promise<OrganizeReport> {
  const actionableRecommendations = recommendations.filter(isActionableRecommendation);
  if (actionableRecommendations.length === 0) {
    throw new Error("没有可执行的归档建议；需要判断或分类失败的项目会保持原位");
  }

  const bookmarks = await Promise.all(
    actionableRecommendations.map((recommendation) => getBookmark(recommendation.bookmarkId))
  );
  const missingRecommendationIds = new Set<string>();
  const plans: MovePlan[] = actionableRecommendations.map((recommendation, index) => {
    const bookmark = bookmarks[index];
    if (hasChromeBookmarks() && !bookmark?.url) {
      missingRecommendationIds.add(recommendation.id);
    }

    return {
      bookmarkId: recommendation.bookmarkId,
      bookmarkTitle: bookmark?.title ?? recommendation.bookmarkTitle,
      bookmarkUrl: bookmark?.url ?? recommendation.bookmarkUrl,
      fromParentId: bookmark?.parentId ?? "",
      fromIndex: bookmark?.index,
      toFolderPath: recommendation.suggestedFolderPath,
      confidence: recommendation.confidence,
      reason: recommendation.reason,
    };
  });

  const report = await executeMovePlans(plans, undefined, { reportKind: "recommendation" });
  const failedBookmarkIds = new Set(report.failedItems.map((item) => item.bookmarkId));
  const completedRecommendationIds = new Set(
    actionableRecommendations
      .filter(
        (recommendation) =>
          missingRecommendationIds.has(recommendation.id) ||
          !failedBookmarkIds.has(recommendation.bookmarkId)
      )
      .map((recommendation) => recommendation.id)
  );
  await removeCompletedRecommendations(completedRecommendationIds);
  return report;
}

export function acceptRecommendation(recommendation: PendingRecommendation) {
  return acceptRecommendations([recommendation]);
}
