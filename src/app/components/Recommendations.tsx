import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Check, X, ExternalLink, Folder } from "lucide-react";
import type { PendingRecommendation } from "../types";
import { acceptRecommendation, removeRecommendation } from "../services/recommendations";
import { useAppStore } from "../store/useAppStore";

export function Recommendations() {
  const { pendingRecommendations, loadRecommendations, loadBookmarks } = useAppStore();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadRecommendations();
  }, [loadRecommendations]);

  const handleAccept = async (recommendation: PendingRecommendation) => {
    setBusyId(recommendation.id);
    setError("");
    try {
      await acceptRecommendation(recommendation);
      await Promise.all([loadRecommendations(), loadBookmarks()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "接受推荐失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (id: string) => {
    setBusyId(id);
    setError("");
    try {
      await removeRecommendation(id);
      await loadRecommendations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "忽略推荐失败");
    } finally {
      setBusyId(null);
    }
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.9) return "text-green-600 bg-green-50";
    if (confidence >= 0.8) return "text-blue-600 bg-blue-50";
    return "text-amber-600 bg-amber-50";
  };

  const formatTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const hours = Math.floor(diff / 3600000);
    if (hours < 1) return "刚刚";
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  };

  return (
    <div className="extension-page">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">待处理推荐</h1>
              <p className="extension-page__subtitle">{pendingRecommendations.length} 条建议待处理</p>
            </div>
          </div>
        </div>

        {error && (
          <div className="extension-notice extension-notice--amber">
            <p>{error}</p>
          </div>
        )}

        {pendingRecommendations.length === 0 ? (
          <div className="extension-empty">
            <Check className="extension-empty__icon" />
            <p>暂无待处理推荐</p>
            <span>新增书签后会自动生成整理推荐</span>
          </div>
        ) : (
          <>
            <div className="extension-notice extension-notice--amber">
              <p>共有 {pendingRecommendations.length} 个新书签等待整理。接受推荐后将移动到建议文件夹。</p>
            </div>

            <div className="extension-stack">
              {pendingRecommendations.map((rec) => (
                <section key={rec.id} className="extension-section">
                  <div className="extension-list__item extension-list__item--static">
                    <div className="extension-list__main">
                      <div className="extension-list__title-row">
                        <h3>{rec.bookmarkTitle}</h3>
                        {rec.bookmarkUrl && (
                          <a href={rec.bookmarkUrl} target="_blank" rel="noopener noreferrer" className="extension-link-icon">
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      {rec.bookmarkUrl && <p className="extension-list__url">{rec.bookmarkUrl}</p>}
                      <p className="extension-list__meta">{formatTime(rec.createdAt)}</p>
                    </div>
                    <span className={`extension-confidence ${getConfidenceColor(rec.confidence)}`}>{Math.round(rec.confidence * 100)}%</span>
                  </div>

                  <div className="extension-folder-target">
                    <Folder className="w-4 h-4" />
                    <span>{rec.suggestedFolderPath.join(" / ")}</span>
                  </div>

                  {rec.reason && <p className="extension-list__note">{rec.reason}</p>}

                  <div className="extension-button-row">
                    <button onClick={() => void handleAccept(rec)} disabled={busyId === rec.id} className="extension-page__wide-primary">
                      <Check className="w-4 h-4" />
                      接受
                    </button>
                    <button onClick={() => void handleReject(rec.id)} disabled={busyId === rec.id} className="extension-page__wide-secondary">
                      <X className="w-4 h-4" />
                      忽略
                    </button>
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
