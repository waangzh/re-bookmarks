import type { AIProviderConfig, BookmarkForAI, BookmarkImpressionMeta, BookmarkNode } from "../types";
import { getAllBookmarks } from "./bookmarks";
import {
  AI_DATA_AUTHORIZATION_REQUIRED_MESSAGE,
  IMPRESSION_TOKENS_PER_BOOKMARK,
  extractImpressionsWithAI,
  getAIOutputTokenLimit,
  isAIProviderAuthorized,
} from "./aiProvider";
import { enrichBookmarksWithPageMetadata } from "./pageMetadata";
import { toBookmarkForAI } from "./rules";
import { getSemanticIndexMap, hasUsableImpression, normalizeUrl, upsertBatchImpressions } from "./semanticIndex";
import { getSettings } from "./storage";
import { hasRequiredHostPermission, HOST_PERMISSION_REQUIRED_MESSAGE } from "./hostPermissions";

const BACKFILL_BATCH_SIZE = 20;
const RETRY_BATCH_SIZE = 5;
const HTTP_URL_PATTERN = /^https?:\/\//i;

export type ImpressionBackfillProgress = {
  phase: "preparing" | "requesting_ai" | "retrying_ai" | "saving";
  processed: number;
  total: number;
  indexed: number;
  failed: number;
  retried: number;
};

export type ImpressionBackfillFailure = {
  bookmarkId: string;
  title: string;
  reason: string;
};

export type ImpressionBackfillSummary = {
  total: number;
  indexed: number;
  failed: number;
  retried: number;
  recovered: number;
  failures: ImpressionBackfillFailure[];
  canceled: boolean;
};

export function getImpressionBackfillBatchSize(config: AIProviderConfig): number {
  const maxTokens = getAIOutputTokenLimit(config, "impression");
  return maxTokens !== undefined
    ? Math.max(1, Math.min(BACKFILL_BATCH_SIZE, Math.floor(maxTokens / IMPRESSION_TOKENS_PER_BOOKMARK)))
    : BACKFILL_BATCH_SIZE;
}

function requestFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/超时/.test(message)) return "AI 请求超时，可稍后重试。";
  if (/网络请求失败/.test(message)) return "AI 网络请求失败，请检查连接与 endpoint。";
  if (/API Key|授权|权限|401|403/.test(message)) return "AI 授权或访问权限不可用，请检查设置。";
  if (/额度|余额|配额|429|限流|频率/.test(message)) return "AI 服务额度不足或请求受限，请检查服务状态。";
  // 不向 UI 透传服务端响应，避免回显密钥或其他敏感内容。
  return "AI 请求失败，请检查服务连接、模型及账户状态后重试。";
}

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
    seenUrls.add(normalizedUrl);
    // 只有目录快照或规则兜底词的记录仍需要 AI 补全。
    return !hasUsableImpression(index[normalizedUrl]);
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
 * 遗漏项最多追加一次小批量请求；请求或保存失败不自动重发。
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
    retried: 0,
    recovered: 0,
    failures: [],
    canceled: false,
  };
  if (!missing.length) return summary;

  const batchSize = getImpressionBackfillBatchSize(settings.provider);
  const batches = chunk(missing, batchSize);
  const completedIds = new Set<string>();

  const report = (phase: ImpressionBackfillProgress["phase"]) => {
    options.onProgress?.({
      phase,
      processed: summary.indexed + summary.failed,
      total: missing.length,
      indexed: summary.indexed,
      failed: summary.failed,
      retried: summary.retried,
    });
  };

  const fail = (bookmarks: BookmarkNode[], reason: string) => {
    for (const bookmark of bookmarks) {
      if (completedIds.has(bookmark.id)) continue;
      completedIds.add(bookmark.id);
      summary.failures.push({ bookmarkId: bookmark.id, title: bookmark.title || "未命名书签", reason });
    }
    summary.failed = summary.failures.length;
    report("saving");
  };

  const attempt = async (batch: BookmarkNode[], aiBookmarks: BookmarkForAI[], retry: boolean) => {
    throwIfAborted(options.signal);
    if (retry) summary.retried += batch.length;
    report(retry ? "retrying_ai" : "requesting_ai");
    let result: Awaited<ReturnType<typeof extractImpressionsWithAI>>;
    try {
      result = await extractImpressionsWithAI(settings.provider, aiBookmarks, { signal: options.signal });
    } catch (error) {
      throwIfAborted(options.signal);
      fail(batch, requestFailureReason(error));
      return [];
    }
    throwIfAborted(options.signal);

    const bookmarkById = new Map(batch.map((bookmark) => [bookmark.id, bookmark]));
    const suggestions = [...new Map(
      result.suggestions
        .filter((suggestion) => bookmarkById.has(suggestion.id))
        .map((suggestion) => [suggestion.id, suggestion])
    ).values()];
    const matchedIds = new Set(suggestions.map((suggestion) => suggestion.id));
    const unresolved = batch.filter((bookmark) => !matchedIds.has(bookmark.id));

    if (suggestions.length) {
      report("saving");
      try {
        await upsertBatchImpressions(suggestions.map((suggestion) => {
          const bookmark = bookmarkById.get(suggestion.id)!;
          return {
            url: bookmark.url!,
            bookmarkId: bookmark.id,
            keywords: suggestion.keywords,
            summary: suggestion.summary,
            source: "ai_batch_index" as const,
          };
        }));
        suggestions.forEach((suggestion) => completedIds.add(suggestion.id));
        summary.indexed += suggestions.length;
        if (retry) summary.recovered += suggestions.length;
        report("saving");
      } catch {
        fail(batch.filter((bookmark) => matchedIds.has(bookmark.id)), "用途已生成，但本地索引保存失败；请检查扩展存储后重试。");
      }
    }

    if (!retry && result.retryable) return unresolved;
    for (const bookmark of unresolved) {
      const metadata = aiBookmarks.find((item) => item.id === bookmark.id)?.metadata;
      fail([bookmark], result.incompleteReason + (metadata?.available === false
        ? " 同时未获取到有效网页摘要，可检查书签标题或页面是否需要登录。"
        : ""));
    }
    return [];
  };

  for (const batch of batches) {
    if (options.signal?.aborted) {
      summary.canceled = true;
      break;
    }

    try {
      throwIfAborted(options.signal);
      report("preparing");
      const aiBookmarks = await enrichBookmarksWithPageMetadata(
        batch.map(withBookmarkPath),
        batch,
        { sendFullUrl: settings.sendFullUrl, mode: "quick", signal: options.signal }
      );
      throwIfAborted(options.signal);

      const unresolved = await attempt(batch, aiBookmarks, false);
      for (const retryBatch of chunk(unresolved, Math.min(RETRY_BATCH_SIZE, batchSize))) {
        throwIfAborted(options.signal);
        report("retrying_ai");
        const retryIds = new Set(retryBatch.map((bookmark) => bookmark.id));
        const retryInputs = aiBookmarks.filter((bookmark) => retryIds.has(bookmark.id));
        const missingMetadata = retryInputs.filter((bookmark) => !bookmark.metadata?.available);
        const refreshed = missingMetadata.length
          ? await enrichBookmarksWithPageMetadata(missingMetadata, retryBatch, {
              sendFullUrl: settings.sendFullUrl, mode: "deep", signal: options.signal,
            })
          : [];
        const refreshedById = new Map(refreshed.map((bookmark) => [bookmark.id, bookmark]));
        await attempt(retryBatch, retryInputs.map((bookmark) => refreshedById.get(bookmark.id) ?? bookmark), true);
      }
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        summary.canceled = true;
        break;
      }
      fail(batch, "获取网页信息时发生错误，未完成的书签可稍后重试。");
    }
  }

  return summary;
}

/** 仅用于测试与 UI 展示：判断某条索引是否由 AI 生成 */
export function isAiImpression(meta: BookmarkImpressionMeta | undefined) {
  return meta?.source === "ai_organize" ||
    meta?.source === "ai_recommend" ||
    meta?.source === "ai_search_heal" ||
    meta?.source === "ai_batch_index";
}
