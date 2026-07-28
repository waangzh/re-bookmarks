import { useEffect, useRef, useState, type ChangeEvent, type TextareaHTMLAttributes } from "react";
import { Link } from "react-router";
import {
  ArrowLeft,
  Ban,
  Bookmark,
  Check,
  ChevronRight,
  Clock3,
  Download,
  Folder,
  FolderOpen,
  GraduationCap,
  Info,
  MoreVertical,
  Plus,
  Save,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { FolderHabitProfile } from "../types";
import {
  analyzeAndSaveFolderHabits,
  cleanFolderHabitProfile,
  exportFolderHabitProfile,
  getFolderHabitProfile,
  importFolderHabitProfileJson,
  saveEditedFolderHabitProfile,
} from "../services/habits";

const emptyProfile = (): FolderHabitProfile => ({
  id: `habit-${Date.now()}`,
  createdAt: Date.now(),
  folderCount: 0,
  bookmarkCount: 0,
  summary: "",
  preferredTopLevelFolders: [],
  folderRules: [],
  avoidRules: [],
  promptHint: "",
});

function pathToText(path: string[]) {
  return path.join(" / ");
}

function normalizeDraftPath(path: string[]) {
  return path.length ? path : [""];
}

function shouldSplitCompactSlash(left: string, right: string) {
  const isShortTechnicalToken = /^[A-Za-z0-9+#.-]{1,4}$/.test(left) && /^[A-Za-z0-9+#.-]{1,4}$/.test(right);
  return !isShortTechnicalToken;
}

function splitPastedPath(text: string) {
  const normalized = text.replace(/[>\\]/g, " / ").replace(/\s+[\/／]\s+/g, " / ");
  const spacedParts = normalized.split(" / ").map((part) => part.trim()).filter(Boolean);
  if (spacedParts.length > 1) return spacedParts;

  const compactSlash = text.match(/^(.+?)[\/／](.+)$/);
  if (!compactSlash) return [text.trim()].filter(Boolean);

  const left = compactSlash[1].trim();
  const right = compactSlash[2].trim();
  return shouldSplitCompactSlash(left, right) ? [left, right].filter(Boolean) : [text.trim()].filter(Boolean);
}

function updatePathSegment(path: string[], index: number, rawValue: string) {
  const value = rawValue.replace(/\s+/g, " ");
  const pastedPath = index === 0 && path.length <= 1 ? splitPastedPath(rawValue) : [];
  if (pastedPath.length > 1) return pastedPath.slice(0, 3);

  const next = normalizeDraftPath(path).slice(0, 3);
  next[index] = value;
  return next;
}

function removePathSegment(path: string[], index: number) {
  const next = normalizeDraftPath(path).filter((_, itemIndex) => itemIndex !== index);
  return next.length ? next : [""];
}

function getFolderRuleGroupTitle(path: string[]) {
  return path[0]?.trim() || "未命名分类";
}

function resizeTextarea(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function AutoResizeTextarea({
  className = "",
  onChange,
  value,
  rows = 1,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      resizeTextarea(textareaRef.current);
    }
  }, [value]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    resizeTextarea(event.currentTarget);
    onChange?.(event);
  };

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={value}
      onChange={handleChange}
      rows={rows}
      className={`extension-control extension-textarea extension-textarea--autosize ${className}`.trim()}
    />
  );
}

type FolderPathBuilderProps = {
  value: string[];
  onChange: (path: string[]) => void;
};

function FolderPathBuilder({ value, onChange }: FolderPathBuilderProps) {
  const segments = normalizeDraftPath(value);

  return (
    <div className="habit-path-builder">
      <div className="habit-path-builder__segments" aria-label="文件夹路径层级">
        {segments.map((segment, index) => (
          <div key={`path-segment-${index}`} className="habit-path-segment">
            <span className="habit-path-segment__prefix">{index === 0 ? "一级" : `第 ${index + 1} 层`}</span>
            <input
              value={segment}
              onChange={(event) => onChange(updatePathSegment(value, index, event.target.value))}
              className="habit-path-segment__input"
              placeholder={index === 0 ? "例如 Tools" : "例如 开发工具"}
            />
            {segments.length > 1 && (
              <button
                type="button"
                className="habit-path-segment__remove"
                onClick={() => onChange(removePathSegment(value, index))}
                aria-label="移除该层级"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        {segments.length < 3 && (
          <button type="button" className="habit-path-builder__add" onClick={() => onChange([...segments, ""])}>
            <Plus className="w-3 h-3" />
            添加层级
          </button>
        )}
      </div>
      <p className="extension-field__hint">每一层单独填写；粘贴 “Tools / 开发工具” 会自动拆成两层，AI/ML 或 C/C++ 会保留为单个名称。</p>
    </div>
  );
}

export function HabitPresets() {
  const [profile, setProfile] = useState<FolderHabitProfile | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "analyzing" | "saving" | "error">("loading");
  const [message, setMessage] = useState("");
  const [openFolderGroups, setOpenFolderGroups] = useState<Set<string>>(() => new Set());
  const [openFolderMenu, setOpenFolderMenu] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getFolderHabitProfile()
      .then(async (stored) => {
        if (!stored) {
          setProfile(emptyProfile());
          return;
        }
        setProfile(cleanFolderHabitProfile(stored));
      })
      .finally(() => setStatus("idle"));
  }, []);

  const updateProfile = (updater: (current: FolderHabitProfile) => FolderHabitProfile) => {
    setProfile((current) => updater(current ?? emptyProfile()));
  };

  const handleAnalyze = async () => {
    setStatus("analyzing");
    setMessage("");
    try {
      const next = await analyzeAndSaveFolderHabits();
      setProfile(next);
      setMessage(next.analysisWarning ?? "已重新分析当前书签分类习惯");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "分析失败");
      return;
    }
    setStatus("idle");
  };

  const handleSave = async () => {
    if (!profile) return;
    setStatus("saving");
    setMessage("");
    try {
      const next = await saveEditedFolderHabitProfile(profile);
      setProfile(next);
      setMessage("分类偏好调整已保存");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "保存失败");
      return;
    }
    setStatus("idle");
  };

  const handleExport = () => {
    if (!profile) return;
    const content = exportFolderHabitProfile(profile);
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `remarks-classification-rules-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage("分类规则已导出");
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setStatus("saving");
    setMessage("");
    try {
      const next = await importFolderHabitProfileJson(await file.text());
      setProfile(next);
      setMessage("分类规则已导入，旧预览缓存已清理");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "导入失败");
      return;
    }
    setStatus("idle");
  };

  const isBusy = status === "loading" || status === "analyzing" || status === "saving";
  const current = profile ?? emptyProfile();
  const learning = current.learning;
  const learnedCount = (learning?.correctionCount ?? 0) + (learning?.rejectionCount ?? 0);
  const lastUpdatedAt = learning?.lastLearnedAt ?? current.createdAt;
  const lastUpdatedText = lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleString() : "尚未学习";
  const depthPreference = !learning || learning.depthVotes.levelOne + learning.depthVotes.nested < 2
    ? "继续观察"
    : learning.depthVotes.nested > learning.depthVotes.levelOne
      ? "偏好二级结构"
      : "偏好一级结构";
  const stylePreference = !learning || learning.styleVotes.topic + learning.styleVotes.purpose < 2
    ? "继续观察"
    : learning.styleVotes.purpose > learning.styleVotes.topic
      ? "偏好用途分类"
      : "偏好主题分类";
  const folderRuleGroups = current.folderRules.reduce<Array<{ title: string; indexes: number[] }>>((groups, rule, index) => {
    const title = getFolderRuleGroupTitle(rule.folderPath);
    const existing = groups.find((group) => group.title === title);
    if (existing) {
      existing.indexes.push(index);
    } else {
      groups.push({ title, indexes: [index] });
    }
    return groups;
  }, []);

  const updateFolderRule = (index: number, updater: (rule: FolderHabitProfile["folderRules"][number]) => FolderHabitProfile["folderRules"][number]) => {
    updateProfile((item) => ({
      ...item,
      folderRules: item.folderRules.map((rule, itemIndex) => (itemIndex === index ? updater(rule) : rule)),
    }));
  };

  const setFolderGroupOpen = (title: string, open: boolean) => {
    setOpenFolderGroups((current) => {
      const next = new Set(current);
      if (open) {
        next.add(title);
      } else {
        next.delete(title);
      }
      return next;
    });
  };

  const addFolderRule = (folderPath: string[] = [], openGroupTitle?: string) => {
    updateProfile((item) => ({
      ...item,
      folderRules: [...item.folderRules, { folderPath, pattern: "" }],
    }));
    if (openGroupTitle) {
      setFolderGroupOpen(openGroupTitle, true);
    }
    setOpenFolderMenu(null);
  };

  const removeFolderRuleGroup = (indexes: number[]) => {
    const removeIndexes = new Set(indexes);
    updateProfile((item) => ({
      ...item,
      folderRules: item.folderRules.filter((_, itemIndex) => !removeIndexes.has(itemIndex)),
    }));
    setOpenFolderMenu(null);
  };

  return (
    <div className="extension-page extension-page--habits">
      <div className="extension-page__inner habit-page-shell">
        <div className="habit-brand-bar">
          <span className="habit-brand-bar__mark">
            <Bookmark className="w-4 h-4" />
          </span>
          <span>ReMarks</span>
        </div>

        <div className="extension-page__header habit-page-hero">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">分类偏好</h1>
              <p className="extension-page__subtitle">查看和管理 ReMarks 学到的分类偏好</p>
            </div>
          </div>
        </div>

        <div className="extension-button-row habit-presets-actions">
          <button onClick={handleAnalyze} disabled={isBusy} className="extension-page__wide-secondary extension-page__wide-secondary--blue">
            <Sparkles className="w-4 h-4" />
            {status === "analyzing" ? "分析中" : "更新书签画像"}
          </button>
          <button onClick={handleSave} disabled={isBusy} className="extension-page__wide-primary">
            <Save className="w-4 h-4" />
            {status === "saving" ? "保存中" : "保存调整"}
          </button>
          <button type="button" onClick={handleExport} disabled={isBusy} className="extension-page__wide-secondary">
            <Download className="w-4 h-4" />
            导出规则
          </button>
          <button type="button" onClick={() => importInputRef.current?.click()} disabled={isBusy} className="extension-page__wide-secondary">
            <Upload className="w-4 h-4" />
            导入规则
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => void handleImportFile(event)}
          />
        </div>

        <div className="extension-summary-panel habit-presets-help habit-info-callout">
          <Info className="w-4 h-4" />
          <p>无需维护 Prompt。你修改分类或拒绝建议时，ReMarks 会在本地记录反馈并用于后续分类；“更新书签画像”才会把脱敏样例发送给已配置的 AI Provider。</p>
        </div>

        {message && (
          <div className={`extension-status ${status === "error" ? "extension-status--error" : "extension-status--success"}`}>
            <span>{message}</span>
          </div>
        )}

        <section className="extension-section habit-card habit-learning-card">
          <div className="habit-section-heading habit-section-heading--with-action">
            <span className="habit-section-heading__icon"><Sparkles className="w-4 h-4" /></span>
            <div>
              <h2 className="extension-section__title">自动学习</h2>
              <p>来自你实际修改和拒绝建议的行为反馈</p>
            </div>
            <span className="habit-learning-badge">后台生效</span>
          </div>
          <div className="habit-learning-signal-grid">
            <div><strong>{learnedCount}</strong><span>次行为反馈</span></div>
            <div><strong>{depthPreference}</strong><span>目录层级</span></div>
            <div><strong>{stylePreference}</strong><span>分类方式</span></div>
          </div>

          {(learning?.categoryCorrections.length ?? 0) > 0 && (
            <div className="habit-learned-list">
              <p className="habit-learned-list__title">分类修正</p>
              {learning?.categoryCorrections.slice(0, 8).map((item, index) => (
                <div
                  key={`${pathToText(item.fromFolderPath)}-${pathToText(item.toFolderPath)}`}
                  className="habit-learned-row"
                >
                  <div>
                    <strong>{pathToText(item.fromFolderPath)} → {pathToText(item.toFolderPath)}</strong>
                    <span>已按这个方向调整 {item.count} 次</span>
                  </div>
                  <button
                    type="button"
                    aria-label={`删除 ${pathToText(item.fromFolderPath)} 到 ${pathToText(item.toFolderPath)} 的修正`}
                    onClick={() => updateProfile((value) => ({
                      ...value,
                      learning: value.learning
                        ? {
                            ...value.learning,
                            categoryCorrections: value.learning.categoryCorrections.filter((_, itemIndex) => itemIndex !== index),
                          }
                        : undefined,
                    }))}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {(learning?.domainPreferences.length ?? 0) > 0 ? (
            <div className="habit-learned-list">
              <p className="habit-learned-list__title">域名归档偏好</p>
              {learning?.domainPreferences.slice(0, 8).map((item, index) => (
                <div key={`${item.domain}-${pathToText(item.folderPath)}`} className="habit-learned-row">
                  <div>
                    <strong>{item.domain}</strong>
                    <span>优先归入 {pathToText(item.folderPath)} · {item.count} 次</span>
                  </div>
                  <button
                    type="button"
                    aria-label={`删除 ${item.domain} 的学习偏好`}
                    onClick={() => updateProfile((value) => ({
                      ...value,
                      learning: value.learning
                        ? {
                            ...value.learning,
                            domainPreferences: value.learning.domainPreferences.filter((_, itemIndex) => itemIndex !== index),
                          }
                        : undefined,
                    }))}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : learnedCount === 0 ? (
            <p className="habit-empty-text">还没有行为反馈。下一次调整 AI 建议后，这里会自动出现学到的偏好。</p>
          ) : null}

          {(learning?.rejectedFolderPaths.length ?? 0) > 0 && (
            <div className="habit-learned-list">
              <p className="habit-learned-list__title">减少推荐的目录</p>
              <div className="habit-learned-chips">
                {learning?.rejectedFolderPaths.slice(0, 8).map((item, index) => (
                  <span key={`${pathToText(item.folderPath)}-${index}`}>
                    {item.isNewFolder
                      ? `不新建 ${pathToText(item.folderPath)}`
                      : `${item.domain ?? "类似来源"} → 不归入 ${pathToText(item.folderPath)}`}
                    <button
                      type="button"
                      aria-label={`恢复推荐 ${pathToText(item.folderPath)}`}
                      onClick={() => updateProfile((value) => ({
                        ...value,
                        learning: value.learning
                          ? {
                              ...value.learning,
                              rejectedFolderPaths: value.learning.rejectedFolderPaths.filter((_, itemIndex) => itemIndex !== index),
                            }
                          : undefined,
                      }))}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="extension-section habit-card habit-overview-card">
          <div className="habit-section-heading">
            <span className="habit-section-heading__icon"><GraduationCap className="w-4 h-4" /></span>
            <div>
              <h2 className="extension-section__title">学习概览</h2>
              <p>现有书签结构提供的基础画像</p>
            </div>
          </div>
          <div className="habit-metrics-grid">
            <div className="habit-metric-item">
              <span><Folder className="w-4 h-4" /></span>
              <strong>{current.folderCount}</strong>
              <small>文件夹</small>
            </div>
            <div className="habit-metric-item">
              <span><Bookmark className="w-4 h-4" /></span>
              <strong>{current.bookmarkCount}</strong>
              <small>书签</small>
            </div>
            <div className="habit-metric-item habit-metric-item--wide">
              <span><Clock3 className="w-4 h-4" /></span>
              <strong>{lastUpdatedText}</strong>
              <small>最后更新时间</small>
            </div>
          </div>
          <div className="extension-field habit-summary-field">
            <label>整体偏好摘要（可选微调）</label>
            <AutoResizeTextarea
              value={current.summary}
              onChange={(event) => updateProfile((item) => ({ ...item, summary: event.target.value }))}
              placeholder="总结这套分类习惯的命名、粒度和偏好"
            />
          </div>
          {current.analysisWarning && <p className="habit-warning-text">{current.analysisWarning}</p>}
        </section>

        <section className="extension-section habit-card">
          <div className="habit-section-heading habit-section-heading--with-action">
            <span className="habit-section-heading__icon"><Tag className="w-4 h-4" /></span>
            <div>
              <h2 className="extension-section__title">常用一级分类</h2>
              <p>这些分类会作为 AI 优先复用的顶层文件夹</p>
            </div>
            <button
              type="button"
              className="habit-outline-button"
              onClick={() => updateProfile((item) => ({ ...item, preferredTopLevelFolders: [...item.preferredTopLevelFolders, ""] }))}
            >
              <Plus className="w-3 h-3" />
              添加分类
            </button>
          </div>
          <div className="habit-chip-editor" aria-label="常用一级分类">
            {current.preferredTopLevelFolders.map((folder, index) => (
              <span key={`preferred-top-level-${index}`} className="habit-category-chip">
                <input
                  value={folder}
                  size={Math.min(Math.max(folder.trim().length || 3, 3), 18)}
                  onChange={(event) =>
                    updateProfile((item) => ({
                      ...item,
                      preferredTopLevelFolders: item.preferredTopLevelFolders.map((value, itemIndex) =>
                        itemIndex === index ? event.target.value : value
                      ),
                    }))
                  }
                  placeholder="分类名"
                />
                <button
                  type="button"
                  onClick={() =>
                    updateProfile((item) => ({
                      ...item,
                      preferredTopLevelFolders: item.preferredTopLevelFolders.filter((_, itemIndex) => itemIndex !== index),
                    }))
                  }
                  aria-label="删除分类"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            {!current.preferredTopLevelFolders.length && <p className="habit-empty-text">暂无常用一级分类，点击“添加分类”开始维护。</p>}
          </div>
        </section>

        <section className="extension-section habit-card habit-folder-rules-card">
          <div className="habit-section-heading habit-section-heading--with-action">
            <span className="habit-section-heading__icon"><FolderOpen className="w-4 h-4" /></span>
            <div>
              <h2 className="extension-section__title">文件夹规则</h2>
              <p>按父文件夹分组维护，避免重复输入完整路径</p>
            </div>
            <button type="button" className="habit-outline-button" onClick={() => addFolderRule([""])}>
              <Plus className="w-3 h-3" />
              新建父分类
            </button>
          </div>

          <div className="habit-rule-list">
            {folderRuleGroups.map((group) => (
              <details
                key={group.title}
                open={openFolderGroups.has(group.title)}
                onToggle={(event) => setFolderGroupOpen(group.title, event.currentTarget.open)}
                className="habit-folder-group"
              >
                <summary className="habit-folder-group__summary">
                  <div className="habit-folder-group__title">
                    <ChevronRight className="habit-folder-group__chevron w-3 h-3" />
                    <Folder className="w-4 h-4" />
                    <strong>{group.title}</strong>
                    <span>{group.indexes.length}</span>
                  </div>
                  <div className="habit-folder-group__actions" onClick={(event) => event.stopPropagation()}>
                    <div className="habit-folder-group__menu-wrap">
                      <button
                        type="button"
                        className="habit-icon-button"
                        aria-label="更多操作"
                        aria-expanded={openFolderMenu === group.title}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenFolderMenu((current) => current === group.title ? null : group.title);
                        }}
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                      {openFolderMenu === group.title && (
                        <div className="habit-folder-group__menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={(event) => {
                              event.stopPropagation();
                              setFolderGroupOpen(group.title, !openFolderGroups.has(group.title));
                              setOpenFolderMenu(null);
                            }}
                          >
                            {openFolderGroups.has(group.title) ? "收起此分类" : "展开此分类"}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={(event) => {
                              event.stopPropagation();
                              addFolderRule(group.title === "未命名分类" ? [""] : [group.title, ""], group.title);
                            }}
                          >
                            添加子分类
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="habit-folder-group__menu-danger"
                            onClick={(event) => {
                              event.stopPropagation();
                              removeFolderRuleGroup(group.indexes);
                            }}
                          >
                            移除此组规则
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </summary>

                <div className="habit-folder-group__rows">
                  {group.indexes.map((ruleIndex) => {
                    const rule = current.folderRules[ruleIndex];
                    return (
                      <div key={`${pathToText(rule.folderPath)}-${ruleIndex}`} className="habit-rule-row">
                        <div className="extension-field habit-rule-row__path">
                          <label>文件夹路径</label>
                          <FolderPathBuilder
                            value={rule.folderPath}
                            onChange={(folderPath) => updateFolderRule(ruleIndex, (value) => ({ ...value, folderPath }))}
                          />
                        </div>
                        <div className="extension-field habit-rule-row__pattern">
                          <label>适用内容特征</label>
                          <AutoResizeTextarea
                            value={rule.pattern}
                            onChange={(event) => updateFolderRule(ruleIndex, (value) => ({ ...value, pattern: event.target.value }))}
                            placeholder="例如：工具官网、资源站、导航站"
                          />
                        </div>
                        <div className="habit-rule-row__actions">
                          <button
                            type="button"
                            className="extension-icon-action extension-icon-action--blue"
                            aria-label="保存规则"
                            title="保存规则"
                            disabled={isBusy}
                            onClick={handleSave}
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            className="extension-icon-action extension-icon-action--red"
                            aria-label="删除规则"
                            title="删除规则"
                            onClick={() =>
                              updateProfile((item) => ({
                                ...item,
                                folderRules: item.folderRules.filter((_, itemIndex) => itemIndex !== ruleIndex),
                              }))
                            }
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>            ))}
            {!folderRuleGroups.length && <p className="habit-empty-text">暂无文件夹规则，点击“新建父分类”添加第一条规则。</p>}
          </div>
          <button type="button" className="habit-add-wide" onClick={() => addFolderRule([""])}>
            <Plus className="w-3 h-3" />
            添加父分类
          </button>
        </section>

        <section className="extension-section habit-card">
          <div className="habit-section-heading habit-section-heading--with-action">
            <span className="habit-section-heading__icon"><Ban className="w-4 h-4" /></span>
            <div>
              <h2 className="extension-section__title">避免规则</h2>
              <p>告诉 AI 哪些情况不希望细分</p>
            </div>
            <span className="habit-section-count">{current.avoidRules.length} 条规则</span>
          </div>
          <div className="habit-avoid-grid">
            {current.avoidRules.map((rule, index) => (
              <div key={`${rule}-${index}`} className="habit-avoid-chip">
                <input
                  value={rule}
                  onChange={(event) =>
                    updateProfile((item) => ({
                      ...item,
                      avoidRules: item.avoidRules.map((value, itemIndex) => (itemIndex === index ? event.target.value : value)),
                    }))
                  }
                  placeholder="例如：避免按网站域名过度分类"
                />
                <button
                  type="button"
                  onClick={() =>
                    updateProfile((item) => ({
                      ...item,
                      avoidRules: item.avoidRules.filter((_, itemIndex) => itemIndex !== index),
                    }))
                  }
                  aria-label="删除避免规则"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="habit-add-rule-tile"
              onClick={() => updateProfile((item) => ({ ...item, avoidRules: [...item.avoidRules, ""] }))}
            >
              <Plus className="w-3 h-3" />
              添加规则
            </button>
          </div>
        </section>

        <details className="extension-section habit-card habit-advanced-details">
          <summary>
            <span className="habit-section-heading__icon"><Sparkles className="w-4 h-4" /></span>
            <span>
              <strong>高级：整体分类提示</strong>
              <small>自动学习已经会生成约束，通常不需要编辑</small>
            </span>
            <ChevronRight className="w-4 h-4 habit-advanced-details__chevron" />
          </summary>
          <AutoResizeTextarea
            value={current.promptHint}
            onChange={(event) => updateProfile((item) => ({ ...item, promptHint: event.target.value }))}
            placeholder="可选：补充自动学习无法表达的特殊分类原则。"
            className="habit-prompt-textarea"
          />
        </details>
      </div>
    </div>
  );
}
