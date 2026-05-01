# ReMarks

> AI 智能分类整理你的浏览器书签

## 项目简介

浏览器书签越积越多，手动整理费时费力，时间一长又会乱掉。ReMarks 是一个 Chrome/Edge 浏览器扩展，利用 AI 自动分析和分类书签，让用户在确认后一键完成整理，并支持随时撤销。

**解决的问题：** 书签堆积难以管理，手动分类效率低、难以坚持。

**特色功能：**
- AI 只提供建议，真正移动书签必须经过用户确认，用户始终拥有最终控制权
- 整理前自动生成完整备份，支持一键撤销
- 新增书签时自动推荐分类，保持书签整洁
- 支持学习用户的分类习惯，分类结果更贴合个人偏好
- 隐私优先：URL 默认脱敏后再发送给 AI，浏览历史不会发送给 AI

**适用场景：** 书签数量较多、希望借助 AI 快速整理、注重隐私安全的 Chrome/Edge 用户。

## 核心功能

- [x] 书签预览：整理前以树形结构展示所有书签，支持按文件夹多选筛选
- [x] AI 智能分类：基于 OpenAI 兼容协议调用 AI（支持 OpenAI、DeepSeek、自定义端点），返回分类建议和置信度
- [x] 确认后执行：用户预览分类方案，逐条确认后才执行移动
- [x] 一键撤销：整理前自动备份书签树，支持撤销最近一次整理操作
- [x] 新书签推荐：新增书签时自动弹出分类推荐，可通过浮窗或 badge 提醒
- [x] 常访问书签：可选读取浏览历史，识别高频访问但未收藏的页面
- [x] 分类习惯预设：AI 分析现有书签结构，学习用户的文件夹命名和分类偏好
- [x] 浮窗模式：在任意网页通过浮窗 iframe 访问 ReMarks，无需打开新标签页
- [x] 整理报告：每次整理后生成报告，包含移动数量、失败项和隐私摘要
- [x] 管理书签：内置书签管理视图，支持树形浏览和搜索

## 技术栈

- **前端框架：** React 18 + TypeScript
- **构建工具：** Vite
- **样式：** Tailwind CSS v4
- **状态管理：** Zustand
- **路由：** React Router
- **UI 组件：** Radix UI + lucide-react
- **AI 接口：** OpenAI 兼容协议（支持 OpenAI、DeepSeek、自定义端点）
- **浏览器 API：** Manifest V3，`chrome.bookmarks`、`chrome.storage`、`chrome.permissions`、可选 `chrome.history`
- **包管理：** pnpm

## 快速开始

### 环境要求

- Node.js 18+
- pnpm
- Chrome 或 Edge 浏览器

### 安装依赖

```bash
pnpm install
```

### 开发构建

```bash
# 监听模式，修改代码后自动重新构建
npm run dev
```

### 加载扩展

1. 构建完成后，打开 Chrome/Edge 的扩展管理页面（`chrome://extensions` 或 `edge://extensions`）
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择项目根目录下的 `dist` 文件夹

### 配置 AI

1. 点击扩展图标打开 ReMarks
2. 进入「设置」页面
3. 选择 AI 提供商（OpenAI / DeepSeek / 自定义）
4. 填入 API Key 和模型名称
5. 点击「测试连接」验证配置

### 生产构建

```bash
npm run build
```

构建产物输出到 `dist/` 目录，可直接用于扩展加载。

## 使用示例

### 智能整理书签

1. 点击浏览器工具栏中的 ReMarks 图标
2. 点击「开始智能整理」
3. 在预览页面选择要整理的书签文件夹
4. AI 分析完成后，查看分类方案和置信度
5. 确认无误后点击「执行整理」
6. 如需撤销，点击「上次整理结果」中的撤销按钮

### 新书签推荐

安装扩展后，当您在浏览器中新增书签时，ReMarks 会自动弹出浮窗推荐分类，点击即可将书签归入建议的文件夹。

### 分类习惯预设

进入「分类习惯预设」页面，让 AI 分析您现有的书签结构，生成个性化的分类习惯档案。后续整理时 AI 会参考这些习惯，使分类结果更贴合您的偏好。

## 项目亮点

- **用户主权设计：** AI 只是建议者，所有书签移动都必须经过用户明确确认，避免误操作
- **隐私优先：** URL 默认经过 `sanitizeUrl` 去除 query 和 hash 后才发送给 AI；浏览历史数据绝不会发送给 AI；`history` 权限为可选
- **可撤销保障：** 每次整理前自动创建完整书签备份，支持一键恢复到整理前状态
- **渐进式体验：** 从预览、选择、确认到执行，每一步都可以中断，不会强制执行任何操作
- **个性化分类：** 通过习惯预设学习用户的文件夹命名偏好，让 AI 分类更贴合个人习惯
- **多种入口：** popup 弹窗、options 页面、浮窗 iframe 三种形态，适配不同使用场景

## 项目结构

```
src/
  app/
    components/    # 页面组件：Popup、Preview、Options、Report 等
    services/      # 业务逻辑：bookmarks、organizer、aiProvider、storage 等
    store/         # Zustand 全局状态
    types.ts       # 跨模块类型定义
    App.tsx        # 路由入口
  background/      # Manifest V3 service worker
  content/         # 页面注入脚本，浮窗宿主
  popup/           # popup 入口
  options/         # options 入口
  styles/          # 全局样式
scripts/           # 构建脚本
public/icons/      # 扩展图标
```

## 未来计划

- [ ] 支持更多 AI 提供商
- [ ] 批量导入/导出分类规则
- [ ] 书签去重检测
- [ ] 自动定期整理提醒
- [ ] 多语言支持

## 贡献指南

欢迎提出 Issue 和 Pull Request！

## 许可证

MIT License

## 作者

- GitHub: [@laonei](https://github.com/laonei)
