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

let latestFullLoad = 0;
let latestRecommendationLoad = 0;

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  bookmarks: [],
  pendingRecommendations: [],
  reportHistory: [],
  lastReport: null,
  loading: false,
  error: null,
  async loadAll() {
    const fullLoad = ++latestFullLoad;
    const recommendationLoad = ++latestRecommendationLoad;
    set({ loading: true, error: null });
    try {
      const [settings, bookmarks, pendingRecommendations, reportHistory] = await Promise.all([
        getSettings(),
        getAllBookmarks(),
        getActivePendingRecommendations(),
        getReportHistory(),
      ]);
      if (fullLoad !== latestFullLoad) return;
      set({
        settings,
        bookmarks,
        ...(recommendationLoad === latestRecommendationLoad ? { pendingRecommendations } : {}),
        reportHistory,
        lastReport: reportHistory[0] ?? null,
        loading: false,
      });
    } catch (error) {
      if (fullLoad === latestFullLoad) set({ error: error instanceof Error ? error.message : "加载失败", loading: false });
    }
  },
  async loadBookmarks() {
    const bookmarks = await getAllBookmarks();
    set({ bookmarks });
  },
  async loadRecommendations() {
    const recommendationLoad = ++latestRecommendationLoad;
    const pendingRecommendations = await getActivePendingRecommendations();
    if (recommendationLoad === latestRecommendationLoad) set({ pendingRecommendations });
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
