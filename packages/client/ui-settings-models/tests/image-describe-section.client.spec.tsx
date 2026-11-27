// @vitest-environment jsdom
/** Image-describe section behavior over a scripted wire face: load, mode pick, save. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { ImageDescribeSection } from '../src/client/ImageDescribeSection.tsx'
import type { ImageDescribeSectionInjected } from '../src/client/ImageDescribeSection.tsx'
import { ImageDescribeStore, IMAGE_DESCRIBE_KEY_REF } from '../src/client/image-describe-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ImageDescribeSectionInjected['t'] = key => en[key]

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return {
    rpcId: `r-${nextRpc++}` as never,
    result: { ok: false, error: { code: 'settings-rejected', message, details: { ns: 'image-describe' } } },
  }
}

/** The current value of one input/select element. */
function valueOf(control: HTMLElement): string {
  return (control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value
}

const NAMESPACES = [
  {
    ns: 'image-describe',
    schema: {},
    value: { enabled: true, baseURL: 'https://vision.example/v1', apiKeyEnv: IMAGE_DESCRIBE_KEY_REF, model: 'vl' },
    user: { enabled: true, baseURL: 'https://vision.example/v1', apiKeyEnv: IMAGE_DESCRIBE_KEY_REF, model: 'vl' },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://openai.example/v1' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://openai.example/v1' } } },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

function harness(overrides: Record<string, (payload: unknown) => RpcResponse<unknown>> = {}) {
  const calls: Array<{ method: string; payload: unknown }> = []
  const record = <T,>(method: string) => async (payload: unknown): Promise<RpcResponse<T>> => {
    calls.push({ method, payload })
    return overrides[method]?.(payload) as RpcResponse<T> ?? ok({})
  }
  const api = {
    settings: {
      describe: record('settings.describe'),
      openDocument: record('settings.openDocument'),
      update: record('settings.update'),
      replace: record('settings.replace'),
      mutate: record('settings.mutate'),
    },
    credentials: { describe: record('credentials.describe'), set: record('credentials.set'), unset: record('credentials.unset') },
    llm: { providers: record('llm.providers'), models: record('llm.models'), discoverModels: record('llm.discoverModels') },
  }
  const controller = new ImageDescribeStore(api as never)
  const useSnapshot = bindSnapshotSelector(controller.store)
  const view = render(<ImageDescribeSection controller={controller} useSnapshot={useSnapshot} api={api as never} t={t} />)
  return { api, calls, controller, view }
}

function readyWire() {
  return {
    'settings.describe': () => ok({ writable: true, hasDocument: true, namespaces: NAMESPACES }),
    'llm.providers': () => ok({ providers: [{ provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true }] }),
    'llm.models': () => ok({ groups: [{ id: 'openai', name: 'openai', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] }], failures: [] }),
    'credentials.describe': () => ok({ credentials: {} }),
  }
}

describe('ImageDescribeSection', () => {
  it('loads the stored section into the form', async () => {
    const { view } = harness(readyWire())
    await waitFor(() => {
      expect(screen.getByLabelText(en.baseUrl)).toBeTruthy()
    })
    expect(valueOf(screen.getByLabelText(en.baseUrl))).toBe('https://vision.example/v1')
    expect(valueOf(screen.getByLabelText(en.model))).toBe('vl')
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    view.unmount()  })

  it('materializes baseURL from a picked provider in provider mode', async () => {
    const { view } = harness(readyWire())
    await waitFor(() => {
      expect(screen.getByLabelText(en.baseUrl)).toBeTruthy()
    })
    // Switch to provider mode; the picker offers the registered provider.
    fireEvent.change(screen.getByLabelText(en.visionMode), { target: { value: 'provider' } })
    await waitFor(() => {
      expect(screen.getByLabelText(en.provider)).toBeTruthy()
    })
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'openai' } })
    expect(valueOf(screen.getByLabelText(en.baseUrl))).toBe('https://openai.example/v1')
    view.unmount()
  })

  it('saves the section and a custom key through the wire', async () => {
    const { calls, view } = harness({
      ...readyWire(),
      'settings.update': () => ok({ ...NAMESPACES[0], revision: 1 }),
      'credentials.set': () => ok({ ref: IMAGE_DESCRIBE_KEY_REF, configured: true }),
    })
    await waitFor(() => {
      expect(screen.getByLabelText(en.baseUrl)).toBeTruthy()
    })
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'vl-max' } })
    // Custom mode exposes the key field; provider mode uses the provider's ref.
    fireEvent.change(screen.getByLabelText(en.visionMode), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'new-secret' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.apply }))
    })
    const replace = calls.find(call => call.method === 'settings.update')
    expect(replace?.payload).toMatchObject({
      ns: 'image-describe',
      patch: { enabled: true, model: 'vl-max', apiKeyEnv: IMAGE_DESCRIBE_KEY_REF },
    })
    const set = calls.find(call => call.method === 'credentials.set')
    expect(set?.payload).toEqual({ ref: IMAGE_DESCRIBE_KEY_REF, value: 'new-secret' })
    await waitFor(() => {
      expect(screen.getByText(en.visionSaved)).toBeTruthy()
    })
    view.unmount()
  })

  it('disabling the section saves enabled=false with the stored values', async () => {
    const stored = NAMESPACES[0]!
    const { calls, view } = harness({
      ...readyWire(),
      'settings.update': () => ok({ ...stored, value: { ...stored.value, enabled: false }, revision: 1 }),
    })
    await waitFor(() => {
      expect(screen.getByLabelText(en.baseUrl)).toBeTruthy()
    })
    fireEvent.click(screen.getByLabelText(en.visionEnabled))
    await waitFor(() => {
      const update = calls.find(call => call.method === 'settings.update')
      expect(update?.payload).toMatchObject({
        ns: 'image-describe',
        patch: { enabled: false, baseURL: 'https://vision.example/v1', model: 'vl' },
      })
    })
    view.unmount()
  })

  it('shows a rejected write as a failure', async () => {
    const { view } = harness({
      ...readyWire(),
      'settings.update': () => fail('enabled but missing baseURL'),
    })
    await waitFor(() => {
      expect(screen.getByLabelText(en.baseUrl)).toBeTruthy()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.apply }))
    })
    await waitFor(() => {
      expect(screen.getByText('enabled but missing baseURL')).toBeTruthy()
    })
    view.unmount()
  })
})
