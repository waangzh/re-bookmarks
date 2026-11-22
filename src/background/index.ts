declare const __REMARKS_BROWSER_TARGET__: "chromium" | "firefox";

import { createPendingRecommendation, getPendingRecommendationAnalysisBookmarkIds } from "@/app/services/organizer";
import { handleLinkHealthScanMessage, isLinkHealthScanMessage } from "@/app/services/bookmarkTasks";
import { handlePreviewTaskMessage, isPreviewTaskMessage } from "@/app/services/previewTask";
import { removeRecommendationsForBookmark, updateRecommendationBadge } from "@/app/services/recommendations";
import {
  isOpenSidePanelMessage,
  isPendingAnalysisStatusMessage,
  PENDING_ANALYSIS_UPDATED_MESSAGE,
} from "@/app/services/sidePanel";

function notifyPendingAnalysisUpdated() {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  try {
    const result = chrome.runtime.sendMessage({ type: PENDING_ANALYSIS_UPDATED_MESSAGE }) as unknown;
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // Popup 未打开时无接收方，忽略即可
  }
}

chrome.bookmarks.onCreated.addListener((_id, bookmark) => {
  if (bookmark.url) {
    void createPendingRecommendation(bookmark)
      .then(() => updateRecommendationBadge())
      .catch(() => undefined)
      .finally(() => {
        notifyPendingAnalysisUpdated();
      });
  }
});

chrome.bookmarks.onRemoved.addListener((id) => {
  void removeRecommendationsForBookmark(id).catch(() => undefined);
});

void updateRecommendationBadge();

if (__REMARKS_BROWSER_TARGET__ === "chromium" && chrome.sidePanel?.setPanelBehavior) {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isPendingAnalysisStatusMessage(message)) {
    sendResponse({ bookmarkIds: getPendingRecommendationAnalysisBookmarkIds() });
    return false;
  }

  if (isOpenSidePanelMessage(message)) {
    if (chrome.sidePanel?.open && typeof message.windowId === "number") {
      void chrome.sidePanel
        .open({ windowId: message.windowId })
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          sendResponse({
            error: error instanceof Error ? error.message : "打开侧边栏失败",
          });
        });
      return true;
    }
    sendResponse({ error: "当前浏览器不支持直接打开侧边栏" });
    return false;
  }

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
