declare const __REMARKS_BROWSER_TARGET__: "chromium" | "firefox";

import { createPendingRecommendation } from "@/app/services/organizer";
import { handleLinkHealthScanMessage, isLinkHealthScanMessage } from "@/app/services/bookmarkTasks";
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

type FirefoxSidebarAction = {
  open: () => Promise<void>;
};

type FirefoxBrowserApi = {
  sidebarAction?: FirefoxSidebarAction;
};

const firefoxSidebarAction = (globalThis as typeof globalThis & { browser?: FirefoxBrowserApi }).browser?.sidebarAction;

if (__REMARKS_BROWSER_TARGET__ === "chromium" && chrome.sidePanel?.setPanelBehavior) {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} else if (firefoxSidebarAction && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(() => {
    void firefoxSidebarAction.open().catch(() => undefined);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isLinkHealthScanMessage(message)) {
    void handleLinkHealthScanMessage(message)
      .then((report) => {
        sendResponse({ report });
      })
      .catch((error: unknown) => {
        sendResponse({
          error: error instanceof Error ? error.message : "链接检测任务处理失败",
        });
      });

    return true;
  }

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
