import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, Bookmark } from "lucide-react";

export function PageHeading({ title, subtitle }: { title: ReactNode; subtitle: ReactNode }) {
  const navigate = useNavigate();

  const handleBack = () => {
    // 直接打开子页面时没有可返回的历史，退回首页避免离开扩展
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate("/home");
  };

  return (
    <div className="extension-page__heading">
      <Link to="/home" className="remarks-brand" aria-label="ReMarks 首页">
        <span className="remarks-brand__mark"><Bookmark aria-hidden="true" /></span>
        <span><strong>ReMarks</strong><small>让书签整理更省心</small></span>
      </Link>
      <div className="remarks-page-intro">
        <div className="remarks-page-intro__row">
          <button
            type="button"
            className="extension-page__back"
            onClick={handleBack}
            aria-label="返回上一页"
            title="返回上一页"
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <h1 className="extension-page__title">{title}</h1>
        </div>
        <p className="extension-page__subtitle">{subtitle}</p>
      </div>
    </div>
  );
}
