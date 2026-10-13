import { updatePendingRecommendations } from "../src/app/services/storage";
import { saveFixedDomainRule } from "../src/app/services/fixedRules";

// 只打包到隔离测试 XPI 的额外页面，不进入生产构建。
export async function appendRecommendations(nodes: Array<{ id: string; title: string; url: string }>, folderId: string) {
  for (const node of nodes) await updatePendingRecommendations((items) => [...items.filter((item) => item.bookmarkId !== node.id), {
    id: "concurrency-" + node.id, bookmarkId: node.id, bookmarkTitle: node.title, bookmarkUrl: node.url,
    suggestedFolderPath: ["测试"], createdAt: Date.now(), confidence: 0.8, sourceParentId: folderId,
  }]);
  return nodes.length;
}

export async function addRules(domainPrefix: string, folderId: string) {
  for (let index = 0; index < 5; index++) await saveFixedDomainRule(`${domainPrefix}${index}.invalid`, folderId);
  return 5;
}
