// @vitest-environment jsdom
/**
 * MCP settings section component behavior over a scripted wire face: rows,
 * status dots, the add flow, editing, and the delete confirmation.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { IApiClient, RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { McpSection, saveServer, removeServer } from '../src/client/McpSection.tsx'
import type { McpSectionInjected, McpSectionProps } from '../src/client/McpSection.tsx'
import { McpSettingsStore, entryFrom, draftFrom } from '../src/client/store.ts'
import type { McpServerEntryView } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

const NAMESPACE = {
  ns: 'mcp',
  schema: {},
  value: {
    servers: {
      github: { transport: 'stdio', command: 'npx', enabled: true, toolCallTimeoutMs: 60_000 },
    },
  },
  user: { servers: { github: { transport: 'stdio', command: 'npx' } } },
  applies: 'live' as const,
  secrets: [],
  revision: 0,
}

/** A scripted wire face recording the settings mutations it receives. */
function api(overrides: {
  writable?: boolean
  namespaces?: SettingsNamespaceView[]
  statuses?: unknown[]
  mutate?: (request: { ns: string; ops: unknown[] }) => Promise<RpcResponse<unknown>>
} = {}) {
  const mutations: Array<{ ns: string; ops: unknown[] }> = []
  const face = {
    settings: {
      describe: () => Promise.resolve(ok({
        writable: overrides.writable ?? true,
        hasDocument: false,
        namespaces: overrides.namespaces ?? [NAMESPACE],
      })),
      update: () => Promise.resolve(fail('unused')),
      replace: () => Promise.resolve(fail('unused')),
      mutate: (request: { ns: string; ops: unknown[] }) => {
        mutations.push(request)
        return overrides.mutate !== undefined
          ? overrides.mutate(request)
          : Promise.resolve(ok(NAMESPACE))
      },
      openDocument: () => Promise.resolve(ok({ opened: true as const })),
    },
    mcp: {
      list: () => Promise.resolve(ok({ servers: overrides.statuses ?? [{ serverName: 'github', status: 'running' }] })),
    },
  }
  return { face, api: face as unknown as Pick<IApiClient, 'settings' | 'mcp'>, mutations }
}

const t: McpSectionInjected['t'] = key => en[key]

/** Render the section with a loaded store. */
async function renderSection(apiFace: ReturnType<typeof api>): Promise<McpSettingsStore> {
  const controller = new McpSettingsStore(apiFace.api)
  const props: McpSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api: apiFace.api,
    t,
  }
  render(<McpSection {...props} />)
  await waitFor(() => {
    expect(controller.store.getSnapshot().status).toBe('ready')
  })
  return controller
}

describe('McpSection', () => {
  it('renders the configured servers with status and transport', async () => {
    const wire = api()
    await renderSection(wire)
    expect(screen.getByText('MCP Servers')).toBeDefined()
    expect(screen.getByText('github')).toBeDefined()
    expect(screen.getByText('Connected')).toBeDefined()
    expect(screen.getByText('stdio (local command)')).toBeDefined()
  })

  it('renders the empty posture when no servers are configured', async () => {
    const wire = api({
      namespaces: [{ ...NAMESPACE, value: { servers: {} } }],
      statuses: [],
    })
    await renderSection(wire)
    expect(screen.getByText(en.noServers)).toBeDefined()
    expect(screen.getByText(en.add)).toBeDefined()
  })

  it('shows a failed server status with its error text', async () => {
    const wire = api({
      statuses: [{ serverName: 'github', status: 'error', error: 'connection refused' }],
    })
    await renderSection(wire)
    expect(screen.getByText(`${en.statusError}: connection refused`)).toBeDefined()
  })

  it('reads a read-only settings document as disabled writes', async () => {
    const wire = api({ writable: false })
    await renderSection(wire)
    expect(screen.getByText(en.readOnly)).toBeDefined()
    expect(screen.getByText(en.add).closest('button')?.hasAttribute('disabled')).toBe(true)
  })

  it('opens the add editor and saves a new server through settings.mutate', async () => {
    const wire = api()
    await renderSection(wire)
    fireEvent.click(screen.getByText(en.add))
    fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'memory' } })
    fireEvent.change(screen.getByLabelText(en.command), { target: { value: 'npx' } })
    fireEvent.change(screen.getByLabelText(en.args), { target: { value: '-y\nserver-memory' } })
    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => {
      expect(wire.mutations).toHaveLength(1)
    })
    const [mutation] = wire.mutations as [{ ns: string; ops: unknown[] }]
    expect(mutation.ns).toBe('mcp')
    expect(mutation.ops).toEqual([
      { op: 'set', path: ['servers', 'memory'], value: { transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'server-memory'] } },
    ])
  })

  it('renames a server as one atomic unset + set', async () => {
    const wire = api()
    await renderSection(wire)
    fireEvent.click(screen.getByLabelText(`${en.edit} github`))
    fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'gh' } })
    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => {
      expect(wire.mutations).toHaveLength(1)
    })
    const [mutation] = wire.mutations as [{ ns: string; ops: unknown[] }]
    expect(mutation.ops).toEqual([
      { op: 'unset', path: ['servers', 'github'] },
      { op: 'set', path: ['servers', 'gh'], value: expect.objectContaining({ transport: 'stdio', command: 'npx' }) as never },
    ])
  })

  it('shows the seam rejection inside the editor', async () => {
    const wire = api({
      mutate: () => Promise.resolve(fail('mcp-manager: server "srv" is stdio but declares a url')),
    })
    await renderSection(wire)
    fireEvent.click(screen.getByText(en.add))
    fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'srv' } })
    fireEvent.change(screen.getByLabelText(en.command), { target: { value: 'echo' } })
    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => {
      expect(screen.getByText(`${en.saveFailed}: mcp-manager: server "srv" is stdio but declares a url`)).toBeDefined()
    })
  })

  it('removes a server after confirmation', async () => {
    const wire = api()
    await renderSection(wire)
    fireEvent.click(screen.getByLabelText(`${en.remove} github`))
    expect(screen.getByText('Delete github?')).toBeDefined()
    fireEvent.click(screen.getByText('Delete github'))
    await waitFor(() => {
      expect(wire.mutations).toHaveLength(1)
    })
    expect(wire.mutations[0]?.ops).toEqual([{ op: 'unset', path: ['servers', 'github'] }])
  })
})

describe('saveServer / removeServer', () => {
  it('saveServer returns the seam failure message', async () => {
    const wire = api({ mutate: () => Promise.resolve(fail('boom')) })
    const message = await saveServer(wire.api, undefined, 'srv', { transport: 'stdio', enabled: true, command: 'echo' })
    expect(message).toBe('boom')
  })

  it('removeServer returns undefined after a successful unset', async () => {
    const wire = api()
    const controller = { load: async () => {} }
    const message = await removeServer(wire.api, controller as unknown as McpSettingsStore, 'github')
    expect(message).toBeUndefined()
    expect(wire.mutations[0]?.ops).toEqual([{ op: 'unset', path: ['servers', 'github'] }])
  })
})

describe('draftFrom', () => {
  it('initializes from an entry with formatted text fields', () => {
    const entry: McpServerEntryView = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'srv'],
      env: { TOKEN: 'abc' },
      cwd: '/work',
      toolCallTimeoutMs: 30_000,
      enabled: false,
    }
    expect(draftFrom('github', entry)).toEqual({
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      argsText: '-y\nsrv',
      envText: 'TOKEN=abc',
      cwd: '/work',
      url: '',
      headersText: '',
      toolCallTimeoutMs: '30000',
      enabled: false,
    })
  })

  it('entryFrom and draftFrom round-trip', () => {
    const draft = draftFrom(undefined, undefined)
    draft.serverName = 'srv'
    draft.command = 'echo'
    const { entry, problem } = entryFrom(draft)
    expect(problem).toBeUndefined()
    expect(draftFrom('srv', entry)).toEqual({ ...draft, serverName: 'srv' })
  })
})
