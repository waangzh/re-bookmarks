import { PageHeading } from "./PageHeading";
import { TopNotice, TopNotices } from "./TopNotice";
import { RecommendationActionHelp } from "./RecommendationActionHelp";
import { BookmarkTaskHeader } from "./BookmarkTaskHeader";
import { RecommendationRowActionMenu } from "./RecommendationRowActionMenu";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Check, X, ExternalLink, Folder, FolderPlus, Globe2, ChevronDown, ChevronRight, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import type { PendingRecommendation } from "../types";
import { acceptRecommendation, acceptRecommendations, getRecommendationKind, getRecommendationSignalLabel, isActionableRecommendation, isBatchSafeRecommendation, removeRecommendation, retryRecommendation, updateRecommendationFolderPath } from "../services/recommendations";
import { getBookmarkFaviconUrl, parseFolderPath } from "../services/bookmarks";
import { recordHabitFeedback } from "../services/habits";
import { useAppStore } from "../store/useAppStore";
import { addBookmarkWhitelistEntry } from "../services/whitelist";
import { STORAGE_KEYS } from "../services/storage";
import { Select } from "./Select";

type SortKey = "created-desc" | "created-asc" | "confidence-desc" | "confidence-asc" | "title-asc";

function getFaviconUrl(url?: string) {
  return url ? getBookmarkFaviconUrl(url) : "";
}

function ExpandableReason({ reason, signalLabel }: { reason?: string; signalLabel?: string }) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = (reason?.length ?? 0) > 72;
  const content = (
    <>
      {signalLabel && (
        <strong className="recommendation-signal" title="依据仅作相对参考，不代表分类正确率">
          {signalLabel}{reason && "："}
        </strong>
      )}
      {reason}
    </>
  );

  if (!shouldCollapse) {
    return <p className="extension-list__note">{content}</p>;
  }

  return (
    <div className="extension-expand-text">
      <p className={`extension-list__note ${expanded ? "" : "extension-list__note--clamped"}`}>
        {content}
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
  const { pendingRecommendations, loadRecommendations, loadBookmarks, loadReports, settings } = useAppStore();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<"accept" | "ignore" | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("created-desc");
  const [editingRecommendationId, setEditingRecommendationId] = useState<string | null>(null);
  const [recommendationPathDraft, setRecommendationPathDraft] = useState("");
  const [error, setError] = useState("");
  const [operationNotice, setOperationNotice] = useState("");
  const [dismissNotice, setDismissNotice] = useState("");
  const [learningNotice, setLearningNotice] = useState("");
  const [confirmCreateFolderId, setConfirmCreateFolderId] = useState<string | null>(null);

  useEffect(() => {
    void loadRecommendations();
  }, [loadRecommendations]);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === "local" && (changes[STORAGE_KEYS.bookmarkWhitelist] || changes[STORAGE_KEYS.pendingRecommendations] || changes[STORAGE_KEYS.folderHabitProfile] || changes[STORAGE_KEYS.fixedDomainRules])) void loadRecommendations();
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, [loadRecommendations]);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.bookmarks) return;
    const refresh = () => {
      void loadRecommendations().catch((cause) => setError(cause instanceof Error ? cause.message : "刷新建议失败"));
    };
    chrome.bookmarks.onRemoved.addListener(refresh);
    chrome.bookmarks.onMoved.addListener(refresh);
    chrome.bookmarks.onChanged.addListener(refresh);
    return () => {
      chrome.bookmarks.onRemoved.removeListener(refresh);
      chrome.bookmarks.onMoved.removeListener(refresh);
      chrome.bookmarks.onChanged.removeListener(refresh);
    };
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

  const actionableRecommendations = useMemo(
    () => sortedRecommendations.filter(isActionableRecommendation),
    [sortedRecommendations]
  );

  const batchRecommendations = actionableRecommendations.filter(isBatchSafeRecommendation);

  const handleEditStart = (recommendation: PendingRecommendation) => {
    setConfirmCreateFolderId(null);
    setEditingRecommendationId(recommendation.id);
    setRecommendationPathDraft(recommendation.suggestedFolderPath.join(" / "));
    setError("");
    setOperationNotice("");
    setDismissNotice("");
    setLearningNotice("");
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
      const notice = await recordHabitFeedback({
        type: "category_override",
        bookmarkTitle: recommendation.bookmarkTitle,
        bookmarkUrl: recommendation.bookmarkUrl,
        suggestedFolderPath: recommendation.suggestedFolderPath,
        chosenFolderPath: folderPath,
      }).catch(() => null);
      await loadRecommendations();
      setEditingRecommendationId(null);
      setRecommendationPathDraft("");
      setLearningNotice(notice ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存推荐目标失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleAccept = async (recommendation: PendingRecommendation) => {
    if (getRecommendationKind(recommendation) === "create_folder" && confirmCreateFolderId !== recommendation.id) {
      setConfirmCreateFolderId(recommendation.id);
      return;
    }
    setConfirmCreateFolderId(null);
    setBusyId(recommendation.id);
    setError("");
    setOperationNotice("");
    setDismissNotice("");
    setLearningNotice("");
    try {
      const report = await acceptRecommendation(recommendation);
      await Promise.all([loadRecommendations(), loadBookmarks(), loadReports()]);
      setEditingRecommendationId(null);
      setRecommendationPathDraft("");
      if (report.failedItems.length > 0) {
        setError(`推荐移动失败：${report.failedItems[0].reason}。操作结果已记录到整理报告。`);
      } else {
        setOperationNotice("推荐已接受；操作前备份和整理报告已保存，可尝试移回原文件夹（不恢复原排序）。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "接受推荐失败");
      await loadRecommendations().catch(() => undefined);
    } finally {
      setBusyId(null);
    }
  };

  const handleIgnore = async (recommendation: PendingRecommendation) => {
    setBusyId(recommendation.id);
    setError("");
    setOperationNotice("");
    setDismissNotice("");
    setLearningNotice("");
    try {
      await removeRecommendation(recommendation.id);
      await loadRecommendations();
      setDismissNotice("已跳过这条建议，分类偏好保持原样");
    } catch (err) {
      setError(err instanceof Error ? err.message : "跳过建议失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleProtect = async (recommendation: PendingRecommendation) => {
    setBusyId(recommendation.id);
    setError("");
    try {
      await addBookmarkWhitelistEntry("bookmark", recommendation.bookmarkId);
      await loadRecommendations();
      setDismissNotice("已保护此书签，可在书签管理的白名单中解除保护");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加入白名单失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleRetry = async (recommendation: PendingRecommendation) => {
    setBusyId(recommendation.id);
    setError("");
    setOperationNotice("");
    setDismissNotice("");
    try {
      await retryRecommendation(recommendation);
      await loadRecommendations();
      setOperationNotice("已重新判断该书签；书签位置未改变");
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新分类失败");
      await loadRecommendations();
    } finally {
      setBusyId(null);
    }
  };

  const handleRejectCategory = async (recommendation: PendingRecommendation) => {
    setBusyId(recommendation.id);
    setError("");
    setOperationNotice("");
    setDismissNotice("");
    try {
      await removeRecommendation(recommendation.id);
      const notice = await recordHabitFeedback({
        type: "folder_rejected",
        bookmarkTitle: recommendation.bookmarkTitle,
        bookmarkUrl: recommendation.bookmarkUrl,
        suggestedFolderPath: recommendation.suggestedFolderPath,
      }).catch(() => null);
      await loadRecommendations();
      setLearningNotice(notice ?? "建议已移除，但未能记录分类偏好");
    } catch (err) {
      setError(err instanceof Error ? err.message : "记录分类反馈失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleAcceptAll = async () => {
    setBulkAction("accept");
    setError("");
    setOperationNotice("");
    setDismissNotice("");
    setLearningNotice("");

    try {
      const report = await acceptRecommendations(batchRecommendations);
      await Promise.all([loadRecommendations(), loadBookmarks(), loadReports()]);
      const skipped = batchRecommendations.length - report.movePlan.length;
      const skippedNotice = skipped > 0 ? ` 已跳过 ${skipped} 条失效或已更新的建议。` : "";
      if (report.failedItems.length > 0) {
        const failedTitles = report.failedItems.slice(0, 3).map((item) => item.bookmarkTitle);
        setError(
          `已移动 ${report.movedCount} 个，${report.failedItems.length} 个失败：${failedTitles.join("、")}${report.failedItems.length > 3 ? " 等" : ""}。详情已写入整理报告。${skippedNotice}`
        );
      } else {
        setOperationNotice(`已归档 ${report.movePlan.length} 条已有目录建议。${skippedNotice}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "一键接受失败");
      await loadRecommendations().catch(() => undefined);
    } finally {
      setBulkAction(null);
    }
  };

  const handleIgnoreAll = async () => {
    setBulkAction("ignore");
    setError("");
    setOperationNotice("");
    setDismissNotice("");
    setLearningNotice("");

    try {
      for (const recommendation of sortedRecommendations) {
        await removeRecommendation(recommendation.id);
      }
      await loadRecommendations();
      setDismissNotice(`已跳过 ${sortedRecommendations.length} 条建议，分类偏好保持原样`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批量跳过建议失败");
      await loadRecommendations();
    } finally {
      setBulkAction(null);
    }
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
          <PageHeading title="待处理推荐" />
        </div>

        <TopNotices>
          <TopNotice message={error} tone="error" onDismiss={() => setError("")} />
          <TopNotice message={operationNotice} tone="success" onDismiss={() => setOperationNotice("")}
            action={<Link to="/report">查看整理报告</Link>} />
          <TopNotice message={dismissNotice} tone="success" onDismiss={() => setDismissNotice("")} />
          <TopNotice message={learningNotice} onDismiss={() => setLearningNotice("")} />
        </TopNotices>

        {pendingRecommendations.length === 0 ? (
          <div className="extension-empty">
            <Check className="extension-empty__icon" />
            <p>暂无待处理推荐</p>
            <Link to="/manage" className="extension-page__primary-button">浏览书签</Link>
          </div>
        ) : (
          <section className="bookmark-health-panel">
            <BookmarkTaskHeader title="分类建议" icon={<Sparkles aria-hidden="true" />} summary={`${sortedRecommendations.length} 条建议`}>
                <button
                  type="button"
                  onClick={() => void handleIgnoreAll()}
                  disabled={Boolean(busyId || bulkAction || editingRecommendationId)}
                  className="extension-page__wide-secondary"
                  title="仅移除建议，不记录分类偏好"
                >
                  {bulkAction === "ignore" ? "跳过中" : "全部跳过"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleAcceptAll()}
                  disabled={Boolean(busyId || bulkAction || editingRecommendationId) || batchRecommendations.length === 0}
                  className="extension-page__wide-primary"
                  title="归档前自动备份，仅包含可批量归档的建议"
                >
                  <Check className="w-4 h-4" />
                  {bulkAction === "accept" ? "归档中" : `批量归档（${batchRecommendations.length}）`}
                </button>
            </BookmarkTaskHeader>
            <div className="bookmark-task-list">
              <div className="recommendation-sort">
                <span>排序</span>
                <Select
                  value={sortKey}
                  onChange={(next) => setSortKey(next as SortKey)}
                  aria-label="排序方式"
                  options={[
                    { value: "created-desc", label: "收藏时间：最新优先" },
                    { value: "created-asc", label: "收藏时间：最早优先" },
                    { value: "confidence-desc", label: "置信度：高到低" },
                    { value: "confidence-asc", label: "置信度：低到高" },
                    { value: "title-asc", label: "标题：A-Z" },
                  ]}
                />
              </div>
              <RecommendationActionHelp />
              {sortedRecommendations.map((rec) => {
                const kind = getRecommendationKind(rec);
                const isActionable = isActionableRecommendation(rec);
                const isNewFolder = kind === "create_folder";
                const needsManualReview = kind === "manual_review";
                const hasError = kind === "error";
                const isEditing = editingRecommendationId === rec.id;
                const isConfirming = confirmCreateFolderId === rec.id;
                const actionsDisabled = Boolean(busyId || bulkAction || editingRecommendationId);
                const signalLabel = isActionable && !isEditing ? getRecommendationSignalLabel(rec) : undefined;
                const primaryLabel = isNewFolder ? "创建目录并归档" : isActionable ? "归档书签" : "重新分类";
                const PrimaryIcon = isActionable ? (isNewFolder ? FolderPlus : Check) : RefreshCw;

                return (
                  <section key={rec.id} className={`extension-section recommendation-section${hasError ? " recommendation-section--error" : ""}`}>
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
                          <h3 title={rec.bookmarkTitle}>{rec.bookmarkTitle}</h3>
                        </div>
                        {rec.bookmarkUrl && <p className="extension-list__url">{rec.bookmarkUrl}</p>}
                        <p className="extension-list__meta">{formatTime(rec.createdAt)}，当前：{rec.currentFolderPath?.join(" / ") || "根目录"}</p>
                        <span className={`recommendation-kind recommendation-kind--${kind}`}>
                          {isNewFolder ? "建议新建" : needsManualReview ? "需要判断" : hasError ? "分类失败" : isBatchSafeRecommendation(rec) ? "可批量确认" : "需单独确认"}
                        </span>
                      </div>
                      {!isEditing && (
                        <div className="recommendation-section__actions">
                          {rec.bookmarkUrl && (
                            <a href={rec.bookmarkUrl} target="_blank" rel="noopener noreferrer" className="extension-link-icon"
                              aria-label={`打开书签：${rec.bookmarkTitle}`} title={rec.bookmarkUrl}>
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => void (isActionable ? handleAccept(rec) : handleRetry(rec))}
                            disabled={actionsDisabled || isConfirming}
                            className="extension-icon-action extension-icon-action--blue"
                            aria-label={`${primaryLabel}：${rec.bookmarkTitle}`}
                            title={primaryLabel}
                          >
                            <PrimaryIcon className="w-4 h-4" aria-hidden="true" />
                          </button>
                          <RecommendationRowActionMenu bookmarkTitle={rec.bookmarkTitle} busy={actionsDisabled}
                            editLabel={isActionable ? "修改目录" : "指定目录"}
                            rejectLabel={isNewFolder ? "减少建议创建此目录" : "减少推荐到此目录"}
                            onEdit={() => handleEditStart(rec)}
                            onProtect={() => void handleProtect(rec)}
                            onSkip={() => void handleIgnore(rec)}
                            onReject={isActionable ? () => void handleRejectCategory(rec) : undefined}
                          />
                        </div>
                      )}
                    </div>

                    {isEditing ? (
                      <label className="bookmark-recommendation-edit bookmark-recommendation-edit--section">
                        <span>目标文件夹</span>
                        <input
                          type="text"
                          autoFocus
                          value={recommendationPathDraft}
                          onChange={(event) => setRecommendationPathDraft(event.target.value)}
                          className="extension-control"
                          placeholder="例如：工作 / 文档"
                          disabled={busyId === rec.id}
                        />
                      </label>
                    ) : isActionable ? (
                      <div className={["extension-folder-target", isNewFolder ? "extension-folder-target--new" : ""].filter(Boolean).join(" ")}>
                        {isNewFolder ? <FolderPlus className="w-4 h-4" /> : <Folder className="w-4 h-4" />}
                        <span>{isNewFolder ? "建议新建：" : "建议归档："}{rec.suggestedFolderPath.join(" / ")}</span>
                      </div>
                    ) : (
                      <div className={["recommendation-state", hasError ? "recommendation-state--error" : ""].filter(Boolean).join(" ")}>
                        {hasError ? <TriangleAlert className="w-4 h-4" /> : <Folder className="w-4 h-4" />}
                        <span>{hasError ? "分类服务未完成，书签保持原位" : "分类依据不足，书签保持原位"}</span>
                      </div>
                    )}

                    {(rec.reason || signalLabel) && <ExpandableReason reason={rec.reason} signalLabel={signalLabel} />}

                    {isEditing && (
                      <div className="extension-button-row">
                        <button
                          type="button"
                          onClick={() => void handleSavePath(rec)}
                          disabled={busyId === rec.id || Boolean(bulkAction)}
                          className="extension-page__wide-primary"
                        >
                          <Check className="w-4 h-4" />
                          保存分类
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingRecommendationId(null);
                            setRecommendationPathDraft("");
                          }}
                          disabled={busyId === rec.id || Boolean(bulkAction)}
                          className="extension-page__wide-secondary"
                        >
                          <X className="w-4 h-4" />
                          取消
                        </button>
                      </div>
                    )}
                    {isConfirming && !isEditing && (
                      <div className="extension-button-row">
                        <button type="button" autoFocus className="extension-page__wide-secondary"
                          onClick={() => setConfirmCreateFolderId(null)}>取消</button>
                        <button type="button" disabled={actionsDisabled} className="extension-page__wide-primary"
                          onClick={() => void handleAccept(rec)}>确认创建并归档</button>
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
