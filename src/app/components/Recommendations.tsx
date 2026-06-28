import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Check, X, ExternalLink, Folder, Globe2, ChevronDown, ChevronRight, Edit2 } from "lucide-react";
import type { PendingRecommendation } from "../types";
import { acceptRecommendation, removeRecommendation, updateRecommendationFolderPath } from "../services/recommendations";
import { parseFolderPath } from "../services/bookmarks";
import { useAppStore } from "../store/useAppStore";

type SortKey = "created-desc" | "created-asc" | "confidence-desc" | "confidence-asc" | "title-asc";

function getFaviconUrl(url?: string) {
  if (!url) return "";

  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  }

  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function ExpandableReason({ reason }: { reason: string }) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = reason.length > 72;

  if (!shouldCollapse) {
    return <p className="extension-list__note">{reason}</p>;
  }

  return (
    <div className="extension-expand-text">
      <p className={`extension-list__note ${expanded ? "" : "extension-list__note--clamped"}`}>
        {reason}
      </p>
      <button
        type="button"
        className="extension-text-button extension-text-button--small extension-expand-text__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {expanded ? "收起" : "展开"}
      </button>
    </div>
  );
}

export function Recommendations() {
  const { pendingRecommendations, loadRecommendations, loadBookmarks, settings } = useAppStore();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<"accept" | "reject" | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("created-desc");
  const [editingRecommendationId, setEditingRecommendationId] = useState<string | null>(null);
  const [recommendationPathDraft, setRecommendationPathDraft] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void loadRecommendations();
  }, [loadRecommendations]);

  const sortedRecommendations = useMemo(() => {
    return [...pendingRecommendations].sort((a, b) => {
      switch (sortKey) {
        case "created-asc":
          return a.createdAt - b.createdAt;
        case "confidence-desc":
          return b.confidence - a.confidence;
        case "confidence-asc":
          return a.confidence - b.confidence;
        case "title-asc":
          return a.bookmarkTitle.localeCompare(b.bookmarkTitle, "zh-CN");
        case "created-desc":
        default:
          return b.createdAt - a.createdAt;
      }
    });
  }, [pendingRecommendations, sortKey]);

  const handleEditStart = (recommendation: PendingRecommendation) => {
    setEditingRecommendationId(recommendation.id);
    setRecommendationPathDraft(recommendation.suggestedFolderPath.join(" / "));
    setError("");
  };

  const handleSavePath = async (recommendation: PendingRecommendation) => {
    const folderPath = parseFolderPath(recommendationPathDraft, settings.maxNestingLevel);
    if (folderPath.length === 0) {
      setError("请填写目标文件夹");
      return;
    }

    setBusyId(recommendation.id);
    setError("");
    try {
      await updateRecommendationFolderPath(recommendation.id, folderPath);
      await loadRecommendations();
      setEditingRecommendationId(null);
      setRecommendationPathDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存推荐目标失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleAccept = async (recommendation: PendingRecommendation) => {
    setBusyId(recommendation.id);
    setError("");
    try {
      await acceptRecommendation(recommendation);
      await Promise.all([loadRecommendations(), loadBookmarks()]);
      setEditingRecommendationId(null);
      setRecommendationPathDraft("");
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

  const handleAcceptAll = async () => {
    setBulkAction("accept");
    setError("");
    const failed: string[] = [];

    try {
      for (const recommendation of sortedRecommendations) {
        try {
          await acceptRecommendation(recommendation);
        } catch {
          failed.push(recommendation.bookmarkTitle || recommendation.bookmarkId);
        }
      }

      await Promise.all([loadRecommendations(), loadBookmarks()]);
      if (failed.length > 0) {
        setError(`部分推荐接受失败：${failed.slice(0, 3).join("、")}${failed.length > 3 ? " 等" : ""}`);
      }
    } finally {
      setBulkAction(null);
    }
  };

  const handleRejectAll = async () => {
    setBulkAction("reject");
    setError("");

    try {
      for (const recommendation of sortedRecommendations) {
        await removeRecommendation(recommendation.id);
      }
      await loadRecommendations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "蹇界暐鎺ㄨ崘澶辫触");
      await loadRecommendations();
    } finally {
      setBulkAction(null);
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

            <div className="recommendation-toolbar">
              <div className="recommendation-toolbar__actions">
                <button
                  type="button"
                  onClick={() => void handleAcceptAll()}
                  disabled={Boolean(bulkAction) || Boolean(editingRecommendationId) || sortedRecommendations.length === 0}
                  className="extension-page__wide-primary"
                >
                  <Check className="w-4 h-4" />
                  一键接受所有
                </button>
                <button
                  type="button"
                  onClick={() => void handleRejectAll()}
                  disabled={Boolean(bulkAction) || Boolean(editingRecommendationId) || sortedRecommendations.length === 0}
                  className="extension-page__wide-secondary"
                >
                  <X className="w-4 h-4" />
                  一键忽略所有
                </button>
              </div>
              <label className="recommendation-sort">
                <span>排序</span>
                <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
                  <option value="created-desc">收藏时间：最新优先</option>
                  <option value="created-asc">收藏时间：最早优先</option>
                  <option value="confidence-desc">置信度：高到低</option>
                  <option value="confidence-asc">置信度：低到高</option>
                  <option value="title-asc">标题：A-Z</option>
                </select>
              </label>
            </div>

            <div className="extension-stack">
              {sortedRecommendations.map((rec) => (
                <section key={rec.id} className="extension-section">
                  <div className="extension-list__item extension-list__item--static">
                    <span className="extension-favicon" aria-hidden="true">
                      <Globe2 className="extension-favicon__fallback" />
                      {rec.bookmarkUrl && (
                        <img
                          src={getFaviconUrl(rec.bookmarkUrl)}
                          alt=""
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                      )}
                    </span>
                    <div className="extension-list__main">
                      <div className="extension-list__title-row">
                        <h3>{rec.bookmarkTitle}</h3>
                        {rec.bookmarkUrl && (
                          <a href={rec.bookmarkUrl} target="_blank" rel="noopener noreferrer" className="extension-link-icon" aria-label="打开书签">
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      {rec.bookmarkUrl && <p className="extension-list__url">{rec.bookmarkUrl}</p>}
                      <p className="extension-list__meta">{formatTime(rec.createdAt)}</p>
                    </div>
                    <span className={`extension-confidence ${getConfidenceColor(rec.confidence)}`}>{Math.round(rec.confidence * 100)}%</span>
                  </div>

                  {editingRecommendationId === rec.id ? (
                    <label className="bookmark-recommendation-edit bookmark-recommendation-edit--section">
                      <span>目标文件夹</span>
                      <input
                        type="text"
                        value={recommendationPathDraft}
                        onChange={(event) => setRecommendationPathDraft(event.target.value)}
                        className="extension-control"
                        placeholder="例如：工作 / 文档"
                        disabled={busyId === rec.id}
                      />
                    </label>
                  ) : (
                    <div className="extension-folder-target">
                      <Folder className="w-4 h-4" />
                      <span>{rec.suggestedFolderPath.join(" / ")}</span>
                    </div>
                  )}

                  {rec.reason && <ExpandableReason reason={rec.reason} />}

                  <div className={`extension-button-row ${editingRecommendationId === rec.id ? "" : "extension-button-row--three"}`}>
                    {editingRecommendationId === rec.id ? (
                      <>
                        <button
                          onClick={() => void handleSavePath(rec)}
                          disabled={busyId === rec.id || Boolean(bulkAction) || (Boolean(editingRecommendationId) && editingRecommendationId !== rec.id)}
                          className="extension-page__wide-primary"
                        >
                          <Check className="w-4 h-4" />
                          保存
                        </button>
                        <button
                          onClick={() => {
                            setEditingRecommendationId(null);
                            setRecommendationPathDraft("");
                          }}
                          disabled={busyId === rec.id || Boolean(bulkAction) || (Boolean(editingRecommendationId) && editingRecommendationId !== rec.id)}
                          className="extension-page__wide-secondary"
                        >
                          <X className="w-4 h-4" />
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => handleEditStart(rec)}
                          disabled={Boolean(busyId) || Boolean(bulkAction) || Boolean(editingRecommendationId)}
                          className="extension-page__wide-secondary"
                        >
                          <Edit2 className="w-4 h-4" />
                          编辑
                        </button>
                        <button
                          onClick={() => void handleAccept(rec)}
                          disabled={busyId === rec.id || Boolean(bulkAction) || (Boolean(editingRecommendationId) && editingRecommendationId !== rec.id)}
                          className="extension-page__wide-primary"
                        >
                          <Check className="w-4 h-4" />
                          接受
                        </button>
                        <button
                          onClick={() => void handleReject(rec.id)}
                          disabled={busyId === rec.id || Boolean(bulkAction) || (Boolean(editingRecommendationId) && editingRecommendationId !== rec.id)}
                          className="extension-page__wide-secondary"
                        >
                          <X className="w-4 h-4" />
                          忽略
                        </button>
                      </>
                    )}
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
