# Agent Note：准入时的识图模型图片描述

状态：implemented

[English](2026-08-19-vision-model-image-description.md) | 中文

## 问题

现网图片路径把用户图片存为持久化附件，并向所选模型发送 `ImageBlock` 内容。DeepSeek 模型只支持文本：适配器拒绝图片内容，且当当前模型未声明图片输入时，主机以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝准入。因此主模型为 DeepSeek 的部署完全无法使用图片。运营者希望先由配置的识图模型识别图片，再只把文字描述交给主模型——对 DeepSeek 模型而言，绝不存储 base64、图片地址或附件引用。

## 决策

`@deepseek-ai/dsh-host-apiproxy` 中的新能力在**准入时**（持久化用户消息创建之前）把 prompt 图片转换为描述：

- `src/image-describe.ts` 拥有 `image-describe` 设置命名空间（`enabled`、`baseURL`、`apiKeyEnv`、`model`、可选 `systemPrompt`、`timeoutMs`、`maxTokens`）与直连的 OpenAI 兼容 chat-completions 调用。图片以内存中的 `data:` URL 传输，不落任何盘。命名空间经 `installSettingsSection` 在 `ApiProxyService` 构造函数中注册，并经 `PRODUCT_SETTINGS_NAMESPACES` 暴露给 Web 客户端。
- `api-proxy.ts` 的 `prompt` 处理器：当内容含图片**且** `image-describe.enabled` 为 true 时，跳过模型能力门禁，`describePromptContent` 用与持久化路径相同的附件策略校验（共享 `validatePromptImages`）校验整批，然后逐图调用识图模型，构建纯文本内容（`图片{i}描述：…` 块，位于图片的原位置）。因此持久化消息只含文本——没有 `ImageBlock`、附件引用、base64 或 URL——任何主模型都能接收。
- 识图调用失败时整条 prompt 以 `attachment-error` + reason `VISION_DESCRIBE_FAILED` 拒绝且零提交；Web composer 沿用现有失败流程恢复草稿图片。能力未启用时，现有 `MODEL_DOES_NOT_SUPPORT_IMAGES` 门禁与持久化 `ImageBlock` 路径原样运行。
- Web 设置页（`ui-settings-models`）新增第二个 `settings.section` 条目（`image-describe`），支持两种模式配置该段：复用已注册的 llm-pi-ai 提供方（baseURL/apiKeyEnv 从该提供方的 profile 物化），或自定义接口及其自有 API Key（经凭证 seam 存入 `IMAGE_DESCRIBE_API_KEY`）。

## Alternatives considered

**改经 LLM seam（`ctx.llm`）调用识图模型，而非直连 HTTP。** pi-ai 适配器要求 `ImageBlock` 引用持久化附件，而附件存储没有删除 API，因此每张被描述的图片都会在磁盘上留下孤儿对象——与「绝不存储图片」的要求相悖。直连 OpenAI 兼容调用让字节只存在于内存；它仍然发送 `attributionHeaders()`，并经凭证 seam 解析密钥。

**在请求构建期转换（`llm/stream` 监听器）。** 会话日志仍会携带图片内容，而这正是运营者排除的（「全程不存 base64、不存图片地址、只存图片说明」）；准入时转换是让持久化记录保持纯文本的唯一时点。

**为该能力单独建 host 包。** 逻辑很小，而 apiproxy 已经拥有 prompt 准入、设置暴露白名单与全部所需依赖；单独建包只会增加 bundle/组合接线，而不移动强制边界。

## 后果

配置识图模型后，DeepSeek 会话可以接收图片且只存描述文本；识图模型是一次辅助调用，其输入（图片字节）按运营者的隐私要求刻意不记录，而其输出（描述）是持久化且可重建的。未配置时行为不变。识图模型的端点由调用方配置，因此响应解析与错误文案遵循 OpenAI 兼容约定；配置错误的模型会以清晰的 `VISION_DESCRIBE_FAILED` reason 拒绝 prompt，而不是污染日志。`read_image` 工具输出、子代理 prompt 以及带 `ImageBlock` 的既有会话历史不在此功能范围内。
