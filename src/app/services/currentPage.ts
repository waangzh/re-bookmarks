import { createBookmarkInFolder, getAllBookmarks, getDefaultBookmarkParentId } from "./bookmarks";

let saving: Promise<{ created: boolean; id: string }> | null = null;
export function saveCurrentPage(title: string, url: string) {
  if (saving) return saving;
  saving = (async () => {
    if (!/^https?:\/\//i.test(url)) throw new Error("仅支持收藏 HTTP / HTTPS 网页");
    const existing = (await getAllBookmarks()).find((bookmark) => bookmark.url === url);
    if (existing) return { created: false, id: existing.id };
    const node = await createBookmarkInFolder(await getDefaultBookmarkParentId(), title, url);
    return { created: true, id: node.id };
  })().finally(() => { saving = null; });
  return saving;
}
