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
  assert.deepEqual(result.tasks.map((item) => item.to), ["/preview", "/report", "/manage?task=unsorted", "/manage?task=duplicate", "/manage?task=invalid"]);
});

test("进行中任务保持主操作，归档和异常保留为其它待办", () => {
  const result = getHomeTasks({ bookmarks: [{ id: "a", path: [], type: "url" }], recommendations: [], ignoredIds: [], task: { status: "running" }, hasPreview: true, failedCount: 1, duplicateGroups: 2, linkProblems: 3 });
  assert.equal(result.tasks[0].kind, "running");
  assert.equal(result.tasks[0].to, "/preview");
  assert.equal(result.tasks.find(task => task.kind === "report").count, 1);
  assert.equal(result.tasks.find(task => task.kind === "links").count, 3);
});

test("未检测或无异常不生成链接任务，异常候选不声称已确认失效", () => {
  const input = { bookmarks: [], recommendations: [], ignoredIds: [], task: null, hasPreview: false, failedCount: 0, duplicateGroups: 0, linkProblems: 0 };
  assert.equal(getHomeTasks(input).tasks.length, 0);
  const [task] = getHomeTasks({ ...input, linkProblems: 2 }).tasks;
  assert.equal(task.to, "/manage?task=invalid");
  assert.match(task.description, /暂时无法访问/);
  assert.doesNotMatch(task.title, /已失效/);
});
