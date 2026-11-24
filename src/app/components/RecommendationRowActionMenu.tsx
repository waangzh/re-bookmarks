import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Edit2, ShieldCheck, ThumbsDown, X } from "lucide-react";
import { BookmarkRowMenu } from "./BookmarkRowActionMenu";
import { protectBookmarkHelp, skipRecommendationHelp } from "./RecommendationActionHelp";

export function RecommendationRowActionMenu({
  bookmarkTitle, busy, editLabel, rejectLabel, onEdit, onProtect, onSkip, onReject,
}: {
  bookmarkTitle: string;
  busy: boolean;
  editLabel: string;
  rejectLabel: string;
  onEdit: () => void;
  onProtect: () => void;
  onSkip: () => void;
  onReject?: () => void;
}) {
  return (
    <BookmarkRowMenu bookmarkTitle={bookmarkTitle} busy={busy}>
      <DropdownMenu.Item className="bookmark-row-menu__item" onSelect={onEdit}>
        <Edit2 aria-hidden="true" /><span>{editLabel}</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item className="bookmark-row-menu__item" title={protectBookmarkHelp} onSelect={onProtect}>
        <ShieldCheck aria-hidden="true" /><span>保护此书签</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item className="bookmark-row-menu__item" title={skipRecommendationHelp} onSelect={onSkip}>
        <X aria-hidden="true" /><span>跳过建议</span>
      </DropdownMenu.Item>
      {onReject && (
        <DropdownMenu.Item className="bookmark-row-menu__item" onSelect={onReject}>
          <ThumbsDown aria-hidden="true" /><span>{rejectLabel}</span>
        </DropdownMenu.Item>
      )}
    </BookmarkRowMenu>
  );
}
