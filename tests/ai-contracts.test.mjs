import test from "node:test";
import assert from "node:assert/strict";
import { loadService } from "./load-service.mjs";
const { parseResults } = await loadService("src/app/services/aiProvider.ts");
const { toBookmarkForAI, sanitizeUrl, normalizeCategoryPath } = await loadService("src/app/services/rules.ts");

test("分类 schema 保留有效 ID、目录、模型信号与原因，拒绝缺 ID 和空目录", () => {
  const results = parseResults(JSON.stringify({ results: [
    { id: "a", categoryPath: ["开发", "文档"], confidence: 0.8, reason: "API 参考", decision: "existing_folder" },
    { categoryPath: ["开发"], confidence: 0.9 },
    { id: "empty", categoryPath: [], confidence: 0.9, decision: "existing_folder" },
    { id: "zero", categoryPath: ["开发"], confidence: 0 },
    { id: "negative", categoryPath: ["开发"], confidence: -1 },
  ] }));
  assert.deepEqual(results.map((item) => item.id), ["a"]);
  assert.deepEqual(results[0].categoryPath, ["开发", "文档"]);
  assert.equal(results[0].reason, "API 参考");
  assert.equal(results[0].source, "ai");
});

test("非法 JSON 与明确暂缓保留失败和 defer 语义", () => {
  assert.throws(() => parseResults("not-json"), /无法解析/);
  const [deferred] = parseResults(JSON.stringify({ results: [{ id: "a", decision: "defer", confidence: 0.5, reason: "依据不足" }] }));
  assert.equal(deferred.decision, "defer");
  assert.equal(deferred.reason, "依据不足");
});

test("AI 数据默认去掉 URL 查询与片段，不包含本地访问统计", () => {
  const bookmark = { id: "a", title: "文档", url: "https://docs.test/path?private=1#part", path: ["开发"], type: "url", visitCount: 5, lastVisit: 1 };
  const data = toBookmarkForAI(bookmark);
  assert.equal(data.sanitizedUrl, "https://docs.test/path");
  assert.equal("visitCount" in data, false);
  assert.equal("lastVisit" in data, false);
  assert.equal(sanitizeUrl(bookmark.url, true), bookmark.url);
  assert.deepEqual(normalizeCategoryPath(["开发", "文档", "细分"], true, 2), ["开发", "文档"]);
});
