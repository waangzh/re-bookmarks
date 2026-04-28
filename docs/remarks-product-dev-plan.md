# ReMarks 产品与开发规划

## 概要

第一版按“稳妥 MVP”推进：先解决书签整理的核心闭环，再补增强能力。核心闭环包括读取书签树、AI/规则分类、用户预览调整、确认后移动、整理前备份、支持最近一次撤销、新增书签轻提示推荐。

已确定的产品取舍：

- 常访问书签：使用浏览历史分析，需要 `history` 权限，但设计为可选启用。
- 新增书签推荐：采用轻提示，不主动弹出强打扰窗口。
- 第一版范围：做稳定可用 MVP，不一次性加入过多复杂功能。

## 核心功能

### 智能整理现有书签

- 读取 `chrome.bookmarks.getTree()` 获取当前浏览器书签树。
- 展平书签树，提取标题、域名、当前路径、清洗后的 URL。
- 默认不向 AI 发送 URL query 和 hash。
- 支持用户设置“是否允许嵌套文件夹”；默认允许，最大两级分类。
- AI 分类结果进入预览页，用户确认前不改动任何书签。
- 用户可在预览页手动调整分类、目标文件夹和待整理项。

### 新增书签推荐

- background service worker 监听 `chrome.bookmarks.onCreated`。
- 对新增 URL 执行本地规则 + AI 推荐。
- 不主动弹出确认窗口；通过插件图标 badge 和 popup 顶部展示“待处理推荐”。
- 用户点击推荐后才移动书签到建议文件夹。
- 用户忽略推荐时，推荐保留在待处理队列中。

### 常访问书签

- 在设置中单独开启。
- 开启时请求 `history` 权限，用 `chrome.history.search()` 获取访问记录。
- 只在本地计算“已收藏 URL 的访问频次”，不把浏览历史发送给 AI。
- 展示维度包括最近常访问、长期常访问、常访问但未整理、常访问且分类置信度低。

### 补充能力

- 重复书签检测：识别同 URL 或同域名近似重复，只提示，不自动删除。
- 待整理收件箱：低置信度、新增未处理、无法分类的书签进入“待整理”。
- 分类规则学习：用户手动调整后的结果保存为本地规则，用于后续推荐。
- 整理报告：展示移动数量、创建文件夹数量、失败项和隐私摘要。

## 技术设计

### 技术栈

- Manifest V3
- React + TypeScript + Vite
- Zustand 管理 UI 状态和任务状态
- `chrome.storage.local` 保存设置、API Key、分类规则、备份和待处理推荐

### 权限设计

- 必需权限：`bookmarks`、`storage`
- 可选权限：`history`
- 不申请 `tabs`、`identity`、`notifications`
- `history` 只在用户开启“常访问书签”时请求

### AI Provider

MVP 必做：

- OpenAI-compatible
- 自定义 endpoint
- DeepSeek 预设

后续补充：

- Gemini
- Moonshot / Kimi
- 智谱 GLM

Provider 抽象统一为：

```ts
export type AIProvider = {
  testConnection(config: AIProviderConfig): Promise<boolean>;
  classify(
    config: AIProviderConfig,
    request: AIClassifyRequest
  ): Promise<AIClassifyResult[]>;
};
```

API Key 只保存到 `chrome.storage.local`，不使用 `chrome.storage.sync`。

### 关键数据模型

```ts
export type BookmarkNode = {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
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

export type ClassificationResult = {
  id: string;
  category: string;
  confidence: number;
  reason?: string;
  source: "rule" | "ai" | "manual";
};

export type MovePlan = {
  bookmarkId: string;
  bookmarkTitle: string;
  fromParentId: string;
  fromIndex?: number;
  toFolderPath: string[];
  confidence: number;
  reason?: string;
};

export type BookmarkBackup = {
  id: string;
  createdAt: number;
  tree: chrome.bookmarks.BookmarkTreeNode[];
  movePlan: MovePlan[];
};

export type PendingRecommendation = {
  id: string;
  bookmarkId: string;
  createdAt: number;
  suggestedFolderPath: string[];
  confidence: number;
  reason?: string;
};
```

### UI 页面

- Popup：书签总览、开始整理、待处理推荐、常访问入口、撤销入口。
- Options：Provider、API Key、模型、endpoint、隐私开关、嵌套文件夹开关、常访问开关。
- Preview：分类树、书签列表、置信度、原因、目标文件夹、手动调整、确认整理。
- Report：整理结果、失败项、撤销按钮、隐私说明。

## 开发阶段

### 阶段 1：扩展骨架

- 创建 Vite + React + TypeScript 项目。
- 配置 Manifest V3。
- 跑通 popup、options page、background service worker。
- 验证 Chrome 和 Edge 均可加载未打包扩展。

### 阶段 2：书签读取与预览

- 封装 `chrome.bookmarks.getTree()`。
- 完成书签树展平、路径计算、URL 清洗。
- 展示书签数量和当前结构。

### 阶段 3：设置与 Provider

- 完成 API Key 本地保存、清除和连接测试。
- 接入 OpenAI-compatible。
- 增加自定义 endpoint 和 DeepSeek 预设。

### 阶段 4：AI 分类与规则分类

- 实现本地规则优先。
- 对未命中规则的书签进行 AI 批量分类。
- 对 AI 返回结果做 JSON 解析和 schema 校验。
- 失败时兜底到“待整理”，避免插件崩溃。

### 阶段 5：整理预览与执行

- 生成 `MovePlan`。
- 支持手动调整分类和目标文件夹。
- 用户确认后创建目标文件夹并移动书签。
- 执行前保存完整备份。

### 阶段 6：撤销最近一次整理

- 根据移动前的 `parentId` 和 `index` 回退。
- 原位置不存在或书签已被删除时展示部分失败明细。
- 第一版只支持撤销最近一次整理。

### 阶段 7：新增书签推荐

- 监听新增书签。
- 生成推荐并写入待处理队列。
- 通过 badge 和 popup 轻提示。
- 用户确认后执行移动。

### 阶段 8：常访问书签

- 设置页开启后请求 `history` 权限。
- 只对已收藏 URL 做本地频次计算。
- 展示常访问书签列表和整理建议。

### 阶段 9：Edge 验证与上架材料

- 分别验证 Chrome 和 Edge。
- 准备隐私政策、权限说明、截图、使用说明和商店描述。

## 测试计划

### 单元测试

- URL 清洗不保留 query 和 hash。
- 书签树展平和路径生成正确。
- AI 返回非法 JSON 时不崩溃。
- `MovePlan` 生成正确。
- 关闭嵌套文件夹时分类路径压平到一级。
- 备份和撤销记录包含原 `parentId` 与 `index`。

### 手动测试

- 空书签。
- 只有一级书签。
- 多级文件夹。
- 中文标题。
- 超长标题。
- 重复 URL。
- URL 带 token、query、hash。
- AI 请求失败。
- Provider 配置错误。
- API Key 清除。
- 整理过程中书签被用户删除。
- 新增书签后出现待处理推荐。
- 开启和关闭 `history` 权限后的常访问展示。
- Chrome 和 Edge 加载、整理、撤销全流程。

### 隐私测试

- API Key 不进入日志、备份、导出文件。
- 默认不发送完整 URL query 和 hash。
- 浏览历史不发送给 AI。
- 未开启常访问时不请求 `history` 权限。
- 清除 API Key 后本地存储无残留。

## 假设与依据

- 默认分类最多两级；用户关闭嵌套时只保留一级分类。
- 第一版不自动删除书签，不静默整理，不做账号系统，不经过自有服务器。
- 常访问能力使用可选 `history` 权限，避免安装时就暴露高敏感权限。
- 书签整理操作必须由用户在预览页确认后执行。
- AI 只接收最小化书签数据，默认不接收完整 URL。
- 参考官方 API：
  - Chrome bookmarks API: https://developer.chrome.com/docs/extensions/reference/api/bookmarks
  - Chrome storage API: https://developer.chrome.com/docs/extensions/reference/api/storage
  - Chrome history API: https://developer.chrome.com/docs/extensions/reference/api/history
