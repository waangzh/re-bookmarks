---
project: ReMarks (re-bookmarks)
scope: Browser Extension UI (Popup, Sidebar, Options)
stack: React 18, Tailwind CSS v4, Radix UI, Lucide React
tokens:
  theme_mode: "light dark (prefers-color-scheme)"
  colors:
    light:
      paper: "#f6f8fc"
      surface: "#ffffff"
      surface_elevated: "#ffffff"
      surface_subtle: "#f8fafc"
      surface_hover: "#f4f7fc"
      ink: "#17233b"
      ink_secondary: "#43516b"
      muted: "#63728b"
      subtle: "#8c9ab0"
      line: "#e5eaf3"
      line_strong: "#d5deed"
      blue: "#315fda"
      blue_solid: "#315fda"
      blue_solid_hover: "#2350be"
      blue_solid_active: "#2047a9"
      soft: "#edf3ff"
      soft_hover: "#dfeaff"
      soft_active: "#d3e2ff"
      soft_border: "#d5e2fc"
      focus_ring: "#9db9ff"
      green: "#16775e"
      green_soft: "#e9f6f0"
      amber: "#91570f"
      amber_soft: "#fff4e7"
      amber_soft_hover: "#ffedd5"
      amber_border: "#f4d18b"
      red: "#b91c1c"
      red_strong: "#dc2626"
      red_soft: "#fef2f2"
      red_soft_hover: "#fee2e2"
      red_border: "#fecaca"
      purple: "#6d5bd0"
      purple_soft: "#f0edff"
    dark:
      paper: "#0c111d"
      surface: "#131b2b"
      surface_elevated: "#182236"
      surface_subtle: "#162033"
      surface_hover: "#1e2b45"
      ink: "#e8eef8"
      ink_secondary: "#cbd5e1"
      muted: "#94a3b8"
      subtle: "#64748b"
      line: "#243148"
      line_strong: "#334361"
      blue: "#78a2ff"
      blue_solid: "#2f62e8"
      blue_solid_hover: "#3c6ef2"
      blue_solid_active: "#2553cc"
      soft: "#162440"
      soft_hover: "#1d3054"
      soft_active: "#253c69"
      soft_border: "#2a4270"
      focus_ring: "#5d87f5"
      green: "#34d399"
      green_soft: "#0f2920"
      amber: "#fbbf24"
      amber_soft: "#291f0e"
      amber_soft_hover: "#382a13"
      amber_border: "#5c4318"
      red: "#f87171"
      red_strong: "#ef4444"
      red_soft: "#2d1417"
      red_soft_hover: "#3c1a1e"
      red_border: "#65262d"
      purple: "#a78bfa"
      purple_soft: "#211b3b"
  radii:
    panel: "8px"
    control: "6px"
    inner: "4px"
    dialog: "12px"
    pill: "999px"
  typography:
    font_sans: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif'
    title_page: "23px (<=520px: 20px)"
    title_featured: "22px (<=320px: 20px)"
    heading_section: "13px"
    body_default: "13px"
    meta_secondary: "12px"
    micro_label: "11px"
  layout:
    popup_width: "360px"
    sidebar_max: "460px"
    page_max: "760px"
    row_min_height: "44px"
    icon_badge_size: "28px"
  motion:
    interactive: "150ms ease"
    chevron_nudge: "150ms cubic-bezier(0.2, 0.8, 0.2, 1)"
    press: "120ms ease"
    reduced_motion: "prefers-reduced-motion: reduce"
---

# ReMarks Design System (`DESIGN.md`)

ReMarks 是一个同时运行在 **360px Popup、浏览器侧栏（Sidebar）和独立设置页（Options）** 的跨浏览器扩展。本规范结合项目演进实践与现代组件设计原则（语义化 Token、可触达微交互、无障碍聚焦反馈），作为人工维护与 AI 协助修改界面时的单一视觉与交互依据。

> 相关工程边界与状态约束同步遵循 [.trellis/spec/frontend/component-guidelines.md](.trellis/spec/frontend/component-guidelines.md) 与 [architecture.md](architecture.md)。

---

## 1. 设计原则与演进脉络

1. **克制与信息秩序优先（Calm Utility）**：扩展窗口空间有限，优先通过卡片分组、留白、明确的动词标签与状态色引导决策，不堆砌说明文案、装饰性阴影或无意义的徽标。
2. **表面层级代替重分割线**：以浅灰画布（`--remarks-paper`）托起白色内容卡片（`--remarks-surface`）和柔蓝焦点卡（`--remarks-soft`），用 `1px` 细边框与内边距列表组织操作，避免裸露在画布上的无容器横线列表。
3. **操作必有即时反馈（Tactile Feedback）**：所有可点击行、按钮与开关必须具备可清晰辨识的 `Hover`、`Focus-Visible`、`Active` 与 `Busy/Disabled` 状态，杜绝“鼠标放上去却看不出是否选中”的静默交互。
4. **安全语义不可被视觉简化**：高风险或不可逆操作（如写入书签、批量删除、恢复备份）必须保留明确的警告色、影响数量、预览与模态确认，不得用弱化的展示掩盖风险。

**历史演进关键决策**：
- 全量样式抽象为 `--remarks-*` 语义变量并适配系统浅/深色模式（`color-scheme: light dark`）。
- 统一子页头部（`PageHeading`）、全局顶部提示（`TopNotice` 悬停/聚焦暂停计时）、Radix 无障碍原语（`PreviewDialog`、`Switch`、`BookmarkRowActionMenu`）。
- 为级联目录引入安全三角区与 95ms 悬停防抖（`FolderCascadeSelect`），为审核页固定底栏与撤销提示建立清晰节律（`ReviewWorkbench`）。
- 统一首页与任务中心待办/常用操作列表卡片、高对比悬停反馈与任务图标语义（`SidebarHome` + `getHomeTaskVisual`）。

---

## 2. 色彩与表面层级（Color & Surface Hierarchy）

所有颜色定义在 [src/styles/redesign.css](src/styles/redesign.css) 的 `:root` 与 `@media (prefers-color-scheme: dark)` 中（写在 `:root` 而非仅 `.remarks-app`，以确保挂载在 `body` 下的 `Dialog.Portal`、`DropdownMenu.Portal` 与 `TopNotices` 同样继承深色主题）。

### 2.1 表面层级（Surface Ladder）

| 层级 | CSS 变量 | 浅色值 | 深色值 | 适用场景 |
| --- | --- | --- | --- | --- |
| L0 页面画布 | `--remarks-paper` | `#f6f8fc` | `#0c111d` | 扩展主背景、页面底色 |
| L1 内容卡片 | `--remarks-surface` | `#ffffff` | `#131b2b` | 列表卡片、当前网页卡、设置分区、审核卡片 |
| L2 浮层/高亮内徽章 | `--remarks-surface-elevated` | `#ffffff` | `#182236` | 下拉弹层、右键菜单、悬停行内的蓝色图标徽章 |
| L1 弱底纹/嵌套区 | `--remarks-surface-subtle` | `#f8fafc` | `#162033` | 路径展示条、说明折叠体、禁用输入框 |
| 交互高亮态 | `--remarks-soft` | `#edf3ff` | `#162440` | 列表行 Hover/Focus、主建议卡片、次级蓝色按钮 |
| 交互按压/二次提亮 | `--remarks-soft-hover` / `--remarks-soft-active` | `#dfeaff` / `#d3e2ff` | `#1d3054` / `#253c69` | 按钮 Hover / Active 按压反馈 |

### 2.2 文本、边框与语义色

- **文本对比梯度**：主标题与强交互标签使用 `--remarks-ink`；正文与次级行使用 `--remarks-ink-secondary`；辅助元信息（域名、时间、统计）使用 `--remarks-muted`；占位提示与默认右箭头使用 `--remarks-subtle`。
- **语义状态色**：
  - **主操作 / 品牌强调**：`--remarks-blue` / `--remarks-blue-solid`（按钮主色与悬停文字高亮）
  - **成功 / 已收藏 / 安全**：`--remarks-green` + `--remarks-green-soft` + `--remarks-green-border`
  - **待办 / 警示 / 注意**：`--remarks-amber` + `--remarks-amber-soft` + `--remarks-amber-border`
  - **危险 / 失败 / 错误**：`--remarks-red` / `--remarks-red-strong` + `--remarks-red-soft` + `--remarks-red-border`
  - **AI 印象 / 语义标签**：`--remarks-purple` + `--remarks-purple-soft` + `--remarks-purple-border`

> **关键对比度规则**：禁止把 `--remarks-surface-hover`（`#f4f7fc`）直接用作 `--remarks-paper`（`#f6f8fc`）上的悬停提示——两者亮度差过小，用户无法感知选中。可点击列表必须包裹在 `--remarks-surface` 卡片容器内，并使用 `--remarks-soft`（配合 `--remarks-soft-border` 与文字变蓝）作为悬停/聚焦态。

---

## 3. 排版与文案规范（Typography & Copy）

- **字体栈**：使用系统原生无衬线与中文黑体回退链，不额外加载远程 Webfont。
- **字号与字重阶梯**：
  - 子页面主标题（`PageHeading` / `.extension-page__title`）：`23px` Bold（`<= 520px` 窄屏降为 `20px`）
  - 首页焦点任务标题（`.home-featured-task h1`）：`22px` Bold（`<= 320px` 降为 `20px`）
  - 分区标题（`.home-section-heading h2` / `.extension-section__title`）：`13px` Bold
  - 列表项标题、操作按钮、正文：主列表项 `13px` SemiBold（`600`），常规正文 `13px` Regular（`400`），`line-height: 1.5–1.8`
  - 辅助说明、域名、页脚链接：`12px`；微标签与快捷键提示：`11px`
- **数字与溢出处理**：
  - 所有数量、批次、耗时、统计数值必须启用 `font-variant-numeric: tabular-nums`，防止数字跳动。
  - 长书签标题、URL 与文件夹路径必须处理溢出：单行截断使用 `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`，多行说明或可换行路径使用 `min-width: 0; overflow-wrap: anywhere;`。
  - 界面文案**不使用中点（`·`）分隔**；`PageHeading` 的 `subtitle` 只展示动态数量或影响操作的状态，不重复解释标题本身。

---

## 4. 布局、间距与同心圆角（Layout, Spacing & Concentric Radii）

### 4.1 视口与容器宽度

| 入口模式 | 容器约束 | 内边距 | 说明 |
| --- | --- | --- | --- |
| Popup 紧凑模式 | `360px` 宽（`.home-v2--compact`） | `24px 18px 18px` | 最近/常访问列表默认上限 2 条 |
| 浏览器侧栏 Sidebar | `max-width: 460px` | `24px 18px 18px` | 隐藏顶栏重复品牌头，最近/常访问默认上限 5 条 |
| 独立页面 Options / Subpage | `min(100%, 760px)` | `24px`（`<=520px` 为 `24px 18px 18px`） | 固定底栏需为正文预留底部空间（设置页 `100px`/`128px`，审核页 `160px`） |
| 极窄视口断点 | `<= 320px` | `18px 10px` | 隐藏搜索框 `kbd` 快捷键徽标与次级辅助提示，主按钮组允许换行 |

### 4.2 同心圆角与无阴影规则

- **圆角令牌**：
  - `--remarks-radius-panel: 8px`：卡片容器、下拉菜单面板、搜索框、分组面板。
  - `--remarks-radius-control: 6px`：独立按钮、输入框、图标徽章（`28px × 28px`）、选择框触发器。
  - `--remarks-radius-inner: 4px`：带 `4px` 内边距的列表容器内部行（满足同心圆角 `8px - 4px = 4px`）。
  - 弹窗与胶囊：`12px`（`.preview-dialog`）、`999px`（Switch 开关、进度条、标签胶囊）。
- **阴影与装饰约束**：
  - 普通卡片、列表容器与常规按钮**禁止添加 `box-shadow` 或装饰性左侧色线**。
  - 仅允许浮层（下拉菜单 `--remarks-shadow-popover`、模态框 `--remarks-shadow-dialog`、Switch 滑块）使用阴影表现跨层浮起。

---

## 5. 交互状态与微交互规范（Interactive States & Micro-Interactions）

所有可交互列表按钮（`.home-queue-row`、`.home-quick`、`.home-tool-list a`、`.home-search-suggestion`）与操作按钮统一遵循五态模型：

1. **Default（默认态）**：
   - 最小点击高度 `min-height: 44px`（下拉菜单项至少 `36px–40px`），预留 `border: 1px solid transparent` 防止悬停加边框时产生 `1px` 抖动。
   - 使用 `cursor: pointer; user-select: none;`。
2. **Hover（悬停态）**：
   - 过渡时长 `150ms ease`：背景切换为 `--remarks-soft`，透明边框切换为 `--remarks-soft-border`。
   - 标题文字与右侧箭头切换为 `--remarks-blue`，右侧箭头 `ChevronRight` 沿 X 轴右移 `2px`（`150ms cubic-bezier(0.2, 0.8, 0.2, 1)`）。
   - **图标徽章反差保护**：当整行背景变为 `--remarks-soft` 时，蓝色图标徽章同步切换为 `--remarks-surface-elevated` + `--remarks-soft-border`（琥珀/红徽章切换为对应的 `-soft-hover` 与 `-border`），避免徽章底色与悬停背景融为一体。
3. **Focus-Visible（键盘焦点态）**：
   - 禁止全局移除焦点指示器；仅在 `:focus-visible` 时显示。
   - 独立控件沿用 `--remarks-focus-ring`（`outline: 3px solid var(--remarks-focus-ring); outline-offset: 3px`）；位于 `overflow: hidden` 或紧贴容器边缘的列表项使用内缩焦点环 `outline: 2px solid var(--remarks-focus-ring); outline-offset: -2px` 并同步应用 `--remarks-soft` 背景高亮。
4. **Active（按压态）**：
   - 列表行与独立主按钮在 `:active:not(:disabled)` 时给予即时触感回弹：列表行使用 `--remarks-soft-active` + `transform: scale(0.99)`（`120ms ease`）；主按钮使用 `--remarks-blue-solid-active` + `transform: translateY(1px)`。
5. **Disabled / Busy（禁用与进行中态）**：
   - 禁用按钮 `cursor: not-allowed` 且降低透明度，不触发按压缩放。
   - 数据读取阶段使用与真实卡片/列表同尺寸的骨架屏（`.home-skeleton-block`，`44px` / `39px`）；局部异步动作使用旋转 `LoaderCircle`（`.home-action-spinner`）配合可读文案。
6. **Motion & Pointer Ergonomics**：
   - 全局声明 `@media (prefers-reduced-motion: reduce)` 关闭过渡与关键帧动画。
   - 级联菜单保留 `95ms` 悬停延迟与安全三角区判定；`TopNotice` 在悬停或键盘聚焦时暂停自动关闭计时（纯成功提示 `5000ms`，其余及带操作提示 `8000ms`）。

---

## 6. 图标语义与一致性规范（Iconography）

全项目统一使用 `lucide-react`，装饰性图标一律添加 `aria-hidden="true"`。功能图标跨入口（首页“下一步建议” / “其他待办” / 任务中心“全部待办” / “常用操作” / “更多工具” / 管理页）保持严格一对一语义映射（由 `getHomeTaskVisual` 统一维护）：

| 功能 / 任务类型 | 图标 (`lucide-react`) | 徽章色调 | 使用位置 |
| --- | --- | --- | --- |
| 待归档书签（`archive`） | `FolderInput` | Amber（琥珀） | 下一步建议、其他待办、全部待办、待整理批量归档 |
| 失效链接复查（`links`） | `Link2Off` | Amber（琥珀） | 下一步建议、其他待办、全部待办、更多工具（失效检测） |
| 重复链接核对（`duplicate`） | `Copy` | Amber（琥珀） | 下一步建议、其他待办、全部待办、更多工具（重复检测） |
| 失败项复查 / 整理报告（`report`） | `FileText` | Red（待办）/ Blue（工具） | 全部待办、其他待办、更多工具（整理报告） |
| 生成失败警示（`failed`） | `AlertTriangle` | Red（红） | 下一步建议、其他待办、全部待办 |
| 整理方案生成中（`running`） | `LoaderCircle`（旋转） | Blue（蓝） | 下一步建议、其他待办、全部待办 |
| 智能整理 / 审核方案 / 分类偏好（`preview`） | `Sparkles` | Blue（蓝） | 下一步建议、全部待办、常用操作、更多工具（分类偏好） |
| 管理书签（`local` / `/manage`） | `Folder` | Blue（蓝） | 常用操作、管理书签页（不与 `FolderInput` 混用） |
| 常访问书签（`/history`） | `History` | Blue（蓝） | 常用操作（无待办时）、更多工具 |
| 导入 / 备份 / 设置 / 健康态 | `FileUp` / `Archive` / `Settings` / `CheckCircle2` | Blue（蓝） | 更多工具、首页健康态 |

---

## 7. 核心组件清单与复用约束

修改或新增页面时，优先复用以下已有组件而非重新造轮子：

- **导航与页面框架**：[SidebarHome.tsx](src/app/components/SidebarHome.tsx)（首页与 `/tasks` 任务中心共享）、[PageHeading.tsx](src/app/components/PageHeading.tsx)、[MoreTools.tsx](src/app/components/MoreTools.tsx)
- **反馈与披露**：[TopNotice.tsx](src/app/components/TopNotice.tsx)、[CollapsibleSection.tsx](src/app/components/CollapsibleSection.tsx)、[RecommendationActionHelp.tsx](src/app/components/RecommendationActionHelp.tsx)
- **表单与菜单原语**：[PreviewDialog.tsx](src/app/components/PreviewDialog.tsx)（Radix Dialog）、[Switch.tsx](src/app/components/Switch.tsx)（Radix Switch）、[Select.tsx](src/app/components/Select.tsx)、[FolderCascadeSelect.tsx](src/app/components/FolderCascadeSelect.tsx)、[FolderPathSelect.tsx](src/app/components/FolderPathSelect.tsx)、[BookmarkRowActionMenu.tsx](src/app/components/BookmarkRowActionMenu.tsx)（Radix DropdownMenu）
- **核心业务工作台**：[ReviewWorkbench.tsx](src/app/components/ReviewWorkbench.tsx)（配合 [preview-review.css](src/styles/preview-review.css)）

---

## 8. AI 与开发者执行守则（Do's & Don'ts）

### Do（应当）
- 新增或调整界面样式时，优先使用 `redesign.css` 中定义的 `--remarks-*` 变量与圆角令牌，并同时检查浅色与深色模式下的对比度。
- 为任何新列表按钮或导航行使用「`--remarks-surface` 卡片容器 + `4px` 内边距 + `--remarks-radius-inner` 行圆角 + `--remarks-soft` 悬停/聚焦态 + 右箭头微移」模式。
- 修改 `SidebarHome`、`ManageBookmarks`、`MoreTools` 的任务入口时，确保图标严格对齐第 6 节的语义映射表。
- 完成改动后按顺序验证：`360px` Popup、Sidebar 侧栏、Options 页面、长标题/空状态/错误态/繁忙态，以及对应的 `tests/ui-polish.test.mjs` 与 `npm run build`（跨浏览器配置变更需跑 `npm run build:all`）。

### Don't（禁止）
- **禁止**大范围重写非本次任务范围内的既有页面样式。
- **禁止**在组件内硬编码未接入 `--remarks-*` 的 Tailwind 默认色值（如裸写 `bg-blue-500`、`text-gray-500`）作为核心界面色。
- **禁止**对可交互行使用与底色近乎无差别的 Hover 色（如在 `--remarks-paper` 上使用 `--remarks-surface-hover`），或移除 `:focus-visible` 焦点环。
- **禁止**给普通内容卡片或普通按钮添加阴影、渐变装饰条或左侧色线。
- **禁止**把需要用户确认或权限说明的文案一并精简掉（数据外发、权限范围、覆盖/删除后果与真实失败原因必须明确可见）。
