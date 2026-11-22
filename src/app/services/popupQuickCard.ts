import type { BookmarkNode, PendingRecommendation } from "../types";
import { sanitizeUrl } from "./rules";

export type PopupCurrentPage = {
  title: string;
  url: string;
  saved: boolean;
  savedPaths: string[];
  related: BookmarkNode[];
  windowId?: number;
};

export type PopupQuickTarget = {
  currentBookmarks: BookmarkNode[];
  currentRecommendation: PendingRecommendation | null;
  isAnalyzingCurrent: boolean;
  latestOtherRecommendation: PendingRecommendation | null;
  totalPendingCount: number;
  analyzingOtherCount: number;
};

function matchesPageUrl(targetUrl: string | undefined, pageSanitizedUrl: string): boolean {
  if (!targetUrl || !pageSanitizedUrl) return false;
  return sanitizeUrl(targetUrl) === pageSanitizedUrl;
}

/**
 * 解析 Popup 置顶快捷卡应展示的“当前页 / 刚收藏”目标：
 * 1. 优先匹配当前标签页对应的待处理推荐或正在后台分析中的新书签；
 * 2. 若当前页没有待处理推荐，仍补充最新一条刚收藏的待整理推荐，方便跨标签页后立刻处理。
 */
export function resolvePopupQuickTarget(input: {
  currentPage: PopupCurrentPage | null;
  bookmarks: BookmarkNode[];
  pendingRecommendations: PendingRecommendation[];
  analyzingBookmarkIds: string[];
}): PopupQuickTarget {
  const sortedRecommendations = [...input.pendingRecommendations].sort(
    (left, right) => right.createdAt - left.createdAt
  );
  const analyzingSet = new Set(input.analyzingBookmarkIds);
  const pageUrl = input.currentPage?.url ? sanitizeUrl(input.currentPage.url) : "";

  const currentBookmarks = pageUrl
    ? input.bookmarks.filter((bookmark) => bookmark.type === "url" && matchesPageUrl(bookmark.url, pageUrl))
    : [];
  const currentBookmarkIds = new Set(currentBookmarks.map((bookmark) => bookmark.id));

  const currentRecommendation =
    pageUrl
      ? sortedRecommendations.find(
          (recommendation) =>
            currentBookmarkIds.has(recommendation.bookmarkId) ||
            matchesPageUrl(recommendation.bookmarkUrl, pageUrl)
        ) ?? null
      : null;

  const isAnalyzingCurrent = Boolean(
    !currentRecommendation &&
      currentBookmarks.some((bookmark) => analyzingSet.has(bookmark.id))
  );

  const latestOtherRecommendation =
    sortedRecommendations.find((recommendation) => recommendation.id !== currentRecommendation?.id) ?? null;

  const analyzingOtherCount = input.analyzingBookmarkIds.filter(
    (bookmarkId) => !currentBookmarkIds.has(bookmarkId)
  ).length;

  return {
    currentBookmarks,
    currentRecommendation,
    isAnalyzingCurrent,
    latestOtherRecommendation,
    totalPendingCount: sortedRecommendations.length,
    analyzingOtherCount,
  };
}
