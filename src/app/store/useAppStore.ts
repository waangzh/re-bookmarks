import { create } from "zustand";
import type { BookmarkNode, OrganizeReport, PendingRecommendation, Settings } from "../types";
import { getAllBookmarks } from "../services/bookmarks";
import {
  DEFAULT_SETTINGS,
  getLastReport,
  getPendingRecommendations,
  getSettings,
  saveSettings,
} from "../services/storage";

type AppState = {
  settings: Settings;
  bookmarks: BookmarkNode[];
  pendingRecommendations: PendingRecommendation[];
  lastReport: OrganizeReport | null;
  loading: boolean;
  error: string | null;
  loadAll: () => Promise<void>;
  loadBookmarks: () => Promise<void>;
  loadRecommendations: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadReport: () => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
};

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  bookmarks: [],
  pendingRecommendations: [],
  lastReport: null,
  loading: false,
  error: null,
  async loadAll() {
    set({ loading: true, error: null });
    try {
      const [settings, bookmarks, pendingRecommendations, lastReport] = await Promise.all([
        getSettings(),
        getAllBookmarks(),
        getPendingRecommendations(),
        getLastReport(),
      ]);
      set({ settings, bookmarks, pendingRecommendations, lastReport, loading: false });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "加载失败", loading: false });
    }
  },
  async loadBookmarks() {
    const bookmarks = await getAllBookmarks();
    set({ bookmarks });
  },
  async loadRecommendations() {
    const pendingRecommendations = await getPendingRecommendations();
    set({ pendingRecommendations });
  },
  async loadSettings() {
    const settings = await getSettings();
    set({ settings });
  },
  async loadReport() {
    const lastReport = await getLastReport();
    set({ lastReport });
  },
  async saveSettings(settings) {
    await saveSettings(settings);
    set({ settings });
    await get().loadAll();
  },
}));
