import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const { executeMovePlans } = await loadService("src/app/services/organizer.ts");
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
