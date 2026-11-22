import { useEffect, useState } from "react";
import { getBookmarkCheckIgnores, STORAGE_KEYS, type BookmarkCheckIgnoreKey } from "../services/storage";
import type { BookmarkUrlIdentity } from "../types";

function useBookmarkCheckIgnores(kind: BookmarkCheckIgnoreKey, enabled: boolean) {
  const [state, setState] = useState<{ entries: BookmarkUrlIdentity[] | null; error: string }>({
    entries: null,
    error: "",
  });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const entries = await getBookmarkCheckIgnores(kind);
        if (active && revision === request) setState({ entries, error: "" });
      } catch (error) {
        if (active && revision === request) {
          setState({ entries: null, error: error instanceof Error ? error.message : "读取检测忽略记录失败" });
        }
      }
    };
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[STORAGE_KEYS[kind]]) void refresh();
    };
    const events = typeof chrome === "undefined" ? undefined : chrome.storage?.onChanged;
    events?.addListener(onChanged);
    void refresh();
    return () => {
      active = false;
      events?.removeListener(onChanged);
    };
  }, [enabled, kind]);

  return state;
}

export function useDuplicateBookmarkIgnores(enabled = true) {
  return useBookmarkCheckIgnores("duplicateBookmarkIgnores", enabled);
}

export function useLinkHealthBookmarkIgnores(enabled = true) {
  return useBookmarkCheckIgnores("linkHealthBookmarkIgnores", enabled);
}
