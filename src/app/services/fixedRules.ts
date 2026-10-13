import type { FixedDomainRule } from "../types";
import { getAllBookmarkFolders } from "./bookmarks";
import { getStorageValue, setStorageValue, STORAGE_KEYS } from "./storage";
import { getCurrentWhitelist, isProtectedTargetPath } from "./whitelist";

export function getFixedDomainRules() { return getStorageValue<FixedDomainRule[]>(STORAGE_KEYS.fixedDomainRules, []); }
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
