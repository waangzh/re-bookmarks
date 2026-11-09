import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode, type RefObject } from "react";
import { ArrowRight, PencilLine, Plus, Search, X } from "lucide-react";
import type { BookmarkImpressionMeta } from "../types";
import { getTopImpressionKeywords } from "../services/semanticIndex";
import { getStorageValue, setStorageValue, STORAGE_KEYS } from "../services/storage";

type SearchInputProps = InputHTMLAttributes<HTMLInputElement> & { ref: RefObject<HTMLInputElement> };

type SearchKeywordDropdownProps = {
  query: string;
  onQueryChange: (query: string) => void;
  semanticIndex: Record<string, BookmarkImpressionMeta>;
  inputRef?: RefObject<HTMLInputElement>;
  className?: string;
  children: (inputProps: SearchInputProps) => ReactNode;
};

export function SearchKeywordDropdown({ query, onQueryChange, semanticIndex, inputRef, className = "", children }: SearchKeywordDropdownProps) {
  const localInputRef = useRef<HTMLInputElement>(null);
  const searchRef = inputRef ?? localInputRef;
  const shellRef = useRef<HTMLDivElement>(null);
  const dropdownId = useId();
  const [focused, setFocused] = useState(false);
  const [savedKeywords, setSavedKeywords] = useState<string[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [maxHeight, setMaxHeight] = useState(360);
  const open = focused && !query.trim();
  const automaticKeywords = useMemo(() => getTopImpressionKeywords(semanticIndex, 6), [semanticIndex]);
  const keywords = savedKeywords ?? automaticKeywords;

  useEffect(() => {
    let alive = true;
    const load = () => void getStorageValue<unknown>(STORAGE_KEYS.homeSearchKeywords, null).then((value) => {
      if (alive) setSavedKeywords(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null);
    });
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[STORAGE_KEYS.homeSearchKeywords]) load();
    };
    load();
    chrome.storage?.onChanged?.addListener(changed);
    return () => { alive = false; chrome.storage?.onChanged?.removeListener(changed); };
  }, []);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        setFocused(true);
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [searchRef]);

  useEffect(() => {
    if (!focused) return;
    const close = (event: PointerEvent) => {
      if (!shellRef.current?.contains(event.target as Node)) setFocused(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [focused]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setMaxHeight(Math.min(360, Math.max(120, window.innerHeight - (shellRef.current?.getBoundingClientRect().bottom ?? 0) - 12)));
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const saveKeywords = async () => {
    const next = [...draft, newKeyword].map((keyword) => keyword.trim()).filter(Boolean);
    if (new Set(next.map((keyword) => keyword.toLocaleLowerCase())).size !== next.length) {
      setError("标签不能重复");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await setStorageValue(STORAGE_KEYS.homeSearchKeywords, next);
      setSavedKeywords(next);
      if (shellRef.current?.contains(document.activeElement)) searchRef.current?.focus();
      setEditing(false);
    } catch {
      setError("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const addKeyword = () => {
    if (!newKeyword.trim()) return;
    setDraft((current) => [...current, newKeyword.trim()]);
    setNewKeyword("");
  };

  return <div ref={shellRef} className={`home-search-shell${open ? " home-search-shell--open" : ""} ${className}`}
    onFocus={() => setFocused(true)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onQueryChange("");
        setEditing(false);
        searchRef.current?.focus();
        setFocused(false);
        return;
      }
      if (editing || query.trim() || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      if (!open) { setFocused(true); return; }
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".home-search-suggestion, .home-search-edit"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    {children({ ref: searchRef, onClick: () => setFocused(true), role: "combobox", "aria-expanded": open, "aria-controls": open ? dropdownId : undefined, "aria-haspopup": "dialog", "aria-autocomplete": "none", autoComplete: "off" })}
    {open && <div id={dropdownId} className="home-search-dropdown" role="dialog" aria-label="快捷搜索标签" style={{ maxHeight }}>
      {editing ? <div className="home-keyword-editor">
        {draft.map((keyword, index) => <div className="home-keyword-editor__row" key={index}>
          <input aria-label={`编辑标签 ${index + 1}`} value={keyword} maxLength={40} onChange={(event) => setDraft((current) => current.map((item, i) => i === index ? event.target.value : item))} />
          <button type="button" aria-label={`删除标签 ${keyword || index + 1}`} onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}><X aria-hidden="true" /></button>
        </div>)}
        <div className="home-keyword-editor__row">
          <input aria-label="新标签" placeholder="输入新标签" maxLength={40} value={newKeyword} onChange={(event) => setNewKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addKeyword(); } }} />
          <button type="button" onClick={addKeyword}><Plus aria-hidden="true" />添加</button>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="home-keyword-editor__actions">
          <button type="button" disabled={saving} onClick={() => { searchRef.current?.focus(); setEditing(false); setError(""); }}>取消</button>
          <button type="button" disabled={saving} onClick={() => void saveKeywords()}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </div> : <>
        {keywords.map((keyword) => <button className="home-search-suggestion" key={keyword} type="button" onClick={() => { onQueryChange(keyword); searchRef.current?.focus(); }}><Search aria-hidden="true" /><span>{keyword}</span><ArrowRight aria-hidden="true" /></button>)}
        <div className="home-search-dropdown__footer"><button className="home-search-edit" type="button" onClick={() => { setDraft([...keywords]); setNewKeyword(""); setError(""); setEditing(true); }}><PencilLine aria-hidden="true" /><span>编辑标签</span></button></div>
      </>}
    </div>}
  </div>;
}
