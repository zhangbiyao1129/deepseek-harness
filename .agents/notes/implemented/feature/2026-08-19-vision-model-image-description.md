# Agent Note: Vision-model image description at prompt admission

Status: implemented

English | [中文](2026-08-19-vision-model-image-description.zh.md)

## Problem

The shipped image path stores user images as durable attachments and sends `ImageBlock` content to the selected model. DeepSeek models are text-only: the adapter rejects image content, and the host refuses admission with `MODEL_DOES_NOT_SUPPORT_IMAGES` when the current model does not declare image input. A deployment whose main model is DeepSeek therefore cannot use images at all. The operator wants a configured vision model to recognize the image first, then pass only a text description to the main model — with no base64, no image URL, and no attachment reference ever stored for the DeepSeek model to see.

## Decision

A new capability in `@deepseek-ai/dsh-host-apiproxy` converts prompt images to descriptions **at admission**, before the durable user message is created:

- `src/image-describe.ts` owns the `image-describe` settings namespace (`enabled`, `baseURL`, `apiKeyEnv`, `model`, optional `systemPrompt`, `timeoutMs`, `maxTokens`) and the direct OpenAI-compatible chat-completions call. The image travels as an in-memory `data:` URL; nothing is persisted. The namespace is registered from the `ApiProxyService` constructor via `installSettingsSection`, and exposed to the Web client through `PRODUCT_SETTINGS_NAMESPACES`.
- `api-proxy.ts`'s `prompt` handler: when content contains images **and** `image-describe.enabled` is true, the model-capability gate is skipped and `describePromptContent` validates the batch with the same attachment-policy checks as the durable path (shared `validatePromptImages`), then calls the vision model once per image and builds text-only content (`图片{i}描述：…` blocks in the image's original position). The durable message therefore contains only text — no `ImageBlock`, no attachment ref, no base64, no URL — and any main model can receive it.
- A failed vision call rejects the whole prompt with `attachment-error` + reason `VISION_DESCRIBE_FAILED` and commits nothing; the Web composer restores the draft images through the existing failure flow. When the capability is not enabled, the existing `MODEL_DOES_NOT_SUPPORT_IMAGES` gate and durable `ImageBlock` path run unchanged.
- The Web settings page (`ui-settings-models`) gains a second `settings.section` entry (`image-describe`) that configures the section in two modes: reuse a registered llm-pi-ai provider (baseURL/apiKeyEnv materialized from that provider's profile) or a custom endpoint with its own API key (stored via the credentials seam under `IMAGE_DESCRIBE_API_KEY`).

## Alternatives considered

**Calling the vision model through the LLM seam (`ctx.llm`) instead of a direct HTTP call.** The pi-ai adapter requires an `ImageBlock` referencing a durable attachment and the attachment store has no delete API, so every described image would leave an orphaned object on disk — contradicting the "never store the image" requirement. A direct OpenAI-compatible call keeps the bytes in memory only; it still sends `attributionHeaders()` and resolves the key through the credentials seam.

**Converting at request-build time (an `llm/stream` listener).** The session log would still carry image content, which is exactly what the operator ruled out ("全程不存 base64、不存图片地址、只存图片说明"); admission-time conversion is the only point that keeps the durable record text-only.

**A dedicated host package for the capability.** The logic is small and apiproxy already owns prompt admission, the settings exposure allowlist, and all required dependencies; a separate package would add bundle/composition wiring without moving the enforcement boundary.

## Consequences

With the vision model configured, DeepSeek sessions accept images and store only the description text; the vision model is an auxiliary call whose input (the image bytes) is deliberately not logged per the operator's privacy requirement, while its output (the description) is durable and reconstructable. Without configuration, behavior is unchanged. The vision model's endpoint is caller-configured, so response parsing and error copy follow the OpenAI-compatible convention; a misconfigured model fails the prompt with a clear `VISION_DESCRIBE_FAILED` reason rather than corrupting the log. `read_image` tool output, subagent prompts, and pre-existing session history with `ImageBlock`s remain outside this feature's scope.
