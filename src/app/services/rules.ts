import type { BookmarkForAI, BookmarkNode, ClassificationResult, ClassificationRule } from "../types";

export function sanitizeUrl(url: string, sendFullUrl = false) {
  try {
    const parsed = new URL(url);
    if (sendFullUrl) return parsed.toString();
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function getDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function toBookmarkForAI(bookmark: BookmarkNode, sendFullUrl = false): BookmarkForAI {
  return {
    id: bookmark.id,
    title: bookmark.title,
    domain: bookmark.url ? getDomain(bookmark.url) : "",
    path: bookmark.path.join(" / "),
    sanitizedUrl: bookmark.url ? sanitizeUrl(bookmark.url, sendFullUrl) : "",
  };
}

function result(
  id: string,
  categoryPath: string[],
  confidence: number,
  reason: string,
  source: ClassificationResult["source"] = "rule"
): ClassificationResult {
  return {
    id,
    category: categoryPath.join(" / "),
    categoryPath,
    confidence,
    reason,
    source,
  };
}

export function classifyWithRules(
  bookmark: BookmarkNode,
  learnedRules: ClassificationRule[] = []
): ClassificationResult | null {
  const title = bookmark.title.toLowerCase();
  const domain = bookmark.url ? getDomain(bookmark.url).toLowerCase() : "";
  const haystack = `${title} ${domain}`;

  const learned = learnedRules.find((rule) => haystack.includes(rule.match.toLowerCase()));
  if (learned) {
    return result(bookmark.id, learned.folderPath, learned.confidence, "匹配用户调整过的本地分类规则");
  }

  if (/(github|stackoverflow|npmjs|typescript|react|vue|vite|developer|docs|api|mdn|vercel|nodejs|tailwind)/.test(haystack)) {
    return result(bookmark.id, ["开发", "文档与工具"], 0.88, "匹配开发文档、代码托管或技术工具站点");
  }
  if (/(figma|dribbble|behance|design|icon|font|color|ui|ux)/.test(haystack)) {
    return result(bookmark.id, ["设计", "工具与灵感"], 0.86, "匹配设计工具或设计参考站点");
  }
  if (/(taobao|tmall|jd|amazon|shop|mall|store|aliexpress|ebay)/.test(haystack)) {
    return result(bookmark.id, ["购物"], 0.9, "匹配电商购物站点");
  }
  if (/(news|medium|substack|hacker news|ycombinator|36kr|sspai|techcrunch|theverge)/.test(haystack)) {
    return result(bookmark.id, ["资讯", "文章"], 0.84, "匹配资讯、博客或文章站点");
  }
  if (/(youtube|netflix|bilibili|spotify|music|video|movie|douban)/.test(haystack)) {
    return result(bookmark.id, ["娱乐", "影音"], 0.87, "匹配影音娱乐站点");
  }
  if (/(gmail|outlook|notion|slack|trello|asana|linear|calendar|office)/.test(haystack)) {
    return result(bookmark.id, ["效率", "工作"], 0.84, "匹配办公协作或效率工具");
  }
  if (/(openai|chatgpt|deepseek|claude|gemini|kimi|glm|ai)/.test(haystack)) {
    return result(bookmark.id, ["AI", "工具"], 0.86, "匹配 AI 工具或模型服务");
  }

  return null;
}

export function normalizeCategoryPath(path: string[] | undefined, allowNested: boolean, maxDepth: number) {
  const safePath = (path?.length ? path : ["待整理"]).map((part) => String(part).trim()).filter(Boolean);
  return safePath.slice(0, allowNested ? Math.max(1, maxDepth) : 1);
}
