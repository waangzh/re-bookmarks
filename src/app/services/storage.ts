import type {
  BookmarkBackup,
  FolderHabitProfile,
  OrganizeReport,
  PendingRecommendation,
  PreviewPlanCache,
  PreviewTaskCache,
  Settings,
} from "../types";

export const STORAGE_KEYS = {
  settings: "remarks.settings",
  pendingRecommendations: "remarks.pendingRecommendations",
  lastBackup: "remarks.lastBackup",
  lastReport: "remarks.lastReport",
  reportHistory: "remarks.reportHistory",
  previewPlan: "remarks.previewPlan",
  previewTask: "remarks.previewTask",
  folderHabitProfile: "remarks.folderHabitProfile",
} as const;

export const REPORT_HISTORY_LIMIT = 5;

export const DEFAULT_CLASSIFY_PROMPT = `你是浏览器书签分类助手。请根据书签标题和域名进行智能分类，输出合法的 JSON 格式。

分类要求：
1. 优先使用通用、简洁的文件夹名称
2. 避免为单个网站或小众主题创建独立文件夹
3. 无法确定分类时归入"待整理"
4. confidence 值范围 0-1，表示分类置信度

输出格式：
{"results":[{"id":"输入id","categoryPath":["一级分类","二级分类"],"confidence":0.8,"reason":"简短中文原因"}]}

每个输入 id 必须对应一项结果。`;

export const DEFAULT_SETTINGS: Settings = {
  provider: {
    type: "deepseek",
    apiKey: "",
    model: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com",
    enabled: false,
  },
  allowNestedFolders: true,
  maxNestingLevel: 2,
  maxTopLevelFolders: 8,
  maxSubfoldersPerFolder: 4,
  enableHistory: false,
  sendFullUrl: false,
  customPrompt: DEFAULT_CLASSIFY_PROMPT,
};

function hasChromeStorage() {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

function mergeSettings(settings?: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    provider: {
      ...DEFAULT_SETTINGS.provider,
      ...settings?.provider,
    },
  };
}

export async function getStorageValue<T>(key: string, fallback: T): Promise<T> {
  if (!hasChromeStorage()) return fallback;

  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        resolve(fallback);
        return;
      }
      resolve((result[key] as T | undefined) ?? fallback);
    });
  });
}

export async function setStorageValue<T>(key: string, value: T): Promise<void> {
  if (!hasChromeStorage()) return;

  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function getSettings(): Promise<Settings> {
  const settings = await getStorageValue<Partial<Settings>>(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  return mergeSettings(settings);
}

export function saveSettings(settings: Settings): Promise<void> {
  return setStorageValue(STORAGE_KEYS.settings, mergeSettings(settings));
}

export function getPendingRecommendations(): Promise<PendingRecommendation[]> {
  return getStorageValue<PendingRecommendation[]>(STORAGE_KEYS.pendingRecommendations, []);
}

export function savePendingRecommendations(recommendations: PendingRecommendation[]): Promise<void> {
  return setStorageValue(STORAGE_KEYS.pendingRecommendations, recommendations);
}

export function getLastBackup(): Promise<BookmarkBackup | null> {
  return getStorageValue<BookmarkBackup | null>(STORAGE_KEYS.lastBackup, null);
}

export function saveLastBackup(backup: BookmarkBackup): Promise<void> {
  return setStorageValue(STORAGE_KEYS.lastBackup, backup);
}

export function getLastReport(): Promise<OrganizeReport | null> {
  return getReportHistory().then((reports) => reports[0] ?? null);
}

export function saveLastReport(report: OrganizeReport): Promise<void> {
  return saveReportToHistory(report);
}

function normalizeReport(report: OrganizeReport): OrganizeReport {
  return {
    ...report,
    kind: report.kind ?? (report.undone ? "undo" : "organize"),
  };
}

async function getLegacyLastReport(): Promise<OrganizeReport | null> {
  return getStorageValue<OrganizeReport | null>(STORAGE_KEYS.lastReport, null);
}

export async function getReportHistory(): Promise<OrganizeReport[]> {
  const reports = await getStorageValue<OrganizeReport[]>(STORAGE_KEYS.reportHistory, []);
  if (reports.length > 0) {
    return reports.map(normalizeReport).slice(0, REPORT_HISTORY_LIMIT);
  }

  const legacyReport = await getLegacyLastReport();
  if (!legacyReport) return [];

  const migratedReports = [normalizeReport(legacyReport)];
  await setStorageValue(STORAGE_KEYS.reportHistory, migratedReports);
  await setStorageValue(STORAGE_KEYS.lastReport, migratedReports[0]);
  return migratedReports;
}

export async function saveReportToHistory(report: OrganizeReport): Promise<void> {
  const normalizedReport = normalizeReport(report);
  const reports = await getReportHistory();
  const nextReports = [
    normalizedReport,
    ...reports.filter((item) => item.id !== normalizedReport.id),
  ].slice(0, REPORT_HISTORY_LIMIT);

  await Promise.all([
    setStorageValue(STORAGE_KEYS.reportHistory, nextReports),
    setStorageValue(STORAGE_KEYS.lastReport, normalizedReport),
  ]);
}

export function getPreviewPlan(): Promise<PreviewPlanCache | null> {
  return getStorageValue<PreviewPlanCache | null>(STORAGE_KEYS.previewPlan, null);
}

export function savePreviewPlan(previewPlan: PreviewPlanCache): Promise<void> {
  return setStorageValue(STORAGE_KEYS.previewPlan, previewPlan);
}

export async function clearPreviewPlan(): Promise<void> {
  if (!hasChromeStorage()) return;

  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(STORAGE_KEYS.previewPlan, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export function getPreviewTask(): Promise<PreviewTaskCache | null> {
  return getStorageValue<PreviewTaskCache | null>(STORAGE_KEYS.previewTask, null);
}

export function savePreviewTask(previewTask: PreviewTaskCache): Promise<void> {
  return setStorageValue(STORAGE_KEYS.previewTask, previewTask);
}

export async function clearPreviewTask(): Promise<void> {
  if (!hasChromeStorage()) return;

  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(STORAGE_KEYS.previewTask, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export function getFolderHabitProfile(): Promise<FolderHabitProfile | null> {
  return getStorageValue<FolderHabitProfile | null>(STORAGE_KEYS.folderHabitProfile, null);
}

export function saveFolderHabitProfile(profile: FolderHabitProfile): Promise<void> {
  return setStorageValue(STORAGE_KEYS.folderHabitProfile, profile);
}

export async function clearFolderHabitProfile(): Promise<void> {
  if (!hasChromeStorage()) return;

  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(STORAGE_KEYS.folderHabitProfile, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}
