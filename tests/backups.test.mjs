import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const { createManualBackup, restoreBackup, getBackupHistory } = await loadService("src/app/services/backups.ts");

test("安全恢复重建缺失书签、保留备份后新增项并迁移保护 ID", async () => {
  const mock = setupBrowser();
  const backup = await createManualBackup();
  mock.values["remarks.bookmarkWhitelist"] = [{ type: "bookmark", id: "a", addedAt: 1 }];
  mock.find("source").children = mock.find("source").children.filter((node) => node.id !== "a");
  mock.find("source").children.push({ id: "after", parentId: "source", title: "之后收藏", url: "https://new.test/" });
  const report = await restoreBackup(backup.id);
  assert.equal(report.failedItems.length, 0);
  assert.equal(report.recreatedCount, 1);
  const recreated = mock.find("source").children.find((node) => node.url === "https://a.test/");
  assert.ok(recreated);
  assert.ok(mock.find("after"));
  assert.equal(mock.values["remarks.bookmarkWhitelist"][0].id, recreated.id);
  assert.ok(mock.values["remarks.backupHistory"].some((entry) => entry.kind === "pre-restore"));
});

test("恢复前保护点无法写入时不改写书签树", async () => {
  const mock = setupBrowser();
  const backup = await createManualBackup();
  const tree = structuredClone(mock.tree);
  const before = structuredClone(tree);
  const failing = setupBrowser({ tree, failStorageKey: "remarks.backupHistory" });
  failing.values["remarks.backupHistory"] = [backup];
  await assert.rejects(restoreBackup(backup.id), /存储写入失败/);
  assert.deepEqual(failing.tree, before);
  assert.deepEqual(failing.moves, []);
});

test("旧 lastBackup 数据兼容迁移为历史记录，不丢树和计划", async () => {
  const mock = setupBrowser();
  mock.values["remarks.lastBackup"] = { id: "legacy", createdAt: 1, tree: structuredClone(mock.tree), movePlan: [{ bookmarkId: "a" }] };
  const history = await getBackupHistory();
  assert.equal(history[0].id, "legacy");
  assert.equal(history[0].kind, "organize");
  assert.equal(history[0].bookmarkCount, 2);
  assert.equal(history[0].movePlan[0].bookmarkId, "a");
  assert.ok(mock.values["remarks.backupHistory"]);
});
