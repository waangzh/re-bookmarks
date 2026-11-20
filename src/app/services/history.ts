import type { FrequentBookmark } from "../types";
import { getAllBookmarks } from "./bookmarks";

const FREQUENT_BOOKMARK_LIMIT = 20;
const HISTORY_LOOKBACK_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FRECENCY_HALF_LIFE_DAYS = 14;
const TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "spm",
  "spm_id_from",
  "vd_source",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
  "ref_src",
  "ref_url",
]);

function isTrackingQueryParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(lower);
}

function getHistoryMatchKeys(url: string): { trackingOnly: string; relaxed: string } {
  const trimmed = url.trim();
  const unchanged = { trackingOnly: trimmed, relaxed: trimmed };
  if (!trimmed) return unchanged;

  try {
    const parsed = new URL(trimmed);
    if (!parsed.host && !trimmed.startsWith(`${parsed.protocol}//`)) return unchanged;

    const retainedQuery = parsed.search.slice(1).split("&").filter((part) => {
      const name = new URLSearchParams(`?${part}`).keys().next().value;
      return name === undefined || !isTrackingQueryParam(name);
    }).join("&");
    parsed.search = retainedQuery;
    const trackingOnly = parsed.href;

    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.searchParams.sort();
    if (!parsed.hash.startsWith("#/") && !parsed.hash.startsWith("#!/")) parsed.hash = "";
    return { trackingOnly, relaxed: parsed.href };
  } catch {
    return unchanged;
  }
}

/**
 * Normalize a URL for local history-to-bookmark matching.
 * Keeps semantic query parameters and SPA route hashes (#/ or #!/),
 * while stripping common tracking params, ordinary anchors, and trailing slashes.
 */
export function normalizeHistoryMatchUrl(url: string): string {
  return getHistoryMatchKeys(url).relaxed;
}

/**
 * Compute a lightweight Frecency score combining smoothed visit frequency
 * with exponential recency decay.
 */
export function calculateFrequentBookmarkScore(visitCount: number, lastVisit: number, now = Date.now()): number {
  if (!Number.isFinite(visitCount) || visitCount <= 0) return 0;
  if (!Number.isFinite(lastVisit) || lastVisit <= 0) return 0;

  const ageDays = Math.max(0, now - lastVisit) / MS_PER_DAY;
  // log1p dampens lifetime-accumulated visitCount from chrome.history.search,
  // while exponential decay lets recently active bookmarks surface over stale ones.
  return Math.log1p(visitCount) * Math.pow(0.5, ageDays / FRECENCY_HALF_LIFE_DAYS);
}

function hasChromeHistory() {
  return typeof chrome !== "undefined" && Boolean(chrome.history);
}

function hasChromePermissions() {
  return typeof chrome !== "undefined" && Boolean(chrome.permissions);
}

export async function hasHistoryPermission() {
  if (!hasChromePermissions()) return false;
  return new Promise<boolean>((resolve) => {
    chrome.permissions.contains({ permissions: ["history"] }, (granted) => {
      resolve(!chrome.runtime.lastError && granted);
    });
  });
}

export async function requestHistoryPermission() {
  if (!hasChromePermissions()) return false;
  return new Promise<boolean>((resolve) => {
    chrome.permissions.request({ permissions: ["history"] }, (granted) => {
      resolve(!chrome.runtime.lastError && granted);
    });
  });
}

async function searchHistory(now = Date.now()) {
  if (!hasChromeHistory()) return [];
  const startTime = now - HISTORY_LOOKBACK_DAYS * MS_PER_DAY;

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

export async function getFrequentBookmarks(now = Date.now()): Promise<FrequentBookmark[]> {
  const [bookmarks, historyItems] = await Promise.all([getAllBookmarks(), searchHistory(now)]);
  type Bookmark = (typeof bookmarks)[number];
  const exactByUrl = new Map<string, Bookmark>();
  const trackingOnlyByUrl = new Map<string, Bookmark | null>();
  const relaxedByUrl = new Map<string, Bookmark | null>();
  const addCandidate = (index: Map<string, Bookmark | null>, key: string, bookmark: Bookmark) => {
    const previous = index.get(key);
    index.set(key, previous === undefined || previous?.url === bookmark.url ? bookmark : null);
  };

  for (const bookmark of bookmarks) {
    if (!bookmark.url) continue;
    exactByUrl.set(bookmark.url, bookmark);
    const keys = getHistoryMatchKeys(bookmark.url);
    addCandidate(trackingOnlyByUrl, keys.trackingOnly, bookmark);
    addCandidate(relaxedByUrl, keys.relaxed, bookmark);
  }

  const byBookmarkId = new Map<string, FrequentBookmark>();

  for (const item of historyItems) {
    if (!item.url) continue;
    let bookmark = exactByUrl.get(item.url);
    if (!bookmark) {
      const keys = getHistoryMatchKeys(item.url);
      const trackingMatch = trackingOnlyByUrl.get(keys.trackingOnly);
      bookmark = (trackingMatch === undefined ? relaxedByUrl.get(keys.relaxed) : trackingMatch) ?? undefined;
    }
    if (!bookmark?.url) continue;
    const existing = byBookmarkId.get(bookmark.id);
    const visitCount = item.visitCount ?? 0;
    if (existing) {
      existing.visitCount += visitCount;
      existing.lastVisit = Math.max(existing.lastVisit, item.lastVisitTime ?? 0);
    } else {
      byBookmarkId.set(bookmark.id, {
        id: bookmark.id,
        title: bookmark.title,
        url: bookmark.url,
        visitCount,
        lastVisit: item.lastVisitTime ?? 0,
        currentFolder: bookmark.path.join(" / ") || "根目录",
      });
    }
  }

  return [...byBookmarkId.values()]
    .filter((bookmark) => bookmark.visitCount > 0)
    .sort((a, b) => {
      const scoreDiff =
        calculateFrequentBookmarkScore(b.visitCount, b.lastVisit, now) -
        calculateFrequentBookmarkScore(a.visitCount, a.lastVisit, now);
      if (Math.abs(scoreDiff) > 1e-12) return scoreDiff;
      if (b.lastVisit !== a.lastVisit) return b.lastVisit - a.lastVisit;
      return b.visitCount - a.visitCount;
    })
    .slice(0, FREQUENT_BOOKMARK_LIMIT);
}
