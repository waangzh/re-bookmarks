import type { AIProviderConfig, BookmarkForAI, ClassificationResult } from "../types";

function endpointFor(config: AIProviderConfig) {
  const endpoint = config.endpoint?.replace(/\/$/, "");
  if (config.type === "deepseek" && endpoint?.endsWith("/v1")) {
    return endpoint.slice(0, -3);
  }
  if (endpoint) return endpoint;
  if (config.type === "deepseek") return "https://api.deepseek.com";
  return "https://api.openai.com/v1";
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

export function parseResults(content: string): ClassificationResult[] {
  const jsonText = extractJson(content);
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (error) {
    debugAI("JSON parse failed", {
      error: error instanceof Error ? error.message : String(error),
      extractedJson: jsonText,
      rawContent: content,
    });
    throw error;
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

  const endpoint = endpointFor(config);
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.1,
    max_tokens: maxTokens,
    stream: false,
  };

  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  debugAI("request", {
    endpoint,
    model: config.model,
    jsonMode,
    maxTokens,
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
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  debugAI("raw response content", content);
  return content;
}

export async function testAIConnection(config: AIProviderConfig) {
  const content = await chatCompletion(
    config,
    [{ role: "user", content: "Return only the word ok." }],
    8
  );
  return content.trim().length > 0;
}

export async function classifyWithAI(config: AIProviderConfig, bookmarks: BookmarkForAI[]) {
  if (!bookmarks.length || !config.apiKey) return [];

  const content = await chatCompletion(
    config,
    [
      {
        role: "system",
        content:
          "你是浏览器书签分类助手。必须输出合法 JSON，不要 Markdown，不要解释。输出必须是 JSON 对象，格式为 {\"results\":[{\"id\":\"输入 id\",\"categoryPath\":[\"一级分类\",\"二级分类\"],\"confidence\":0.8,\"reason\":\"简短中文原因\"}]}。results 中每一项必须对应输入中的一个 id。confidence 必须是 0 到 1 的数字。",
      },
      {
        role: "user",
        content: `请分类这些书签，并为每个输入 id 返回一项结果。只返回 JSON：\n${JSON.stringify(bookmarks)}`,
      },
    ],
    4000,
    true
  );

  const results = parseResults(content);
  debugAI("parsed results", {
    inputCount: bookmarks.length,
    outputCount: results.length,
    ids: results.map((result) => result.id),
  });

  if (!results.length) {
    throw new Error(`AI 返回内容无法解析为有效分类：${content.slice(0, 180)}`);
  }
  return results;
}
