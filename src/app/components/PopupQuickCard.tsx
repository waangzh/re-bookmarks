import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit2,
  ExternalLink,
  Folder,
  FolderInput,
  FolderPlus,
  Globe2,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import type { BookmarkNode, PendingRecommendation } from "../types";
import {
  acceptRecommendation,
  getRecommendationKind,
  getRecommendationSignalLabel,
  isActionableRecommendation,
  removeRecommendation,
  retryRecommendation,
  updateRecommendationFolderPath,
} from "../services/recommendations";
import { getAllBookmarkFolders, getBookmarkFaviconUrl, parseFolderPath } from "../services/bookmarks";
import { saveCurrentPage } from "../services/currentPage";
import { recordHabitFeedback } from "../services/habits";
import { sanitizeUrl } from "../services/rules";
import { getPendingAnalysisBookmarkIds, isPendingAnalysisUpdatedMessage } from "../services/sidePanel";
import { resolvePopupQuickTarget, type PopupCurrentPage } from "../services/popupQuickCard";
import { addBookmarkWhitelistEntry } from "../services/whitelist";
import { FolderPathSelect } from "./FolderPathSelect";
import { protectBookmarkHelp, skipRecommendationHelp } from "./RecommendationActionHelp";

type PopupQuickCardProps = {
  currentPage: PopupCurrentPage | null;
  bookmarks: BookmarkNode[];
  pendingRecommendations: PendingRecommendation[];
  maxNestingLevel: number;
  onRefresh: () => Promise<void> | void;
  onCurrentPageSaved: (url: string) => void;
  onAnalyzingIdsChange?: (bookmarkIds: string[]) => void;
};

type QuickFeedback = {
  tone: "success" | "error" | "info";
  text: string;
  showReportLink?: boolean;
};

function getDomain(url?: string) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function CardFavicon({ title, url }: { title?: string; url?: string }) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = url && !failed ? getBookmarkFaviconUrl(url, 32) : "";

  useEffect(() => {
    setFailed(false);
  }, [url]);

  return (
    <span className="popup-quick-card__icon" aria-hidden="true" title={title || undefined}>
      {faviconUrl ? <img src={faviconUrl} alt="" draggable={false} onError={() => setFailed(true)} /> : <Globe2 aria-hidden="true" />}
    </span>
  );
}

/**
 * Popup 首页置顶的“刚收藏 / 当前页”快捷操作卡：
 * 支持收藏当前页、查看当前页位置，以及原地确认/修改/跳过刚收藏书签的 AI 归档建议。
 */
export function PopupQuickCard({
  currentPage,
  bookmarks,
  pendingRecommendations,
  maxNestingLevel,
  onRefresh,
  onCurrentPageSaved,
  onAnalyzingIdsChange,
}: PopupQuickCardProps) {
  const [folders, setFolders] = useState<BookmarkNode[]>([]);
  const [analyzingBookmarkIds, setAnalyzingBookmarkIds] = useState<string[]>([]);
  const [optimisticAnalyzingIds, setOptimisticAnalyzingIds] = useState<string[]>([]);
  const [savingCurrent, setSavingCurrent] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [confirmCreateFolderId, setConfirmCreateFolderId] = useState<string | null>(null);
  const [reasonExpandedId, setReasonExpandedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<QuickFeedback | null>(null);
  const sawActiveInBackgroundRef = useRef(false);

  const syncAnalyzingIds = useCallback(async () => {
    const activeIds = await getPendingAnalysisBookmarkIds();
    if (activeIds.length > 0) sawActiveInBackgroundRef.current = true;
    setAnalyzingBookmarkIds(activeIds);
    setOptimisticAnalyzingIds((current) => {
      if (current.length === 0) return current;
      const pendingBookmarkSet = new Set(pendingRecommendations.map((item) => item.bookmarkId));
      return current.filter((id) => !pendingBookmarkSet.has(id));
    });
  }, [pendingRecommendations]);

  useEffect(() => {
    void getAllBookmarkFolders().then(setFolders).catch(() => undefined);
  }, [bookmarks]);

  useEffect(() => {
    void syncAnalyzingIds();
  }, [syncAnalyzingIds]);

  useEffect(() => {
    if (typeof chrome === "undefined") return;
    const handleMessage = (message: unknown) => {
      if (!isPendingAnalysisUpdatedMessage(message)) return;
      setOptimisticAnalyzingIds([]);
      void syncAnalyzingIds();
      void onRefresh();
    };
    const handleBookmarkCreated = () => {
      void syncAnalyzingIds();
    };
    chrome.runtime?.onMessage?.addListener(handleMessage);
    chrome.bookmarks?.onCreated?.addListener(handleBookmarkCreated);
    return () => {
      chrome.runtime?.onMessage?.removeListener(handleMessage);
      chrome.bookmarks?.onCreated?.removeListener(handleBookmarkCreated);
    };
  }, [onRefresh, syncAnalyzingIds]);

  const combinedAnalyzingIds = useMemo(
    () => [...new Set([...analyzingBookmarkIds, ...optimisticAnalyzingIds])],
    [analyzingBookmarkIds, optimisticAnalyzingIds]
  );

  useEffect(() => {
    onAnalyzingIdsChange?.(combinedAnalyzingIds);
  }, [combinedAnalyzingIds, onAnalyzingIdsChange]);

  useEffect(() => {
    if (combinedAnalyzingIds.length === 0) {
      sawActiveInBackgroundRef.current = false;
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      void getPendingAnalysisBookmarkIds().then((activeIds) => {
        if (activeIds.length > 0) sawActiveInBackgroundRef.current = true;
        setAnalyzingBookmarkIds(activeIds);
        if (activeIds.length === 0 && (sawActiveInBackgroundRef.current || Date.now() - startedAt >= 3000)) {
          sawActiveInBackgroundRef.current = false;
          setOptimisticAnalyzingIds([]);
          void onRefresh();
        }
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [combinedAnalyzingIds.length, onRefresh]);

  const target = useMemo(
    () =>
      resolvePopupQuickTarget({
        currentPage,
        bookmarks,
        pendingRecommendations,
        analyzingBookmarkIds: combinedAnalyzingIds,
      }),
    [analyzingBookmarkIds, bookmarks, combinedAnalyzingIds, currentPage, pendingRecommendations]
  );

  const activeRecommendation = target.currentRecommendation ?? target.latestOtherRecommendation;
  const isCurrentRecommendation = Boolean(
    activeRecommendation && target.currentRecommendation?.id === activeRecommendation.id
  );

  useEffect(() => {
    if (confirmCreateFolderId && confirmCreateFolderId !== activeRecommendation?.id) {
      setConfirmCreateFolderId(null);
    }
    if (editingId && editingId !== activeRecommendation?.id) {
      setEditingId(null);
      setPathDraft("");
    }
  }, [activeRecommendation?.id, confirmCreateFolderId, editingId]);

  const handleSaveCurrentPage = async () => {
    if (!currentPage || savingCurrent) return;
    setSavingCurrent(true);
    setFeedback(null);
    try {
      const result = await saveCurrentPage(currentPage.title, currentPage.url);
      onCurrentPageSaved(currentPage.url);
      if (result.created) {
        setOptimisticAnalyzingIds((current) =>
          current.includes(result.id) ? current : [...current, result.id]
        );
      }
      await onRefresh();
      await syncAnalyzingIds();
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "收藏失败，请重试",
      });
    } finally {
      setSavingCurrent(false);
    }
  };

  const handleAccept = async (recommendation: PendingRecommendation) => {
    if (getRecommendationKind(recommendation) === "create_folder" && confirmCreateFolderId !== recommendation.id) {
      setConfirmCreateFolderId(recommendation.id);
      return;
    }
    setConfirmCreateFolderId(null);
    setBusyId(recommendation.id);
    setFeedback(null);
    try {
      const report = await acceptRecommendation(recommendation);
      await onRefresh();
      setEditingId(null);
      setPathDraft("");
      if (report.failedItems.length > 0) {
        setFeedback({
          tone: "error",
          text: `归档失败：${report.failedItems[0].reason}`,
          showReportLink: true,
        });
      } else {
        setFeedback({
          tone: "success",
          text: `已归档至 ${recommendation.suggestedFolderPath.join(" / ")}，备份已保存`,
          showReportLink: true,
        });
      }
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "接受推荐失败",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleEditStart = (recommendation: PendingRecommendation) => {
    setConfirmCreateFolderId(null);
    setEditingId(recommendation.id);
    setPathDraft(recommendation.suggestedFolderPath.join(" / "));
    setFeedback(null);
    void getAllBookmarkFolders().then(setFolders).catch(() => undefined);
  };

  const handleSavePath = async (recommendation: PendingRecommendation) => {
    const folderPath = parseFolderPath(pathDraft, maxNestingLevel);
    if (folderPath.length === 0) {
      setFeedback({ tone: "error", text: "请选择或输入目标文件夹" });
      return;
    }
    setBusyId(recommendation.id);
    setFeedback(null);
    try {
      await updateRecommendationFolderPath(recommendation.id, folderPath);
      const habitNotice = await recordHabitFeedback({
        type: "category_override",
        bookmarkTitle: recommendation.bookmarkTitle,
        bookmarkUrl: recommendation.bookmarkUrl,
        suggestedFolderPath: recommendation.suggestedFolderPath,
        chosenFolderPath: folderPath,
      }).catch(() => null);
      await onRefresh();
      setEditingId(null);
      setPathDraft("");
      setFeedback({
        tone: "info",
        text: habitNotice || `目标目录已更新为 ${folderPath.join(" / ")}`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "保存目标目录失败",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleIgnore = async (recommendation: PendingRecommendation) => {
    setConfirmCreateFolderId(null);
    setBusyId(recommendation.id);
    setFeedback(null);
    try {
      await removeRecommendation(recommendation.id);
      await onRefresh();
      setFeedback({ tone: "info", text: "已跳过该归档建议，书签保持原位" });
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "跳过建议失败",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleProtect = async (recommendation: PendingRecommendation) => {
    setConfirmCreateFolderId(null);
    setBusyId(recommendation.id);
    setFeedback(null);
    try {
      await addBookmarkWhitelistEntry("bookmark", recommendation.bookmarkId);
      await onRefresh();
      setFeedback({ tone: "info", text: "已加入白名单保护，后续整理将跳过此书签" });
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "加入白名单失败",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleRetry = async (recommendation: PendingRecommendation) => {
    setBusyId(recommendation.id);
    setFeedback(null);
    try {
      await retryRecommendation(recommendation);
      await onRefresh();
      setFeedback({ tone: "info", text: "已重新生成推荐，书签位置未改变" });
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "重试推荐失败",
      });
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  const showSeparateCurrentPageCard = Boolean(
    currentPage && !target.isAnalyzingCurrent && !isCurrentRecommendation
  );

  const showAnything = Boolean(
    showSeparateCurrentPageCard || target.isAnalyzingCurrent || activeRecommendation || feedback
  );

  if (!showAnything) return null;

  const renderRecommendationCard = (rec: PendingRecommendation) => {
    const kind = getRecommendationKind(rec);
    const actionable = isActionableRecommendation(rec);
    const isNewFolder = kind === "create_folder";
    const hasError = kind === "error";
    const isBusy = busyId === rec.id;
    const isEditing = editingId === rec.id;
    const signalLabel = actionable && !isEditing ? getRecommendationSignalLabel(rec) : undefined;
    const reasonText = rec.reason ?? "";
    const reasonTooLong = reasonText.length > 68;
    const reasonExpanded = reasonExpandedId === rec.id;

    return (
      <section
        className={`popup-quick-card popup-quick-card--recommendation${hasError ? " is-error" : ""}`}
        aria-label={isCurrentRecommendation ? "当前网页归档建议" : "刚收藏归档建议"}
      >
        <div className="popup-quick-card__top">
          <span className="popup-quick-card__badge">
            <FolderInput aria-hidden="true" />
            <span>{isCurrentRecommendation ? "当前网页 归档建议" : "刚收藏 待整理"}</span>
          </span>
          {target.totalPendingCount > 1 ? (
            <Link to="/recommendations" className="popup-quick-card__more">
              共 {target.totalPendingCount} 条
              <ChevronRight aria-hidden="true" />
            </Link>
          ) : (
            <span className={`recommendation-kind recommendation-kind--${kind}`}>
              {isNewFolder ? "建议新建" : kind === "manual_review" ? "需要判断" : hasError ? "分类失败" : "可归档"}
            </span>
          )}
        </div>

        <div className="popup-quick-card__identity">
          <CardFavicon title={rec.bookmarkTitle} url={rec.bookmarkUrl} />
          <div className="popup-quick-card__identity-main">
            <div className="popup-quick-card__title-row">
              <strong title={rec.bookmarkTitle}>{rec.bookmarkTitle || getDomain(rec.bookmarkUrl) || "未命名书签"}</strong>
              {rec.bookmarkUrl && (
                <a
                  href={rec.bookmarkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="extension-link-icon"
                  aria-label="打开书签"
                >
                  <ExternalLink aria-hidden="true" />
                </a>
              )}
            </div>
            <span title={rec.currentFolderPath?.join(" / ") || "根目录"}>
              当前：{rec.currentFolderPath?.join(" / ") || "根目录"}
            </span>
          </div>
        </div>

        {isEditing ? (
          <div className="popup-quick-card__editor">
            <FolderPathSelect
              value={pathDraft}
              folders={folders}
              maxNestingLevel={maxNestingLevel}
              onChange={setPathDraft}
              disabled={isBusy}
            />
          </div>
        ) : actionable ? (
          <div className={`extension-folder-target popup-quick-card__target${isNewFolder ? " extension-folder-target--new" : ""}`}>
            {isNewFolder ? <FolderPlus aria-hidden="true" /> : <Folder aria-hidden="true" />}
            <span>{isNewFolder ? "建议新建：" : "建议归档："}{rec.suggestedFolderPath.join(" / ")}</span>
          </div>
        ) : (
          <div className={`recommendation-state popup-quick-card__state${hasError ? " recommendation-state--error" : ""}`}>
            {hasError ? <TriangleAlert aria-hidden="true" /> : <Folder aria-hidden="true" />}
            <span>{hasError ? "分类未完成，书签保持原位" : "分类依据不足，书签保持原位"}</span>
          </div>
        )}

        {!isEditing && (reasonText || signalLabel) && (
          <div className="popup-quick-card__reason-box">
            <p className={`popup-quick-card__reason${reasonTooLong && !reasonExpanded ? " is-clamped" : ""}`}>
              {signalLabel && (
                <strong className="recommendation-signal">
                  {signalLabel}{reasonText && "："}
                </strong>
              )}
              {reasonText}
            </p>
            {reasonTooLong && (
              <button
                type="button"
                className="extension-text-button extension-text-button--small popup-quick-card__expand"
                aria-expanded={reasonExpanded}
                onClick={() => setReasonExpandedId(reasonExpanded ? null : rec.id)}
              >
                {reasonExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                {reasonExpanded ? "收起" : "展开"}
              </button>
            )}
          </div>
        )}

        <div className="popup-quick-card__actions">
          {isEditing ? (
            <>
              <button
                type="button"
                className="popup-quick-card__btn popup-quick-card__btn--primary"
                disabled={isBusy}
                onClick={() => void handleSavePath(rec)}
              >
                {isBusy ? <LoaderCircle className="home-action-spinner" aria-hidden="true" /> : <Check aria-hidden="true" />}
                保存目标
              </button>
              <button
                type="button"
                className="popup-quick-card__btn popup-quick-card__btn--secondary"
                disabled={isBusy}
                onClick={() => {
                  setEditingId(null);
                  setPathDraft("");
                }}
              >
                <X aria-hidden="true" />
                取消
              </button>
            </>
          ) : (
            <>
              {actionable ? (
                <button
                  type="button"
                  className="popup-quick-card__btn popup-quick-card__btn--primary"
                  disabled={isBusy}
                  onClick={() => void handleAccept(rec)}
                >
                  {isBusy ? <LoaderCircle className="home-action-spinner" aria-hidden="true" /> : <Check aria-hidden="true" />}
                  {isNewFolder
                    ? confirmCreateFolderId === rec.id
                      ? "确认创建并归档"
                      : "将创建目录"
                    : "归档"}
                </button>
              ) : (
                <button
                  type="button"
                  className="popup-quick-card__btn popup-quick-card__btn--primary"
                  disabled={isBusy}
                  onClick={() => void handleRetry(rec)}
                >
                  {isBusy ? <LoaderCircle className="home-action-spinner" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                  重试
                </button>
              )}
              <button
                type="button"
                className="popup-quick-card__btn popup-quick-card__btn--secondary"
                disabled={isBusy}
                onClick={() => handleEditStart(rec)}
              >
                <Edit2 aria-hidden="true" />
                {actionable ? "改目录" : "指定目录"}
              </button>
            </>
          )}
        </div>

        {!isEditing && (
          <div className="popup-quick-card__footer-actions">
            <button
              type="button"
              className="extension-text-button popup-quick-card__quiet"
              disabled={isBusy}
              title={skipRecommendationHelp}
              onClick={() => void handleIgnore(rec)}
            >
              <X aria-hidden="true" />
              跳过建议
            </button>
            <button
              type="button"
              className="extension-text-button popup-quick-card__quiet"
              disabled={isBusy}
              title={protectBookmarkHelp}
              onClick={() => void handleProtect(rec)}
            >
              <ShieldCheck aria-hidden="true" />
              保护此书签
            </button>
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="popup-quick-stack">
      {showSeparateCurrentPageCard && currentPage && (
        <section className="home-current popup-quick-current" aria-label="当前网页">
          <div className="home-current__row">
            <CardFavicon title={currentPage.title} url={currentPage.url} />
            <div className="home-current__main">
              <small>当前网页</small>
              <strong title={currentPage.title}>{currentPage.title || getDomain(currentPage.url)}</strong>
              <span title={currentPage.savedPaths.join("、") || currentPage.url}>
                {currentPage.saved
                  ? `已收藏于 ${currentPage.savedPaths.join("、") || "根目录"}`
                  : getDomain(currentPage.url)}
              </span>
            </div>
            {currentPage.saved ? (
              <Link
                to={`/manage?search=${encodeURIComponent(sanitizeUrl(currentPage.url))}`}
                className="home-current__saved"
                title="查看或调整此书签"
              >
                <CheckCircle2 aria-hidden="true" />
                已收藏
              </Link>
            ) : (
              <button
                type="button"
                className="home-current__save"
                disabled={savingCurrent || !/^https?:\/\//i.test(currentPage.url)}
                onClick={() => void handleSaveCurrentPage()}
              >
                {savingCurrent ? <LoaderCircle className="home-action-spinner" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                {savingCurrent ? "收藏中" : "收藏"}
              </button>
            )}
          </div>
        </section>
      )}

      {target.isAnalyzingCurrent && currentPage && (
        <section className="popup-quick-card popup-quick-card--analyzing" aria-label="正在生成归档建议">
          <div className="popup-quick-card__top">
            <span className="popup-quick-card__badge">
              <LoaderCircle className="home-action-spinner" aria-hidden="true" />
              <span>当前网页 正在分析</span>
            </span>
          </div>
          <div className="popup-quick-card__identity">
            <CardFavicon title={currentPage.title} url={currentPage.url} />
            <div className="popup-quick-card__identity-main">
              <strong title={currentPage.title}>{currentPage.title || getDomain(currentPage.url)}</strong>
              <span>正在分析适合的归档目录，请稍候</span>
            </div>
          </div>
        </section>
      )}

      {!target.isAnalyzingCurrent && activeRecommendation && renderRecommendationCard(activeRecommendation)}

      {feedback && (
        <div
          className={`popup-quick-feedback popup-quick-feedback--${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          <span>{feedback.text}</span>
          {feedback.showReportLink && (
            <Link to="/report">
              查看报告
              <ChevronRight aria-hidden="true" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
