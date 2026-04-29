import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import type { FolderHabitProfile } from "../types";
import {
  analyzeAndSaveFolderHabits,
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
    <div className="extension-page">
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

        {message && (
          <div className={`extension-status ${status === "error" ? "extension-status--error" : "extension-status--success"}`}>
            <span>{message}</span>
          </div>
        )}

        <section className="extension-section">
          <h2 className="extension-section__title">学习概览</h2>
          <div className="extension-form">
            <div className="extension-privacy">
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

        <section className="extension-section">
          <div className="extension-section__bar extension-section__bar--plain">
            <h2 className="extension-section__title">常用一级分类</h2>
            <button
              type="button"
              className="extension-text-button"
              onClick={() => updateProfile((item) => ({ ...item, preferredTopLevelFolders: [...item.preferredTopLevelFolders, ""] }))}
            >
              <Plus className="w-3 h-3" />
              添加
            </button>
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
        </section>

        <section className="extension-section">
          <div className="extension-section__bar extension-section__bar--plain">
            <h2 className="extension-section__title">文件夹规则</h2>
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
                <div className="extension-field">
                  <label>适用内容特征</label>
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
                <button
                  type="button"
                  className="extension-page__wide-secondary"
                  onClick={() =>
                    updateProfile((item) => ({
                      ...item,
                      folderRules: item.folderRules.filter((_, itemIndex) => itemIndex !== index),
                    }))
                  }
                >
                  <Trash2 className="w-4 h-4" />
                  删除规则
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="extension-section">
          <div className="extension-section__bar extension-section__bar--plain">
            <h2 className="extension-section__title">避免规则</h2>
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
        </section>

        <section className="extension-section">
          <h2 className="extension-section__title">给 AI 的预设提示</h2>
          <textarea
            value={current.promptHint}
            onChange={(event) => updateProfile((item) => ({ ...item, promptHint: event.target.value }))}
            rows={6}
            className="extension-control extension-textarea"
          />
        </section>

        <div className="extension-button-row">
          <button onClick={handleAnalyze} disabled={isBusy} className="extension-page__wide-secondary extension-page__wide-secondary--blue">
            <Sparkles className="w-4 h-4" />
            {status === "analyzing" ? "分析中" : "重新分析"}
          </button>
          <button onClick={handleSave} disabled={isBusy} className="extension-page__wide-primary">
            <Save className="w-4 h-4" />
            {status === "saving" ? "保存中" : "保存预设"}
          </button>
        </div>
      </div>
    </div>
  );
}
