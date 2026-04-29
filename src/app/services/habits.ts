import type { FolderHabitProfile, FolderHabitSample } from "../types";
import { analyzeFolderHabitsWithAI } from "./aiProvider";
import { getAllBookmarks } from "./bookmarks";
import { getDomain } from "./rules";
import {
  clearPreviewPlan,
  getFolderHabitProfile,
  getSettings,
  saveFolderHabitProfile,
} from "./storage";

function folderKey(path: string[]) {
  return path.join(" / ");
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
    pattern: `已有 ${sample.bookmarkCount} 个书签，示例：${sample.examples
      .map((example) => `${example.title}${example.domain ? `(${example.domain})` : ""}`)
      .join("、")}`,
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
      ? `优先复用用户已有一级分类：${preferredTopLevelFolders.join("、")}；分类粒度应贴近现有文件夹，不要过度细分。`
      : "分类应保持少量、通用、可维护。",
  };
}

export async function collectFolderHabitSamples(): Promise<FolderHabitSample[]> {
  const bookmarks = await getAllBookmarks();
  const folders = new Map<string, FolderHabitSample>();

  for (const bookmark of bookmarks) {
    if (!bookmark.url || bookmark.path.length === 0) continue;
    const key = folderKey(bookmark.path);
    const existing = folders.get(key) ?? {
      folderPath: bookmark.path,
      bookmarkCount: 0,
      examples: [],
    };

    existing.bookmarkCount += 1;
    if (existing.examples.length < 6) {
      existing.examples.push({
        title: bookmark.title,
        domain: getDomain(bookmark.url),
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
  const analyzed = samples.length
    ? await analyzeFolderHabitsWithAI(settings.provider, samples, fallback).catch(() => fallback)
    : fallback;
  const profile: FolderHabitProfile = {
    id: `habit-${Date.now()}`,
    createdAt: Date.now(),
    ...analyzed,
  };

  await saveFolderHabitProfile(profile);
  await clearPreviewPlan();
  return profile;
}

export { getFolderHabitProfile };
