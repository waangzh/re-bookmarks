import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  FileUp,
  Folder,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { BookmarkImportItem, BookmarkImportProgress, BookmarkImportReport, BookmarkImportPreview } from "../types";
import { buildBookmarkImportPreview, executeBookmarkImport } from "../services/importBookmarks";
import { useAppStore } from "../store/useAppStore";

type DetailGroup = {
  key: "ready" | "duplicate" | "invalid";
  title: string;
  description: string;
  items: BookmarkImportItem[];
};

const DETAIL_SAMPLE_LIMIT = 12;

function formatTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function importPathLabel(path: string[]) {
  return path.length ? path.join(" / ") : "导入根目录";
}

function isHtmlBookmarkFile(file: File) {
  const name = file.name.toLowerCase();
  return name.endsWith(".html") || name.endsWith(".htm") || file.type === "text/html";
}

function DetailSection({ group }: { group: DetailGroup }) {
  const [open, setOpen] = useState(group.key !== "ready");
  const sampleItems = group.items.slice(0, DETAIL_SAMPLE_LIMIT);

  if (group.items.length === 0) return null;

  return (
    <section className={`import-detail import-detail--${group.key}`}>
      <button type="button" className="import-detail__head" onClick={() => setOpen((value) => !value)}>
        <span className="import-detail__chevron">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
        <div>
          <h3>{group.title}</h3>
          <p>{group.description}</p>
        </div>
        <strong>{group.items.length}</strong>
      </button>
      {open && (
        <div className="import-detail__list">
          {sampleItems.map((item) => (
            <article key={item.id} className="import-detail-row">
              <div>
                <h4 title={item.title || item.url}>{item.title || "未命名书签"}</h4>
                <p title={item.url}>{item.url || item.reason}</p>
              </div>
              <span title={item.reason || importPathLabel(item.path)}>
                {item.reason || importPathLabel(item.path)}
              </span>
            </article>
          ))}
          {group.items.length > DETAIL_SAMPLE_LIMIT && (
            <p className="import-detail__more">还有 {group.items.length - DETAIL_SAMPLE_LIMIT} 项未展示</p>
          )}
        </div>
      )}
    </section>
  );
}

export function ImportBookmarks() {
  const { bookmarks, loadAll } = useAppStore();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [preview, setPreview] = useState<BookmarkImportPreview | null>(null);
  const [report, setReport] = useState<BookmarkImportReport | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BookmarkImportProgress>({ processed: 0, total: 0 });

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const detailGroups = useMemo<DetailGroup[]>(() => {
    if (!preview) return [];
    return [
      {
        key: "ready",
        title: "将导入",
        description: "这些书签会进入新的导入文件夹，并保留原始目录层级。",
        items: preview.items.filter((item) => item.status === "ready"),
      },
      {
        key: "duplicate",
        title: "重复跳过",
        description: "当前浏览器中已存在相同 URL，默认不再创建副本。",
        items: preview.items.filter((item) => item.status === "duplicate"),
      },
      {
        key: "invalid",
        title: "无效跳过",
        description: "标题、URL 或协议不符合导入要求。",
        items: preview.items.filter((item) => item.status === "invalid"),
      },
    ];
  }, [preview]);

  const handleFileChange = async (file: File | undefined) => {
    setMessage("");
    setReport(null);
    setPreview(null);
    setProgress({ processed: 0, total: 0 });

    if (!file) return;
    setSelectedFileName(file.name);

    if (!isHtmlBookmarkFile(file)) {
      setMessage("请选择浏览器导出的 HTML 书签文件");
      return;
    }

    setBusy(true);
    try {
      const text = await file.text();
      const nextPreview = buildBookmarkImportPreview(text, bookmarks, file.name);
      setPreview(nextPreview);
      setMessage(`已解析 ${nextPreview.bookmarkCount} 个书签，默认将导入 ${nextPreview.readyCount} 个。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "解析书签文件失败");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleReset = () => {
    setSelectedFileName("");
    setPreview(null);
    setReport(null);
    setMessage("");
    setProgress({ processed: 0, total: 0 });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleImport = async () => {
    if (!preview || preview.readyCount === 0) {
      setMessage("没有可导入的书签");
      return;
    }

    const confirmed = confirm(
      `确认导入 ${preview.readyCount} 个书签吗？\n\n目标文件夹：${preview.targetRootName}\n导入前会自动创建一份备份，重复和无效书签会跳过。`
    );
    if (!confirmed) return;

    setBusy(true);
    setMessage("");
    setReport(null);
    setProgress({ processed: 0, total: preview.readyCount });
    try {
      const nextReport = await executeBookmarkImport(preview, setProgress);
      await loadAll();
      setReport(nextReport);
      setPreview(null);
      setMessage(`导入完成：成功 ${nextReport.importedCount} 个，失败 ${nextReport.failedItems.length} 个。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入书签失败");
    } finally {
      setBusy(false);
    }
  };

  const progressPercent = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div className="extension-page extension-page--import">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">导入书签</h1>
              <p className="extension-page__subtitle">导入浏览器导出的 HTML 书签文件，先预览再写入。</p>
            </div>
          </div>
        </div>

        {message && (
          <div className={`extension-notice ${report?.failedItems.length ? "extension-notice--amber" : "extension-notice--blue"}`}>
            <p>{message}</p>
          </div>
        )}

        <section className="extension-section import-file-card">
          <div className="import-file-card__icon">
            <FileUp className="w-5 h-5" />
          </div>
          <div className="import-file-card__main">
            <h2>选择书签 HTML 文件</h2>
            <p>支持 Chrome、Edge、Firefox 导出的 bookmarks.html。文件只会在本地解析。</p>
            {selectedFileName && <span title={selectedFileName}>当前文件：{selectedFileName}</span>}
          </div>
          <label className="extension-page__wide-primary import-file-card__button">
            {busy && !report ? <RefreshCw className="w-4 h-4 import-spin" /> : <FileUp className="w-4 h-4" />}
            {busy && !report ? "处理中" : "选择文件"}
            <input
              ref={fileInputRef}
              type="file"
              accept=".html,.htm,text/html"
              disabled={busy}
              onChange={(event) => void handleFileChange(event.target.files?.[0])}
            />
          </label>
        </section>

        {preview && (
          <>
            <section className="backup-summary-grid import-summary-grid">
              <div className="extension-section backup-summary-card backup-summary-card--blue">
                <FileUp className="backup-summary-card__icon" />
                <span>将导入</span>
                <strong>{preview.readyCount}</strong>
              </div>
              <div className="extension-section backup-summary-card backup-summary-card--amber">
                <AlertTriangle className="backup-summary-card__icon" />
                <span>跳过</span>
                <strong>{preview.duplicateCount + preview.invalidCount}</strong>
              </div>
              <div className="extension-section backup-summary-card backup-summary-card--green">
                <Folder className="backup-summary-card__icon" />
                <span>文件夹</span>
                <strong>{preview.folderCount}</strong>
              </div>
            </section>

            <section className="extension-section">
              <div className="extension-section__bar extension-section__bar--plain">
                <div>
                  <h2 className="extension-section__title">导入预览</h2>
                  <p className="backup-section-copy">
                    目标文件夹：{preview.targetRootName}
                    {preview.sourceFileName ? ` · 来源：${preview.sourceFileName}` : ""}
                  </p>
                </div>
                <span className="extension-pill">{preview.bookmarkCount} 个书签</span>
              </div>
              <div className="import-detail-list">
                {detailGroups.map((group) => (
                  <DetailSection key={group.key} group={group} />
                ))}
              </div>
              {busy && progress.total > 0 && (
                <div className="bookmark-task-progress import-progress" aria-label={`导入进度 ${progressPercent}%`}>
                  <span style={{ width: `${progressPercent}%` }} />
                </div>
              )}
              <div className="import-actions">
                <button
                  type="button"
                  className="extension-page__wide-primary"
                  disabled={busy || preview.readyCount === 0}
                  onClick={() => void handleImport()}
                >
                  <ShieldCheck className="w-4 h-4" />
                  {busy ? `导入中 ${progress.processed}/${progress.total}` : "确认导入"}
                </button>
                <button type="button" className="extension-page__wide-secondary" disabled={busy} onClick={handleReset}>
                  重新选择
                </button>
              </div>
            </section>
          </>
        )}

        {report && (
          <section className="extension-section">
            <div className="extension-section__bar extension-section__bar--plain">
              <div>
                <h2 className="extension-section__title">导入结果</h2>
                <p className="backup-section-copy">导入前保护点：{formatTime(report.backupCreatedAt)}</p>
              </div>
              <span className="extension-pill">{formatTime(report.createdAt)}</span>
            </div>
            <div className="backup-restore-metrics">
              <span><CheckCircle className="w-4 h-4" />成功 {report.importedCount}</span>
              <span><AlertTriangle className="w-4 h-4" />失败 {report.failedItems.length}</span>
              <span><Folder className="w-4 h-4" />文件夹 {report.folderCount}</span>
              <span>跳过 {report.skippedCount}</span>
            </div>
            {report.failedItems.length > 0 && (
              <div className="extension-compact-list backup-failed-list">
                {report.failedItems.map((item) => (
                  <div key={`${item.itemId}-${item.reason}`} className="extension-compact-row">
                    <span>{item.title || item.url || "未命名书签"}</span>
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
