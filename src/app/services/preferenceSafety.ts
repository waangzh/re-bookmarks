import type { FixedDomainRule, FolderHabitProfile, MovePlan } from "../types";
import { getDomain } from "./rules";

type Candidate = Pick<MovePlan, "bookmarkUrl" | "source" | "toFolderPath" | "expectedTargetId">;
const pathKey = (path: string[]) => JSON.stringify(path.map((part) => part.trim()).filter(Boolean));

function relevantPreferences(plan: Candidate, profile: FolderHabitProfile | null, rules: FixedDomainRule[]) {
  let hostname = "";
  try { hostname = new URL(plan.bookmarkUrl ?? "").hostname.toLowerCase(); } catch { /* 无法匹配域名 */ }
  const domain = getDomain(plan.bookmarkUrl ?? "").toLowerCase();
  return {
    fixed: rules.filter((rule) => rule.domain === hostname),
    rejected: (profile?.learning?.rejectedFolderPaths ?? []).filter((rule) =>
      pathKey(rule.folderPath) === pathKey(plan.toFolderPath) &&
      (!rule.domain || rule.domain === domain) && (!rule.isNewFolder || !plan.expectedTargetId)),
  };
}

export function getPreferenceConflict(plan: Candidate, profile: FolderHabitProfile | null, rules: FixedDomainRule[] = []) {
  if (plan.source === "manual") return null;
  const relevant = relevantPreferences(plan, profile, rules);
  if (relevant.fixed.some((rule) => pathKey(rule.folderPath) !== pathKey(plan.toFolderPath) ||
    (plan.expectedTargetId && plan.expectedTargetId !== rule.folderId))) return "与用户明确固定的域名规则冲突，需要单独确认";
  if (relevant.rejected.length) return "该分类曾被你明确拒绝，需要单独确认";
  return null;
}

export function getPreferenceFingerprint(plan: Candidate, profile: FolderHabitProfile | null, rules: FixedDomainRule[]) {
  const relevant = relevantPreferences(plan, profile, rules);
  return JSON.stringify({
    fixed: relevant.fixed.map((rule) => JSON.stringify([rule.domain, rule.folderId, rule.folderPath])).sort(),
    rejected: [...new Set(relevant.rejected.map((rule) => JSON.stringify([rule.domain ?? "", Boolean(rule.isNewFolder), rule.folderPath])))].sort(),
  });
}
