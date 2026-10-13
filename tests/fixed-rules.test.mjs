import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
import { setupBrowser } from "./browser-mock.mjs";
const rules = await loadService("src/app/services/fixedRules.ts");
test("固定规则仅匹配精确域名且可撤销", async () => {
  setupBrowser();
  const saved = await rules.saveFixedDomainRule("a.test", "target");
  assert.equal((await rules.matchFixedDomainRule("https://a.test/docs")).invalid, false);
  assert.equal(await rules.matchFixedDomainRule("https://sub.a.test/docs"), null);
  await rules.removeFixedDomainRule(saved[0].id);
  assert.equal(await rules.matchFixedDomainRule("https://a.test/docs"), null);
});
test("目标目录变化或受保护时不命中可执行规则", async () => {
  const mock = setupBrowser();
  await rules.saveFixedDomainRule("a.test", "target");
  mock.find("target").title = "已改名";
  assert.equal((await rules.matchFixedDomainRule("https://a.test/")).invalid, true);
  mock.find("target").title = "工具";
  mock.values["remarks.bookmarkWhitelist"] = [{ type: "folder", id: "target", addedAt: 1 }];
  assert.equal((await rules.matchFixedDomainRule("https://a.test/")).invalid, true);
});
test("明确规则生成推荐不调用 AI 且不移动书签", async () => {
  const mock = setupBrowser();
  await rules.saveFixedDomainRule("a.test", "target");
  const { createPendingRecommendation } = await loadService("src/app/services/organizer.ts");
  let fetchCount = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCount++; throw new Error("不应调用"); };
  try {
    const result = await createPendingRecommendation(mock.find("a"));
    assert.equal(result.kind, "move");
    assert.match(result.reason, /明确固定/);
    assert.equal(fetchCount, 0);
    assert.deepEqual(mock.moves, []);
  } finally { globalThis.fetch = previousFetch; }
});
test("收藏同一完整 URL 两次只创建一次", async () => {
  const mock = setupBrowser();
  const { saveCurrentPage } = await loadService("src/app/services/currentPage.ts");
  const first = await saveCurrentPage("新网页", "https://new.test/");
  const second = await saveCurrentPage("新网页", "https://new.test/");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
  assert.deepEqual(mock.moves, []);
});
