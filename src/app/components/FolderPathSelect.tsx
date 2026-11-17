import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Folder, FolderPlus } from "lucide-react";
import type { BookmarkNode } from "../types";
import { parseFolderPath } from "../services/bookmarks";

type FolderPathSelectProps = {
  value: string;
  folders: BookmarkNode[];
  maxNestingLevel: number;
  onChange: (value: string) => void;
  disabled?: boolean;
};

/** 可输入新路径的目录选择器，候选列表在弹窗内展开，保留底部操作空间。 */
export function FolderPathSelect({ value, folders, maxNestingLevel, onChange, disabled = false }: FolderPathSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const path = parseFolderPath(value, maxNestingLevel);
  const pathKey = JSON.stringify(path);
  const pathLabel = path.join(" / ");
  const existing = folders.some((folder) => JSON.stringify(folder.path) === pathKey);
  const choices = useMemo(() => {
    const tokens = query.toLocaleLowerCase().split(/[\s/／>＞]+/).filter(Boolean);
    return folders.filter((folder) => {
      const label = folder.path.join(" / ").toLocaleLowerCase();
      return tokens.every((token) => label.includes(token));
    });
  }, [folders, query]);
  const canUseNewPath = path.length > 0 && !existing;
  const count = choices.length + (canUseNewPath ? 1 : 0);
  const expanded = open && !disabled;

  useEffect(() => {
    if (expanded && highlighted >= 0) {
      listRef.current?.children[highlighted]?.scrollIntoView({ block: "nearest" });
    }
  }, [expanded, highlighted]);

  const choose = (index: number) => {
    const next = choices[index]?.path.join(" / ") ?? (index === choices.length && canUseNewPath ? pathLabel : null);
    if (next === null) return;
    onChange(next);
    setOpen(false);
    setQuery("");
    setHighlighted(-1);
    inputRef.current?.focus();
  };

  return <div className={`ui-select ui-folder-select${expanded ? " is-open" : ""}`} ref={rootRef}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
    <label className="ui-folder-select__label" htmlFor={`${id}-input`}>目标目录</label>
    <div className={`ui-select__trigger ui-folder-select__control${expanded ? " is-open" : ""}`}>
      <input id={`${id}-input`} ref={inputRef} value={value} disabled={disabled}
        role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={`${id}-list`}
        aria-activedescendant={expanded && highlighted >= 0 && highlighted < count ? `${id}-option-${highlighted}` : undefined}
        aria-describedby={`${id}-note`} autoComplete="off" placeholder="搜索目录或输入新路径"
        onClick={() => { if (!expanded) { setQuery(""); setHighlighted(-1); setOpen(true); } }}
        onChange={(event) => { onChange(event.target.value); setQuery(event.target.value); setHighlighted(-1); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!expanded) { setQuery(""); setHighlighted(-1); setOpen(true); return; }
            if (count) setHighlighted((current) => current < 0
              ? event.key === "ArrowDown" ? 0 : count - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
          } else if (event.key === "Enter" && expanded && highlighted >= 0) {
            event.preventDefault();
            choose(highlighted);
          } else if (event.key === "Escape" && expanded) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "Tab") setOpen(false);
        }} />
      <button type="button" disabled={disabled} aria-label={expanded ? "收起目录列表" : "展开目录列表"}
        aria-expanded={expanded} aria-controls={`${id}-list`} aria-haspopup="listbox"
        onClick={() => { setQuery(""); setHighlighted(-1); setOpen(!expanded); inputRef.current?.focus(); }}>
        <ChevronDown className="ui-select__chevron" aria-hidden="true" />
      </button>
    </div>
    {expanded && <ul id={`${id}-list`} role="listbox" aria-label="目标目录候选" ref={listRef}
      className="ui-select__menu ui-folder-select__menu">
      {choices.map((folder, index) => {
        const selected = JSON.stringify(folder.path) === pathKey;
        const label = folder.path.join(" / ");
        return <li id={`${id}-option-${index}`} key={folder.id} role="option" aria-selected={selected}
          className={`ui-select__option ui-folder-select__option${highlighted === index ? " is-highlighted" : ""}${selected ? " is-selected" : ""}`}
          onPointerDown={(event) => event.preventDefault()} onClick={() => choose(index)} onMouseMove={() => setHighlighted(index)}>
          <Folder className="ui-folder-select__icon" aria-hidden="true" />
          <span title={label}>{label}</span><Check aria-hidden="true" />
        </li>;
      })}
      {canUseNewPath && <li id={`${id}-option-${choices.length}`} role="option" aria-selected={false}
        className={`ui-select__option ui-folder-select__option ui-folder-select__new${highlighted === choices.length ? " is-highlighted" : ""}`}
        onPointerDown={(event) => event.preventDefault()} onClick={() => choose(choices.length)} onMouseMove={() => setHighlighted(choices.length)}>
        <FolderPlus className="ui-folder-select__icon" aria-hidden="true" />
        <span>使用新路径：{pathLabel}</span>
      </li>}
      {!choices.length && !canUseNewPath && <li className="ui-select__empty" role="presentation">暂无可选目录，可输入新路径</li>}
    </ul>}
    <p id={`${id}-note`} className="preview-dialog__note">新路径会在最终执行整理时创建。</p>
  </div>;
}
