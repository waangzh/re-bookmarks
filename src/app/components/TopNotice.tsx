import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from "lucide-react";

export type NoticeTone = "info" | "success" | "warning" | "error";

type TopNoticeProps = {
  message: string;
  tone?: NoticeTone;
  action?: ReactNode;
  onDismiss?: () => void;
};

const noticeIcons = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: CircleAlert };

export function TopNotices({ children, inline = false }: { children: ReactNode; inline?: boolean }) {
  const viewport = <div className="top-notices">{children}</div>;
  return inline ? viewport : createPortal(viewport, document.body);
}

export function TopNotice(props: TopNoticeProps) {
  return props.message ? <NoticeCard key={props.message} {...props} /> : null;
}

function NoticeCard({ message, tone = "info", action, onDismiss }: TopNoticeProps) {
  const [dismissed, setDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (dismissed || hovered || focused || action || tone !== "success") return;
    const timeout = window.setTimeout(() => setDismissed(true), 5000);
    return () => window.clearTimeout(timeout);
  }, [action, dismissed, focused, hovered, tone]);

  if (dismissed) return null;
  const Icon = noticeIcons[tone];

  return (
    <div
      className={`top-notice top-notice--${tone}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Icon className="top-notice__icon" size={16} aria-hidden="true" />
      <div className="top-notice__content">
        <p role={tone === "error" ? "alert" : "status"}>{message}</p>
        {action}
      </div>
      <button className="top-notice__close" type="button" aria-label="关闭提示" onClick={() => {
        setDismissed(true);
        onDismiss?.();
      }}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
