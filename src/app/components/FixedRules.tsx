import { useEffect, useState } from "react";
import type { BookmarkNode, FixedDomainRule } from "../types";
import { getAllBookmarkFolders } from "../services/bookmarks";
import { getFixedDomainRules, removeFixedDomainRule, saveFixedDomainRule } from "../services/fixedRules";

export function FixedRules() {
  const [rules, setRules] = useState<FixedDomainRule[]>([]);
  const [folders, setFolders] = useState<BookmarkNode[]>([]);
  const [domain, setDomain] = useState("");
  const [folderId, setFolderId] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void Promise.all([getFixedDomainRules(), getAllBookmarkFolders()]).then(([stored, choices]) => { setRules(stored); setFolders(choices); }).catch(() => setNotice("固定规则加载失败，请重试")); }, []);
  const save = async () => {
    setBusy(true);
    try { setRules(await saveFixedDomainRule(domain, folderId)); setDomain(""); setNotice("规则已固定：同域名新书签会先生成本地建议，仍需确认与备份后移动"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  };
  return <section className="extension-section">
    <h2 className="extension-section__title">你明确固定的域名规则</h2>
    <p className="sidebar-muted-copy">仅匹配完整域名，不扩展到子域名。推断偏好不会自动变成固定规则。目录失效或受保护时保持待判断。</p>
    <label className="extension-field">域名<input className="extension-control" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="docs.example.com" /></label>
    <label className="extension-field">已有目录<select className="extension-control" value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">选择目录</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path.join(" / ")}</option>)}</select></label>
    <button type="button" className="extension-page__wide-secondary" disabled={busy || !domain || !folderId} onClick={() => void save()}>固定这条规则</button>
    {rules.map((rule) => <div key={rule.id} className="extension-compact-row"><span>{rule.domain} → {rule.folderPath.join(" / ")}</span><button type="button" disabled={busy} onClick={() => { setBusy(true); void removeFixedDomainRule(rule.id).then(setRules).catch(() => setNotice("撤销失败，规则仍保留")).finally(() => setBusy(false)); }}>撤销规则</button></div>)}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
