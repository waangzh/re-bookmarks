import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const { addBookmarkWhitelistEntry } = await loadService("src/app/services/whitelist.ts");
const { buildPreviewRiskAnalysis, derivePreviewReview } = await loadService("src/app/services/previewReview.ts");

const source = { id: "a", title: "中文资料", parentId: "source", url: "https://a.test/", path: ["开发", "资料"] };
const bookmarks = [source, { ...source, id: "b", path: ["开发", "工具"] }, { ...source, id: "c", path: ["开发", "工具"] }];
const plan = { bookmarkId: "a", bookmarkTitle: source.title, bookmarkUrl: source.url, fromParentId: "source",
  sourceFolderPath: source.path, toFolderPath: ["开发", "工具"], confidence: 0.95, source: "ai", reason: "技术资料" };

test("低依据与清理提示默认保留，旧批准不能将其加入实际移动", () => {
  for (const change of [{ confidence: 0.54 }, { confidence: NaN }, { reason: "可能重复" }, { reason: "疑似失效链接" }, { keepInPlace: true }]) {
    const analysis = buildPreviewRiskAnalysis([{ ...plan, ...change }], bookmarks, null);
    const review = derivePreviewReview(analysis, { a: "move" }, {});
    assert.equal(review.keepCount, 1);
    assert.equal(review.pending.length, 0);
    assert.equal(review.approvedPlans.length, 0);
  }
});

test("跨一级目录即便人工修改或高模型信号，也须逐条批准", () => {
  for (const source of ["ai", "manual"]) {
    const analysis = buildPreviewRiskAnalysis([{ ...plan, source, toFolderPath: ["生活"] }], bookmarks, null);
    assert.equal(analysis.auto.length, 0);
    assert.equal(analysis.batchGroups.length, 0);
    const key = analysis.frameworkGroups[0].key;
    const review = derivePreviewReview(analysis, {}, { [key]: "approve" });
    assert.equal(review.pending.length, 1);
    assert.equal(review.approvedPlans.length, 0);
    assert.equal(derivePreviewReview(analysis, { a: "move" }, { [key]: "approve" }).approvedPlans.length, 1);
  }
});

test("采用目录只确认结构，拒绝目录覆盖旧移动决定", () => {
  const analysis = buildPreviewRiskAnalysis([{ ...plan, toFolderPath: ["新目录"] }], bookmarks, null);
  const key = analysis.frameworkGroups[0].key;
  assert.equal(derivePreviewReview(analysis, {}, {}).pendingFrameworks.length, 1);
  assert.equal(derivePreviewReview(analysis, {}, { [key]: "approve" }).pending.length, 1);
  const rejected = derivePreviewReview(analysis, { a: "move" }, { [key]: "keep" });
  assert.equal(rejected.keepCount, 1);
  assert.equal(rejected.approvedPlans.length, 0);
  assert.equal(rejected.pending.length, 0);
});

test("互斥计数只包含有效去重书签，默认规则与待审及保留不重叠", () => {
  const analysis = buildPreviewRiskAnalysis([
    plan, plan, { ...plan, bookmarkId: "b", confidence: 0.8, toFolderPath: ["开发", "资料"] },
    { ...plan, bookmarkId: "c", keepInPlace: true }, { ...plan, bookmarkId: "missing" },
  ], bookmarks, null);
  const review = derivePreviewReview(analysis, {}, {});
  assert.equal(review.total, 3);
  assert.equal(review.approvedPlans.length, 1);
  assert.equal(review.keepCount, 1);
  assert.equal(review.pending.length, 1);
  assert.equal(review.approvedPlans.length + review.keepCount + review.pending.length, review.total);
});

test("空目录参与已有结构判定，手动改目标须重新决定", () => {
  const analysis = buildPreviewRiskAnalysis([{ ...plan, source: "manual", toFolderPath: ["工作", "新资料"] }],
    bookmarks, null, [], null, [{ id: "empty", path: ["工作", "新资料"] }]);
  assert.equal(analysis.frameworkGroups.length, 0);
  assert.equal(analysis.auto.length, 0);
  assert.equal(derivePreviewReview(analysis, {}, {}).pending.length, 1);
});

test("新增保护保留无影响预览及已完成任务，只让受影响项保持原位", async () => {
  const mock = setupBrowser();
  const plans = ["a", "b"].map((id) => ({ bookmarkId: id, toFolderPath: ["开发", "工具"], keepInPlace: false }));
  mock.values["remarks.previewPlan"] = { id: "preview", whitelistFingerprint: "", movePlan: plans };
  mock.values["remarks.previewTask"] = { id: "task", status: "completed", whitelistFingerprint: "", movePlan: plans };
  await addBookmarkWhitelistEntry("bookmark", "a");
  const cache = mock.values["remarks.previewPlan"];
  assert.equal(cache.id, "preview");
  assert.equal(cache.movePlan[0].keepInPlace, true);
  assert.equal(cache.movePlan[1].keepInPlace, false);
  assert.equal(mock.values["remarks.previewTask"].status, "completed");
});
