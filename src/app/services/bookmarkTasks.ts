import type {
  BookmarkLinkHealthReport,
  BookmarkLinkHealthResult,
  BookmarkNode,
  PendingRecommendation,
} from "../types";
import { saveLinkHealthReport } from "./storage";

const AUTH_OR_RATE_LIMIT_STATUSES = new Set([401, 403, 429]);
const BROKEN_STATUSES = new Set([404, 410, 451]);
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 800;
const GET_RETRY_COUNT = 1;
const LINK_CHECK_CONCURRENCY = 4;
const TRACKING_PARAM_PATTERNS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
];

export type DuplicateBookmarkMatchKind = "exact";

export type DuplicateBookmarkGroup = {
  id: string;
  kind: DuplicateBookmarkMatchKind;
  key: string;
  domain: string;
  items: BookmarkNode[];
};

function isTrackingParam(name: string) {
  return TRACKING_PARAM_PATTERNS.some((pattern) => pattern.test(name));
}

export function normalizeBookmarkUrl(url: string) {
  try {
    const parsed = new URL(url.trim());
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    Array.from(parsed.searchParams.keys()).forEach((key) => {
      if (isTrackingParam(key)) parsed.searchParams.delete(key);
    });
    parsed.searchParams.sort();
    if (parsed.hash === "#") parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function getUrlDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
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

function createDuplicateGroup(
  kind: DuplicateBookmarkMatchKind,
  key: string,
  items: BookmarkNode[]
): DuplicateBookmarkGroup {
  return {
    id: `${kind}:${key}`,
    kind,
    key,
    domain: getUrlDomain(items[0]?.url ? normalizeBookmarkUrl(items[0].url) : ""),
    items,
  };
}

function getExactDuplicateGroups(bookmarks: BookmarkNode[]) {
  const byUrl = new Map<string, BookmarkNode[]>();
  bookmarks.forEach((bookmark) => {
    if (!bookmark.url) return;
    const key = normalizeBookmarkUrl(bookmark.url);
    const group = byUrl.get(key) ?? [];
    group.push(bookmark);
    byUrl.set(key, group);
  });

  return [...byUrl.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => createDuplicateGroup("exact", key, items));
}

export function getDuplicateBookmarkGroups(bookmarks: BookmarkNode[]): DuplicateBookmarkGroup[] {
  return getExactDuplicateGroups(bookmarks);
}

export function countDuplicateGroups(bookmarks: BookmarkNode[]) {
  return getDuplicateBookmarkGroups(bookmarks).length;
}

export function filterDuplicateBookmarks(bookmarks: BookmarkNode[]) {
  const duplicateIds = new Set(
    getDuplicateBookmarkGroups(bookmarks).flatMap((group) => group.items.map((bookmark) => bookmark.id))
  );
  return bookmarks.filter((bookmark) => duplicateIds.has(bookmark.id));
}

function isHttpBookmark(bookmark: BookmarkNode) {
  return Boolean(bookmark.url && /^https?:\/\//i.test(bookmark.url));
}

function isReachableStatus(status: number) {
  if (status >= 200 && status < 400) return true;
  return AUTH_OR_RATE_LIMIT_STATUSES.has(status);
}

function classifyHttpStatus(status: number): BookmarkLinkHealthResult["status"] {
  if (isReachableStatus(status)) return "ok";
  if (BROKEN_STATUSES.has(status)) return "broken";
  if (status >= 500 || status === 408) return "temporary_failed";
  return "suspicious";
}

function statusReason(status: number) {
  if (BROKEN_STATUSES.has(status)) return `HTTP ${status}`;
  if (status >= 500) return `服务器临时错误 ${status}`;
  if (status === 408) return "请求超时";
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

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function shouldRetryStatus(status: number) {
  return classifyHttpStatus(status) === "temporary_failed";
}

async function fetchGetWithRetry(url: string) {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= GET_RETRY_COUNT; attempt += 1) {
    if (attempt > 0) await wait(RETRY_DELAY_MS);

    try {
      const response = await fetchWithTimeout(url, "GET");
      lastResponse = response;
      lastError = null;
      if (!shouldRetryStatus(response.status)) return response;
    } catch (error) {
      lastResponse = null;
      lastError = error;
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError;
}

function responseToHealthResult(
  bookmark: BookmarkNode,
  response: Response,
  checkedAt: number,
  method: "HEAD" | "GET"
): BookmarkLinkHealthResult {
  const status = classifyHttpStatus(response.status);
  return {
    bookmarkId: bookmark.id,
    bookmarkTitle: bookmark.title,
    bookmarkUrl: bookmark.url ?? "",
    checkedAt,
    status,
    httpStatus: response.status,
    finalUrl: response.url && response.url !== bookmark.url ? response.url : undefined,
    checkedMethod: method,
    reason: status === "ok" ? undefined : statusReason(response.status),
  };
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
      return responseToHealthResult(bookmark, headResponse, checkedAt, "HEAD");
    }

    const getResponse = await fetchGetWithRetry(bookmark.url);
    return responseToHealthResult(bookmark, getResponse, checkedAt, "GET");
  } catch (headError) {
    try {
      const getResponse = await fetchGetWithRetry(bookmark.url);
      return responseToHealthResult(bookmark, getResponse, checkedAt, "GET");
    } catch (getError) {
      return {
        bookmarkId: bookmark.id,
        bookmarkTitle: bookmark.title,
        bookmarkUrl: bookmark.url,
        checkedAt,
        status: "temporary_failed",
        reason: `${toNetworkReason(headError)}；${toNetworkReason(getError)}`,
      };
    }
  }
}

export function isProblemLinkHealthResult(result: BookmarkLinkHealthResult) {
  return result.status === "broken" ||
    result.status === "suspicious" ||
    result.status === "temporary_failed" ||
    result.status === "invalid";
}

export function getLinkHealthProblemResults(
  report: BookmarkLinkHealthReport,
  bookmarks?: BookmarkNode[]
) {
  const existingBookmarkIds = bookmarks ? new Set(bookmarks.map((bookmark) => bookmark.id)) : null;
  return report.results.filter((result) => {
    if (!isProblemLinkHealthResult(result)) return false;
    return !existingBookmarkIds || existingBookmarkIds.has(result.bookmarkId);
  });
}

export function getLinkHealthProblemCount(report: BookmarkLinkHealthReport, bookmarks?: BookmarkNode[]) {
  return getLinkHealthProblemResults(report, bookmarks).length;
}

export function getLinkHealthStatusLabel(result: BookmarkLinkHealthResult) {
  if (result.status === "broken" || result.status === "invalid") return "疑似失效";
  if (result.status === "suspicious") return "需要复查";
  if (result.status === "temporary_failed") return "暂时无法确认";
  return result.status === "skipped" ? "已跳过" : "可访问";
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
    brokenCount: results.filter((result) => result.status === "broken" || result.status === "invalid").length,
    suspiciousCount: results.filter((result) => result.status === "suspicious").length,
    temporaryFailedCount: results.filter((result) => result.status === "temporary_failed").length,
    invalidCount: results.filter(isProblemLinkHealthResult).length,
    results,
  };

  await saveLinkHealthReport(report);
  return report;
}
