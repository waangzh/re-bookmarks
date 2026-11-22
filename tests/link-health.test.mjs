import assert from "node:assert/strict";
import test from "node:test";
import { setupBrowser } from "./browser-mock.mjs";
import { loadService } from "./load-service.mjs";

const {
  checkBookmarkLinks, deleteLinkHealthBookmarks, getLinkHealthProblemResults,
  isSuggestedLinkHealthCleanup, recheckLinkHealthBookmark, NOT_FOUND_RECHECK_MINUTES,
} = await loadService("src/app/services/bookmarkTasks.ts");
const { STORAGE_KEYS, getBookmarkCheckIgnores, updateBookmarkCheckIgnores } = await loadService("src/app/services/storage.ts");
const ignoreKey = "linkHealthBookmarkIgnores";

function bookmark(mock, id) {
  return { ...mock.find(id), path: ["开发", "资料"], type: "url" };
}

function result(item, status = 404, extra = {}) {
  return {
    bookmarkId: item.id, bookmarkTitle: item.title, bookmarkUrl: item.url,
    status: "broken", httpStatus: status, checkedAt: Date.now(), checkedMethod: "GET", ...extra,
  };
}

function saveReport(mock, results, extra = {}) {
  const report = { id: "report-a", createdAt: 1, status: "completed", checkedCount: results.length,
    skippedCount: 0, invalidCount: results.length, results, ...extra };
  mock.values[STORAGE_KEYS.linkHealthReport] = report;
  return report;
}

test("HEAD 初筛和 GET 复核区分失效、限制、限流和跳转", async (context) => {
  const mock = setupBrowser();
  const source = mock.find("source");
  const responses = {
    a: { HEAD: 405, GET: 200 },
    b: { HEAD: 403, GET: 200 },
    legal: { HEAD: 451, GET: 451 },
    rate: { HEAD: 429 },
    missing: { HEAD: 404, GET: 404 },
    moved: { HEAD: 410, GET: 410 },
    landing: { HEAD: 200, GET: 200 },
    unauthorized: { HEAD: 401, GET: 401 },
  };
  for (const id of Object.keys(responses).slice(2)) source.children.push({ id, title: id, url: `https://${id}.test/`, parentId: "source" });
  const inputs = Object.keys(responses).map((id) => bookmark(mock, id));
  const calls = {};
  context.mock.method(globalThis, "fetch", async (url, options) => {
    const id = new URL(url).hostname.split(".")[0];
    (calls[id] ??= []).push(options.method);
    assert.equal(options.credentials, "omit");
    const response = { status: responses[id][options.method] };
    return ["landing", "moved"].includes(id) ? { ...response, redirected: true, url: "https://other.test/" } : response;
  });
  const report = await checkBookmarkLinks(inputs);
  const byId = Object.fromEntries(report.results.map((item) => [item.bookmarkId, item]));
  assert.deepEqual(calls.a, ["HEAD", "GET"]);
  assert.deepEqual(calls.b, ["HEAD", "GET"]);
  assert.deepEqual(calls.rate, ["HEAD"]);
  assert.equal(byId.a.status, "ok");
  assert.equal(byId.b.status, "ok");
  assert.equal(byId.legal.status, "restricted");
  assert.equal(byId.unauthorized.status, "restricted");
  assert.equal(byId.rate.status, "rate_limited");
  assert.equal(byId.missing.status, "broken");
  assert.equal(isSuggestedLinkHealthCleanup(byId.missing), false);
  assert.equal(byId.moved.finalUrl, "https://other.test/");
  assert.equal(isSuggestedLinkHealthCleanup(byId.moved), false);
  assert.deepEqual(calls.landing, ["HEAD", "GET"]);
  assert.equal(byId.landing.status, "suspicious");
});

test("网址变更后隐藏旧结果，续扫只复查原范围并按当前网址请求", async (context) => {
  const mock = setupBrowser();
  const old = result(bookmark(mock, "a"));
  const report = saveReport(mock, [old], { status: "running", bookmarkIds: ["a"] });
  mock.find("a").url = "https://new.test/";
  const inputs = [bookmark(mock, "a"), bookmark(mock, "b")];
  assert.deepEqual(getLinkHealthProblemResults(report, inputs), []);
  const probe = context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  const resumed = await checkBookmarkLinks(inputs, { initialReport: report });
  assert.equal(probe.mock.callCount(), 1);
  assert.equal(probe.mock.calls[0].arguments[0], inputs[0].url);
  assert.deepEqual(resumed.bookmarkIds, ["a"]);
  assert.equal(resumed.results[0].bookmarkUrl, inputs[0].url);
});

test("404 只在间隔达到要求的 GET 复测后列入清理建议", async (context) => {
  const mock = setupBrowser();
  globalThis.__REMARKS_BROWSER_TARGET__ = "chromium";
  context.after(() => { delete globalThis.__REMARKS_BROWSER_TARGET__; });
  const original = result(bookmark(mock, "a"));
  const report = saveReport(mock, [original]);
  let now = original.checkedAt + 1;
  context.mock.method(Date, "now", () => now);
  const fetch = context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  const early = (await recheckLinkHealthBookmark(report.id, original)).results[0];
  assert.equal(isSuggestedLinkHealthCleanup(early), false);
  now = original.checkedAt + NOT_FOUND_RECHECK_MINUTES * 60_000;
  const reviewed = (await recheckLinkHealthBookmark(report.id, early)).results[0];
  assert.equal(isSuggestedLinkHealthCleanup(reviewed), true);
  assert.deepEqual(fetch.mock.calls.map(({ arguments: args }) => args[1].method), ["GET", "GET"]);
  await assert.rejects(deleteLinkHealthBookmarks(report.id, [early]), /检测结果已更新/);
});

test("失效检测忽略独立保存，恢复后可重新显示旧报告", async () => {
  const mock = setupBrowser();
  const item = bookmark(mock, "a");
  const legacy = result(item, 451);
  const report = saveReport(mock, [legacy]);
  assert.equal(getLinkHealthProblemResults(report, [item])[0].status, "restricted");
  await updateBookmarkCheckIgnores(ignoreKey, [item], true);
  assert.deepEqual(getLinkHealthProblemResults(report, [{ ...item, path: ["新目录"] }], await getBookmarkCheckIgnores(ignoreKey)), []);
  assert.deepEqual(await getBookmarkCheckIgnores("duplicateBookmarkIgnores"), []);
  assert.equal(mock.values[STORAGE_KEYS.bookmarkWhitelist], undefined);
  await updateBookmarkCheckIgnores(ignoreKey, [item], false);
  assert.equal(getLinkHealthProblemResults(report, [item], await getBookmarkCheckIgnores(ignoreKey)).length, 1);
});

test("手动批量删除接受访问受限和首次 404，执行前仍校验备份和网址", async () => {
  const blocked = setupBrowser({ failStorageKey: STORAGE_KEYS.backupHistory });
  const candidate = result(bookmark(blocked, "a"));
  const report = saveReport(blocked, [candidate]);
  await assert.rejects(deleteLinkHealthBookmarks(report.id, [candidate]), /写入失败/);
  assert.ok(blocked.find("a"));

  const mock = setupBrowser();
  mock.find("source").children.push({ id: "missing", title: "首次 404", url: "https://missing.test/", parentId: "source" });
  const stale = result(bookmark(mock, "a"), 410);
  const restricted = result(bookmark(mock, "b"), 403, { status: "restricted" });
  const missing = result(bookmark(mock, "missing"));
  saveReport(mock, [stale, restricted, missing]);
  mock.find("a").url = "https://new.test/";
  const outcome = await deleteLinkHealthBookmarks(report.id, [stale, restricted, missing]);
  assert.deepEqual([...outcome.deletedIds], ["b", "missing"]);
  assert.match(outcome.failedItems[0], /网址已变化/);
  assert.ok(mock.find("a"));
  assert.equal(mock.find("b"), undefined);
  assert.equal(mock.find("missing"), undefined);
  assert.equal(mock.values[STORAGE_KEYS.backupHistory][0].kind, "invalid-delete");
});
