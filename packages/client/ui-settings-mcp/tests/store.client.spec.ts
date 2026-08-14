/**
 * MCP settings page store: namespace × status join with last-good rows on
 * failure, plus the editor text <-> structured value conversions.
 */
import { describe, expect, it } from 'vitest'
import type { McpServerView, RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  McpSettingsStore, entryFrom, formatArgs, formatEnv, formatHeaders,
  parseArgs, parseEnv, parseHeaders,
} from '../src/client/store.ts'

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
      github: { transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], enabled: true, toolCallTimeoutMs: 60_000 },
      web: { transport: 'streamable-http', url: 'http://localhost:3000/mcp', enabled: true, toolCallTimeoutMs: 60_000 },
      hidden: { transport: 'stdio', command: 'echo', enabled: false, toolCallTimeoutMs: 60_000 },
    },
  },
  user: { servers: { github: { transport: 'stdio', command: 'npx' } } },
  applies: 'live' as const,
  secrets: [],
  revision: 0,
}

function api(overrides: {
  describeSettings?: () => Promise<RpcResponse<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }>>
  listMcp?: () => Promise<RpcResponse<{ servers: McpServerView[] }>>
} = {}) {
  const face = {
    settings: {
      describe: overrides.describeSettings ?? (() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [NAMESPACE] }))),
      update: () => Promise.resolve(fail('unused') as RpcResponse<SettingsNamespaceView>),
      replace: () => Promise.resolve(fail('unused') as RpcResponse<SettingsNamespaceView>),
      mutate: () => Promise.resolve(fail('unused') as RpcResponse<SettingsNamespaceView>),
      openDocument: () => Promise.resolve(ok({ opened: true as const })),
    },
    mcp: {
      list: overrides.listMcp ?? (() => Promise.resolve(ok({ servers: [{ serverName: 'github', status: 'running' }] }))),
    },
  }
  return { face, api: face }
}

describe('McpSettingsStore', () => {
  it('joins the mcp namespace with the live statuses', async () => {
    const store = new McpSettingsStore(api().api)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.rows.map(row => row.serverName)).toEqual(['github', 'web', 'hidden'])
    expect(state.rows[0]?.status?.status).toBe('running')
    expect(state.rows[1]?.status).toBeUndefined()
    expect(state.rows[0]?.removable).toBe(true)
    expect(state.rows[1]?.removable).toBe(false)
  })

  it('keeps the last good rows and surfaces the error on load failure', async () => {
    const store = new McpSettingsStore(api({
      describeSettings: () => Promise.resolve(fail('boom')),
    }).api)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('boom')
    expect(state.rows).toEqual([])
  })

  it('tolerates a missing mcp namespace (manager absent)', async () => {
    const store = new McpSettingsStore(api({
      describeSettings: () => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [] })),
    }).api)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.namespace).toBeUndefined()
    expect(state.rows).toEqual([])
  })

  it('marks a disabled server as present but not mounted', async () => {
    const store = new McpSettingsStore(api().api)
    await store.load()
    const state = store.store.getSnapshot()
    const hidden = state.rows.find(row => row.serverName === 'hidden')
    expect(hidden?.entry.enabled).toBe(false)
    expect(hidden?.status).toBeUndefined()
  })
})

describe('editor text conversions', () => {
  it('parses one argument per line and round-trips', () => {
    expect(parseArgs('  -y\nserver-github\n\n')).toEqual(['-y', 'server-github'])
    expect(formatArgs(['-y', 'server-github'])).toBe('-y\nserver-github')
    expect(formatArgs(undefined)).toBe('')
  })

  it('parses KEY=VALUE env lines and round-trips', () => {
    expect(parseEnv('A=1\nB=two words\n\ninvalid-line')).toEqual({ A: '1', B: 'two words' })
    expect(formatEnv({ A: '1' })).toBe('A=1')
    expect(formatEnv(undefined)).toBe('')
  })

  it('parses Key: Value header lines and round-trips', () => {
    expect(parseHeaders('Authorization: Bearer x\n\nX-Test: 1')).toEqual({ Authorization: 'Bearer x', 'X-Test': '1' })
    expect(formatHeaders({ Authorization: 'Bearer x' })).toBe('Authorization: Bearer x')
    expect(formatHeaders(undefined)).toBe('')
  })
})

describe('entryFrom', () => {
  it('builds a stdio entry from a draft', () => {
    const { entry, problem } = entryFrom({
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      argsText: '-y\nserver-github',
      envText: 'TOKEN=abc',
      cwd: '/work',
      url: '',
      headersText: '',
      toolCallTimeoutMs: '60000',
      enabled: true,
    })
    expect(problem).toBeUndefined()
    expect(entry).toEqual({
      transport: 'stdio',
      enabled: true,
      toolCallTimeoutMs: 60_000,
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { TOKEN: 'abc' },
      cwd: '/work',
    })
  })

  it('builds a streamable-http entry from a draft', () => {
    const { entry, problem } = entryFrom({
      serverName: 'web',
      transport: 'streamable-http',
      command: '',
      argsText: '',
      envText: '',
      cwd: '',
      url: 'http://localhost:3000/mcp',
      headersText: 'Authorization: Bearer x',
      toolCallTimeoutMs: '',
      enabled: true,
    })
    expect(problem).toBeUndefined()
    expect(entry).toEqual({
      transport: 'streamable-http',
      enabled: true,
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer x' },
    })
  })

  it('rejects a missing serverName', () => {
    const { problem } = entryFrom({
      serverName: '  ', transport: 'stdio', command: 'echo', argsText: '', envText: '',
      cwd: '', url: '', headersText: '', toolCallTimeoutMs: '', enabled: true,
    })
    expect(problem).toMatch(/server name: required/)
  })

  it('rejects an invalid serverName', () => {
    const { problem } = entryFrom({
      serverName: 'bad name!', transport: 'stdio', command: 'echo', argsText: '', envText: '',
      cwd: '', url: '', headersText: '', toolCallTimeoutMs: '', enabled: true,
    })
    expect(problem).toMatch(/at most 32 characters/)
  })

  it('rejects a stdio draft without a command', () => {
    const { problem } = entryFrom({
      serverName: 'srv', transport: 'stdio', command: '', argsText: '', envText: '',
      cwd: '', url: '', headersText: '', toolCallTimeoutMs: '', enabled: true,
    })
    expect(problem).toMatch(/command is required/)
  })

  it('rejects a streamable-http draft without a url', () => {
    const { problem } = entryFrom({
      serverName: 'srv', transport: 'streamable-http', command: '', argsText: '', envText: '',
      cwd: '', url: '', headersText: '', toolCallTimeoutMs: '', enabled: true,
    })
    expect(problem).toMatch(/url is required/)
  })

  it('rejects a non-positive timeout', () => {
    const { problem } = entryFrom({
      serverName: 'srv', transport: 'stdio', command: 'echo', argsText: '', envText: '',
      cwd: '', url: '', headersText: '', toolCallTimeoutMs: '-5', enabled: true,
    })
    expect(problem).toMatch(/timeout must be a positive number/)
  })
})
