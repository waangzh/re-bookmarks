import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
const { getPlanSummary, getPlanChangeReason, classificationPolicyFingerprint } = await loadService("src/app/services/previewSafety.ts");
const settings = { maxNestingLevel: 2, customPrompt: "原规则" };
const source = { id: "a", parentId: "f", title: "中文长标题", url: "https://a.test/?q=1", path: ["开发", "资料"] };
const plan = { bookmarkId: "a", bookmarkTitle: source.title, bookmarkUrl: source.url, fromParentId: "f", sourceFolderPath: source.path, toFolderPath: ["开发", "工具"], expectedTargetId: "target", policyFingerprint: classificationPolicyFingerprint(settings) };
const folders = [{ id: "target", path: plan.toFolderPath }];
test("源快照、目录身份与规则改变均使旧批准失效", () => {
  assert.equal(getPlanChangeReason(plan, source, folders, settings), null);
  for (const change of [{ title: "新标题" }, { url: "https://a.test/?q=2" }, { parentId: "other" }, { path: ["重命名"] }]) assert.ok(getPlanChangeReason(plan, { ...source, ...change }, folders, settings));
  assert.ok(getPlanChangeReason(plan, undefined, folders, settings));
  assert.ok(getPlanChangeReason(plan, source, [], settings));
  assert.ok(getPlanChangeReason(plan, source, [{ id: "target", path: ["改名"] }], settings));
  assert.ok(getPlanChangeReason(plan, source, folders, { ...settings, customPrompt: "新规则" }));
});
test("摘要按条目互斥统计，目录前缀去重，保持原位不进入变更清单", () => {
  const result = getPlanSummary([plan, plan, { ...plan, bookmarkId: "b", keepInPlace: true }], [source], [{ path: ["开发"] }]);
  assert.equal(result.total, 2);
  assert.equal(result.moveCount, 1);
  assert.equal(result.keepCount, 1);
  assert.deepEqual(result.newFolders, [["开发", "工具"]]);
});
test("风险分组不会因模型信号较强而整组批准疑似重复或跨一级目录", async () => {
  const { buildPreviewRiskAnalysis } = await loadService("src/app/components/Preview.tsx");
  const bookmarks = [source, { id: "b", path: ["开发", "工具"] }, { id: "c", path: ["开发", "工具"] }];
  const duplicate = { ...plan, confidence: 0.99, source: "ai", reason: "可能重复" };
  const cross = { ...duplicate, bookmarkId: "c", toFolderPath: ["生活"], reason: "分类" };
  const result = buildPreviewRiskAnalysis([duplicate, cross], bookmarks, null);
  assert.equal(result.auto.length, 0);
  assert.equal(result.review.length, 2);
});
