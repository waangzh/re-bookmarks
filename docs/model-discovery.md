# 模型列表检测

设置页的“检测可用模型”使用尚未保存的当前供应商、API Key 和 Endpoint，实时查询服务端。结果会按 Provider 类型与 Endpoint 缓存到本地，用于下次打开设置页时快速展示；缓存不包含 API Key 副本，也不会自动替换当前模型。选择模型后需重新测试连接并授权分类；列表中出现某个模型不保证它支持聊天、结构化分类或当前账号有调用额度。

## 本地缓存

- 检测成功后，模型 ID 与归属信息写入 `chrome.storage.local` 的 `remarks.modelCatalog`，有效期 24 小时。
- 缓存按 `providerType + endpoint` 匹配：切换供应商或修改 Endpoint 后不会复用旧列表。
- 重新打开设置页时，若缓存有效则直接展示，并在提示中标注“X 小时前更新”；点击“检测可用模型”会强制刷新。
- 检测失败（网络、鉴权、服务不支持列表接口）时，若存在同 Provider/Endpoint 的旧缓存，会降级展示并说明失败原因；缓存不参与 AI 分类请求，也不会写入报告或备份。

## 接口依据

以下官方页面于 2026-09-30 核验。没有明确契约的供应商仅尝试兼容接口，不能保证支持。

| 供应商 | 查询方式 | 文档与限制 |
| --- | --- | --- |
| OpenAI | 当前 API root + `GET /models`，Bearer Key，读取 `data[].id` | [List models](https://developers.openai.com/api/reference/resources/models/methods/list)，列表包含多种模型，实际聊天能力需测试 |
| DeepSeek | `GET https://api.deepseek.com/models`，Bearer Key，读取 `data[].id` | [List models](https://api-docs.deepseek.com/api/list-models)，当前公开契约未声明分页 |
| Kimi | 当前 API root + `GET /models`，Bearer Key，读取 `data[].id` | [List models](https://platform.moonshot.ai/docs/api/list-models)，当前公开契约未声明分页 |
| MiniMax | 当前 API root + `GET /models`，Bearer Key，读取 `data[].id` | [List Models](https://platform.minimax.io/docs/api-reference/models)，当前公开契约未声明分页 |
| Gemini | 官方 Google Endpoint 转为 `GET /v1beta/models`，`x-goog-api-key`；读取 `models[].name` 和 `nextPageToken` | [Models](https://ai.google.dev/api/models)，逐页获取，只保留支持 `generateContent` 的模型，去掉 `models/` 前缀；代理地址仍使用兼容 `/models` |
| 智谱 | 尝试当前 API root + `GET /models` | [HTTP 基础信息](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)确认 root 和 Bearer 鉴权；本次未找到明确公开的列表接口契约 |
| 通义千问 | 尝试当前 API root + `GET /models` | [OpenAI 兼容说明](https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope)确认兼容 root 和 Bearer 鉴权；本次未确认列表接口契约，各地域和工作空间可能不同 |
| 火山方舟 / 豆包 | 尝试当前 API root + `GET /models` | [官方文档入口](https://www.volcengine.com/docs/ark/6431)，本次未取得可核验的列表 schema；模型目录不等同于账号可调用的模型或接入点 |
| 自定义 | 当前 API root + `GET /models`，Bearer Key | 要求服务支持 OpenAI-compatible 模型列表；兼容聊天不代表兼容模型列表 |

## 失败与隐私处理

- 查询有 15 秒总超时；支持取消，切换供应商、Key 或 Endpoint 后旧结果不会显示。
- 兼容接口支持 `{data: [...]}`、`{models: [...]}` 或数组，校验模型标识、去重并排序。
- 不支持列表接口、认证失败、空结果、无效 JSON 和网络失败均显示原因，保留手动输入。
- 不用静态推荐模型冒充检测结果，不批量发送付费聊天请求探测所有模型。
- 不记录 Key；Gemini 的 Key 放在请求头中，不放在 URL；检测不发送书签或历史数据。
- Firefox 的网站权限申请由按钮点击直接触发，复用现有权限逻辑。
