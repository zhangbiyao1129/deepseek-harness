/**
 * Web prompt admission with the image-describe capability: when the vision
 * model is enabled, images convert to text descriptions before the message is
 * committed; when it is not, the existing model-capability gate and durable
 * ImageBlock path stay exactly as they were.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk, UserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'
import {
  assertServiceableImageDescribe, IMAGE_DESCRIBE_SETTINGS_NAMESPACE, IMAGE_DESCRIBE_SETTINGS_SCHEMA,
} from '../src/image-describe.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`vision-${String(nextRpc++)}`), payload }
}

/** In-memory settings provider fixture: the smallest real subclass of the Service Definition. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>
  constructor(ctx: Context, options: { doc?: Record<string, unknown> } = {}) {
    super(ctx)
    this.doc = structuredClone(options.doc ?? {})
  }
  get writable(): boolean {
    return true
  }
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
  }
}

/** A provider whose models are all text-only (the DeepSeek posture). */
class TextOnlyAdapter extends LlmAdapter {
  override providerInfo() {
    return { id: 'deepseek-official', name: 'DeepSeek' }
  }
  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat', inputModalities: ['text'] },
    ])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Admission tests never enter provider streaming.
  }
}

/** A provider whose models declare image input. */
class ImageAdapter extends LlmAdapter {
  override providerInfo() {
    return { id: 'vision-main', name: 'Vision Main' }
  }
  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider: 'vision-main', id: 'vl', name: 'VL', inputModalities: ['text', 'image'] },
    ])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Admission tests never enter provider streaming.
  }
}

async function harness(options?: {
  visionSection?: Record<string, unknown>
  mainProvider?: string
}): Promise<{
  ctx: Context
  agent: Agent
  sessionId: SessionId
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['deepseek-official'], new TextOnlyAdapter())
  ctx.llm.registerAdapter(['vision-main'], new ImageAdapter())
  await ctx.plugin(MemorySettings, {
    doc: options?.visionSection === undefined
      ? {}
      : { 'image-describe': options.visionSection },
  })
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(IMAGE_DESCRIBE_SETTINGS_NAMESPACE, IMAGE_DESCRIBE_SETTINGS_SCHEMA, {
      validate: assertServiceableImageDescribe,
    })
  })
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 4,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 4,
      maxImagePixels: 4,
      mediaTypes: ['image/png'],
    },
    validateImage: vi.fn(() => Promise.resolve()),
    saveImage: vi.fn((input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => Promise.resolve({
      attachmentId: `att-${String(input.data[0])}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    })),
  } as never)
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id }
}

const VISION_SECTION = {
  enabled: true, baseURL: 'https://vision.example/v1', apiKeyEnv: 'VISION_KEY', model: 'vl-model',
}

describe('Web prompt admission with image-describe', () => {
  it('converts images to description text when the vision model is enabled', async () => {
    const { ctx, agent, sessionId } = await harness({ visionSection: VISION_SECTION })
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '一只橘猫' } }] }), { status: 200 }),
    )
    process.env.VISION_KEY = 'secret'
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    try {
      const result = await api.sessions.prompt(request({
        sessionId,
        mode: 'queue' as const,
        content: [
          { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' },
          { type: 'text' as const, text: '这是什么？' },
        ],
      }))
      expect(result.result.ok).toBe(true)
      const message = followup.mock.calls[0]?.[0] as UserMessage
      expect(message.content).toEqual([
        { type: 'text', text: '图片1描述：一只橘猫' },
        { type: 'text', text: '这是什么？' },
      ])
      // The vision model was called with the in-memory bytes; the attachment
      // store never saw the image.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.body as string) as {
        messages: Array<{ content: Array<{ image_url: { url: string } }> }>
      }
      expect(body.messages[1]?.content[0]?.image_url?.url).toBe('data:image/png;base64,AQ==')
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('describes each image in order and rejects the whole prompt when one fails', async () => {
    const { ctx, agent, sessionId } = await harness({ visionSection: VISION_SECTION })
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '第一张' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
    process.env.VISION_KEY = 'secret'
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    try {
      const result = await api.sessions.prompt(request({
        sessionId,
        mode: 'queue' as const,
        content: [
          { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' },
          { type: 'image' as const, mediaType: 'image/png' as const, data: 'Ag==' },
        ],
      }))
      expect(result.result).toMatchObject({
        ok: false,
        error: { code: 'attachment-error', details: { reason: 'VISION_DESCRIBE_FAILED' } },
      })
      // Nothing was committed: the agent never received a message.
      expect(followup).not.toHaveBeenCalled()
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('keeps the existing text-only rejection when the vision model is not configured', async () => {
    const { ctx, agent, sessionId } = await harness()
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' }],
    }))
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
    })
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('keeps the durable ImageBlock path for an image-capable model when vision is not configured', async () => {
    const { ctx, agent, sessionId } = await harness()
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'vision-main', model: 'vl' }),
      cwd: '/tmp',
    })
    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' }],
    }))
    expect(result.result.ok).toBe(true)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([
      {
        type: 'image',
        attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      },
    ])
    await ctx.fiber.dispose()
  })

  it('still enforces image limits before the vision call', async () => {
    const { ctx, agent, sessionId } = await harness({ visionSection: VISION_SECTION })
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' },
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'Ag==' },
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'Aw==' },
      ],
    }))
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'TOO_MANY_IMAGES' } },
    })
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
