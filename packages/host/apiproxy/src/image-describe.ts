/**
 * Image-description capability: a user-configured vision model converts an
 * uploaded image into a text description before the message is committed, so
 * the session log and every downstream model request carry only the
 * description — never base64, never an image address, never an ImageBlock.
 *
 * The vision model is an OpenAI-compatible chat-completions endpoint. The
 * image travels as an in-memory data URL and is never persisted to the
 * attachment store. Settings live in the `image-describe` namespace; the
 * optional `settings` seam is read live per call, so a configuration change
 * reaches the next admission without a restart.
 *
 * @module dsh-host-apiproxy/image-describe
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace carrying the image-description model configuration. */
export const IMAGE_DESCRIBE_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('image-describe')

/** Stored and composed image-description model configuration. */
export interface ImageDescribeSettings {
  /** Master switch; absent or false leaves image admission untouched. */
  enabled?: boolean
  /** OpenAI-compatible endpoint root, e.g. `https://api.example.com/v1`. */
  baseURL?: string
  /** Credential reference (environment-variable name) resolved per call through `ctx.credentials`. */
  apiKeyEnv?: string
  /** Vision model id sent in the chat-completions request. */
  model?: string
  /** Description instruction; defaults to {@link DEFAULT_IMAGE_DESCRIBE_SYSTEM_PROMPT}. */
  systemPrompt?: string
  /** Per-call timeout in milliseconds; defaults to {@link DEFAULT_IMAGE_DESCRIBE_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Output token cap; defaults to {@link DEFAULT_IMAGE_DESCRIBE_MAX_TOKENS}. */
  maxTokens?: number
}

/** Default description instruction sent as the system prompt. */
export const DEFAULT_IMAGE_DESCRIBE_SYSTEM_PROMPT = '请用中文详细描述这张图片的内容。'

/** Default per-call timeout. */
export const DEFAULT_IMAGE_DESCRIBE_TIMEOUT_MS = 60_000

/** Default output token cap for one description. */
export const DEFAULT_IMAGE_DESCRIBE_MAX_TOKENS = 1024

/** Response body cap for one vision call, in bytes. */
const MAX_DESCRIBE_RESPONSE_BYTES = 4 * 1024 * 1024

/** Error-body detail cap for one vision call, in bytes. */
const MAX_DESCRIBE_ERROR_BODY_BYTES = 4 * 1024

/** Schema of the `image-describe` settings section. */
export const IMAGE_DESCRIBE_SETTINGS_SCHEMA: z<ImageDescribeSettings> = z.object({
  enabled: z.boolean(),
  baseURL: z.string(),
  apiKeyEnv: z.string(),
  model: z.string(),
  systemPrompt: z.string(),
  timeoutMs: z.natural(),
  maxTokens: z.natural(),
})

/**
 * Reject a section this capability could not serve. Registered as the
 * settings namespace's validator, so an unusable configuration is refused
 * where it is written — `settings.mutate` answers `settings-rejected` naming
 * the missing field — instead of being stored and then failing every image
 * admission with a generic error.
 * @param section - the resolved section to check.
 * @throws Error naming the field that must be set while enabled.
 */
export function assertServiceableImageDescribe(section: ImageDescribeSettings): void {
  if (section.enabled !== true) return
  const missing: string[] = []
  if (section.baseURL === undefined || section.baseURL.trim().length === 0) missing.push('baseURL')
  if (section.apiKeyEnv === undefined || section.apiKeyEnv.trim().length === 0) missing.push('apiKeyEnv')
  if (section.model === undefined || section.model.trim().length === 0) missing.push('model')
  if (missing.length > 0) {
    throw new Error(`image-describe: enabled but missing ${missing.join(', ')}`)
  }
  const parsed = new URL(section.baseURL as string)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('image-describe: baseURL must be an http(s) endpoint')
  }
}

/** Stable failure codes for one image-description call. */
export type ImageDescribeErrorCode =
  | 'NOT_CONFIGURED'
  | 'MISSING_CREDENTIAL'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'EMPTY_RESPONSE'
  | 'INVALID_RESPONSE'

/** One image-description failure with a stable machine-routable code. */
export class ImageDescribeError extends Error {
  constructor(
    message: string,
    readonly code: ImageDescribeErrorCode,
  ) {
    super(message)
  }
}

/** Resolve the API key for one reference through the optional credentials seam. */
async function resolveApiKey(ctx: Context, apiKeyEnv: string): Promise<string> {
  const credentials = ctx.get('credentials')
  const hit = credentials !== undefined
    ? (await credentials.resolve(credentialRef(apiKeyEnv)))?.value
    : process.env[apiKeyEnv]
  if (hit !== undefined && hit.length > 0) return hit
  throw new ImageDescribeError(
    `识图模型未配置凭证：环境变量 ${apiKeyEnv} 未设置，请在设置中填写 API Key 或导出该环境变量`,
    'MISSING_CREDENTIAL',
  )
}

/** Read the response body under a byte cap, rejecting oversized payloads. */
async function readCappedText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_DESCRIBE_RESPONSE_BYTES) {
    throw new ImageDescribeError('识图模型响应超过大小上限', 'INVALID_RESPONSE')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return response.text()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_DESCRIBE_RESPONSE_BYTES) {
      await reader.cancel()
      throw new ImageDescribeError('识图模型响应超过大小上限', 'INVALID_RESPONSE')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read at most {@link MAX_DESCRIBE_ERROR_BODY_BYTES} bytes of an error body. */
async function readErrorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_DESCRIBE_ERROR_BODY_BYTES) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Normalize one endpoint root to the chat-completions URL. */
function chatCompletionsUrl(baseURL: string): string {
  const root = baseURL.trim().replace(/\/+$/, '')
  return root.endsWith('/chat/completions') ? root : `${root}/chat/completions`
}

/**
 * Call the configured vision model with one in-memory image and return the
 * description text. The image is sent as a base64 data URL; nothing is
 * persisted.
 * @param ctx - the caller's context (settings/credentials seams read live).
 * @param section - the resolved image-describe settings.
 * @param data - the decoded image bytes.
 * @param mediaType - the image media type.
 * @param opts - optional caller cancellation.
 * @returns the trimmed description text.
 * @throws {@link ImageDescribeError} with a stable code on every failure path.
 */
export async function describeImage(
  ctx: Context,
  section: ImageDescribeSettings,
  data: Uint8Array,
  mediaType: ImageMediaType,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  if (section.enabled !== true) {
    throw new ImageDescribeError('识图模型未启用', 'NOT_CONFIGURED')
  }
  const baseURL = section.baseURL ?? ''
  const apiKeyEnv = section.apiKeyEnv ?? ''
  const model = section.model ?? ''
  if (baseURL.length === 0 || apiKeyEnv.length === 0 || model.length === 0) {
    throw new ImageDescribeError('识图模型配置不完整（baseURL/apiKeyEnv/model）', 'NOT_CONFIGURED')
  }
  const apiKey = await resolveApiKey(ctx, apiKeyEnv)

  const controller = new AbortController()
  const timeoutMs = section.timeoutMs ?? DEFAULT_IMAGE_DESCRIBE_TIMEOUT_MS
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const signal = opts?.signal === undefined
    ? controller.signal
    : AbortSignal.any([opts.signal, controller.signal])
  if (signal.aborted) {
    clearTimeout(timer)
    throw new ImageDescribeError('识图模型请求已取消', 'NETWORK_ERROR')
  }

  const base64 = Buffer.from(data).toString('base64')
  const body = {
    model,
    max_tokens: section.maxTokens ?? DEFAULT_IMAGE_DESCRIBE_MAX_TOKENS,
    messages: [
      { role: 'system', content: section.systemPrompt ?? DEFAULT_IMAGE_DESCRIBE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } }],
      },
    ],
  }

  let response: Response
  try {
    response = await fetch(chatCompletionsUrl(baseURL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ImageDescribeError(`识图模型请求超时（${timeoutMs}ms）`, 'TIMEOUT')
    }
    throw new ImageDescribeError(
      `识图模型请求失败：${error instanceof Error ? error.message : String(error)}`,
      'NETWORK_ERROR',
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const detail = await readErrorBody(response)
    throw new ImageDescribeError(
      `识图模型请求失败（HTTP ${response.status}${detail.length > 0 ? `：${detail.slice(0, 200)}` : ''}）`,
      'HTTP_ERROR',
    )
  }

  let parsed: { choices?: Array<{ message?: { content?: unknown } }> }
  try {
    parsed = JSON.parse(await readCappedText(response)) as typeof parsed
  } catch (error) {
    throw new ImageDescribeError(
      `识图模型响应解析失败：${error instanceof Error ? error.message : String(error)}`,
      'INVALID_RESPONSE',
    )
  }
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ImageDescribeError('识图模型未返回描述内容', 'EMPTY_RESPONSE')
  }
  return content.trim()
}

/**
 * Resolve the image-describe settings source: the registered namespace while
 * a settings seam is mounted, otherwise the given fallback.
 * @param ctx - the caller's context.
 * @param fallback - value used when no settings seam or namespace exists.
 * @returns the resolved section.
 */
export function imageDescribeSettingsOf(ctx: Context, fallback: ImageDescribeSettings = {}): ImageDescribeSettings {
  const settings = ctx.get('settings')
  if (settings === undefined) return fallback
  const section = settings.get(IMAGE_DESCRIBE_SETTINGS_NAMESPACE)
  return section === undefined ? fallback : (section as ImageDescribeSettings)
}

/**
 * Install the optional-settings consumer wiring for the image-describe
 * namespace: while a settings service exists, register the namespace with the
 * composition entry as the base layer and validate every write.
 * @param ctx - the owning plugin context.
 * @param entry - the composition entry config subset (image-describe fields).
 */
export function installImageDescribeSettings(ctx: Context, entry: ImageDescribeSettings = {}): void {
  installSettingsSection(ctx, IMAGE_DESCRIBE_SETTINGS_NAMESPACE, IMAGE_DESCRIBE_SETTINGS_SCHEMA, entry, {
    setSource: () => {},
    onChange: () => {},
    validate: assertServiceableImageDescribe,
  })
}
