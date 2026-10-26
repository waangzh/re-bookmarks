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
  const tasks: Array<{ label: string; to: string; title: string; description: string; cta: string; kind: string; count?: number }> = [];
  if (input.task?.status === "running") tasks.push({ label: "正在生成整理方案，查看进度", to: "/preview", kind: "running", title: "整理方案正在生成", description: "可以继续浏览书签，稍后回来检查分类建议。生成建议不会移动书签。", cta: "查看整理进度" });
  else if (input.task?.status === "failed") tasks.push({ label: "上次生成未完成，查看原因并重试", to: "/preview", kind: "failed", title: "上次的整理方案尚未完成", description: "查看失败原因后再重试。书签仍保留在原来的位置。", cta: "查看原因与恢复选项" });
  else if (input.hasPreview) tasks.push({ label: "继续审核已保存的整理方案", to: "/preview", kind: "preview", title: "上次的分类建议，等你确认", description: "先检查分类结构、移动建议和异常项，再决定是否应用。", cta: "继续审核整理方案" });
  if (input.failedCount) tasks.push({ label: `${input.failedCount} 项整理失败需要复查`, to: "/report", kind: "report", count: input.failedCount, title: `有 ${input.failedCount} 项操作需要复查`, description: "部分书签未能完成操作。检查执行记录与原因，再决定下一步。", cta: "查看执行记录" });
  if (pendingCount) tasks.push({ label: `${pendingCount} 个书签待归档`, to: "/manage?task=unsorted", kind: "archive", count: pendingCount, title: `${pendingCount} 个书签，等待归档`, description: "核对已有建议，也可以直接指定目录。接受、修改或暂不处理，由你决定。", cta: `查看这 ${pendingCount} 个书签` });
  if (input.duplicateGroups) tasks.push({ label: `${input.duplicateGroups} 组疑似重复链接`, to: "/manage?task=duplicate", kind: "duplicate", count: input.duplicateGroups, title: `有 ${input.duplicateGroups} 组疑似重复链接`, description: "先核对网址与保留项，再决定是否清理。重复候选不会自动删除。", cta: "核对重复书签" });
  if (input.linkProblems) tasks.push({ label: `${input.linkProblems} 个链接需要复查`, to: "/manage?task=invalid", kind: "links", count: input.linkProblems, title: `有 ${input.linkProblems} 条链接值得复查`, description: "网页可能已失效，也可能只是暂时无法访问。确认后再决定是否清理。", cta: `复查这 ${input.linkProblems} 条链接` });
  return { pendingCount, tasks };
}
