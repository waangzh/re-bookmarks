import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Bookmark,
  CheckCircle,
  Clock,
  Folder,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import type { BookmarkBackup, BookmarkRestoreReport } from "../types";
import {
  createManualBackup,
  getBackupHistory,
  restoreBackup,
} from "../services/backups";
import { BACKUP_HISTORY_LIMIT } from "../services/storage";
import { useAppStore } from "../store/useAppStore";

type BusyAction = "create" | "restore" | null;

function formatBackupTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getBackupKindLabel(kind: BookmarkBackup["kind"]) {
  if (kind === "manual") return "手动备份";
  if (kind === "pre-restore") return "恢复前保护点";
  return "整理前备份";
}

export function Backups() {
  const { bookmarks, loadAll } = useAppStore();
  const [backups, setBackups] = useState<BookmarkBackup[]>([]);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [message, setMessage] = useState("");
  const [restoreReport, setRestoreReport] = useState<BookmarkRestoreReport | null>(null);

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
    const confirmed = confirm(
      "确认恢复到这份备份吗？\n\n恢复前会自动保存当前状态。安全恢复不会删除备份之后新增的书签，但会尽量恢复备份中已有书签的位置、标题和链接。"
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
              {backups.map((backup, index) => (
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
                  <button
                    type="button"
                    onClick={() => void handleRestore(backup)}
                    disabled={Boolean(busyAction)}
                    className="extension-page__wide-secondary backup-card__restore"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {busyAction === "restore" ? "恢复中" : "恢复"}
                  </button>
                </article>
              ))}
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
