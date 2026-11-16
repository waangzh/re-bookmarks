import { Link } from "react-router";
import { Archive, ChevronRight, Copy, FileUp, FileText, History, Link2Off, Settings, Sparkles } from "lucide-react";
import { PageHeading } from "./PageHeading";

export function MoreTools() {
  const entries = [
    { to: "/manage?task=duplicate", label: "重复检测", icon: Copy },
    { to: "/manage?task=invalid", label: "失效检测", icon: Link2Off },
    { to: "/import", label: "导入书签", icon: FileUp },
    { to: "/backups", label: "书签备份", icon: Archive },
    { to: "/report", label: "整理报告", icon: FileText },
    { to: "/habits", label: "分类偏好", icon: Sparkles },
    { to: "/history", label: "常访问书签", icon: History },
    { to: "/options", label: "设置与 AI 服务", icon: Settings },
  ];
  return <main className="extension-page extension-page--tools">
    <div className="extension-page__inner">
      <header className="extension-page__header"><PageHeading title="更多工具" /></header>
      <nav className="remarks-tool-directory" aria-label="更多工具">
        {entries.map(({ to, label, icon: Icon }) => <Link key={to} to={to}><span className="remarks-tool-directory__icon"><Icon aria-hidden="true" /></span><span><strong>{label}</strong></span><ChevronRight aria-hidden="true" /></Link>)}
      </nav>
    </div>
  </main>;
}
