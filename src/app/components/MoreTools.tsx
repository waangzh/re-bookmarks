import { Link } from "react-router";
import { Archive, ChevronRight, FileUp, FileText, History, Settings, Sparkles } from "lucide-react";
import { PageHeading } from "./PageHeading";

export function MoreTools() {
  const entries = [
    { to: "/report", label: "整理报告", description: "查看实际变更、失败项与撤销记录", icon: FileText },
    { to: "/backups", label: "书签备份", description: "保存保护点，按需安全恢复", icon: Archive },
    { to: "/import", label: "导入书签", description: "本地解析 HTML，先预览再写入", icon: FileUp },
    { to: "/habits", label: "分类偏好", description: "管理明确规则与已学习的分类习惯", icon: Sparkles },
    { to: "/history", label: "常访问书签", description: "授权后查看本地访问统计", icon: History },
    { to: "/options", label: "设置与 AI 服务", description: "配置模型、整理选项与隐私权限", icon: Settings },
  ];
  return <main className="extension-page extension-page--tools">
    <div className="extension-page__inner">
      <header className="extension-page__header"><PageHeading title="更多工具" /></header>
      <nav className="remarks-tool-directory" aria-label="更多工具">
        {entries.map(({ to, label, description, icon: Icon }) => <Link key={to} to={to}><span className="remarks-tool-directory__icon"><Icon aria-hidden="true" /></span><span><strong>{label}</strong><small>{description}</small></span><ChevronRight aria-hidden="true" /></Link>)}
      </nav>
    </div>
  </main>;
}
