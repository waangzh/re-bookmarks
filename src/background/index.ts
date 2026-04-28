import { createPendingRecommendation } from "@/app/services/organizer";
import { updateRecommendationBadge } from "@/app/services/recommendations";

chrome.bookmarks.onCreated.addListener((_id, bookmark) => {
  if (bookmark.url) {
    void createPendingRecommendation(bookmark).then(() => updateRecommendationBadge());
  }
});

void updateRecommendationBadge();

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;

  chrome.tabs.sendMessage(tab.id, { type: "remarks:open-floating-ui" }, () => {
    void chrome.runtime.lastError;
  });
});

export {};
