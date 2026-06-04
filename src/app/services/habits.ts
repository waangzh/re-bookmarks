import type { FolderHabitProfile, FolderHabitSample } from "../types";
import { analyzeFolderHabitsWithAI } from "./aiProvider";
import { getAllBookmarks } from "./bookmarks";
import { getDomain, sanitizeUrl } from "./rules";
import {
  clearPreviewPlan,
  getFolderHabitProfile,
  getSettings,
  saveFolderHabitProfile,
} from "./storage";

const ROOT_FOLDER_NAMES = new Set(["收藏夹栏", "书签栏", "其他收藏夹", "移动设备书签", "Bookmarks Bar", "Other Bookmarks", "Mobile Bookmarks"]);

function folderKey(path: string[]) {
  return path.join(" / ");
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
  };
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
  const [settings, samples] = await Promise.all([getSettings(), collectFolderHabitSamples()]);
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

export { getFolderHabitProfile };
