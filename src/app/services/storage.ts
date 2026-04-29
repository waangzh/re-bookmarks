import type {
  BookmarkBackup,
  FolderHabitProfile,
  OrganizeReport,
  PendingRecommendation,
  PreviewPlanCache,
  Settings,
} from "../types";

export const STORAGE_KEYS = {
  settings: "remarks.settings",
  pendingRecommendations: "remarks.pendingRecommendations",
  lastBackup: "remarks.lastBackup",
  lastReport: "remarks.lastReport",
  previewPlan: "remarks.previewPlan",
  folderHabitProfile: "remarks.folderHabitProfile",
} as const;

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
  return getStorageValue<OrganizeReport | null>(STORAGE_KEYS.lastReport, null);
}

export function saveLastReport(report: OrganizeReport): Promise<void> {
  return setStorageValue(STORAGE_KEYS.lastReport, report);
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
