import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Bookmark,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  Clock,
  Folder,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { BookmarkBackup, BookmarkRestoreReport } from "../types";
import {
  createManualBackup,
  deleteBackup,
  getBackupHistory,
  restoreBackup,
} from "../services/backups";
import { BACKUP_HISTORY_LIMIT } from "../services/storage";
import { useAppStore } from "../store/useAppStore";

type BusyAction = "create" | "restore" | "delete" | null;

type BackupFolderSummary = {
  name: string;
  bookmarkCount: number;
  folderCount: number;
  samples: string[];
};

const BACKUP_DETAIL_FOLDER_LIMIT = 20;
const BACKUP_DETAIL_SAMPLE_LIMIT = 3;

function formatBackupTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getBackupKindLabel(kind: BookmarkBackup["kind"]) {
  if (kind === "duplicate-delete") return "重复删除前备份";
  if (kind === "manual") return "手动备份";
  if (kind === "pre-restore") return "恢复前保护点";
  return "整理前备份";
}

function buildBackupFolderSummary(backup: BookmarkBackup) {
  const summaryMap = new Map<string, BackupFolderSummary>();
  let rootBookmarkCount = 0;

  const getSummary = (name: string) => {
    const existing = summaryMap.get(name);
    if (existing) return existing;
    const nextSummary: BackupFolderSummary = {
      name,
      bookmarkCount: 0,
      folderCount: 0,
      samples: [],
    };
    summaryMap.set(name, nextSummary);
    return nextSummary;
  };

  function visit(nodes: chrome.bookmarks.BookmarkTreeNode[], path: string[]) {
    for (const node of nodes) {
      if (node.url) {
        const topFolder = path[0];
        if (!topFolder) {
          rootBookmarkCount += 1;
          continue;
        }
        const summary = getSummary(topFolder);
        summary.bookmarkCount += 1;
        if (summary.samples.length < BACKUP_DETAIL_SAMPLE_LIMIT) {
          summary.samples.push(node.title || node.url);
        }
        continue;
      }

      const nextPath = node.id === "0"
        ? []
        : [...path, node.title || "未命名文件夹"];
      if (nextPath.length > 1) {
        getSummary(nextPath[0]).folderCount += 1;
      }
      visit(node.children ?? [], nextPath);
    }
  }

  visit(backup.tree, []);

  const folders = [...summaryMap.values()]
    .sort((a, b) => b.bookmarkCount - a.bookmarkCount || a.name.localeCompare(b.name, "zh-CN"));
  return {
    folders: folders.slice(0, BACKUP_DETAIL_FOLDER_LIMIT),
    hiddenFolderCount: Math.max(0, folders.length - BACKUP_DETAIL_FOLDER_LIMIT),
    rootBookmarkCount,
  };
}

export function Backups() {
  const { bookmarks, loadAll } = useAppStore();
  const [backups, setBackups] = useState<BookmarkBackup[]>([]);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [message, setMessage] = useState("");
  const [restoreReport, setRestoreReport] = useState<BookmarkRestoreReport | null>(null);
  const [expandedBackupIds, setExpandedBackupIds] = useState<Set<string>>(new Set());

  const latestBackup = backups[0] ?? null;
  const failedItems = restoreReport?.failedItems ?? [];

  const backupStats = useMemo(() => {
    const manualCount = backups.filter((backup) => backup.kind === "manual").length;
    return {
      total: backups.length,
      manualCount,
      protectedCount: backups.filter((backup) => backup.kind === "pre-restore").length,
    };
  }, [backups]);

  const loadBackups = async () => {
    const nextBackups = await getBackupHistory();
    setBackups(nextBackups);
  };

  const toggleBackupDetail = (backupId: string) => {
    setExpandedBackupIds((prev) => {
      const next = new Set(prev);
      if (next.has(backupId)) {
        next.delete(backupId);
      } else {
        next.add(backupId);
      }
      return next;
    });
  };

  useEffect(() => {
    void loadAll();
    void loadBackups();
  }, [loadAll]);

  const handleCreateBackup = async () => {
    setBusyAction("create");
    setMessage("");
    setRestoreReport(null);
    try {
      const backup = await createManualBackup();
      await loadBackups();
      setMessage(`已创建手动备份，包含 ${backup.bookmarkCount} 个书签`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建备份失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestore = async (backup: BookmarkBackup) => {
    const detail = buildBackupFolderSummary(backup);
    const sampleFolders = detail.folders.slice(0, 3).map((folder) => folder.name).join("、") || "无顶层文件夹";
    const confirmed = confirm(
      `确认恢复到这份备份吗？\n\n备份时间：${formatBackupTime(backup.createdAt)}\n包含：${backup.bookmarkCount} 个书签、${backup.folderCount} 个文件夹\n主要文件夹：${sampleFolders}\n\n恢复前会自动保存当前状态。安全恢复不会删除备份之后新增的书签，但会尽量恢复备份中已有书签的位置、标题和链接。`
    );
    if (!confirmed) return;

    setBusyAction("restore");
    setMessage("");
    setRestoreReport(null);
    try {
      const report = await restoreBackup(backup.id);
      await Promise.all([loadAll(), loadBackups()]);
      setRestoreReport(report);
      setMessage(`恢复完成：处理 ${report.restoredCount + report.recreatedCount} 个书签，失败 ${report.failedItems.length} 个`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "恢复备份失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteBackup = async (backup: BookmarkBackup) => {
    const confirmed = confirm(
      `确认删除这份备份吗？\n\n备份时间：${formatBackupTime(backup.createdAt)}\n包含：${backup.bookmarkCount} 个书签、${backup.folderCount} 个文件夹\n\n删除后不能从 ReMarks 的备份记录中恢复这份备份。`
    );
    if (!confirmed) return;

    setBusyAction("delete");
    setMessage("");
    setRestoreReport(null);
    try {
      await deleteBackup(backup.id);
      setExpandedBackupIds((prev) => {
        const next = new Set(prev);
        next.delete(backup.id);
        return next;
      });
      await loadBackups();
      setMessage("已删除备份记录");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除备份失败");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="extension-page extension-page--backups">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">书签备份</h1>
              <p className="extension-page__subtitle">手动保存当前状态，并从最近备份安全恢复</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleCreateBackup()}
            disabled={Boolean(busyAction)}
            className="extension-page__primary-button"
          >
            <Archive className="w-4 h-4" />
            {busyAction === "create" ? "备份中" : "立即备份"}
          </button>
        </div>

        {message && (
          <div className={`extension-notice ${failedItems.length > 0 ? "extension-notice--amber" : "extension-notice--blue"}`}>
            <p>{message}</p>
          </div>
        )}

        <section className="backup-summary-grid">
          <div className="extension-section backup-summary-card backup-summary-card--blue">
            <Bookmark className="backup-summary-card__icon" />
            <span>当前书签</span>
            <strong>{bookmarks.length}</strong>
          </div>
          <div className="extension-section backup-summary-card backup-summary-card--green">
            <ShieldCheck className="backup-summary-card__icon" />
            <span>近期备份</span>
            <strong>{backupStats.total} / {BACKUP_HISTORY_LIMIT}</strong>
          </div>
          <div className="extension-section backup-summary-card backup-summary-card--amber">
            <Clock className="backup-summary-card__icon" />
            <span>最新备份</span>
            <strong>{latestBackup ? formatBackupTime(latestBackup.createdAt) : "暂无"}</strong>
          </div>
        </section>

        <section className="extension-section">
          <div className="extension-section__bar extension-section__bar--plain">
            <div>
              <h3 className="extension-section__title">近期备份记录</h3>
              <p className="backup-section-copy">
                保留最近 {BACKUP_HISTORY_LIMIT} 份；恢复不会删除备份后新增的书签。
              </p>
            </div>
            <span className="extension-pill">
              手动 {backupStats.manualCount} / 保护点 {backupStats.protectedCount}
            </span>
          </div>

          {backups.length > 0 ? (
            <div className="backup-card-list">
              {backups.map((backup, index) => {
                const isExpanded = expandedBackupIds.has(backup.id);
                const detail = buildBackupFolderSummary(backup);

                return (
                  <article key={backup.id} className="backup-card">
                    <div className="backup-card__main">
                      <div className="backup-card__topline">
                        <span className="backup-card__kind">{getBackupKindLabel(backup.kind)}</span>
                        {index === 0 && <span className="extension-pill">最新</span>}
                      </div>
                      <div className="backup-card__time">
                        <Clock className="w-3 h-3" />
                        {formatBackupTime(backup.createdAt)}
                      </div>
                      <div className="backup-card__metrics">
                        <span><Bookmark className="w-3 h-3" />{backup.bookmarkCount} 个书签</span>
                        <span><Folder className="w-3 h-3" />{backup.folderCount} 个文件夹</span>
                      </div>
                    </div>
                    <div className="backup-card__actions">
                      <button
                        type="button"
                        onClick={() => toggleBackupDetail(backup.id)}
                        className="extension-page__wide-secondary backup-card__details-toggle"
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        详情
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRestore(backup)}
                        disabled={Boolean(busyAction)}
                        className="extension-page__wide-secondary backup-card__restore"
                      >
                        <RotateCcw className="w-4 h-4" />
                        {busyAction === "restore" ? "恢复中" : "恢复"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteBackup(backup)}
                        disabled={Boolean(busyAction)}
                        className="extension-page__wide-secondary backup-card__delete"
                      >
                        <Trash2 className="w-4 h-4" />
                        {busyAction === "delete" ? "删除中" : "删除"}
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="backup-card__details">
                        {detail.rootBookmarkCount > 0 && (
                          <div className="backup-folder-summary backup-folder-summary--root">
                            <div>
                              <strong>根目录书签</strong>
                              <span>{detail.rootBookmarkCount} 个书签</span>
                            </div>
                          </div>
                        )}
                        {detail.folders.length > 0 ? (
                          <div className="backup-folder-list">
                            {detail.folders.map((folder) => (
                              <div key={folder.name} className="backup-folder-summary">
                                <div>
                                  <strong title={folder.name}>{folder.name}</strong>
                                  <span>{folder.bookmarkCount} 个书签 · {folder.folderCount} 个子文件夹</span>
                                </div>
                                {folder.samples.length > 0 && (
                                  <p>{folder.samples.join(" / ")}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : detail.rootBookmarkCount === 0 ? (
                          <div className="extension-empty extension-empty--compact">这份备份暂无可预览的书签分类</div>
                        ) : null}
                        {detail.hiddenFolderCount > 0 && (
                          <p className="backup-detail-more">还有 {detail.hiddenFolderCount} 个文件夹未展示</p>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="extension-empty extension-empty--compact">
              <Archive className="extension-empty__icon" />
              <p>暂无备份</p>
              <span>点击“立即备份”保存当前书签状态</span>
            </div>
          )}
        </section>

        {restoreReport && (
          <section className="extension-section">
            <div className="extension-section__bar extension-section__bar--plain">
              <h3 className="extension-section__title">恢复结果</h3>
              <span className="extension-pill">{formatBackupTime(restoreReport.createdAt)}</span>
            </div>
            <div className="backup-restore-metrics">
              <span><CheckCircle className="w-4 h-4" />已恢复 {restoreReport.restoredCount}</span>
              <span><Archive className="w-4 h-4" />已重建 {restoreReport.recreatedCount}</span>
              <span><Folder className="w-4 h-4" />检查文件夹 {restoreReport.folderCount}</span>
              <span><AlertTriangle className="w-4 h-4" />失败 {restoreReport.failedItems.length}</span>
            </div>
            {failedItems.length > 0 && (
              <div className="extension-compact-list backup-failed-list">
                {failedItems.map((item) => (
                  <div key={`${item.bookmarkId}-${item.reason}`} className="extension-compact-row">
                    <span>{item.bookmarkTitle}</span>
                    <span>{item.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
