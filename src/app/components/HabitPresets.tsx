import { useEffect, useRef, useState, type ChangeEvent, type TextareaHTMLAttributes } from "react";
import { Link } from "react-router";
import {
  ArrowLeft,
  Ban,
  Bookmark,
  Check,
  ChevronRight,
  Clock3,
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
  X,
} from "lucide-react";
import type { FolderHabitProfile } from "../types";
import {
  analyzeAndSaveFolderHabits,
  cleanFolderHabitProfile,
  getFolderHabitProfile,
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
      setMessage("分类习惯预设已保存");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "保存失败");
      return;
    }
    setStatus("idle");
  };

  const isBusy = status === "loading" || status === "analyzing" || status === "saving";
  const current = profile ?? emptyProfile();
  const lastUpdatedText = current.createdAt ? new Date(current.createdAt).toLocaleString() : "未生成";
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
              <h1 className="extension-page__title">分类习惯预设</h1>
              <p className="extension-page__subtitle">查看 AI 学到的分类偏好，并手动微调</p>
            </div>
          </div>
        </div>

        <div className="extension-button-row habit-presets-actions">
          <button onClick={handleAnalyze} disabled={isBusy} className="extension-page__wide-secondary extension-page__wide-secondary--blue">
            <Sparkles className="w-4 h-4" />
            {status === "analyzing" ? "分析中" : "重新分析"}
          </button>
          <button onClick={handleSave} disabled={isBusy} className="extension-page__wide-primary">
            <Save className="w-4 h-4" />
            {status === "saving" ? "保存中" : "保存预设"}
          </button>
        </div>

        <div className="extension-summary-panel habit-presets-help habit-info-callout">
          <Info className="w-4 h-4" />
          <p>重新分析会把现有文件夹路径、书签标题、域名和去除 query/hash 的 URL 样例发送给已配置的 AI Provider；不会发送浏览历史。</p>
        </div>

        {message && (
          <div className={`extension-status ${status === "error" ? "extension-status--error" : "extension-status--success"}`}>
            <span>{message}</span>
          </div>
        )}

        <section className="extension-section habit-card habit-overview-card">
          <div className="habit-section-heading">
            <span className="habit-section-heading__icon"><GraduationCap className="w-4 h-4" /></span>
            <div>
              <h2 className="extension-section__title">学习概览</h2>
              <p>当前分类画像的样本规模与更新时间</p>
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
            <label>总结</label>
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

        <section className="extension-section habit-card">
          <div className="habit-section-heading habit-section-heading--with-action">
            <span className="habit-section-heading__icon"><Sparkles className="w-4 h-4" /></span>
            <div>
              <h2 className="extension-section__title">给 AI 的预设提示</h2>
              <p>传递给分类模型的整体指导原则</p>
            </div>
          </div>
          <AutoResizeTextarea
            value={current.promptHint}
            onChange={(event) => updateProfile((item) => ({ ...item, promptHint: event.target.value }))}
            placeholder="请参考以上文件夹规则，按主题、用途和来源分层分类，保持命名简洁、粒度适中。"
            className="habit-prompt-textarea"
          />
        </section>
      </div>
    </div>
  );
}
