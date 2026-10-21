import type {
  BookmarkImpressionMeta,
  ImpressionSearchResult,
  SearchableBookmark,
} from "../types";
import { getStaticImpressionKeywords } from "./domainHeuristics";
import { normalizeUrl } from "./semanticIndex";

/** 口语连接词、虚词与泛指后缀：剥离后保留核心功能词，原词仍用于高优先级的完整匹配 */
const STOP_WORDS_REGEX = /(那个|什么|怎么|在线|免费|好用|常用|网站|网址|网页|工具|平台|软件|系统|的|了|呢|啊|吧)/g;
const CJK_PATTERN = /[一-龥]/;

export type ParsedQuery = {
  /** 原始清理后的搜索词，例如 "好用的看视频的网站" */
  rawQuery: string;
  /** 提取出的核心意图词组，例如 ["视频", "图片压缩"] */
  tokens: string[];
};

function addChineseNgrams(source: string, target: Set<string>) {
  if (!CJK_PATTERN.test(source) || source.length <= 2) return;
  for (let index = 0; index < source.length - 1; index += 1) {
    const gram = source.slice(index, index + 2).trim();
    if (gram.length === 2 && CJK_PATTERN.test(gram)) target.add(gram);
  }
}

/**
 * 将口语化印象输入拆分为核心词组。
 * 例如「好用的看视频的网站」→ ["好用的看视频的网站","看视频","视频",...]。
 */
export function parseUserImpressionQuery(input: string): ParsedQuery {
  const rawQuery = input.trim().toLowerCase();
  if (!rawQuery) return { rawQuery: "", tokens: [] };

  const baseParts = rawQuery.split(/[\s,，。、/\\|+\-_]+/).filter(Boolean);
  const tokenSet = new Set<string>(baseParts);

  for (const part of baseParts) {
    const stripped = part.replace(STOP_WORDS_REGEX, " ").trim();
    for (const chunk of stripped.split(/\s+/).filter(Boolean)) {
      if (chunk.length >= 2) tokenSet.add(chunk);
      addChineseNgrams(chunk, tokenSet);
    }

    if (part.endsWith("网站") && part.length > 2) tokenSet.add(part.slice(0, -2));
    if (part.endsWith("工具") && part.length > 2) tokenSet.add(part.slice(0, -2));
    if (part.endsWith("平台") && part.length > 2) tokenSet.add(part.slice(0, -2));
  }

  // 单字词噪声过大（如“看”“找”），只在整句就是单字时保留。
  const tokens = Array.from(tokenSet).filter((token) => token.length >= 2 || token === rawQuery);
  return { rawQuery, tokens };
}

function textIncludesQuery(text: string, rawQuery: string, tokens: string[]) {
  if (!text) return [];
  if (text.includes(rawQuery)) return [rawQuery];
  return tokens.filter((token) => text.includes(token));
}

function tagsIncludeQuery(tags: string[], rawQuery: string, tokens: string[]) {
  return tags.filter((tag) => {
    const value = tag.toLowerCase();
    return value.includes(rawQuery) || rawQuery.includes(value) || tokens.some((token) => value.includes(token));
  });
}

function truncateSummary(summary: string) {
  const compact = summary.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? compact.slice(0, 60) + "…" : compact;
}

/**
 * 多字段加权检索：标题、AI 印象标签、文件夹、AI 功能简述、域名静态兜底与 URL。
 * 同时记录最佳命中类型与命中说明，用于 UI 解释“为什么搜出了这个书签”。
 */
export function searchBookmarksByImpression(
  query: string,
  bookmarks: SearchableBookmark[],
  semanticIndexMap: Record<string, BookmarkImpressionMeta>
): ImpressionSearchResult[] {
  const { rawQuery, tokens } = parseUserImpressionQuery(query);
  if (!rawQuery) return [];

  const results: ImpressionSearchResult[] = [];

  for (const bookmark of bookmarks) {
    if (!bookmark.url) continue;
    const normalizedUrl = normalizeUrl(bookmark.url);
    const meta = semanticIndexMap[normalizedUrl];
    const aiKeywords = meta?.keywords ?? [];
    const aiSummary = meta?.summary ?? "";
    const heuristicTags = getStaticImpressionKeywords(bookmark.url);

    const titleLower = (bookmark.title || "").toLowerCase();
    const urlLower = bookmark.url.toLowerCase();
    const folderLower = (bookmark.folderPath || "").toLowerCase();
    const summaryLower = aiSummary.toLowerCase();

    let totalScore = 0;
    let bestMatchType: ImpressionSearchResult["matchType"] = "url";
    let bestMatchScore = 0;
    let matchHint: string | undefined;

    const updateBestMatch = (
      type: ImpressionSearchResult["matchType"],
      scoreDelta: number,
      hint?: string
    ) => {
      if (scoreDelta <= 0) return;
      totalScore += scoreDelta;
      if (scoreDelta > bestMatchScore) {
        bestMatchScore = scoreDelta;
        bestMatchType = type;
        matchHint = hint;
      }
    };

    // 1. 标题
    const titleHits = textIncludesQuery(titleLower, rawQuery, tokens);
    if (titleHits.length) {
      updateBestMatch("title", titleHits.includes(rawQuery) ? 100 : titleHits.length * 60);
    }

    // 2. AI 印象标签
    const hitAiKeywords = tagsIncludeQuery(aiKeywords, rawQuery, tokens);
    if (hitAiKeywords.length) {
      const isExact = hitAiKeywords.some((keyword) => keyword.toLowerCase().includes(rawQuery));
      updateBestMatch(
        "ai_keyword",
        isExact ? 95 : hitAiKeywords.length * 55,
        `匹配功能印象：${hitAiKeywords.join(" / ")}`
      );
    }

    // 3. 所在文件夹
    const folderHits = textIncludesQuery(folderLower, rawQuery, tokens);
    if (folderHits.length) {
      updateBestMatch(
        "folder",
        folderHits.includes(rawQuery) ? 80 : 45,
        `所在分类：${bookmark.folderPath}`
      );
    }

    // 4. AI 功能简述
    if (summaryLower) {
      if (summaryLower.includes(rawQuery)) {
        updateBestMatch("ai_summary", 75, `功能描述：${truncateSummary(aiSummary)}`);
      } else {
        const summaryHits = tokens.filter((token) => summaryLower.includes(token));
        if (summaryHits.length) {
          updateBestMatch("ai_summary", summaryHits.length * 40, `功能描述：${truncateSummary(aiSummary)}`);
        }
      }
    }

    // 5. 域名静态启发词（存量书签冷启动兜底）
    const hitHeuristics = tagsIncludeQuery(heuristicTags, rawQuery, tokens);
    if (hitHeuristics.length) {
      updateBestMatch(
        "heuristic",
        hitHeuristics.some((tag) => tag.toLowerCase().includes(rawQuery)) ? 65 : hitHeuristics.length * 35,
        `站点类型识别：${hitHeuristics.join(" / ")}`
      );
    }

    // 6. URL / 域名
    if (urlLower.includes(rawQuery)) {
      updateBestMatch("url", 50);
    }

    if (totalScore > 0) {
      results.push({
        bookmark,
        score: totalScore,
        matchType: bestMatchType,
        matchHint,
        displayTags: Array.from(new Set([...aiKeywords, ...heuristicTags])).slice(0, 4),
      });
    }
  }

  return results.sort((a, b) =>
    b.score - a.score ||
    a.bookmark.title.localeCompare(b.bookmark.title, "zh-CN")
  );
}

/** 命中 AI 标签、AI 简述或域名兜底时，UI 应显式渲染“匹配功能印象”提示条 */
export function isImpressionMatch(result: ImpressionSearchResult) {
  return result.matchType === "ai_keyword" ||
    result.matchType === "ai_summary" ||
    result.matchType === "ai_rerank" ||
    result.matchType === "heuristic";
}

/** 搜索结果命中条目前缀：AI 精排用 🎯，其余印象命中用 ✨ */
export function getImpressionMatchIcon(result: ImpressionSearchResult) {
  return result.matchType === "ai_rerank" ? "🎯" : "✨";
}
