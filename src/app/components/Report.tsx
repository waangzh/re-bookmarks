import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, CheckCircle, Folder, FileText, RotateCcw, Trash2 } from "lucide-react";
import { undoLastOrganize } from "../services/organizer";
import { useAppStore } from "../store/useAppStore";

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function Report() {
  const { lastReport, loadReport, loadAll } = useAppStore();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const folderCounts = useMemo(
    () =>
      (lastReport?.movePlan ?? []).reduce((acc, plan) => {
        const key = plan.toFolderPath.join(" / ");
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    [lastReport]
  );

  const handleUndo = async () => {
    if (!confirm("确认要撤销本次整理吗？书签将恢复到整理前的位置。")) return;
    setBusy(true);
    try {
      await undoLastOrganize();
      await loadAll();
      setMessage("已尝试撤销最近一次整理");
    } finally {
      setBusy(false);
    }
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
    <div className="extension-page">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">整理报告</h1>
              <p className="extension-page__subtitle">{lastReport.undone ? "最近一次撤销结果" : "最近一次整理结果"}</p>
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
              <div className="extension-metric__label">已移动</div>
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
          <div className="extension-compact-list">
            {Object.entries(folderCounts).map(([path, count]) => (
              <div key={path} className="extension-compact-row">
                <div className="extension-compact-row__main">
                  <Folder className="w-4 h-4" />
                  <span>{path}</span>
                </div>
                <span className="extension-pill">{count} 个</span>
              </div>
            ))}
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

        <section className="extension-section">
          <h3 className="extension-section__title">隐私说明</h3>
          <ul className="extension-copy-list">
            {lastReport.privacySummary.map((item) => (
              <li key={item}>· {item}</li>
            ))}
          </ul>
        </section>

        {!lastReport.undone && (
          <button onClick={handleUndo} disabled={busy} className="extension-page__wide-secondary">
            <RotateCcw className="w-5 h-5" />
            {busy ? "撤销中" : "撤销本次整理"}
          </button>
        )}

        <Link to="/" className="extension-page__wide-primary">
          返回首页
        </Link>
      </div>
    </div>
  );
}
