/**
 * Image-description module behavior: settings validation, live settings
 * resolution, and the direct vision call over a mocked fetch.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  assertServiceableImageDescribe, describeImage, ImageDescribeError,
  IMAGE_DESCRIBE_SETTINGS_NAMESPACE, IMAGE_DESCRIBE_SETTINGS_SCHEMA,
  imageDescribeSettingsOf, installImageDescribeSettings,
} from '../src/image-describe.ts'

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

/** A Context with a memory settings provider and the namespace registered. */
async function settingsHarness(section?: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, { doc: section === undefined ? {} : { 'image-describe': section } })
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(IMAGE_DESCRIBE_SETTINGS_NAMESPACE, IMAGE_DESCRIBE_SETTINGS_SCHEMA, {})
  })
  return ctx
}

describe('assertServiceableImageDescribe', () => {
  it('accepts an unset or disabled section', () => {
    expect(() => { assertServiceableImageDescribe({}) }).not.toThrow()
    expect(() => { assertServiceableImageDescribe({ enabled: false }) }).not.toThrow()
  })

  it('rejects an enabled section missing any required field', () => {
    expect(() => { assertServiceableImageDescribe({ enabled: true }) }).toThrow(/baseURL/)
    expect(() => { assertServiceableImageDescribe({ enabled: true, baseURL: 'https://x' }) }).toThrow(/apiKeyEnv/)
    expect(() => {
      assertServiceableImageDescribe({ enabled: true, baseURL: 'https://x', apiKeyEnv: 'VISION_KEY' })
    }).toThrow(/model/)
  })

  it('rejects a non-http baseURL', () => {
    expect(() => {
      assertServiceableImageDescribe({ enabled: true, baseURL: 'ftp://x', apiKeyEnv: 'K', model: 'm' })
    }).toThrow(/http/)
    expect(() => {
      assertServiceableImageDescribe({ enabled: true, baseURL: 'https://x', apiKeyEnv: 'K', model: 'm' })
    }).not.toThrow()
  })
})

describe('imageDescribeSettingsOf', () => {
  it('falls back when no settings seam is mounted', async () => {
    const ctx = new Context()
    expect(imageDescribeSettingsOf(ctx)).toEqual({})
    expect(imageDescribeSettingsOf(ctx, { enabled: true })).toEqual({ enabled: true })
  })

  it('reads the registered namespace live', async () => {
    const ctx = await settingsHarness({
      enabled: true, baseURL: 'https://vision', apiKeyEnv: 'VISION_KEY', model: 'vl',
    })
    expect(imageDescribeSettingsOf(ctx)).toEqual({
      enabled: true, baseURL: 'https://vision', apiKeyEnv: 'VISION_KEY', model: 'vl',
    })
  })
})

describe('installImageDescribeSettings', () => {
  it('registers the namespace and validates writes', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    installImageDescribeSettings(ctx)
    // The registration rides ctx.inject(['settings']), which settles after the
    // current tick; wait for it before asserting.
    await vi.waitFor(() => {
      expect(ctx.get('settings')?.get(IMAGE_DESCRIBE_SETTINGS_NAMESPACE)).toEqual({})
    })
    await expect(
      ctx.get('settings')?.update(IMAGE_DESCRIBE_SETTINGS_NAMESPACE, { enabled: true }),
    ).rejects.toThrow(/baseURL/)
    await expect(
      ctx.get('settings')?.update(IMAGE_DESCRIBE_SETTINGS_NAMESPACE, {
        enabled: true, baseURL: 'https://vision', apiKeyEnv: 'VISION_KEY', model: 'vl',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('describeImage', () => {
  const SECTION = {
    enabled: true, baseURL: 'https://vision.example/v1', apiKeyEnv: 'VISION_KEY', model: 'vl-model',
  }

  it('sends the image as a data URL with attribution headers and returns the description', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '一只橘猫' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    process.env.VISION_KEY = 'secret'
    try {
      const result = await describeImage(new Context(), SECTION, new Uint8Array([1, 2, 3]), 'image/png')
      expect(result).toBe('一只橘猫')
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://vision.example/v1/chat/completions')
      expect(init.method).toBe('POST')
      const headers = init.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer secret')
      expect(typeof headers['user-agent']).toBe('string')
      const body = JSON.parse(init.body as string) as {
        model: string
        messages: Array<{ content: Array<{ image_url: { url: string } }> }>
      }
      expect(body.model).toBe('vl-model')
      expect(body.messages[1]?.content[0]?.image_url?.url).toBe('data:image/png;base64,AQID')
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
    }
  })

  it('rejects when the vision model is not enabled', async () => {
    await expect(
      describeImage(new Context(), {}, new Uint8Array([1]), 'image/png'),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('rejects an incomplete section even when enabled', async () => {
    await expect(
      describeImage(new Context(), { enabled: true }, new Uint8Array([1]), 'image/png'),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('rejects a missing credential', async () => {
    delete process.env.VISION_KEY
    await expect(
      describeImage(new Context(), SECTION, new Uint8Array([1]), 'image/png'),
    ).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('resolves the credential through the credentials seam', async () => {
    const ctx = new Context()
    ctx.provide('credentials', {
      resolve: vi.fn(async () => ({ value: 'seam-secret', source: 'test' })),
    } as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    )
    try {
      const result = await describeImage(ctx, SECTION, new Uint8Array([1]), 'image/png')
      expect(result).toBe('ok')
      const headers = (fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer seam-secret')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('maps an HTTP error status to HTTP_ERROR without echoing the secret', async () => {
    process.env.VISION_KEY = 'secret'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }))
    try {
      const failure = await describeImage(new Context(), SECTION, new Uint8Array([1]), 'image/png')
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ImageDescribeError)
      expect((failure as ImageDescribeError).code).toBe('HTTP_ERROR')
      expect((failure as ImageDescribeError).message).not.toContain('secret')
      expect((failure as ImageDescribeError).message).toContain('401')
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
    }
  })

  it('reads at most a bounded error body on an HTTP failure', async () => {
    process.env.VISION_KEY = 'secret'
    const huge = 'x'.repeat(1024 * 1024)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(huge, { status: 500 }))
    try {
      const failure = await describeImage(new Context(), SECTION, new Uint8Array([1]), 'image/png')
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ImageDescribeError)
      // The message carries a bounded slice of the error body, never the whole payload.
      expect((failure as ImageDescribeError).message.length).toBeLessThan(1024)
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
    }
  })

  it('maps a network rejection to NETWORK_ERROR', async () => {
    process.env.VISION_KEY = 'secret'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    try {
      await expect(
        describeImage(new Context(), SECTION, new Uint8Array([1]), 'image/png'),
      ).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
    }
  })

  it('maps an empty response to EMPTY_RESPONSE', async () => {
    process.env.VISION_KEY = 'secret'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 }),
    )
    try {
      await expect(
        describeImage(new Context(), SECTION, new Uint8Array([1]), 'image/png'),
      ).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
    }
  })

  it('times out when the vision endpoint stalls', async () => {
    process.env.VISION_KEY = 'secret'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
        reject(new Error('AbortError'))
      })
    }))
    try {
      await expect(
        describeImage(new Context(), { ...SECTION, timeoutMs: 20 }, new Uint8Array([1]), 'image/png'),
      ).rejects.toMatchObject({ code: 'TIMEOUT' })
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
    }
  })

  it('honors a caller abort signal', async () => {
    process.env.VISION_KEY = 'secret'
    const controller = new AbortController()
    controller.abort()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(
        describeImage(new Context(), SECTION, new Uint8Array([1]), 'image/png', { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
    }
  })

  it('normalizes a baseURL that already ends in chat/completions', async () => {
    process.env.VISION_KEY = 'secret'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    )
    try {
      await describeImage(
        new Context(),
        { ...SECTION, baseURL: 'https://vision.example/v1/chat/completions' },
        new Uint8Array([1]),
        'image/png',
      )
      const url = (fetchSpy.mock.calls[0] as [string, RequestInit])[0]
      expect(url).toBe('https://vision.example/v1/chat/completions')
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
    }
  })

  it('caps an oversized response body', async () => {
    process.env.VISION_KEY = 'secret'
    const huge = JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5 * 1024 * 1024) } }] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(huge, { status: 200, headers: { 'content-length': String(huge.length) } }),
    )
    try {
      await expect(
        describeImage(new Context(), SECTION, new Uint8Array([1]), 'image/png'),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    } finally {
      delete process.env.VISION_KEY
      fetchSpy.mockRestore()
    }
  })
})

// The module imports SettingsProvider only for the MemorySettings plugin type
// (the fixture lives in dsh-settings/tests); keep the type edge honest.
void SettingsProvider
