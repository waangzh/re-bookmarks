import type {
  BookmarkImpressionMeta,
  BookmarkImpressionSource,
  SemanticIndexStorage,
} from "../types";
import {
  STORAGE_KEYS,
  getReportHistory,
  getStorageValue,
  setStorageValue,
} from "./storage";
import { withStorageMutation } from "./storageMutation";

const TRACKING_PARAM_PATTERN = /^(utm_[a-z]+|gclid|fbclid|yclid|msclkid|spm|from_source|ref|referrer)$/i;
const MAX_KEYWORDS = 8;
const MAX_KEYWORD_LENGTH = 24;

export type ImpressionUpsertInput = {
  url: string;
  bookmarkId?: string;
  keywords?: string[];
  summary?: string;
  folderSnapshot?: string;
  source: BookmarkImpressionSource;
};

function createEmptyIndex(): SemanticIndexStorage {
  return { version: 1, items: {} };
}

/**
 * 规范化 URL 作为印象索引主键：忽略协议/域名大小写、末尾斜杠、hash 与常见跟踪参数。
 * 备份恢复或 HTML 导入后浏览器会重新分配 bookmarkId，但规范化 URL 不变。
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    Array.from(parsed.searchParams.keys()).forEach((key) => {
      if (TRACKING_PARAM_PATTERN.test(key)) parsed.searchParams.delete(key);
    });
    parsed.searchParams.sort();
    // 统一去掉末尾斜杠，但保留 query 分隔符。
    const result = parsed.toString();
    return result.endsWith("/") ? result.slice(0, -1) : result;
  } catch {
    return trimmed.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

function cleanKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of keywords) {
    if (typeof value !== "string") continue;
    const keyword = value.trim().slice(0, MAX_KEYWORD_LENGTH);
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
    if (result.length >= MAX_KEYWORDS) break;
  }
  return result;
}

function isImpressionMeta(value: unknown): value is BookmarkImpressionMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<BookmarkImpressionMeta>;
  return typeof meta.normalizedUrl === "string" &&
    typeof meta.summary === "string" &&
    Array.isArray(meta.keywords) &&
    typeof meta.updatedAt === "number";
}

function sanitizeIndex(value: unknown): SemanticIndexStorage {
  if (!value || typeof value !== "object") return createEmptyIndex();
  const raw = value as Partial<SemanticIndexStorage>;
  const items: Record<string, BookmarkImpressionMeta> = {};
  if (raw.items && typeof raw.items === "object") {
    for (const [key, item] of Object.entries(raw.items)) {
      if (!isImpressionMeta(item)) continue;
      const normalizedUrl = normalizeUrl(item.normalizedUrl) || key;
      if (!normalizedUrl) continue;
      items[normalizedUrl] = {
        ...item,
        normalizedUrl,
        keywords: cleanKeywords(item.keywords),
        summary: typeof item.summary === "string" ? item.summary : "",
        folderSnapshot: typeof item.folderSnapshot === "string" ? item.folderSnapshot : undefined,
        source: item.source ?? "ai_organize",
      };
    }
  }
  return {
    version: 1,
    items,
    migratedAt: typeof raw.migratedAt === "number" ? raw.migratedAt : undefined,
  };
}

function folderKeywords(folderPath: string[] | undefined) {
  return (folderPath ?? [])
    .flatMap((part) => part.split(/[/｜|]/))
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 从历史整理报告中吸纳旧的 reason 与目标目录，升级后无需重新跑 AI 即可检索 */
async function absorbLegacyReports(index: SemanticIndexStorage): Promise<SemanticIndexStorage> {
  const reports = await getReportHistory();
  if (!reports.length) return index;

  const items = { ...index.items };
  for (const report of reports) {
    for (const plan of report.movePlan ?? []) {
      if (!plan.bookmarkUrl) continue;
      const normalizedUrl = normalizeUrl(plan.bookmarkUrl);
      if (!normalizedUrl || items[normalizedUrl]) continue;
      const keywords = cleanKeywords(folderKeywords(plan.toFolderPath));
      const summary = (plan.reason ?? "").trim();
      if (!keywords.length && !summary) continue;
      items[normalizedUrl] = {
        normalizedUrl,
        lastBookmarkId: plan.bookmarkId,
        keywords,
        summary,
        folderSnapshot: plan.toFolderPath?.length ? plan.toFolderPath.join(" / ") : undefined,
        source: plan.source === "ai" ? "ai_organize" : "rule_fallback",
        updatedAt: report.createdAt || Date.now(),
      };
    }
  }

  return { ...index, items };
}

export async function getSemanticIndex(): Promise<SemanticIndexStorage> {
  const stored = sanitizeIndex(await getStorageValue<unknown>(STORAGE_KEYS.semanticIndex, null));
  if (stored.migratedAt) return stored;

  try {
    const migrated = await absorbLegacyReports(stored);
    const next = { ...migrated, migratedAt: Date.now() };
    await setStorageValue(STORAGE_KEYS.semanticIndex, next);
    return next;
  } catch {
    // 历史报告损坏时不应阻断印象搜索，保留已读取的索引。
    return stored;
  }
}

export async function getSemanticIndexMap(): Promise<Record<string, BookmarkImpressionMeta>> {
  return (await getSemanticIndex()).items;
}

function mergeImpression(
  existing: BookmarkImpressionMeta | undefined,
  input: ImpressionUpsertInput,
  normalizedUrl: string
): BookmarkImpressionMeta | null {
  const keywords = cleanKeywords([
    ...(existing?.keywords ?? []),
    ...cleanKeywords(input.keywords),
  ]);
  const summary = (input.summary ?? existing?.summary ?? "").trim();
  const folderSnapshot = (input.folderSnapshot ?? existing?.folderSnapshot ?? "").trim() || undefined;
  if (!keywords.length && !summary && !folderSnapshot) return null;

  return {
    normalizedUrl,
    lastBookmarkId: input.bookmarkId ?? existing?.lastBookmarkId,
    keywords,
    summary,
    folderSnapshot,
    source: input.source,
    updatedAt: Date.now(),
  };
}

export function upsertBatchImpressions(inputs: ImpressionUpsertInput[]): Promise<SemanticIndexStorage> {
  const validInputs = inputs.filter((input) => input.url && normalizeUrl(input.url));
  if (!validInputs.length) return getSemanticIndex();

  return withStorageMutation("semantic-index", async () => {
    const index = await getSemanticIndex();
    const items = { ...index.items };

    for (const input of validInputs) {
      const normalizedUrl = normalizeUrl(input.url);
      const next = mergeImpression(items[normalizedUrl], input, normalizedUrl);
      if (next) items[normalizedUrl] = next;
    }

    const nextIndex: SemanticIndexStorage = { ...index, version: 1, items };
    await setStorageValue(STORAGE_KEYS.semanticIndex, nextIndex);
    return nextIndex;
  });
}

/** 用户手动调整目录后，把最终文件夹名称追加为印象词，便于以后按用途检索 */
export async function appendFolderImpression(url: string | undefined, folderPath: string[], source: BookmarkImpressionSource = "user_edit") {
  if (!url || !folderPath.length) return;
  await upsertBatchImpressions([{
    url,
    keywords: folderKeywords(folderPath),
    folderSnapshot: folderPath.join(" / "),
    source,
  }]);
}

export async function removeImpressionByUrl(url: string): Promise<void> {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) return;

  await withStorageMutation("semantic-index", async () => {
    const index = await getSemanticIndex();
    if (!index.items[normalizedUrl]) return;
    const items = { ...index.items };
    delete items[normalizedUrl];
    await setStorageValue(STORAGE_KEYS.semanticIndex, { ...index, items });
  });
}

export type SemanticIndexCoverage = {
  indexed: number;
  total: number;
};

/** 统计当前书签树中已建立 AI 印象索引的数量（按规范化 URL 匹配） */
export function getSemanticIndexCoverage(
  bookmarks: Array<{ url?: string }>,
  index: Record<string, BookmarkImpressionMeta>
): SemanticIndexCoverage {
  // 只统计可建立功能印象的网页书签，chrome:// 等内部页面不参与覆盖率。
  const urls = new Set(bookmarks.flatMap((bookmark) => (
    bookmark.url && /^https?:\/\//i.test(bookmark.url) ? [normalizeUrl(bookmark.url)] : []
  )));
  let indexed = 0;
  for (const url of urls) {
    const meta = index[url];
    // 只有目录快照、没有功能词或简述的记录不算已建立功能印象。
    if (meta && (meta.keywords.length > 0 || meta.summary.trim())) indexed += 1;
  }
  return { indexed, total: urls.size };
}

/** 空状态展示的高频印象词，取自本地索引中出现次数最多的 keywords */
export function getTopImpressionKeywords(
  index: Record<string, BookmarkImpressionMeta>,
  limit = 6
): string[] {
  const counts = new Map<string, number>();
  for (const meta of Object.values(index)) {
    for (const keyword of meta.keywords) {
      const value = keyword.trim();
      if (!value || value.length > 12) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, Math.max(1, limit))
    .map(([keyword]) => keyword);
}
