import type {
  AIQueryExpansionResult,
  AIRerankCandidateInput,
  BookmarkImpressionMeta,
  DeepSearchStage,
  ImpressionSearchResult,
  SearchableBookmark,
} from "../types";
import {
  AI_DATA_AUTHORIZATION_REQUIRED_MESSAGE,
  expandImpressionQueryWithAI,
  isAIProviderAuthorized,
  rerankImpressionCandidatesWithAI,
} from "./aiProvider";
import { getStaticImpressionKeywords } from "./domainHeuristics";
import { searchBookmarksByImpression } from "./impressionSearch";
import { hasUsableImpression, normalizeUrl, upsertBatchImpressions } from "./semanticIndex";
import { getSettings } from "./storage";

/** 单次深度搜索最多参与精排的候选数，控制 Stage 3 Token 体积 */
export const MAX_DEEP_SEARCH_CANDIDATES = 25;
/** 低于该相关度的精排结果直接丢弃 */
const MIN_RELEVANCE = 45;
/** 会话级缓存上限，避免长时间使用后无限增长 */
const EXPANSION_CACHE_LIMIT = 60;
const HTTP_URL_PATTERN = /^https?:\/\//i;

const expansionCache = new Map<string, AIQueryExpansionResult>();

export type DeepSearchCallbacks = {
  /** Stage 切换；expandedTerms 为展示在状态条上的联想词 */
  onStageChange: (stage: DeepSearchStage, expandedTerms?: string[]) => void;
  /** Stage 2 扩展召回完成或 Stage 3 精排完成时触发，供 UI 渐进式刷新列表 */
  onResultsUpdate: (results: ImpressionSearchResult[], isFinalReranked: boolean) => void;
  /** 配置缺失、鉴权失败等可展示给用户的错误 */
  onError?: (message: string) => void;
};

export type DeepSearchOptions = {
  query: string;
  bookmarks: SearchableBookmark[];
  semanticIndexMap: Record<string, BookmarkImpressionMeta>;
  existingTopFolders: string[];
  callbacks: DeepSearchCallbacks;
  signal?: AbortSignal;
  onTokenUsage?: (totalTokens: number) => void;
};

function isHttpUrl(url: string) {
  return HTTP_URL_PATTERN.test(url);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("AI 深度搜索已取消", "AbortError");
}

function readExpansionCache(query: string) {
  const cached = expansionCache.get(query);
  if (!cached) return undefined;
  // 命中后重新插入，维持近似 LRU 的顺序。
  expansionCache.delete(query);
  expansionCache.set(query, cached);
  return cached;
}

function writeExpansionCache(query: string, expansion: AIQueryExpansionResult) {
  if (!Object.values(expansion).some((list) => list.length > 0)) return;
  expansionCache.delete(query);
  expansionCache.set(query, expansion);
  while (expansionCache.size > EXPANSION_CACHE_LIMIT) {
    const oldest = expansionCache.keys().next().value;
    if (oldest === undefined) break;
    expansionCache.delete(oldest);
  }
}

/** 仅供测试与调试：清空会话缓存 */
export function clearImpressionExpansionCache() {
  expansionCache.clear();
}

/** 精简 URL：只保留 hostname 与第一级路径，避免长 query 浪费 Token */
export function toShortUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const firstPath = parsed.pathname.split("/").filter(Boolean)[0];
    return `${parsed.hostname.replace(/^www\./, "")}${firstPath ? `/${firstPath}` : ""}`;
  } catch {
    return rawUrl.slice(0, 50);
  }
}

/** 展示用联想词：核心意图 + 前几个推测站点，去重后截断 */
export function buildExpandedTerms(expansion: AIQueryExpansionResult, limit = 6): string[] {
  const seen = new Set<string>();
  return [...expansion.coreIntents, ...expansion.likelySites.slice(0, 3)]
    .map((term) => term.trim())
    .filter((term) => {
      if (!term) return false;
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

type ScoredCandidate = ImpressionSearchResult & { matchedClues: string[] };


/**
 * Stage 2：用扩展词包在本地全量书签中做多路宽网召回。
 * 四类线索分别计分，命中 AI 推测站点的裸书签也能被捞出。
 */
export function recallCandidatesWithExpansion(
  originalQuery: string,
  expansion: AIQueryExpansionResult,
  bookmarks: SearchableBookmark[],
  semanticIndexMap: Record<string, BookmarkImpressionMeta>,
  maxCandidates = MAX_DEEP_SEARCH_CANDIDATES
): ImpressionSearchResult[] {
  const scoreMap = new Map<string, ScoredCandidate>();

  for (const result of searchBookmarksByImpression(originalQuery, bookmarks, semanticIndexMap)) {
    scoreMap.set(result.bookmark.id, { ...result, matchedClues: [] });
  }

  const lower = (list: string[]) => list.map((item) => item.toLowerCase().trim()).filter(Boolean);
  const likelySites = lower(expansion.likelySites);
  const coreIntents = lower(expansion.coreIntents);
  const bilingualKeywords = lower(expansion.bilingualKeywords);
  const folderHints = lower(expansion.folderHints);

  for (const bookmark of bookmarks) {
    if (!isHttpUrl(bookmark.url)) continue;
    const meta = semanticIndexMap[normalizeUrl(bookmark.url)];
    const staticTags = getStaticImpressionKeywords(bookmark.url);

    const titleLower = bookmark.title.toLowerCase();
    const urlLower = bookmark.url.toLowerCase();
    const folderLower = bookmark.folderPath.toLowerCase();
    const indexBlob = [...(meta?.keywords ?? []), meta?.summary ?? "", ...staticTags]
      .join(" ")
      .toLowerCase();

    let extraScore = 0;
    const clues: string[] = [];

    // A. 命中 AI 依据世界知识推测的站点（高置信度，可穿透从未整理过的裸书签）
    const hitSite = likelySites.find((site) => urlLower.includes(site) || titleLower.includes(site));
    if (hitSite) {
      extraScore += 95;
      clues.push(`AI 联想站点：${hitSite}`);
    }

    // B. 命中核心功能意图词
    const hitIntents = coreIntents.filter(
      (intent) => titleLower.includes(intent) || indexBlob.includes(intent)
    );
    if (hitIntents.length) {
      extraScore += hitIntents.length * 50;
      clues.push(`AI 意图关联：${hitIntents.slice(0, 3).join(" / ")}`);
    }

    // C. 命中中英文同义词或 URL 词根
    const hitBilingual = bilingualKeywords.filter(
      (keyword) => titleLower.includes(keyword) || urlLower.includes(keyword) || indexBlob.includes(keyword)
    );
    if (hitBilingual.length) {
      extraScore += hitBilingual.length * 30;
      clues.push(`AI 扩展词：${hitBilingual.slice(0, 3).join(" / ")}`);
    }

    // D. 命中分类目录线索
    const hitFolder = folderHints.find((hint) => folderLower.includes(hint));
    if (hitFolder) {
      extraScore += 25;
      clues.push(`关联目录：${bookmark.folderPath || "根目录"}`);
    }

    if (!extraScore) continue;

    const existing = scoreMap.get(bookmark.id);
    if (existing) {
      existing.score += extraScore;
      existing.matchedClues.push(...clues);
      if (!existing.matchHint) existing.matchHint = clues[0];
    } else {
      scoreMap.set(bookmark.id, {
        bookmark,
        score: extraScore,
        matchType: "ai_keyword",
        matchHint: clues[0],
        displayTags: Array.from(new Set([...(meta?.keywords ?? []), ...staticTags])).slice(0, 4),
        matchedClues: clues,
      });
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) =>
      b.score - a.score ||
      a.bookmark.title.localeCompare(b.bookmark.title, "zh-CN")
    )
    .slice(0, Math.max(1, maxCandidates))
    .map(({ matchedClues: _matchedClues, ...result }) => result);
}

function toRerankInputs(
  candidates: ImpressionSearchResult[],
  semanticIndexMap: Record<string, BookmarkImpressionMeta>
): AIRerankCandidateInput[] {
  return candidates.flatMap((item) => {
    if (!isHttpUrl(item.bookmark.url)) return [];
    const meta = semanticIndexMap[normalizeUrl(item.bookmark.url)];
    const existingHint = meta?.summary?.trim() || item.displayTags.join("、");
    return [{
      id: item.bookmark.id,
      title: item.bookmark.title.slice(0, 60) || "未命名书签",
      shortUrl: toShortUrl(item.bookmark.url),
      folder: item.bookmark.folderPath || "根目录",
      ...(existingHint ? { existingHint: existingHint.slice(0, 80) } : {}),
    }];
  });
}

/**
 * V2 主流程：Stage 1 意图扩展 → Stage 2 本地宽网召回（先刷新 UI）
 * → Stage 3 候选精排 + 索引自愈（再刷新 UI）。
 * 任何阶段被 abort 时都静默返回，避免旧请求覆盖新搜索结果。
 */
export async function runDeepImpressionSearch(options: DeepSearchOptions): Promise<void> {
  const { query, bookmarks, semanticIndexMap, existingTopFolders, callbacks, signal } = options;
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return;

  let expandedTerms: string[] = [];

  try {
    const settings = await getSettings();
    throwIfAborted(signal);
    if (!settings.provider.apiKey) throw new Error("未配置 API Key，无法使用 AI 深度搜索");
    if (!isAIProviderAuthorized(settings.provider)) throw new Error(AI_DATA_AUTHORIZATION_REQUIRED_MESSAGE);

    // ===== Stage 1：AI 查询词联想扩展 =====
    callbacks.onStageChange("expanding");

    let expansion = readExpansionCache(trimmedQuery);
    if (!expansion) {
      expansion = await expandImpressionQueryWithAI(
        settings.provider,
        trimmedQuery,
        existingTopFolders,
        {
          signal,
          onTokenUsage: (usage) => options.onTokenUsage?.(usage.totalTokens),
        }
      );
      throwIfAborted(signal);
      writeExpansionCache(trimmedQuery, expansion);
    }

    expandedTerms = buildExpandedTerms(expansion);
    if (!Object.values(expansion).some((list) => list.length > 0)) {
      // 模型没有给出任何线索时，退回 V1 本地结果，避免发出无意义的精排请求。
      callbacks.onResultsUpdate(
        searchBookmarksByImpression(trimmedQuery, bookmarks, semanticIndexMap),
        false
      );
      callbacks.onStageChange("completed");
      return;
    }

    // ===== Stage 2：本地宽网召回，立即刷新 UI =====
    const candidates = recallCandidatesWithExpansion(
      trimmedQuery,
      expansion,
      bookmarks,
      semanticIndexMap
    );
    throwIfAborted(signal);
    callbacks.onStageChange("expanded_shown", expandedTerms);
    callbacks.onResultsUpdate(candidates, false);

    if (!candidates.length) {
      callbacks.onStageChange("completed", expandedTerms);
      return;
    }

    // ===== Stage 3：AI 候选集精排与索引自愈 =====
    const reranked = await rerankImpressionCandidatesWithAI(
      settings.provider,
      trimmedQuery,
      toRerankInputs(candidates, semanticIndexMap),
      {
        signal,
        onTokenUsage: (usage) => options.onTokenUsage?.(usage.totalTokens),
      }
    );
    throwIfAborted(signal);

    const candidateById = new Map(candidates.map((candidate) => [candidate.bookmark.id, candidate]));
    const finalResults: ImpressionSearchResult[] = [];
    const healInputs: Array<{
      url: string;
      bookmarkId: string;
      keywords: string[];
      summary: string;
      folderSnapshot?: string;
    }> = [];

    for (const item of reranked) {
      if (item.relevance < MIN_RELEVANCE) continue;
      const candidate = candidateById.get(item.id);
      if (!candidate) continue;
      const { bookmark } = candidate;
      const existingMeta = semanticIndexMap[normalizeUrl(bookmark.url)];

      const mergedKeywords = Array.from(new Set([
        ...(existingMeta?.keywords ?? []),
        ...item.healedKeywords,
      ])).slice(0, 8);
      const healedSummary = item.healedSummary || existingMeta?.summary || item.matchReason;
      const shouldHeal = !hasUsableImpression(existingMeta) &&
        Boolean(mergedKeywords.length || healedSummary);

      finalResults.push({
        bookmark,
        // 精排确认项统一排在扩展召回项之前
        score: 1000 + item.relevance,
        matchType: "ai_rerank",
        matchHint: `AI 深度匹配：${item.matchReason || "语义相关"}`,
        displayTags: mergedKeywords.slice(0, 4),
        healed: shouldHeal,
      });

      if (shouldHeal) {
        healInputs.push({
          url: bookmark.url,
          bookmarkId: bookmark.id,
          keywords: mergedKeywords,
          summary: healedSummary,
          folderSnapshot: bookmark.folderPath || undefined,
        });
      }
    }

    // 自愈落盘失败不应影响搜索结果展示，下次搜索会再次尝试。
    if (healInputs.length) {
      await upsertBatchImpressions(healInputs.map((input) => ({
        ...input,
        source: "ai_search_heal" as const,
      }))).catch(() => undefined);
    }

    if (finalResults.length) callbacks.onResultsUpdate(finalResults, true);
    callbacks.onStageChange("completed", expandedTerms);
  } catch (error) {
    if (signal?.aborted) return;
    if (error instanceof DOMException && error.name === "AbortError") return;
    callbacks.onError?.(error instanceof Error ? error.message : "AI 深度搜索失败");
    callbacks.onStageChange("error");
  }
}
