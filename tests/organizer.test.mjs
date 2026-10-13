import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const { executeMovePlans, undoLastOrganize, reapplyLastOrganize } = await loadService("src/app/services/organizer.ts");
const plan = (id, title) => ({ bookmarkId: id, bookmarkTitle: title, bookmarkUrl: "https://" + id + ".test/", fromParentId: "source", sourceFolderPath: ["开发", "资料"], toFolderPath: ["开发", "工具"], expectedTargetId: "target", confidence: 0.9 });
test("关键备份失败时不执行书签写入", async () => {
  const mock = setupBrowser({ failBackup: true });
  await assert.rejects(executeMovePlans([plan("a", "中文资料")]), /备份写入失败/);
  assert.deepEqual(mock.moves, []);
});
test("单项失败不阻断其他项，重复执行不会再次移动", async () => {
  const mock = setupBrowser({ failMoveId: "a" });
  const plans = [plan("a", "中文资料"), plan("b", "工具文档")];
  const report = await executeMovePlans(plans);
  assert.equal(report.movedCount, 1);
  assert.equal(report.failedItems.length, 1);
  assert.deepEqual(mock.moves, ["b"]);
  const repeat = await executeMovePlans(plans);
  assert.equal(repeat.movedCount, 0);
  assert.deepEqual(mock.moves, ["b"]);
});
test("预览后外部修改与新增保护均保持原位并记录原因", async () => {
  const mock = setupBrowser();
  mock.find("a").url = "https://changed.test/";
  mock.values["remarks.bookmarkWhitelist"] = [{ type: "bookmark", id: "b", addedAt: 1 }];
  const report = await executeMovePlans([plan("a", "中文资料"), plan("b", "工具文档")]);
  assert.equal(report.movedCount, 0);
  assert.equal(report.failedItems.length, 2);
  assert.deepEqual(mock.moves, []);
});

test("撤销只处理实际移动项，不撤销保留项的后续人工移动", async () => {
  const mock = setupBrowser();
  await executeMovePlans([plan("a", "中文资料"), { ...plan("b", "工具文档"), keepInPlace: true }]);
  mock.find("source").children = [];
  const retained = mock.find("target").children[0];
  assert.equal(retained.id, "a");
  // 用户将保留项 b 移到别处，重新放入真实树模拟外部编辑。
  mock.find("target").children.push({ id: "b", parentId: "target", title: "工具文档", url: "https://b.test/" });
  const report = await undoLastOrganize();
  assert.equal(report.movedCount, 1);
  assert.equal(mock.find("a").parentId, "source");
  assert.equal(mock.find("b").parentId, "target");
});

test("撤销不覆盖后续改名且不清理无关空目录", async () => {
  const mock = setupBrowser();
  mock.find("dev").children.push({ id: "unrelated", parentId: "dev", title: "手动保留的空目录", children: [] });
  await executeMovePlans([plan("a", "中文资料")]);
  mock.find("a").title = "用户后续改名";
  const report = await undoLastOrganize();
  assert.equal(report.movedCount, 0);
  assert.equal(report.failedItems.length, 1);
  assert.equal(mock.find("a").title, "用户后续改名");
  assert.ok(mock.find("unrelated"));
});

test("重新应用接受已撤销的原目录身份变化，但拒绝无关位置和内容变化", async () => {
  const mock = setupBrowser();
  await executeMovePlans([plan("a", "中文资料"), plan("b", "工具文档")]);
  const undo = await undoLastOrganize();
  assert.equal(undo.movedCount, 2);
  mock.find("a").url = "https://user-modified.test/";
  const report = await reapplyLastOrganize();
  assert.equal(report.movedCount, 1);
  assert.equal(report.failedItems.length, 1);
  assert.equal(mock.find("a").url, "https://user-modified.test/");
  assert.equal(mock.find("b").parentId, "target");
});

test("移动后最终备份写失败，事前持久化的目标仍能支持安全撤销", async () => {
  const mock = setupBrowser({ failBackupAfter: 2 });
  await assert.rejects(executeMovePlans([plan("a", "中文资料")]), /备份写入失败/);
  assert.equal(mock.find("a").parentId, "target");
  assert.equal(mock.values["remarks.lastBackup"].movePlan[0].executionStatus, "pending");
  const undo = await undoLastOrganize();
  assert.equal(undo.movedCount, 1);
  assert.equal(mock.find("a").parentId, "source");
});
