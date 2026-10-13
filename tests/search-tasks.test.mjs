import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
const { getHomeTasks } = await loadService("src/app/services/homeTasks.ts");
test("任务状态保留明确语义并将疑似问题单独列为复查", () => {
  const result = getHomeTasks({ bookmarks: [{ id: "a", path: ["开发"], type: "url" }], recommendations: [], ignoredIds: [], task: { status: "failed" }, hasPreview: false, failedCount: 0, duplicateGroups: 0, linkProblems: 2 });
  assert.equal(result.tasks[0].to, "/preview");
  assert.match(result.tasks.at(-1).label, /复查/);
});
