import { useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

export function PreviewDialog({ label, description, busy = false, onClose, children }: {
  label: string;
  description: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="preview-dialog-overlay" />
      <Dialog.Content className="extension-section execution-confirmation" aria-label={label}
        onOpenAutoFocus={(event) => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const content = event.currentTarget as HTMLElement;
          const target = content.querySelector<HTMLElement>("input, [data-dialog-return]");
          if (target) { event.preventDefault(); target.focus(); }
        }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => event.preventDefault()}>
        <Dialog.Title className="sr-only">{label}</Dialog.Title>
        <Dialog.Description className="sr-only">{description}</Dialog.Description>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
