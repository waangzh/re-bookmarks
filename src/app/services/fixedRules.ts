import type { FixedDomainRule } from "../types";
import { getAllBookmarkFolders } from "./bookmarks";
import { setStorageValue, STORAGE_KEYS } from "./storage";
import { getCurrentWhitelist, isProtectedTargetPath } from "./whitelist";

export async function getFixedDomainRules(): Promise<FixedDomainRule[]> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  return new Promise((resolve, reject) => chrome.storage.local.get(STORAGE_KEYS.fixedDomainRules, (result) => {
    if (chrome.runtime.lastError) { reject(new Error("无法读取固定归档规则，请重试")); return; }
    const value: unknown = result[STORAGE_KEYS.fixedDomainRules];
    if (value === undefined) { resolve([]); return; }
    if (!Array.isArray(value) || !value.every((entry) => entry && typeof entry === "object" &&
      typeof entry.id === "string" && typeof entry.domain === "string" && typeof entry.folderId === "string" &&
      Array.isArray(entry.folderPath) && entry.folderPath.length && entry.folderPath.every((part: unknown) => typeof part === "string") &&
      typeof entry.createdAt === "number")) { reject(new Error("固定归档规则格式异常，请检查分类偏好")); return; }
    resolve(value as FixedDomainRule[]);
  }));
}
export function normalizeRuleDomain(value: string) {
  try {
    const url = new URL(value.includes("://") ? value : "https://" + value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.hostname.toLowerCase();
  } catch { throw new Error("请输入完整域名，例如 docs.example.com；不含路径或参数"); }
}
export async function saveFixedDomainRule(domainInput: string, folderId: string) {
  const domain = normalizeRuleDomain(domainInput);
  const folders = await getAllBookmarkFolders();
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) throw new Error("请选择现有目录");
  const protection = await getCurrentWhitelist();
  if (isProtectedTargetPath(folder.path, protection.tree, protection.index)) throw new Error("不能将规则指向受保护目录");
  const rules = await getFixedDomainRules();
  const next = [...rules.filter((rule) => rule.domain !== domain), { id: "fixed-" + Date.now(), domain, folderId, folderPath: folder.path, createdAt: Date.now() }];
  await setStorageValue(STORAGE_KEYS.fixedDomainRules, next);
  return next;
}
export async function removeFixedDomainRule(id: string) {
  const next = (await getFixedDomainRules()).filter((rule) => rule.id !== id);
  await setStorageValue(STORAGE_KEYS.fixedDomainRules, next);
  return next;
}
export async function matchFixedDomainRule(url: string) {
  let domain: string;
  try { domain = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const rules = (await getFixedDomainRules()).filter((rule) => rule.domain === domain);
  if (rules.length !== 1) return null;
  const rule = rules[0];
  const folders = await getAllBookmarkFolders();
  const target = folders.find((folder) => folder.id === rule.folderId && JSON.stringify(folder.path) === JSON.stringify(rule.folderPath));
  const protection = await getCurrentWhitelist();
  if (!target || isProtectedTargetPath(target.path, protection.tree, protection.index)) return { invalid: true as const, rule };
  return { invalid: false as const, rule };
}
