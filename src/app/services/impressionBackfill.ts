import type { BookmarkForAI, BookmarkImpressionMeta, BookmarkNode } from "../types";
import { getAllBookmarks } from "./bookmarks";
import {
  AI_DATA_AUTHORIZATION_REQUIRED_MESSAGE,
  extractImpressionsWithAI,
  isAIProviderAuthorized,
} from "./aiProvider";
import { enrichBookmarksWithPageMetadata } from "./pageMetadata";
import { toBookmarkForAI } from "./rules";
import { getSemanticIndexMap, normalizeUrl, upsertBatchImpressions } from "./semanticIndex";
import { getSettings } from "./storage";
import { hasRequiredHostPermission, HOST_PERMISSION_REQUIRED_MESSAGE } from "./hostPermissions";

/** 每批书签数量：与批量整理保持一致，避免单次请求过长 */
const BACKFILL_BATCH_SIZE = 20;
const HTTP_URL_PATTERN = /^https?:\/\//i;

export type ImpressionBackfillProgress = {
  phase: "preparing" | "requesting_ai" | "saving";
  processed: number;
  total: number;
  indexed: number;
  failed: number;
};

export type ImpressionBackfillSummary = {
  total: number;
  indexed: number;
  failed: number;
  canceled: boolean;
};

function isHttpUrl(url?: string) {
  return Boolean(url && HTTP_URL_PATTERN.test(url));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("补全印象已取消", "AbortError");
}

/** 纯函数版本：供 UI 同步计算待补全数量，避免额外读取存储 */
export function getMissingImpressionBookmarks(
  bookmarks: BookmarkNode[],
  index: Record<string, BookmarkImpressionMeta>
): BookmarkNode[] {
  const seenUrls = new Set<string>();
  return bookmarks.filter((bookmark) => {
    if (!isHttpUrl(bookmark.url)) return false;
    const normalizedUrl = normalizeUrl(bookmark.url ?? "");
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) return false;
    const meta = index[normalizedUrl];
    // 只有目录快照、没有功能词与简述的记录仍需要 AI 补全。
    if (meta && (meta.keywords.length > 0 || meta.summary.trim())) return false;
    seenUrls.add(normalizedUrl);
    return true;
  });
}

/** 找出当前书签树中尚无有效功能印象的网页书签（同一规范化 URL 只补全一次） */
export async function getBookmarksMissingImpressions(
  bookmarks?: BookmarkNode[]
): Promise<BookmarkNode[]> {
  const [allBookmarks, index] = await Promise.all([
    bookmarks ? Promise.resolve(bookmarks) : getAllBookmarks(),
    getSemanticIndexMap(),
  ]);
  return getMissingImpressionBookmarks(allBookmarks, index);
}

export async function getMissingImpressionCount(): Promise<number> {
  return (await getBookmarksMissingImpressions()).length;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function withBookmarkPath(bookmark: BookmarkNode): BookmarkForAI {
  return toBookmarkForAI(bookmark);
}

/**
 * 仅针对未索引书签分批调用 AI 生成功能印象。
 * 不移动、不删除任何书签，也不写入整理报告或备份；失败批次会被跳过并计入 failed。
 */
export async function backfillImpressions(
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: ImpressionBackfillProgress) => void;
    bookmarks?: BookmarkNode[];
  } = {}
): Promise<ImpressionBackfillSummary> {
  const settings = await getSettings();
  if (!settings.provider.apiKey) throw new Error("未配置 API Key，无法补全印象索引");
  if (!isAIProviderAuthorized(settings.provider)) throw new Error(AI_DATA_AUTHORIZATION_REQUIRED_MESSAGE);
  if (!(await hasRequiredHostPermission())) throw new Error(HOST_PERMISSION_REQUIRED_MESSAGE);

  const missing = await getBookmarksMissingImpressions(options.bookmarks);
  const summary: ImpressionBackfillSummary = {
    total: missing.length,
    indexed: 0,
    failed: 0,
    canceled: false,
  };
  if (!missing.length) return summary;

  const batches = chunk(missing, BACKFILL_BATCH_SIZE);
  let processed = 0;

  const report = (phase: ImpressionBackfillProgress["phase"]) => {
    options.onProgress?.({
      phase,
      processed,
      total: missing.length,
      indexed: summary.indexed,
      failed: summary.failed,
    });
  };

  for (const batch of batches) {
    if (options.signal?.aborted) {
      summary.canceled = true;
      break;
    }

    let batchFinished = false;
    try {
      throwIfAborted(options.signal);
      report("preparing");
      const aiBookmarks = await enrichBookmarksWithPageMetadata(
        batch.map(withBookmarkPath),
        batch,
        { sendFullUrl: settings.sendFullUrl, mode: "quick", signal: options.signal }
      );
      throwIfAborted(options.signal);

      report("requesting_ai");
      const suggestions = await extractImpressionsWithAI(settings.provider, aiBookmarks, {
        signal: options.signal,
      });
      throwIfAborted(options.signal);

      const bookmarkById = new Map(batch.map((bookmark) => [bookmark.id, bookmark]));
      const validSuggestions = suggestions.filter((suggestion) => bookmarkById.has(suggestion.id));
      const matchedIds = new Set(validSuggestions.map((suggestion) => suggestion.id));

      report("saving");
      await upsertBatchImpressions(validSuggestions.flatMap((suggestion) => {
        const bookmark = bookmarkById.get(suggestion.id);
        if (!bookmark?.url) return [];
        return [{
          url: bookmark.url,
          bookmarkId: bookmark.id,
          keywords: suggestion.keywords,
          summary: suggestion.summary,
          source: "ai_organize" as const,
        }];
      }));

      summary.indexed += validSuggestions.length;
      summary.failed += batch.filter((bookmark) => !matchedIds.has(bookmark.id)).length;
      batchFinished = true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        summary.canceled = true;
        break;
      }
      // 单个批次失败不应中断补全，继续处理剩余批次。
      summary.failed += batch.length;
      batchFinished = true;
    } finally {
      if (batchFinished) {
        processed += batch.length;
        report("saving");
      }
    }
  }

  return summary;
}

/** 仅用于测试与 UI 展示：判断某条索引是否由 AI 生成 */
export function isAiImpression(meta: BookmarkImpressionMeta | undefined) {
  return meta?.source === "ai_organize" || meta?.source === "ai_recommend";
}
