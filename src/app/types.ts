export type BookmarkNode = {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  index?: number;
  dateAdded?: number;
  children?: BookmarkNode[];
  path: string[];
  type: "folder" | "url";
};

export type OrganizeMode = "quick" | "deep";

/** 模型列表缓存：按 provider 类型 + endpoint 区分，避免跨服务串用 */
export type ModelCatalogCache = {
  providerType: string;
  endpoint: string;
  fetchedAt: number;
  models: { id: string; ownedBy?: string }[];
};

export type FixedDomainRule = { id: string; domain: string; folderId: string; folderPath: string[]; createdAt: number };

export type BookmarkWhitelistEntry = {
  type: "bookmark" | "folder";
  id: string;
  addedAt: number;
};

export type UnclassifiedHandling = "collect" | "preserveSourcePath";

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

export type ClassificationDecision = "existing_folder" | "new_folder" | "defer";

export type ClassificationResult = {
  id: string;
  category: string;
  categoryPath?: string[];
  confidence: number;
  reason?: string;
  /** AI 生成的功能印象词，用于本地印象搜索；旧数据或解析失败时为空 */
  keywords?: string[];
  decision: ClassificationDecision;
  source: "rule" | "ai" | "manual";
};

/** 印象索引来源，便于后续区分 AI 生成与用户手动补充 */
export type BookmarkImpressionSource =
  | "ai_organize"
  | "ai_recommend"
  | "rule_fallback"
  | "user_edit"
  /** V2：AI 深度搜索时顺手自愈补全 */
  | "ai_search_heal"
  /** V2：存量书签静默批量建索引 */
  | "ai_batch_index";

/** 单个书签的功能印象索引；normalizedUrl 是持久化主键，备份恢复后仍可复用 */
export type BookmarkImpressionMeta = {
  normalizedUrl: string;
  lastBookmarkId?: string;
  keywords: string[];
  summary: string;
  folderSnapshot?: string;
  source: BookmarkImpressionSource;
  updatedAt: number;
};

export type SemanticIndexStorage = {
  version: 1;
  items: Record<string, BookmarkImpressionMeta>;
  /** 是否已完成从历史整理报告吸纳旧数据 */
  migratedAt?: number;
};

export type ImpressionMatchType =
  | "title"
  | "ai_keyword"
  | "ai_summary"
  /** V2：AI 候选集语义精排命中 */
  | "ai_rerank"
  | "folder"
  | "heuristic"
  | "url";

export type SearchableBookmark = {
  id: string;
  title: string;
  url: string;
  folderPath: string;
};

export type ImpressionSearchResult = {
  bookmark: SearchableBookmark;
  score: number;
  matchType: ImpressionMatchType;
  /** 供 UI 展示的命中说明，例如“匹配功能印象：视频网站 / 在线追番” */
  matchHint?: string;
  displayTags: string[];
  /** V2：本次搜索顺手把功能印象写回本地索引，UI 可提示“已记住该印象” */
  healed?: boolean;
};

/** Stage 1：AI 查询词联想扩展结果 */
export type AIQueryExpansionResult = {
  /** 核心功能意图词，如 ["代码截图", "代码转图片"] */
  coreIntents: string[];
  /** 中英文同义词、行业术语与 URL 常见词根 */
  bilingualKeywords: string[];
  /** AI 依据世界知识推测的匹配站点名或域名 */
  likelySites: string[];
  /** 可能归属的文件夹分类词 */
  folderHints: string[];
};

/** Stage 3：发送给 AI 精排的精简候选书签，严控 Token 体积 */
export type AIRerankCandidateInput = {
  id: string;
  title: string;
  /** 仅 hostname + 首层 pathname，不含 query / hash */
  shortUrl: string;
  folder: string;
  existingHint?: string;
};

/** Stage 3：AI 精排返回的单条结果，同时携带索引自愈数据 */
export type AIRerankResultItem = {
  id: string;
  /** 语义相关度 0~100，低于 45 的结果会被过滤 */
  relevance: number;
  matchReason: string;
  healedKeywords: string[];
  healedSummary: string;
};

/** V2 深度搜索执行阶段，供 UI 展示渐进式反馈 */
export type DeepSearchStage =
  | "idle"
  | "expanding"
  | "expanded_shown"
  | "completed"
  | "error";

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
  keepInPlace?: boolean;
  sourceFolderPath?: string[];
  expectedTargetId?: string | null;
  policyFingerprint?: string;
  preferenceFingerprint?: string;
  executionStatus?: "pending" | "moved" | "unchanged" | "failed" | "kept";
  executedTargetParentId?: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type BookmarkBackup = {
  id: string;
  kind: "organize" | "manual" | "pre-restore" | "pre-import" | "duplicate-delete" | "invalid-delete";
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

export type PendingRecommendationKind = "move" | "create_folder" | "manual_review" | "error";

export type PendingRecommendation = {
  id: string;
  bookmarkId: string;
  bookmarkTitle: string;
  bookmarkUrl?: string;
  createdAt: number;
  suggestedFolderPath: string[];
  currentFolderPath?: string[];
  sourceParentId?: string;
  source?: ClassificationResult["source"];
  preferenceFingerprint?: string;
  requiresIndividualReview?: boolean;
  expectedTargetId?: string;
  confidence: number;
  reason?: string;
  kind?: PendingRecommendationKind;
  errorCode?: "missing_api_key" | "ai_not_authorized" | "host_permission" | "invalid_response" | "provider_error";
};

export type BookmarkImportItemStatus = "ready" | "duplicate" | "invalid";

export type BookmarkImportItem = {
  id: string;
  title: string;
  url: string;
  normalizedUrl: string;
  path: string[];
  status: BookmarkImportItemStatus;
  reason?: string;
  existingBookmarkTitle?: string;
};

export type BookmarkImportPreview = {
  id: string;
  createdAt: number;
  sourceFileName?: string;
  targetRootName: string;
  items: BookmarkImportItem[];
  bookmarkCount: number;
  readyCount: number;
  duplicateCount: number;
  invalidCount: number;
  folderCount: number;
};

export type BookmarkImportFailedItem = {
  itemId: string;
  title: string;
  url?: string;
  path: string[];
  reason: string;
};

export type BookmarkImportProgress = {
  processed: number;
  total: number;
};

export type BookmarkImportReport = {
  id: string;
  createdAt: number;
  targetRootName: string;
  backupId: string;
  backupCreatedAt: number;
  importedCount: number;
  skippedCount: number;
  duplicateCount: number;
  invalidCount: number;
  folderCount: number;
  failedItems: BookmarkImportFailedItem[];
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
  updatedAt?: number;
  status?: "running" | "completed" | "failed";
  totalCount?: number;
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
  temperature?: number;
  maxTokens?: number;
  tokenParam?: "auto" | "max_tokens" | "max_completion_tokens";
  jsonMode?: "auto" | "on" | "off";
  enabled?: boolean;
  testedAt?: number;
};

export type Settings = {
  provider: AIProviderConfig;
  providerConfigs: Partial<Record<AIProviderType, AIProviderConfig>>;
  onboardingCompleted: boolean;
  allowNestedFolders: boolean;
  maxNestingLevel: number;
  maxTopLevelFolders: number;
  maxSubfoldersPerFolder: number;
  unclassifiedHandling: UnclassifiedHandling;
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
  kind?: "organize" | "recommendation" | "undo" | "reapply";
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
  keptCount?: number;
  createdFolderCount?: number;
  reusedFolderCount?: number;
};

export type PreviewPlanCache = {
  id: string;
  createdAt: number;
  bookmarkCount: number;
  whitelistFingerprint?: string;
  organizeMode?: OrganizeMode;
  model?: string;
  movePlan: MovePlan[];
  tokenUsage?: TokenUsage;
};

export type PreviewTaskPhase =
  | "queued"
  | "preparing"
  | "requesting_ai"
  | "parsing_results"
  | "generating_preview";

export type PreviewTaskProgress = {
  phase: PreviewTaskPhase;
  completedBatches: number;
  totalBatches: number;
  processedBookmarks: number;
  totalBookmarks: number;
  currentBatchSize?: number;
  startedAt: number;
  updatedAt: number;
};

export type PreviewTaskCache = {
  id: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  bookmarkCount: number;
  selectedBookmarkIds: string[];
  whitelistFingerprint?: string;
  organizeMode?: OrganizeMode;
  model?: string;
  movePlan?: MovePlan[];
  tokenUsage?: TokenUsage;
  error?: string;
  progress?: PreviewTaskProgress;
  executionOwner?: "background" | "page";
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
  whitelistFingerprint?: string;
  learning?: {
    correctionCount: number;
    rejectionCount: number;
    lastLearnedAt?: number;
    depthVotes: {
      levelOne: number;
      nested: number;
    };
    styleVotes: {
      topic: number;
      purpose: number;
    };
    categoryCorrections: Array<{
      fromFolderPath: string[];
      toFolderPath: string[];
      count: number;
      updatedAt: number;
    }>;
    domainPreferences: Array<{
      domain: string;
      folderPath: string[];
      count: number;
      updatedAt: number;
    }>;
    rejectedFolderPaths: Array<{
      folderPath: string[];
      domain?: string;
      isNewFolder?: boolean;
      count: number;
      updatedAt: number;
    }>;
    recentEvents: Array<{
      id: string;
      type: "category_override" | "folder_rejected";
      createdAt: number;
      bookmarkTitle?: string;
      domain?: string;
      suggestedFolderPath: string[];
      chosenFolderPath?: string[];
    }>;
  };
};

export type FolderHabitExportV1 = {
  version: 1;
  exportedAt: number;
  profile: Pick<FolderHabitProfile, "summary" | "preferredTopLevelFolders" | "folderRules" | "avoidRules" | "promptHint" | "learning">;
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

export type PreviewRiskLevel = "auto" | "framework" | "batch" | "review" | "keep";
export type PreviewPlanDecision = "move" | "keep";
export type PreviewFrameworkDecision = "approve" | "keep";

export type PreviewRiskItem = {
  plan: MovePlan;
  level: PreviewRiskLevel;
  reasons: string[];
  sourcePath: string[];
};

export type PreviewBatchGroup = {
  key: string;
  targetPath: string[];
  items: PreviewRiskItem[];
};

export type PreviewFrameworkGroup = {
  key: string;
  topLevel: string;
  targetPathCount: number;
  items: PreviewRiskItem[];
};
