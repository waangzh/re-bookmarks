import { create } from "zustand";
import type { BookmarkNode, OrganizeReport, PendingRecommendation, Settings } from "../types";
import { getAllBookmarks } from "../services/bookmarks";
import {
  DEFAULT_SETTINGS,
  getReportHistory,
  getSettings,
  saveSettings,
} from "../services/storage";
import { getActivePendingRecommendations } from "../services/recommendations";

type AppState = {
  settings: Settings;
  bookmarks: BookmarkNode[];
  pendingRecommendations: PendingRecommendation[];
  reportHistory: OrganizeReport[];
  lastReport: OrganizeReport | null;
  loading: boolean;
  error: string | null;
  loadAll: () => Promise<void>;
  loadBookmarks: () => Promise<void>;
  loadRecommendations: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadReport: () => Promise<void>;
  loadReports: () => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
};

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  bookmarks: [],
  pendingRecommendations: [],
  reportHistory: [],
  lastReport: null,
  loading: false,
  error: null,
  async loadAll() {
    set({ loading: true, error: null });
    try {
      const [settings, bookmarks, pendingRecommendations, reportHistory] = await Promise.all([
        getSettings(),
        getAllBookmarks(),
        getActivePendingRecommendations(),
        getReportHistory(),
      ]);
      set({
        settings,
        bookmarks,
        pendingRecommendations,
        reportHistory,
        lastReport: reportHistory[0] ?? null,
        loading: false,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "加载失败", loading: false });
    }
  },
  async loadBookmarks() {
    const bookmarks = await getAllBookmarks();
    set({ bookmarks });
  },
  async loadRecommendations() {
    const pendingRecommendations = await getActivePendingRecommendations();
    set({ pendingRecommendations });
  },
  async loadSettings() {
    const settings = await getSettings();
    set({ settings });
  },
  async loadReport() {
    await get().loadReports();
  },
  async loadReports() {
    const reportHistory = await getReportHistory();
    set({ reportHistory, lastReport: reportHistory[0] ?? null });
  },
  async saveSettings(settings) {
    await saveSettings(settings);
    set({ settings });
    await get().loadAll();
  },
}));
