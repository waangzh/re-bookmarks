import type { PendingRecommendation } from "../types";
import { ensureFolderPath, getBookmark, moveBookmark } from "./bookmarks";
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

export async function acceptRecommendation(recommendation: PendingRecommendation) {
  if (hasChromeBookmarks() && !(await bookmarkExists(recommendation.bookmarkId))) {
    await removeRecommendation(recommendation.id);
    throw new Error("书签已不存在，已移除这条建议");
  }

  const settings = await getSettings();
  const parentId = await ensureFolderPath(recommendation.suggestedFolderPath, settings.maxNestingLevel);
  await moveBookmark(recommendation.bookmarkId, parentId);
  return removeRecommendation(recommendation.id);
}
