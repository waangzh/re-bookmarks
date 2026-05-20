import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, ChevronRight, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import type { FolderHabitProfile } from "../types";
import {
  analyzeAndSaveFolderHabits,
  getFolderHabitProfile,
  saveEditedFolderHabitProfile,
} from "../services/habits";
import { CollapsibleSection } from "./CollapsibleSection";

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

function textToPath(text: string) {
  return text.split("/").flatMap((part) => part.split(" / ")).map((part) => part.trim()).filter(Boolean);
}

export function HabitPresets() {
  const [profile, setProfile] = useState<FolderHabitProfile | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "analyzing" | "saving" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    getFolderHabitProfile()
      .then(async (stored) => {
        if (!stored) {
          setProfile(emptyProfile());
          return;
        }
        const cleaned = await saveEditedFolderHabitProfile(stored);
        setProfile(cleaned);
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
      setMessage("已重新分析当前书签分类习惯");
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

  return (
    <div className="extension-page extension-page--habits">
      <div className="extension-page__inner">
        <div className="extension-page__header">
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

        {message && (
          <div className={`extension-status ${status === "error" ? "extension-status--error" : "extension-status--success"}`}>
            <span>{message}</span>
          </div>
        )}

        <section className="extension-section">
          <h2 className="extension-section__title">学习概览</h2>
          <div className="extension-form">
            <div className="extension-summary-panel">
              <p>
                已学习 {current.folderCount} 个文件夹、{current.bookmarkCount} 个书签。最后更新时间：
                {current.createdAt ? new Date(current.createdAt).toLocaleString() : "未生成"}
              </p>
            </div>
            <div className="extension-field">
              <label>总结</label>
              <textarea
                value={current.summary}
                onChange={(event) => updateProfile((item) => ({ ...item, summary: event.target.value }))}
                rows={3}
                className="extension-control extension-textarea"
              />
            </div>
          </div>
        </section>

        <CollapsibleSection title="常用一级分类" count={current.preferredTopLevelFolders.length} hint="展开后编辑常用的一级文件夹">
          <div className="extension-section__bar extension-section__bar--plain collapsible-section__body-actions">
            <button
              type="button"
              className="extension-text-button"
              onClick={() => updateProfile((item) => ({ ...item, preferredTopLevelFolders: [...item.preferredTopLevelFolders, ""] }))}
            >
              <Plus className="w-3 h-3" />
              添加
            </button>
          </div>
          <div className="extension-summary-panel habit-presets-help">
            <p>
              说明：“一级分类”是指去掉“书签栏”等浏览器根目录后的第一层文件夹。
            </p>
          </div>
          <div className="habit-editor-list">
            {current.preferredTopLevelFolders.map((folder, index) => (
              <div key={`${folder}-${index}`} className="habit-editor-row">
                <input
                  value={folder}
                  onChange={(event) =>
                    updateProfile((item) => ({
                      ...item,
                      preferredTopLevelFolders: item.preferredTopLevelFolders.map((value, itemIndex) =>
                        itemIndex === index ? event.target.value : value
                      ),
                    }))
                  }
                  className="extension-control"
                  placeholder="例如：开发"
                />
                <button
                  type="button"
                  className="extension-icon-action extension-icon-action--red"
                  onClick={() =>
                    updateProfile((item) => ({
                      ...item,
                      preferredTopLevelFolders: item.preferredTopLevelFolders.filter((_, itemIndex) => itemIndex !== index),
                    }))
                  }
                  aria-label="删除分类"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="文件夹规则" count={current.folderRules.length} hint="展开后编辑文件夹路径与适用特征">
          <div className="extension-section__bar extension-section__bar--plain collapsible-section__body-actions">
            <button
              type="button"
              className="extension-text-button"
              onClick={() =>
                updateProfile((item) => ({
                  ...item,
                  folderRules: [...item.folderRules, { folderPath: [], pattern: "" }],
                }))
              }
            >
              <Plus className="w-3 h-3" />
              添加
            </button>
          </div>
          <div className="habit-rule-list">
            {current.folderRules.map((rule, index) => (
              <div key={`${pathToText(rule.folderPath)}-${index}`} className="habit-rule-card">
                <div className="habit-rule-card__header">
                  <div className="extension-field">
                    <label>文件夹路径</label>
                    <input
                      value={pathToText(rule.folderPath)}
                      onChange={(event) =>
                        updateProfile((item) => ({
                          ...item,
                          folderRules: item.folderRules.map((value, itemIndex) =>
                            itemIndex === index ? { ...value, folderPath: textToPath(event.target.value) } : value
                          ),
                        }))
                      }
                      className="extension-control"
                      placeholder="开发 / 文档"
                    />
                  </div>
                  <button
                    type="button"
                    className="extension-icon-action extension-icon-action--red habit-rule-card__delete"
                    aria-label="删除规则"
                    title="删除规则"
                    onClick={() =>
                      updateProfile((item) => ({
                        ...item,
                        folderRules: item.folderRules.filter((_, itemIndex) => itemIndex !== index),
                      }))
                    }
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <details className="habit-rule-feature-details">
                  <summary className="habit-rule-feature-summary">
                    <span className="habit-rule-feature-title">
                      <ChevronRight className="habit-rule-feature-icon" />
                      适用内容特征
                    </span>
                    <span className="habit-rule-feature-hint">点击展开浏览编辑</span>
                  </summary>
                  <div className="extension-field habit-rule-feature-body">
                    <textarea
                      value={rule.pattern}
                      onChange={(event) =>
                        updateProfile((item) => ({
                          ...item,
                          folderRules: item.folderRules.map((value, itemIndex) =>
                            itemIndex === index ? { ...value, pattern: event.target.value } : value
                          ),
                        }))
                      }
                      rows={3}
                      className="extension-control extension-textarea"
                      placeholder="适合放入这里的书签特征"
                    />
                  </div>
                </details>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="避免规则" count={current.avoidRules.length} hint="展开后编辑不希望 AI 过度分类的规则">
          <div className="extension-section__bar extension-section__bar--plain collapsible-section__body-actions">
            <button
              type="button"
              className="extension-text-button"
              onClick={() => updateProfile((item) => ({ ...item, avoidRules: [...item.avoidRules, ""] }))}
            >
              <Plus className="w-3 h-3" />
              添加
            </button>
          </div>
          <div className="habit-editor-list">
            {current.avoidRules.map((rule, index) => (
              <div key={`${rule}-${index}`} className="habit-editor-row">
                <input
                  value={rule}
                  onChange={(event) =>
                    updateProfile((item) => ({
                      ...item,
                      avoidRules: item.avoidRules.map((value, itemIndex) => itemIndex === index ? event.target.value : value),
                    }))
                  }
                  className="extension-control"
                  placeholder="例如：不要为单个网站创建独立文件夹"
                />
                <button
                  type="button"
                  className="extension-icon-action extension-icon-action--red"
                  onClick={() =>
                    updateProfile((item) => ({
                      ...item,
                      avoidRules: item.avoidRules.filter((_, itemIndex) => itemIndex !== index),
                    }))
                  }
                  aria-label="删除避免规则"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="给 AI 的预设提示" hint="展开后编辑传给分类模型的习惯提示">
          <textarea
            value={current.promptHint}
            onChange={(event) => updateProfile((item) => ({ ...item, promptHint: event.target.value }))}
            rows={6}
            className="extension-control extension-textarea"
          />
        </CollapsibleSection>
      </div>
    </div>
  );
}
