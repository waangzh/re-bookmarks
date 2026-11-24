import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const service = await loadService("src/app/services/recommendations.ts");
const organizer = await loadService("src/app/services/organizer.ts");
const { useAppStore } = await loadService("src/app/store/useAppStore.ts");
const pendingKey = "remarks.pendingRecommendations";
const recommendation = (id, title) => ({ id: "rec-" + id, bookmarkId: id, bookmarkTitle: title, bookmarkUrl: `https://${id}.test/`,
  sourceParentId: "source", currentFolderPath: ["开发", "资料"], suggestedFolderPath: ["开发", "工具"],
  expectedTargetId: "target", confidence: 0.8, kind: "move", source: "ai", createdAt: 1 });

test("批量候选排除跨一级目录、弱依据、重复、新目录、错误及未知旧快照", () => {
  const good = recommendation("a", "中文资料");
  assert.equal(service.isBatchSafeRecommendation(good), true);
  for (const change of [{ suggestedFolderPath: ["生活"] }, { confidence: 0.6 }, { reason: "可能重复" }, { kind: "create_folder" },
    { kind: "error" }, { sourceParentId: undefined }, { expectedTargetId: undefined }]) {
    assert.equal(service.isBatchSafeRecommendation({ ...good, ...change }), false);
  }
});

test("服务拒绝混入未单独确认的批量项，且不创建备份或移动", async () => {
  const mock = setupBrowser();
  const good = recommendation("a", "中文资料");
  await assert.rejects(service.acceptRecommendations([good, { ...recommendation("b", "工具文档"), confidence: 0.6 }]), /逐条确认/);
  assert.deepEqual(mock.moves, []);
  assert.equal(mock.values["remarks.lastBackup"], undefined);
});

test("AI 未配置的失败建议可直接指定现有目录，并经备份确认归档", async () => {
  const mock = setupBrowser();
  mock.values["remarks.pendingRecommendations"] = [{ ...recommendation("a", "中文资料"), kind: "error", errorCode: "missing_api_key", suggestedFolderPath: [] }];
  const saved = await service.updateRecommendationFolderPath("rec-a", ["开发", "工具"]);
  assert.equal(saved[0].source, "manual");
  assert.equal(saved[0].expectedTargetId, "target");
  assert.equal(service.getRecommendationSignalLabel(saved[0]), "你已指定");
  const report = await service.acceptRecommendation(saved[0]);
  assert.equal(report.movedCount, 1);
  assert.ok(mock.values["remarks.lastBackup"].tree.length);
  assert.deepEqual(mock.values["remarks.pendingRecommendations"], []);
});

test("书签离开生成建议时的源目录后旧建议不执行", async () => {
  const mock = setupBrowser();
  const old = recommendation("a", "中文资料");
  mock.values[pendingKey] = [old];
  await new Promise((resolve) => chrome.bookmarks.move("a", { parentId: "target" }, resolve));
  mock.moves.length = 0;

  await assert.rejects(service.acceptRecommendation(old), /建议已失效/);
  assert.deepEqual(mock.values[pendingKey], []);
  assert.equal(mock.values["remarks.lastBackup"], undefined);
  assert.deepEqual(mock.moves, []);
});

test("同一书签只保留最新有效建议，已替换的卡片不会生成失败报告", async () => {
  const mock = setupBrowser();
  const old = recommendation("a", "中文资料");
  const current = { ...old, id: "rec-new-a", createdAt: 2 };
  mock.values[pendingKey] = [old, current];

  const [visible] = await service.getActivePendingRecommendations();
  assert.deepEqual(mock.values[pendingKey], [current]);
  await assert.rejects(service.acceptRecommendation(old), /建议已失效/);
  assert.equal(mock.values["remarks.lastBackup"], undefined);
  const report = await service.acceptRecommendation(visible);
  assert.equal(report.movedCount, 1);
  assert.deepEqual(mock.values[pendingKey], []);
});

test("同一网址的两个独立书签仍可分别归档", async () => {
  const mock = setupBrowser();
  const first = recommendation("a", "中文资料");
  mock.find("b").url = first.bookmarkUrl;
  const second = { ...recommendation("b", "工具文档"), bookmarkUrl: first.bookmarkUrl };
  mock.values[pendingKey] = [first, second];

  assert.equal((await service.acceptRecommendation(first)).movedCount, 1);
  assert.equal((await service.acceptRecommendation(second)).movedCount, 1);
  assert.deepEqual(mock.moves, ["a", "b"]);
});

test("被另一页面改过的建议需要重新审核，批量归档继续处理其余有效建议", async () => {
  const mock = setupBrowser();
  const old = recommendation("a", "中文资料");
  const other = recommendation("b", "工具文档");
  mock.values[pendingKey] = [old, other];
  await service.updateRecommendationFolderPath(old.id, ["开发"]);

  await assert.rejects(service.acceptRecommendation(old), /建议已失效或已更新/);
  assert.deepEqual(mock.moves, []);
  assert.equal(mock.values["remarks.lastBackup"], undefined);
  const report = await service.acceptRecommendations([old, other]);
  assert.equal(report.movePlan.length, 1);
  assert.deepEqual(mock.moves, ["b"]);
  assert.deepEqual(mock.values[pendingKey].map(({ id }) => id), [old.id]);
});

test("取消收藏清掉旧建议，同一网址在另一个目录重新收藏时保留新建议", async () => {
  const mock = setupBrowser();
  const bookmark = { ...mock.find("a") };
  const { onCreated, onRemoved } = chrome.bookmarks;
  chrome.runtime.onMessage = { addListener() {} };
  globalThis.__REMARKS_BROWSER_TARGET__ = "chromium";
  await loadService("src/background/index.ts", "recommendation-events");
  const create = (node) => new Promise((resolve) => {
    chrome.runtime.sendMessage = resolve;
    onCreated.emit(node.id, node);
  });
  await create(bookmark);
  assert.deepEqual(mock.values[pendingKey].map(({ bookmarkId }) => bookmarkId), ["a"]);

  await new Promise((resolve) => chrome.bookmarks.remove("a", resolve));
  const set = chrome.storage.local.set;
  await new Promise((resolve) => {
    chrome.storage.local.set = (data, callback) => set(data, () => {
      callback();
      if (pendingKey in data) resolve();
    });
    onRemoved.emit(bookmark.id, { node: bookmark, parentId: bookmark.parentId });
  });
  assert.deepEqual(mock.values[pendingKey], []);

  const savedAgain = { ...bookmark, id: "new-a", parentId: "target" };
  mock.find("target").children.push(savedAgain);
  await create(savedAgain);
  assert.deepEqual(mock.values[pendingKey].map(({ bookmarkId, currentFolderPath }) => [bookmarkId, currentFolderPath]),
    [["new-a", ["开发", "工具"]]]);

  const additionalCopy = { ...bookmark, id: "another-a" };
  mock.find("source").children.push(additionalCopy);
  await create(additionalCopy);
  assert.deepEqual((await service.getActivePendingRecommendations()).map(({ bookmarkId }) => bookmarkId), ["another-a", "new-a"]);
});

test("书签在分类快照读取后被取消，迟到结果不会写回推荐队列", async () => {
  const mock = setupBrowser();
  const bookmark = { ...mock.find("a") };
  const get = chrome.bookmarks.get;
  let bookmarkReads = 0;
  let releaseSnapshot;
  const snapshotReady = new Promise((resolve) => {
    chrome.bookmarks.get = (id, callback) => get(id, (nodes) => {
      if (id === bookmark.id && ++bookmarkReads === 2) {
        releaseSnapshot = () => callback(nodes);
        resolve();
      } else {
        callback(nodes);
      }
    });
  });
  const recommendationWrites = [];
  const set = chrome.storage.local.set;
  chrome.storage.local.set = (data, callback) => {
    if (pendingKey in data) recommendationWrites.push(data[pendingKey]);
    set(data, callback);
  };
  const delayed = organizer.createPendingRecommendation(bookmark);
  await snapshotReady;
  await new Promise((resolve) => chrome.bookmarks.remove(bookmark.id, resolve));
  await service.removeRecommendationsForBookmark(bookmark.id);
  const savedAgain = { ...bookmark, id: "new-a", parentId: "target" };
  mock.find("target").children.push(savedAgain);
  assert.ok(await organizer.createPendingRecommendation(savedAgain));

  releaseSnapshot();
  assert.equal(await delayed, null);
  assert.deepEqual(mock.values[pendingKey].map(({ bookmarkId }) => bookmarkId), ["new-a"]);
  assert.ok(recommendationWrites.every((items) => items.every(({ bookmarkId }) => bookmarkId !== bookmark.id)));
});

test("取消收藏后，延迟返回的页面刷新不会恢复已清除的建议", async () => {
  const mock = setupBrowser();
  mock.values[pendingKey] = [recommendation("a", "中文资料")];
  const get = chrome.storage.local.get;
  let releasePreferences;
  const preferencesRequested = new Promise((resolve) => {
    chrome.storage.local.get = (key, callback) => get(key, (result) => {
      if (key === "remarks.folderHabitProfile" && !releasePreferences) {
        releasePreferences = () => callback(result);
        resolve();
      } else {
        callback(result);
      }
    });
  });
  const delayed = useAppStore.getState().loadAll();
  await preferencesRequested;
  await new Promise((resolve) => chrome.bookmarks.remove("a", resolve));
  await service.removeRecommendationsForBookmark("a");
  await useAppStore.getState().loadRecommendations();
  releasePreferences();
  await delayed;

  assert.deepEqual(mock.values[pendingKey], []);
  assert.deepEqual(useAppStore.getState().pendingRecommendations, []);
});

test("手动指定受保护源或目标时建议数据保持不变", async () => {
  for (const entry of [{ type: "folder", id: "target" }, { type: "bookmark", id: "a" }]) {
    const mock = setupBrowser();
    const original = [recommendation("a", "中文资料")];
    mock.values["remarks.pendingRecommendations"] = structuredClone(original);
    mock.values["remarks.bookmarkWhitelist"] = [{ ...entry, addedAt: 1 }];
    await assert.rejects(service.updateRecommendationFolderPath("rec-a", ["开发", "工具"]), /受保护/);
    assert.deepEqual(mock.values["remarks.pendingRecommendations"], original);
    assert.deepEqual(mock.moves, []);
  }
});
