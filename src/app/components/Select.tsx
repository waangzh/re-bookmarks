import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
};

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
};

/**
 * 与「模型选择框」视觉一致的下拉框。
 * 用 button + listbox 替代原生 select，使展开面板也能自定义样式。
 */
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  id,
  className = "",
  placeholder = "请选择",
  "aria-label": ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const [menuMaxHeight, setMenuMaxHeight] = useState(260);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;

  // 在可用空间内展开：优先向下，空间不足且上方更宽裕时向上，并限制菜单高度
  const MENU_MAX_HEIGHT = 260;
  const MENU_GAP = 6;
  const MENU_PADDING = 10;
  const EDGE_MARGIN = 8;
  const updatePlacement = useCallback(() => {
    const trigger = rootRef.current?.querySelector(".ui-select__trigger");
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const desired = Math.min(MENU_MAX_HEIGHT, options.length * 38 + MENU_PADDING);
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - EDGE_MARGIN;
    const spaceAbove = rect.top - MENU_GAP - EDGE_MARGIN;

    if (spaceBelow >= desired || spaceBelow >= spaceAbove) {
      setPlacement("below");
      setMenuMaxHeight(Math.max(spaceBelow, 96));
    } else {
      setPlacement("above");
      setMenuMaxHeight(Math.max(spaceAbove, 96));
    }
  }, [options.length]);

  // 菜单渲染后按真实位置再校正一次，避免滚动/布局变化导致溢出视口
  useLayoutEffect(() => {
    if (!open) return;
    updatePlacement();
  }, [open, updatePlacement]);

  useEffect(() => {
    if (!open) return;
    setHighlighted(selectedIndex >= 0 ? selectedIndex : 0);
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleReposition = () => updatePlacement();
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [open, selectedIndex, updatePlacement]);

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.children[highlighted] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % Math.max(options.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => (current - 1 + options.length) % Math.max(options.length, 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlighted(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlighted(Math.max(options.length - 1, 0));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (options[highlighted]) choose(options[highlighted].value);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={`ui-select ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        id={id}
        className={`ui-select__trigger${open ? " is-open" : ""}`}
        onClick={() => !disabled && setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
      >
        <span className={`ui-select__value${selectedOption ? "" : " is-placeholder"}`}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown className="ui-select__chevron" aria-hidden="true" />
      </button>

      {open && (
        <ul
          id={listId}
          className={`ui-select__menu${placement === "above" ? " is-above" : ""}`}
          role="listbox"
          ref={listRef}
          aria-label={ariaLabel}
          style={{ maxHeight: `${menuMaxHeight}px` }}
        >
          {options.length ? options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`ui-select__option${option.value === value ? " is-selected" : ""}${index === highlighted ? " is-highlighted" : ""}`}
              onMouseEnter={() => setHighlighted(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(option.value)}
            >
              <span>{option.label}</span>
              <Check aria-hidden="true" />
            </li>
          )) : <li className="ui-select__empty">暂无可选项</li>}
        </ul>
      )}
    </div>
  );
}
