import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
const { getHomeTasks, getOrganizeAction } = await loadService("src/app/services/homeTasks.ts");
const settings = { provider: { apiKey: "", enabled: false } };
test("恢复任务优先于 AI 配置入口", () => {
  assert.equal(getOrganizeAction(settings, { status: "running" }, false).label, "查看整理进度");
  assert.equal(getOrganizeAction(settings, null, true).label, "继续审核整理方案");
  assert.equal(getOrganizeAction(settings, { status: "failed" }, false).label, "查看失败原因");
  assert.equal(getOrganizeAction(settings, null, false).to, "/options");
});
test("归档去重、忽略手动项、排除不存在的推荐并按优先级排列", () => {
  const result = getHomeTasks({
    bookmarks: [{ id: "a", path: [], type: "url" }, { id: "b", path: [], type: "url" }],
    recommendations: [{ bookmarkId: "a" }, { bookmarkId: "a" }, { bookmarkId: "deleted" }],
    ignoredIds: ["b"], task: null, hasPreview: true, failedCount: 2, duplicateGroups: 3, linkProblems: 1,
  });
  assert.equal(result.pendingCount, 1);
  assert.deepEqual(result.tasks.map((item) => item.to), ["/preview", "/report", "/recommendations", "/manage?task=duplicate", "/manage?task=invalid"]);
});
