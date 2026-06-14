import type {
  BookmarkImportFailedItem,
  BookmarkImportItem,
  BookmarkImportPreview,
  BookmarkImportProgress,
  BookmarkImportReport,
  BookmarkNode,
} from "../types";
import { createBookmarkInFolder, createFolderInFolder, getBookmarkTree, isRootFolder } from "./bookmarks";
import { createPreImportBackup } from "./backups";
import { sanitizeUrl } from "./rules";

type ParsedBookmark = {
  title: string;
  url: string;
  path: string[];
};

type ParsedBookmarkFile = {
  bookmarks: ParsedBookmark[];
  folderPaths: string[][];
};

const IMPORT_MAX_DEPTH = 30;
const VALID_IMPORT_PROTOCOLS = new Set(["http:", "https:", "file:"]);

function normalizeImportPath(path: string[]) {
  return path.map((part) => part.trim()).filter(Boolean);
}

function pathKey(path: string[]) {
  return normalizeImportPath(path).join("\u0000");
}

function defaultParentId(tree: chrome.bookmarks.BookmarkTreeNode[]) {
  return tree[0]?.children?.find((child) => !child.url)?.id ?? "1";
}

function formatImportRootName(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `导入书签 ${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function getDirectElement(parent: Element, tagName: string) {
  return Array.from(parent.children).find((child) => child.tagName.toUpperCase() === tagName.toUpperCase()) ?? null;
}

function getNestedFolderList(folderNode: Element) {
  const direct = getDirectElement(folderNode, "DL");
  if (direct) return direct;

  let sibling = folderNode.nextElementSibling;
  while (sibling?.tagName.toUpperCase() === "P") {
    sibling = sibling.nextElementSibling;
  }
  return sibling?.tagName.toUpperCase() === "DL" ? sibling : null;
}

function firstBookmarkList(document: Document) {
  return Array.from(document.querySelectorAll("dl")).find((dl) => dl.querySelector("dt a, dt h3")) ?? null;
}

function parseBookmarkDocument(document: Document): ParsedBookmarkFile {
  const rootList = firstBookmarkList(document);
  if (!rootList) {
    throw new Error("未识别到 Netscape 书签结构，请选择浏览器导出的 bookmarks.html 文件");
  }

  const bookmarks: ParsedBookmark[] = [];
  const folderKeys = new Set<string>();
  const consumedLists = new Set<Element>();

  const visitList = (list: Element, path: string[]) => {
    if (consumedLists.has(list)) return;
    consumedLists.add(list);

    for (const child of Array.from(list.children)) {
      if (child.tagName.toUpperCase() !== "DT") continue;

      const folderTitle = getDirectElement(child, "H3")?.textContent?.trim();
      if (folderTitle) {
        const folderPath = normalizeImportPath([...path, folderTitle]);
        if (folderPath.length) folderKeys.add(pathKey(folderPath));
        const nestedList = getNestedFolderList(child);
        if (nestedList) visitList(nestedList, folderPath);
        continue;
      }

      const link = getDirectElement(child, "A");
      if (!link) continue;

      bookmarks.push({
        title: link.textContent?.trim() ?? "",
        url: link.getAttribute("href")?.trim() ?? "",
        path: normalizeImportPath(path),
      });
    }
  };

  visitList(rootList, []);
  if (bookmarks.length === 0 && folderKeys.size === 0) {
    throw new Error("未在文件中找到可导入的书签");
  }

  return {
    bookmarks,
    folderPaths: [...folderKeys].map((key) => key.split("\u0000").filter(Boolean)),
  };
}

function isValidImportUrl(url: string) {
  try {
    return VALID_IMPORT_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function existingUrlLookup(bookmarks: BookmarkNode[]) {
  const lookup = new Map<string, BookmarkNode>();
  bookmarks.forEach((bookmark) => {
    if (!bookmark.url) return;
    const normalizedUrl = sanitizeUrl(bookmark.url);
    if (normalizedUrl && !lookup.has(normalizedUrl)) {
      lookup.set(normalizedUrl, bookmark);
    }
  });
  return lookup;
}

function collectFoldersByParent(nodes: chrome.bookmarks.BookmarkTreeNode[]) {
  const foldersByParent = new Map<string, Set<string>>();

  const visit = (node: chrome.bookmarks.BookmarkTreeNode) => {
    if (!node.url && node.parentId && !isRootFolder(node.id)) {
      const names = foldersByParent.get(node.parentId) ?? new Set<string>();
      names.add(node.title);
      foldersByParent.set(node.parentId, names);
    }
    node.children?.forEach(visit);
  };

  nodes.forEach(visit);
  return foldersByParent;
}

function uniqueFolderName(baseName: string, siblingNames: Set<string>) {
  if (!siblingNames.has(baseName)) return baseName;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} (${index})`;
    if (!siblingNames.has(candidate)) return candidate;
  }

  return `${baseName} ${Date.now()}`;
}

async function createUniqueImportRoot(baseName: string) {
  const tree = await getBookmarkTree();
  const parentId = defaultParentId(tree);
  const foldersByParent = collectFoldersByParent(tree);
  const rootName = uniqueFolderName(baseName, foldersByParent.get(parentId) ?? new Set());
  const root = await createFolderInFolder(parentId, rootName);
  return root;
}

async function ensureChildFolderPath(rootId: string, path: string[], foldersByPath: Map<string, string>) {
  let parentId = rootId;

  for (const folderName of normalizeImportPath(path).slice(0, IMPORT_MAX_DEPTH - 1)) {
    const key = `${parentId}\u0000${folderName}`;
    const existingId = foldersByPath.get(key);
    if (existingId) {
      parentId = existingId;
      continue;
    }

    const created = await createFolderInFolder(parentId, folderName);
    foldersByPath.set(key, created.id);
    parentId = created.id;
  }

  return parentId;
}

export function parseBookmarkHtml(html: string): ParsedBookmarkFile {
  if (!html.trim()) throw new Error("书签文件为空");
  if (typeof DOMParser === "undefined") throw new Error("当前环境不支持解析 HTML 书签文件");

  const document = new DOMParser().parseFromString(html, "text/html");
  return parseBookmarkDocument(document);
}

export function buildBookmarkImportPreview(
  html: string,
  existingBookmarks: BookmarkNode[],
  sourceFileName?: string
): BookmarkImportPreview {
  const parsed = parseBookmarkHtml(html);
  const existingUrls = existingUrlLookup(existingBookmarks);

  const items: BookmarkImportItem[] = parsed.bookmarks.map((bookmark, index) => {
    const title = bookmark.title.trim();
    const url = bookmark.url.trim();
    const normalizedUrl = url ? sanitizeUrl(url) : "";
    const existing = normalizedUrl ? existingUrls.get(normalizedUrl) : undefined;

    if (!title) {
      return {
        id: `import-${index}`,
        title,
        url,
        normalizedUrl,
        path: bookmark.path,
        status: "invalid",
        reason: "标题为空",
      };
    }

    if (!url) {
      return {
        id: `import-${index}`,
        title,
        url,
        normalizedUrl,
        path: bookmark.path,
        status: "invalid",
        reason: "URL 为空",
      };
    }

    if (!isValidImportUrl(url)) {
      return {
        id: `import-${index}`,
        title,
        url,
        normalizedUrl,
        path: bookmark.path,
        status: "invalid",
        reason: "仅支持 http、https 或 file 链接",
      };
    }

    if (existing) {
      return {
        id: `import-${index}`,
        title,
        url,
        normalizedUrl,
        path: bookmark.path,
        status: "duplicate",
        reason: "当前浏览器中已存在相同 URL",
        existingBookmarkTitle: existing.title,
      };
    }

    return {
      id: `import-${index}`,
      title,
      url,
      normalizedUrl,
      path: bookmark.path,
      status: "ready",
    };
  });

  const readyCount = items.filter((item) => item.status === "ready").length;
  const duplicateCount = items.filter((item) => item.status === "duplicate").length;
  const invalidCount = items.filter((item) => item.status === "invalid").length;

  return {
    id: `import-preview-${Date.now()}`,
    createdAt: Date.now(),
    sourceFileName,
    targetRootName: formatImportRootName(),
    items,
    bookmarkCount: items.length,
    readyCount,
    duplicateCount,
    invalidCount,
    folderCount: parsed.folderPaths.length + 1,
  };
}

function failedItem(item: BookmarkImportItem, reason: string): BookmarkImportFailedItem {
  return {
    itemId: item.id,
    title: item.title,
    url: item.url,
    path: item.path,
    reason,
  };
}

export async function executeBookmarkImport(
  preview: BookmarkImportPreview,
  onProgress?: (progress: BookmarkImportProgress) => void
): Promise<BookmarkImportReport> {
  const readyItems = preview.items.filter((item) => item.status === "ready");
  const backup = await createPreImportBackup();
  const failedItems: BookmarkImportFailedItem[] = [];
  let importedCount = 0;
  let processed = 0;

  const root = await createUniqueImportRoot(preview.targetRootName);
  const foldersByPath = new Map<string, string>();

  for (const item of readyItems) {
    try {
      const parentId = await ensureChildFolderPath(root.id, item.path, foldersByPath);
      await createBookmarkInFolder(parentId, item.title, item.url);
      importedCount += 1;
    } catch (error) {
      failedItems.push(failedItem(item, error instanceof Error ? error.message : "导入失败"));
    } finally {
      processed += 1;
      onProgress?.({ processed, total: readyItems.length });
    }
  }

  return {
    id: `import-report-${Date.now()}`,
    createdAt: Date.now(),
    targetRootName: root.title,
    backupId: backup.id,
    backupCreatedAt: backup.createdAt,
    importedCount,
    skippedCount: preview.duplicateCount + preview.invalidCount,
    duplicateCount: preview.duplicateCount,
    invalidCount: preview.invalidCount,
    folderCount: preview.folderCount,
    failedItems,
  };
}
