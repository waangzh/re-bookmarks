import type { MovePlan, OrganizeReport, PendingRecommendation } from "../types";
import {
  type BrowserBookmarkNode,
  getBookmark,
  getBookmarkRootFolderIds,
  getUrlBookmarks,
  isBookmarkFolder,
  isRootFolder,
  normalizeFolderPath,
  flattenBookmarkTree,
} from "./bookmarks";
import { createPendingRecommendation, executeMovePlans } from "./organizer";
import { getStoredFolderHabitProfile, getSettings, getPendingRecommendations, updatePendingRecommendations } from "./storage";
import { getFixedDomainRules } from "./fixedRules";
import { getPreferenceConflict, getPreferenceFingerprint } from "./preferenceSafety";
import { ensureRequiredHostPermission } from "./hostPermissions";
import { getCurrentWhitelist, isProtectedTargetPath } from "./whitelist";
import { appendFolderImpression } from "./semanticIndex";
import { withStorageMutation } from "./storageMutation";

function hasChromeAction() {
  return typeof chrome !== "undefined" && Boolean(chrome.action);
}

function hasChromeBookmarks() {
  return typeof chrome !== "undefined" && Boolean(chrome.bookmarks);
}

export function getRecommendationKind(recommendation: PendingRecommendation) {
  if (recommendation.kind) return recommendation.kind;
  const firstFolder = recommendation.suggestedFolderPath[0]?.trim();
  if (recommendation.confidence < 0.55 || firstFolder === "待整理" || firstFolder === "未分类") {
    return "manual_review" as const;
  }
  return "move" as const;
}

export function isActionableRecommendation(recommendation: PendingRecommendation) {
  const kind = getRecommendationKind(recommendation);
  return (kind === "move" || kind === "create_folder") && recommendation.suggestedFolderPath.length > 0;
}

export function isBatchSafeRecommendation(recommendation: PendingRecommendation) {
  if (getRecommendationKind(recommendation) !== "move" || !isActionableRecommendation(recommendation)) return false;
  if (recommendation.requiresIndividualReview) return false;
  if (!recommendation.currentFolderPath || !recommendation.sourceParentId || !recommendation.expectedTargetId) return false;
  if (recommendation.confidence < 0.7 || /重复|duplicate|冲突/i.test(recommendation.reason ?? "")) return false;
  const sourceTop = recommendation.currentFolderPath[0];
  return recommendation.source === "manual" || !sourceTop || sourceTop === recommendation.suggestedFolderPath[0];
}

export function getRecommendationSignalLabel(recommendation: PendingRecommendation) {
  if (recommendation.source === "manual") return "你已指定";
  if (recommendation.source === "rule") return "固定规则";
  return recommendation.confidence >= 0.9 ? "依据较充分" : recommendation.confidence >= 0.7 ? "需要确认" : "依据不足";
}

function pathKey(path: string[]) {
  return normalizeFolderPath(path, Math.max(1, path.length)).join("\u0000");
}

function collectFolderPathKeys(tree: BrowserBookmarkNode[]) {
  const keys = new Set<string>();
  const rootFolderIds = getBookmarkRootFolderIds(tree);

  function visit(nodes: BrowserBookmarkNode[], path: string[]) {
    for (const node of nodes) {
      if (!isBookmarkFolder(node)) continue;
      const isRoot = isRootFolder(node.id, rootFolderIds);
      const currentPath = isRoot ? path : [...path, node.title];
      if (!isRoot && currentPath.length > 0) keys.add(pathKey(currentPath));
      if (node.children) visit(node.children as BrowserBookmarkNode[], currentPath);
    }
  }

  visit(tree, []);
  return keys;
}

function prunePendingRecommendations(completedIds?: Set<string>) {
  return updatePendingRecommendations(async (recommendations) => {
    if (!recommendations.length) return recommendations;
    const { tree, index } = await getCurrentWhitelist();
    const bookmarks = new Map(getUrlBookmarks(tree).map((bookmark) => [bookmark.id, bookmark]));
    const activeByBookmark = new Map<string, PendingRecommendation>();
    for (const recommendation of recommendations) {
      const bookmark = bookmarks.get(recommendation.bookmarkId);
      if (completedIds?.has(recommendation.id) || !bookmark || index.protectedBookmarkIds.has(bookmark.id) ||
          bookmark.title !== recommendation.bookmarkTitle ||
          (recommendation.bookmarkUrl !== undefined && bookmark.url !== recommendation.bookmarkUrl) ||
          (recommendation.sourceParentId !== undefined && bookmark.parentId !== recommendation.sourceParentId) ||
          (recommendation.currentFolderPath && JSON.stringify(bookmark.path) !== JSON.stringify(recommendation.currentFolderPath)) ||
          isProtectedTargetPath(recommendation.suggestedFolderPath, tree, index)) continue;

      const previous = activeByBookmark.get(bookmark.id);
      if (!previous || recommendation.createdAt > previous.createdAt) activeByBookmark.set(bookmark.id, recommendation);
    }
    return activeByBookmark.size === recommendations.length ? recommendations : [...activeByBookmark.values()];
  });
}

export async function getActivePendingRecommendations() {
  if (!hasChromeBookmarks()) return getPendingRecommendations();
  const recommendations = await prunePendingRecommendations();
  if (!recommendations.length) return recommendations;
  const [profile, rules] = await Promise.all([getStoredFolderHabitProfile(), getFixedDomainRules()]);
  return recommendations.map((recommendation) => {
    const plan = { bookmarkUrl: recommendation.bookmarkUrl, toFolderPath: recommendation.suggestedFolderPath,
      expectedTargetId: recommendation.expectedTargetId, source: recommendation.source };
    const conflict = getPreferenceConflict(plan, profile, rules);
    const fingerprint = getPreferenceFingerprint(plan, profile, rules);
    const changed = recommendation.preferenceFingerprint !== undefined && recommendation.preferenceFingerprint !== fingerprint;
    return { ...recommendation, preferenceFingerprint: fingerprint,
      requiresIndividualReview: recommendation.requiresIndividualReview || Boolean(conflict) || changed,
      reason: conflict && !recommendation.reason?.includes(conflict) ? [recommendation.reason, conflict].filter(Boolean).join("；")
        : changed ? "相关明确偏好已变化，请逐条确认" : recommendation.reason };
  });
}

export async function updateRecommendationBadge() {
  if (!hasChromeAction()) return;
  const count = (await getActivePendingRecommendations()).length;
  chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

export async function removeRecommendation(id: string) {
  const next = await updatePendingRecommendations((recommendations) =>
    recommendations.filter((recommendation) => recommendation.id !== id)
  );
  await updateRecommendationBadge();
  return next;
}


export async function removeRecommendationsForBookmark(bookmarkId: string) {
  const next = await updatePendingRecommendations((recommendations) => {
    const filtered = recommendations.filter((recommendation) => recommendation.bookmarkId !== bookmarkId);
    return filtered.length === recommendations.length ? recommendations : filtered;
  });
  await updateRecommendationBadge();
  return next;
}

export async function updateRecommendationFolderPath(id: string, folderPath: string[]) {
  const settings = await getSettings();
  const safeFolderPath = normalizeFolderPath(folderPath, settings.maxNestingLevel);
  if (safeFolderPath.length === 0) {
    throw new Error("请填写目标文件夹");
  }

  const protection = await getCurrentWhitelist();
  const tree = protection.tree;
  if (isProtectedTargetPath(safeFolderPath, tree, protection.index)) throw new Error("目标目录受保护，请选择其他目录");
  const nodes = flattenBookmarkTree(tree);
  const target = nodes.find((node) => node.type === "folder" && pathKey(node.path) === pathKey(safeFolderPath));
  const [profile, rules] = await Promise.all([getStoredFolderHabitProfile(), getFixedDomainRules()]);
  const existingPathKeys = collectFolderPathKeys(tree);
  let matched = false;
  const next = await updatePendingRecommendations((recommendations) =>
    recommendations.map((recommendation) => {
      if (recommendation.id !== id) return recommendation;
      matched = true;
      const bookmark = nodes.find((node) => node.id === recommendation.bookmarkId && node.type === "url");
      if (!bookmark) throw new Error("书签已不存在");
      if (protection.index.protectedBookmarkIds.has(bookmark.id)) throw new Error("书签已受保护，不能修改归档建议");
      return {
        ...recommendation,
        bookmarkTitle: bookmark.title,
        bookmarkUrl: bookmark.url,
        currentFolderPath: bookmark.path,
        sourceParentId: bookmark.parentId,
        source: "manual" as const,
        preferenceFingerprint: getPreferenceFingerprint({ bookmarkUrl: bookmark.url, toFolderPath: safeFolderPath, expectedTargetId: target?.id, source: "manual" }, profile, rules),
        requiresIndividualReview: false,
        suggestedFolderPath: safeFolderPath,
        kind: existingPathKeys.has(pathKey(safeFolderPath)) ? "move" as const : "create_folder" as const,
        errorCode: undefined,
        reason: "已由用户指定目标目录",
        confidence: 1,
        expectedTargetId: target?.id,
      };
    })
  );

  if (!matched) {
    throw new Error("推荐已不存在");
  }
  const updated = next.find((recommendation) => recommendation.id === id);
  if (updated?.bookmarkUrl) {
    await appendFolderImpression(updated.bookmarkUrl, safeFolderPath).catch(() => undefined);
  }
  await updateRecommendationBadge();
  return next;
}

export async function retryRecommendation(recommendation: PendingRecommendation) {
  const settings = await getSettings();
  if (settings.provider.apiKey && settings.provider.enabled) {
    await ensureRequiredHostPermission();
  }
  const bookmark = await getBookmark(recommendation.bookmarkId);
  if (!bookmark?.url) {
    await removeRecommendation(recommendation.id);
    throw new Error("书签已不存在");
  }

  const next = await createPendingRecommendation(bookmark);
  await updateRecommendationBadge();
  return next;
}

function reviewSnapshot(recommendation: PendingRecommendation) {
  return JSON.stringify([
    recommendation.bookmarkId, recommendation.bookmarkTitle, recommendation.bookmarkUrl,
    recommendation.sourceParentId, recommendation.currentFolderPath, recommendation.suggestedFolderPath,
    recommendation.expectedTargetId, recommendation.source, getRecommendationKind(recommendation),
  ]);
}

async function acceptCurrentRecommendations(
  recommendations: PendingRecommendation[],
  individual: boolean
): Promise<OrganizeReport> {
  if (individual && recommendations.length !== 1) throw new Error("单独确认每次只能处理一条建议");
  if (!individual && recommendations.some((recommendation) => !isBatchSafeRecommendation(recommendation))) {
    throw new Error("批量归档只接受已存在目录且无风险冲突的建议；其余项目请逐条确认");
  }
  const approved = recommendations.filter(isActionableRecommendation);
  if (approved.length === 0) {
    throw new Error("没有可执行的归档建议；需要判断或分类失败的项目会保持原位");
  }
  const active = new Map((await getActivePendingRecommendations()).map((recommendation) => [recommendation.id, recommendation]));
  const approvedById = new Map(approved.map((recommendation) => [recommendation.id, recommendation]));
  const actionableRecommendations = [...approvedById.values()].filter((recommendation) => {
    const current = active.get(recommendation.id);
    return current && reviewSnapshot(current) === reviewSnapshot(recommendation) &&
      (individual || isBatchSafeRecommendation(current));
  });
  if (!actionableRecommendations.length) throw new Error("建议已失效或已更新，请查看最新分类建议");

  const bookmarks = await Promise.all(
    actionableRecommendations.map((recommendation) => getBookmark(recommendation.bookmarkId))
  );
  const plans: MovePlan[] = actionableRecommendations.map((recommendation, index) => {
    const bookmark = bookmarks[index];
    return {
      bookmarkId: recommendation.bookmarkId,
      bookmarkTitle: recommendation.bookmarkTitle,
      bookmarkUrl: recommendation.bookmarkUrl,
      sourceFolderPath: recommendation.currentFolderPath,
      expectedTargetId: recommendation.expectedTargetId,
      preferenceFingerprint: recommendation.preferenceFingerprint,
      source: recommendation.source,
      fromParentId: recommendation.sourceParentId ?? bookmark?.parentId ?? "",
      fromIndex: bookmark?.index,
      toFolderPath: recommendation.suggestedFolderPath,
      confidence: recommendation.confidence,
      reason: recommendation.reason,
    };
  });

  const report = await executeMovePlans(plans, undefined, { reportKind: "recommendation" });
  const failedBookmarkIds = new Set(report.failedItems.map((item) => item.bookmarkId));
  const completedRecommendationIds = new Set(
    actionableRecommendations
      .filter((recommendation) => !failedBookmarkIds.has(recommendation.bookmarkId))
      .map((recommendation) => recommendation.id)
  );
  await prunePendingRecommendations(completedRecommendationIds);
  await updateRecommendationBadge();
  return report;
}

export function acceptRecommendations(
  recommendations: PendingRecommendation[],
  options: { individual?: boolean } = {}
) {
  return withStorageMutation("accept-recommendations", () => acceptCurrentRecommendations(recommendations, options.individual === true));
}

export function acceptRecommendation(recommendation: PendingRecommendation) {
  return acceptRecommendations([recommendation], { individual: true });
}
