/** Image-describe settings store: directory × namespace × catalog join and the write path. */
import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import {
  ImageDescribeStore, visionProviderChoices, IMAGE_DESCRIBE_KEY_REF,
} from '../src/client/image-describe-store.ts'

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

const DIRECTORY = [
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'keyless', displayName: 'Keyless', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'keyless'], active: false },
]

const PI_AI_NAMESPACE = {
  ns: 'llm-pi-ai',
  schema: {},
  value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://openai.example/v1' } } },
  user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://openai.example/v1' } } },
  applies: 'live' as const,
  secrets: [],
  revision: 0,
}

const VISION_NAMESPACE = {
  ns: 'image-describe',
  schema: {},
  value: { enabled: true, baseURL: 'https://vision.example/v1', apiKeyEnv: 'VISION_KEY', model: 'vl' },
  user: { enabled: true, baseURL: 'https://vision.example/v1', apiKeyEnv: 'VISION_KEY', model: 'vl' },
  applies: 'live' as const,
  secrets: [],
  revision: 3,
}

function apiStub(overrides: Record<string, (payload: unknown) => RpcResponse<unknown>> = {}) {
  const calls: Array<{ method: string; payload: unknown }> = []
  const record = <T>(method: string) => async (payload: unknown): Promise<RpcResponse<T>> => {
    calls.push({ method, payload })
    return overrides[method]?.(payload) as RpcResponse<T> ?? ok({})
  }
  return {
    calls,
    api: {
      settings: {
        describe: record('settings.describe'),
        openDocument: record('settings.openDocument'),
        update: record('settings.update'),
        replace: record('settings.replace'),
        mutate: record('settings.mutate'),
      },
      credentials: { describe: record('credentials.describe'), set: record('credentials.set'), unset: record('credentials.unset') },
      llm: { providers: record('llm.providers'), models: record('llm.models'), discoverModels: record('llm.discoverModels') },
    },
  }
}

describe('visionProviderChoices', () => {
  it('projects only providers with a declared baseURL and apiKeyEnv', () => {
    expect(visionProviderChoices(DIRECTORY, PI_AI_NAMESPACE)).toEqual([
      { provider: 'openai', displayName: 'openai', baseURL: 'https://openai.example/v1', apiKeyEnv: 'OPENAI_API_KEY' },
    ])
  })

  it('returns an empty list without the pi-ai namespace', () => {
    expect(visionProviderChoices(DIRECTORY, undefined)).toEqual([])
  })
})

describe('ImageDescribeStore', () => {
  it('loads the section, providers, models, and credential state', async () => {
    const stub = apiStub({
      'settings.describe': () => ok({
        writable: true, hasDocument: true, namespaces: [VISION_NAMESPACE, PI_AI_NAMESPACE],
      }),
      'llm.providers': () => ok({ providers: DIRECTORY }),
      'llm.models': () => ok({ groups: [{ id: 'openai', name: 'openai', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] }], failures: [] }),
      'credentials.describe': () => ok({ credentials: { [IMAGE_DESCRIBE_KEY_REF]: { ref: IMAGE_DESCRIBE_KEY_REF, configured: true, writable: true } } }),
    })
    const store = new ImageDescribeStore(stub.api as never)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.section).toEqual({
      enabled: true, baseURL: 'https://vision.example/v1', apiKeyEnv: 'VISION_KEY', model: 'vl', systemPrompt: '',
    })
    expect(state.providers).toHaveLength(1)
    expect(state.providers[0]?.baseURL).toBe('https://openai.example/v1')
    expect(state.modelsByProvider.get('openai')).toEqual(['gpt-4o'])
    expect(state.credential?.configured).toBe(true)
    expect(state.revision).toBe(3)
  })

  it('reports a load failure', async () => {
    const stub = apiStub({
      'settings.describe': () => fail('boom'),
    })
    const store = new ImageDescribeStore(stub.api as never)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('boom')
  })

  it('saves the section and the standalone key through the wire', async () => {
    const stub = apiStub({
      'settings.describe': () => ok({ writable: true, hasDocument: true, namespaces: [VISION_NAMESPACE, PI_AI_NAMESPACE] }),
      'llm.providers': () => ok({ providers: DIRECTORY }),
      'llm.models': () => ok({ groups: [], failures: [] }),
      'credentials.describe': () => ok({ credentials: {} }),
      'settings.replace': () => ok({ ...VISION_NAMESPACE, revision: 4 }),
      'credentials.set': () => ok({ ref: IMAGE_DESCRIBE_KEY_REF, configured: true }),
    })
    const store = new ImageDescribeStore(stub.api as never)
    await store.load()
    const outcome = await store.save({
      enabled: true,
      baseURL: 'https://vision.example/v1',
      apiKeyEnv: IMAGE_DESCRIBE_KEY_REF,
      model: 'vl',
      systemPrompt: '',
    }, 'new-key')
    expect(outcome).toBeUndefined()
    const replace = stub.calls.find(call => call.method === 'settings.replace')
    expect(replace?.payload).toMatchObject({
      ns: 'image-describe',
      section: { enabled: true, apiKeyEnv: IMAGE_DESCRIBE_KEY_REF, model: 'vl' },
      expectedRevision: 3,
    })
    const set = stub.calls.find(call => call.method === 'credentials.set')
    expect(set?.payload).toEqual({ ref: IMAGE_DESCRIBE_KEY_REF, value: 'new-key' })
  })

  it('reports a rejected settings write and keeps the key write pending', async () => {
    const stub = apiStub({
      'settings.describe': () => ok({ writable: true, hasDocument: true, namespaces: [VISION_NAMESPACE, PI_AI_NAMESPACE] }),
      'llm.providers': () => ok({ providers: DIRECTORY }),
      'llm.models': () => ok({ groups: [], failures: [] }),
      'credentials.describe': () => ok({ credentials: {} }),
      'settings.replace': () => fail('enabled but missing baseURL'),
    })
    const store = new ImageDescribeStore(stub.api as never)
    await store.load()
    const outcome = await store.save({
      enabled: true, baseURL: '', apiKeyEnv: IMAGE_DESCRIBE_KEY_REF, model: 'vl', systemPrompt: '',
    }, 'new-key')
    expect(outcome).toBe('enabled but missing baseURL')
    expect(stub.calls.some(call => call.method === 'credentials.set')).toBe(false)
  })
})
