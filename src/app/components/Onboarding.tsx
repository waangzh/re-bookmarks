import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertCircle,
  ArrowRight,
  BookOpenCheck,
  Check,
  CheckCircle2,
  Files,
  FolderTree,
  KeyRound,
  Layers3,
  LoaderCircle,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { AIProviderConfig, AIProviderType, MovePlan, PreviewTaskProgress, Settings, TokenUsage } from "../types";
import { AI_PROVIDER_OPTIONS, AI_PROVIDER_PROFILES, testAIConnection } from "../services/aiProvider";
import { countDuplicateGroups, isUnsortedBookmark } from "../services/bookmarkTasks";
import { getAllBookmarkFolders, parseFolderPath } from "../services/bookmarks";
import { recordHabitFeedback } from "../services/habits";
import { executeMovePlans } from "../services/organizer";
import { getPreviewTask, requestClearPreviewTask, startPreviewTask } from "../services/previewTask";
import { clearPreviewPlan } from "../services/storage";
import { useAppStore } from "../store/useAppStore";

type OnboardingProps = {
  defaultView?: "popup" | "options" | "sidebar";
};

type SampleState = "idle" | "running" | "ready" | "error";

const SAMPLE_SIZE = 20;
const REVIEWED_SAMPLE_SIZE = 5;

function selectRepresentativeSample<T extends { path: string[] }>(items: T[], limit: number) {
  const sorted = [...items].sort((left, right) =>
    left.path.join("/").localeCompare(right.path.join("/"), "zh-CN")
  );
  if (sorted.length <= limit) return sorted;
  return Array.from({ length: limit }, (_, index) => sorted[Math.floor(index * sorted.length / limit)]);
}

function progressPercent(progress?: PreviewTaskProgress) {
  if (!progress) return 8;
  if (progress.totalBatches > 0) {
    return Math.max(8, Math.round((progress.completedBatches / progress.totalBatches) * 100));
  }
  if (progress.totalBookmarks > 0) {
    return Math.max(8, Math.round((progress.processedBookmarks / progress.totalBookmarks) * 100));
  }
  return 8;
}

function sameFolderPath(left: string[], right: string[]) {
  return left.join("/").toLocaleLowerCase() === right.join("/").toLocaleLowerCase();
}

function confidenceLabel(plan: MovePlan) {
  if (plan.source === "manual") return "你已修正";
  return plan.confidence >= 0.85 ? "AI 较有把握" : "建议重点确认";
}

export function Onboarding({ defaultView = "popup" }: OnboardingProps) {
  const navigate = useNavigate();
  const { bookmarks, settings, loading, loadAll, saveSettings } = useAppStore();
  const [step, setStep] = useState(1);
  const [folderCount, setFolderCount] = useState(0);
  const [draft, setDraft] = useState<Settings>(settings);
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [sampleState, setSampleState] = useState<SampleState>("idle");
  const [samplePlans, setSamplePlans] = useState<MovePlan[]>([]);
  const [initialSamplePlans, setInitialSamplePlans] = useState<MovePlan[]>([]);
  const [samplePathDrafts, setSamplePathDrafts] = useState<Record<string, string>>({});
  const [recordedSampleCorrections, setRecordedSampleCorrections] = useState<Record<string, string>>({});
  const [sampleTokenUsage, setSampleTokenUsage] = useState<TokenUsage>();
  const [sampleProgress, setSampleProgress] = useState<PreviewTaskProgress>();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [applyingSample, setApplyingSample] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadAll();
    void getAllBookmarkFolders().then((folders) => setFolderCount(folders.length));
  }, [loadAll]);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    if (!activeTaskId || sampleState !== "running") return;
    let alive = true;
    const poll = async () => {
      const task = await getPreviewTask();
      if (!alive || task?.id !== activeTaskId) return;
      setSampleProgress(task.progress);
      if (task.status === "completed") {
        const plans = task.movePlan ?? [];
        setInitialSamplePlans(plans);
        setSamplePlans(plans);
        setSamplePathDrafts(Object.fromEntries(
          plans.slice(0, REVIEWED_SAMPLE_SIZE).map((plan) => [plan.bookmarkId, plan.toFolderPath.join(" / ")])
        ));
        setSampleTokenUsage(task.tokenUsage);
        setSampleState("ready");
        setActiveTaskId(null);
      } else if (task.status === "failed") {
        setMessage(task.error ?? "小样本生成失败，请重试");
        setSampleState("error");
        setActiveTaskId(null);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1200);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [activeTaskId, sampleState]);

  const stats = useMemo(() => ({
    total: bookmarks.length,
    unsorted: bookmarks.filter(isUnsortedBookmark).length,
    duplicates: countDuplicateGroups(bookmarks),
    folders: folderCount,
    organizable: bookmarks.length,
  }), [bookmarks, folderCount]);

  const providerProfile = AI_PROVIDER_PROFILES[draft.provider.type];
  const sample = useMemo(() => selectRepresentativeSample(bookmarks, SAMPLE_SIZE), [bookmarks]);
  const sampleSize = sample.length;
  const sampleFolderCount = new Set(samplePlans.map((plan) => plan.toFolderPath.join("/"))).size;
  const reviewedSamplePlans = samplePlans.slice(0, REVIEWED_SAMPLE_SIZE);
  const correctedSampleCount = reviewedSamplePlans.filter((plan) => {
    const initialPlan = initialSamplePlans.find((item) => item.bookmarkId === plan.bookmarkId);
    return Boolean(initialPlan && !sameFolderPath(initialPlan.toFolderPath, plan.toFolderPath));
  }).length;
  const currentSampleFolderCount = new Set(
    sample.map((bookmark) => bookmark.path.join("/") || "根目录")
  ).size;

  const updateProvider = (type: AIProviderType) => {
    const profile = AI_PROVIDER_PROFILES[type];
    const saved = draft.providerConfigs[type];
    const provider: AIProviderConfig = saved
      ? { ...saved, type }
      : {
          type,
          apiKey: "",
          model: profile.model,
          endpoint: profile.endpoint,
          temperature: profile.defaultTemperature,
          tokenParam: "auto",
          jsonMode: "auto",
          enabled: false,
        };
    setDraft((current) => ({
      ...current,
      provider,
      providerConfigs: { ...current.providerConfigs, [type]: provider },
    }));
    setConnectionStatus("idle");
    setMessage("");
  };

  const updateApiKey = (apiKey: string) => {
    setDraft((current) => {
      const provider = { ...current.provider, apiKey, enabled: false };
      return {
        ...current,
        provider,
        providerConfigs: { ...current.providerConfigs, [provider.type]: provider },
      };
    });
    setConnectionStatus("idle");
    setMessage("");
  };

  const handleTestConnection = async () => {
    if (!draft.provider.apiKey.trim()) {
      setConnectionStatus("error");
      setMessage("请输入 API Key");
      return;
    }
    setConnectionStatus("testing");
    setMessage("");
    try {
      await testAIConnection(draft.provider);
      const provider = { ...draft.provider, enabled: true, testedAt: Date.now() };
      const nextDraft = {
        ...draft,
        provider,
        providerConfigs: { ...draft.providerConfigs, [provider.type]: provider },
      };
      await saveSettings(nextDraft);
      setDraft(nextDraft);
      setConnectionStatus("success");
    } catch (error) {
      setConnectionStatus("error");
      setMessage(error instanceof Error ? error.message : "连接失败，请检查 API Key");
    }
  };

  const handleGenerateSample = async () => {
    if (!sample.length) {
      setMessage("没有可用于生成小样本的书签");
      setSampleState("error");
      return;
    }
    setSampleState("running");
    setSamplePlans([]);
    setInitialSamplePlans([]);
    setSamplePathDrafts({});
    setRecordedSampleCorrections({});
    setSampleTokenUsage(undefined);
    setSampleProgress(undefined);
    setMessage("");
    try {
      await Promise.all([clearPreviewPlan(), requestClearPreviewTask()]);
      const task = await startPreviewTask(sample, "quick", draft.provider.model);
      setActiveTaskId(task.id);
      setSampleProgress(task.progress);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "小样本生成失败，请重试");
      setSampleState("error");
    }
  };

  const handleUpdateSamplePath = (plan: MovePlan) => {
    const folderPath = parseFolderPath(samplePathDrafts[plan.bookmarkId] ?? "", draft.maxNestingLevel);
    if (!folderPath.length) {
      setMessage("请填写目标文件夹");
      return;
    }
    setSamplePlans((current) => current.map((item) => item.bookmarkId === plan.bookmarkId
      ? {
          ...item,
          toFolderPath: folderPath,
          confidence: 1,
          reason: `首次引导中手动修正为：${folderPath.join(" / ")}`,
          source: "manual",
        }
      : item));
    setSamplePathDrafts((current) => ({ ...current, [plan.bookmarkId]: folderPath.join(" / ") }));
    setMessage("");
  };

  const saveSampleCorrections = async (plans: MovePlan[]) => {
    const corrections = plans.flatMap((plan) => {
      const initialPlan = initialSamplePlans.find((item) => item.bookmarkId === plan.bookmarkId);
      const correctionKey = plan.toFolderPath.join("/");
      if (
        !initialPlan ||
        sameFolderPath(initialPlan.toFolderPath, plan.toFolderPath) ||
        recordedSampleCorrections[plan.bookmarkId] === correctionKey
      ) return [];
      return [{
        bookmarkId: plan.bookmarkId,
        correctionKey,
        result: recordHabitFeedback({
          type: "category_override" as const,
          bookmarkTitle: plan.bookmarkTitle,
          bookmarkUrl: plan.bookmarkUrl,
          suggestedFolderPath: initialPlan.toFolderPath,
          chosenFolderPath: plan.toFolderPath,
        }).catch(() => null),
      }];
    });
    await Promise.all(corrections.map((item) => item.result));
    if (corrections.length) {
      setRecordedSampleCorrections((current) => ({
        ...current,
        ...Object.fromEntries(corrections.map((item) => [item.bookmarkId, item.correctionKey])),
      }));
    }
  };

  const handleContinueAfterSample = async () => {
    await saveSampleCorrections(reviewedSamplePlans);
    setStep(4);
  };

  const handleApplyReviewedSample = async () => {
    if (!reviewedSamplePlans.length) return;
    setApplyingSample(true);
    setMessage("");
    try {
      await saveSampleCorrections(reviewedSamplePlans);
      await executeMovePlans(reviewedSamplePlans, sampleTokenUsage);
      await Promise.all([
        clearPreviewPlan(),
        requestClearPreviewTask(),
        saveSettings({ ...draft, onboardingCompleted: true }),
      ]);
      await loadAll();
      navigate("/report", { replace: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "应用小样本失败，请重试");
      setApplyingSample(false);
    }
  };

  const completeOnboarding = async (destination: "home" | "preview") => {
    await Promise.all([clearPreviewPlan(), requestClearPreviewTask()]);
    await saveSettings({ ...draft, onboardingCompleted: true });
    navigate(destination === "preview" ? "/preview" : "/", { replace: true });
  };

  return (
    <main className={`onboarding onboarding--${defaultView}`}>
      <div className="onboarding__shell">
        <header className="onboarding__brand">
          <span className="onboarding__brand-mark"><Sparkles aria-hidden="true" /></span>
          <span>ReMarks</span>
          <button type="button" onClick={() => void completeOnboarding("home")}>跳过引导</button>
        </header>

        <nav className="onboarding__steps" aria-label="首次使用进度">
          {[1, 2, 3, 4].map((item) => (
            <span key={item} className={item === step ? "is-active" : item < step ? "is-done" : ""}>
              {item < step ? <Check aria-hidden="true" /> : item}
            </span>
          ))}
        </nav>

        {step === 1 && (
          <section className="onboarding__panel">
            <div className="onboarding__eyebrow"><ScanSearch aria-hidden="true" /> 第一步 · 扫描</div>
            <h1>先看看你的书签现状</h1>
            <p className="onboarding__lead">ReMarks 已在本地扫描书签，不会上传浏览历史。</p>
            <div className="onboarding__metrics">
              <div className="onboarding__metric onboarding__metric--hero">
                <BookOpenCheck aria-hidden="true" />
                <span>共发现</span>
                <strong>{loading ? "…" : stats.total}</strong>
                <small>个书签</small>
              </div>
              <div className="onboarding__metric"><Files aria-hidden="true" /><span>未分类</span><strong>{stats.unsorted}</strong></div>
              <div className="onboarding__metric"><Layers3 aria-hidden="true" /><span>疑似重复</span><strong>{stats.duplicates}</strong></div>
              <div className="onboarding__metric"><FolderTree aria-hidden="true" /><span>当前文件夹</span><strong>{stats.folders}</strong></div>
            </div>
            <div className="onboarding__estimate">
              <CheckCircle2 aria-hidden="true" />
              <span>预计可整理 <strong>{stats.organizable}</strong> 项</span>
            </div>
            <button className="onboarding__primary" type="button" onClick={() => setStep(2)} disabled={loading}>
              继续连接 AI <ArrowRight aria-hidden="true" />
            </button>
          </section>
        )}

        {step === 2 && (
          <section className="onboarding__panel">
            <div className="onboarding__eyebrow"><Sparkles aria-hidden="true" /> 第二步 · 连接 AI</div>
            <h1>连接 AI 服务</h1>
            <p className="onboarding__lead">ReMarks 使用 AI 判断书签内容并生成整理建议。</p>
            <div className="onboarding__form">
              <label>
                <span>AI 服务</span>
                <select value={draft.provider.type} onChange={(event) => updateProvider(event.target.value as AIProviderType)}>
                  {AI_PROVIDER_OPTIONS.map((provider) => (
                    <option key={provider.type} value={provider.type}>{provider.label}</option>
                  ))}
                </select>
                <small>模型与请求参数已使用 {providerProfile.label} 推荐值</small>
              </label>
              <label>
                <span className="onboarding__label-row"><span><KeyRound aria-hidden="true" />API Key</span><em>仅保存在本地</em></span>
                <input
                  type="password"
                  value={draft.provider.apiKey}
                  onChange={(event) => updateApiKey(event.target.value)}
                  placeholder="输入服务商提供的 API Key"
                  autoComplete="off"
                />
              </label>
            </div>
            <button className="onboarding__primary" type="button" onClick={() => void handleTestConnection()} disabled={connectionStatus === "testing"}>
              {connectionStatus === "testing" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
              {connectionStatus === "testing" ? "正在测试连接" : connectionStatus === "success" ? "重新测试连接" : "测试连接"}
            </button>
            {connectionStatus === "success" && (
              <div className="onboarding__status onboarding__status--success"><CheckCircle2 aria-hidden="true" />连接成功，可以生成试分类</div>
            )}
            {connectionStatus === "error" && (
              <div className="onboarding__status onboarding__status--error"><AlertCircle aria-hidden="true" />{message}</div>
            )}
            <button className="onboarding__later" type="button" onClick={() => void completeOnboarding("home")}>
              没有 API Key？先使用本地搜索与重复检查
            </button>
            <div className="onboarding__nav-row">
              <button type="button" onClick={() => setStep(1)}>返回</button>
              <button type="button" onClick={() => setStep(3)} disabled={connectionStatus !== "success"}>下一步 <ArrowRight aria-hidden="true" /></button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="onboarding__panel">
            <div className="onboarding__eyebrow"><Files aria-hidden="true" /> 第三步 · 生成小样本</div>
            <h1>先试整理 {sampleSize} 个书签</h1>
            <p className="onboarding__lead">先检查并修正几条代表性建议。只有你主动应用后，已检查的书签才会移动。</p>
            {sampleState === "idle" || sampleState === "error" ? (
              <div className="onboarding__sample-empty">
                <span><Sparkles aria-hidden="true" /></span>
                <strong>从不同文件夹抽取代表性书签</strong>
                <small>展示 3—5 条代表性建议供你判断</small>
                <button className="onboarding__primary" type="button" onClick={() => void handleGenerateSample()}>
                  生成 {sampleSize} 条试分类
                </button>
              </div>
            ) : sampleState === "running" ? (
              <div className="onboarding__sample-loading">
                <LoaderCircle className="is-spinning" aria-hidden="true" />
                <strong>AI 正在理解这些书签</strong>
                <span>已处理 {sampleProgress?.processedBookmarks ?? 0}/{sampleSize} 项</span>
                <div><i style={{ width: `${progressPercent(sampleProgress)}%` }} /></div>
              </div>
            ) : (
              <>
                <div className="onboarding__before-after">
                  <div><span>整理前结构</span><strong>{currentSampleFolderCount}</strong><small>个来源位置</small></div>
                  <ArrowRight aria-hidden="true" />
                  <div><span>{correctedSampleCount ? "修正后结构" : "建议结构"}</span><strong>{sampleFolderCount}</strong><small>{correctedSampleCount ? `已修正 ${correctedSampleCount} 条` : "个建议分类"}</small></div>
                </div>
                <div className="onboarding__suggestions">
                  {reviewedSamplePlans.map((plan) => (
                    <div className="onboarding__suggestion" key={plan.bookmarkId}>
                      <div className="onboarding__suggestion-copy">
                        <span title={plan.bookmarkTitle}>{plan.bookmarkTitle}</span>
                        <small title={plan.reason}>{confidenceLabel(plan)} · {plan.reason || "根据标题、网址与现有目录生成"}</small>
                      </div>
                      <ArrowRight aria-hidden="true" />
                      <div className="onboarding__suggestion-target">
                        <input
                          type="text"
                          aria-label={`修改“${plan.bookmarkTitle}”的目标文件夹`}
                          value={samplePathDrafts[plan.bookmarkId] ?? plan.toFolderPath.join(" / ")}
                          onChange={(event) => setSamplePathDrafts((current) => ({
                            ...current,
                            [plan.bookmarkId]: event.target.value,
                          }))}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") handleUpdateSamplePath(plan);
                          }}
                        />
                        <button type="button" onClick={() => handleUpdateSamplePath(plan)}>更新</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="onboarding__safe-note"><ShieldCheck aria-hidden="true" />只会应用上面已检查的 {reviewedSamplePlans.length} 条；其余样本仅用于观察分类风格</div>
              </>
            )}
            {message && (
              <div className="onboarding__status onboarding__status--error"><AlertCircle aria-hidden="true" />{message}</div>
            )}
            <div className="onboarding__nav-row onboarding__nav-row--sample">
              <button type="button" onClick={() => setStep(2)} disabled={sampleState === "running" || applyingSample}>返回</button>
              <div className="onboarding__sample-actions">
                <button type="button" onClick={() => void handleContinueAfterSample()} disabled={sampleState !== "ready" || applyingSample}>
                  继续完整预览 <ArrowRight aria-hidden="true" />
                </button>
                <button type="button" onClick={() => void handleApplyReviewedSample()} disabled={sampleState !== "ready" || applyingSample}>
                  {applyingSample ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                  {applyingSample ? "正在应用" : `应用已检查的 ${reviewedSamplePlans.length} 条`}
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="onboarding__panel onboarding__panel--finish">
            <span className="onboarding__finish-mark"><CheckCircle2 aria-hidden="true" /></span>
            <div className="onboarding__eyebrow">第四步 · 完整整理</div>
            <h1>继续检查完整整理方案</h1>
            <p className="onboarding__lead">你已认可或修正代表样本。下一页会重新生成完整预览；只有再次确认后，ReMarks 才会创建备份并移动书签。</p>
            <div className="onboarding__finish-summary">
              <span><BookOpenCheck aria-hidden="true" />可整理书签<strong>{stats.organizable}</strong></span>
              <span><ShieldCheck aria-hidden="true" />确认前不会移动<strong>安全预览</strong></span>
            </div>
            <button className="onboarding__primary" type="button" onClick={() => void completeOnboarding("preview")}>
              开始完整整理 <ArrowRight aria-hidden="true" />
            </button>
            <button className="onboarding__later" type="button" onClick={() => void completeOnboarding("home")}>稍后再整理</button>
          </section>
        )}
      </div>
    </main>
  );
}
