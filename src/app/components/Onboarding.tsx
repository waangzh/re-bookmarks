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
import type { AIProviderConfig, AIProviderType, MovePlan, PreviewTaskProgress, Settings } from "../types";
import { AI_PROVIDER_OPTIONS, AI_PROVIDER_PROFILES, testAIConnection } from "../services/aiProvider";
import { countDuplicateGroups, isUnsortedBookmark } from "../services/bookmarkTasks";
import { getAllBookmarkFolders } from "../services/bookmarks";
import { getPreviewTask, requestClearPreviewTask, startPreviewTask } from "../services/previewTask";
import { clearPreviewPlan } from "../services/storage";
import { useAppStore } from "../store/useAppStore";

type OnboardingProps = {
  defaultView?: "popup" | "options" | "sidebar";
};

type SampleState = "idle" | "running" | "ready" | "error";

const SAMPLE_SIZE = 20;

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

export function Onboarding({ defaultView = "popup" }: OnboardingProps) {
  const navigate = useNavigate();
  const { bookmarks, settings, loading, loadAll, saveSettings } = useAppStore();
  const [step, setStep] = useState(1);
  const [folderCount, setFolderCount] = useState(0);
  const [draft, setDraft] = useState<Settings>(settings);
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [sampleState, setSampleState] = useState<SampleState>("idle");
  const [samplePlans, setSamplePlans] = useState<MovePlan[]>([]);
  const [sampleProgress, setSampleProgress] = useState<PreviewTaskProgress>();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
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
        setSamplePlans(task.movePlan ?? []);
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
            <p className="onboarding__lead">先确认分类风格。此步骤只生成建议，不会实际移动任何书签。</p>
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
                  <div><span>整理后结构</span><strong>{sampleFolderCount}</strong><small>个建议分类</small></div>
                </div>
                <div className="onboarding__suggestions">
                  {samplePlans.slice(0, 5).map((plan) => (
                    <div key={plan.bookmarkId}>
                      <span>{plan.bookmarkTitle}</span>
                      <ArrowRight aria-hidden="true" />
                      <strong>{plan.toFolderPath.join(" / ")}</strong>
                    </div>
                  ))}
                </div>
                <div className="onboarding__safe-note"><ShieldCheck aria-hidden="true" />这里只是预览，书签仍在原处</div>
              </>
            )}
            {sampleState === "error" && (
              <div className="onboarding__status onboarding__status--error"><AlertCircle aria-hidden="true" />{message}</div>
            )}
            <div className="onboarding__nav-row">
              <button type="button" onClick={() => setStep(2)} disabled={sampleState === "running"}>返回</button>
              <button type="button" onClick={() => setStep(4)} disabled={sampleState !== "ready"}>风格符合预期 <ArrowRight aria-hidden="true" /></button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="onboarding__panel onboarding__panel--finish">
            <span className="onboarding__finish-mark"><CheckCircle2 aria-hidden="true" /></span>
            <div className="onboarding__eyebrow">第四步 · 完整整理</div>
            <h1>准备好整理全部书签</h1>
            <p className="onboarding__lead">下一页会再次展示完整预览。只有你确认后，ReMarks 才会创建备份并移动书签。</p>
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
