# Firefox 构建、测试与签名

## 本地构建与临时加载

```bash
pnpm install
npm run build:firefox
npx web-ext lint --source-dir dist-firefox
npx web-ext run --source-dir dist-firefox
```

在 `about:debugging#/runtime/this-firefox` 也可以选择“临时载入附加组件”，然后选取 `dist-firefox/manifest.json`。

当前清单要求 Firefox 140.0 或更高版本。`strict_min_version` 只控制安装兼容性，不能替代实际测试。

## 必测回归

在最低支持版本 Firefox 140 和当前稳定版各完成一次：

1. 临时加载后点击工具栏图标，确认原生侧栏、设置页、badge 和新书签推荐消息可用。
2. 检查根目录与 separator 场景；创建、移动、清理、备份和撤销不会写入系统根目录，也不会把 separator 还原为文件夹。
3. 在 AI 设置中测试连接、授予网站访问权限、显式开启 AI 数据发送，确认预览、元数据、模型列表和推荐可用。
4. 拒绝或撤销网站访问权限，确认推荐保持原位，AI 预览与链接检测给出可理解的提示，本地书签操作仍可用。
5. 启动快速和深度预览后关闭页面再返回，确认同一运行任务被恢复并且不会重复调用 AI；重复点击开始时复用活动任务。
6. 拒绝或撤销 `history` 权限，确认常访问书签关闭且核心功能仍可用。

## 签名为可安装 XPI

Firefox Release 和 Beta 安装包必须由 Mozilla 签名。先在 [AMO 开发者中心](https://addons.mozilla.org/developers/addon/api/key/) 创建 JWT 凭据，再在本机环境变量或 CI Secret 中提供：

- `AMO_API_KEY`：AMO JWT issuer；
- `AMO_API_SECRET`：AMO JWT secret。

执行：

```bash
npx web-ext sign --source-dir dist-firefox --artifacts-dir web-ext-artifacts --api-key "$AMO_API_KEY" --api-secret "$AMO_API_SECRET" --channel unlisted
```

命令返回的 `.xpi` 才是可在 Firefox Release 安装的签名包。`--channel unlisted` 适合 GitHub Release 自托管分发；要公开上架 AMO 时使用 listed 渠道并完成 AMO 审核。不要提交 API Key、API Secret、未脱敏日志或签名产物。

签名前确认 `browser_specific_settings.gecko.id` 是发布后长期不变的唯一 ID，并将本仓库的 [隐私说明](privacy-policy.md) 填入 AMO 的隐私政策链接。
