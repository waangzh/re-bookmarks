import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Edit2, MoreVertical, RefreshCw, Shield, ShieldCheck, Trash2 } from "lucide-react";

export type BookmarkRowActionMenuProps = {
  bookmarkTitle: string;
  isProtected?: boolean;
  hasDirectWhitelistEntry?: boolean;
  protectionReason?: string;
  busy: boolean;
  onToggleProtection?: () => void;
  onRecheck?: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export function BookmarkRowActionMenu({
  bookmarkTitle,
  isProtected = false,
  hasDirectWhitelistEntry = false,
  protectionReason,
  busy,
  onToggleProtection,
  onRecheck,
  onEdit,
  onDelete,
}: BookmarkRowActionMenuProps) {
  const protectionLabel = hasDirectWhitelistEntry
    ? "解除白名单保护"
    : isProtected
      ? "由文件夹白名单保护"
      : "保护此书签";
  const protectionDisabled = busy || (isProtected && !hasDirectWhitelistEntry);
  const editDeleteTitle = isProtected ? "请先解除白名单保护" : undefined;

  return (
    <div className="extension-row-actions">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={`extension-icon-action bookmark-row-menu__trigger${isProtected ? " is-protected" : ""}`}
            aria-label={`更多操作：${bookmarkTitle || "未命名书签"}`}
            title="更多操作"
            disabled={busy}
          >
            <MoreVertical className="w-4 h-4" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="bookmark-row-menu"
            side="bottom"
            align="end"
            sideOffset={4}
            collisionPadding={8}
          >
            {onToggleProtection && (
              <DropdownMenu.Item
                className="bookmark-row-menu__item bookmark-row-menu__item--protect"
                disabled={protectionDisabled}
                title={protectionReason ?? protectionLabel}
                onSelect={onToggleProtection}
              >
                {isProtected ? <ShieldCheck aria-hidden="true" /> : <Shield aria-hidden="true" />}
                <span>{protectionLabel}</span>
              </DropdownMenu.Item>
            )}

            <DropdownMenu.Item
              className="bookmark-row-menu__item"
              disabled={busy || isProtected}
              title={editDeleteTitle ?? "编辑"}
              onSelect={onEdit}
            >
              <Edit2 aria-hidden="true" />
              <span>编辑</span>
            </DropdownMenu.Item>

            {onRecheck && (
              <DropdownMenu.Item className="bookmark-row-menu__item" disabled={busy} onSelect={onRecheck}>
                <RefreshCw aria-hidden="true" />
                <span>复测</span>
              </DropdownMenu.Item>
            )}

            <DropdownMenu.Separator className="bookmark-row-menu__separator" />

            <DropdownMenu.Item
              className="bookmark-row-menu__item bookmark-row-menu__item--danger"
              disabled={busy || isProtected}
              title={editDeleteTitle ?? "删除"}
              onSelect={onDelete}
            >
              <Trash2 aria-hidden="true" />
              <span>删除</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
