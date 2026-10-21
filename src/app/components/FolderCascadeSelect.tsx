import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { BookmarkNode } from "../types";

type FolderCascadeSelectProps = {
  /** 当前选中的目录路径，例如 ["开发工具与平台", "AI 开发平台"] */
  value: string[];
  /** 可选的已有目录，path 为从一级目录开始的完整路径 */
  folders: BookmarkNode[];
  onChange: (path: string[]) => void;
  disabled?: boolean;
  "aria-label"?: string;
};

type CascadeGroup = {
  name: string;
  path: string[];
  children: BookmarkNode[];
};

type MenuGeometry = {
  placement: "below" | "above";
  maxHeight: number;
  width: number;
  left: number;
};

const MENU_MAX_HEIGHT = 300;
const MENU_MIN_HEIGHT = 140;
const MENU_MIN_WIDTH = 260;
const MENU_MAX_WIDTH = 340;
const MENU_GAP = 6;
const EDGE_MARGIN = 8;

function pathLabel(path: string[]) {
  return path.join(" / ");
}

/**
 * 两级目录下拉：左栏常驻一级目录，悬停或键盘进入后右栏显示对应的下级目录。
 * 视觉沿用 Select 的 ui-select 样式，避免与模型选择框不一致。
 */
export function FolderCascadeSelect({
  value,
  folders,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
}: FolderCascadeSelectProps) {
  const [open, setOpen] = useState(false);
  const [geometry, setGeometry] = useState<MenuGeometry>({
    placement: "below",
    maxHeight: MENU_MAX_HEIGHT,
    width: MENU_MIN_WIDTH,
    left: 0,
  });
  const [activeTop, setActiveTop] = useState("");
  const [column, setColumn] = useState<"primary" | "secondary">("primary");
  const [highlightPrimary, setHighlightPrimary] = useState(0);
  const [highlightSecondary, setHighlightSecondary] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLUListElement>(null);
  const secondaryRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const groups = useMemo(() => {
    const map = new Map<string, CascadeGroup>();
    folders.forEach((folder) => {
      if (folder.type !== "folder" || folder.path.length === 0) return;
      const top = folder.path[0];
      let group = map.get(top);
      if (!group) {
        group = { name: top, path: [top], children: [] };
        map.set(top, group);
      }
      // 二级及更深目录都归到对应一级目录下，用相对路径展示
      if (folder.path.length > 1) group.children.push(folder);
    });
    return [...map.values()];
  }, [folders]);

  const activeGroup = groups.find((group) => group.name === activeTop) ?? groups[0] ?? null;
  const selectedKey = pathLabel(value);
  const triggerLabel = value.length ? selectedKey : "选择目标目录";

  const focusGroup = useCallback((index: number) => {
    const group = groups[index];
    if (!group) return;
    setHighlightPrimary(index);
    setActiveTop(group.name);
    setHighlightSecondary(0);
  }, [groups]);

  const openMenu = useCallback(() => {
    if (!groups.length) return;
    const currentTop = value[0] && groups.some((group) => group.name === value[0])
      ? value[0]
      : groups[0].name;
    const primaryIndex = Math.max(groups.findIndex((group) => group.name === currentTop), 0);
    const group = groups[primaryIndex];
    const childIndex = group?.children.findIndex((folder) => pathLabel(folder.path) === selectedKey) ?? -1;
    setActiveTop(currentTop);
    setColumn("primary");
    setHighlightPrimary(primaryIndex);
    setHighlightSecondary(Math.max(childIndex, 0));
    setOpen(true);
  }, [groups, selectedKey, value]);

  const updateGeometry = useCallback(() => {
    const trigger = rootRef.current?.querySelector(".ui-select__trigger");
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const width = Math.min(MENU_MAX_WIDTH, Math.max(MENU_MIN_WIDTH, viewportWidth - EDGE_MARGIN * 2));
    // 菜单比触发框宽时向左偏移，保证两侧都落在视口内
    const maxLeft = viewportWidth - EDGE_MARGIN - width;
    const left = Math.min(Math.max(rect.left, EDGE_MARGIN), Math.max(maxLeft, EDGE_MARGIN)) - rect.left;
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - EDGE_MARGIN;
    const spaceAbove = rect.top - MENU_GAP - EDGE_MARGIN;
    const placement = spaceBelow >= MENU_MAX_HEIGHT || spaceBelow >= spaceAbove ? "below" : "above";
    setGeometry({
      placement,
      maxHeight: Math.max(placement === "below" ? spaceBelow : spaceAbove, MENU_MIN_HEIGHT),
      width,
      left,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) updateGeometry();
  }, [open, updateGeometry]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleReposition = () => updateGeometry();
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [open, updateGeometry]);

  useEffect(() => {
    if (!open) return;
    const list = column === "primary" ? primaryRef.current : secondaryRef.current;
    const item = list?.children[column === "primary" ? highlightPrimary : highlightSecondary] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [open, column, highlightPrimary, highlightSecondary, activeTop]);

  const choose = (path: string[]) => {
    onChange(path);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    const secondaryLength = activeGroup?.children.length ?? 0;
    if (event.key === "Escape" || event.key === "Tab") {
      setOpen(false);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setColumn("primary");
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (secondaryLength > 0) {
        setColumn("secondary");
        setHighlightSecondary(0);
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      if (column === "primary") {
        focusGroup((highlightPrimary + delta + groups.length) % Math.max(groups.length, 1));
      } else {
        setHighlightSecondary((current) => (current + delta + secondaryLength) % Math.max(secondaryLength, 1));
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (column === "primary") {
        const group = groups[highlightPrimary];
        if (group) choose(group.path);
      } else {
        const folder = activeGroup?.children[highlightSecondary];
        if (folder) choose(folder.path);
      }
    }
  };

  return (
    <div className={`ui-select ui-cascade${open ? " is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={`ui-select__trigger${open ? " is-open" : ""}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${listId}-primary`}
        aria-label={ariaLabel}
      >
        <span className={`ui-select__value${value.length ? "" : " is-placeholder"}`}>{triggerLabel}</span>
        <ChevronDown className="ui-select__chevron" aria-hidden="true" />
      </button>

      {open && (
        <div
          className={`ui-cascade__menu${geometry.placement === "above" ? " is-above" : ""}`}
          style={{ maxHeight: `${geometry.maxHeight}px`, width: `${geometry.width}px`, left: `${geometry.left}px` }}
        >
          <ul
            id={`${listId}-primary`}
            className="ui-cascade__column ui-cascade__column--primary"
            role="listbox"
            aria-label="一级目录"
            ref={primaryRef}
          >
            {groups.map((group, index) => (
              <li
                key={group.name}
                role="option"
                aria-selected={value[0] === group.name}
                tabIndex={-1}
                className={`ui-cascade__item${index === highlightPrimary ? " is-active" : ""}${value[0] === group.name ? " is-current" : ""}`}
                onMouseEnter={() => focusGroup(index)}
                onClick={() => choose(group.path)}
              >
                <span>{group.name}</span>
                {group.children.length > 0 && <ChevronRight aria-hidden="true" />}
              </li>
            ))}
          </ul>
          <ul
            id={`${listId}-secondary`}
            className="ui-cascade__column ui-cascade__column--secondary"
            role="listbox"
            aria-label="二级目录"
            ref={secondaryRef}
          >
            {activeGroup && activeGroup.children.length > 0 ? (
              activeGroup.children.map((folder, index) => {
                const key = pathLabel(folder.path);
                return (
                  <li
                    key={folder.id}
                    role="option"
                    aria-selected={key === selectedKey}
                    tabIndex={-1}
                    className={`ui-cascade__item${column === "secondary" && index === highlightSecondary ? " is-active" : ""}${key === selectedKey ? " is-current" : ""}`}
                    onMouseEnter={() => {
                      setColumn("secondary");
                      setHighlightSecondary(index);
                    }}
                    onClick={() => choose(folder.path)}
                  >
                    <span>{folder.path.slice(1).join(" / ")}</span>
                    {key === selectedKey && <Check aria-hidden="true" />}
                  </li>
                );
              })
            ) : (
              <li className="ui-cascade__empty">{activeGroup ? "该目录下没有子目录" : "暂无可用目录"}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
