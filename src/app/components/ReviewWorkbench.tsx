import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, Check, ChevronDown, FileText, Folder, FolderPlus, ShieldCheck } from "lucide-react";
import type { MovePlan, PreviewBatchGroup, PreviewFrameworkDecision, PreviewPlanDecision, PreviewRiskItem, Settings, TokenUsage } from "../types";
import { buildPreviewRiskAnalysis, derivePreviewReview, pathKey } from "../services/previewReview";
import { getPlanSummary } from "../services/previewSafety";
import { PreviewDialog } from "./PreviewDialog";

type Analysis = ReturnType<typeof buildPreviewRiskAnalysis>;
type Review = ReturnType<typeof derivePreviewReview>;
type Props = {
  analysis: Analysis;
  review: Review;
  groups: PreviewBatchGroup[];
  frameworks: Record<string, PreviewFrameworkDecision>;
  busy: boolean;
  cacheMessage: string;
  summary: ReturnType<typeof getPlanSummary>;
  tree: ReactNode;
  treeQuery: string;
  onTreeQuery: (query: string) => void;
  folderCount: number;
  tokenUsage?: TokenUsage;
  model: string;
  unclassifiedHandling: Settings["unclassifiedHandling"];
  onDecision: (ids: string[], decision: PreviewPlanDecision) => void;
  onFramework: (group: Analysis["frameworkGroups"][number], decision: PreviewFrameworkDecision) => void;
  onEdit: (plan: MovePlan) => void;
  onRegenerate: () => void;
  onConfirm: () => void;
  onKeepRemaining: () => void;
};

const matches = (item: PreviewRiskItem, query: string) =>
  [item.plan.bookmarkTitle, item.plan.bookmarkUrl, pathKey(item.sourcePath), pathKey(item.plan.toFolderPath)]
    .join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

const reviewReasonLabels: Record<string, string> = {
  "将跨一级目录移动": "跨一级目录",
  "模型提供的分类依据较弱": "分类依据较弱",
  "目标属于拟新增一级文件夹": "拟新增一级目录",
  "与用户明确固定的域名规则冲突，需要单独确认": "固定域名规则冲突",
  "该分类曾被你明确拒绝，需要单独确认": "曾明确拒绝此分类",
};

function Progress({ label, done, total }: { label: string; done: number; total: number }) {
  return <div className="review-progress">
    <p><span>{label}</span><span>{done} / {total}</span></p>
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={Math.max(total, 1)}
      aria-valuenow={total ? done : 1} aria-valuetext={total ? `已完成 ${done} / ${total}` : "无需审核"}>
      <span style={{ width: `${total ? done / total * 100 : 100}%` }} />
    </div>
  </div>;
}

export function ReviewWorkbench(props: Props) {
  const { analysis, review, groups, frameworks, busy, onDecision, onEdit } = props;
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [keepOpen, setKeepOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const workspace = useRef<HTMLDivElement>(null);
  const awaiting = new Set(review.pending.map((item) => item.plan.bookmarkId));
  const pendingFrameworks = review.pendingFrameworks.length;
  const pendingCount = review.pending.length;
  const remaining = pendingCount > 0 || pendingFrameworks > 0;
  const decisionItems = review.items.filter((item) => item.level !== "auto" && item.level !== "keep");
  const activeGroups = groups.filter((group) => group.items.some((item) => awaiting.has(item.plan.bookmarkId)));
  const activeReview = analysis.review.filter((item) => awaiting.has(item.plan.bookmarkId) &&
    !analysis.frameworkGroups.some((group) => group.items.includes(item) && frameworks[group.key] !== "approve"));
  const visibleReview = showAll ? activeReview : activeReview.slice(0, 2);
  const safeItems = review.items.filter((item) => item.level === "auto" || item.level === "keep");
  const decidedItems = review.items.filter((item) => !awaiting.has(item.plan.bookmarkId));
  const weakCount = analysis.keep.filter((item) => item.plan.source !== "manual" && item.plan.confidence < 0.55).length;

  const decide = (ids: string[], choice: PreviewPlanDecision) => {
    onDecision(ids, choice);
    setNotice(choice === "move" ? "已加入待执行清单，尚未移动书签。" : "已保留在原目录。");
  };
  const continueReview = () => {
    if (!remaining) { props.onConfirm(); return; }
    setShowAll(true);
    // 展开隐藏条目后定位到真正的下一项，并将键盘焦点移入工作区。
    window.requestAnimationFrame(() => {
      const next = workspace.current?.querySelector<HTMLElement>("[data-review-pending]");
      next?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
      next?.focus({ preventScroll: true });
    });
  };
  const renderItem = (item: PreviewRiskItem, editable = true) => {
    const { plan } = item;
    const choice = review.effective[plan.bookmarkId];
    const riskLabels = item.level === "review"
      ? item.reasons.map((reason) => reviewReasonLabels[reason] ?? reason)
      : [];
    return <article key={plan.bookmarkId} className="review-card review-item" tabIndex={-1}
      data-review-pending={awaiting.has(plan.bookmarkId) ? "" : undefined}
      aria-label={`${plan.bookmarkTitle}，${choice === "move" ? "已批准移动" : choice === "keep" ? "确定保留" : "待决定"}`}>
      <div className="review-card__top">
        <div className="review-card__labels">
          {choice && <span className="review-tag review-tag--safe">{choice === "move" ? "已批准移动" : "确定保留"}</span>}
          {riskLabels.map((label) => <span key={label} className="review-tag review-tag--risk">{label}</span>)}
          {!choice && riskLabels.length === 0 && <span className="review-tag">一级目录内调整</span>}
        </div>
        <FileText size={16} aria-hidden="true" />
      </div>
      <h3>{plan.bookmarkTitle}</h3>
      {plan.bookmarkUrl && <a className="review-url" href={plan.bookmarkUrl} target="_blank" rel="noopener noreferrer">{plan.bookmarkUrl}</a>}
      <div className="review-route">
        <div><span>原位</span><strong>{pathKey(item.sourcePath) || "当前根目录"}</strong></div>
        <div><span>建议</span><strong>{pathKey(plan.toFolderPath) || "保持原位"}</strong></div>
      </div>
      {!choice && <p className={item.level === "review" ? "review-risk-note" : "review-muted"}>{item.reasons.join("；")}</p>}
      <div className="review-item__tools">
        <details className="review-evidence">
          <summary>查看依据 <ChevronDown size={14} /></summary>
          <p>{item.reasons.join("；")}</p>
          {plan.reason && <p>{plan.reason}</p>}
          <p>{plan.source === "manual" ? "来源：人工修改，仍需确认此次移动。" : `来源：${plan.source === "rule" ? "分类规则" : "AI 建议"}。模型自评 ${Number.isFinite(plan.confidence) ? plan.confidence.toFixed(2) : "未知"}，仅作排序参考，不代表正确率。`}</p>
        </details>
        <button type="button" className="review-text-button" disabled={busy} onClick={() => onEdit(plan)}>修改目标目录 <ArrowRight size={14} /></button>
      </div>
      {editable && <div className="review-actions" aria-label={`${plan.bookmarkTitle} 的处理方式`}>
        <button type="button" className={choice === "keep" ? "is-selected" : ""} aria-pressed={choice === "keep"}
          disabled={busy} onClick={() => decide([plan.bookmarkId], "keep")}>保留原位</button>
        {item.level !== "keep" && <button type="button" className={choice === "move" ? "is-selected" : "review-primary"}
          aria-pressed={choice === "move"} disabled={busy} onClick={() => decide([plan.bookmarkId], "move")}>同意移动</button>}
      </div>}
    </article>;
  };

  return <div className="review-workbench">
    <p className="review-intro">把注意力留给真正需要判断的变更。</p>
    <div className="review-promise"><ShieldCheck size={18} /><p><strong>整理前不会改动书签。</strong>低依据建议默认保留原位，只有已批准的移动才进入最终执行清单。</p></div>
    <section className="review-overview" aria-label="变更概览">
      <p>本次方案 · 共 {review.total} 条有效书签</p>
      <div className="review-metrics">
        <div><strong>{review.approvedPlans.length}</strong><span>已批准移动</span></div>
        <div><strong>{review.keepCount}</strong><span>确定保留</span></div>
        <div><strong>{pendingCount}</strong><span>待你决定</span></div>
      </div>
      <div className="review-overview__foot"><span>原建议移动 {props.summary.moveCount} 条</span><span>低依据 {weakCount} 条已安全保留</span></div>
    </section>

    <div className="review-queue" ref={workspace} aria-busy={busy}>
      <div className="review-section-heading"><h2>需要你的判断</h2><span className="review-tag">{remaining ? `${pendingCount} 条待决定` : "审核已完成"}</span></div>
      {analysis.frameworkGroups.length > 0 && <Progress label="目录结构" done={analysis.frameworkGroups.length - pendingFrameworks} total={analysis.frameworkGroups.length} />}
      <Progress label="书签变更" done={decisionItems.length - pendingCount} total={decisionItems.length} />
      <p className="review-muted">目录与书签分别确认 · 支持中途离开后继续</p>
      {review.pendingFrameworks.map((group) => <article key={group.key} className="review-card" tabIndex={-1} data-review-pending="" aria-label={`新一级目录 ${group.topLevel}`}>
        <span className="review-tag"><FolderPlus size={13} /> 新一级目录</span>
        <h3>{group.topLevel}</h3>
        <p className="review-muted">{group.items.length} 条建议 · {group.targetPathCount} 个目标目录</p>
        <div className="review-route">{[...new Set(group.items.map((item) => pathKey(item.plan.toFolderPath)))].map((path) => <div key={path}><Folder size={14} /><strong>{path}</strong></div>)}</div>
        <p className="review-muted">采用目录只确认结构，其中的书签仍需独立审核。</p>
        <div className="review-actions">
          <button type="button" disabled={busy} onClick={() => props.onFramework(group, "keep")}>不采用，保留原位</button>
          <button type="button" disabled={busy} className="review-primary" onClick={() => props.onFramework(group, "approve")}>采用此目录</button>
        </div>
        <details className="review-evidence"><summary>调整目录名与层级 <ChevronDown size={14} /></summary>
          <p>逐条修改建议路径后，重新确认新的目录结构。</p>
          {group.items.map((item) => <button className="review-text-button" key={item.plan.bookmarkId} disabled={busy} onClick={() => onEdit(item.plan)}>修改 {item.plan.bookmarkTitle} 的目标</button>)}
        </details>
      </article>)}
      {activeGroups.map((group) => {
        const items = group.items.filter((item) => awaiting.has(item.plan.bookmarkId));
        if (items.length === 1) return renderItem(items[0]);
        const sampleIndexes = [...new Set([0, Math.floor((items.length - 1) / 2), items.length - 1])];
        return <article className="review-card" key={group.key} tabIndex={-1} data-review-pending="" aria-label={`批量审核 ${group.key}`}>
          <span className="review-tag">批量审核</span>
          <div className="review-card__title"><span className="review-folder-icon"><Folder size={18} /></span><div><h3>{items.length} 条书签建议归入同一目录</h3><p className="review-muted">目标：{pathKey(group.targetPath)}</p></div></div>
          <div className="review-route">{sampleIndexes.map((index, i) => <div key={index}><span>{i === 0 ? "典型" : i === sampleIndexes.length - 1 ? "较弱" : "边界"}</span><strong>{items[index].plan.bookmarkTitle}</strong></div>)}</div>
          <div className="review-actions">
            <button type="button" disabled={busy} onClick={() => decide(items.map((item) => item.plan.bookmarkId), "keep")}>保留原位</button>
            <button type="button" disabled={busy} className="review-primary" onClick={() => decide(items.map((item) => item.plan.bookmarkId), "move")}>批量接受（{items.length} 条）</button>
          </div>
          <details className="review-evidence"><summary>查看分组依据与全部条目 <ChevronDown size={14} /></summary>
            <p>按同一目标目录分组，模型自评仅作排序参考。跨一级目录项目独立处理。</p>
            {items.map((item) => renderItem(item))}
          </details>
        </article>;
      })}
      {activeReview.length > 0 && <>
        <div className="review-section-heading"><h2>逐项判断</h2><span className="review-tag review-tag--risk">{activeReview.length} 条待决定</span></div>
        <p className="review-muted">跨一级目录或偏好冲突需逐项确认，未批准的移动不会执行。</p>
        {visibleReview.map((item) => renderItem(item))}
        {activeReview.length > 2 && <button type="button" className="review-fold" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? "收起其余建议" : `查看其余 ${activeReview.length - 2} 条审核建议`} <ChevronDown size={14} />
        </button>}
      </>}
      {!remaining && <div className="review-complete"><Check size={20} /><div><strong>所有建议均已处理</strong><p>检查实际移动清单后，再确认执行。</p></div></div>}
    </div>

    <details className="review-safe">
      <summary><ShieldCheck size={20} /><span><strong>已安全处理的建议</strong><small>低风险 {analysis.auto.length} 条 · 默认保留 {analysis.keep.length} 条</small></span><ChevronDown size={16} /></summary>
      <p className="review-muted">低风险建议复用现有目录、符合已有分类习惯且未跨一级目录。所有条目均可检查。</p>
      <label className="review-search"><span>搜索安全建议</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题、URL 或目录" /></label>
      {analysis.auto.some((item) => review.effective[item.plan.bookmarkId] === "move") && <button className="review-text-button" disabled={busy}
        onClick={() => decide(analysis.auto.filter((item) => review.effective[item.plan.bookmarkId] === "move").map((item) => item.plan.bookmarkId), "keep")}>取消全部低风险自动建议</button>}
      <div className="review-secondary-list">{safeItems.filter((item) => matches(item, query)).map((item) => renderItem(item))}</div>
      {!safeItems.some((item) => matches(item, query)) && <p className="review-muted">没有匹配的建议。</p>}
      <Link to="/manage" className="review-text-button">疑似重复与链接问题，前往书签管理独立核实 <ArrowRight size={14} /></Link>
    </details>

    <details className="review-details">
      <summary>执行清单与目标树 <span>{review.approvedPlans.length} 条移动</span><ChevronDown size={16} /></summary>
      <label className="review-search"><span>搜索实际移动的目标树</span><input value={props.treeQuery} onChange={(event) => props.onTreeQuery(event.target.value)} placeholder="书签标题、URL 或目标目录" /></label>
      <p className="review-muted">{props.folderCount} 个匹配目标目录 · 点击书签可修改目标，修改后须重新审核</p>
      <div className="preview-tree">{props.tree}</div>
      {!review.approvedPlans.length && <p className="review-muted">没有已批准的移动，书签保持原位。</p>}
      <details className="review-evidence"><summary>已决定的全部条目（{decidedItems.length}）<ChevronDown size={14} /></summary>
        <div className="review-secondary-list">{decidedItems.map((item) => renderItem(item))}</div>
      </details>
      {analysis.frameworkGroups.some((group) => frameworks[group.key]) && <details className="review-evidence">
        <summary>已决定的目录结构 <ChevronDown size={14} /></summary>
        {analysis.frameworkGroups.filter((group) => frameworks[group.key]).map((group) => <div key={group.key} className="review-structure-decision">
          <p>{group.topLevel} · {frameworks[group.key] === "approve" ? "已采用" : "不新建"}</p>
          <button className="review-text-button" disabled={busy} onClick={() => props.onFramework(group, frameworks[group.key] === "approve" ? "keep" : "approve")}>更改目录决定（重新审核其中书签）</button>
        </div>)}
      </details>}
    </details>
    <div className="review-strategy"><span>无法可靠分类时</span><Link to="/options">查看设置 <ArrowRight size={13} /></Link><p>{props.unclassifiedHandling === "collect" ? "当前设置：集中至「未分类」；本次低依据建议安全保留，可自愿修改目标。" : "保留原位置（推荐）· 避免打乱已有收藏结构"}</p></div>
    <details className="review-details">
      <summary>方案详情与执行说明 <ChevronDown size={16} /></summary>
      {props.cacheMessage && <p>{props.cacheMessage}</p>}
      <p>本次模型：{props.model || "缓存未记录"}</p>
      {props.tokenUsage && <p>Token：{props.tokenUsage.totalTokens.toLocaleString()} · 输入 {props.tokenUsage.promptTokens.toLocaleString()} / 输出 {props.tokenUsage.completionTokens.toLocaleString()}</p>}
      <p>整理前创建完整本地备份，失败则停止。只执行批准的移动，执行后前往报告查看成功与失败详情。</p>
      <p>会清理本次移动后变空的源目录、空祖先与新建空目录；撤销可移回原目录，但不恢复原排序。</p>
      <p>删除或变化项会在执行前再次校验；已不存在的书签不计入有效参与数。</p>
      <button type="button" className="review-text-button" disabled={busy} onClick={props.onRegenerate}>重新选择书签</button>
    </details>
    <p className="review-announcement" role="status" aria-live="polite">{notice}</p>

    <footer className="review-footer">
      <div><span>{review.approvedPlans.length} 条移动已批准</span><strong>{remaining ? `待定 ${pendingCount} 条${pendingFrameworks ? ` · ${pendingFrameworks} 个目录` : ""}` : "可进行最终确认"}</strong></div>
      <button type="button" className="review-primary" disabled={busy || (!remaining && !review.approvedPlans.length)}
        onClick={continueReview}>{busy ? "正在保存与校验…" : remaining ? "继续审核" : review.approvedPlans.length ? `检查并应用 · ${review.approvedPlans.length} 条移动` : "审核完成 · 全部保留原位"}<ArrowRight size={17} /></button>
      {remaining && <button type="button" className="review-text-button" disabled={busy} onClick={() => setKeepOpen(true)}>其余待定全部保留原位</button>}
      {!remaining && !review.approvedPlans.length && <Link className="review-text-button" to="/home">返回首页</Link>}
    </footer>
    {keepOpen && <PreviewDialog label="保留其余待定项" title="将其余待定项保留原位？"
      description={`剩余 ${pendingCount} 条书签将保持原位，${pendingFrameworks} 个待确认目录不新建。已经批准的其他移动保持不变。`}
      busy={busy} onClose={() => setKeepOpen(false)} actions={<>
        <button className="extension-page__wide-secondary" data-dialog-return disabled={busy} onClick={() => setKeepOpen(false)}>继续审核</button>
        <button className="extension-page__wide-primary" disabled={busy} onClick={() => { props.onKeepRemaining(); setKeepOpen(false); setNotice("其余待定项已明确保留原位。"); }}>确认保留原位</button>
      </>}><p>此操作仅保存审核决定，不会移动或删除书签。</p></PreviewDialog>}
  </div>;
}
