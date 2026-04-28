import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, Folder, ExternalLink, Check, AlertCircle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { MovePlan } from "../types";
import { executeMovePlans, generateMovePlans } from "../services/organizer";
import { useAppStore } from "../store/useAppStore";
import { clearPreviewPlan, getPreviewPlan, savePreviewPlan } from "../services/storage";

export function Preview() {
  const navigate = useNavigate();
  const { loadAll } = useAppStore();
  const [plans, setPlans] = useState<MovePlan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [cacheMessage, setCacheMessage] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  const createPlans = async (forceRefresh = false) => {
    setLoading(true);
    setError("");
    setCacheMessage("");

    try {
      if (!forceRefresh) {
        const cached = await getPreviewPlan();
        if (cached?.movePlan.length) {
          setPlans(cached.movePlan);
          setCacheMessage(`已恢复 ${new Date(cached.createdAt).toLocaleString()} 生成的预览结果`);
          return;
        }
      }

      const movePlans = await generateMovePlans();
      setPlans(movePlans);
      await savePreviewPlan({
        id: `preview-${Date.now()}`,
        createdAt: Date.now(),
        bookmarkCount: movePlans.length,
        movePlan: movePlans,
      });
      setCacheMessage("预览结果已保存，返回后可继续查看");
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成整理预览失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        await createPlans(false);
      } finally {
        if (!alive) return;
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  const handleRegenerate = async () => {
    setCollapsedFolders(new Set());
    setSelectedPlan(null);
    await createPlans(true);
  };

  const groupedByFolder = useMemo(
    () =>
      plans.reduce((acc, plan) => {
        const key = plan.toFolderPath.join(" / ");
        if (!acc[key]) acc[key] = [];
        acc[key].push(plan);
        return acc;
      }, {} as Record<string, MovePlan[]>),
    [plans]
  );

  const handleConfirm = async () => {
    if (!plans.length || submitting) return;
    setSubmitting(true);
    try {
      await executeMovePlans(plans);
      await clearPreviewPlan();
      await loadAll();
      navigate("/report");
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行整理失败");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.9) return "text-green-600 bg-green-50";
    if (confidence >= 0.8) return "text-blue-600 bg-blue-50";
    return "text-amber-600 bg-amber-50";
  };

  return (
    <div className="extension-page extension-page--preview">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">整理预览</h1>
              <p className="extension-page__subtitle">{loading ? "正在读取书签并生成分类" : `${plans.length} 个书签待确认`}</p>
            </div>
          </div>
          <button onClick={handleConfirm} disabled={!plans.length || submitting} className="extension-page__primary-button">
            <Check className="w-4 h-4" />
            {submitting ? "整理中" : "确认整理"}
          </button>
        </div>

        {!loading && plans.length > 0 && (
          <button onClick={handleRegenerate} disabled={submitting} className="extension-page__wide-secondary">
            <RefreshCw className="w-4 h-4" />
            重新生成预览
          </button>
        )}

        {error && (
          <div className="extension-notice extension-notice--amber">
            <p>{error}</p>
          </div>
        )}

        {cacheMessage && (
          <div className="extension-notice extension-notice--blue">
            <p>{cacheMessage}</p>
          </div>
        )}

        <div className="extension-notice extension-notice--blue">
          <div className="extension-notice__title">
            <AlertCircle className="extension-notice__icon" />
            <span>整理前预览</span>
          </div>
          <p>
            将移动 {plans.length} 个书签到 {Object.keys(groupedByFolder).length} 个文件夹。确认前不会修改任何书签。
          </p>
        </div>

        {loading ? (
          <div className="extension-empty">
            <p>正在生成整理建议</p>
            <span>本地规则会优先执行，未命中时再调用 AI</span>
          </div>
        ) : plans.length === 0 ? (
          <div className="extension-empty">
            <p>暂无可整理书签</p>
            <span>请先在浏览器中添加书签</span>
          </div>
        ) : (
          <div className="extension-stack preview-folder-stack">
            {Object.entries(groupedByFolder).map(([folderPath, items]) => {
              const isCollapsed = collapsedFolders.has(folderPath);

              return (
                <section key={folderPath} className="extension-section extension-section--flush">
                  <button
                    type="button"
                    className="extension-section__bar extension-section__bar--button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleFolder(folderPath)}
                  >
                    <div className="extension-section__bar-title">
                      {isCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                      <Folder className="w-5 h-5" />
                      <span>{folderPath}</span>
                    </div>
                    <span className="extension-pill">{items.length} 个</span>
                  </button>

                  {!isCollapsed && (
                    <div className="extension-list">
                      {items.map((plan) => (
                        <button
                          key={plan.bookmarkId}
                          className={`extension-list__item extension-list__item--button ${
                            selectedPlan === plan.bookmarkId ? "is-selected" : ""
                          }`}
                          onClick={() => setSelectedPlan(plan.bookmarkId)}
                        >
                          <div className="extension-list__main">
                            <div className="extension-list__title-row">
                              <h3>{plan.bookmarkTitle}</h3>
                              {plan.bookmarkUrl && (
                                <a href={plan.bookmarkUrl} target="_blank" rel="noopener noreferrer" className="extension-link-icon" onClick={(event) => event.stopPropagation()}>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                            {plan.bookmarkUrl && <p className="extension-list__url">{plan.bookmarkUrl}</p>}
                            {plan.reason && <p className="extension-list__note">{plan.reason}</p>}
                          </div>
                          <span className={`extension-confidence ${getConfidenceColor(plan.confidence)}`}>{Math.round(plan.confidence * 100)}%</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

        <section className="extension-section">
          <h3 className="extension-section__title">整理说明</h3>
          <ul className="extension-copy-list">
            <li>· 整理前会自动备份当前书签结构</li>
            <li>· 支持撤销最近一次整理操作</li>
            <li>· 已存在的文件夹会复用，不会重复创建</li>
            <li>· AI 失败时会回退到本地规则或待整理</li>
          </ul>
        </section>

        <button onClick={handleConfirm} disabled={!plans.length || submitting} className="extension-page__wide-primary">
          <Check className="w-5 h-5" />
          {submitting ? "正在整理" : `确认整理 ${plans.length} 个书签`}
        </button>
      </div>
    </div>
  );
}
