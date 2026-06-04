import type {
  AIProviderConfig,
  AIProviderType,
  BookmarkForAI,
  ClassificationResult,
  FolderHabitProfile,
  FolderHabitSample,
  TokenUsage,
} from "../types";

type ClassificationOptions = {
  maxTopLevelFolders: number;
  maxSubfoldersPerFolder: number;
  allowNestedFolders: boolean;
  habitProfile?: FolderHabitProfile | null;
  customPrompt?: string;
  existingCategories?: string[];
  onTokenUsage?: (usage: TokenUsage) => void;
};

export type CategoryScheme = {
  topLevelCategories: string[];
  subCategories: Record<string, string[]>;
};

type TokenParam = "max_tokens" | "max_completion_tokens";

export type AIProviderProfile = {
  type: AIProviderType;
  label: string;
  model: string;
  endpoint: string;
  tokenParam: TokenParam;
  supportsJsonMode: boolean;
};

export const AI_PROVIDER_PROFILES: Record<AIProviderType, AIProviderProfile> = {
  openai: {
    type: "openai",
    label: "OpenAI",
    model: "gpt-5.4-mini",
    endpoint: "https://api.openai.com/v1",
    tokenParam: "max_completion_tokens",
    supportsJsonMode: true,
  },
  deepseek: {
    type: "deepseek",
    label: "DeepSeek",
    model: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com",
    tokenParam: "max_tokens",
    supportsJsonMode: true,
  },
  zhipu: {
    type: "zhipu",
    label: "智谱 GLM",
    model: "glm-5.1",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    tokenParam: "max_tokens",
    supportsJsonMode: true,
  },
  kimi: {
    type: "kimi",
    label: "Kimi",
    model: "kimi-k2.6",
    endpoint: "https://api.moonshot.ai/v1",
    tokenParam: "max_tokens",
    supportsJsonMode: false,
  },
  gemini: {
    type: "gemini",
    label: "Gemini",
    model: "gemini-3-flash-preview",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    tokenParam: "max_tokens",
    supportsJsonMode: false,
  },
  minimax: {
    type: "minimax",
    label: "MiniMax",
    model: "MiniMax-M2.7",
    endpoint: "https://api.minimax.io/v1",
    tokenParam: "max_completion_tokens",
    supportsJsonMode: false,
  },
  qwen: {
    type: "qwen",
    label: "通义千问",
    model: "qwen-plus",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    tokenParam: "max_tokens",
    supportsJsonMode: true,
  },
  doubao: {
    type: "doubao",
    label: "火山方舟 / 豆包",
    model: "doubao-seed-1-6-251015",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    tokenParam: "max_tokens",
    supportsJsonMode: false,
  },
  custom: {
    type: "custom",
    label: "自定义",
    model: "gpt-5.4-mini",
    endpoint: "https://api.openai.com/v1",
    tokenParam: "max_completion_tokens",
    supportsJsonMode: true,
  },
};

export const AI_PROVIDER_OPTIONS = Object.values(AI_PROVIDER_PROFILES);

function profileFor(type: AIProviderType) {
  return AI_PROVIDER_PROFILES[type] ?? AI_PROVIDER_PROFILES.custom;
}

function endpointFor(config: AIProviderConfig) {
  const endpoint = config.endpoint?.replace(/\/$/, "");
  const profile = profileFor(config.type);
  if (config.type === "deepseek" && endpoint?.endsWith("/v1")) {
    return endpoint.slice(0, -3);
  }
  if (endpoint) return endpoint;
  return profile.endpoint;
}

function extractJson(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return trimmed.slice(arrayStart, arrayEnd + 1);
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1);
  }

  return trimmed;
}

function debugAI(label: string, payload: unknown) {
  console.debug(`[ReMarks AI] ${label}`, payload);
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

function asObjectArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
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

    if (!id || categoryPath.length === 0 || confidence <= 0 || confidence > 1) continue;

    results.push({
      id,
      category: categoryPath.join(" / "),
      categoryPath,
      confidence,
      reason: extractLooseReason(block) || "AI 分类建议",
      source: "ai",
    });
  }

  return results;
}

function parseHabitProfile(content: string, fallback: Omit<FolderHabitProfile, "id" | "createdAt">): Omit<FolderHabitProfile, "id" | "createdAt"> {
  const parsed = JSON.parse(extractJson(content)) as Record<string, unknown>;
  const preferredTopLevelFolders = asStringArray(parsed.preferredTopLevelFolders).slice(0, 16);
  const folderRules = asObjectArray(parsed.folderRules)
    .map((item) => {
      const value = item as Record<string, unknown>;
      return {
        folderPath: asStringArray(value.folderPath).slice(0, 3),
        pattern: typeof value.pattern === "string" ? value.pattern.trim() : "",
      };
    })
    .filter((rule) => rule.folderPath.length > 0 && rule.pattern)
    .slice(0, 30);
  const avoidRules = asStringArray(parsed.avoidRules).slice(0, 10);

  return {
    folderCount: fallback.folderCount,
    bookmarkCount: fallback.bookmarkCount,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : fallback.summary,
    preferredTopLevelFolders: preferredTopLevelFolders.length
      ? preferredTopLevelFolders
      : fallback.preferredTopLevelFolders,
    folderRules: folderRules.length ? folderRules : fallback.folderRules,
    avoidRules: avoidRules.length ? avoidRules : fallback.avoidRules,
    promptHint: typeof parsed.promptHint === "string" && parsed.promptHint.trim()
      ? parsed.promptHint.trim()
      : fallback.promptHint,
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
    if (!id || categoryPath.length === 0 || confidence <= 0 || confidence > 1) return [];

    return [
      {
        id,
        category: categoryPath.join(" / "),
        categoryPath,
        confidence,
        reason: typeof value.reason === "string" ? value.reason : "AI 分类建议",
        source: "ai" as const,
      },
    ];
  });
}

async function chatCompletion(
  config: AIProviderConfig,
  messages: Array<{ role: string; content: string }>,
  maxTokens = 800,
  jsonMode = false
) {
  if (!config.apiKey) throw new Error("缺少 API Key");

  const profile = profileFor(config.type);
  const endpoint = endpointFor(config);
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.1,
    stream: false,
  };
  body[profile.tokenParam] = maxTokens;

  if (jsonMode && profile.supportsJsonMode) {
    body.response_format = { type: "json_object" };
  }

  debugAI("request", {
    endpoint,
    model: config.model,
    jsonMode: jsonMode && profile.supportsJsonMode,
    maxTokens,
    provider: config.type,
    tokenParam: profile.tokenParam,
    messageCount: messages.length,
  });

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI 请求失败：${response.status}${detail ? ` ${detail.slice(0, 160)}` : ""}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  debugAI("raw response content", content);
  return {
    content,
    tokenUsage: normalizeTokenUsage(data.usage),
  };
}

export async function testAIConnection(config: AIProviderConfig) {
  const completion = await chatCompletion(
    config,
    [{ role: "user", content: "Return only the word ok." }],
    8
  );
  return completion.content.trim().length > 0;
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
  const parts = ["\n用户已有分类习惯："];

  if (profile.promptHint) parts.push(profile.promptHint);
  if (preferred.length) parts.push(`优先复用这些一级分类：${preferred.join("、")}。`);
  if (folderRules.length) {
    parts.push(`可复用文件夹规则：${folderRules.join("；")}。分类时优先匹配这些路径体现的主题和粒度。`);
  }
  if (avoidRules.length) parts.push(`避免规则：${avoidRules.join("；")}。`);
  parts.push("如果书签明显匹配已有文件夹规则，优先返回该规则路径；无法匹配时再创建克制的新分类或归入待整理。");

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
  const compactInstruction = `整体分类必须尽量克制，优先复用少量通用文件夹。一级分类总数最多 ${maxTopLevelFolders} 个；每个一级分类下最多 ${maxSubfoldersPerFolder} 个二级分类。不要为单个网站、单篇文章或小众主题创建独立文件夹。无法确定时归入较宽泛的父级分类或"待整理"。`;
  const metadataInstruction = "如果输入包含 metadata，请优先结合 metadata.title、metadata.description、metadata.ogTitle、metadata.ogDescription、metadata.ogSiteName 判断网站类型。metadata.available 为 false 或 metadata 缺失时，继续根据书签标题、域名、路径和 URL 分类；不要仅因为 metadata 不可用就归入待整理。";

  const existingCategoriesInstruction = options?.existingCategories?.length
    ? `\n你必须严格使用以下已有的一级分类名称，不得创建新的一级分类：${options.existingCategories.join("、")}。只有确实无法归入时才使用"待整理"。`
    : "";

  const habitInstruction = options?.habitProfile
    ? buildHabitInstruction(options.habitProfile)
    : "";

  const completion = await chatCompletion(
    config,
    [
      {
        role: "system",
        content: `${options?.customPrompt ?? `你是浏览器书签分类助手。必须输出合法 JSON，不要 Markdown，不要解释。`}${compactInstruction}${metadataInstruction}${existingCategoriesInstruction}${habitInstruction} 输出必须是 JSON 对象，格式为 {\"results\":[{\"id\":\"输入 id\",\"categoryPath\":[\"一级分类\",\"二级分类\"],\"confidence\":0.8,\"reason\":\"简短中文原因\"}]}。results 中每一项必须对应输入中的一个 id。confidence 必须是 0 到 1 的数字。`,
      },
      {
        role: "user",
        content: `请分类这些书签，并为每个输入 id 返回一项结果。只返回 JSON：\n${JSON.stringify(bookmarks)}`,
      },
    ],
    4000,
    true
  );

  if (completion.tokenUsage) options?.onTokenUsage?.(completion.tokenUsage);

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
          "你是书签分类习惯分析助手。必须输出合法 JSON 对象，不要 Markdown，不要解释。请根据用户现有文件夹路径和样例，总结用户的分类命名、粒度和偏好。folderRules[].pattern 必须先说明该文件夹主要放置什么主题、什么类型的网页，例如“主要放置与前端框架相关的官方文档、API 参考和工程实践资料”。然后可补充少量参考。不要只罗列网站示例，不要单独输出“常见来源”或“主要来源”，不要为每条规则重复追加“后续归入这里的内容应与该主题、来源类型或标题特征明显一致”这类通用约束。需要提供参考时，使用“参考：标题（链接）、标题（链接）”格式，链接使用样例中的 url 或 domain，最多 3 个。promptHint 应提醒后续分类模型参考这些文件夹规则体现的主题、命名和粒度。输出格式为 {\"summary\":\"一句话总结\",\"preferredTopLevelFolders\":[\"一级分类\"],\"folderRules\":[{\"folderPath\":[\"一级\",\"二级\"],\"pattern\":\"主要放置什么主题和类型的网页，可附少量参考\"}],\"avoidRules\":[\"应避免的过度分类行为\"],\"promptHint\":\"给后续书签分类模型使用的一段简短指令\"}。",
      },
      {
        role: "user",
        content: `请分析这些现有书签文件夹样本，只返回 JSON：\n${JSON.stringify(samples)}`,
      },
    ],
    2600,
    true
  );

  return parseHabitProfile(completion.content, fallback);
}
