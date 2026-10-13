import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const service = await loadService("src/app/services/recommendations.ts");
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
  mock.find("a").parentId = "target";
  const report = await service.acceptRecommendation(recommendation("a", "中文资料"));
  assert.equal(report.movedCount, 0);
  assert.equal(report.failedItems.length, 1);
  assert.deepEqual(mock.moves, []);
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
