export type BookmarkNode = {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  index?: number;
  children?: BookmarkNode[];
  path: string[];
  type: "folder" | "url";
};

export type BookmarkForAI = {
  id: string;
  title: string;
  domain: string;
  path: string;
  sanitizedUrl: string;
};

export type FolderHabitSample = {
  folderPath: string[];
  bookmarkCount: number;
  examples: Array<{
    title: string;
    domain: string;
  }>;
};

export type ClassificationResult = {
  id: string;
  category: string;
  categoryPath?: string[];
  confidence: number;
  reason?: string;
  source: "rule" | "ai" | "manual";
};

export type MovePlan = {
  bookmarkId: string;
  bookmarkTitle: string;
  bookmarkUrl?: string;
  fromParentId: string;
  fromIndex?: number;
  toFolderPath: string[];
  confidence: number;
  reason?: string;
  source?: ClassificationResult["source"];
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type BookmarkBackup = {
  id: string;
  createdAt: number;
  tree: chrome.bookmarks.BookmarkTreeNode[];
  movePlan: MovePlan[];
  createdTargetFolders?: Array<{
    id: string;
    path: string[];
  }>;
};

export type PendingRecommendation = {
  id: string;
  bookmarkId: string;
  bookmarkTitle: string;
  bookmarkUrl?: string;
  createdAt: number;
  suggestedFolderPath: string[];
  confidence: number;
  reason?: string;
};

export type AIProviderType = "openai" | "deepseek" | "zhipu" | "kimi" | "gemini" | "minimax" | "qwen" | "doubao" | "custom";

export type AIProviderConfig = {
  type: AIProviderType;
  apiKey: string;
  model: string;
  endpoint?: string;
  enabled?: boolean;
  testedAt?: number;
};

export type Settings = {
  provider: AIProviderConfig;
  allowNestedFolders: boolean;
  maxNestingLevel: number;
  maxTopLevelFolders: number;
  maxSubfoldersPerFolder: number;
  enableHistory: boolean;
  sendFullUrl: boolean;
  customPrompt?: string;
};

export type FailedMove = {
  bookmarkId: string;
  bookmarkTitle: string;
  reason: string;
};

export type OrganizeReport = {
  id: string;
  createdAt: number;
  movedCount: number;
  folderCount: number;
  removedFolders?: number;
  failedItems: FailedMove[];
  movePlan: MovePlan[];
  privacySummary: string[];
  tokenUsage?: TokenUsage;
  undone?: boolean;
  skippedFolderCleanup?: FailedMove[];
};

export type PreviewPlanCache = {
  id: string;
  createdAt: number;
  bookmarkCount: number;
  movePlan: MovePlan[];
  tokenUsage?: TokenUsage;
};

export type FolderHabitProfile = {
  id: string;
  createdAt: number;
  folderCount: number;
  bookmarkCount: number;
  summary: string;
  preferredTopLevelFolders: string[];
  folderRules: Array<{
    folderPath: string[];
    pattern: string;
  }>;
  avoidRules: string[];
  promptHint: string;
};

export type FrequentBookmark = {
  id: string;
  title: string;
  url: string;
  visitCount: number;
  lastVisit: number;
  currentFolder?: string;
  suggestedFolder?: string;
  confidence?: number;
};
