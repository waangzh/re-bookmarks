import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const first = await loadService("src/app/services/storage.ts", "page-a");
const second = await loadService("src/app/services/storage.ts", "page-b");
const fixedA = await loadService("src/app/services/fixedRules.ts", "fixed-a");
const fixedB = await loadService("src/app/services/fixedRules.ts", "fixed-b");
const recommendation = (id) => ({ id, bookmarkId: id, bookmarkTitle: id, suggestedFolderPath: ["开发"], confidence: 0.8 });

async function withSharedLocks(run) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  const queues = new Map();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (name, callback) => {
    const operation = (queues.get(name) ?? Promise.resolve()).then(callback);
    queues.set(name, operation.catch(() => undefined));
    return operation;
  } } });
  try { await run(); } finally { if (descriptor) Object.defineProperty(navigator, "locks", descriptor); else delete navigator.locks; }
}

test("两个独立模块同时新增建议保留双方结果", async () => {
  const mock = setupBrowser();
  const get = chrome.storage.local.get;
  chrome.storage.local.get = (key, callback) => get(key, (result) => setTimeout(() => callback(structuredClone(result)), 5));
  await withSharedLocks(async () => {
    await Promise.all([first.updatePendingRecommendations((items) => [...items, recommendation("a")]),
      second.updatePendingRecommendations((items) => [...items, recommendation("b")])]);
  });
  assert.deepEqual(mock.values["remarks.pendingRecommendations"].map((item) => item.id), ["a", "b"]);
});

test("忽略旧项与后台新增同时发生，不恢复旧项、不丢新项", async () => {
  const mock = setupBrowser();
  mock.values["remarks.pendingRecommendations"] = [recommendation("old")];
  await withSharedLocks(async () => {
    await Promise.all([first.updatePendingRecommendations((items) => items.filter((item) => item.id !== "old")),
      second.updatePendingRecommendations((items) => [...items, recommendation("new")])]);
  });
  assert.deepEqual(mock.values["remarks.pendingRecommendations"].map((item) => item.id), ["new"]);
});

test("推荐读取失败或格式损坏时禁止更新，并可在后续正常读取时重试", async () => {
  const mock = setupBrowser();
  mock.values["remarks.pendingRecommendations"] = [recommendation("preserve")];
  const originalGet = chrome.storage.local.get;
  chrome.storage.local.get = (_key, callback) => { chrome.runtime.lastError = { message: "暂时读取失败" }; callback({}); chrome.runtime.lastError = undefined; };
  await assert.rejects(first.updatePendingRecommendations(() => []), /读取待归档/);
  assert.equal(mock.values["remarks.pendingRecommendations"][0].id, "preserve");
  chrome.storage.local.get = originalGet;
  await first.updatePendingRecommendations((items) => [...items, recommendation("new")]);
  assert.equal(mock.values["remarks.pendingRecommendations"].length, 2);
  mock.values["remarks.pendingRecommendations"] = { invalid: true };
  await assert.rejects(first.updatePendingRecommendations(() => []), /格式异常/);
  assert.deepEqual(mock.values["remarks.pendingRecommendations"], { invalid: true });
});

test("两个页面同时新增固定规则不会覆盖彼此，删除也保留其他规则", async () => {
  const mock = setupBrowser();
  await withSharedLocks(async () => {
    await Promise.all([fixedA.saveFixedDomainRule("a.test", "source"), fixedB.saveFixedDomainRule("b.test", "target")]);
    assert.equal(mock.values["remarks.fixedDomainRules"].length, 2);
    assert.equal(new Set(mock.values["remarks.fixedDomainRules"].map((rule) => rule.id)).size, 2);
    const removed = mock.values["remarks.fixedDomainRules"].find((rule) => rule.domain === "a.test");
    await Promise.all([fixedA.removeFixedDomainRule(removed.id), fixedB.saveFixedDomainRule("c.test", "target")]);
  });
  assert.deepEqual(mock.values["remarks.fixedDomainRules"].map((rule) => rule.domain).sort(), ["b.test", "c.test"]);
});
