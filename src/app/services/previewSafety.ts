import type { BookmarkNode, MovePlan, Settings } from "../types";

const key = (path: string[]) => JSON.stringify(path);

export function classificationPolicyFingerprint(settings: Settings) {
  const text = JSON.stringify([settings.allowNestedFolders, settings.maxNestingLevel, settings.maxTopLevelFolders,
    settings.maxSubfoldersPerFolder, settings.unclassifiedHandling, settings.customPrompt]);
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

export function getPlanChangeReason(plan: MovePlan, bookmark: BookmarkNode | undefined, folders: BookmarkNode[], settings: Settings) {
  if (!bookmark) return "书签已不存在，请重新生成受影响项";
  if (bookmark.parentId !== plan.fromParentId || bookmark.title !== plan.bookmarkTitle || bookmark.url !== plan.bookmarkUrl ||
    (plan.sourceFolderPath && key(bookmark.path) !== key(plan.sourceFolderPath))) return "书签位置、标题或 URL 已变化，请重新审核";
  if (plan.policyFingerprint && plan.policyFingerprint !== classificationPolicyFingerprint(settings)) return "分类规则已变化，请重新生成建议";
  if (plan.expectedTargetId) {
    const target = folders.find((folder) => folder.id === plan.expectedTargetId);
    if (!target || key(target.path) !== key(plan.toFolderPath)) return "原目标目录已删除、移动或重命名，请重新选择";
  }
  return null;
}

export function getPlanSummary(plans: MovePlan[], bookmarks: BookmarkNode[], folders: BookmarkNode[]) {
  const byId = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
  const unique = [...new Map(plans.map((plan) => [plan.bookmarkId, plan])).values()];
  const moving = unique.filter((plan) => !plan.keepInPlace && key(byId.get(plan.bookmarkId)?.path ?? plan.sourceFolderPath ?? []) !== key(plan.toFolderPath));
  const existing = new Set(folders.map((folder) => key(folder.path)));
  const created = new Map<string, string[]>();
  const reused = new Set<string>();
  for (const plan of moving) {
    if (existing.has(key(plan.toFolderPath))) reused.add(key(plan.toFolderPath));
    plan.toFolderPath.forEach((_, index) => {
      const path = plan.toFolderPath.slice(0, index + 1);
      if (!existing.has(key(path))) created.set(key(path), path);
    });
  }
  return { total: unique.length, moving, moveCount: moving.length, keepCount: unique.length - moving.length,
    newFolders: [...created.values()], reusedCount: reused.size,
    crossTopLevelCount: moving.filter((plan) => {
      const source = byId.get(plan.bookmarkId)?.path ?? plan.sourceFolderPath ?? [];
      return source.length && source[0] !== plan.toFolderPath[0];
    }).length };
}

export type PreviewReviewState = {
  signatures: Record<string, string>;
  plans: Record<string, "move" | "keep">;
  frameworks: Record<string, "approve" | "keep">;
};

export function parsePreviewReview(value: unknown): PreviewReviewState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const validMap = (map: unknown, allowed?: string[]) => map && typeof map === "object" && !Array.isArray(map) &&
    Object.values(map).every((entry) => typeof entry === "string" && (!allowed || allowed.includes(entry)));
  if (!validMap(record.signatures) || !validMap(record.plans, ["move", "keep"]) || !validMap(record.frameworks, ["approve", "keep"])) return null;
  return record as PreviewReviewState;
}
