import { Link } from "react-router";
import { Archive, FileUp, FileText, History, Settings, Sparkles } from "lucide-react";

export function MoreTools() {
  const entries = [
    { to: "/habits", label: "分类偏好", icon: Sparkles },
    { to: "/backups", label: "备份与安全恢复", icon: Archive },
    { to: "/import", label: "导入书签", icon: FileUp },
    { to: "/history", label: "常访问书签", icon: History },
    { to: "/report", label: "历史整理报告", icon: FileText },
    { to: "/options", label: "设置与 AI 服务", icon: Settings },
  ];
  return <main className="sidebar-home">
    <header className="home-heading"><Link to="/">返回首页</Link><h1>更多工具</h1></header>
    <nav className="sidebar-entry-list" aria-label="更多工具">
      {entries.map(({ to, label, icon: Icon }) => <Link key={to} to={to} className="sidebar-entry-row"><Icon className="w-4 h-4" /><span>{label}</span></Link>)}
    </nav>
  </main>;
}
