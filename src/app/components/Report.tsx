import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import {
  ArrowLeft,
  Bookmark,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { MovePlan } from "../types";
import { reapplyLastOrganize, undoLastOrganize } from "../services/organizer";
import { useAppStore } from "../store/useAppStore";

type BusyAction = "undo" | "reapply" | null;

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

export function Report() {
  const { lastReport, loadReport, loadAll } = useAppStore();
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [message, setMessage] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  useEffect(() => {
    setExpandedFolders(new Set());
  }, [lastReport?.id]);

  const targetTree = useMemo(
    () => buildTargetFolderTree(lastReport?.movePlan ?? []),
    [lastReport?.movePlan]
  );

  const skippedFolderCleanup = lastReport?.skippedFolderCleanup ?? [];

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
    if (!confirm("确认要撤销本次整理吗？书签将恢复到整理前的位置。")) return;
    setBusyAction("undo");
    try {
      await undoLastOrganize();
      await loadAll();
      setMessage("已撤销最近一次整理，并清理空的目标文件夹");
    } finally {
      setBusyAction(null);
    }
  };

  const handleReapply = async () => {
    if (!confirm("确认要重新应用上次智能整理吗？将按上次分类结果移动书签，不会重新调用 AI。")) return;
    setBusyAction("reapply");
    try {
      await reapplyLastOrganize();
      await loadAll();
      setMessage("已重新应用上次智能整理");
    } finally {
      setBusyAction(null);
    }
  };

  const renderBookmarkRow = (plan: MovePlan, depth: number) => (
    <div
      key={plan.bookmarkId}
      className="report-target-tree-row report-target-tree-row--bookmark"
      style={{ "--tree-depth": depth } as CSSProperties}
    >
      <span className="report-target-tree-row__spacer" />
      <Bookmark className="report-target-tree-row__bookmark-icon" />
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
        {plan.bookmarkUrl && <p className="report-target-tree-row__url">{plan.bookmarkUrl}</p>}
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

  if (!lastReport) {
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
            <span>完成一次整理后会在这里显示结果</span>
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
              <p className="extension-page__subtitle">
                {lastReport.undone ? "最近一次撤销结果" : "最近一次整理结果"}
              </p>
            </div>
          </div>
        </div>

        <section className="extension-success">
          <CheckCircle className="extension-success__icon" />
          <div>
            <h2>{lastReport.undone ? "撤销完成" : "整理完成"}</h2>
            <p>{message || "结果已保存到本地报告"}</p>
          </div>
        </section>

        {lastReport.tokenUsage && (
          <div className="token-usage-highlight" aria-label="本次智能整理 token 消耗">
            <span className="token-usage-highlight__label">Token 消耗</span>
            <strong>{formatTokenCount(lastReport.tokenUsage.totalTokens)}</strong>
            <span>
              输入 {formatTokenCount(lastReport.tokenUsage.promptTokens)} / 输出{" "}
              {formatTokenCount(lastReport.tokenUsage.completionTokens)}
            </span>
          </div>
        )}

        <section className="extension-section">
          <h3 className="extension-section__title">整理统计</h3>
          <div className="extension-metrics">
            <div className="extension-metric">
              <FileText className="extension-metric__icon extension-metric__icon--blue" />
              <div className="extension-metric__value">{lastReport.movedCount}</div>
              <div className="extension-metric__label">{lastReport.undone ? "已恢复" : "已移动"}</div>
            </div>
            <div className="extension-metric">
              <Folder className="extension-metric__icon extension-metric__icon--green" />
              <div className="extension-metric__value">{lastReport.folderCount}</div>
              <div className="extension-metric__label">文件夹</div>
            </div>
            {lastReport.removedFolders ? (
              <div className="extension-metric">
                <Trash2 className="extension-metric__icon extension-metric__icon--red" />
                <div className="extension-metric__value">{lastReport.removedFolders}</div>
                <div className="extension-metric__label">已清理</div>
              </div>
            ) : null}
            <div className="extension-metric">
              <CheckCircle className="extension-metric__icon" />
              <div className="extension-metric__value">{lastReport.failedItems.length}</div>
              <div className="extension-metric__label">失败</div>
            </div>
          </div>
        </section>

        <section className="extension-section">
          <h3 className="extension-section__title">目标文件夹</h3>
          <div className="report-target-tree">
            {targetTree.children.map((folder) => renderFolderNode(folder))}
          </div>
        </section>

        {lastReport.failedItems.length > 0 && (
          <section className="extension-section">
            <h3 className="extension-section__title">失败明细</h3>
            <div className="extension-compact-list">
              {lastReport.failedItems.map((item) => (
                <div key={item.bookmarkId} className="extension-compact-row">
                  <span>{item.bookmarkTitle}</span>
                  <span>{item.reason}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {skippedFolderCleanup.length > 0 && (
          <section className="extension-section">
            <h3 className="extension-section__title">未清理的目标文件夹</h3>
            <div className="extension-compact-list">
              {skippedFolderCleanup.map((item) => (
                <div key={item.bookmarkId} className="extension-compact-row">
                  <span>{item.bookmarkTitle}</span>
                  <span>{item.reason}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="extension-section">
          <h3 className="extension-section__title">隐私说明</h3>
          <ul className="extension-copy-list">
            {lastReport.privacySummary.map((item) => (
              <li key={item}>· {item}</li>
            ))}
          </ul>
        </section>

        <div className="report-actions">
          {!lastReport.undone ? (
            <button onClick={handleUndo} disabled={Boolean(busyAction)} className="extension-page__wide-secondary">
              <RotateCcw className="w-5 h-5" />
              {busyAction === "undo" ? "撤销中" : "撤销本次整理"}
            </button>
          ) : (
            <button onClick={handleReapply} disabled={Boolean(busyAction)} className="extension-page__wide-primary">
              <RotateCcw className="w-5 h-5" />
              {busyAction === "reapply" ? "重新应用中" : "重新应用本次整理"}
            </button>
          )}

          <Link to="/" className="extension-page__wide-primary">
            返回首页
          </Link>
        </div>
      </div>
    </div>
  );
}
