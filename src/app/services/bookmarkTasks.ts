import type {
  BookmarkLinkHealthReport,
  BookmarkLinkHealthResult,
  DuplicateBookmarkIgnore,
  BookmarkNode,
  PendingRecommendation,
} from "../types";
import { getLinkHealthReport, saveLinkHealthReport } from "./storage";
import { hasRequiredHostPermission, HOST_PERMISSION_REQUIRED_MESSAGE } from "./hostPermissions";
import { filterAvailableBookmarks, getCurrentWhitelist } from "./whitelist";

export const LINK_HEALTH_SCAN_MESSAGE = "remarks:link-health-scan";

type LinkHealthScanMessage = {
  type: typeof LINK_HEALTH_SCAN_MESSAGE;
  action: "run";
  bookmarks: BookmarkNode[];
  report: BookmarkLinkHealthReport;
};

type LinkHealthProgressHandler = (checked: number, total: number) => void;

type LinkHealthScanOptions = {
  initialReport?: BookmarkLinkHealthReport;
  onProgress?: LinkHealthProgressHandler;
};

const AUTH_OR_RATE_LIMIT_STATUSES = new Set([401, 403, 429]);
const BROKEN_STATUSES = new Set([404, 410, 451]);
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 800;
const GET_RETRY_COUNT = 1;
const LINK_CHECK_CONCURRENCY = 4;

export type DuplicateBookmarkGroup = {
  key: string;
  items: BookmarkNode[];
  recommendedKeepId: string;
  suggestedDeleteIds: string[];
};

function normalizeBookmarkUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : url;
  } catch {
    return url;
  }
}

export function getIgnoredDuplicateBookmarkIds(bookmarks: BookmarkNode[], ignored: DuplicateBookmarkIgnore[]) {
  const ignoredUrls = new Map(ignored.map(({ id, url }) => [id, url]));
  return new Set(bookmarks.filter(({ id, url }) => url && ignoredUrls.get(id) === url).map(({ id }) => id));
}

function pickRecommendedKeep(items: BookmarkNode[]) {
  return [...items].sort((left, right) => {
    const pathDepthDiff = right.path.length - left.path.length;
    if (pathDepthDiff) return pathDepthDiff;

    const titleLengthDiff = right.title.trim().length - left.title.trim().length;
    if (titleLengthDiff) return titleLengthDiff;

    const leftDate = left.dateAdded ?? Number.MAX_SAFE_INTEGER;
    const rightDate = right.dateAdded ?? Number.MAX_SAFE_INTEGER;
    if (leftDate !== rightDate) return leftDate - rightDate;

    return (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER);
  })[0];
}

export function isUnsortedBookmark(bookmark: BookmarkNode) {
  if (!bookmark.path.length) return true;
  return bookmark.path.some((part) => /待整理|未分类|unsorted/i.test(part));
}

export function getVisibleUnsortedBookmarks(
  bookmarks: BookmarkNode[],
  recommendations: PendingRecommendation[],
  ignoredManualBookmarkIds: Iterable<string> = []
) {
  const recommendationBookmarkIds = new Set(recommendations.map((recommendation) => recommendation.bookmarkId));
  const ignoredIds = new Set(ignoredManualBookmarkIds);

  return bookmarks.filter((bookmark) =>
    isUnsortedBookmark(bookmark) &&
    !recommendationBookmarkIds.has(bookmark.id) &&
    !ignoredIds.has(bookmark.id)
  );
}

export function getUnsortedTaskCount(
  bookmarks: BookmarkNode[],
  recommendations: PendingRecommendation[],
  ignoredManualBookmarkIds: Iterable<string> = []
) {
  const ids = new Set<string>();
  getVisibleUnsortedBookmarks(bookmarks, recommendations, ignoredManualBookmarkIds)
    .forEach((bookmark) => ids.add(bookmark.id));
  recommendations.forEach((recommendation) => ids.add(recommendation.bookmarkId));
  return ids.size;
}

export function getDuplicateBookmarkGroups(
  bookmarks: BookmarkNode[],
  ignored: DuplicateBookmarkIgnore[],
  protectedIds: ReadonlySet<string> = new Set()
): DuplicateBookmarkGroup[] {
  const ignoredIds = getIgnoredDuplicateBookmarkIds(bookmarks, ignored);
  const byUrl = new Map<string, BookmarkNode[]>();
  bookmarks.forEach((bookmark) => {
    if (!bookmark.url || ignoredIds.has(bookmark.id)) return;
    const key = normalizeBookmarkUrl(bookmark.url);
    const group = byUrl.get(key) ?? [];
    group.push(bookmark);
    byUrl.set(key, group);
  });

  return [...byUrl.entries()]
    .filter(([, items]) => items.length > 1 && items.some(({ id }) => !protectedIds.has(id)))
    .map(([key, items]) => {
      const kept = items.find(({ id }) => protectedIds.has(id)) ?? pickRecommendedKeep(items);
      return {
        key,
        items,
        recommendedKeepId: kept.id,
        suggestedDeleteIds: items.filter(({ id }) => id !== kept.id && !protectedIds.has(id)).map(({ id }) => id),
      };
    });
}

export function countDuplicateGroups(
  bookmarks: BookmarkNode[],
  ignored: DuplicateBookmarkIgnore[],
  protectedIds?: ReadonlySet<string>
) {
  return getDuplicateBookmarkGroups(bookmarks, ignored, protectedIds).length;
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
  const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
    globalThis.clearTimeout(timer);
  }
}

function toNetworkReason(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "请求超时";
  return error instanceof Error && error.message ? error.message : "网络请求失败";
}

function wait(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
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

function normalizeLinkHealthScanOptions(
  options?: LinkHealthProgressHandler | LinkHealthScanOptions
): LinkHealthScanOptions {
  if (typeof options === "function") return { onProgress: options };
  return options ?? {};
}

export async function checkBookmarkLinks(
  bookmarks: BookmarkNode[],
  options?: LinkHealthProgressHandler | LinkHealthScanOptions
): Promise<BookmarkLinkHealthReport> {
  const { initialReport, onProgress } = normalizeLinkHealthScanOptions(options);
  bookmarks = filterAvailableBookmarks(bookmarks, (await getCurrentWhitelist()).index);
  const bookmarkIds = new Set(bookmarks.map((bookmark) => bookmark.id));
  const results: BookmarkLinkHealthResult[] = initialReport?.results.filter((result) => bookmarkIds.has(result.bookmarkId)) ?? [];
  const checkedBookmarkIds = new Set(results.map((result) => result.bookmarkId));
  const pendingBookmarks = bookmarks.filter((bookmark) => !checkedBookmarkIds.has(bookmark.id));
  const total = bookmarks.length;
  const id = initialReport?.id ?? `link-health-${Date.now()}`;
  const createdAt = initialReport?.createdAt ?? Date.now();
  let nextIndex = 0;
  let checked = results.length;

  const buildReport = (status: BookmarkLinkHealthReport["status"]): BookmarkLinkHealthReport => ({
    id,
    createdAt,
    updatedAt: Date.now(),
    status,
    totalCount: total,
    checkedCount: results.filter((result) => result.status !== "skipped").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    brokenCount: results.filter((result) => result.status === "broken" || result.status === "invalid").length,
    suspiciousCount: results.filter((result) => result.status === "suspicious").length,
    temporaryFailedCount: results.filter((result) => result.status === "temporary_failed").length,
    invalidCount: results.filter(isProblemLinkHealthResult).length,
    results: [...results],
  });

  await saveLinkHealthReport(buildReport("running"));
  onProgress?.(checked, total);

  const worker = async () => {
    while (nextIndex < pendingBookmarks.length) {
      const bookmark = pendingBookmarks[nextIndex];
      nextIndex += 1;
      const protectedNow = (await getCurrentWhitelist()).index.protectedBookmarkIds.has(bookmark.id);
      results.push(protectedNow ? {
        bookmarkId: bookmark.id,
        bookmarkTitle: bookmark.title,
        bookmarkUrl: bookmark.url ?? "",
        checkedAt: Date.now(),
        status: "skipped",
        reason: "已加入白名单",
      } : await checkOneBookmark(bookmark));
      checked += 1;
      onProgress?.(checked, total);
      await saveLinkHealthReport(buildReport("running"));
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(LINK_CHECK_CONCURRENCY, Math.max(1, pendingBookmarks.length)) }, worker)
    );
  } catch (error) {
    const failedReport = buildReport("failed");
    await saveLinkHealthReport(failedReport);
    throw error;
  }

  const report = buildReport("completed");
  await saveLinkHealthReport(report);
  return report;
}

function hasRuntimeMessaging() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

let activeLinkHealthScanId: string | null = null;
let activeLinkHealthScanPromise: Promise<BookmarkLinkHealthReport> | null = null;

function withLinkHealthResultCounts(report: BookmarkLinkHealthReport): BookmarkLinkHealthReport {
  return {
    ...report,
    checkedCount: report.results.filter((result) => result.status !== "skipped").length,
    skippedCount: report.results.filter((result) => result.status === "skipped").length,
    brokenCount: report.results.filter((result) => result.status === "broken" || result.status === "invalid").length,
    suspiciousCount: report.results.filter((result) => result.status === "suspicious").length,
    temporaryFailedCount: report.results.filter((result) => result.status === "temporary_failed").length,
    invalidCount: report.results.filter(isProblemLinkHealthResult).length,
  };
}

async function createLinkHealthScanTask(bookmarks: BookmarkNode[]) {
  const existingReport = await getLinkHealthReport();
  if (existingReport?.status === "running") {
    const bookmarkIds = new Set(bookmarks.map((bookmark) => bookmark.id));
    const results = existingReport.results.filter((result) => bookmarkIds.has(result.bookmarkId));
    const task = withLinkHealthResultCounts({
      ...existingReport,
      updatedAt: Date.now(),
      totalCount: bookmarks.length,
      results,
    });
    await saveLinkHealthReport(task);
    return task;
  }

  const task: BookmarkLinkHealthReport = {
    id: `link-health-${Date.now()}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    totalCount: bookmarks.length,
    checkedCount: 0,
    skippedCount: 0,
    brokenCount: 0,
    suspiciousCount: 0,
    temporaryFailedCount: 0,
    invalidCount: 0,
    results: [],
  };
  await saveLinkHealthReport(task);
  return task;
}

function runLinkHealthScan(bookmarks: BookmarkNode[], report: BookmarkLinkHealthReport) {
  if (activeLinkHealthScanId === report.id && activeLinkHealthScanPromise) {
    return activeLinkHealthScanPromise;
  }

  activeLinkHealthScanId = report.id;
  activeLinkHealthScanPromise = checkBookmarkLinks(bookmarks, { initialReport: report }).finally(() => {
    if (activeLinkHealthScanId === report.id) {
      activeLinkHealthScanId = null;
      activeLinkHealthScanPromise = null;
    }
  });
  return activeLinkHealthScanPromise;
}

export async function startLinkHealthScan(bookmarks: BookmarkNode[]) {
  bookmarks = filterAvailableBookmarks(bookmarks, (await getCurrentWhitelist()).index);
  if (!(await hasRequiredHostPermission())) {
    throw new Error(HOST_PERMISSION_REQUIRED_MESSAGE);
  }
  const task = await createLinkHealthScanTask(bookmarks);

  if (!hasRuntimeMessaging()) {
    void runLinkHealthScan(bookmarks, task).catch(() => undefined);
    return task;
  }

  chrome.runtime.sendMessage(
    {
      type: LINK_HEALTH_SCAN_MESSAGE,
      action: "run",
      bookmarks,
      report: task,
    } satisfies LinkHealthScanMessage,
    (response?: { error?: string }) => {
      if (chrome.runtime.lastError || response?.error) {
        void runLinkHealthScan(bookmarks, task).catch(() => undefined);
      }
    }
  );

  return task;
}

export function isLinkHealthScanMessage(message: unknown): message is LinkHealthScanMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: string }).type === LINK_HEALTH_SCAN_MESSAGE
  );
}

export async function handleLinkHealthScanMessage(message: LinkHealthScanMessage) {
  if (message.action === "run") {
    return runLinkHealthScan(message.bookmarks, message.report);
  }
  return null;
}
