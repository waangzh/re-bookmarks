import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  FolderTree,
  KeyRound,
  RotateCcw,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type { AIProviderConfig, AIProviderType, Settings } from "../types";
import { AI_PROVIDER_OPTIONS, AI_PROVIDER_PROFILES, listAIModels, testAIConnection, type AIModelOption } from "../services/aiProvider";
import { requestHistoryPermission } from "../services/history";
import { requestClearPreviewTask } from "../services/previewTask";
import { ensureRequiredHostPermission } from "../services/hostPermissions";
import { clearPreviewPlan, DEFAULT_CLASSIFY_PROMPT, DEFAULT_SETTINGS } from "../services/storage";
import { useAppStore } from "../store/useAppStore";

export function Options() {
  const navigate = useNavigate();
  const { settings, loadSettings, saveSettings } = useAppStore();
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [models, setModels] = useState<AIModelOption[]>([]);
  const [modelStatus, setModelStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [modelMessage, setModelMessage] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFiltering, setModelFiltering] = useState(false);
  const [highlightedModel, setHighlightedModel] = useState(0);
  const modelPicker = useRef<HTMLDivElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const displayedModels = modelFiltering
    ? models.filter((model) => model.id.toLowerCase().includes(draft.provider.model.trim().toLowerCase()))
    : models;
  const modelRequest = useRef<AbortController | null>(null);
  const currentProvider = useRef(draft.provider);
  currentProvider.current = draft.provider;
  const providerProfile = AI_PROVIDER_PROFILES[draft.provider.type];
  const effectiveTemperature = draft.provider.temperature ?? providerProfile.defaultTemperature;
  const effectiveTokenParam = draft.provider.tokenParam && draft.provider.tokenParam !== "auto"
    ? draft.provider.tokenParam
    : providerProfile.tokenParam;

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    modelRequest.current?.abort();
    modelRequest.current = null;
    setModels([]);
    setModelMenuOpen(false);
    setModelStatus("idle");
    setModelMessage("");
    return () => modelRequest.current?.abort();
  }, [draft.provider.type, draft.provider.apiKey, draft.provider.endpoint]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!modelPicker.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [modelMenuOpen]);

  useEffect(() => {
    if (modelMenuOpen) {
      document.getElementById(`settings-model-option-${highlightedModel}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [modelMenuOpen, highlightedModel]);

  const openModelMenu = () => {
    setModelFiltering(false);
    setHighlightedModel(0);
    setModelMenuOpen(models.length > 0);
  };

  const chooseModel = (id: string) => {
    updateProviderConfig("model", id);
    setModelMenuOpen(false);
    modelInput.current?.focus();
  };

  const handleDetectModels = async () => {
    const provider = draft.provider;
    const controller = new AbortController();
    modelRequest.current?.abort();
    modelRequest.current = controller;
    const isCurrent = () => !controller.signal.aborted &&
      currentProvider.current.type === provider.type &&
      currentProvider.current.apiKey === provider.apiKey &&
      currentProvider.current.endpoint === provider.endpoint;
    setModels([]);
    setModelMenuOpen(false);
    setModelStatus("loading");
    setModelMessage("");
    try {
      await ensureRequiredHostPermission();
      if (!isCurrent()) return;
      const available = await listAIModels(provider, controller.signal);
      if (!isCurrent()) return;
      setModels(available);
      setModelStatus("success");
      setModelMessage(`已获取 ${available.length} 个模型。列表不保证均支持书签分类，请选择后测试连接。`);
    } catch (error) {
      if (!isCurrent()) return;
      setModelStatus("error");
      setModelMessage(error instanceof Error ? error.message : "模型检测失败，请稍后重试或手动输入模型名称");
    }
  };

  const updateProvider = (type: AIProviderType) => {
    const defaults = AI_PROVIDER_PROFILES[type];
    setDraft((current) => {
      const providerConfigs = {
        ...current.providerConfigs,
        [current.provider.type]: current.provider,
      };
      const savedConfig = providerConfigs[type];
      const provider = savedConfig
        ? { ...savedConfig, type }
        : {
            type,
            apiKey: "",
            model: defaults.model,
            endpoint: defaults.endpoint,
            temperature: defaults.defaultTemperature,
            maxTokens: undefined,
            tokenParam: "auto" as const,
            jsonMode: "auto" as const,
            enabled: false,
            testedAt: undefined,
          };
      return {
        ...current,
        provider,
        providerConfigs: {
          ...providerConfigs,
          [type]: provider,
        },
      };
    });
    setTestStatus("idle");
    setMessage("");
  };

  const updateProviderConfig = <Key extends keyof AIProviderConfig>(
    key: Key,
    value: AIProviderConfig[Key]
  ) => {
    setDraft((current) => {
      const requiresRetest = key !== "enabled" && key !== "testedAt";
      const provider = { ...current.provider, [key]: value,
        ...(requiresRetest ? { enabled: false, testedAt: undefined } : {}),
      };
      return {
        ...current,
        provider,
        providerConfigs: {
          ...current.providerConfigs,
          [provider.type]: provider,
        },
      };
    });
    setTestStatus("idle");
    setMessage("");
  };

  const handleTestConnection = async () => {
    const providerToTest = draft.provider;
    setTestStatus("testing");
    setMessage("");
    try {
      await ensureRequiredHostPermission();
      if (currentProvider.current !== providerToTest) return;
      await testAIConnection(providerToTest);
      if (currentProvider.current !== providerToTest) return;
      setTestStatus("success");
      setDraft((current) => {
        const provider = { ...current.provider, testedAt: Date.now() };
        return {
          ...current,
          provider,
          providerConfigs: {
            ...current.providerConfigs,
            [provider.type]: provider,
          },
        };
      });
    } catch (error) {
      if (currentProvider.current !== providerToTest) return;
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
    const nextDraft = { ...draft, enableHistory: granted };
    setDraft(nextDraft);
    if (!granted) {
      await saveSettings(nextDraft);
      setMessage("未授予浏览历史权限，常访问书签已保持关闭");
    }
  };

  const persistDraft = async () => {
    const nextDraft = {
      ...draft,
      providerConfigs: {
        ...draft.providerConfigs,
        [draft.provider.type]: draft.provider,
      },
    };
    setDraft(nextDraft);
    await saveSettings(nextDraft);
    await Promise.all([clearPreviewPlan(), requestClearPreviewTask()]);
    return nextDraft;
  };

  const handleSave = async () => {
    await persistDraft();
    setMessage("设置已保存");
  };

  const handleStartOrganize = async () => {
    await persistDraft();
    navigate("/preview");
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

        <section className="extension-section settings-section settings-section--provider settings-simple">
          <div className="settings-simple__header">
            <span className="settings-disclosure__icon settings-disclosure__icon--ai">
              <Sparkles aria-hidden="true" />
            </span>
            <div>
              <h2 className="extension-section__title">连接 AI 服务</h2>
              <p>ReMarks 使用 AI 判断书签内容并生成整理建议。</p>
            </div>
            <span className={`provider-overview__state${testStatus === "success" ? " is-ready" : ""}`}>
              {testStatus === "success" ? "连接可用" : "尚未测试"}
            </span>
          </div>

          <div className="extension-form provider-form settings-simple__form">
            <div className="extension-field">
              <label>AI 服务</label>
              <select value={draft.provider.type} onChange={(event) => updateProvider(event.target.value as AIProviderType)} className="extension-control">
                {AI_PROVIDER_OPTIONS.map((provider) => (
                  <option key={provider.type} value={provider.type}>{provider.label}</option>
                ))}
              </select>
              <p>模型、Endpoint 和请求参数将使用推荐值。</p>
            </div>

            <div className="extension-field">
              <div className="extension-field__label-with-icon">
                <KeyRound aria-hidden="true" />
                <label>API Key</label>
                <span>仅保存在本地</span>
              </div>
              <input
                type="password"
                value={draft.provider.apiKey}
                onChange={(event) => updateProviderConfig("apiKey", event.target.value)}
                placeholder="输入服务商提供的 API Key"
                autoComplete="off"
                className="extension-control"
              />
            </div>

            <div className="extension-field">
              <label htmlFor="settings-model">模型</label>
              <div
                ref={modelPicker}
                className="organize-model-picker__control"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setModelMenuOpen(false);
                }}
              >
                <input
                  ref={modelInput}
                  id="settings-model"
                  type="text"
                  autoComplete="off"
                  value={draft.provider.model}
                  onClick={openModelMenu}
                  onChange={(event) => {
                    updateProviderConfig("model", event.target.value);
                    setModelFiltering(true);
                    setHighlightedModel(0);
                    setModelMenuOpen(models.length > 0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      if (!models.length) return;
                      event.preventDefault();
                      if (!modelMenuOpen) {
                        openModelMenu();
                      } else if (displayedModels.length) {
                        const direction = event.key === "ArrowDown" ? 1 : -1;
                        setHighlightedModel((current) => (current + direction + displayedModels.length) % displayedModels.length);
                      }
                    } else if (event.key === "Enter" && modelMenuOpen && displayedModels[highlightedModel]) {
                      event.preventDefault();
                      chooseModel(displayedModels[highlightedModel].id);
                    } else if (event.key === "Escape") {
                      setModelMenuOpen(false);
                    }
                  }}
                  placeholder={providerProfile.model}
                  className="extension-control organize-model-picker__input"
                  role="combobox"
                  aria-expanded={modelMenuOpen}
                  aria-controls="settings-model-options"
                  aria-autocomplete="list"
                  aria-activedescendant={modelMenuOpen && displayedModels[highlightedModel]
                    ? `settings-model-option-${highlightedModel}` : undefined}
                />
                <button
                  type="button"
                  className={`organize-model-picker__toggle${modelMenuOpen ? " is-open" : ""}`}
                  disabled={!models.length}
                  aria-label={modelMenuOpen ? "收起模型列表" : "展开模型列表"}
                  aria-expanded={modelMenuOpen}
                  aria-controls="settings-model-options"
                  onClick={() => {
                    modelInput.current?.focus();
                    if (modelMenuOpen) setModelMenuOpen(false);
                    else openModelMenu();
                  }}
                >
                  <ChevronDown aria-hidden="true" />
                </button>
                {modelMenuOpen && (
                  <ul id="settings-model-options" className="organize-model-picker__menu" role="listbox" aria-label="检测到的模型">
                    {displayedModels.length ? displayedModels.map((model, index) => (
                      <li
                        id={`settings-model-option-${index}`}
                        key={model.id}
                        role="option"
                        aria-selected={model.id === draft.provider.model}
                        className={`organize-model-picker__option${model.id === draft.provider.model ? " is-selected" : ""}${index === highlightedModel ? " is-highlighted" : ""}`}
                        onMouseEnter={() => setHighlightedModel(index)}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => chooseModel(model.id)}
                      >
                        <span>{model.id}</span>
                        <Check aria-hidden="true" />
                      </li>
                    )) : <li className="organize-model-picker__empty">未找到匹配模型，可直接使用当前输入值</li>}
                  </ul>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleDetectModels()}
                disabled={!draft.provider.apiKey.trim() || modelStatus === "loading"}
                className="extension-page__wide-secondary extension-page__wide-secondary--blue provider-test-button"
              >
                <RefreshCw aria-hidden="true" />
                {modelStatus === "loading" ? "正在检测模型..." : "检测可用模型"}
              </button>
              <p role={modelStatus === "error" ? "alert" : "status"} aria-live="polite">
                {modelMessage || "使用当前 API Key 和 Endpoint 查询最新模型；也可手动输入。修改模型后需重新测试连接。"}
              </p>
            </div>

            <div className="settings-simple__actions">
              <button onClick={handleTestConnection} disabled={testStatus === "testing"} className="extension-page__wide-secondary extension-page__wide-secondary--blue provider-test-button">
                <FlaskConical aria-hidden="true" />
                {testStatus === "testing" ? "正在连接..." : "测试连接"}
              </button>
              <button
                type="button"
                onClick={() => void handleStartOrganize()}
                disabled={!draft.provider.enabled}
                className="extension-page__wide-primary"
              >
                <Sparkles aria-hidden="true" />
                开始整理
              </button>
            </div>

            <div className="extension-switch-row">
              <div>
                <div className="extension-switch-row__title">允许向此服务发送分类数据</div>
                <div className="extension-switch-row__hint">会发送书签标题、去敏 URL、文件夹路径和可获取的网页元数据；书签移动仍需另行确认</div>
              </div>
              <label className="relative inline-block w-12 h-6">
                <input
                  type="checkbox"
                  checked={Boolean(draft.provider.enabled)}
                  disabled={!draft.provider.testedAt && testStatus !== "success"}
                  onChange={(event) => updateProviderConfig("enabled", event.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-12 h-6 bg-gray-200 peer-checked:bg-blue-500 peer-disabled:cursor-not-allowed peer-disabled:opacity-60 rounded-full peer transition-colors cursor-pointer after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-6"></div>
              </label>
            </div>

            {testStatus === "success" && (
              <div className="extension-status extension-status--success">
                <Check aria-hidden="true" />
                <span>
                  <strong>连接成功</strong>
                  <small>{providerProfile.label} 已返回有效响应；开启下方授权后才会发送书签分类数据。</small>
                </span>
              </div>
            )}

            {testStatus === "error" && (
              <div className="extension-status extension-status--error">
                <AlertCircle aria-hidden="true" />
                <span>
                  <strong>连接失败</strong>
                  <small>{message || "请检查 API Key；技术参数可在高级设置中调整。"}</small>
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="extension-section settings-section settings-section--expert">
          <details className="settings-disclosure">
            <summary className="settings-disclosure__summary">
              <span className="settings-disclosure__intro">
                <span className="settings-disclosure__icon settings-disclosure__icon--expert">
                  <SlidersHorizontal aria-hidden="true" />
                </span>
                <span>
                  <h2 className="extension-section__title">高级设置</h2>
                  <span className="settings-disclosure__hint">自定义 Provider、模型与请求参数</span>
                </span>
              </span>
              <span className="settings-expert__badge">专家模式</span>
              <ChevronRight className="settings-disclosure__chevron" aria-hidden="true" />
            </summary>
            <div className="settings-disclosure__body">
              <div className="settings-expert__notice">
                <Bot aria-hidden="true" />
                <span>仅在使用代理服务、自定义模型或调试兼容性时修改。默认推荐值适合大多数用户。</span>
              </div>
              <div className="extension-form provider-form">
                <div className="provider-form__grid">
                  <div className="extension-field">
                    <label>Provider</label>
                    <select value={draft.provider.type} onChange={(event) => updateProvider(event.target.value as AIProviderType)} className="extension-control">
                      {AI_PROVIDER_OPTIONS.map((provider) => (
                        <option key={provider.type} value={provider.type}>{provider.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="extension-field">
                  <label>Endpoint</label>
                  <input
                    type="url"
                    value={draft.provider.endpoint ?? ""}
                    onChange={(event) => updateProviderConfig("endpoint", event.target.value)}
                    placeholder={providerProfile.endpoint}
                    className="extension-control"
                  />
                </div>

                <div className="provider-form__grid">
                  <div className="extension-field">
                    <label htmlFor="provider-temperature">Temperature</label>
                    <input
                      id="provider-temperature"
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={effectiveTemperature ?? ""}
                      disabled={!providerProfile.supportsTemperature}
                      onChange={(event) => updateProviderConfig(
                        "temperature",
                        event.target.value === "" ? undefined : Number(event.target.value)
                      )}
                      placeholder="不发送"
                      className="extension-control"
                    />
                  </div>
                  <div className="extension-field">
                    <label htmlFor="provider-max-tokens">Max tokens</label>
                    <input
                      id="provider-max-tokens"
                      type="number"
                      min="1"
                      step="1"
                      value={draft.provider.maxTokens ?? ""}
                      onChange={(event) => updateProviderConfig(
                        "maxTokens",
                        event.target.value === "" ? undefined : Number(event.target.value)
                      )}
                      placeholder="按任务自动"
                      className="extension-control"
                    />
                  </div>
                  <div className="extension-field">
                    <label htmlFor="provider-token-param">Token 参数</label>
                    <select
                      id="provider-token-param"
                      value={draft.provider.tokenParam ?? "auto"}
                      onChange={(event) => updateProviderConfig(
                        "tokenParam",
                        event.target.value as AIProviderConfig["tokenParam"]
                      )}
                      className="extension-control"
                    >
                      <option value="auto">自动（{providerProfile.tokenParam}）</option>
                      <option value="max_tokens">max_tokens</option>
                      <option value="max_completion_tokens">max_completion_tokens</option>
                    </select>
                  </div>
                  <div className="extension-field">
                    <label htmlFor="provider-json-mode">JSON mode</label>
                    <select
                      id="provider-json-mode"
                      value={draft.provider.jsonMode ?? "auto"}
                      disabled={!providerProfile.supportsJsonMode}
                      onChange={(event) => updateProviderConfig(
                        "jsonMode",
                        event.target.value as AIProviderConfig["jsonMode"]
                      )}
                      className="extension-control"
                    >
                      <option value="auto">按任务自动</option>
                      <option value="on">始终开启</option>
                      <option value="off">始终关闭</option>
                    </select>
                  </div>
                </div>

                <div className="extension-field">
                  <div className="extension-field__label-row">
                    <label>自定义 Prompt</label>
                    <button
                      type="button"
                      className="extension-text-button"
                      onClick={() => setDraft({ ...draft, customPrompt: DEFAULT_CLASSIFY_PROMPT })}
                    >
                      <RotateCcw className="w-3 h-3" />
                      恢复默认
                    </button>
                  </div>
                  <textarea
                    value={draft.customPrompt ?? DEFAULT_CLASSIFY_PROMPT}
                    onChange={(event) => setDraft({ ...draft, customPrompt: event.target.value })}
                    placeholder={DEFAULT_CLASSIFY_PROMPT}
                    rows={8}
                    className="extension-control extension-textarea"
                  />
                  <p>请保留输出 schema 中的 id、categoryPath、confidence 和 reason。</p>
                </div>

                <div className="extension-summary-panel provider-summary">
                  <p>{providerProfile.endpointHint}</p>
                  <p>{providerProfile.modelHint}</p>
                  <div className="provider-summary__chips" aria-label="当前请求配置">
                    <span>{effectiveTokenParam}</span>
                    <span>{providerProfile.supportsJsonMode ? "JSON 可用" : "Prompt JSON"}</span>
                    <span>{effectiveTemperature === undefined ? "无 temperature" : `temperature ${effectiveTemperature}`}</span>
                  </div>
                </div>
              </div>
            </div>
          </details>
        </section>

        <section className="extension-section settings-section">
          <details className="settings-disclosure">
            <summary className="settings-disclosure__summary">
              <span className="settings-disclosure__intro">
                <span className="settings-disclosure__icon">
                  <FolderTree aria-hidden="true" />
                </span>
                <span>
                  <h2 className="extension-section__title">整理选项</h2>
                  <span className="settings-disclosure__hint">控制文件夹层级、数量和 URL 发送策略</span>
                </span>
              </span>
              <ChevronRight className="settings-disclosure__chevron" aria-hidden="true" />
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

              <div className="extension-field">
                <label>未分类书签处理方式</label>
                <select
                  value={draft.unclassifiedHandling}
                  onChange={(event) => setDraft({ ...draft, unclassifiedHandling: event.target.value as Settings["unclassifiedHandling"] })}
                  className="extension-control"
                >
                  <option value="preserveSourcePath">保持原位置（推荐）</option>
                  <option value="collect">全部放入“未分类”文件夹</option>
                </select>
                <p>适用于 AI 无法可靠分类、低置信度或返回待整理/未分类的书签；默认保持原位置，只有明确选择集中处理时才移动到“未分类”。</p>
              </div>

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
              <span className="settings-disclosure__intro">
                <span className="settings-disclosure__icon">
                  <ShieldCheck aria-hidden="true" />
                </span>
                <span>
                  <h2 className="extension-section__title">隐私与权限</h2>
                  <span className="settings-disclosure__hint">管理历史权限和本地数据说明</span>
                </span>
              </span>
              <ChevronRight className="settings-disclosure__chevron" aria-hidden="true" />
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
