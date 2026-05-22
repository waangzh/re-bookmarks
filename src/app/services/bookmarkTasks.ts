import type {
  BookmarkLinkHealthReport,
  BookmarkLinkHealthResult,
  BookmarkNode,
  PendingRecommendation,
} from "../types";
import { saveLinkHealthReport } from "./storage";

const AUTH_OR_RATE_LIMIT_STATUSES = new Set([401, 403, 429]);
const INVALID_STATUSES = new Set([404, 410, 451]);
const REQUEST_TIMEOUT_MS = 8000;
const LINK_CHECK_CONCURRENCY = 4;

export function normalizeBookmarkUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

export function isUnsortedBookmark(bookmark: BookmarkNode) {
  if (!bookmark.path.length) return true;
  return bookmark.path.some((part) => /待整理|未分类|unsorted/i.test(part));
}

export function getUnsortedTaskCount(bookmarks: BookmarkNode[], recommendations: PendingRecommendation[]) {
  const ids = new Set<string>();
  bookmarks.filter(isUnsortedBookmark).forEach((bookmark) => ids.add(bookmark.id));
  recommendations.forEach((recommendation) => ids.add(recommendation.bookmarkId));
  return ids.size;
}

export function getDuplicateUrlCounts(bookmarks: BookmarkNode[]) {
  const counts = new Map<string, number>();
  bookmarks.forEach((bookmark) => {
    if (!bookmark.url) return;
    const key = normalizeBookmarkUrl(bookmark.url);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

export function getDuplicateUrlKeys(bookmarks: BookmarkNode[]) {
  return new Set(
    [...getDuplicateUrlCounts(bookmarks).entries()]
      .filter(([, count]) => count > 1)
      .map(([url]) => url)
  );
}

export function countDuplicateGroups(bookmarks: BookmarkNode[]) {
  return [...getDuplicateUrlCounts(bookmarks).values()].filter((count) => count > 1).length;
}

export function filterDuplicateBookmarks(bookmarks: BookmarkNode[]) {
  const duplicateUrls = getDuplicateUrlKeys(bookmarks);
  return bookmarks.filter((bookmark) => bookmark.url && duplicateUrls.has(normalizeBookmarkUrl(bookmark.url)));
}

function isHttpBookmark(bookmark: BookmarkNode) {
  return Boolean(bookmark.url && /^https?:\/\//i.test(bookmark.url));
}

function isReachableStatus(status: number) {
  if (status >= 200 && status < 400) return true;
  return AUTH_OR_RATE_LIMIT_STATUSES.has(status);
}

function statusReason(status: number) {
  if (INVALID_STATUSES.has(status)) return `HTTP ${status}`;
  if (status >= 500) return `服务器错误 ${status}`;
  return `HTTP ${status}`;
}

async function fetchWithTimeout(url: string, method: "HEAD" | "GET") {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    void response.body?.cancel();
    return response;
  } finally {
    window.clearTimeout(timer);
  }
}

function toNetworkReason(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "请求超时";
  return error instanceof Error && error.message ? error.message : "网络请求失败";
}

async function checkOneBookmark(bookmark: BookmarkNode): Promise<BookmarkLinkHealthResult> {
  const checkedAt = Date.now();

  if (!bookmark.url || !isHttpBookmark(bookmark)) {
    return {
      bookmarkId: bookmark.id,
      bookmarkTitle: bookmark.title,
      bookmarkUrl: bookmark.url ?? "",
      checkedAt,
      status: "skipped",
      reason: "仅检测 http/https 链接",
    };
  }

  try {
    const headResponse = await fetchWithTimeout(bookmark.url, "HEAD");
    if (isReachableStatus(headResponse.status)) {
      return {
        bookmarkId: bookmark.id,
        bookmarkTitle: bookmark.title,
        bookmarkUrl: bookmark.url,
        checkedAt,
        status: "ok",
        httpStatus: headResponse.status,
      };
    }

    if (headResponse.status === 405 || !INVALID_STATUSES.has(headResponse.status)) {
      const getResponse = await fetchWithTimeout(bookmark.url, "GET");
      return {
        bookmarkId: bookmark.id,
        bookmarkTitle: bookmark.title,
        bookmarkUrl: bookmark.url,
        checkedAt,
        status: isReachableStatus(getResponse.status) ? "ok" : "invalid",
        httpStatus: getResponse.status,
        reason: isReachableStatus(getResponse.status) ? undefined : statusReason(getResponse.status),
      };
    }

    return {
      bookmarkId: bookmark.id,
      bookmarkTitle: bookmark.title,
      bookmarkUrl: bookmark.url,
      checkedAt,
      status: "invalid",
      httpStatus: headResponse.status,
      reason: statusReason(headResponse.status),
    };
  } catch (headError) {
    try {
      const getResponse = await fetchWithTimeout(bookmark.url, "GET");
      return {
        bookmarkId: bookmark.id,
        bookmarkTitle: bookmark.title,
        bookmarkUrl: bookmark.url,
        checkedAt,
        status: isReachableStatus(getResponse.status) ? "ok" : "invalid",
        httpStatus: getResponse.status,
        reason: isReachableStatus(getResponse.status) ? undefined : statusReason(getResponse.status),
      };
    } catch (getError) {
      return {
        bookmarkId: bookmark.id,
        bookmarkTitle: bookmark.title,
        bookmarkUrl: bookmark.url,
        checkedAt,
        status: "invalid",
        reason: `${toNetworkReason(headError)}；${toNetworkReason(getError)}`,
      };
    }
  }
}

export async function checkBookmarkLinks(
  bookmarks: BookmarkNode[],
  onProgress?: (checked: number, total: number) => void
): Promise<BookmarkLinkHealthReport> {
  const results: BookmarkLinkHealthResult[] = [];
  const total = bookmarks.length;
  let nextIndex = 0;
  let checked = 0;

  const worker = async () => {
    while (nextIndex < bookmarks.length) {
      const bookmark = bookmarks[nextIndex];
      nextIndex += 1;
      results.push(await checkOneBookmark(bookmark));
      checked += 1;
      onProgress?.(checked, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(LINK_CHECK_CONCURRENCY, Math.max(1, bookmarks.length)) }, worker)
  );

  const report: BookmarkLinkHealthReport = {
    id: `link-health-${Date.now()}`,
    createdAt: Date.now(),
    checkedCount: results.filter((result) => result.status !== "skipped").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    invalidCount: results.filter((result) => result.status === "invalid").length,
    results,
  };

  await saveLinkHealthReport(report);
  return report;
}
