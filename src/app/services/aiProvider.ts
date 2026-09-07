import type {
  AIProviderConfig,
  AIProviderType,
  BookmarkForAI,
  ClassificationResult,
  FolderHabitProfile,
  FolderHabitSample,
  PreviewTaskPhase,
  TokenUsage,
} from "../types";

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
    const decisionMatch = block.match(/"(?:decision|action|classificationDecision)"\s*:\s*"([^"\\]+)"/);
    const decision = normalizeClassificationDecision(decisionMatch?.[1], categoryPath);

    if (!id || (decision !== "defer" && categoryPath.length === 0) || confidence <= 0 || confidence > 1) continue;

    results.push({
      id,
      category: categoryPath.join(" / "),
      categoryPath,
      confidence,
      reason: extractLooseReason(block) || "AI 分类建议",
      decision,
      source: "ai",
    });
  }

  return results;
}

function parseHabitProfile(content: string, fallback: Omit<FolderHabitProfile, "id" | "createdAt">): Omit<FolderHabitProfile, "id" | "createdAt"> {
  const candidates = extractJsonCandidates(content);
  const errors: string[] = [];
  let parsed: Record<string, unknown> | undefined;
  let jsonText = candidates[0] ?? content.trim();

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push("JSON is not an object");
        continue;
      }
      const record = value as Record<string, unknown>;
      const hasHabitField = ["summary", "preferredTopLevelFolders", "folderRules", "avoidRules", "promptHint"].some(
        (key) => key in record
      );
      if (!hasHabitField) {
        errors.push("JSON object does not contain habit profile fields");
        continue;
      }
      parsed = record;
      jsonText = candidate;
      break;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!parsed) {
    debugAI("habit profile JSON parse failed", {
      error: errors[0] ?? "No valid habit profile JSON found",
      errors,
      extractedJson: jsonText,
      rawContent: content,
    });
    throw new Error(errors[0] ?? "No valid habit profile JSON found");
  }

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
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    debugAI("raw response content", content);
    return {
      content,
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

export async function listAIModels(config: AIProviderConfig): Promise<AIModelOption[]> {
  if (!config.apiKey) throw new Error("请先配置 API Key 后再查询模型");

  const profile = profileFor(config.type);
  const endpoint = endpointFor(config);
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

  try {
    const response = await fetch(`${endpoint}/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
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

    const models = records.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as { id?: unknown; name?: unknown; owned_by?: unknown; ownedBy?: unknown };
      const idValue = typeof value.id === "string" ? value.id : value.name;
      if (typeof idValue !== "string" || !idValue.trim()) return [];
      const ownedByValue = value.owned_by ?? value.ownedBy;
      return [{
        id: idValue.trim(),
        ownedBy: typeof ownedByValue === "string" ? ownedByValue : undefined,
      }];
    });

    return Array.from(new Map(models.map((model) => [model.id, model])).values())
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`${profile.label} 模型列表查询超时，请稍后重试`);
    }
    if (error instanceof Error) throw error;
    throw new Error(`${profile.label} 模型列表查询失败`);
  } finally {
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
        content: `${options?.customPrompt ?? `你是浏览器书签分类助手。必须输出合法 JSON，不要 Markdown，不要解释。`}${compactInstruction}${metadataInstruction}${existingCategoriesInstruction}${existingFolderPathsInstruction}${habitInstruction} 输出必须是 JSON 对象，格式为 {\"results\":[{\"id\":\"输入 id\",\"decision\":\"existing_folder|new_folder|defer\",\"categoryPath\":[\"一级分类\",\"二级分类\"],\"confidence\":0.8,\"reason\":\"说明内容依据，以及为何复用、为何新建或为何暂缓\"}]}。results 中每一项必须对应输入中的一个 id。decision=\"defer\" 时 categoryPath 必须为空数组；其他 decision 必须提供路径。confidence 必须是 0 到 1 的数字，仅表示你对书签内容和用途判断的相对自评，不得把它表述为经过验证的正确率。`,
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
          "你是书签分类习惯分析助手。必须输出合法 JSON 对象，不要 Markdown，不要解释。请根据用户现有文件夹路径和样例，总结用户的分类命名、粒度和偏好。folderRules[].pattern 必须先说明该文件夹主要放置什么主题、什么类型的网页，例如“主要放置与前端框架相关的官方文档、API 参考和工程实践资料”。然后可补充少量参考。不要只罗列网站示例，不要单独输出“常见来源”或“主要来源”，不要为每条规则重复追加“后续归入这里的内容应与该主题、来源类型或标题特征明显一致”这类通用约束。需要提供参考时，使用“参考：标题（链接）、标题（链接）”格式，链接使用样例中的 url 或 domain，最多 3 个。promptHint 应提醒后续分类模型参考这些文件夹规则体现的主题、命名和粒度。输出格式为 {\"summary\":\"一句话总结\",\"preferredTopLevelFolders\":[\"一级分类\"],\"folderRules\":[{\"folderPath\":[\"一级\",\"二级\"],\"pattern\":\"主要放置什么主题和类型的网页，可附少量参考\"}],\"avoidRules\":[\"应避免的过度分类行为\"],\"promptHint\":\"给后续书签分类模型使用的一段简短指令\"}。",
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

  return parseHabitProfile(completion.content, fallback);
}
