import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

type CollapsibleSectionProps = {
  title: string;
  count?: number | string;
  hint?: string;
  defaultOpen?: boolean;
  onToggle?: (open: boolean, details: HTMLDetailsElement) => void;
  children: ReactNode;
  className?: string;
};

export function CollapsibleSection({
  title,
  count,
  hint,
  defaultOpen = false,
  onToggle,
  children,
  className = "",
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`extension-section extension-section--flush collapsible-section ${className}`.trim()}>
      <details
        open={open}
        onToggle={(event) => {
          const nextOpen = event.currentTarget.open;
          setOpen(nextOpen);
          onToggle?.(nextOpen, event.currentTarget);
        }}
        className="collapsible-section__details"
      >
        <summary className="collapsible-section__summary" aria-expanded={open}>
          <span className="collapsible-section__title-group">
            <span className="collapsible-section__title-line">
              {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              <span>{title}</span>
            </span>
            {hint && <span className="collapsible-section__hint">{hint}</span>}
          </span>
          {count !== undefined && <span className="extension-pill">{count}</span>}
        </summary>
        <div className="collapsible-section__body">{children}</div>
      </details>
    </section>
  );
}
