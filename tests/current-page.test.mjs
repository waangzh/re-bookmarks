import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const { getCurrentPage } = await loadService("src/app/components/SidebarHome.tsx");

test("当前页按声明的 query/hash 策略匹配收藏，并显示目录和同网站条目", async () => {
  setupBrowser();
  chrome.tabs.query = (query, callback) => {
    assert.deepEqual(query, { active: true, currentWindow: true });
    callback([{ url: "https://a.test/docs?view=2#part", title: "当前文档" }]);
  };
  const bookmarks = [
    { id: "a", title: "不同书签标题", url: "https://a.test/docs?stored=1", path: ["开发", "文档"], type: "url" },
    { id: "related", title: "同站资料", url: "https://a.test/other", path: [], type: "url" },
    { id: "different", title: "其他网站", url: "https://b.test/docs", path: [], type: "url" },
  ];
  const page = await getCurrentPage(bookmarks);
  assert.equal(page.saved, true);
  assert.deepEqual(page.savedPaths, ["开发 / 文档"]);
  assert.deepEqual(page.related.map((bookmark) => bookmark.id), ["related"]);
  chrome.tabs.query = (_query, callback) => callback([{ url: "https://c.test/", title: "新页面" }]);
  const next = await getCurrentPage(bookmarks);
  assert.equal(next.saved, false);
  assert.deepEqual(next.savedPaths, []);
});

test("无法访问当前标签页信息时返回空状态，不继续显示旧页面", async () => {
  setupBrowser();
  chrome.tabs.query = (_query, callback) => callback([{ title: "无 URL 授权" }]);
  assert.equal(await getCurrentPage([]), null);
  chrome.tabs.query = (_query, callback) => { chrome.runtime.lastError = { message: "拒绝访问" }; callback([]); chrome.runtime.lastError = undefined; };
  assert.equal(await getCurrentPage([]), null);
});

test("本地文件之间不被标为同网站推荐", async () => {
  setupBrowser();
  chrome.tabs.query = (_query, callback) => callback([{ url: "file:///C:/example/a.html", title: "本地页面" }]);
  const page = await getCurrentPage([{ id: "b", url: "file:///C:/example/b.html", path: [], type: "url" }]);
  assert.deepEqual(page.related, []);
});
