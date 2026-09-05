import type { MovePlan, OrganizeReport, PendingRecommendation } from "../types";
import { getBookmark, normalizeFolderPath } from "./bookmarks";
import { executeMovePlans } from "./organizer";
import { getSettings, getPendingRecommendations, savePendingRecommendations } from "./storage";

function hasChromeAction() {
  return typeof chrome !== "undefined" && Boolean(chrome.action);
}

function hasChromeBookmarks() {
  return typeof chrome !== "undefined" && Boolean(chrome.bookmarks);
}

async function bookmarkExists(bookmarkId: string) {
  const bookmark = await getBookmark(bookmarkId);
  return Boolean(bookmark?.url);
}

export async function getActivePendingRecommendations() {
  const recommendations = await getPendingRecommendations();
  if (!hasChromeBookmarks() || recommendations.length === 0) return recommendations;

  const checks = await Promise.all(
    recommendations.map(async (recommendation) => ({
      recommendation,
      exists: await bookmarkExists(recommendation.bookmarkId),
    }))
  );
  const activeRecommendations = checks
    .filter((check) => check.exists)
    .map((check) => check.recommendation);

  if (activeRecommendations.length !== recommendations.length) {
    const removedBookmarkIds = new Set(
      checks
        .filter((check) => !check.exists)
        .map((check) => check.recommendation.bookmarkId)
    );
    const latestRecommendations = await getPendingRecommendations();
    const nextRecommendations = latestRecommendations.filter(
      (recommendation) => !removedBookmarkIds.has(recommendation.bookmarkId)
    );
    await savePendingRecommendations(nextRecommendations);
    return nextRecommendations;
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
  const recommendations = await getPendingRecommendations();
  const next = recommendations.filter((recommendation) => recommendation.id !== id);
  await savePendingRecommendations(next);
  await updateRecommendationBadge();
  return next;
}

export async function removeRecommendationsForBookmark(bookmarkId: string) {
  const recommendations = await getPendingRecommendations();
  const next = recommendations.filter((recommendation) => recommendation.bookmarkId !== bookmarkId);
  if (next.length === recommendations.length) return recommendations;

  await savePendingRecommendations(next);
  await updateRecommendationBadge();
  return next;
}

export async function updateRecommendationFolderPath(id: string, folderPath: string[]) {
  const settings = await getSettings();
  const safeFolderPath = normalizeFolderPath(folderPath, settings.maxNestingLevel);
  if (safeFolderPath.length === 0) {
    throw new Error("请填写目标文件夹");
  }

  const recommendations = await getPendingRecommendations();
  let matched = false;
  const next = recommendations.map((recommendation) => {
    if (recommendation.id !== id) return recommendation;
    matched = true;
    return {
      ...recommendation,
      suggestedFolderPath: safeFolderPath,
    };
  });

  if (!matched) {
    throw new Error("推荐已不存在");
  }

  await savePendingRecommendations(next);
  await updateRecommendationBadge();
  return next;
}

async function removeCompletedRecommendations(ids: Set<string>) {
  if (ids.size === 0) return getPendingRecommendations();

  const recommendations = await getPendingRecommendations();
  const next = recommendations.filter((recommendation) => !ids.has(recommendation.id));
  await savePendingRecommendations(next);
  await updateRecommendationBadge();
  return next;
}

export async function acceptRecommendations(
  recommendations: PendingRecommendation[]
): Promise<OrganizeReport> {
  if (recommendations.length === 0) {
    throw new Error("没有可接受的推荐");
  }

  const bookmarks = await Promise.all(
    recommendations.map((recommendation) => getBookmark(recommendation.bookmarkId))
  );
  const missingRecommendationIds = new Set<string>();
  const plans: MovePlan[] = recommendations.map((recommendation, index) => {
    const bookmark = bookmarks[index];
    if (hasChromeBookmarks() && !bookmark?.url) {
      missingRecommendationIds.add(recommendation.id);
    }

    return {
      bookmarkId: recommendation.bookmarkId,
      bookmarkTitle: bookmark?.title ?? recommendation.bookmarkTitle,
      bookmarkUrl: bookmark?.url ?? recommendation.bookmarkUrl,
      fromParentId: bookmark?.parentId ?? "1",
      fromIndex: bookmark?.index,
      toFolderPath: recommendation.suggestedFolderPath,
      confidence: recommendation.confidence,
      reason: recommendation.reason,
    };
  });

  const report = await executeMovePlans(plans, undefined, { reportKind: "recommendation" });
  const failedBookmarkIds = new Set(report.failedItems.map((item) => item.bookmarkId));
  const completedRecommendationIds = new Set(
    recommendations
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
