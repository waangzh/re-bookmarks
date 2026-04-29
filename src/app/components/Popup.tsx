import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Bookmark, Settings, FileText, History, Bell, FolderEdit, Sparkles, CheckCircle } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { getPreviewPlan } from "../services/storage";

export function Popup() {
  const { bookmarks, pendingRecommendations, lastReport, loadAll, loading } = useAppStore();
  const [hasPreviewCache, setHasPreviewCache] = useState(false);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void getPreviewPlan().then((cache) => {
      setHasPreviewCache(!!cache?.movePlan?.length);
    });
  }, []);

  const bookmarkCount = bookmarks.length;
  const pendingCount = pendingRecommendations.length;

  return (
    <div className="bookmark-popup">
      <div className="bookmark-popup__header">
        <div className="bookmark-popup__brand">
          <div className="bookmark-popup__brand-icon">
            <Bookmark className="bookmark-popup__brand-svg" />
          </div>
          <h1 className="bookmark-popup__title">ReMarks</h1>
        </div>
        <Link to="/options" className="bookmark-popup__icon-button" aria-label="设置">
          <Settings className="bookmark-popup__settings-icon" />
        </Link>
      </div>

      <div className="bookmark-popup__card bookmark-popup__card--blue">
        <div className="bookmark-popup__card-title bookmark-popup__card-title--blue">
          <Bookmark className="bookmark-popup__card-icon" />
          <span>当前书签</span>
        </div>
        <div className="bookmark-popup__count">{loading ? "读取中" : `${bookmarkCount} 个`}</div>
      </div>

      {pendingCount > 0 && (
        <div className="bookmark-popup__card bookmark-popup__card--amber">
          <div className="bookmark-popup__recommend-head">
            <div className="bookmark-popup__card-title bookmark-popup__card-title--amber">
              <Bell className="bookmark-popup__card-icon" />
              <span>待处理推荐</span>
            </div>
            <span className="bookmark-popup__badge">{pendingCount}</span>
          </div>
          <p className="bookmark-popup__recommend-copy">有 {pendingCount} 个新书签等待整理</p>
          <Link to="/recommendations" className="bookmark-popup__recommend-button">
            查看推荐
          </Link>
        </div>
      )}

      <div className="bookmark-popup__actions">
        {hasPreviewCache ? (
          <Link to="/preview" className="bookmark-popup__action bookmark-popup__action--primary">
            <div className="bookmark-popup__action-main">
              <FileText className="bookmark-popup__action-icon" />
              <span>继续上次预览</span>
            </div>
            <span className="bookmark-popup__arrow">→</span>
          </Link>
        ) : (
          <Link to="/preview" className="bookmark-popup__action bookmark-popup__action--primary">
            <div className="bookmark-popup__action-main">
              <FileText className="bookmark-popup__action-icon" />
              <span>开始智能整理</span>
            </div>
            <span className="bookmark-popup__arrow">→</span>
          </Link>
        )}

        {lastReport && (
          <Link to="/report" className="bookmark-popup__action bookmark-popup__action--secondary">
            <div className="bookmark-popup__action-main">
              <CheckCircle className="bookmark-popup__action-icon" />
              <span>上次整理结果</span>
            </div>
            <span className="bookmark-popup__arrow">→</span>
          </Link>
        )}

        <Link to="/history" className="bookmark-popup__action bookmark-popup__action--secondary">
          <div className="bookmark-popup__action-main">
            <History className="bookmark-popup__action-icon" />
            <span>常访问书签</span>
          </div>
          <span className="bookmark-popup__arrow">→</span>
        </Link>

        <Link to="/manage" className="bookmark-popup__action bookmark-popup__action--secondary">
          <div className="bookmark-popup__action-main">
            <FolderEdit className="bookmark-popup__action-icon" />
            <span>管理书签</span>
          </div>
          <span className="bookmark-popup__arrow">→</span>
        </Link>

        <Link to="/habits" className="bookmark-popup__action bookmark-popup__action--secondary">
          <div className="bookmark-popup__action-main">
            <Sparkles className="bookmark-popup__action-icon" />
            <span>分类习惯预设</span>
          </div>
          <span className="bookmark-popup__arrow">→</span>
        </Link>
      </div>

      <div className="bookmark-popup__footer">
        <p>使用 AI 智能分类您的书签</p>
      </div>
    </div>
  );
}
