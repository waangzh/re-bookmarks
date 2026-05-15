import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import {
  ArrowLeft,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  Folder,
  Globe2,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { MovePlan, OrganizeReport } from "../types";
import { reapplyLastOrganize, undoLastOrganize } from "../services/organizer";
import { getBookmarkFaviconUrl } from "../services/bookmarks";
import { REPORT_HISTORY_LIMIT } from "../services/storage";
import { useAppStore } from "../store/useAppStore";
import { CollapsibleSection } from "./CollapsibleSection";

type BusyAction = "undo" | "reapply" | null;
type ReportKind = NonNullable<OrganizeReport["kind"]>;

type ReportTargetFolderNode = {
  key: string;
  title: string;
  path: string[];
  count: number;
  children: ReportTargetFolderNode[];
  bookmarks: MovePlan[];
};

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatReportTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function getReportKind(report: OrganizeReport): ReportKind {
  return report.kind ?? (report.undone ? "undo" : "organize");
}

function getReportKindMeta(report: OrganizeReport) {
  const kind = getReportKind(report);
  if (kind === "undo") {
    return {
      kind,
      label: "撤销",
      title: "撤销完成",
      subtitle: "已按最近一次备份尝试恢复书签位置",
      movedLabel: "已恢复",
    };
  }

  if (kind === "reapply") {
    return {
      kind,
      label: "重新应用",
      title: "重新应用完成",
      subtitle: "已按最近一次分类结果重新移动书签",
      movedLabel: "已移动",
    };
  }

  return {
    kind,
    label: "整理",
    title: "整理完成",
    subtitle: "结果已保存到本地报告历史",
    movedLabel: "已移动",
  };
}

function folderKey(path: string[]) {
  return path.join("/") || "__root__";
}

function createFolderNode(title: string, path: string[]): ReportTargetFolderNode {
  return {
    key: folderKey(path),
    title,
    path,
    count: 0,
    children: [],
    bookmarks: [],
  };
}

function buildTargetFolderTree(plans: MovePlan[]) {
  const root = createFolderNode("目标文件夹", []);
  const folderMap = new Map<string, ReportTargetFolderNode>([[root.key, root]]);

  for (const plan of plans) {
    const targetPath = plan.toFolderPath.length ? plan.toFolderPath : ["待整理"];
    let current = root;

    targetPath.forEach((folderName, index) => {
      const path = targetPath.slice(0, index + 1);
      const key = folderKey(path);
      let folder = folderMap.get(key);

      if (!folder) {
        folder = createFolderNode(folderName, path);
        folderMap.set(key, folder);
        current.children.push(folder);
      }

      folder.count += 1;
      current = folder;
    });

    current.bookmarks.push(plan);
  }

  const sortTree = (node: ReportTargetFolderNode) => {
    node.children.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    node.bookmarks.sort((a, b) => a.bookmarkTitle.localeCompare(b.bookmarkTitle, "zh-CN"));
    node.children.forEach(sortTree);
  };

  sortTree(root);
  return root;
}

function getConfidenceClass(confidence: number) {
  if (confidence >= 0.9) return "text-green-600 bg-green-50";
  if (confidence >= 0.8) return "text-blue-600 bg-blue-50";
  return "text-amber-600 bg-amber-50";
}

function BookmarkFavicon({ title, url }: { title: string; url?: string }) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = url && !failed ? getBookmarkFaviconUrl(url) : "";

  return (
    <span className="extension-favicon report-target-tree-row__favicon" aria-hidden="true" title={title}>
      <Globe2 className="extension-favicon__fallback" />
      {faviconUrl && (
        <img
          src={faviconUrl}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function Report() {
  const { reportHistory, loadReports, loadAll } = useAppStore();
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [message, setMessage] = useState("");
  const [historyOpen, setHistoryOpen] = useState(true);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  useEffect(() => {
    const latestId = reportHistory[0]?.id ?? null;
    if (!latestId) {
      setSelectedReportId(null);
      return;
    }

    if (!selectedReportId || !reportHistory.some((report) => report.id === selectedReportId)) {
      setSelectedReportId(latestId);
    }
  }, [reportHistory, selectedReportId]);

  const selectedReport = useMemo(
    () => reportHistory.find((report) => report.id === selectedReportId) ?? reportHistory[0] ?? null,
    [reportHistory, selectedReportId]
  );

  useEffect(() => {
    setExpandedFolders(new Set());
  }, [selectedReport?.id]);

  const targetTree = useMemo(
    () => buildTargetFolderTree(selectedReport?.movePlan ?? []),
    [selectedReport?.movePlan]
  );

  const isLatestReport = Boolean(selectedReport && reportHistory[0]?.id === selectedReport.id);
  const skippedFolderCleanup = selectedReport?.skippedFolderCleanup ?? [];
  const selectedMeta = selectedReport ? getReportKindMeta(selectedReport) : null;

  const toggleFolder = (key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleUndo = async () => {
    if (!selectedReport || !isLatestReport) return;
    if (!confirm("确认要撤销最近一次整理吗？书签将恢复到整理前的位置。")) return;
    setBusyAction("undo");
    try {
      await undoLastOrganize();
      setSelectedReportId(null);
      await loadAll();
      setMessage("已撤销最近一次整理，并清理空的目标文件夹");
    } finally {
      setBusyAction(null);
    }
  };

  const handleReapply = async () => {
    if (!selectedReport || !isLatestReport) return;
    if (!confirm("确认要重新应用最近一次智能整理吗？将按最近一次分类结果移动书签，不会重新调用 AI。")) return;
    setBusyAction("reapply");
    try {
      await reapplyLastOrganize();
      setSelectedReportId(null);
      await loadAll();
      setMessage("已重新应用最近一次智能整理");
    } finally {
      setBusyAction(null);
    }
  };

  const renderHistoryCard = (report: OrganizeReport, index: number) => {
    const meta = getReportKindMeta(report);
    const selected = selectedReport?.id === report.id;

    return (
      <button
        key={report.id}
        type="button"
        className={`report-history-card report-history-card--${meta.kind}${selected ? " report-history-card--active" : ""}`}
        onClick={() => {
          setSelectedReportId(report.id);
          setMessage("");
        }}
      >
        <span className="report-history-card__rail" aria-hidden="true" />
        <span className="report-history-card__dot" aria-hidden="true" />
        <span className="report-history-card__body">
          <span className="report-history-card__topline">
            <span className="report-history-card__kind">{meta.label}</span>
            {index === 0 && <span className="extension-pill">最新</span>}
          </span>
          <span className="report-history-card__time">
            <Clock className="w-3 h-3" />
            {formatReportTime(report.createdAt)}
          </span>
          <span className="report-history-card__metrics">
            <span>{report.movedCount} 个</span>
            <span>{report.folderCount} 个文件夹</span>
            <span>{report.failedItems.length} 失败</span>
            {report.tokenUsage && <span>{formatTokenCount(report.tokenUsage.totalTokens)} tokens</span>}
          </span>
        </span>
      </button>
    );
  };

  const renderBookmarkRow = (plan: MovePlan, depth: number) => (
    <div
      key={plan.bookmarkId}
      className="report-target-tree-row report-target-tree-row--bookmark"
      style={{ "--tree-depth": depth } as CSSProperties}
    >
      <span className="report-target-tree-row__spacer" />
      <BookmarkFavicon title={plan.bookmarkTitle} url={plan.bookmarkUrl} />
      <div className="report-target-tree-row__main">
        <div className="report-target-tree-row__title-line">
          <span title={plan.bookmarkTitle}>{plan.bookmarkTitle}</span>
          {plan.bookmarkUrl && (
            <a
              href={plan.bookmarkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="extension-link-icon"
              aria-label="打开书签"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        {plan.reason && <p className="report-target-tree-row__reason">{plan.reason}</p>}
      </div>
      <span className={`extension-confidence ${getConfidenceClass(plan.confidence)}`}>
        {Math.round(plan.confidence * 100)}%
      </span>
    </div>
  );

  const renderFolderNode = (folder: ReportTargetFolderNode, depth = 0) => {
    const isExpanded = expandedFolders.has(folder.key);
    const hasChildren = folder.children.length > 0 || folder.bookmarks.length > 0;

    return (
      <div key={folder.key}>
        <button
          type="button"
          className="report-target-tree-row report-target-tree-row--folder"
          style={{ "--tree-depth": depth } as CSSProperties}
          aria-expanded={isExpanded}
          onClick={() => toggleFolder(folder.key)}
        >
          <span className="report-target-tree-row__chevron">
            {hasChildren ? (
              isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
            ) : null}
          </span>
          <Folder className="report-target-tree-row__folder-icon" />
          <span className="report-target-tree-row__title" title={folder.path.join(" / ")}>
            {folder.title}
          </span>
          <span className="extension-pill">{folder.count} 个</span>
        </button>

        {isExpanded && (
          <>
            {folder.children.map((child) => renderFolderNode(child, depth + 1))}
            {folder.bookmarks.map((plan) => renderBookmarkRow(plan, depth + 1))}
          </>
        )}
      </div>
    );
  };

  if (!selectedReport || !selectedMeta) {
    return (
      <div className="extension-page">
        <div className="extension-page__inner">
          <div className="extension-page__header">
            <div className="extension-page__heading">
              <Link to="/" className="extension-page__back" aria-label="返回">
                <ArrowLeft className="extension-page__back-icon" />
              </Link>
              <div>
                <h1 className="extension-page__title">整理报告</h1>
                <p className="extension-page__subtitle">暂无最近整理结果</p>
              </div>
            </div>
          </div>
          <div className="extension-empty">
            <p>暂无整理报告</p>
            <span>完成一次整理后会在这里显示最近 {REPORT_HISTORY_LIMIT} 次结果</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="extension-page extension-page--report">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">整理报告</h1>
              <p className="extension-page__subtitle">最近 {Math.min(reportHistory.length, REPORT_HISTORY_LIMIT)} 次整理操作</p>
            </div>
          </div>
        </div>

        <section className="extension-section report-history">
          <button
            type="button"
            className="report-history__head"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <span className="report-history__title">
              {historyOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              <span className="extension-section__title">报告历史</span>
            </span>
            <span className="extension-pill">
              {reportHistory.length} / {REPORT_HISTORY_LIMIT}
            </span>
          </button>
          {historyOpen && (
            <div className="report-history__list">
              {reportHistory.map((report, index) => renderHistoryCard(report, index))}
            </div>
          )}
        </section>

        <section className="extension-success">
          <CheckCircle className="extension-success__icon" />
          <div>
            <h2>{selectedMeta.title}</h2>
            <p>{message && isLatestReport ? message : isLatestReport ? selectedMeta.subtitle : "历史报告仅用于查看，撤销和重新应用只支持最新一次操作"}</p>
          </div>
        </section>

        {selectedReport.tokenUsage && (
          <div className="token-usage-highlight" aria-label="本次智能整理 token 消耗">
            <span className="token-usage-highlight__label">Token 消耗</span>
            <strong>{formatTokenCount(selectedReport.tokenUsage.totalTokens)}</strong>
            <span>
              输入 {formatTokenCount(selectedReport.tokenUsage.promptTokens)} / 输出{" "}
              {formatTokenCount(selectedReport.tokenUsage.completionTokens)}
            </span>
          </div>
        )}

        <section className="extension-section">
          <h3 className="extension-section__title">整理统计</h3>
          <div className="extension-metrics">
            <div className="extension-metric">
              <FileText className="extension-metric__icon extension-metric__icon--blue" />
              <div className="extension-metric__value">{selectedReport.movedCount}</div>
              <div className="extension-metric__label">{selectedMeta.movedLabel}</div>
            </div>
            <div className="extension-metric">
              <Folder className="extension-metric__icon extension-metric__icon--green" />
              <div className="extension-metric__value">{selectedReport.folderCount}</div>
              <div className="extension-metric__label">文件夹</div>
            </div>
            {selectedReport.removedFolders ? (
              <div className="extension-metric">
                <Trash2 className="extension-metric__icon extension-metric__icon--red" />
                <div className="extension-metric__value">{selectedReport.removedFolders}</div>
                <div className="extension-metric__label">已清理</div>
              </div>
            ) : null}
            <div className="extension-metric">
              <CheckCircle className="extension-metric__icon" />
              <div className="extension-metric__value">{selectedReport.failedItems.length}</div>
              <div className="extension-metric__label">失败</div>
            </div>
          </div>
        </section>

        <section className="extension-section">
          <h3 className="extension-section__title">目标文件夹</h3>
          <div className="report-target-tree">
            {targetTree.children.length > 0 ? (
              targetTree.children.map((folder) => renderFolderNode(folder))
            ) : (
              <div className="extension-empty extension-empty--compact">暂无移动计划</div>
            )}
          </div>
        </section>

        {selectedReport.failedItems.length > 0 && (
          <CollapsibleSection title="失败明细" count={selectedReport.failedItems.length} hint="查看未完成移动的书签和原因">
            <div className="extension-compact-list">
              {selectedReport.failedItems.map((item) => (
                <div key={item.bookmarkId} className="extension-compact-row">
                  <span>{item.bookmarkTitle}</span>
                  <span>{item.reason}</span>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {skippedFolderCleanup.length > 0 && (
          <CollapsibleSection title="未清理的目标文件夹" count={skippedFolderCleanup.length} hint="查看本次保留的文件夹和原因">
            <div className="extension-compact-list">
              {skippedFolderCleanup.map((item) => (
                <div key={item.bookmarkId} className="extension-compact-row">
                  <span>{item.bookmarkTitle}</span>
                  <span>{item.reason}</span>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        <CollapsibleSection title="隐私说明" hint="查看本次整理的数据使用和备份范围">
          <ul className="extension-copy-list">
            {selectedReport.privacySummary.map((item) => (
              <li key={item}>· {item}</li>
            ))}
          </ul>
        </CollapsibleSection>

        {!isLatestReport && (
          <div className="extension-notice extension-notice--blue">
            <p>这是历史报告，只用于查看。撤销和重新应用仅支持最新一次操作。</p>
          </div>
        )}

        <div className={`report-actions${isLatestReport ? "" : " report-actions--single"}`}>
          {isLatestReport && (
            selectedMeta.kind === "undo" ? (
              <button onClick={handleReapply} disabled={Boolean(busyAction)} className="extension-page__wide-primary">
                <RotateCcw className="w-5 h-5" />
                {busyAction === "reapply" ? "重新应用中" : "重新应用本次整理"}
              </button>
            ) : (
              <button onClick={handleUndo} disabled={Boolean(busyAction)} className="extension-page__wide-secondary">
                <RotateCcw className="w-5 h-5" />
                {busyAction === "undo" ? "撤销中" : "撤销本次整理"}
              </button>
            )
          )}

          <Link to="/" className="extension-page__wide-primary">
            返回首页
          </Link>
        </div>
      </div>
    </div>
  );
}
