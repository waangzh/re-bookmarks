# AGENTS.md

## 按任务查阅

| 改动 | 先查阅 |
| --- | --- |
| 新增功能、确定模块归属、调整跨层调用或浏览器构建 | [架构与扩展入口](architecture.md) |
| 页面、交互或 Store | [前端规范索引](.trellis/spec/frontend/index.md) |
| 跨页面状态 | [运行边界](architecture.md)、[前端规范索引](.trellis/spec/frontend/index.md) |
| 整理、推荐、书签写入、AI、权限和后台任务 | [架构与关键流程](architecture.md)、[扩展安全规范索引](.trellis/spec/extension/index.md) |

## 常用命令

- 在仓库根目录运行 `pnpm install` 安装依赖。pnpm 版本以 `package.json` 的 `packageManager` 为准，`pnpm-lock.yaml` 只用 pnpm 更新。
- `npm run dev` 监听构建，`npm run preview` 预览页面。扩展权限和后台行为需要加载构建产物验证。
- 图标源变更后运行 `node scripts/generate-icons.mjs`。

## 验证规则

提交代码前完成下表中适用的验证。Vite 构建负责转译和打包，TypeScript 类型检查单独执行。

| 改动 | 最小验证 |
| --- | --- |
| 仅文档 | 核对内容、链接和改动范围。受 Git 忽略的本地文档直接检查文件内容。 |
| 代码 | 默认运行 `npm run build`。涉及 TypeScript 时运行 `npx --no-install tsc --noEmit`，并按改动选择相关回归。 |
| 共享服务的跨浏览器行为、权限、清单、后台、入口 HTML 或构建脚本 | 运行 `npm run build:all`，检查两套产物中 manifest 引用的路径、后台和侧栏配置。 |
| UI 布局 | 检查 360px popup、浏览器侧栏和 options 页面。涉及侧栏能力时分别在 Chromium 和 Firefox 验证。 |
| 权限、历史记录或 manifest | 验证仅在用户开启常访问书签时通过 `chrome.permissions.request` 请求 `history`。未授权时功能可降级，历史数据不进入 AI 请求、导出或日志。 |

回归测试按文件运行。`tests/` 下使用 `node --test` 执行对应的 `*.test.mjs`，例如 `node --test tests/ai-protocols.test.mjs`。`scripts/` 下也有独立回归，例如 `node --test scripts/test-ai-output-budgets.cjs`。分别记录类型检查、构建、模拟测试与真实浏览器的验证结果。

## 代码约定

- React 组件使用 function component 和 hooks；状态优先放组件本地或 `useAppStore`。
- 新增书签、存储、权限或历史记录等 `chrome.*` 调用时，优先复用服务层封装。
- AI 入参需要 URL 脱敏时复用 `sanitizeUrl`。
- AI 返回必须经过 JSON 解析和字段校验；非法 JSON、缺失 `id`、置信度异常时应降级到失败原因或“待整理”。
- 文件夹路径必须经过 `normalizeFolderPath` / `normalizeCategoryPath`，并尊重嵌套层级和分类数量设置。
- UI 延续现有 class 命名、lucide-react 图标和 Tailwind/CSS 混合写法，复用现有 UI 组件。长标题、URL 和按钮文案要处理溢出。不要引入新的 UI 框架。
- 保留现有源码编码。批量转码或重写文案需用户明确要求，新文档使用 UTF-8。

## 隐私与安全边界

- API Key 只允许通过 `storage.ts` 写入 `chrome.storage.local`，不得进入报告、备份、导出内容或示例文件。
- `history` 必须保持可选权限，浏览历史数据不得发送给 AI。
- 涉及书签移动前，必须有预览、用户确认和可用备份。
- 删除书签、清空存储、批量改写书签或大规模重构前必须先询问用户。
- 新增生产依赖、替换包管理器、新增敏感扩展权限、修改 AI Provider 协议/默认模型/默认 endpoint/API Key 存储方式前必须先询问用户。
- 不要编辑 `node_modules/`、`dist/`、`vendor/` 等生成目录。不要提交 `.env*`、日志或真实凭据。

## 整理与 AI 回归

- 修改整理流程时至少推演空书签、中文和长标题、重复 URL、嵌套与分类数量限制、目录复用和路径规范化。
- 检查无 API Key、请求失败和非法响应的降级。书签不存在或单项移动失败时应记录到 `failedItems`，其余项继续处理。验证整理前备份、撤销和恢复失败追踪。
- 修改 AI prompt、`parseResults` 或分类压缩逻辑时，确认输出契约仍包含 `id`、`category`/`categoryPath`、`confidence`、`reason`。

## Git 约定

- 修改前运行 `git status --short`，确认已有改动。
- 不要直接提交到 `main`，除非用户明确要求。
- 提交信息使用 Conventional Commits，例如 `docs: update agent guide`。
