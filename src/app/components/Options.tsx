import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Check, AlertCircle, Sparkles } from "lucide-react";
import type { AIProviderType, FolderHabitProfile, Settings } from "../types";
import { testAIConnection } from "../services/aiProvider";
import { analyzeAndSaveFolderHabits, getFolderHabitProfile } from "../services/habits";
import { requestHistoryPermission } from "../services/history";
import { clearPreviewPlan, DEFAULT_SETTINGS } from "../services/storage";
import { useAppStore } from "../store/useAppStore";

const providerDefaults: Record<AIProviderType, Pick<Settings["provider"], "model" | "endpoint">> = {
  openai: { model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1" },
  deepseek: { model: "deepseek-v4-flash", endpoint: "https://api.deepseek.com" },
  custom: { model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1" },
};

export function Options() {
  const { settings, loadSettings, saveSettings } = useAppStore();
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [habitProfile, setHabitProfile] = useState<FolderHabitProfile | null>(null);
  const [habitStatus, setHabitStatus] = useState<"idle" | "analyzing" | "success" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    void getFolderHabitProfile().then(setHabitProfile);
  }, []);

  const updateProvider = (type: AIProviderType) => {
    const defaults = providerDefaults[type];
    setDraft((current) => ({
      ...current,
      provider: {
        ...current.provider,
        type,
        model: defaults.model,
        endpoint: defaults.endpoint,
      },
    }));
  };

  const handleTestConnection = async () => {
    setTestStatus("testing");
    setMessage("");
    try {
      await testAIConnection(draft.provider);
      setTestStatus("success");
      setDraft((current) => ({
        ...current,
        provider: { ...current.provider, enabled: true, testedAt: Date.now() },
      }));
    } catch (error) {
      setTestStatus("error");
      setMessage(error instanceof Error ? error.message : "连接失败，请检查配置");
    }
  };

  const handleHistoryToggle = async (enabled: boolean) => {
    if (!enabled) {
      setDraft((current) => ({ ...current, enableHistory: false }));
      return;
    }
    const granted = await requestHistoryPermission();
    setDraft((current) => ({ ...current, enableHistory: granted }));
    if (!granted) setMessage("未授予浏览历史权限，常访问书签已保持关闭");
  };

  const handleSave = async () => {
    await saveSettings(draft);
    await clearPreviewPlan();
    setMessage("设置已保存");
  };

  const handleAnalyzeHabits = async () => {
    setHabitStatus("analyzing");
    setMessage("");
    try {
      await saveSettings(draft);
      const profile = await analyzeAndSaveFolderHabits();
      setHabitProfile(profile);
      setHabitStatus("success");
      setMessage("已分析并保存当前分类习惯，后续整理会优先参考");
    } catch (error) {
      setHabitStatus("error");
      setMessage(error instanceof Error ? error.message : "分析分类习惯失败");
    }
  };

  return (
    <div className="extension-page extension-page--settings">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">设置</h1>
              <p className="extension-page__subtitle">AI、整理规则与隐私权限</p>
            </div>
          </div>
        </div>

        <section className="extension-section settings-section">
          <details className="settings-disclosure">
            <summary className="settings-disclosure__summary">
              <span>
                <h2 className="extension-section__title">AI Provider 配置</h2>
                <span className="settings-disclosure__hint">配置 AI 服务、模型和连接测试</span>
              </span>
              <span className="settings-disclosure__chevron" aria-hidden="true">›</span>
            </summary>
            <div className="settings-disclosure__body">
            <div className="extension-form">
              <div className="extension-field">
                <label>Provider</label>
                <select value={draft.provider.type} onChange={(event) => updateProvider(event.target.value as AIProviderType)} className="extension-control">
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="custom">自定义</option>
                </select>
              </div>

              <div className="extension-field">
                <label>API Key</label>
                <input
                  type="password"
                  value={draft.provider.apiKey}
                  onChange={(event) => setDraft({ ...draft, provider: { ...draft.provider, apiKey: event.target.value } })}
                  placeholder="sk-..."
                  className="extension-control"
                />
                <p>API Key 仅保存到本地浏览器，不会写入报告或备份</p>
              </div>

              <div className="extension-field">
                <label>模型</label>
                <input
                  type="text"
                  value={draft.provider.model}
                  onChange={(event) => setDraft({ ...draft, provider: { ...draft.provider, model: event.target.value } })}
                  placeholder="gpt-4o-mini"
                  className="extension-control"
                />
              </div>

              <div className="extension-field">
                <label>Endpoint</label>
                <input
                  type="text"
                  value={draft.provider.endpoint ?? ""}
                  onChange={(event) => setDraft({ ...draft, provider: { ...draft.provider, endpoint: event.target.value } })}
                  placeholder="https://api.openai.com/v1"
                  className="extension-control"
                />
              </div>

              <button onClick={handleTestConnection} disabled={testStatus === "testing"} className="extension-page__wide-secondary extension-page__wide-secondary--blue">
                {testStatus === "testing" ? "测试中..." : "测试连接"}
              </button>

              {testStatus === "success" && (
                <div className="extension-status extension-status--success">
                  <Check className="w-4 h-4 text-green-600" />
                  <span className="text-sm text-green-800">连接成功</span>
                </div>
              )}

              {testStatus === "error" && (
                <div className="extension-status extension-status--error">
                  <AlertCircle className="w-4 h-4 text-red-600" />
                  <span className="text-sm text-red-800">{message || "连接失败，请检查配置"}</span>
                </div>
              )}
            </div>
            </div>
          </details>
        </section>

        <section className="extension-section settings-section">
          <details className="settings-disclosure">
            <summary className="settings-disclosure__summary">
              <span>
                <h2 className="extension-section__title">分类习惯学习</h2>
                <span className="settings-disclosure__hint">分析现有文件夹偏好并保存本地画像</span>
              </span>
              <span className="settings-disclosure__chevron" aria-hidden="true">›</span>
            </summary>
            <div className="settings-disclosure__body">
            <div className="extension-settings-list">
              <div className="extension-privacy">
                <p>
                  从当前书签文件夹中提取分类命名和粒度偏好，AI 会生成本地画像。之后整理会优先复用已有分类习惯，减少新建陌生文件夹。
                </p>
              </div>

              {habitProfile && (
                <div className="extension-privacy">
                  <p>
                    已学习 {habitProfile.folderCount} 个文件夹、{habitProfile.bookmarkCount} 个书签<br />
                    {habitProfile.summary}<br />
                    主要分类：{habitProfile.preferredTopLevelFolders.slice(0, 8).join("、") || "暂无"}
                  </p>
                </div>
              )}

              <button
                onClick={handleAnalyzeHabits}
                disabled={habitStatus === "analyzing"}
                className="extension-page__wide-secondary extension-page__wide-secondary--blue"
              >
                <Sparkles className="w-4 h-4" />
                {habitStatus === "analyzing" ? "正在分析分类习惯..." : habitProfile ? "重新分析分类习惯" : "分析当前分类习惯"}
              </button>
            </div>
            </div>
          </details>
        </section>

        <section className="extension-section settings-section">
          <details className="settings-disclosure">
            <summary className="settings-disclosure__summary">
              <span>
                <h2 className="extension-section__title">整理选项</h2>
                <span className="settings-disclosure__hint">控制文件夹层级、数量和 URL 发送策略</span>
              </span>
              <span className="settings-disclosure__chevron" aria-hidden="true">›</span>
            </summary>
            <div className="settings-disclosure__body">
            <div className="extension-settings-list">
              <div className="extension-switch-row">
                <div>
                  <div className="extension-switch-row__title">允许嵌套文件夹</div>
                  <div className="extension-switch-row__hint">关闭后所有书签只分类到一级文件夹</div>
                </div>
                <label className="relative inline-block w-12 h-6">
                  <input type="checkbox" checked={draft.allowNestedFolders} onChange={(event) => setDraft({ ...draft, allowNestedFolders: event.target.checked })} className="sr-only peer" />
                  <div className="w-12 h-6 bg-gray-200 peer-checked:bg-blue-500 rounded-full peer transition-colors cursor-pointer after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-6"></div>
                </label>
              </div>

              {draft.allowNestedFolders && (
                <div className="extension-field">
                  <label>最大嵌套层级</label>
                  <select value={draft.maxNestingLevel} onChange={(event) => setDraft({ ...draft, maxNestingLevel: Number(event.target.value) })} className="extension-control">
                    <option value="1">1 级</option>
                    <option value="2">2 级</option>
                    <option value="3">3 级</option>
                  </select>
                </div>
              )}

              <div className="extension-field">
                <label>一级文件夹数量上限</label>
                <select
                  value={draft.maxTopLevelFolders}
                  onChange={(event) => setDraft({ ...draft, maxTopLevelFolders: Number(event.target.value) })}
                  className="extension-control"
                >
                  <option value="4">4 个</option>
                  <option value="6">6 个</option>
                  <option value="8">8 个</option>
                  <option value="10">10 个</option>
                  <option value="12">12 个</option>
                </select>
                <p>数量越少，分类越克制；长尾内容会合并到“其他”或更粗粒度文件夹。</p>
              </div>

              {draft.allowNestedFolders && draft.maxNestingLevel > 1 && (
                <div className="extension-field">
                  <label>每个一级文件夹的子文件夹上限</label>
                  <select
                    value={draft.maxSubfoldersPerFolder}
                    onChange={(event) => setDraft({ ...draft, maxSubfoldersPerFolder: Number(event.target.value) })}
                    className="extension-control"
                  >
                    <option value="0">不创建子文件夹</option>
                    <option value="2">2 个</option>
                    <option value="3">3 个</option>
                    <option value="4">4 个</option>
                    <option value="6">6 个</option>
                  </select>
                </div>
              )}

              <div className="extension-switch-row">
                <div>
                  <div className="extension-switch-row__title">发送完整 URL</div>
                  <div className="extension-switch-row__hint">默认不发送 query 和 hash 参数</div>
                </div>
                <label className="relative inline-block w-12 h-6">
                  <input type="checkbox" checked={draft.sendFullUrl} onChange={(event) => setDraft({ ...draft, sendFullUrl: event.target.checked })} className="sr-only peer" />
                  <div className="w-12 h-6 bg-gray-200 peer-checked:bg-blue-500 rounded-full peer transition-colors cursor-pointer after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-6"></div>
                </label>
              </div>
            </div>
            </div>
          </details>
        </section>

        <section className="extension-section settings-section">
          <details className="settings-disclosure">
            <summary className="settings-disclosure__summary">
              <span>
                <h2 className="extension-section__title">隐私与权限</h2>
                <span className="settings-disclosure__hint">管理历史权限和本地数据说明</span>
              </span>
              <span className="settings-disclosure__chevron" aria-hidden="true">›</span>
            </summary>
            <div className="settings-disclosure__body">
            <div className="extension-settings-list">
              <div className="extension-switch-row">
                <div>
                  <div className="extension-switch-row__title">启用常访问书签</div>
                  <div className="extension-switch-row__hint">需要浏览历史权限，数据仅本地处理</div>
                </div>
                <label className="relative inline-block w-12 h-6">
                  <input type="checkbox" checked={draft.enableHistory} onChange={(event) => void handleHistoryToggle(event.target.checked)} className="sr-only peer" />
                  <div className="w-12 h-6 bg-gray-200 peer-checked:bg-blue-500 rounded-full peer transition-colors cursor-pointer after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-6"></div>
                </label>
              </div>

              <div className="extension-privacy">
                <p>
                  · API Key 仅保存到浏览器本地<br />
                  · 默认不发送完整 URL 到 AI<br />
                  · 浏览历史不会发送给 AI<br />
                  · 所有书签移动都在用户确认后执行
                </p>
              </div>
            </div>
            </div>
          </details>
        </section>

        {message && testStatus !== "error" && (
          <div className="extension-status extension-status--success">
            <Check className="w-4 h-4 text-green-600" />
            <span className="text-sm text-green-800">{message}</span>
          </div>
        )}

        <button onClick={handleSave} className="extension-page__wide-primary">
          保存设置
        </button>
      </div>
    </div>
  );
}
