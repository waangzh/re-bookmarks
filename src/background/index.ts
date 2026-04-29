import { createPendingRecommendation } from "@/app/services/organizer";
import { updateRecommendationBadge } from "@/app/services/recommendations";

const popupCandidates = ["popup/index.html", "dist/popup/index.html"];
const floatingMessage = "remarks:open-floating-ui";

chrome.bookmarks.onCreated.addListener((_id, bookmark) => {
  if (bookmark.url) {
    void createPendingRecommendation(bookmark).then(() => updateRecommendationBadge());
  }
});

void updateRecommendationBadge();

async function resolvePopupPath() {
  for (const candidate of popupCandidates) {
    const url = chrome.runtime.getURL(candidate);
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return candidate;
    } catch {
      // Continue trying the next path. The extension can be loaded from either project root or dist.
    }
  }

  return "popup/index.html";
}

function canUseFloatingUi(url?: string) {
  if (!url) return false;

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
      return !["chrome.google.com", "chromewebstore.google.com"].includes(parsedUrl.hostname);
    }

    return parsedUrl.protocol === "file:";
  } catch {
    return false;
  }
}

async function updateActionMode(tabId: number, url?: string) {
  const popup = canUseFloatingUi(url) ? "" : await resolvePopupPath();
  const title = popup ? "打开 ReMarks" : "打开悬浮 ReMarks";

  await chrome.action.setPopup({ tabId, popup });
  await chrome.action.setTitle({ tabId, title });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId, (tab) => {
    void updateActionMode(tabId, tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  void updateActionMode(tabId, tab.url);
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;

  if (!canUseFloatingUi(tab.url)) {
    void updateActionMode(tab.id, tab.url);
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: floatingMessage }, () => {
    void chrome.runtime.lastError;
  });
});

export {};
