import type { FolderHabitExportV1, FolderHabitProfile, FolderHabitSample } from "../types";
import { analyzeFolderHabitsWithAI } from "./aiProvider";
import { getAllBookmarkFolders, getAllBookmarks } from "./bookmarks";
import { getDomain, sanitizeUrl } from "./rules";
import {
  clearPreviewPlan,
  getFolderHabitProfile,
  getSettings,
  saveFolderHabitProfile,
} from "./storage";

const ROOT_FOLDER_NAMES = new Set(["收藏夹栏", "书签栏", "其他收藏夹", "移动设备书签", "Bookmarks Bar", "Other Bookmarks", "Mobile Bookmarks"]);

const FOLDER_HABIT_EXPORT_VERSION = 1;
const PURPOSE_CATEGORY_PATTERN = /工具|稍后|待读|阅读|学习|工作|参考|灵感|收藏|课程|视频|购物|开发|research|read|later|work|learn|tool|reference|inspiration/i;

type HabitFeedback =
  | {
      type: "category_override";
      bookmarkTitle?: string;
      bookmarkUrl?: string;
      suggestedFolderPath: string[];
      chosenFolderPath: string[];
    }
  | {
      type: "folder_rejected";
      bookmarkTitle?: string;
      bookmarkUrl?: string;
      suggestedFolderPath: string[];
    };

function folderKey(path: string[]) {
  return path.join(" / ");
}

function emptyLearning(): NonNullable<FolderHabitProfile["learning"]> {
  return {
    correctionCount: 0,
    rejectionCount: 0,
    depthVotes: { levelOne: 0, nested: 0 },
    styleVotes: { topic: 0, purpose: 0 },
    categoryCorrections: [],
    domainPreferences: [],
    rejectedFolderPaths: [],
    recentEvents: [],
  };
}

function cleanPath(path: string[]) {
  return path.map((item) => item.trim()).filter(Boolean).slice(0, 3);
}

function samePath(left: string[], right: string[]) {
  return folderKey(cleanPath(left)) === folderKey(cleanPath(right));
}

function upsertPathSignal<T extends { folderPath: string[]; count: number; updatedAt: number }>(
  items: T[],
  folderPath: string[],
  now: number,
  extra: Omit<T, "folderPath" | "count" | "updatedAt">
) {
  const key = folderKey(folderPath);
  const existing = items.find((item) => folderKey(item.folderPath) === key);
  const next = items.filter((item) => folderKey(item.folderPath) !== key);
  next.unshift({
    ...extra,
    folderPath,
    count: (existing?.count ?? 0) + 1,
    updatedAt: now,
  } as T);
  return next.sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt);
}

function upsertRejectedSignal(
  items: NonNullable<FolderHabitProfile["learning"]>["rejectedFolderPaths"],
  folderPath: string[],
  domain: string | undefined,
  isNewFolder: boolean,
  now: number
) {
  const key = `${domain ?? "*"}|${folderKey(folderPath)}`;
  const existing = items.find((item) => `${item.domain ?? "*"}|${folderKey(item.folderPath)}` === key);
  return [{
    folderPath,
    domain,
    isNewFolder,
    count: (existing?.count ?? 0) + 1,
    updatedAt: now,
  }, ...items.filter((item) => `${item.domain ?? "*"}|${folderKey(item.folderPath)}` !== key)]
    .sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt)
    .slice(0, 16);
}

function upsertCategoryCorrection(
  items: NonNullable<FolderHabitProfile["learning"]>["categoryCorrections"],
  fromFolderPath: string[],
  toFolderPath: string[],
  now: number
) {
  const key = `${folderKey(fromFolderPath)}→${folderKey(toFolderPath)}`;
  const existing = items.find((item) =>
    `${folderKey(item.fromFolderPath)}→${folderKey(item.toFolderPath)}` === key
  );
  return [{
    fromFolderPath,
    toFolderPath,
    count: (existing?.count ?? 0) + 1,
    updatedAt: now,
  }, ...items.filter((item) =>
    `${folderKey(item.fromFolderPath)}→${folderKey(item.toFolderPath)}` !== key
  )]
    .sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt)
    .slice(0, 20);
}

function uniqueStrings(items: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of items) {
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

function stripRootFolderNames(path: string[]) {
  let next = path.map((item) => item.trim()).filter(Boolean);
  while (next.length > 0 && ROOT_FOLDER_NAMES.has(next[0])) {
    next = next.slice(1);
  }
  return next;
}

function summarizeAnalysisError(error: unknown) {
  if (!(error instanceof Error) || !error.message.trim()) return "AI 分析失败";
  return error.message.replace(/\s+/g, " ").slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function parseImportedLearning(value: unknown): FolderHabitProfile["learning"] {
  if (!isRecord(value)) return undefined;
  const depthVotes = isRecord(value.depthVotes) ? value.depthVotes : {};
  const styleVotes = isRecord(value.styleVotes) ? value.styleVotes : {};
  const categoryCorrections = Array.isArray(value.categoryCorrections)
    ? value.categoryCorrections.flatMap((item) => {
        if (!isRecord(item)) return [];
        return [{
          fromFolderPath: asStringArray(item.fromFolderPath),
          toFolderPath: asStringArray(item.toFolderPath),
          count: asCount(item.count),
          updatedAt: asCount(item.updatedAt),
        }];
      })
    : [];
  const domainPreferences = Array.isArray(value.domainPreferences)
    ? value.domainPreferences.flatMap((item) => {
        if (!isRecord(item) || typeof item.domain !== "string") return [];
        return [{
          domain: item.domain,
          folderPath: asStringArray(item.folderPath),
          count: asCount(item.count),
          updatedAt: asCount(item.updatedAt),
        }];
      })
    : [];
  const rejectedFolderPaths = Array.isArray(value.rejectedFolderPaths)
    ? value.rejectedFolderPaths.flatMap((item) => {
        if (!isRecord(item)) return [];
        return [{
          folderPath: asStringArray(item.folderPath),
          domain: typeof item.domain === "string" ? item.domain : undefined,
          isNewFolder: item.isNewFolder === true,
          count: asCount(item.count),
          updatedAt: asCount(item.updatedAt),
        }];
      })
    : [];

  return {
    correctionCount: asCount(value.correctionCount),
    rejectionCount: asCount(value.rejectionCount),
    lastLearnedAt: asCount(value.lastLearnedAt) || undefined,
    depthVotes: {
      levelOne: asCount(depthVotes.levelOne),
      nested: asCount(depthVotes.nested),
    },
    styleVotes: {
      topic: asCount(styleVotes.topic),
      purpose: asCount(styleVotes.purpose),
    },
    categoryCorrections,
    domainPreferences,
    rejectedFolderPaths,
    recentEvents: [],
  };
}

function parseImportProfile(value: unknown): Pick<FolderHabitProfile, "summary" | "preferredTopLevelFolders" | "folderRules" | "avoidRules" | "promptHint" | "learning"> {
  if (!isRecord(value)) throw new Error("导入文件缺少 profile 对象");

  const folderRules = Array.isArray(value.folderRules)
    ? value.folderRules.flatMap((rule) => {
        if (!isRecord(rule)) return [];
        return [{
          folderPath: asStringArray(rule.folderPath).slice(0, 3),
          pattern: typeof rule.pattern === "string" ? rule.pattern : "",
        }];
      })
    : [];

  return {
    summary: typeof value.summary === "string" ? value.summary : "",
    preferredTopLevelFolders: asStringArray(value.preferredTopLevelFolders),
    folderRules,
    avoidRules: asStringArray(value.avoidRules),
    promptHint: typeof value.promptHint === "string" ? value.promptHint : "",
    learning: parseImportedLearning(value.learning),
  };
}

function hasImportContent(profile: FolderHabitProfile) {
  return Boolean(
    profile.preferredTopLevelFolders.length ||
    profile.folderRules.length ||
    profile.avoidRules.length ||
    Boolean(profile.learning?.categoryCorrections.length) ||
    Boolean(profile.learning?.domainPreferences.length) ||
    Boolean(profile.learning?.rejectedFolderPaths.length)
  );
}

export function cleanFolderHabitProfile(profile: FolderHabitProfile): FolderHabitProfile {
  const folderRuleKeys = new Set<string>();
  const folderRules: FolderHabitProfile["folderRules"] = [];

  for (const rule of profile.folderRules ?? []) {
    const folderPath = stripRootFolderNames(rule.folderPath).slice(0, 3);
    const pattern = rule.pattern.trim();
    const key = folderKey(folderPath);
    if (!folderPath.length || !pattern || folderRuleKeys.has(key)) continue;
    folderRuleKeys.add(key);
    folderRules.push({ folderPath, pattern });
  }

  return {
    ...profile,
    summary: profile.summary?.trim() ?? "",
    preferredTopLevelFolders: uniqueStrings(profile.preferredTopLevelFolders ?? [])
      .filter((item) => !ROOT_FOLDER_NAMES.has(item))
      .slice(0, 16),
    folderRules,
    avoidRules: uniqueStrings(profile.avoidRules ?? []).slice(0, 10),
    promptHint: profile.promptHint?.trim() ?? "",
    analysisWarning: profile.analysisWarning?.trim() || undefined,
    learning: profile.learning
      ? {
          ...emptyLearning(),
          ...profile.learning,
          depthVotes: { ...emptyLearning().depthVotes, ...profile.learning.depthVotes },
          styleVotes: { ...emptyLearning().styleVotes, ...profile.learning.styleVotes },
          categoryCorrections: (profile.learning.categoryCorrections ?? [])
            .map((item) => ({
              ...item,
              fromFolderPath: cleanPath(item.fromFolderPath),
              toFolderPath: cleanPath(item.toFolderPath),
            }))
            .filter((item) => item.fromFolderPath.length && item.toFolderPath.length)
            .slice(0, 20),
          domainPreferences: (profile.learning.domainPreferences ?? [])
            .map((item) => ({ ...item, domain: item.domain.trim().toLowerCase(), folderPath: cleanPath(item.folderPath) }))
            .filter((item) => item.domain && item.folderPath.length)
            .slice(0, 24),
          rejectedFolderPaths: (profile.learning.rejectedFolderPaths ?? [])
            .map((item) => ({
              ...item,
              domain: item.domain?.trim().toLowerCase() || undefined,
              isNewFolder: item.isNewFolder === true,
              folderPath: cleanPath(item.folderPath),
            }))
            .filter((item) => item.folderPath.length)
            .slice(0, 16),
          recentEvents: (profile.learning.recentEvents ?? []).slice(0, 30),
        }
      : undefined,
  };
}

export function exportFolderHabitProfile(profile: FolderHabitProfile): string {
  const cleaned = cleanFolderHabitProfile(profile);
  const payload: FolderHabitExportV1 = {
    version: FOLDER_HABIT_EXPORT_VERSION,
    exportedAt: Date.now(),
    profile: {
      summary: cleaned.summary,
      preferredTopLevelFolders: cleaned.preferredTopLevelFolders,
      folderRules: cleaned.folderRules,
      avoidRules: cleaned.avoidRules,
      promptHint: cleaned.promptHint,
      learning: cleaned.learning,
    },
  };
  return JSON.stringify(payload, null, 2);
}

export async function importFolderHabitProfileJson(text: string): Promise<FolderHabitProfile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("导入文件不是有效的 JSON");
  }

  if (!isRecord(parsed)) throw new Error("导入文件格式不正确");
  if (parsed.version !== FOLDER_HABIT_EXPORT_VERSION) throw new Error("导入文件版本不受支持");

  const samples = await collectFolderHabitSamples();
  const bookmarkCount = samples.reduce((total, sample) => total + sample.bookmarkCount, 0);
  const next = cleanFolderHabitProfile({
    id: `habit-${Date.now()}`,
    createdAt: Date.now(),
    folderCount: samples.length,
    bookmarkCount,
    ...parseImportProfile(parsed.profile),
  });

  if (!hasImportContent(next)) throw new Error("导入文件没有可用的分类规则");

  await saveFolderHabitProfile(next);
  await clearPreviewPlan();
  return next;
}

function inferSourceType(sample: FolderHabitSample) {
  const text = `${sample.folderPath.join(" ")} ${sample.examples
    .map((example) => `${example.title} ${example.domain}`)
    .join(" ")}`.toLowerCase();

  if (/github|gitlab|repo|repository|代码|源码|开源/.test(text)) return "代码仓库、开源项目或工程资料";
  if (/docs|doc|developer|api|reference|guide|指南|文档|手册|教程/.test(text)) return "文档、教程、指南或 API 参考";
  if (/youtube|bilibili|video|课程|视频|公开课/.test(text)) return "视频、课程或演示内容";
  if (/zhihu|juejin|csdn|cnblogs|medium|blog|博客|文章|经验|讨论/.test(text)) return "文章、经验分享或讨论内容";
  return "网页资料";
}

function buildFallbackPattern(sample: FolderHabitSample) {
  const topic = sample.folderPath.at(-1) || sample.folderPath.join(" / ") || "该文件夹主题";
  const parentTopic = sample.folderPath.length > 1 ? sample.folderPath.slice(0, -1).join(" / ") : "";
  const references = sample.examples
    .filter((example) => example.title.trim())
    .slice(0, 3)
    .map((example) => {
      const link = example.url || example.domain;
      return link ? `${example.title}（${link}）` : example.title;
    });
  const sourceType = inferSourceType(sample);
  const scopeText = parentTopic ? `，通常属于“${parentTopic}”主题下的资料` : "";
  const referenceText = references.length ? `参考：${references.join("、")}。` : "";

  return `主要放置与“${topic}”相关的${sourceType}${scopeText}。已有 ${sample.bookmarkCount} 个相关书签。${referenceText}`;
}

function buildFallbackProfile(samples: FolderHabitSample[]): Omit<FolderHabitProfile, "id" | "createdAt"> {
  const topLevelCounts = new Map<string, number>();
  let bookmarkCount = 0;

  for (const sample of samples) {
    bookmarkCount += sample.bookmarkCount;
    const topLevel = sample.folderPath[0];
    if (topLevel) {
      topLevelCounts.set(topLevel, (topLevelCounts.get(topLevel) ?? 0) + sample.bookmarkCount);
    }
  }

  const preferredTopLevelFolders = [...topLevelCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .map(([folder]) => folder)
    .slice(0, 12);

  const folderRules = samples.slice(0, 30).map((sample) => ({
    folderPath: sample.folderPath,
    pattern: buildFallbackPattern(sample),
  }));

  return {
    folderCount: samples.length,
    bookmarkCount,
    summary: preferredTopLevelFolders.length
      ? `用户倾向使用 ${preferredTopLevelFolders.join("、")} 等现有一级分类，并按已有文件夹粒度归档。`
      : "用户现有分类样本较少，后续整理应保持克制。",
    preferredTopLevelFolders,
    folderRules,
    avoidRules: ["避免为单个网站或少量相似页面创建独立文件夹", "优先复用已有文件夹命名"],
    promptHint: preferredTopLevelFolders.length
      ? `优先复用用户已有一级分类：${preferredTopLevelFolders.join("、")}；分类粒度应贴近现有文件夹，并参考文件夹规则中的适用内容特征，不要过度细分。`
      : "分类应保持少量、通用、可维护。",
  };
}

export async function collectFolderHabitSamples(): Promise<FolderHabitSample[]> {
  const bookmarks = await getAllBookmarks();
  const folders = new Map<string, FolderHabitSample>();

  for (const bookmark of bookmarks) {
    if (!bookmark.url || bookmark.path.length === 0) continue;
    const folderPath = stripRootFolderNames(bookmark.path);
    if (folderPath.length === 0) continue;
    const key = folderKey(folderPath);
    const existing = folders.get(key) ?? {
      folderPath,
      bookmarkCount: 0,
      examples: [],
    };

    existing.bookmarkCount += 1;
    if (existing.examples.length < 6) {
      existing.examples.push({
        title: bookmark.title,
        domain: getDomain(bookmark.url),
        url: sanitizeUrl(bookmark.url),
      });
    }
    folders.set(key, existing);
  }

  return [...folders.values()]
    .sort((a, b) => b.bookmarkCount - a.bookmarkCount || folderKey(a.folderPath).localeCompare(folderKey(b.folderPath), "zh-CN"))
    .slice(0, 80);
}

export async function analyzeAndSaveFolderHabits(): Promise<FolderHabitProfile> {
  const [settings, samples, storedProfile] = await Promise.all([
    getSettings(),
    collectFolderHabitSamples(),
    getFolderHabitProfile(),
  ]);
  const fallback = buildFallbackProfile(samples);
  let analyzed = fallback;
  let analysisSource: FolderHabitProfile["analysisSource"] = "fallback";
  let analysisWarning: string | undefined;

  if (!samples.length) {
    analysisWarning = "未找到可分析的书签样本，已使用本地规则推断";
  } else if (!settings.provider.apiKey) {
    analysisWarning = "未配置 API Key，已使用本地规则推断";
  } else {
    try {
      analyzed = await analyzeFolderHabitsWithAI(settings.provider, samples, fallback);
      analysisSource = "ai";
    } catch (error) {
      analysisWarning = `AI 分析失败，已使用本地规则推断：${summarizeAnalysisError(error)}`;
    }
  }

  const profile = cleanFolderHabitProfile({
    id: `habit-${Date.now()}`,
    createdAt: Date.now(),
    ...analyzed,
    analysisSource,
    analysisWarning,
    learning: storedProfile?.learning,
  });

  await saveFolderHabitProfile(profile);
  await clearPreviewPlan();
  return profile;
}

export async function saveEditedFolderHabitProfile(profile: FolderHabitProfile): Promise<FolderHabitProfile> {
  const next = cleanFolderHabitProfile({
    ...profile,
    analysisWarning: profile.analysisWarning,
  });
  await saveFolderHabitProfile(next);
  await clearPreviewPlan();
  return next;
}

export async function recordHabitFeedback(feedback: HabitFeedback): Promise<string | null> {
  const suggestedFolderPath = cleanPath(feedback.suggestedFolderPath);
  const chosenFolderPath = feedback.type === "category_override" ? cleanPath(feedback.chosenFolderPath) : undefined;
  if (!suggestedFolderPath.length || (chosenFolderPath && samePath(suggestedFolderPath, chosenFolderPath))) return null;

  const now = Date.now();
  const stored = await getFolderHabitProfile();
  const profile = cleanFolderHabitProfile(stored ?? {
    id: `habit-${now}`,
    createdAt: now,
    folderCount: 0,
    bookmarkCount: 0,
    summary: "",
    preferredTopLevelFolders: [],
    folderRules: [],
    avoidRules: [],
    promptHint: "",
  });
  const learning = {
    ...emptyLearning(),
    ...profile.learning,
    depthVotes: { ...emptyLearning().depthVotes, ...profile.learning?.depthVotes },
    styleVotes: { ...emptyLearning().styleVotes, ...profile.learning?.styleVotes },
    categoryCorrections: [...(profile.learning?.categoryCorrections ?? [])],
    domainPreferences: [...(profile.learning?.domainPreferences ?? [])],
    rejectedFolderPaths: [...(profile.learning?.rejectedFolderPaths ?? [])],
    recentEvents: [...(profile.learning?.recentEvents ?? [])],
  };
  const domain = feedback.bookmarkUrl ? getDomain(feedback.bookmarkUrl).toLowerCase() : "";

  if (feedback.type === "category_override" && chosenFolderPath) {
    learning.correctionCount += 1;
    learning.categoryCorrections = upsertCategoryCorrection(
      learning.categoryCorrections,
      suggestedFolderPath,
      chosenFolderPath,
      now
    );
    if (chosenFolderPath.length > 1) learning.depthVotes.nested += 1;
    else learning.depthVotes.levelOne += 1;

    if (PURPOSE_CATEGORY_PATTERN.test(chosenFolderPath.join(" "))) learning.styleVotes.purpose += 1;
    else learning.styleVotes.topic += 1;

    if (domain) {
      const otherDomainPaths = learning.domainPreferences.filter((item) => item.domain !== domain);
      const sameDomainPaths = learning.domainPreferences.filter((item) => item.domain === domain);
      learning.domainPreferences = [
        ...upsertPathSignal(sameDomainPaths, chosenFolderPath, now, { domain }),
        ...otherDomainPaths,
      ]
        .sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt)
        .slice(0, 24);
    }

    const first = chosenFolderPath[0];
    profile.preferredTopLevelFolders = [first, ...profile.preferredTopLevelFolders.filter((item) => item !== first)].slice(0, 16);
  } else {
    learning.rejectionCount += 1;
    const existingFolders = await getAllBookmarkFolders().catch(() => []);
    const isNewFolder = !existingFolders.some((folder) => samePath(stripRootFolderNames(folder.path), suggestedFolderPath));
    learning.rejectedFolderPaths = upsertRejectedSignal(
      learning.rejectedFolderPaths,
      suggestedFolderPath,
      isNewFolder ? undefined : domain || undefined,
      isNewFolder,
      now,
    );
  }

  learning.lastLearnedAt = now;
  learning.recentEvents = [{
    id: `habit-event-${now}-${Math.random().toString(36).slice(2, 7)}`,
    type: feedback.type,
    createdAt: now,
    bookmarkTitle: feedback.bookmarkTitle,
    domain: domain || undefined,
    suggestedFolderPath,
    chosenFolderPath,
  }, ...learning.recentEvents].slice(0, 30);

  const next = cleanFolderHabitProfile({
    ...profile,
    learning,
  });
  await saveFolderHabitProfile(next);

  if (feedback.type === "folder_rejected") {
    const rejected = learning.rejectedFolderPaths.find((item) =>
      folderKey(item.folderPath) === folderKey(suggestedFolderPath) &&
      (item.isNewFolder || item.domain === domain)
    );
    return rejected?.isNewFolder
      ? `已记住：减少新建“${suggestedFolderPath.join(" / ")}”`
      : `已记住：减少把 ${domain || "类似书签"} 归入“${suggestedFolderPath.join(" / ")}”`;
  }
  return `已记住：${domain ? `${domain} 的书签` : "类似书签"}优先归入“${chosenFolderPath?.join(" / ")}”`;
}

export { getFolderHabitProfile };
