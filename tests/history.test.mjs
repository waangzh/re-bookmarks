import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";

const { calculateFrequentBookmarkScore, getFrequentBookmarks, normalizeHistoryMatchUrl } =
  await loadService("src/app/services/history.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

test("Frecency 综合频次与时间衰减排序，近期活跃书签优先于陈旧高频书签", async () => {
  const now = 1_760_000_000_000;
  const bookmark = (id, title, url) => ({ id, parentId: "dev", title, url, index: 0 });
  setupBrowser({
    tree: [{
      id: "0",
      title: "",
      children: [{
        id: "root",
        parentId: "0",
        title: "书签栏",
        children: [{
          id: "dev",
          parentId: "root",
          title: "开发",
          children: [
            bookmark("stale", "陈旧高频", "https://stale.test/docs"),
            bookmark("recent", "近期常用", "https://recent.test/app"),
            bookmark("single", "今日单次", "https://single.test/note"),
            bookmark("biweekly", "两周高频", "https://biweekly.test/ref"),
          ],
        }],
      }],
    }],
  });

  chrome.history = {
    search: (query, callback) => {
      assert.equal(query.startTime, now - 90 * DAY_MS);
      callback([
        { url: "https://stale.test/docs", visitCount: 500, lastVisitTime: now - 60 * DAY_MS },
        { url: "https://recent.test/app?utm_source=share", visitCount: 10, lastVisitTime: now - 1 * DAY_MS },
        { url: "https://recent.test/app/#section", visitCount: 5, lastVisitTime: now },
        { url: "https://biweekly.test/ref", visitCount: 20, lastVisitTime: now - 14 * DAY_MS },
        { url: "https://single.test/note", visitCount: 1, lastVisitTime: now },
        { url: "https://unbookmarked.test/", visitCount: 999, lastVisitTime: now },
      ]);
    },
  };

  const results = await getFrequentBookmarks(now);
  assert.deepEqual(
    results.map((item) => item.id),
    ["recent", "biweekly", "single", "stale"]
  );
  assert.equal(results[0].visitCount, 15);
  assert.equal(results[0].lastVisit, now);
  assert.equal(results[0].currentFolder, "开发");
});

test("URL 匹配优先保留路径和锚点，只在宽松候选唯一时归因", async () => {
  const now = 1_760_000_000_000;
  const documents = [
    ["file", "https://docs.test/docs"],
    ["directory", "https://docs.test/docs/"],
    ["section-a", "https://docs.test/guide#a"],
    ["section-b", "https://docs.test/guide#b"],
    ["unique", "https://docs.test/about"],
  ].map(([id, url]) => ({ id, url, title: id, parentId: "root" }));

  for (const children of [documents, [...documents].reverse()]) {
    setupBrowser({ tree: [{ id: "0", title: "", children: [{ id: "root", title: "书签栏", children }] }] });
    chrome.history = {
      search: (_query, callback) => callback([
        { url: "https://docs.test/docs?utm_source=share", visitCount: 4, lastVisitTime: now },
        { url: "https://docs.test/docs/", visitCount: 3, lastVisitTime: now },
        { url: "https://docs.test/docs#ambiguous", visitCount: 99, lastVisitTime: now },
        { url: "https://docs.test/guide?gclid=tracking#a", visitCount: 2, lastVisitTime: now },
        { url: "https://docs.test/about/#intro", visitCount: 1, lastVisitTime: now },
      ]),
    };
    assert.deepEqual((await getFrequentBookmarks(now)).map(({ id, visitCount }) => [id, visitCount]), [
      ["file", 4], ["directory", 3], ["section-a", 2], ["unique", 1],
    ]);
  }
});

test("缺少时间戳或出现边界值时安全计算得分，且结果上限为 20 条", async () => {
  const now = 1_760_000_000_000;
  assert.equal(calculateFrequentBookmarkScore(0, now, now), 0);
  assert.equal(calculateFrequentBookmarkScore(-5, now, now), 0);
  assert.equal(calculateFrequentBookmarkScore(Number.NaN, now, now), 0);
  assert.equal(calculateFrequentBookmarkScore(10, 0, now), 0);
  assert.equal(
    calculateFrequentBookmarkScore(10, now + 5 * DAY_MS, now),
    calculateFrequentBookmarkScore(10, now, now)
  );

  const children = Array.from({ length: 25 }, (_, index) => ({
    id: `b-${index}`,
    parentId: "root",
    title: `书签 ${index}`,
    url: `https://site-${index}.test/`,
    index,
  }));
  setupBrowser({
    tree: [{ id: "0", title: "", children: [{ id: "root", parentId: "0", title: "书签栏", children }] }],
  });

  chrome.history = {
    search: (_query, callback) => {
      callback([
        ...children.map((item, index) => ({
          url: item.url,
          visitCount: index + 1,
          lastVisitTime: now - index * DAY_MS,
        })),
        { url: "https://site-0.test/", visitCount: 0, lastVisitTime: now },
      ]);
    },
  };

  const results = await getFrequentBookmarks(now);
  assert.equal(results.length, 20);
  const scores = results.map((item) =>
    calculateFrequentBookmarkScore(item.visitCount, item.lastVisit, now)
  );
  for (let index = 1; index < scores.length; index++) {
    assert.ok(scores[index - 1] >= scores[index]);
  }
  assert.ok(results.every((item) => item.visitCount > 0));
});

test("无 history API 或发生 runtime.lastError 时返回空数组", async () => {
  setupBrowser();
  delete chrome.history;
  assert.deepEqual(await getFrequentBookmarks(), []);

  chrome.history = {
    search: (_query, callback) => {
      chrome.runtime.lastError = { message: "history unavailable" };
      callback([]);
      chrome.runtime.lastError = undefined;
    },
  };
  assert.deepEqual(await getFrequentBookmarks(), []);
});

test("URL 清洗保留语义 query 与路由 hash，剥离追踪参数、普通锚点与末尾斜杠", async () => {
  assert.equal(
    normalizeHistoryMatchUrl("https://Video.test/watch/?v=abc&utm_source=share&b=2&a=1#t=10"),
    "https://video.test/watch?a=1&b=2&v=abc"
  );
  assert.equal(
    normalizeHistoryMatchUrl("https://spa.test/#/projects/alpha?utm_medium=email"),
    "https://spa.test/#/projects/alpha?utm_medium=email"
  );
  assert.equal(
    normalizeHistoryMatchUrl("https://docs.test/guide/#:~:text=hello"),
    "https://docs.test/guide"
  );

  const now = 1_760_000_000_000;
  setupBrowser({
    tree: [{
      id: "0",
      title: "",
      children: [{
        id: "root",
        parentId: "0",
        title: "书签栏",
        children: [
          { id: "v1", parentId: "root", title: "视频 A", url: "https://video.test/watch?v=aaa", index: 0 },
          { id: "v2", parentId: "root", title: "视频 B", url: "https://video.test/watch?v=bbb", index: 1 },
          { id: "spa-a", parentId: "root", title: "面板 A", url: "https://spa.test/#/a", index: 2 },
          { id: "spa-b", parentId: "root", title: "面板 B", url: "https://spa.test/#/b", index: 3 },
        ],
      }],
    }],
  });

  chrome.history = {
    search: (_query, callback) => {
      callback([
        { url: "https://video.test/watch?v=aaa&utm_campaign=spring#comments", visitCount: 4, lastVisitTime: now },
        { url: "https://video.test/watch?v=bbb", visitCount: 2, lastVisitTime: now },
        { url: "https://video.test/watch?v=ccc", visitCount: 99, lastVisitTime: now },
        { url: "https://spa.test/#/b", visitCount: 6, lastVisitTime: now },
        { url: "https://spa.test/#section", visitCount: 50, lastVisitTime: now },
      ]);
    },
  };

  const results = await getFrequentBookmarks(now);
  assert.deepEqual(
    results.map((item) => ({ id: item.id, visitCount: item.visitCount })),
    [
      { id: "spa-b", visitCount: 6 },
      { id: "v1", visitCount: 4 },
      { id: "v2", visitCount: 2 },
    ]
  );
});
