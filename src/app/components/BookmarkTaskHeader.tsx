import type { ReactNode } from "react";

export function BookmarkTaskHeader({ title, icon, summary, children }: {
  title: string;
  icon: ReactNode;
  summary: string;
  children?: ReactNode;
}) {
  return (
    <header className="bookmark-tree-panel__head bookmark-task-results__head">
      <div>
        <h3 className="bookmark-section-heading">{icon}{title}</h3>
        <p role="status">{summary}</p>
      </div>
      {children && <div className="bookmark-tree-panel__actions">{children}</div>}
    </header>
  );
}
