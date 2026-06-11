import type { BookmarkForAI, BookmarkNode } from "../types";

export const UNCLASSIFIED_FOLDER_NAME = "未分类";
export const LEGACY_UNCLASSIFIED_FOLDER_NAMES = ["待整理", UNCLASSIFIED_FOLDER_NAME];

export function sanitizeUrl(url: string, sendFullUrl = false) {
  try {
    const parsed = new URL(url);
    if (sendFullUrl) return parsed.toString();
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function getDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function toBookmarkForAI(bookmark: BookmarkNode, sendFullUrl = false): BookmarkForAI {
  return {
    id: bookmark.id,
    title: bookmark.title,
    domain: bookmark.url ? getDomain(bookmark.url) : "",
    path: bookmark.path.join(" / "),
    sanitizedUrl: bookmark.url ? sanitizeUrl(bookmark.url, sendFullUrl) : "",
  };
}

export function normalizeCategoryPath(path: string[] | undefined, allowNested: boolean, maxDepth: number) {
  const safePath = (path?.length ? path : [UNCLASSIFIED_FOLDER_NAME]).map((part) => String(part).trim()).filter(Boolean);
  return safePath.slice(0, allowNested ? Math.max(1, maxDepth) : 1);
}
