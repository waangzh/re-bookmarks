import { Children, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ScrollEdges } from "./ScrollEdges";

type ModelOptionsListProps = {
  id: string;
  highlightedIndex: number;
  children: ReactNode;
};

export function ModelOptionsList({ id, highlightedIndex, children }: ModelOptionsListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [above, setAbove] = useState(false);
  const [maxHeight, setMaxHeight] = useState(208);
  const optionCount = Children.count(children);

  useLayoutEffect(() => {
    const anchor = listRef.current?.closest(".organize-model-picker__control");
    if (!anchor) return;
    const saveBar = anchor.closest(".extension-page--settings")?.querySelector(".settings-save-bar");
    const measure = () => {
      const bounds = anchor.getBoundingClientRect();
      const bottom = Math.min(window.innerHeight, saveBar?.getBoundingClientRect().top ?? window.innerHeight);
      const belowSpace = bottom - bounds.bottom - 14;
      const aboveSpace = bounds.top - 14;
      const desired = Math.min(208, optionCount * 38 + 10);
      const opensAbove = belowSpace < desired && aboveSpace > belowSpace;
      setAbove(opensAbove);
      setMaxHeight(Math.max(0, Math.min(208, opensAbove ? aboveSpace : belowSpace)));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [optionCount]);

  useLayoutEffect(() => {
    if (highlightedIndex < 0) return;
    listRef.current?.querySelectorAll('[role="option"]')[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, above, maxHeight]);

  return <ScrollEdges className={`organize-model-picker__menu${above ? " is-above" : ""}`} style={{ maxHeight }}>
    <ul className="scroll-edges__viewport" id={id} ref={listRef} role="listbox" aria-label="检测到的模型">
      {children}
    </ul>
  </ScrollEdges>;
}
