/**
 * Tests for the mcp-manager plugin: settings-driven reconciliation of
 * mcp-client instances. The manager core mounts its client plugin through an
 * injectable factory, so tests feed it a recording stub instead of mocking
 * the mcp-client module (vitest cannot intercept the externalized lib import).
 * Reconcile completion is awaited directly, never timed.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  apply, Config, ManagerCore, validateSection,
} from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import type { ClientPluginFactory } from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import type { ManagerConfig } from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import type { Config as ClientConfig } from '@deepseek-ai/dsh-mcp-client'

// ---- Recording stub client plugin ----

interface StubInstance {
  serverName: string
  config: ClientConfig
}

/** Build a client-plugin factory whose instances record and optionally fail. */
function stubFactory(instances: StubInstance[], fail: Set<string>): ClientPluginFactory {
  return () => ({
    name: 'stub-mcp-client',
    inject: [],
    async apply(ctx: Context, config: ClientConfig): Promise<void> {
      if (fail.has(config.serverName)) throw new Error('connection refused')
      const entry = { serverName: config.serverName, config }
      instances.push(entry)
      ctx.effect(() => () => {
        const index = instances.indexOf(entry)
        if (index >= 0) instances.splice(index, 1)
      }, `stub-mcp-client(${config.serverName})`)
    },
  })
}

/** One mounted stub client's config, by serverName. */
function mountedConfig(instances: StubInstance[], serverName: string): ClientConfig | undefined {
  return instances.find(instance => instance.serverName === serverName)?.config
}

/** Resolve a settings section with the manager's schema (base + user layer). */
function resolveSection(user: Record<string, unknown> | undefined): ManagerConfig {
  const raw = user === undefined ? {} : { servers: user }
  return Config({ ...raw } as never)
}

// ---- Core harness: ManagerCore with a stub client ----

interface CoreHarness {
  ctx: Context
  core: ManagerCore
  instances: StubInstance[]
  fail: Set<string>
  /** Replace the current section and reconcile. */
  reconcile(servers: Record<string, unknown>): Promise<void>
}

function bootCore(): CoreHarness {
  const ctx = new Context()
  const instances: StubInstance[] = []
  const fail = new Set<string>()
  let current: ManagerConfig = { servers: {} }
  const core = new ManagerCore(ctx, () => current, stubFactory(instances, fail))
  return {
    ctx,
    core,
    instances,
    fail,
    // Resolve through the Config schema exactly like the settings seam does,
    // so defaults (enabled, toolCallTimeoutMs) are applied before reconcile.
    async reconcile(servers: Record<string, unknown>): Promise<void> {
      current = resolveSection(servers)
      await core.reconcile()
    },
  }
}

// ---- Tests ----

describe('mcp-manager config', () => {
  it('exports name and Config', () => {
    expect(Config).toBeDefined()
  })

  it('rejects an invalid serverName in the section', () => {
    expect(() => { validateSection({ servers: { 'bad name!': { transport: 'stdio', command: 'echo', enabled: true } } as never }) })
      .toThrow(/must match/)
  })

  it('rejects a stdio entry without a command', () => {
    expect(() => { validateSection({ servers: { srv: { transport: 'stdio', enabled: true } } as never }) })
      .toThrow(/requires a command/)
  })

  it('rejects a stdio entry that also declares a url', () => {
    expect(() => { validateSection({ servers: { srv: { transport: 'stdio', command: 'echo', url: 'http://x', enabled: true } } as never }) })
      .toThrow(/is stdio but declares a url/)
  })

  it('rejects a streamable-http entry without a url', () => {
    expect(() => { validateSection({ servers: { srv: { transport: 'streamable-http', enabled: true } } as never }) })
      .toThrow(/requires a url/)
  })

  it('accepts a valid stdio entry', () => {
    expect(() => { validateSection({ servers: { srv: { transport: 'stdio', command: 'echo', enabled: true } } as never }) })
      .not.toThrow()
  })

  it('defaults toolCallTimeoutMs and enabled', () => {
    const resolved = resolveSection({ srv: { transport: 'stdio', command: 'echo' } })
    expect(resolved.servers['srv']).toMatchObject({ toolCallTimeoutMs: 60_000, enabled: true })
  })
})

describe('mcp-manager reconciliation', () => {
  let harness: CoreHarness | undefined

  afterEach(async () => {
    await harness?.ctx.fiber.dispose()
    harness = undefined
  })

  it('mounts nothing while the section is empty (dormant)', async () => {
    harness = bootCore()
    await harness.reconcile({})
    expect(harness.instances).toHaveLength(0)
    expect(harness.core.list()).toEqual([])
  })

  it('mounts one client per enabled server with the serverName injected', async () => {
    harness = bootCore()
    await harness.reconcile({
      github: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    })
    expect(harness.instances).toHaveLength(1)
    expect(mountedConfig(harness.instances, 'github')).toMatchObject({
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    })
  })

  it('exposes running status after a successful mount', async () => {
    harness = bootCore()
    await harness.reconcile({ github: { transport: 'stdio', command: 'echo' } })
    expect(harness.core.list()).toEqual([{ serverName: 'github', status: 'running' }])
  })

  it('unmounts a removed server and drops its status', async () => {
    harness = bootCore()
    await harness.reconcile({ github: { transport: 'stdio', command: 'echo' } })
    await harness.reconcile({})
    expect(harness.instances).toHaveLength(0)
    expect(harness.core.list()).toEqual([])
  })

  it('keeps an unchanged server while another changes', async () => {
    harness = bootCore()
    await harness.reconcile({ a: { transport: 'stdio', command: 'echo a' }, b: { transport: 'stdio', command: 'echo b' } })
    await harness.reconcile({ a: { transport: 'stdio', command: 'echo a' }, b: { transport: 'stdio', command: 'echo b2' } })
    expect(harness.instances).toHaveLength(2)
    expect(mountedConfig(harness.instances, 'a')).toMatchObject({ command: 'echo a' })
    expect(mountedConfig(harness.instances, 'b')).toMatchObject({ command: 'echo b2' })
  })

  it('does not mount a disabled server and mounts it once enabled', async () => {
    harness = bootCore()
    await harness.reconcile({ srv: { transport: 'stdio', command: 'echo', enabled: false } })
    expect(harness.instances).toHaveLength(0)
    await harness.reconcile({ srv: { transport: 'stdio', command: 'echo', enabled: true } })
    expect(harness.instances).toHaveLength(1)
  })

  it('reports error status when the client activation rejects', async () => {
    harness = bootCore()
    harness.fail.add('boom')
    await harness.reconcile({ ok: { transport: 'stdio', command: 'echo' }, boom: { transport: 'stdio', command: 'echo' } })
    const statuses = harness.core.list()
    expect(statuses.find(s => s.serverName === 'ok')?.status).toBe('running')
    expect(statuses.find(s => s.serverName === 'boom')?.status).toBe('error')
    expect(statuses.find(s => s.serverName === 'boom')?.error).toMatch(/connection refused/)
  })

  it('recovers a failed server after its entry is fixed', async () => {
    harness = bootCore()
    harness.fail.add('srv')
    await harness.reconcile({ srv: { transport: 'stdio', command: 'echo' } })
    expect(harness.core.list()[0]?.status).toBe('error')
    harness.fail.delete('srv')
    // A changed entry must remount; an unchanged entry stays failed, so flip a field.
    await harness.reconcile({ srv: { transport: 'stdio', command: 'echo', failOnStartupError: true } })
    expect(harness.core.list()[0]?.status).toBe('running')
  })

  it('emits mcp/synced with the converged status snapshot', async () => {
    harness = bootCore()
    const seen: unknown[][] = []
    harness.ctx.on('mcp/synced', (...args: unknown[]) => { seen.push(args) })
    await harness.reconcile({ github: { transport: 'stdio', command: 'echo' } })
    expect(seen.length).toBeGreaterThan(0)
    const last = seen[seen.length - 1] as unknown as [{ serverName: string; status: string }]
    expect(last[0]).toEqual([{ serverName: 'github', status: 'running' }])
  })
})

describe('mcp-manager settings integration', () => {
  let ctx: Context | undefined
  let directory: string | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  it('registers the mcp namespace with the manager config schema', async () => {
    ctx = new Context()
    directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-'))
    const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(directory, 'settings.yaml'), watch: false })
    await settingsFiber
    const managerFiber = ctx.plugin({ name: 'mcp-manager', apply, Config }, { servers: {} })
    await managerFiber
    const settings = ctx.get('settings') as FileSettingsProvider
    const descriptor = settings.describe().find(d => d.ns === 'mcp')
    expect(descriptor).toBeDefined()
    expect(descriptor?.value).toEqual({ servers: {} })
  })

  it('stays dormant under an empty section and reconciles nothing', async () => {
    ctx = new Context()
    directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-'))
    const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(directory, 'settings.yaml'), watch: false })
    await settingsFiber
    const managerFiber = ctx.plugin({ name: 'mcp-manager', apply, Config }, { servers: {} })
    await managerFiber
    const settings = ctx.get('settings') as FileSettingsProvider
    // A section write with no servers converges without mounting anything.
    await settings.update(settingsNamespace('mcp'), { servers: {} })
    const manager = ctx.get('mcpManager')
    expect(manager?.list()).toEqual([])
  })
})
