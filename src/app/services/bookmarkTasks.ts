import type {
  BookmarkLinkHealthReport,
  BookmarkLinkHealthResult,
  BookmarkNode,
  PendingRecommendation,
} from "../types";
import { getLinkHealthReport, saveLinkHealthReport } from "./storage";

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
const SIMILAR_TITLE_DOMAIN_LIMIT = 150;
const TRACKING_PARAM_PATTERNS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
];

export type DuplicateBookmarkMatchKind = "exact" | "normalized-path" | "similar-title";

export type DuplicateBookmarkGroup = {
  id: string;
  kind: DuplicateBookmarkMatchKind;
  key: string;
  domain: string;
  items: BookmarkNode[];
  recommendedKeepId: string;
  suggestedDeleteIds: string[];
  reason: string;
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

function normalizeUrlPathKey(url: string) {
  try {
    const parsed = new URL(url.trim());
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    let pathname = decodeURIComponent(parsed.pathname || "/").replace(/\/+$/, "");
    if (!pathname) pathname = "/";
    return `${protocol}//${hostname}${pathname}`;
  } catch {
    return url.trim();
  }
}

function normalizeTitleForMatch(title: string) {
  return title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(title: string) {
  return normalizeTitleForMatch(title)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function titleSimilarity(left: string, right: string) {
  const leftTitle = normalizeTitleForMatch(left);
  const rightTitle = normalizeTitleForMatch(right);
  if (!leftTitle || !rightTitle) return 0;
  if (leftTitle === rightTitle) return 1;
  if ((leftTitle.length >= 8 && rightTitle.includes(leftTitle)) || (rightTitle.length >= 8 && leftTitle.includes(rightTitle))) {
    return 0.9;
  }

  const leftTokens = new Set(titleTokens(leftTitle));
  const rightTokens = new Set(titleTokens(rightTitle));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
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
  items: BookmarkNode[],
  reason: string
): DuplicateBookmarkGroup {
  const recommendedKeep = pickRecommendedKeep(items) ?? items[0];
  return {
    id: `${kind}:${key}`,
    kind,
    key,
    domain: getUrlDomain(items[0]?.url ? normalizeBookmarkUrl(items[0].url) : ""),
    items,
    recommendedKeepId: recommendedKeep?.id ?? "",
    suggestedDeleteIds: items.filter((bookmark) => bookmark.id !== recommendedKeep?.id).map((bookmark) => bookmark.id),
    reason,
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
    .map(([key, items]) => createDuplicateGroup("exact", key, items, "URL 完全一致或仅跟踪参数不同"));
}

function getNormalizedPathDuplicateGroups(bookmarks: BookmarkNode[]) {
  const byPath = new Map<string, BookmarkNode[]>();
  bookmarks.forEach((bookmark) => {
    if (!bookmark.url) return;
    const key = normalizeUrlPathKey(bookmark.url);
    const group = byPath.get(key) ?? [];
    group.push(bookmark);
    byPath.set(key, group);
  });

  return [...byPath.entries()]
    .filter(([, items]) => {
      const exactKeys = new Set(items.map((bookmark) => bookmark.url ? normalizeBookmarkUrl(bookmark.url) : ""));
      return items.length > 1 && exactKeys.size > 1;
    })
    .map(([key, items]) => createDuplicateGroup("normalized-path", key, items, "域名和路径一致，忽略 query、hash 和末尾斜杠"));
}

function getSimilarTitleDuplicateGroups(bookmarks: BookmarkNode[]) {
  const byDomain = new Map<string, BookmarkNode[]>();
  bookmarks.forEach((bookmark) => {
    if (!bookmark.url) return;
    const domain = getUrlDomain(bookmark.url);
    if (!domain) return;
    const group = byDomain.get(domain) ?? [];
    group.push(bookmark);
    byDomain.set(domain, group);
  });

  const groups: DuplicateBookmarkGroup[] = [];
  byDomain.forEach((items, domain) => {
    if (items.length > SIMILAR_TITLE_DOMAIN_LIMIT) return;

    const parent = new Map<string, string>();
    const find = (id: string): string => {
      const current = parent.get(id) ?? id;
      if (current === id) return id;
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    const union = (left: string, right: string) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };

    items.forEach((item) => parent.set(item.id, item.id));
    for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
        const left = items[leftIndex];
        const right = items[rightIndex];
        if (left.url && right.url && normalizeUrlPathKey(left.url) === normalizeUrlPathKey(right.url)) continue;
        if (titleSimilarity(left.title, right.title) >= 0.82) union(left.id, right.id);
      }
    }

    const clusters = new Map<string, BookmarkNode[]>();
    items.forEach((item) => {
      const root = find(item.id);
      const cluster = clusters.get(root) ?? [];
      cluster.push(item);
      clusters.set(root, cluster);
    });

    clusters.forEach((cluster, root) => {
      if (cluster.length > 1) {
        groups.push(createDuplicateGroup("similar-title", `${domain}:${root}`, cluster, "同一域名下标题高度相似"));
      }
    });
  });

  return groups;
}

export function getDuplicateBookmarkGroups(bookmarks: BookmarkNode[]): DuplicateBookmarkGroup[] {
  const exactGroups = getExactDuplicateGroups(bookmarks);
  const exactIds = new Set(exactGroups.flatMap((group) => group.items.map((bookmark) => bookmark.id)));

  const normalizedGroups = getNormalizedPathDuplicateGroups(
    bookmarks.filter((bookmark) => !exactIds.has(bookmark.id))
  );
  const normalizedIds = new Set(normalizedGroups.flatMap((group) => group.items.map((bookmark) => bookmark.id)));

  const similarGroups = getSimilarTitleDuplicateGroups(
    bookmarks.filter((bookmark) => !exactIds.has(bookmark.id) && !normalizedIds.has(bookmark.id))
  );

  return [...exactGroups, ...normalizedGroups, ...similarGroups];
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

export function getLinkHealthStatusLabel(result: BookmarkLinkHealthResult) {
  if (result.status === "broken" || result.status === "invalid") return "疑似失效";
  if (result.status === "suspicious") return "需要复查";
  if (result.status === "temporary_failed") return "暂时无法确认";
  return result.status === "skipped" ? "已跳过" : "可访问";
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
      results.push(await checkOneBookmark(bookmark));
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
