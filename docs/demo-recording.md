# 演示录制

README 的演示通过 Playwright 操作构建后的 Chromium 扩展页面，再用 FFmpeg 合成 MP4 和精简 GIF。录制使用临时浏览器配置，不接入日常浏览器或个人书签。

## 产物

- `pic/demo.mp4`：完整操作演示，H.264 编码，无音轨。
- `pic/demo.gif`：可选的精简动图，README 不再使用。
- `pic/demo-cover.png`：视频封面。
- `output/playwright/`：原始录制、分段视频、截图与验证记录，已被 Git 忽略。

GitHub README 使用附件播放器：上传 MP4 后，将生成的 `https://github.com/user-attachments/assets/...` 地址单独放在一个段落中。更新视频后须重新上传附件并替换 README 地址；仓库内的 MP4 文件路径不能替代该地址。GitHub Markdown 渲染接口已确认当前地址生成带播放控件的 `demo.mp4` 视频播放器。

## 环境与命令

沿用项目的 Node.js 和 pnpm 环境。另需 FFmpeg，`ffmpeg` 和 `ffprobe` 均须在 PATH 中，FFmpeg 须提供 `libx264` 编码器。Playwright 作为临时录制工具使用，不写入项目依赖或 lockfile。

在仓库根目录执行：

```bash
npm run build
npm exec --yes --package=playwright@1.65.1 -- playwright install chromium
npm exec --yes --package=playwright@1.65.1 -- node scripts/record-demo.cjs
```

脚本会重新录制并覆盖上述三个 `pic/` 产物。若运行环境没有通过 npm exec 暴露 Playwright，可使用 `REMARKS_PLAYWRIGHT_MODULE` 指向独立安装的 `playwright` 包目录。

## 数据与真实性

- `scripts/demo/support.cjs` 创建 9 个公开网站的示例书签，并启动只监听 `127.0.0.1`、随机端口的固定响应服务。
- 本地响应符合扩展的 OpenAI-compatible 分类 schema，模型标识为 `demo-fixture`；占位凭据不是真实 API Key，录制不调用真实 AI Provider。
- Dribbble 的初始建议故意设为“实用工具”，用于展示将目标目录修正为“设计灵感”的操作；其他建议同样只是演示数据，不用于评估模型质量。
- 搜索、分类结果解析、审核与确认、备份、移动、报告和撤销使用扩展原有代码和真实浏览器 API。
- 页面注入鼠标指示、点击波纹与用于对齐分段的角落同步标记；同步标记在合成时移除，说明文字通过后期添加，没有为录制修改产品布局或业务代码。
- Chromium 可能请求公开网站的页面元数据与图标，录制不保证离线可用。录制生成的时间与单次请求耗时不用于性能比较。
- 剪辑会压缩等待时间。录制结束后关闭独立浏览器与本地响应服务；临时配置和原片保留在已忽略的 `output/playwright/` 中，便于检查与重新剪辑。

## 验证

脚本检查最终确认前 9 个书签仍在原目录，整理后存在备份、3 个目标目录各包含 3 个书签且没有失败项，并检查撤销后 9 个书签回到“待整理”目录、没有撤销失败项。完整视频的尺寸、时长和编码通过 `ffprobe` 读取，结果写入 `output/playwright/verification.json`。

每次录制后仍应抽查关键帧、字幕与页面的对应关系、GIF 循环和 README 相对链接。此录制展示 Chromium 扩展页面，不覆盖 Firefox、原生浏览器侧栏、工具栏交互或真实 AI 服务调用。
