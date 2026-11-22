import { ChevronDown } from "lucide-react";

export const skipRecommendationHelp = "仅移除这条建议，保留书签位置和分类偏好";
export const protectBookmarkHelp = "ReMarks 会跳过此书签的整理、推荐和清理。可在书签管理的白名单中解除保护";

export function RecommendationActionHelp() {
  return (
    <details className="recommendation-action-details">
      <summary>
        <span>跳过、分类偏好和保护有什么区别？</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="recommendation-action-details__body">
        <p><strong>跳过建议</strong>：{skipRecommendationHelp}。</p>
        <p><strong>减少推荐到此目录</strong>：以后少把同一域名的书签推荐到该目录。</p>
        <p><strong>减少建议创建此目录</strong>：以后少建议新建该目录，适用于所有书签。</p>
        <p><strong>保护此书签</strong>：{protectBookmarkHelp}。</p>
      </div>
    </details>
  );
}
