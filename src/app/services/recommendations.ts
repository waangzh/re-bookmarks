import type { PendingRecommendation } from "../types";
import { ensureFolderPath, moveBookmark } from "./bookmarks";
import { getSettings, getPendingRecommendations, savePendingRecommendations } from "./storage";

function hasChromeAction() {
  return typeof chrome !== "undefined" && Boolean(chrome.action);
}

export async function updateRecommendationBadge() {
  if (!hasChromeAction()) return;
  const count = (await getPendingRecommendations()).length;
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

export async function acceptRecommendation(recommendation: PendingRecommendation) {
  const settings = await getSettings();
  const parentId = await ensureFolderPath(recommendation.suggestedFolderPath, settings.maxNestingLevel);
  await moveBookmark(recommendation.bookmarkId, parentId);
  return removeRecommendation(recommendation.id);
}
