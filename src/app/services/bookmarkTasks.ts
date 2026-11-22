import type {
  BookmarkLinkHealthReport,
  BookmarkLinkHealthResult,
  BookmarkUrlIdentity,
  BookmarkNode,
  PendingRecommendation,
} from "../types";
import {
  getBookmarkCheckIgnores, getLinkHealthReport, removeBookmarkFromLinkHealthReport,
  saveLinkHealthReport, updateLinkHealthReport, withLinkHealthResultCounts,
} from "./storage";
import { hasRequiredHostPermission, HOST_PERMISSION_REQUIRED_MESSAGE } from "./hostPermissions";
import { filterAvailableBookmarks, getCurrentWhitelist } from "./whitelist";
import { getBookmark, getUrlBookmarks, removeBookmark } from "./bookmarks";
import { createInvalidDeleteBackup } from "./backups";
import { withStorageMutation } from "./storageMutation";

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

const REQUEST_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 800;
const GET_RETRY_COUNT = 1;
const LINK_CHECK_CONCURRENCY = 4;
export const NOT_FOUND_RECHECK_MINUTES = 10;
const NOT_FOUND_RECHECK_DELAY = NOT_FOUND_RECHECK_MINUTES * 60_000;

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

export function getIgnoredBookmarkUrlIds(bookmarks: BookmarkNode[], ignored: BookmarkUrlIdentity[]) {
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
  ignored: BookmarkUrlIdentity[],
  protectedIds: ReadonlySet<string> = new Set()
): DuplicateBookmarkGroup[] {
  const ignoredIds = getIgnoredBookmarkUrlIds(bookmarks, ignored);
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
  ignored: BookmarkUrlIdentity[],
  protectedIds?: ReadonlySet<string>
) {
  return getDuplicateBookmarkGroups(bookmarks, ignored, protectedIds).length;
}

function isHttpBookmark(bookmark: BookmarkNode) {
  return Boolean(bookmark.url && /^https?:\/\//i.test(bookmark.url));
}

function classifyHttpStatus(status: number): BookmarkLinkHealthResult["status"] {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403 || status === 451) return "restricted";
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 410) return "broken";
  if (status >= 500 || status === 408) return "temporary_failed";
  return "suspicious";
}

function statusReason(status: number) {
  if (status === 401) return "需要登录或认证";
  if (status === 403) return "服务器拒绝访问";
  if (status === 451) return "站点因法律原因限制访问";
  if (status === 429) return "站点限制了请求频率，请稍后复测";
  if (status === 404) return "页面未找到";
  if (status === 410) return "服务器标记页面已移除";
  if (status >= 500) return "服务器暂时无法处理请求";
  if (status === 408) return "请求超时";
  return `HTTP ${status}`;
}

function pointsToAnotherPage(original: string, target: string) {
  try {
    const source = new URL(original);
    const destination = new URL(target);
    const upgrade = source.protocol === "http:" && destination.protocol === "https:";
    return source.host !== destination.host || source.pathname !== destination.pathname ||
      source.search !== destination.search || (!upgrade && source.protocol !== destination.protocol);
  } catch {
    return true;
  }
}

async function fetchWithTimeout(url: string, method: "HEAD" | "GET") {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    void response.body?.cancel().catch(() => undefined);
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
  return normalizeLinkHealthResult({
    bookmarkId: bookmark.id,
    bookmarkTitle: bookmark.title,
    bookmarkUrl: bookmark.url ?? "",
    checkedAt,
    status: classifyHttpStatus(response.status),
    httpStatus: response.status,
    finalUrl: response.redirected ? response.url : undefined,
    checkedMethod: method,
  });
}

async function checkOneBookmark(bookmark: BookmarkNode, initialMethod: "HEAD" | "GET" = "HEAD"): Promise<BookmarkLinkHealthResult> {
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

  const headResponse = initialMethod === "HEAD" ? await fetchWithTimeout(bookmark.url, "HEAD").catch(() => null) : null;
  if (headResponse) {
    const result = responseToHealthResult(bookmark, headResponse, checkedAt, "HEAD");
    if (result.status === "ok" || result.status === "rate_limited") return result;
  }
  try {
    const getResponse = await fetchGetWithRetry(bookmark.url);
    return responseToHealthResult(bookmark, getResponse, checkedAt, "GET");
  } catch (error) {
    return {
      bookmarkId: bookmark.id,
      bookmarkTitle: bookmark.title,
      bookmarkUrl: bookmark.url,
      checkedAt,
      status: "temporary_failed",
      reason: toNetworkReason(error),
    };
  }
}

function normalizeLinkHealthResult(result: BookmarkLinkHealthResult): BookmarkLinkHealthResult {
  if (result.httpStatus === undefined) {
    return result.status === "broken" || result.status === "invalid"
      ? { ...result, status: "suspicious" } : result;
  }
  const status = classifyHttpStatus(result.httpStatus);
  if (status === "ok" && result.finalUrl && pointsToAnotherPage(result.bookmarkUrl, result.finalUrl)) {
    return { ...result, status: "suspicious", reason: "已跳转到其他页面，请核对最终地址" };
  }
  return { ...result, status, reason: status === "ok" ? undefined : statusReason(result.httpStatus) };
}

export function isSuggestedLinkHealthCleanup(result: BookmarkLinkHealthResult) {
  if (result.checkedMethod !== "GET" || result.finalUrl) return false;
  return result.httpStatus === 410 || (result.httpStatus === 404 &&
    result.notFoundConfirmedAt !== undefined && result.checkedAt - result.notFoundConfirmedAt >= NOT_FOUND_RECHECK_DELAY);
}

export function getLinkHealthProblemResults(
  report: BookmarkLinkHealthReport,
  bookmarks: BookmarkNode[],
  ignored: BookmarkUrlIdentity[] = []
) {
  const currentUrls = new Map(bookmarks.map(({ id, url }) => [id, url]));
  const ignoredUrls = new Map(ignored.map(({ id, url }) => [id, url]));
  return report.results
    .filter(({ bookmarkId, bookmarkUrl }) => Boolean(bookmarkUrl) &&
      currentUrls.get(bookmarkId) === bookmarkUrl && ignoredUrls.get(bookmarkId) !== bookmarkUrl)
    .map(normalizeLinkHealthResult)
    .filter(({ status }) => status !== "ok" && status !== "skipped");
}

function validateLinkHealthResult(
  report: BookmarkLinkHealthReport | null,
  expectedReportId: string,
  expected: BookmarkLinkHealthResult
) {
  const current = report?.results.find(({ bookmarkId }) => bookmarkId === expected.bookmarkId);
  if (!report || report.id !== expectedReportId || report.status === "running" ||
      !current || current.bookmarkUrl !== expected.bookmarkUrl || current.checkedAt !== expected.checkedAt) {
    throw new Error("检测结果已更新，请重新核对");
  }
  return current;
}

async function getReviewableLinkHealthBookmark(result: BookmarkLinkHealthResult) {
  const [protection, ignored] = await Promise.all([
    getCurrentWhitelist(), getBookmarkCheckIgnores("linkHealthBookmarkIgnores"),
  ]);
  const bookmark = getUrlBookmarks(protection.tree).find(({ id }) => id === result.bookmarkId);
  if (!bookmark || bookmark.url !== result.bookmarkUrl) throw new Error("书签网址已变化，请重新检测");
  if (protection.index.protectedBookmarkIds.has(bookmark.id)) throw new Error("书签已加入白名单");
  if (ignored.some(({ id, url }) => id === bookmark.id && url === bookmark.url)) throw new Error("此书签已忽略");
  return bookmark;
}

export async function recheckLinkHealthBookmark(reportId: string, expected: BookmarkLinkHealthResult) {
  if (!(await hasRequiredHostPermission())) throw new Error(HOST_PERMISSION_REQUIRED_MESSAGE);
  const previous = validateLinkHealthResult(await getLinkHealthReport(), reportId, expected);
  const bookmark = await getReviewableLinkHealthBookmark(previous);
  const result = await checkOneBookmark(bookmark, "GET");
  if ((await getBookmark(bookmark.id))?.url !== bookmark.url) throw new Error("书签网址已变化，请重新检测");

  if (previous.httpStatus === 404 && previous.checkedMethod === "GET" && !previous.finalUrl &&
      result.httpStatus === 404 && result.checkedMethod === "GET" && !result.finalUrl) {
    result.notFoundConfirmedAt = previous.notFoundConfirmedAt ?? previous.checkedAt;
  }
  return updateLinkHealthReport((report) => {
    validateLinkHealthResult(report, reportId, previous);
    if (!report) return null;
    return withLinkHealthResultCounts({
      ...report,
      results: report.results.map((item) => item.bookmarkId === bookmark.id ? result : item),
    });
  });
}

export async function deleteLinkHealthBookmarks(reportId: string, selected: BookmarkLinkHealthResult[]) {
  const report = await getLinkHealthReport();
  selected.forEach((result) => validateLinkHealthResult(report, reportId, result));
  if (!selected.length) return { deletedIds: new Set<string>(), failedItems: [] };
  await createInvalidDeleteBackup();
  const deletedIds = new Set<string>();
  const failedItems: string[] = [];
  for (const result of selected) {
    try {
      await getReviewableLinkHealthBookmark(result);
      validateLinkHealthResult(await getLinkHealthReport(), reportId, result);
      await removeBookmark(result.bookmarkId, result.bookmarkUrl);
      deletedIds.add(result.bookmarkId);
    } catch (error) {
      failedItems.push(`${result.bookmarkTitle}：${error instanceof Error ? error.message : "删除失败"}`);
    }
  }
  for (const id of deletedIds) await removeBookmarkFromLinkHealthReport(id).catch(() => undefined);
  return { deletedIds, failedItems };
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
  const ignored = await getBookmarkCheckIgnores("linkHealthBookmarkIgnores");
  const ignoredUrls = new Map(ignored.map(({ id, url }) => [id, url]));
  const originalIds = initialReport?.bookmarkIds ? new Set(initialReport.bookmarkIds) : null;
  bookmarks = bookmarks.filter(({ id, url }) => (!originalIds || originalIds.has(id)) &&
    (url === undefined || ignoredUrls.get(id) !== url));
  const bookmarkIds = initialReport?.bookmarkIds ?? bookmarks.map(({ id }) => id);
  const bookmarkUrls = new Map(bookmarks.map(({ id, url }) => [id, url]));
  const results = initialReport?.results.filter(({ bookmarkId, bookmarkUrl, status }) =>
    bookmarkUrls.get(bookmarkId) === bookmarkUrl && status !== "skipped") ?? [];
  const checkedBookmarkIds = new Set(results.map((result) => result.bookmarkId));
  const pendingBookmarks = bookmarks.filter((bookmark) => !checkedBookmarkIds.has(bookmark.id));
  const total = bookmarks.length;
  const id = initialReport?.id ?? `link-health-${Date.now()}`;
  const createdAt = initialReport?.createdAt ?? Date.now();
  let nextIndex = 0;
  let checked = results.length;

  const buildReport = (status: BookmarkLinkHealthReport["status"]): BookmarkLinkHealthReport => withLinkHealthResultCounts({
    id,
    createdAt,
    status,
    bookmarkIds,
    totalCount: total,
    checkedCount: 0,
    skippedCount: 0,
    invalidCount: 0,
    results: [...results],
  });

  await saveLinkHealthReport(buildReport("running"));
  onProgress?.(checked, total);

  const worker = async () => {
    while (nextIndex < pendingBookmarks.length) {
      const bookmark = pendingBookmarks[nextIndex];
      nextIndex += 1;
      const [protection, currentIgnores] = await Promise.all([
        getCurrentWhitelist(), getBookmarkCheckIgnores("linkHealthBookmarkIgnores"),
      ]);
      const protectedNow = protection.index.protectedBookmarkIds.has(bookmark.id);
      const ignoredNow = currentIgnores.some(({ id, url }) => id === bookmark.id && url === bookmark.url);
      if (!protectedNow && !ignoredNow && (await getBookmark(bookmark.id))?.url === bookmark.url) {
        results.push(await checkOneBookmark(bookmark));
      }
      checked += 1;
      onProgress?.(checked, total);
      await saveLinkHealthReport(buildReport("running"));
    }
  };

  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(LINK_CHECK_CONCURRENCY, Math.max(1, pendingBookmarks.length)) }, worker)
  );
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure?.status === "rejected") {
    const failedReport = buildReport("failed");
    await saveLinkHealthReport(failedReport);
    throw failure.reason;
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

async function createLinkHealthScanTask(bookmarks: BookmarkNode[]) {
  const report = await updateLinkHealthReport((current) => {
    if (current?.status === "running" && current.bookmarkIds) return current;
    return {
      id: `link-health-${crypto.randomUUID()}`,
      createdAt: Date.now(),
      status: "running",
      bookmarkIds: bookmarks.map(({ id }) => id),
      totalCount: bookmarks.length,
      checkedCount: 0,
      skippedCount: 0,
      invalidCount: 0,
      results: [],
    };
  });
  if (!report) throw new Error("无法创建链接检测任务");
  return report;
}

function runLinkHealthScan(bookmarks: BookmarkNode[], report: BookmarkLinkHealthReport) {
  if (activeLinkHealthScanId === report.id && activeLinkHealthScanPromise) {
    return activeLinkHealthScanPromise;
  }

  activeLinkHealthScanId = report.id;
  activeLinkHealthScanPromise = withStorageMutation("link-health-scan", async () => {
    const current = await getLinkHealthReport();
    if (!current || current.id !== report.id || current.status !== "running") return current ?? report;
    try {
      if (!(await hasRequiredHostPermission())) throw new Error(HOST_PERMISSION_REQUIRED_MESSAGE);
      const protection = await getCurrentWhitelist();
      const scopedIds = new Set(current.bookmarkIds ?? bookmarks.map(({ id }) => id));
      const scopedBookmarks = getUrlBookmarks(protection.tree).filter(({ id }) => scopedIds.has(id));
      return await checkBookmarkLinks(scopedBookmarks, { initialReport: current });
    } catch (error) {
      await updateLinkHealthReport((latest) => latest?.id === current.id && latest.status === "running"
        ? { ...latest, status: "failed" } : latest);
      throw error;
    }
  }).finally(() => {
    if (activeLinkHealthScanId === report.id) {
      activeLinkHealthScanId = null;
      activeLinkHealthScanPromise = null;
    }
  });
  return activeLinkHealthScanPromise;
}

export async function startLinkHealthScan(bookmarks: BookmarkNode[]) {
  bookmarks = filterAvailableBookmarks(bookmarks, (await getCurrentWhitelist()).index);
  const ignored = new Map((await getBookmarkCheckIgnores("linkHealthBookmarkIgnores")).map(({ id, url }) => [id, url]));
  bookmarks = bookmarks.filter(({ id, url }) => ignored.get(id) !== url || url === undefined);
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
