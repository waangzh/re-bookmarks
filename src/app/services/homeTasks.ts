import type { BookmarkNode, PendingRecommendation, PreviewTaskCache, Settings } from "../types";
import { getUnsortedTaskCount } from "./bookmarkTasks";

export function getOrganizeAction(settings: Settings, task: PreviewTaskCache | null, hasPreview: boolean) {
  if (task?.status === "running") return { label: "查看整理进度", to: "/preview" };
  if (task?.status === "failed") return { label: "查看失败原因", to: "/preview" };
  if (hasPreview) return { label: "继续审核整理方案", to: "/preview" };
  if (!settings.provider.apiKey.trim()) return { label: "启用 AI 智能整理", to: "/options" };
  if (!settings.provider.enabled) return { label: "授权后开始整理", to: "/options" };
  return { label: "开始智能整理", to: "/preview" };
}

export function getHomeTasks(input: {
  bookmarks: BookmarkNode[];
  recommendations: PendingRecommendation[];
  ignoredIds: string[];
  task: PreviewTaskCache | null;
  hasPreview: boolean;
  failedCount: number;
  duplicateGroups: number;
  linkProblems: number;
}) {
  const existingIds = new Set(input.bookmarks.map((item) => item.id));
  const recommendations = input.recommendations.filter((item) => existingIds.has(item.bookmarkId));
  const pendingCount = getUnsortedTaskCount(input.bookmarks, recommendations, input.ignoredIds);
  const tasks: Array<{ label: string; to: string }> = [];
  if (input.task?.status === "running") tasks.push({ label: "正在生成整理方案 · 查看进度", to: "/preview" });
  else if (input.task?.status === "failed") tasks.push({ label: "上次生成未完成 · 查看原因并重试", to: "/preview" });
  else if (input.hasPreview) tasks.push({ label: "继续审核已保存的整理方案", to: "/preview" });
  if (input.failedCount) tasks.push({ label: `${input.failedCount} 项整理失败需要复查`, to: "/report" });
  if (pendingCount) tasks.push({ label: `${pendingCount} 个书签待归档`, to: "/manage?task=unsorted" });
  if (input.duplicateGroups) tasks.push({ label: `${input.duplicateGroups} 组疑似重复链接`, to: "/manage?task=duplicate" });
  if (input.linkProblems) tasks.push({ label: `${input.linkProblems} 个链接需要复查`, to: "/manage?task=invalid" });
  return { pendingCount, tasks };
}
