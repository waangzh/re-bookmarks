import { useLayoutEffect, useRef, type HTMLAttributes } from "react";

type ScrollEdgesProps = HTMLAttributes<HTMLDivElement> & {
  resetKey?: string;
  viewportBottomGap?: number;
};

export function ScrollEdges({ className = "", resetKey, viewportBottomGap, children, ...props }: ScrollEdgesProps) {
  const frameRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = frameRef.current?.firstElementChild;
    if (resetKey !== undefined && viewport) viewport.scrollTop = 0;
  }, [resetKey]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const viewport = frame?.firstElementChild;
    if (!frame || !(viewport instanceof HTMLElement)) return;

    const updateEdges = () => {
      const remaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      frame.toggleAttribute("data-scroll-start", viewport.scrollTop > 1);
      frame.toggleAttribute("data-scroll-end", remaining > 1);
    };
    const measure = () => {
      if (viewportBottomGap !== undefined) {
        const pageTop = frame.getBoundingClientRect().top + window.scrollY;
        frame.style.setProperty("--scroll-edges-available-height", `${window.innerHeight - pageTop - viewportBottomGap}px`);
      }
      updateEdges();
    };

    measure();
    viewport.addEventListener("scroll", updateEdges, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    if (viewportBottomGap !== undefined) {
      resize.observe(frame.closest("main") ?? document.body);
      window.addEventListener("resize", measure);
    }
    const content = new MutationObserver(updateEdges);
    content.observe(viewport, { childList: true, characterData: true, subtree: true });

    return () => {
      viewport.removeEventListener("scroll", updateEdges);
      window.removeEventListener("resize", measure);
      resize.disconnect();
      content.disconnect();
    };
  }, [viewportBottomGap]);

  return <div {...props} className={`scroll-edges ${className}`.trim()} ref={frameRef}>{children}</div>;
}
