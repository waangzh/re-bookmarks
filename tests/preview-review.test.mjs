import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const { addBookmarkWhitelistEntry } = await loadService("src/app/services/whitelist.ts");

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
