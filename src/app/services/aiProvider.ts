import type {
  AIProviderConfig,
  AIProviderType,
  AIQueryExpansionResult,
  AIRerankCandidateInput,
  AIRerankResultItem,
  BookmarkForAI,
  ClassificationResult,
  FolderHabitProfile,
  FolderHabitSample,
  PreviewTaskPhase,
  TokenUsage,
} from "../types";
import { hasRequiredHostPermission, HOST_PERMISSION_REQUIRED_MESSAGE } from "./hostPermissions";
import {
  buildCandidateRerankPrompt,
  buildQueryExpansionPrompt,
} from "./impressionSearchPrompts";

type ClassificationOptions = {
  maxTopLevelFolders: number;
  maxSubfoldersPerFolder: number;
  allowNestedFolders: boolean;
  habitProfile?: FolderHabitProfile | null;
  customPrompt?: string;
  existingCategories?: string[];
  existingFolderPaths?: string[][];
  signal?: AbortSignal;
  onTokenUsage?: (usage: TokenUsage) => void;
  onStage?: (stage: Extract<PreviewTaskPhase, "requesting_ai" | "parsing_results">) => void | Promise<void>;
};

export type CategoryScheme = {
  topLevelCategories: string[];
  subCategories: Record<string, string[]>;
};

type TokenParam = "max_tokens" | "max_completion_tokens";
const CLASSIFICATION_REQUEST_TIMEOUT_MS = 90 * 1000;
const CONNECTION_TEST_TIMEOUT_MS = 15 * 1000;
const MODEL_LIST_TIMEOUT_MS = 15 * 1000;
const HABIT_ANALYSIS_TIMEOUT_MS = 120 * 1000;
/** V2 深度搜索追求低延迟：Stage 1 只做短输出，Stage 3 候选集有限 */
const QUERY_EXPANSION_TIMEOUT_MS = 20 * 1000;
const RERANK_TIMEOUT_MS = 30 * 1000;

export type AIModelOption = {
  id: string;
  ownedBy?: string;
};

export type AIProviderProfile = {
  type: AIProviderType;
  label: string;
  model: string;
  endpoint: string;
  tokenParam: TokenParam;
  supportsJsonMode: boolean;
  supportsTemperature: boolean;
  defaultTemperature?: number;
  endpointHint: string;
  modelHint: string;
  limitations: string[];
  statusMessages: Record<string, string>;
};

export const AI_PROVIDER_PROFILES: Record<AIProviderType, AIProviderProfile> = {
  openai: {
    type: "openai",
    label: "OpenAI",
    model: "gpt-5.4-mini",
    endpoint: "https://api.openai.com/v1",
    tokenParam: "max_completion_tokens",
    supportsJsonMode: true,
    supportsTemperature: false,
    endpointHint: "使用 OpenAI /v1 OpenAI-compatible 接口。",
    modelHint: "默认模型使用 max_completion_tokens，部分推理模型不支持 temperature。",
    limitations: ["不发送 temperature", "支持 JSON mode"],
    statusMessages: {},
  },
  deepseek: {
    type: "deepseek",
    label: "DeepSeek",
    model: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com",
    tokenParam: "max_tokens",
    supportsJsonMode: true,
    supportsTemperature: true,
    defaultTemperature: 0.1,
    endpointHint: "DeepSeek endpoint 会自动兼容是否包含 /v1。",
    modelHint: "使用 deepseek-chat/deepseek-reasoner 或兼容模型名。",
    limitations: ["支持 temperature", "支持 JSON mode"],
    statusMessages: {},
  },
  zhipu: {
    type: "zhipu",
    label: "智谱 GLM",
    model: "glm-5.1",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    tokenParam: "max_tokens",
    supportsJsonMode: true,
    supportsTemperature: true,
    defaultTemperature: 0.1,
    endpointHint: "智谱 GLM 使用 /api/paas/v4 OpenAI-compatible 接口。",
    modelHint: "填写 GLM OpenAI-compatible 模型名。",
    limitations: ["支持 temperature", "支持 JSON mode"],
    statusMessages: {},
  },
  kimi: {
    type: "kimi",
    label: "Kimi",
    model: "kimi-k2.6",
    endpoint: "https://api.moonshot.ai/v1",
    tokenParam: "max_tokens",
    supportsJsonMode: false,
    supportsTemperature: true,
    defaultTemperature: 1,
    endpointHint: "Kimi 使用 Moonshot /v1 OpenAI-compatible 接口。",
    modelHint: "填写 kimi 系列模型名；当前模型默认使用 temperature 1。",
    limitations: ["temperature 默认 1", "不强制 JSON mode，依赖 prompt 约束输出 JSON"],
    statusMessages: {},
  },
  gemini: {
    type: "gemini",
    label: "Gemini",
    model: "gemini-3-flash-preview",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    tokenParam: "max_tokens",
    supportsJsonMode: false,
    supportsTemperature: true,
    defaultTemperature: 0.1,
    endpointHint: "Gemini 使用 Google OpenAI compatibility endpoint。",
    modelHint: "填写 Gemini OpenAI-compatible 模型名。",
    limitations: ["不强制 JSON mode，依赖 prompt 约束输出 JSON"],
    statusMessages: {},
  },
  minimax: {
    type: "minimax",
    label: "MiniMax",
    model: "MiniMax-M2.7",
    endpoint: "https://api.minimax.io/v1",
    tokenParam: "max_completion_tokens",
    supportsJsonMode: false,
    supportsTemperature: true,
    defaultTemperature: 0.1,
    endpointHint: "MiniMax 使用 /v1 OpenAI-compatible 接口。",
    modelHint: "填写 MiniMax OpenAI-compatible 模型名。",
    limitations: ["不强制 JSON mode，依赖 prompt 约束输出 JSON"],
    statusMessages: {},
  },
  qwen: {
    type: "qwen",
    label: "通义千问",
    model: "qwen-plus",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    tokenParam: "max_tokens",
    supportsJsonMode: true,
    supportsTemperature: true,
    defaultTemperature: 0.1,
    endpointHint: "通义千问使用 DashScope compatible-mode endpoint。",
    modelHint: "填写 qwen 系列兼容模式模型名。",
    limitations: ["支持 temperature", "支持 JSON mode"],
    statusMessages: {},
  },
  doubao: {
    type: "doubao",
    label: "火山方舟 / 豆包",
    model: "doubao-seed-1-6-251015",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    tokenParam: "max_tokens",
    supportsJsonMode: false,
    supportsTemperature: true,
    defaultTemperature: 0.1,
    endpointHint: "豆包使用火山方舟 OpenAI-compatible endpoint。",
    modelHint: "填写方舟 endpoint 可访问的模型或接入点名称。",
    limitations: ["不强制 JSON mode，依赖 prompt 约束输出 JSON"],
    statusMessages: {},
  },
  custom: {
    type: "custom",
    label: "自定义",
    model: "gpt-5.4-mini",
    endpoint: "https://api.openai.com/v1",
    tokenParam: "max_completion_tokens",
    supportsJsonMode: true,
    supportsTemperature: true,
    defaultTemperature: 0.1,
    endpointHint: "自定义 Provider 需兼容 /chat/completions。",
    modelHint: "填写目标服务支持的模型名。",
    limitations: ["按 OpenAI-compatible 响应解析 choices[0].message.content"],
    statusMessages: {},
  },
};

export const AI_PROVIDER_OPTIONS = Object.values(AI_PROVIDER_PROFILES);

export const AI_DATA_AUTHORIZATION_REQUIRED_MESSAGE = "尚未授权向 AI 服务发送分类所需数据。请在设置中测试连接后，开启“允许向此服务发送分类数据”。";

export function isAIProviderAuthorized(config: AIProviderConfig) {
  return Boolean(config.apiKey && config.enabled);
}

function profileFor(type: AIProviderType) {
  return AI_PROVIDER_PROFILES[type] ?? AI_PROVIDER_PROFILES.custom;
}

export function endpointFor(config: AIProviderConfig) {
  const endpoint = config.endpoint?.replace(/\/$/, "");
  const profile = profileFor(config.type);
  if (config.type === "deepseek" && endpoint?.endsWith("/v1")) {
    return endpoint.slice(0, -3);
  }
  if (endpoint) return endpoint;
  return profile.endpoint;
}

function compactResponseDetail(detail: string) {
  return detail.replace(/\s+/g, " ").trim().slice(0, 180);
}

function providerStatusMessage(profile: AIProviderProfile, status: number, detail: string) {
  const custom = profile.statusMessages[String(status)];
  if (custom) return custom;

  const suffix = compactResponseDetail(detail);
  const detailText = suffix ? ` 服务返回：${suffix}` : "";
  if (status === 401) return `${profile.label} 认证失败：API Key 无效、缺失或未授权。${detailText}`;
  if (status === 403) return `${profile.label} 拒绝请求：请检查模型权限、账户余额、区域限制或 endpoint 权限。${detailText}`;
  if (status === 404) return `${profile.label} 未找到资源：请检查 endpoint 是否正确，以及模型名是否存在。${detailText}`;
  if (status === 429) return `${profile.label} 请求受限：额度不足、并发过高或触发限流，请稍后重试或减少本次整理数量。${detailText}`;
  if (status >= 500) return `${profile.label} 服务端临时异常：请稍后重试，或切换模型/Provider。${detailText}`;
  return `${profile.label} 请求失败：HTTP ${status}。${detailText}`;
}

function extractJson(content: string) {
  return extractJsonCandidates(content)[0] ?? content.trim();
}

function extractJsonCandidates(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const fencedContent = fenced[1].trim();
    const fencedCandidates = extractBalancedJsonCandidates(fencedContent);
    return fencedCandidates.length ? fencedCandidates : [fencedContent];
  }

  const candidates = extractBalancedJsonCandidates(trimmed);
  return candidates.length ? candidates : [trimmed];
}

function extractBalancedJsonCandidates(content: string) {
  const candidates: string[] = [];

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char !== "{" && char !== "[") continue;

    const end = findBalancedJsonEnd(content, index);
    if (end > index) {
      candidates.push(content.slice(index, end + 1).trim());
      index = end;
    }
  }

  return candidates;
}

function findBalancedJsonEnd(content: string, start: number) {
  const open = content[start];
  const close = open === "{" ? "}" : "]";
  const stack = [close];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < content.length; index += 1) {
    const char = content[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return index;
    }
  }

  return -1;
}

function debugAI(label: string, payload: unknown) {
  console.debug(`[ReMarks AI] ${label}`, payload);
}

function normalizeKeywords(value: unknown, limit = 6) {
  const keywords = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[/>｜|,，、]/)
      : [];
  const seen = new Set<string>();
  return keywords
    .map((item) => String(item).trim().slice(0, 24))
    .filter((keyword) => {
      if (!keyword) return false;
      const key = keyword.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function asStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((part) => String(part).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[/>｜|,，]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeConfidence(value: unknown) {
  if (typeof value === "number") {
    return value > 1 && value <= 100 ? value / 100 : value;
  }
  if (typeof value === "string") {
    const number = Number(value.replace("%", "").trim());
    if (!Number.isFinite(number)) return 0;
    return number > 1 && number <= 100 ? number / 100 : number;
  }
  return 0;
}

function normalizeClassificationDecision(value: unknown, categoryPath: string[]) {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["defer", "abstain", "manual_review", "uncertain"].includes(normalized)) return "defer" as const;
    if (["new_folder", "propose_new_category", "new_category"].includes(normalized)) return "new_folder" as const;
    if (["existing_folder", "classify", "existing_category"].includes(normalized)) return "existing_folder" as const;
  }

  return categoryPath.some((part) => ["待整理", "未分类"].includes(part.trim()))
    ? "defer" as const
    : "existing_folder" as const;
}

function normalizeTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens);

  if (![promptTokens, completionTokens, totalTokens].some((item) => Number.isFinite(item) && item > 0)) {
    return undefined;
  }

  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

function parseJsonStringLiteral(value: string) {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
  }
}

function extractLooseStringArray(block: string, keys: string[]) {
  for (const key of keys) {
    const arrayMatch = block.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    if (arrayMatch?.[1]) {
      return [...arrayMatch[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
        .map((match) => parseJsonStringLiteral(match[1]).trim())
        .filter(Boolean);
    }

    const stringMatch = block.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (stringMatch?.[1]) {
      return asStringArray(parseJsonStringLiteral(stringMatch[1]));
    }
  }

  return [];
}

function extractLooseReason(block: string) {
  const reasonMatch = block.match(/"reason"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"[^"]+"\s*:|\s*}\s*,?\s*$)/);
  return reasonMatch?.[1] ? parseJsonStringLiteral(reasonMatch[1]).trim() : undefined;
}

function extractLooseStringField(block: string, keys: string[]) {
  for (const key of keys) {
    const match = block.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (match?.[1]) return parseJsonStringLiteral(match[1]).trim();
  }
  return "";
}

export type BookmarkImpressionSuggestion = {
  id: string;
  keywords: string[];
  summary: string;
};

function parseImpressionResults(content: string): BookmarkImpressionSuggestion[] {
  const jsonText = extractJson(content);
  const results: BookmarkImpressionSuggestion[] = [];

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? (["results", "items", "data"] as const)
            .map((key) => (parsed as Record<string, unknown>)[key])
            .find(Array.isArray) ?? []
        : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id.trim() : "";
      if (!id) continue;
      const keywords = normalizeKeywords(value.keywords ?? value.tags ?? value.impressions);
      const summary = typeof value.summary === "string"
        ? value.summary.trim()
        : typeof value.reason === "string" ? value.reason.trim() : "";
      if (!keywords.length && !summary) continue;
      results.push({ id, keywords, summary });
    }
    if (results.length) return results;
  } catch {
    // 继续尝试宽松解析，兼容缺少引号或尾随逗号的响应。
  }

  const recordPattern = /"id"\s*:\s*"((?:\\.|[^"\\])*)"([\s\S]*?)(?=,\s*\{\s*"id"\s*:|\]\s*\}?\s*$|\}\s*\]\s*\}?\s*$)/g;
  for (const match of content.matchAll(recordPattern)) {
    const id = parseJsonStringLiteral(match[1]).trim();
    if (!id) continue;
    const block = match[2];
    const keywords = normalizeKeywords(extractLooseStringArray(block, ["keywords", "tags", "impressions"]));
    const summary = extractLooseStringField(block, ["summary", "reason"]);
    if (!keywords.length && !summary) continue;
    results.push({ id, keywords, summary });
  }
  return results;
}

/** 仅生成功能印象标签，不返回分类建议，用于补全未索引书签 */
export async function extractImpressionsWithAI(
  config: AIProviderConfig,
  bookmarks: BookmarkForAI[],
  options?: { signal?: AbortSignal; onTokenUsage?: (usage: TokenUsage) => void }
) {
  if (!bookmarks.length || !config.apiKey) return [];

  const completion = await chatCompletion(
    config,
    [
      {
        role: "system",
        content:
          "你是浏览器书签功能印象标注助手。必须输出合法 JSON，不要 Markdown，不要解释。" +
          "请为每个书签生成：summary（一句话说明网站核心功能，15~35字）和 keywords（3~5 个功能印象词）。" +
          "keywords 要站在“用户忘记网站名字时，会在搜索框输入什么功能词或品类词来找它”的角度生成，例如 Cupfox → [\"视频网站\",\"在线看剧\",\"影视搜索\",\"电影网站\"]，Squoosh → [\"图片压缩\",\"图像优化\",\"WebP转换\"]。" +
          "不要只重复书签标题里已有的词；无法判断时 keywords 返回空数组，不要编造。" +
          "输出格式为 {\"results\":[{\"id\":\"输入 id\",\"keywords\":[\"功能印象词\"],\"summary\":\"网站功能简述\"}]}，每一项必须对应输入中的一个 id。",
      },
      {
        role: "user",
        content: `请为这些书签生成功能印象，只返回 JSON：\n${JSON.stringify(bookmarks)}`,
      },
    ],
    2400,
    true,
    CLASSIFICATION_REQUEST_TIMEOUT_MS,
    options?.signal
  );

  if (completion.tokenUsage) options?.onTokenUsage?.(completion.tokenUsage);

  const results = parseImpressionResults(completion.content);
  debugAI("parsed impressions", {
    inputCount: bookmarks.length,
    outputCount: results.length,
    ids: results.map((result) => result.id),
  });
  return results;
}

const EMPTY_QUERY_EXPANSION: AIQueryExpansionResult = {
  coreIntents: [],
  bilingualKeywords: [],
  likelySites: [],
  folderHints: [],
};

function cleanClueList(value: unknown, limit: number) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[/>｜|,，、]/)
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of values) {
    const clue = String(item).trim().slice(0, 40);
    if (!clue) continue;
    const key = clue.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clue);
    if (result.length >= limit) break;
  }
  return result;
}

function parseQueryExpansion(content: string): AIQueryExpansionResult {
  for (const candidate of extractJsonCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const value = parsed as Record<string, unknown>;
      const expansion: AIQueryExpansionResult = {
        coreIntents: cleanClueList(value.coreIntents ?? value.intents, 5),
        bilingualKeywords: cleanClueList(value.bilingualKeywords ?? value.keywords, 8),
        likelySites: cleanClueList(value.likelySites ?? value.sites, 8),
        folderHints: cleanClueList(value.folderHints ?? value.folders, 4),
      };
      if (Object.values(expansion).some((list) => list.length > 0)) return expansion;
    } catch {
      // 继续尝试下一个 JSON 片段。
    }
  }
  return EMPTY_QUERY_EXPANSION;
}

function parseRerankResults(content: string): AIRerankResultItem[] {
  const items: unknown[] = [];

  for (const candidate of extractJsonCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        items.push(...parsed);
        break;
      }
      if (parsed && typeof parsed === "object") {
        const list = (["results", "items", "data"] as const)
          .map((key) => (parsed as Record<string, unknown>)[key])
          .find(Array.isArray);
        if (Array.isArray(list)) {
          items.push(...list);
          break;
        }
      }
    } catch {
      // 继续尝试下一个 JSON 片段。
    }
  }

  const results: AIRerankResultItem[] = [];
  const seenIds = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!id || seenIds.has(id)) continue;
    const relevance = Number(value.relevance ?? value.score);
    if (!Number.isFinite(relevance)) continue;
    const matchReason = typeof value.matchReason === "string"
      ? value.matchReason.trim()
      : typeof value.reason === "string" ? value.reason.trim() : "";
    seenIds.add(id);
    results.push({
      id,
      relevance: Math.max(0, Math.min(100, Math.round(relevance))),
      matchReason,
      healedKeywords: normalizeKeywords(value.healedKeywords ?? value.keywords),
      healedSummary: typeof value.healedSummary === "string"
        ? value.healedSummary.trim()
        : typeof value.summary === "string" ? value.summary.trim() : "",
    });
  }
  return results;
}

/** Stage 1：AI 查询词联想扩展，不发送任何书签数据 */
export async function expandImpressionQueryWithAI(
  config: AIProviderConfig,
  query: string,
  existingTopFolders: string[],
  options?: { signal?: AbortSignal; onTokenUsage?: (usage: TokenUsage) => void }
): Promise<AIQueryExpansionResult> {
  if (!config.apiKey || !query.trim()) return EMPTY_QUERY_EXPANSION;

  const completion = await chatCompletion(
    config,
    [
      {
        role: "system",
        content:
          "你是浏览器书签检索意图分析专家。必须输出合法 JSON 对象，不要 Markdown，不要解释。" +
          "用户会用模糊的功能印象描述来寻找忘记名字的书签，请把描述翻译成检索线索：" +
          "coreIntents 为 3~5 个核心功能意图词；bilingualKeywords 为 5~8 个可能出现在标题或 URL 中的中英文词根；" +
          "likelySites 为 4~8 个依据世界知识推测的知名站点域名或名称；folderHints 为 2~4 个可能的书签分类目录词。" +
          "只根据功能描述联想，不要编造与描述无关的站点。输出格式为 {\"coreIntents\":[],\"bilingualKeywords\":[],\"likelySites\":[],\"folderHints\":[]}。",
      },
      { role: "user", content: buildQueryExpansionPrompt(query, existingTopFolders) },
    ],
    600,
    true,
    QUERY_EXPANSION_TIMEOUT_MS,
    options?.signal
  );

  if (completion.tokenUsage) options?.onTokenUsage?.(completion.tokenUsage);
  const expansion = parseQueryExpansion(completion.content);
  debugAI("parsed query expansion", expansion);
  return expansion;
}

/** Stage 3：AI 候选集语义精排，并顺带生成可回写本地索引的功能印象 */
export async function rerankImpressionCandidatesWithAI(
  config: AIProviderConfig,
  query: string,
  candidates: AIRerankCandidateInput[],
  options?: { signal?: AbortSignal; onTokenUsage?: (usage: TokenUsage) => void }
): Promise<AIRerankResultItem[]> {
  if (!config.apiKey || !candidates.length) return [];

  const completion = await chatCompletion(
    config,
    [
      {
        role: "system",
        content:
          "你是浏览器书签语义检索精排助手。必须输出合法 JSON 数组，不要 Markdown，不要解释。" +
          "根据用户的功能印象搜索词，从候选书签中挑出真正相关的项，剔除明显无关项，最多保留 10 个。" +
          "每项输出 id、relevance（0~100，低于 45 的不要输出）、matchReason（15~30 字，向用户解释为什么符合）、" +
          "healedKeywords（3~5 个通用功能印象词）和 healedSummary（15~35 字的一句话用途描述）。" +
          "healedKeywords 与 healedSummary 必须描述站点本身的客观功能，不要针对本次搜索词定制；无法判断时返回空数组或空字符串，不要编造。",
      },
      { role: "user", content: buildCandidateRerankPrompt(query, candidates) },
    ],
    1600,
    true,
    RERANK_TIMEOUT_MS,
    options?.signal
  );

  if (completion.tokenUsage) options?.onTokenUsage?.(completion.tokenUsage);
  const results = parseRerankResults(completion.content);
  debugAI("parsed rerank results", {
    inputCount: candidates.length,
    outputCount: results.length,
    ids: results.map((result) => result.id),
  });
  return results;
}

function parseLooseResults(jsonText: string): ClassificationResult[] {
  const results: ClassificationResult[] = [];
  const recordPattern = /"id"\s*:\s*"((?:\\.|[^"\\])*)"([\s\S]*?)(?=,\s*\{\s*"id"\s*:|\]\s*\}?\s*$|\}\s*\]\s*\}?\s*$)/g;

  for (const match of jsonText.matchAll(recordPattern)) {
    const id = parseJsonStringLiteral(match[1]).trim();
    const block = match[2];
    const categoryPath = extractLooseStringArray(block, [
      "categoryPath",
      "folderPath",
      "suggestedFolderPath",
      "category_path",
      "path",
      "category",
    ]);
    const confidenceMatch = block.match(/"(?:confidence|score|probability)"\s*:\s*"?([0-9]+(?:\.[0-9]+)?%?)"?/);
    const confidence = normalizeConfidence(confidenceMatch?.[1]);
    const decisionMatch = block.match(/"(?:decision|action|classificationDecision)"\s*:\s*"([^"\\]+)"/);
    const decision = normalizeClassificationDecision(decisionMatch?.[1], categoryPath);

    if (!id || (decision !== "defer" && categoryPath.length === 0) || confidence <= 0 || confidence > 1) continue;

    results.push({
      id,
      category: categoryPath.join(" / "),
      categoryPath,
      confidence,
      reason: extractLooseReason(block) || "AI 分类建议",
      keywords: normalizeKeywords(extractLooseStringArray(block, ["keywords", "tags", "impressions"])),
      decision,
      source: "ai",
    });
  }

  return results;
}

function parseHabitProfile(content: string, fallback: Omit<FolderHabitProfile, "id" | "createdAt">): Omit<FolderHabitProfile, "id" | "createdAt"> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("AI 返回的画像内容为空，请重试");
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  // Parse the complete document so nested fragments cannot hide truncated output.
  const jsonText = fenced ? fenced[1].trim() : trimmed;
  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch {
    throw new Error("AI 返回的画像 JSON 不完整或格式无效，请重试");
  }

  const isRecord = (item: unknown): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item));
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && ["profile", "data", "result"].includes(keys[0])) {
      value = value[keys[0]];
    }
  }
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (!isRecord(value)) {
    throw new Error("AI 返回的画像必须是单个 JSON 对象");
  }

  const readStrings = (item: unknown): string[] | undefined =>
    Array.isArray(item) && item.every((part) => typeof part === "string" && part.trim())
      ? item.map((part: string) => part.trim())
      : undefined;
  const preferredTopLevelFolders = readStrings(value.preferredTopLevelFolders);
  const avoidRules = readStrings(value.avoidRules);
  const folderRules: FolderHabitProfile["folderRules"] = [];
  if (!Array.isArray(value.folderRules)) {
    throw new Error("AI 返回的画像缺少有效的文件夹规则");
  }
  for (const item of value.folderRules) {
    const folderPath = isRecord(item) ? readStrings(item.folderPath) : undefined;
    if (!folderPath?.length || folderPath.length > 3 || !isRecord(item) ||
        typeof item.pattern !== "string" || !item.pattern.trim()) {
      throw new Error("AI 返回的画像包含无效的文件夹路径或规则");
    }
    folderRules.push({ folderPath, pattern: item.pattern.trim() });
  }
  if (typeof value.summary !== "string" || !value.summary.trim() ||
      typeof value.promptHint !== "string" || !value.promptHint.trim() ||
      !preferredTopLevelFolders?.length || !folderRules.length || !avoidRules) {
    throw new Error("AI 返回的画像字段缺失或类型不正确，请重试");
  }

  return {
    folderCount: fallback.folderCount,
    bookmarkCount: fallback.bookmarkCount,
    summary: value.summary.trim(),
    preferredTopLevelFolders: preferredTopLevelFolders.slice(0, 16),
    folderRules: folderRules.slice(0, 30),
    avoidRules: avoidRules.slice(0, 10),
    promptHint: value.promptHint.trim(),
  };
}

export function parseResults(content: string): ClassificationResult[] {
  const jsonText = extractJson(content);
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (error) {
    const recovered = parseLooseResults(jsonText);
    if (recovered.length > 0) {
      debugAI("loose parsed results", {
        recoveredCount: recovered.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return recovered;
    }

    debugAI("JSON parse failed", {
      error: error instanceof Error ? error.message : String(error),
      extractedJson: jsonText,
      rawContent: content,
    });
    throw new Error("AI 返回格式不完整，无法解析为有效分类 JSON");
  }

  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (["results", "classifications", "items", "data"] as const)
          .map((key) => (parsed as Record<string, unknown>)[key])
          .find(Array.isArray) ?? []
      : [];
  if (!Array.isArray(items)) return [];

  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id : "";
    const categoryPath = asStringArray(
      value.categoryPath ??
        value.folderPath ??
        value.suggestedFolderPath ??
        value.category_path ??
        value.path ??
        value.category
    );
    const confidence = normalizeConfidence(value.confidence ?? value.score ?? value.probability);
    const decision = normalizeClassificationDecision(
      value.decision ?? value.action ?? value.classificationDecision,
      categoryPath
    );
    if (!id || (decision !== "defer" && categoryPath.length === 0) || confidence <= 0 || confidence > 1) return [];

    return [
      {
        id,
        category: categoryPath.join(" / "),
        categoryPath,
        confidence,
        reason: typeof value.reason === "string" ? value.reason : "AI 分类建议",
        keywords: normalizeKeywords(value.keywords ?? value.tags ?? value.impressions),
        decision,
        source: "ai" as const,
      },
    ];
  });
}

async function chatCompletion(
  config: AIProviderConfig,
  messages: Array<{ role: string; content: string }>,
  maxTokens = 800,
  jsonMode = false,
  timeoutMs = CLASSIFICATION_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal
) {
  if (!config.apiKey) throw new Error("缺少 API Key");
  if (!(await hasRequiredHostPermission())) throw new Error(HOST_PERMISSION_REQUIRED_MESSAGE);

  const profile = profileFor(config.type);
  const endpoint = endpointFor(config);
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
  };
  const temperature = config.temperature ?? profile.defaultTemperature;
  if (profile.supportsTemperature && temperature !== undefined) {
    body.temperature = temperature;
  }
  const tokenParam = config.tokenParam && config.tokenParam !== "auto"
    ? config.tokenParam
    : profile.tokenParam;
  const configuredMaxTokens = Number.isFinite(config.maxTokens) && (config.maxTokens ?? 0) > 0
    ? Math.round(config.maxTokens as number)
    : maxTokens;
  body[tokenParam] = configuredMaxTokens;

  const wantsJsonMode = config.jsonMode === "on"
    ? true
    : config.jsonMode === "off"
      ? false
      : jsonMode;
  const usesJsonMode = wantsJsonMode && profile.supportsJsonMode;
  if (usesJsonMode) {
    body.response_format = { type: "json_object" };
  }

  debugAI("request", {
    endpoint,
    model: config.model,
    jsonMode: usesJsonMode,
    maxTokens: configuredMaxTokens,
    temperature,
    provider: config.type,
    tokenParam,
    messageCount: messages.length,
  });

  const controller = new AbortController();
  const abortForExternalSignal = () => controller.abort();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  if (signal?.aborted) {
    throw new DOMException("AI request canceled", "AbortError");
  }
  signal?.addEventListener("abort", abortForExternalSignal, { once: true });

  try {
    response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    globalThis.clearTimeout(timer);
    if (error instanceof DOMException && error.name === "AbortError") {
      signal?.removeEventListener("abort", abortForExternalSignal);
      if (signal?.aborted) throw new DOMException("AI request canceled", "AbortError");
      throw new Error(`${profile.label} 请求超时：请稍后重试、减少本次整理数量，或检查模型服务是否可用。`);
    }
    signal?.removeEventListener("abort", abortForExternalSignal);
    throw new Error(`${profile.label} 网络请求失败：请检查 endpoint、网络连接或跨域兼容性。`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", abortForExternalSignal);
    throw new Error(providerStatusMessage(profile, response.status, detail));
  }

  try {
    const data = (await response.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; refusal?: string | null } }>;
      usage?: unknown;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    debugAI("raw response content", content);
    return {
      content,
      finishReason: data.choices?.[0]?.finish_reason,
      refusal: data.choices?.[0]?.message?.refusal,
      tokenUsage: normalizeTokenUsage(data.usage),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("AI 请求超时，请稍后重试或检查模型服务");
    }
    throw new Error(`${profile.label} 返回了非 OpenAI-compatible JSON：请检查 endpoint 是否为 /chat/completions 兼容接口。`);
  } finally {
    signal?.removeEventListener("abort", abortForExternalSignal);
    globalThis.clearTimeout(timer);
  }
}

export async function testAIConnection(config: AIProviderConfig) {
  const completion = await chatCompletion(
    config,
    [{ role: "user", content: "Return only the word ok." }],
    8,
    false,
    CONNECTION_TEST_TIMEOUT_MS
  );
  return completion.content.trim().length > 0;
}

export async function listAIModels(config: AIProviderConfig, signal?: AbortSignal): Promise<AIModelOption[]> {
  if (!config.apiKey.trim()) throw new Error("请先配置 API Key 后再查询模型");
  if (signal?.aborted) throw new DOMException("模型查询已取消", "AbortError");
  if (!(await hasRequiredHostPermission())) throw new Error(HOST_PERMISSION_REQUIRED_MESSAGE);

  const profile = profileFor(config.type);
  const endpoint = endpointFor(config);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = globalThis.setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

  try {
    // Google 原生列表提供生成能力和分页字段；代理地址仍使用其兼容接口。
    const url = new URL(`${endpoint}/models`);
    const nativeGemini = config.type === "gemini" &&
      url.hostname === "generativelanguage.googleapis.com" &&
      /\/openai\/models$/.test(url.pathname);
    if (nativeGemini) {
      url.pathname = url.pathname.replace(/\/openai\/models$/, "/models");
      url.searchParams.set("pageSize", "1000");
    }
    const models: AIModelOption[] = [];
    const seenTokens = new Set<string>();
    do {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(nativeGemini
          ? { "x-goog-api-key": config.apiKey.trim() }
          : { Authorization: `Bearer ${config.apiKey.trim()}` }),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        throw new Error(`${profile.label} 当前 Endpoint 不支持模型列表接口（HTTP ${response.status}）。请参考供应商文档手动输入模型名称，再测试连接。`);
      }
      const detail = await response.text().catch(() => "");
      throw new Error(providerStatusMessage(profile, response.status, detail));
    }

    const payload = (await response.json()) as unknown;
    const records = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object"
        ? ((payload as { data?: unknown; models?: unknown }).data ??
          (payload as { models?: unknown }).models)
        : undefined;

    if (!Array.isArray(records)) {
      throw new Error(`${profile.label} 返回的模型列表格式不受支持`);
    }

    models.push(...records.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as { id?: unknown; name?: unknown; owned_by?: unknown; ownedBy?: unknown; supportedGenerationMethods?: unknown };
      if (nativeGemini && (!Array.isArray(value.supportedGenerationMethods) ||
        !value.supportedGenerationMethods.includes("generateContent"))) return [];
      const idValue = typeof value.id === "string" ? value.id : value.name;
      if (typeof idValue !== "string" || !idValue.trim()) return [];
      const ownedByValue = value.owned_by ?? value.ownedBy;
      return [{
        id: nativeGemini ? idValue.trim().replace(/^models\//, "") : idValue.trim(),
        ownedBy: typeof ownedByValue === "string" ? ownedByValue : undefined,
      }];
    }));

    const nextToken = nativeGemini && payload && typeof payload === "object"
      ? (payload as { nextPageToken?: unknown }).nextPageToken : undefined;
    if (nextToken !== undefined && (typeof nextToken !== "string" || !nextToken.trim())) {
      throw new Error(`${profile.label} 返回了无效的模型分页标记`);
    }
    if (typeof nextToken !== "string") break;
    if (seenTokens.has(nextToken)) throw new Error(`${profile.label} 返回了重复的模型分页标记`);
    seenTokens.add(nextToken);
    url.searchParams.set("pageToken", nextToken);
    } while (!controller.signal.aborted);

    if (controller.signal.aborted) throw new DOMException("模型查询已取消", "AbortError");
    if (!models.length) throw new Error(`${profile.label} 未返回可选择的模型，请手动输入模型名称后测试连接`);

    return Array.from(new Map(models.map((model) => [model.id, model])).values())
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (signal?.aborted) throw error;
      throw new Error(`${profile.label} 模型列表查询超时，请稍后重试`);
    }
    if (error instanceof TypeError) throw new Error(`${profile.label} 模型列表查询失败，请检查 Endpoint、网络或跨域支持`);
    if (error instanceof SyntaxError) throw new Error(`${profile.label} 未返回有效的模型列表 JSON`);
    if (error instanceof Error) throw error;
    throw new Error(`${profile.label} 模型列表查询失败`);
  } finally {
    signal?.removeEventListener("abort", abort);
    globalThis.clearTimeout(timer);
  }
}

function summarizeRulePatternForPrompt(pattern: string) {
  const text = pattern
    .replace(/参考[:：].*$/i, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b[\w.-]+\.[a-z]{2,}(?:\/\S*)?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 160) || "参考该文件夹的主题和内容类型";
}

function buildHabitInstruction(profile: FolderHabitProfile) {
  const preferred = (profile.preferredTopLevelFolders ?? []).slice(0, 12);
  const folderRules = (profile.folderRules ?? []).slice(0, 12).map((rule, index) => {
    const path = rule.folderPath.join(" / ");
    const pattern = summarizeRulePatternForPrompt(rule.pattern);
    return `${index + 1}. ${path}：${pattern}`;
  });
  const avoidRules = (profile.avoidRules ?? []).slice(0, 8).map((rule, index) => `${index + 1}. ${rule}`);
  const learning = profile.learning;
  const learnedCorrections = (learning?.categoryCorrections ?? []).slice(0, 10).map(
    (item) => `${item.fromFolderPath.join(" / ")} → ${item.toFolderPath.join(" / ")}（用户调整 ${item.count} 次）`
  );
  const learnedDomains = (learning?.domainPreferences ?? []).slice(0, 12).map(
    (item) => `${item.domain} → ${item.folderPath.join(" / ")}（用户确认 ${item.count} 次）`
  );
  const rejectedPaths = (learning?.rejectedFolderPaths ?? []).slice(0, 8).map(
    (item) => item.isNewFolder
      ? `不要新建 ${item.folderPath.join(" / ")}（用户拒绝 ${item.count} 次）`
      : `${item.domain ?? "类似来源"} 不要归入 ${item.folderPath.join(" / ")}（用户拒绝 ${item.count} 次）`
  );
  const parts = ["\n用户已有分类习惯："];

  if (profile.promptHint) parts.push(profile.promptHint);
  if (preferred.length) parts.push(`优先复用这些一级分类：${preferred.join("、")}。`);
  if (folderRules.length) {
    parts.push(`可复用文件夹规则：${folderRules.join("；")}。分类时优先匹配这些路径体现的主题和粒度。`);
  }
  if (avoidRules.length) parts.push(`避免规则：${avoidRules.join("；")}。`);
  if (learnedCorrections.length) parts.push(`用户对 AI 分类的实际修正：${learnedCorrections.join("；")}。遇到相似分类时优先采用修正后的路径。`);
  if (learnedDomains.length) parts.push(`用户实际修改形成的域名偏好：${learnedDomains.join("；")}。这些反馈优先级高于通用推断。`);
  if (rejectedPaths.length) parts.push(`用户曾拒绝这些分类方式：${rejectedPaths.join("；")}。除非有很强的新证据，否则遵守这些反馈。`);
  if (learning) {
    const depthVotes = learning.depthVotes.levelOne + learning.depthVotes.nested;
    if (depthVotes >= 2) {
      parts.push(learning.depthVotes.nested > learning.depthVotes.levelOne ? "用户更偏好二级目录结构。" : "用户更偏好一级目录结构。");
    }
    const styleVotes = learning.styleVotes.topic + learning.styleVotes.purpose;
    if (styleVotes >= 2) {
      parts.push(learning.styleVotes.purpose > learning.styleVotes.topic ? "用户更偏好按用途分类。" : "用户更偏好按主题分类。");
    }
  }
  parts.push("如果书签明显匹配已有文件夹规则，优先返回该规则路径；内容明确但现有目录不覆盖时，应提出可复用的新分类；只有内容或用途本身难以判断时才暂缓分类。");

  return parts.join(" ");
}

export async function classifyWithAI(
  config: AIProviderConfig,
  bookmarks: BookmarkForAI[],
  options?: ClassificationOptions
) {
  if (!bookmarks.length || !config.apiKey) return [];

  const maxTopLevelFolders = options?.maxTopLevelFolders ?? 8;
  const maxSubfoldersPerFolder = options?.allowNestedFolders === false ? 0 : options?.maxSubfoldersPerFolder ?? 4;
  const compactInstruction = `整体分类必须尽量克制，优先复用少量通用文件夹。一级分类总数尽量不超过 ${maxTopLevelFolders} 个；每个一级分类下尽量不超过 ${maxSubfoldersPerFolder} 个二级分类。先判断书签的内容或用途是否明确，再判断现有目录是否合适。内容明确且已有目录合适时 decision="existing_folder"；内容明确但现有目录体系未覆盖时 decision="new_folder"，提出命名通用、可继续容纳同类书签的路径；只有内容或用途本身难以判断、分类证据不足时才 decision="defer"。不要仅因当前只有一条书签就禁止新建目录，也不要用具体网站名或单篇文章名建立目录。`;
  const metadataInstruction = "如果输入包含 metadata，请优先结合 metadata.title、metadata.description、metadata.ogTitle、metadata.ogDescription、metadata.ogSiteName 判断网站类型。metadata.available 为 false 或 metadata 缺失时，继续根据书签标题、域名、路径和 URL 分类；不要仅因为 metadata 不可用就归入待整理。";
  const impressionInstruction = "reason 请用一句话描述该网站的核心功能及归类依据（15~35字，例如：提供免费在线影视搜索与在线观看的视频网站，适合归入影视娱乐）。同时输出 keywords：3~5 个功能印象词，站在“用户忘记网站名字时会在搜索框输入什么功能词或品类词来找它”的角度生成，例如 Cupfox 输出 [\"视频网站\",\"在线看剧\",\"影视搜索\",\"电影网站\"]，Squoosh 输出 [\"图片压缩\",\"图像优化\",\"在线修图\",\"WebP转换\"]；不要只重复书签标题里已有的词。";

  const existingCategoriesInstruction = options?.existingCategories?.length
    ? `\n前面批次已形成这些一级分类：${options.existingCategories.join("、")}。后续批次应优先复用；若出现内容明确且这些分类确实未覆盖的新主题，仍可 decision="new_folder" 新增一个可复用分类，不得因批次顺序而暂缓。`
    : "";

  const existingFolderPathsInstruction = options?.existingFolderPaths?.length
    ? `\n以下是调用时最新的完整现有文件夹路径清单：${JSON.stringify(options.existingFolderPaths)}。先逐项检查语义相符的路径，避免创建同义或近义目录。若复用其中路径，返回 decision="existing_folder"；若目标完整路径不在清单中，返回 decision="new_folder"。`
    : "\n当前没有可供复用的用户文件夹路径；内容明确时可提出可复用的新目录。";

  const habitInstruction = options?.habitProfile
    ? buildHabitInstruction(options.habitProfile)
    : "";

  await options?.onStage?.("requesting_ai");

  const completion = await chatCompletion(
    config,
    [
      {
        role: "system",
        content: `${options?.customPrompt ?? `你是浏览器书签分类助手。必须输出合法 JSON，不要 Markdown，不要解释。`}${compactInstruction}${metadataInstruction}${impressionInstruction}${existingCategoriesInstruction}${existingFolderPathsInstruction}${habitInstruction} 输出必须是 JSON 对象，格式为 {\"results\":[{\"id\":\"输入 id\",\"decision\":\"existing_folder|new_folder|defer\",\"categoryPath\":[\"一级分类\",\"二级分类\"],\"confidence\":0.8,\"reason\":\"按上述要求描述功能与归类依据\",\"keywords\":[\"功能印象词\"]}]}。results 中每一项必须对应输入中的一个 id。decision=\"defer\" 时 categoryPath 必须为空数组；其他 decision 必须提供路径。confidence 必须是 0 到 1 的数字，仅表示你对书签内容和用途判断的相对自评，不得把它表述为经过验证的正确率。keywords 无法确定时返回空数组，不要编造。`,
      },
      {
        role: "user",
        content: `请分类这些书签，并为每个输入 id 返回一项结果。只返回 JSON：\n${JSON.stringify(bookmarks)}`,
      },
    ],
    4000,
    true,
    CLASSIFICATION_REQUEST_TIMEOUT_MS,
    options?.signal
  );

  if (completion.tokenUsage) options?.onTokenUsage?.(completion.tokenUsage);

  await options?.onStage?.("parsing_results");

  const results = parseResults(completion.content);
  debugAI("parsed results", {
    inputCount: bookmarks.length,
    outputCount: results.length,
    ids: results.map((result) => result.id),
  });

  if (!results.length) {
    throw new Error(`AI 返回内容无法解析为有效分类：${completion.content.slice(0, 180)}`);
  }
  return results;
}

export async function analyzeFolderHabitsWithAI(
  config: AIProviderConfig,
  samples: FolderHabitSample[],
  fallback: Omit<FolderHabitProfile, "id" | "createdAt">
) {
  if (!config.apiKey) return fallback;

  const completion = await chatCompletion(
    config,
    [
      {
        role: "system",
        content:
          "你是书签分类习惯分析助手。必须输出合法 JSON 对象，不要 Markdown，不要解释。请根据用户现有文件夹路径和样例，总结用户的分类命名、粒度和偏好。优先总结书签较多的目录，folderRules 最多 12 条，folderPath 保留 1~3 层，pattern 每条不超过 80 字；summary 不超过 100 字，preferredTopLevelFolders 最多 12 个，avoidRules 最多 5 条且每条不超过 40 字，promptHint 不超过 150 字。所有字段均须提供，avoidRules 可以为空数组。folderRules[].pattern 必须先说明该文件夹主要放置什么主题、什么类型的网页，例如“主要放置与前端框架相关的官方文档、API 参考和工程实践资料”。不要只罗列网站示例，不要单独输出“常见来源”或“主要来源”，不要为每条规则重复追加通用约束。参考为可选内容，仅在字数允许时附 1 个样例标题，无需复述链接。promptHint 应提醒后续分类模型参考这些文件夹规则体现的主题、命名和粒度。输出格式为 {\"summary\":\"一句话总结\",\"preferredTopLevelFolders\":[\"一级分类\"],\"folderRules\":[{\"folderPath\":[\"一级\",\"二级\"],\"pattern\":\"主要放置什么主题和类型的网页\"}],\"avoidRules\":[\"应避免的过度分类行为\"],\"promptHint\":\"给后续书签分类模型使用的一段简短指令\"}。",
      },
      {
        role: "user",
        content: `请分析这些现有书签文件夹样本，只返回 JSON：\n${JSON.stringify(samples)}`,
      },
    ],
    2600,
    true,
    HABIT_ANALYSIS_TIMEOUT_MS
  );

  if (completion.finishReason === "length") {
    throw new Error("AI 画像输出达到长度限制而未完成，请适当提高输出上限后重试");
  }
  if (completion.finishReason === "content_filter" || completion.refusal) {
    throw new Error("AI 服务未提供画像内容，请检查服务限制后重试");
  }
  return parseHabitProfile(completion.content, fallback);
}
