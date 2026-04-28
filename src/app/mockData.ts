import { BookmarkNode, MovePlan, PendingRecommendation } from "./types";

export const mockBookmarks: BookmarkNode[] = [
  { id: "1", title: "React 官方文档", url: "https://react.dev", type: "url", path: ["书签栏"] },
  { id: "2", title: "TypeScript Handbook", url: "https://www.typescriptlang.org/docs/", type: "url", path: ["书签栏"] },
  { id: "3", title: "GitHub - anthropics/claude-code", url: "https://github.com/anthropics/claude-code", type: "url", path: ["书签栏"] },
  { id: "4", title: "淘宝网", url: "https://www.taobao.com", type: "url", path: ["书签栏"] },
  { id: "5", title: "京东商城", url: "https://www.jd.com", type: "url", path: ["书签栏"] },
  { id: "6", title: "Hacker News", url: "https://news.ycombinator.com", type: "url", path: ["书签栏"] },
  { id: "7", title: "Medium - Design", url: "https://medium.com/tag/design", type: "url", path: ["书签栏"] },
  { id: "8", title: "Netflix", url: "https://www.netflix.com", type: "url", path: ["书签栏"] },
  { id: "9", title: "YouTube", url: "https://www.youtube.com", type: "url", path: ["书签栏"] },
  { id: "10", title: "Stack Overflow", url: "https://stackoverflow.com", type: "url", path: ["书签栏"] },
];

export const mockMovePlans: MovePlan[] = [
  { bookmarkId: "1", bookmarkTitle: "React 官方文档", bookmarkUrl: "https://react.dev", fromParentId: "0", toFolderPath: ["开发", "前端框架"], confidence: 0.95, reason: "React 是前端开发框架，应归类到开发/前端框架" },
  { bookmarkId: "2", bookmarkTitle: "TypeScript Handbook", bookmarkUrl: "https://www.typescriptlang.org/docs/", fromParentId: "0", toFolderPath: ["开发", "编程语言"], confidence: 0.92, reason: "TypeScript 文档属于编程语言学习资料" },
  { bookmarkId: "3", bookmarkTitle: "GitHub - anthropics/claude-code", bookmarkUrl: "https://github.com/anthropics/claude-code", fromParentId: "0", toFolderPath: ["开发", "工具与资源"], confidence: 0.88, reason: "GitHub 仓库属于开发工具和资源" },
  { bookmarkId: "4", bookmarkTitle: "淘宝网", bookmarkUrl: "https://www.taobao.com", fromParentId: "0", toFolderPath: ["购物"], confidence: 0.98, reason: "电商购物网站" },
  { bookmarkId: "5", bookmarkTitle: "京东商城", bookmarkUrl: "https://www.jd.com", fromParentId: "0", toFolderPath: ["购物"], confidence: 0.98, reason: "电商购物网站" },
  { bookmarkId: "6", bookmarkTitle: "Hacker News", bookmarkUrl: "https://news.ycombinator.com", fromParentId: "0", toFolderPath: ["资讯", "科技"], confidence: 0.90, reason: "技术新闻和讨论社区" },
  { bookmarkId: "7", bookmarkTitle: "Medium - Design", bookmarkUrl: "https://medium.com/tag/design", fromParentId: "0", toFolderPath: ["设计", "文章与博客"], confidence: 0.85, reason: "设计相关的文章和博客内容" },
  { bookmarkId: "8", bookmarkTitle: "Netflix", bookmarkUrl: "https://www.netflix.com", fromParentId: "0", toFolderPath: ["娱乐", "影视"], confidence: 0.96, reason: "视频流媒体娱乐平台" },
  { bookmarkId: "9", bookmarkTitle: "YouTube", bookmarkUrl: "https://www.youtube.com", fromParentId: "0", toFolderPath: ["娱乐", "视频"], confidence: 0.94, reason: "视频分享和观看平台" },
  { bookmarkId: "10", bookmarkTitle: "Stack Overflow", bookmarkUrl: "https://stackoverflow.com", fromParentId: "0", toFolderPath: ["开发", "问答社区"], confidence: 0.93, reason: "编程问答社区" },
];

export const mockPendingRecommendations: PendingRecommendation[] = [
  { id: "rec-1", bookmarkId: "new-1", bookmarkTitle: "Tailwind CSS 文档", bookmarkUrl: "https://tailwindcss.com/docs", createdAt: Date.now() - 3600000, suggestedFolderPath: ["开发", "前端框架"], confidence: 0.91, reason: "CSS 框架文档，建议归类到前端开发" },
  { id: "rec-2", bookmarkId: "new-2", bookmarkTitle: "Figma - Design Tool", bookmarkUrl: "https://www.figma.com", createdAt: Date.now() - 7200000, suggestedFolderPath: ["设计", "工具"], confidence: 0.94, reason: "UI/UX 设计工具" },
];
