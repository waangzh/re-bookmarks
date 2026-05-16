import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Bookmark, Settings, FileText, History, Bell, FolderEdit, Sparkles, CheckCircle } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { getPreviewPlan } from "../services/storage";
import { getPreviewTask } from "../services/previewTask";

export function Popup() {
  const { bookmarks, pendingRecommendations, lastReport, loadAll, loading } = useAppStore();
  const [previewState, setPreviewState] = useState<"none" | "running" | "ready">("none");

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void Promise.all([getPreviewPlan(), getPreviewTask()]).then(([cache, task]) => {
      if (task?.status === "running") {
        setPreviewState("running");
        return;
      }
      setPreviewState(cache?.movePlan?.length || task?.movePlan?.length ? "ready" : "none");
    });
  }, []);

  const bookmarkCount = bookmarks.length;
  const pendingCount = pendingRecommendations.length;

  return (
    <div className="bookmark-popup">
      <div className="bookmark-popup__card bookmark-popup__card--blue">
        <div className="bookmark-popup__current-head">
          <div className="bookmark-popup__card-title bookmark-popup__card-title--blue">
            <Bookmark className="bookmark-popup__card-icon" />
            <span>当前书签</span>
          </div>
          <div className="bookmark-popup__count">
            {loading ? (
              <span className="bookmark-popup__count-value bookmark-popup__count-value--text">读取中</span>
            ) : (
              <>
                <span className="bookmark-popup__count-value">{bookmarkCount}</span>
                <span className="bookmark-popup__count-unit">个</span>
              </>
            )}
          </div>
        </div>
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
        {previewState !== "none" ? (
          <Link to="/preview" className="bookmark-popup__action bookmark-popup__action--primary">
            <div className="bookmark-popup__action-main">
              <FileText className="bookmark-popup__action-icon" />
              <span>{previewState === "running" ? "继续智能整理" : "继续上次预览"}</span>
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
              <span>整理报告</span>
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
        <Link to="/options" className="bookmark-popup__icon-button" aria-label="设置">
          <Settings className="bookmark-popup__settings-icon" />
        </Link>
      </div>
    </div>
  );
}
