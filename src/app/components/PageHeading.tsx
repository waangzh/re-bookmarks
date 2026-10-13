import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft, Bookmark } from "lucide-react";

export function PageHeading({ title, subtitle }: { title: ReactNode; subtitle: ReactNode }) {
  return (
    <div className="extension-page__heading">
      <Link to="/home" className="remarks-brand" aria-label="ReMarks 首页">
        <span className="remarks-brand__mark"><Bookmark aria-hidden="true" /></span>
        <span><strong>ReMarks</strong><small>让书签整理更省心</small></span>
      </Link>
      <Link to="/home" className="extension-page__back">
        <ArrowLeft aria-hidden="true" /> 返回首页
      </Link>
      <div className="remarks-page-intro">
        <h1 className="extension-page__title">{title}</h1>
        <p className="extension-page__subtitle">{subtitle}</p>
      </div>
    </div>
  );
}
