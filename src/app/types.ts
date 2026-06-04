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

export type OrganizeMode = "quick" | "deep";

export type BookmarkForAI = {
  id: string;
  title: string;
  domain: string;
  path: string;
  sanitizedUrl: string;
  metadata?: {
    available: boolean;
    title?: string;
    description?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogSiteName?: string;
    finalUrl?: string;
    httpStatus?: number;
    reason?: string;
  };
};

export type FolderHabitSample = {
  folderPath: string[];
  bookmarkCount: number;
  examples: Array<{
    title: string;
    domain: string;
    url?: string;
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
  kind: "organize" | "manual" | "pre-restore";
  createdAt: number;
  tree: chrome.bookmarks.BookmarkTreeNode[];
  bookmarkCount: number;
  folderCount: number;
  movePlan?: MovePlan[];
  restoreSourceId?: string;
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

export type BookmarkLinkHealthResult = {
  bookmarkId: string;
  bookmarkTitle: string;
  bookmarkUrl: string;
  checkedAt: number;
  status: "ok" | "broken" | "suspicious" | "temporary_failed" | "invalid" | "skipped";
  httpStatus?: number;
  finalUrl?: string;
  checkedMethod?: "HEAD" | "GET";
  reason?: string;
};

export type BookmarkLinkHealthReport = {
  id: string;
  createdAt: number;
  checkedCount: number;
  skippedCount: number;
  brokenCount?: number;
  suspiciousCount?: number;
  temporaryFailedCount?: number;
  invalidCount: number;
  results: BookmarkLinkHealthResult[];
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

export type BookmarkRestoreReport = {
  id: string;
  createdAt: number;
  backupId: string;
  backupCreatedAt: number;
  restoredCount: number;
  recreatedCount: number;
  folderCount: number;
  failedItems: FailedMove[];
  preRestoreBackupId?: string;
};

export type OrganizeReport = {
  id: string;
  kind?: "organize" | "undo" | "reapply";
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
  organizeMode?: OrganizeMode;
  movePlan: MovePlan[];
  tokenUsage?: TokenUsage;
};

export type PreviewTaskCache = {
  id: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  bookmarkCount: number;
  selectedBookmarkIds: string[];
  organizeMode?: OrganizeMode;
  movePlan?: MovePlan[];
  tokenUsage?: TokenUsage;
  error?: string;
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
  analysisSource?: "ai" | "fallback";
  analysisWarning?: string;
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
