import type { BookmarkNode, FixedDomainRule, FolderHabitProfile, MovePlan, PreviewRiskItem, PreviewBatchGroup, PreviewFrameworkGroup, PreviewPlanDecision, PreviewFrameworkDecision } from "../types";
import { getPreferenceConflict } from "./preferenceSafety";
const STRONG_MODEL_SIGNAL = 0.9;
const WEAK_MODEL_SIGNAL = 0.7;

export function pathKey(path: string[]) {
  return path.map((part) => part.trim()).filter(Boolean).join(" / ");
}

function isSamePath(left: string[], right: string[]) {
  return pathKey(left) === pathKey(right);
}

export function groupRiskItemsByTarget(items: PreviewRiskItem[]) {
  const groupsByPath = new Map<string, PreviewBatchGroup>();
  for (const item of items) {
    const key = pathKey(item.plan.toFolderPath) || "待整理";
    const group = groupsByPath.get(key) ?? {
      key,
      targetPath: item.plan.toFolderPath,
      items: [],
    };
    group.items.push(item);
    groupsByPath.set(key, group);
  }

  return [...groupsByPath.values()]
    .map((group) => ({
      ...group,
      items: group.items.sort((left, right) =>
        right.plan.confidence - left.plan.confidence ||
        left.plan.bookmarkTitle.localeCompare(right.plan.bookmarkTitle, "zh-CN")
      ),
    }))
    .sort((left, right) => right.items.length - left.items.length || left.key.localeCompare(right.key, "zh-CN"));
}

export function buildPreviewRiskAnalysis(
  plans: MovePlan[],
  bookmarks: BookmarkNode[],
  habitProfile: FolderHabitProfile | null,
  fixedRules: FixedDomainRule[] = [],
  preferenceProfile: FolderHabitProfile | null = habitProfile,
  folders: BookmarkNode[] = []
) {
  const bookmarkById = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
  const existingPathCounts = new Map<string, number>();
  const existingTopLevels = new Set<string>();

  for (const bookmark of [...bookmarks, ...folders]) {
    bookmark.path.forEach((_, index) => {
      const key = pathKey(bookmark.path.slice(0, index + 1));
      if (key) existingPathCounts.set(key, (existingPathCounts.get(key) ?? 0) + 1);
    });
    if (bookmark.path[0]) existingTopLevels.add(bookmark.path[0]);
  }

  const habitPaths = new Set(
    (habitProfile?.folderRules ?? []).map((rule) => pathKey(rule.folderPath)).filter(Boolean)
  );
  const preferredTopLevels = new Set(habitProfile?.preferredTopLevelFolders ?? []);
  const auto: PreviewRiskItem[] = [];
  const review: PreviewRiskItem[] = [];
  const keep: PreviewRiskItem[] = [];
  const frameworkCandidates: PreviewRiskItem[] = [];
  const batchCandidates: PreviewRiskItem[] = [];

  for (const plan of new Map(plans.map((plan) => [plan.bookmarkId, plan])).values()) {
    if (!bookmarkById.has(plan.bookmarkId)) continue;
    const sourcePath = bookmarkById.get(plan.bookmarkId)?.path ?? [];
    const targetPath = plan.toFolderPath;
    const targetKey = pathKey(targetPath);
    const targetExists = existingPathCounts.has(targetKey);
    const habitMatches = (existingPathCounts.get(targetKey) ?? 0) >= 2 ||
      habitPaths.has(targetKey) ||
      Boolean(targetPath[0] && preferredTopLevels.has(targetPath[0]));
    const keepsTopLevel = Boolean(sourcePath[0] && targetPath[0] && sourcePath[0] === targetPath[0]);
    const crossesTopLevel = Boolean(sourcePath[0] && targetPath[0] && sourcePath[0] !== targetPath[0]);
    const createsTopLevel = Boolean(targetPath[0] && !existingTopLevels.has(targetPath[0]));
    const possibleDuplicate = /重复|duplicate/i.test(plan.reason ?? "");
    const preferenceConflict = getPreferenceConflict(plan, preferenceProfile, fixedRules);
    const keepsOriginalPosition = Boolean(
      plan.keepInPlace ||
      (sourcePath.length > 0 && isSamePath(sourcePath, targetPath))
    );

    const insufficient = plan.source !== "manual" && (!Number.isFinite(plan.confidence) || plan.confidence < 0.55);
    const cleanup = possibleDuplicate || /失效|broken.link/i.test(plan.reason ?? "");
    if (keepsOriginalPosition || insufficient || cleanup) {
      keep.push({
        plan,
        level: "keep",
        sourcePath,
        reasons: [
          insufficient ? "分类依据不足，已安全保留原位" : cleanup ? "存在清理提示；保留原位，请在书签管理中独立核实" : plan.keepInPlace ? plan.reason || "当前计划保持原位" : "目标与原目录一致",
        ],
      });
      continue;
    }

    if (
      plan.source !== "manual" &&
      (
        plan.confidence >= STRONG_MODEL_SIGNAL &&
        targetExists &&
        !possibleDuplicate &&
        !preferenceConflict &&
        habitMatches &&
        keepsTopLevel
      )
    ) {
      auto.push({
        plan,
        level: "auto",
        sourcePath,
        reasons: [
          "模型信号较强、复用现有目录且符合已有分类习惯",
        ],
      });
      continue;
    }

    const reviewReasons = [
      preferenceConflict ?? "",
      crossesTopLevel ? "将跨一级目录移动" : "",
      possibleDuplicate ? "检测到可能重复；本次不会删除" : "",
      plan.confidence < WEAK_MODEL_SIGNAL ? "模型提供的分类依据较弱" : "",
    ].filter(Boolean);

    if (reviewReasons.length > 0) {
      if (createsTopLevel) reviewReasons.unshift("目标属于拟新增一级文件夹");
      const reviewItem: PreviewRiskItem = { plan, level: "review", sourcePath, reasons: reviewReasons };
      review.push(reviewItem);
      if (createsTopLevel) frameworkCandidates.push(reviewItem);
      continue;
    }

    if (createsTopLevel) {
      frameworkCandidates.push({
        plan,
        level: "framework",
        sourcePath,
        reasons: [`分配到拟新增一级目录“${targetPath[0]}”`],
      });
      continue;
    }

    batchCandidates.push({
      plan,
      level: "batch",
      sourcePath,
      reasons: [targetExists ? "目标目录已存在，请确认归档位置" : "目标目录尚未创建，请确认归档位置"],
    });
  }

  const sortByConfidence = (left: PreviewRiskItem, right: PreviewRiskItem) =>
    right.plan.confidence - left.plan.confidence ||
    left.plan.bookmarkTitle.localeCompare(right.plan.bookmarkTitle, "zh-CN");

  auto.sort(sortByConfidence);
  review.sort(sortByConfidence);
  keep.sort(sortByConfidence);
  frameworkCandidates.sort(sortByConfidence);
  const frameworkGroupsByTopLevel = new Map<string, PreviewFrameworkGroup>();
  for (const item of frameworkCandidates) {
    const topLevel = item.plan.toFolderPath[0];
    const key = `framework:${topLevel}`;
    const group = frameworkGroupsByTopLevel.get(key) ?? {
      key,
      topLevel,
      targetPathCount: 0,
      items: [],
    };
    group.items.push(item);
    frameworkGroupsByTopLevel.set(key, group);
  }
  const frameworkGroups = [...frameworkGroupsByTopLevel.values()]
    .map((group) => ({
      ...group,
      targetPathCount: new Set(group.items.map((item) => pathKey(item.plan.toFolderPath))).size,
    }))
    .sort((left, right) => right.items.length - left.items.length || left.topLevel.localeCompare(right.topLevel, "zh-CN"));
  const batchGroups = groupRiskItemsByTarget(batchCandidates);

  return { auto, frameworkGroups, batchGroups, review, keep };
}

export function derivePreviewReview(
  analysis: ReturnType<typeof buildPreviewRiskAnalysis>,
  decisions: Record<string, PreviewPlanDecision>,
  frameworks: Record<string, PreviewFrameworkDecision>
) {
  const frameworkById = new Map(analysis.frameworkGroups.flatMap((group) =>
    group.items.map((item) => [item.plan.bookmarkId, frameworks[group.key]] as const)));
  const items = [...new Map([
    ...analysis.auto, ...analysis.keep, ...analysis.review,
    ...analysis.batchGroups.flatMap((group) => group.items),
    ...analysis.frameworkGroups.flatMap((group) => group.items),
  ].map((item) => [item.plan.bookmarkId, item])).values()];
  const effective: Record<string, PreviewPlanDecision> = {};
  const pending: PreviewRiskItem[] = [];
  for (const item of items) {
    const id = item.plan.bookmarkId;
    const structure = frameworkById.get(id);
    if (item.level === "keep" || structure === "keep") effective[id] = "keep";
    else if (frameworkById.has(id) && structure !== "approve") pending.push(item);
    else if (decisions[id]) effective[id] = decisions[id];
    else if (item.level === "auto") effective[id] = "move";
    else pending.push(item);
  }
  const approvedPlans = items.filter((item) => effective[item.plan.bookmarkId] === "move").map((item) => item.plan);
  const keepCount = items.filter((item) => effective[item.plan.bookmarkId] === "keep").length;
  const pendingFrameworks = analysis.frameworkGroups.filter((group) => !frameworks[group.key]);
  return { items, effective, pending, approvedPlans, keepCount, pendingFrameworks, total: items.length };
}
