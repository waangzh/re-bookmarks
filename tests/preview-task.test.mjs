import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const { getPreviewTask, resumePreviewTask, requestClearPreviewTask, handlePreviewTaskMessage, PREVIEW_TASK_MESSAGE } = await loadService("src/app/services/previewTask.ts");
const task = (mode = "quick") => ({ id: "recovered", status: "running", createdAt: Date.now() - 2000, updatedAt: Date.now() - 1000,
  selectedBookmarkIds: ["a"], bookmarkCount: 1, organizeMode: mode, whitelistFingerprint: "", executionOwner: "background" });

test("过期后台任务保存失败原因，重开不显示假进度", async () => {
  const mock = setupBrowser();
  mock.values["remarks.previewTask"] = { ...task(), updatedAt: Date.now() - 31 * 60 * 1000 };
  const current = await getPreviewTask();
  assert.equal(current.status, "failed");
  assert.match(current.error, /超时/);
  assert.equal(mock.values["remarks.previewTask"].status, "failed");
});

test("深度任务采用自身超时边界，已完成结果不按运行超时丢弃", async () => {
  const mock = setupBrowser();
  mock.values["remarks.previewTask"] = { ...task("deep"), updatedAt: Date.now() - 40 * 60 * 1000 };
  assert.equal((await getPreviewTask()).status, "running");
  mock.values["remarks.previewTask"] = { ...task(), status: "completed", updatedAt: 1, movePlan: [{ bookmarkId: "a" }] };
  assert.equal((await getPreviewTask()).status, "completed");
});

test("恢复时后台消息失败不会擅自接管仍标为后台所有的任务", async () => {
  const mock = setupBrowser();
  mock.values["remarks.previewTask"] = task();
  chrome.runtime.sendMessage = (_message, callback) => { chrome.runtime.lastError = { message: "后台暂不可用" }; callback(); chrome.runtime.lastError = undefined; };
  const current = await resumePreviewTask(mock.values["remarks.previewTask"], [{ id: "a", type: "url" }]);
  assert.equal(current.executionOwner, "background");
  assert.equal(current.id, "recovered");
  assert.deepEqual(mock.moves, []);
});

test("取消任务时清理持久任务状态，不移动真实书签", async () => {
  const mock = setupBrowser();
  mock.values["remarks.previewTask"] = task();
  await requestClearPreviewTask();
  assert.equal(mock.values["remarks.previewTask"], undefined);
  assert.deepEqual(mock.moves, []);
});

test("恢复任务只向后台传递原选择，不能把页面全部书签当成任务范围", async () => {
  const mock = setupBrowser();
  mock.values["remarks.previewTask"] = task();
  let received;
  chrome.runtime.sendMessage = (message, callback) => { received = message; callback({ task: mock.values["remarks.previewTask"] }); };
  await resumePreviewTask(mock.values["remarks.previewTask"], [{ id: "a" }, { id: "b" }, { id: "new" }]);
  assert.deepEqual(received.bookmarks.map((bookmark) => bookmark.id), ["a"]);
});

test("原选择缺失时恢复为明确失败，不重新整理其他项目", async () => {
  const mock = setupBrowser();
  mock.values["remarks.previewTask"] = task();
  const current = await resumePreviewTask(mock.values["remarks.previewTask"], [{ id: "b" }]);
  assert.equal(current.status, "failed");
  assert.match(current.error, /未扩大/);
  assert.deepEqual(mock.moves, []);
});

test("后台入口也拒绝缺少原选择的恢复消息", async () => {
  const mock = setupBrowser();
  mock.values["remarks.previewTask"] = task();
  const current = await handlePreviewTaskMessage({ type: PREVIEW_TASK_MESSAGE, action: "run", taskId: "recovered", bookmarks: [{ id: "b" }] });
  assert.equal(current.status, "failed");
  assert.match(current.error, /未扩大/);
  assert.deepEqual(mock.moves, []);
});
