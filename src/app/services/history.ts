import type { FrequentBookmark } from "../types";
import { getAllBookmarks } from "./bookmarks";
import { sanitizeUrl } from "./rules";

function hasChromeHistory() {
  return typeof chrome !== "undefined" && Boolean(chrome.history);
}

function hasChromePermissions() {
  return typeof chrome !== "undefined" && Boolean(chrome.permissions);
}

export async function hasHistoryPermission() {
  if (!hasChromePermissions()) return false;
  return new Promise<boolean>((resolve) => {
    chrome.permissions.contains({ permissions: ["history"] }, resolve);
  });
}

export async function requestHistoryPermission() {
  if (!hasChromePermissions()) return false;
  return new Promise<boolean>((resolve) => {
    chrome.permissions.request({ permissions: ["history"] }, resolve);
  });
}

async function searchHistory() {
  if (!hasChromeHistory()) return [];
  const startTime = Date.now() - 90 * 24 * 60 * 60 * 1000;

  return new Promise<chrome.history.HistoryItem[]>((resolve) => {
    chrome.history.search({ text: "", startTime, maxResults: 10000 }, (items) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(items);
    });
  });
}

export async function getFrequentBookmarks(): Promise<FrequentBookmark[]> {
  const [bookmarks, historyItems] = await Promise.all([getAllBookmarks(), searchHistory()]);
  const byUrl = new Map(
    bookmarks
      .filter((bookmark) => bookmark.url)
      .map((bookmark) => [sanitizeUrl(bookmark.url ?? ""), bookmark])
  );

  return historyItems
    .flatMap((item) => {
      if (!item.url) return [];
      const bookmark = byUrl.get(sanitizeUrl(item.url));
      if (!bookmark?.url) return [];
      return [
        {
          id: bookmark.id,
          title: bookmark.title,
          url: bookmark.url,
          visitCount: item.visitCount ?? 0,
          lastVisit: item.lastVisitTime ?? 0,
          currentFolder: bookmark.path.join(" / ") || "书签栏",
        },
      ];
    })
    .filter((bookmark) => bookmark.visitCount > 0)
    .sort((a, b) => b.visitCount - a.visitCount)
    .slice(0, 50);
}
