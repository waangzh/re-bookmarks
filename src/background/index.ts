import { createPendingRecommendation } from "@/app/services/organizer";
import { handlePreviewTaskMessage, isPreviewTaskMessage } from "@/app/services/previewTask";
import { removeRecommendationsForBookmark, updateRecommendationBadge } from "@/app/services/recommendations";

chrome.bookmarks.onCreated.addListener((_id, bookmark) => {
  if (bookmark.url) {
    void createPendingRecommendation(bookmark).then(() => updateRecommendationBadge());
  }
});

chrome.bookmarks.onRemoved.addListener((id) => {
  void removeRecommendationsForBookmark(id);
});

void updateRecommendationBadge();

if (chrome.sidePanel?.setPanelBehavior) {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isPreviewTaskMessage(message)) return false;

  void handlePreviewTaskMessage(message)
    .then((task) => {
      sendResponse({ task });
    })
    .catch((error: unknown) => {
      sendResponse({
        error: error instanceof Error ? error.message : "预览任务处理失败",
      });
    });

  return true;
});

export {};
