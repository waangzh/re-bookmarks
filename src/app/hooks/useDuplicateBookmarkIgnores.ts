import { useEffect, useState } from "react";
import { getDuplicateBookmarkIgnores, STORAGE_KEYS } from "../services/storage";
import type { DuplicateBookmarkIgnore } from "../types";

export function useDuplicateBookmarkIgnores(enabled = true) {
  const [state, setState] = useState<{ entries: DuplicateBookmarkIgnore[] | null; error: string }>({
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
        const entries = await getDuplicateBookmarkIgnores();
        if (active && revision === request) setState({ entries, error: "" });
      } catch (error) {
        if (active && revision === request) {
          setState({ entries: null, error: error instanceof Error ? error.message : "读取重复检测忽略记录失败" });
        }
      }
    };
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[STORAGE_KEYS.duplicateBookmarkIgnores]) void refresh();
    };
    const events = typeof chrome === "undefined" ? undefined : chrome.storage?.onChanged;
    events?.addListener(onChanged);
    void refresh();
    return () => {
      active = false;
      events?.removeListener(onChanged);
    };
  }, [enabled]);

  return state;
}
