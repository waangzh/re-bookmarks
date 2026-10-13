import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const preferences = await loadService("src/app/services/preferenceSafety.ts");
const organizer = await loadService("src/app/services/organizer.ts");
const recommendations = await loadService("src/app/services/recommendations.ts");
const plan = { bookmarkId: "a", bookmarkTitle: "中文资料", bookmarkUrl: "https://a.test/", fromParentId: "source",
  sourceFolderPath: ["开发", "资料"], toFolderPath: ["开发", "工具"], expectedTargetId: "target", confidence: 0.99, source: "ai" };
const rejection = { learning: { rejectedFolderPaths: [{ domain: "a.test", folderPath: ["开发", "工具"], count: 1 }] } };
const rule = { id: "rule", domain: "a.test", folderId: "source", folderPath: ["开发", "资料"], createdAt: 1 };
const rec = { id: "rec-a", bookmarkId: "a", bookmarkTitle: plan.bookmarkTitle, bookmarkUrl: plan.bookmarkUrl,
  currentFolderPath: plan.sourceFolderPath, suggestedFolderPath: plan.toFolderPath, sourceParentId: "source", expectedTargetId: "target",
  source: "ai", confidence: 0.99, kind: "move" };

test("推断习惯不升级为硬限制，明确拒绝或固定目录冲突才需单独审核", () => {
  assert.equal(preferences.getPreferenceConflict(plan, { learning: { domainPreferences: [{ domain: "a.test", folderPath: ["生活"], count: 30 }] } }), null);
  assert.match(preferences.getPreferenceConflict(plan, rejection), /明确拒绝/);
  assert.match(preferences.getPreferenceConflict(plan, null, [rule]), /固定/);
  assert.equal(preferences.getPreferenceConflict({ ...plan, source: "manual" }, rejection, [rule]), null);
});

test("偏好快照只包含相关域名和目标，无关变更不使旧审核失效", () => {
  const before = preferences.getPreferenceFingerprint(plan, null, []);
  assert.equal(preferences.getPreferenceFingerprint(plan, { learning: { rejectedFolderPaths: [{ folderPath: ["生活"] }] } }, [{ ...rule, domain: "other.test" }]), before);
  assert.notEqual(preferences.getPreferenceFingerprint(plan, rejection, []), before);
  assert.notEqual(preferences.getPreferenceFingerprint(plan, null, [rule]), before);
});

test("较强模型信号也不能绕过明确拒绝的逐项预览", async () => {
  const { buildPreviewRiskAnalysis } = await loadService("src/app/components/Preview.tsx");
  const bookmarks = [{ id: "a", path: plan.sourceFolderPath }, { id: "b", path: plan.toFolderPath }, { id: "c", path: plan.toFolderPath }];
  const result = buildPreviewRiskAnalysis([plan], bookmarks, rejection);
  assert.equal(result.auto.length, 0);
  assert.equal(result.review.length, 1);
  assert.match(result.review[0].reasons.join("；"), /明确拒绝/);
});

test("批准后相关规则变化停止执行，其他有效项继续移动", async () => {
  const mock = setupBrowser();
  const plans = [plan, { ...plan, bookmarkId: "b", bookmarkTitle: "工具文档", bookmarkUrl: "https://b.test/" }].map((item) =>
    ({ ...item, preferenceFingerprint: preferences.getPreferenceFingerprint(item, null, []) }));
  mock.values["remarks.fixedDomainRules"] = [rule];
  const report = await organizer.executeMovePlans(plans);
  assert.equal(report.movedCount, 1);
  assert.equal(report.failedItems.length, 1);
  assert.deepEqual(mock.moves, ["b"]);
});

test("推荐页刷新后冲突项不能批量接受，仍可单独明确确认", async () => {
  const mock = setupBrowser();
  mock.values["remarks.pendingRecommendations"] = [rec];
  mock.values["remarks.folderHabitProfile"] = rejection;
  const [current] = await recommendations.getActivePendingRecommendations();
  assert.equal(current.requiresIndividualReview, true);
  assert.equal(recommendations.isBatchSafeRecommendation(current), false);
  const report = await recommendations.acceptRecommendation(current);
  assert.equal(report.movedCount, 1);
});

test("删除无效推荐时，保留项的明确偏好审核标志仍然生效", async () => {
  const mock = setupBrowser();
  mock.values["remarks.pendingRecommendations"] = [rec, { ...rec, id: "deleted", bookmarkId: "missing" }];
  mock.values["remarks.folderHabitProfile"] = rejection;
  const current = await recommendations.getActivePendingRecommendations();
  assert.equal(current.length, 1);
  assert.equal(current[0].requiresIndividualReview, true);
});

test("画像失效后明确拒绝仍进入本地审核，读取失败不会降级成无规则", async () => {
  const mock = setupBrowser();
  mock.values["remarks.pendingRecommendations"] = [rec];
  mock.values["remarks.folderHabitProfile"] = { ...rejection, whitelistFingerprint: "older-protection" };
  const [current] = await recommendations.getActivePendingRecommendations();
  assert.equal(current.requiresIndividualReview, true);
  const originalGet = chrome.storage.local.get;
  chrome.storage.local.get = (key, callback) => {
    if (key === "remarks.fixedDomainRules") { chrome.runtime.lastError = { message: "读取失败" }; callback({}); chrome.runtime.lastError = undefined; }
    else originalGet(key, callback);
  };
  const report = await organizer.executeMovePlans([plan]);
  assert.equal(report.movedCount, 0);
  assert.match(report.failedItems[0].reason, /无法读取固定归档规则/);
  assert.deepEqual(mock.moves, []);
});
