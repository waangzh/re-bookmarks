import assert from "node:assert/strict";
import test from "node:test";
import { setupBrowser } from "./browser-mock.mjs";
import { loadService } from "./load-service.mjs";

const { getDuplicateBookmarkGroups, countDuplicateGroups, getVisibleUnsortedBookmarks } =
  await loadService("src/app/services/bookmarkTasks.ts");
const { getDuplicateBookmarkIgnores, updateDuplicateBookmarkIgnores, STORAGE_KEYS } =
  await loadService("src/app/services/storage.ts");

const link = (id, url, title = id, path = []) => ({ id, url, title, path, type: "url" });

test("完整链接匹配保留查询顺序、锚点、斜杠和跟踪参数", () => {
  const url = "https://example.test/profile";
  for (const [left, right] of [
    [`${url}?id=1`, `${url}?id=2`],
    [`${url}?a=1&b=2`, `${url}?b=2&a=1`],
    [`${url}?id=1&id=2`, `${url}?id=2&id=1`],
    [`${url}#one`, `${url}#two`],
    [url, `${url}#/page`],
    [url, `${url}/`],
    [url, `${url}?utm_source=news`],
    [url, `${url}?`],
    [url, `${url}#`],
    [url, "https://example.test:444/profile"],
    [`${url}/a%2Fb`, `${url}/a/b`],
    [url, "http://example.test/profile"],
  ]) {
    assert.deepEqual(getDuplicateBookmarkGroups([link("left", left, "同一个标题"), link("right", right, "同一个标题")], []),
      [], `不能合并 ${left} 和 ${right}`);
  }

  const bookmarks = [
    link("home", "https://forum.test/", "LINUX DO"),
    link("article-a", "https://forum.test/t/1", "Zotero setup - LINUX DO"),
    link("article-b", "https://forum.test/t/2", "ML notes - LINUX DO"),
  ];
  assert.equal(countDuplicateGroups(bookmarks, []), 0);
});

test("完整链接经浏览器规范化后可跨目录匹配，优先保留白名单副本", () => {
  const bookmarks = [
    link("protected", "https://EXAMPLE.test:443/path?id=1#details", "原始收藏", ["资料"]),
    link("copy", "https://example.test/path?id=1#details", "另一条数据", ["研究", "项目"]),
  ];
  const protectedIds = new Set(["protected"]);
  const [group] = getDuplicateBookmarkGroups(bookmarks, [], protectedIds);
  assert.deepEqual(group.items, bookmarks);
  assert.equal(group.recommendedKeepId, "protected");
  assert.deepEqual(group.suggestedDeleteIds, ["copy"]);
  assert.equal(countDuplicateGroups(bookmarks, [], protectedIds), 1);
  assert.equal(countDuplicateGroups(bookmarks, [], new Set(["protected", "copy"])), 0);
});

test("忽略和恢复仅修改本地去重记录，并以书签 ID 和当前 URL 匹配", async () => {
  const { values } = setupBrowser();
  const initial = link("initial", "https://example.test/");
  const copy = link("copy", initial.url);
  const later = link("later", initial.url);
  const changed = link("copy", "https://example.test/updated");
  const whitelist = [{ type: "bookmark", id: "other" }];
  values[STORAGE_KEYS.bookmarkWhitelist] = whitelist;

  await updateDuplicateBookmarkIgnores([copy], true);
  const ignored = await getDuplicateBookmarkIgnores();
  assert.deepEqual(ignored, [{ id: copy.id, url: copy.url }]);
  assert.equal(countDuplicateGroups([initial, { ...copy, path: ["新目录"] }], ignored), 0);
  assert.deepEqual(getVisibleUnsortedBookmarks([copy], []), [copy]);
  assert.deepEqual(getDuplicateBookmarkGroups([initial, copy, later], ignored)[0].items, [initial, later]);
  assert.equal(countDuplicateGroups([changed, { ...changed, id: "updated-copy" }], ignored), 1);
  assert.deepEqual(values[STORAGE_KEYS.bookmarkWhitelist], whitelist);

  await updateDuplicateBookmarkIgnores([copy], false);
  assert.equal(countDuplicateGroups([initial, copy], await getDuplicateBookmarkIgnores()), 1);
  assert.deepEqual(Object.keys(values).sort(), [STORAGE_KEYS.bookmarkWhitelist, STORAGE_KEYS.duplicateBookmarkIgnores].sort());
});

test("并行追加保留两条记录，损坏数据和失败的写入不被覆盖", async () => {
  const { values } = setupBrowser();
  const first = link("first", "https://example.test/");
  const second = link("second", "https://example.test/");
  await Promise.all([updateDuplicateBookmarkIgnores([first], true), updateDuplicateBookmarkIgnores([second], true)]);
  assert.equal((await getDuplicateBookmarkIgnores()).length, 2);
  values[STORAGE_KEYS.duplicateBookmarkIgnores] = "invalid";
  await assert.rejects(updateDuplicateBookmarkIgnores([first], true), /格式无效/);
  assert.equal(values[STORAGE_KEYS.duplicateBookmarkIgnores], "invalid");

  const failing = setupBrowser({ failStorageKey: STORAGE_KEYS.duplicateBookmarkIgnores });
  await assert.rejects(updateDuplicateBookmarkIgnores([first], true), /写入失败/);
  assert.equal(failing.values[STORAGE_KEYS.duplicateBookmarkIgnores], undefined);
});
