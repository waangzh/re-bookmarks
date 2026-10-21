import { useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

type PreviewDialogProps = {
  /** 无障碍名称；标题未单独提供时也作为可见标题 */
  label: string;
  title?: string;
  description?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
};

export function PreviewDialog({
  label,
  title,
  description,
  busy = false,
  onClose,
  children,
  actions,
}: PreviewDialogProps) {
  const opener = useRef<HTMLElement | null>(null);
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="preview-dialog-overlay" />
      <Dialog.Content className="preview-dialog" aria-label={label}
        onOpenAutoFocus={(event) => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const content = event.currentTarget as HTMLElement;
          const target = content.querySelector<HTMLElement>("input, [data-dialog-return]");
          if (target) { event.preventDefault(); target.focus(); }
        }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => event.preventDefault()}>
        <div className="preview-dialog__header">
          <Dialog.Title className="preview-dialog__title">{title ?? label}</Dialog.Title>
          {description && <Dialog.Description className="preview-dialog__description">{description}</Dialog.Description>}
        </div>
        <div className="preview-dialog__body">{children}</div>
        {actions && <div className="preview-dialog__actions">{actions}</div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
