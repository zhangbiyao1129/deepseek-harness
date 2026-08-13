/**
 * MCP server manager plugin: keeps one `dsh-mcp-client` instance per server in
 * sync with the user-settings `mcp:` section. The section lists servers as a
 * map of `serverName` to entry; each enabled entry is mounted as its own
 * mcp-client plugin instance (with `serverName` injected from the map key), so
 * the model sees every configured server's tools as native tools
 * (`mcp__<serverName>__<rawName>`). A section edit — adding, removing,
 * renaming, disabling, or reconfiguring a server — reconciles the mounted
 * instances in place without a restart.
 *
 * Dormant posture: with an empty section (or no settings service at all) zero
 * mcp-client instances mount and nothing registers on `ctx.tools`; the
 * manager only publishes its own `mcpManager` status service, which the web
 * configuration page reads.
 *
 * ```yaml
 * # ~/.dsh/settings.yaml
 * mcp:
 *   servers:
 *     github:
 *       transport: stdio
 *       command: npx
 *       args: ['-y', '@modelcontextprotocol/server-github']
 *       env:
 *         GITHUB_TOKEN: ghp_xxx
 *     memory:
 *       transport: streamable-http
 *       url: http://localhost:3000/mcp
 * ```
 *
 * @module @deepseek-ai/dsh-mcp-manager
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  apply as clientApply, inject as clientInject, name as clientName,
  type Config as ClientConfig, type ReconnectConfig,
} from '@deepseek-ai/dsh-mcp-client'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager'

/**
 * Required services: none. The settings seam is optional by design — the
 * manager must stay dormant (entry config only) on a deployment that mounts
 * no settings service; `installSettingsSection` handles the optional attach.
 */
export const inject = []

/** User-settings namespace owning the `mcp:` section. */
export const NS = settingsNamespace('mcp')

/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Valid `serverName` (a settings map key), kept below the public tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

// ---- Config ----

/** Settings schema for one MCP server entry; mirrors the mcp-client Config minus `serverName`. */
export interface ServerEntry {
  /** Selects child-process stdio or Streamable HTTP transport. */
  transport: 'stdio' | 'streamable-http'
  /** Executable used to start the server (stdio; required by {@link validateSection}). */
  command?: string
  /** Arguments passed directly, without shell interpolation (stdio). */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env (stdio). */
  env: Record<string, string>
  /** Working directory for the child process (stdio). */
  cwd: string
  /** MCP endpoint URL (streamable-http; required by {@link validateSection}). */
  url?: string
  /** Additional headers attached to MCP requests (streamable-http). */
  headers: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail the instance when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy; omission uses the mcp-client defaults. */
  reconnect?: ReconnectConfig
  /** When false the entry is kept in the document but never mounted. */
  enabled: boolean
}

/** The `mcp:` section: a map of `serverName` to server entry. */
export interface ManagerConfig {
  servers: Record<string, ServerEntry>
}

const Reconnect = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().min(1).default(500),
  maxDelayMs: z.number().min(1).default(30_000),
  maxAttempts: z.number().step(1).min(1).default(10),
})

/** Server entry schema; cross-field transport constraints are judged in {@link validateSection}. */
export const ServerEntry = z.object({
  transport: z.union([z.const('stdio'), z.const('streamable-http')]).required(),
  command: z.string(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  cwd: z.string().default(''),
  url: z.string(),
  headers: z.dict(String).default({}),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: Reconnect,
  enabled: z.boolean().default(true),
}) as unknown as z<ServerEntry>

export const Config = z.object({
  servers: z.dict(ServerEntry).default({}),
}) as unknown as z<ManagerConfig>

// ---- Status ----

/** One server's live mount state, as served to configuration surfaces. */
export interface McpServerStatusView {
  /** The settings map key and mcp-client `serverName`. */
  serverName: string
  /** `pending` while the initial connection + tool sync runs; `running` after it settles; `error` when the instance failed to activate. */
  status: 'pending' | 'running' | 'error'
  /** Activation failure text, present only in `error`. */
  error?: string
}

/** One mounted mcp-client instance and the entry it was mounted from. */
interface MountedServer {
  handle: ReturnType<Context['plugin']>
  entry: ServerEntry
}

/** The client plugin shape {@link ManagerCore} mounts per server. */
export type ClientPluginFactory = () => { apply: typeof clientApply; name: string; inject: readonly string[] }

/**
 * Owns the mounted mcp-client instances for one manager fiber: reconciles the
 * set against the current settings section, tracks per-server activation
 * status, and exposes the status snapshot to the `mcpManager` service.
 */
export class ManagerCore {
  private readonly mounted = new Map<string, MountedServer>()
  private readonly statuses = new Map<string, Omit<McpServerStatusView, 'serverName'>>()

  /**
   * @param ctx - plugin context; mounted client fibers parent to it.
   * @param current - thunk returning the currently authoritative section.
   * @param client - factory for the mcp-client plugin mounted per server; injectable for tests.
   */
  constructor(
    private readonly ctx: Context,
    private readonly current: () => ManagerConfig,
    private readonly client: ClientPluginFactory = clientPlugin,
  ) {}

  /** Current status of every server this manager has mounted or attempted. */
  list(): McpServerStatusView[] {
    return [...this.statuses.entries()].map(([serverName, status]) => ({ serverName, ...status }))
  }

  /**
   * Diff the configured section against the mounted set and converge: unmount
   * removed, disabled, or reconfigured servers, then mount added or
   * reconfigured ones. Unmounts run before mounts so a reconfigured server
   * never collides with its own still-live namespace reservation.
   * @returns settlement after every mount/unmount attempt settles.
   */
  async reconcile(): Promise<void> {
    const servers = this.current().servers
    for (const [serverName, mounted] of [...this.mounted]) {
      const next = servers[serverName]
      if (next === undefined || !next.enabled || !deepEqualJson(next, mounted.entry)) {
        await this.unmount(serverName)
      }
    }
    for (const [serverName, entry] of Object.entries(servers)) {
      if (!entry.enabled) continue
      if (!this.mounted.has(serverName)) await this.mount(serverName, entry)
    }
    this.ctx.emit('mcp/synced', this.list())
  }

  /** Mount one server as its own mcp-client instance under this fiber. */
  private async mount(serverName: string, entry: ServerEntry): Promise<void> {
    this.statuses.set(serverName, { status: 'pending' })
    const handle = this.ctx.plugin(this.client(), toClientConfig(serverName, entry))
    try {
      await handle.await()
      this.statuses.set(serverName, { status: 'running' })
      this.mounted.set(serverName, { handle, entry })
    } catch (error) {
      this.statuses.set(serverName, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      // A failed fiber rolls its effects back; the explicit dispose only
      // guarantees the attempt's teardown settled before reconcile continues.
      try {
        await handle.dispose()
      } catch {
        /* v8 ignore next -- teardown of an already-rolled-back fiber has no observed failure mode */
        // Swallows only this attempt's teardown failure; the activation error above is the actionable one.
      }
    }
  }

  /** Unmount one server and drop its status record. */
  private async unmount(serverName: string): Promise<void> {
    const mounted = this.mounted.get(serverName)
    this.mounted.delete(serverName)
    this.statuses.delete(serverName)
    if (mounted !== undefined) await mounted.handle.dispose()
  }
}

/** The mcp-client function plugin as an object plugin, for `ctx.plugin()`. */
function clientPlugin(): { apply: typeof clientApply; name: string; inject: readonly string[] } {
  return { apply: clientApply, name: clientName, inject: clientInject }
}

/** Build the mcp-client config for one server, carrying only its transport's fields. */
function toClientConfig(serverName: string, entry: ServerEntry): ClientConfig {
  const base = {
    serverName,
    toolCallTimeoutMs: entry.toolCallTimeoutMs,
    failOnStartupError: entry.failOnStartupError,
    ...entry.reconnect === undefined ? {} : { reconnect: entry.reconnect },
  }
  if (entry.transport === 'stdio') {
    // validateSection has refused this branch without a command at every write.
    return { transport: 'stdio', command: entry.command as string, args: entry.args, env: entry.env, cwd: entry.cwd, ...base }
  }
  return { transport: 'streamable-http', url: entry.url as string, headers: entry.headers, ...base }
}

/**
 * Reject a resolved section the manager could not mount, for constraints the
 * schema cannot express: the map key is the serverName, and each transport
 * requires exactly its own fields. Throwing here refuses the settings write
 * that produced the value, so a misconfigured server never lands in the
 * document only to fail every reconcile.
 * @param value - the resolved section, schema-valid by construction.
 */
export function validateSection(value: ManagerConfig): void {
  for (const [serverName, entry] of Object.entries(value.servers)) {
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      throw new Error(`mcp-manager: server "${serverName}" must match ${String(SERVER_NAME_PATTERN)}`)
    }
    if (entry.transport === 'stdio') {
      if (entry.command === undefined || entry.command.length === 0) {
        throw new Error(`mcp-manager: server "${serverName}" (stdio) requires a command`)
      }
      if (entry.url !== undefined) {
        throw new Error(`mcp-manager: server "${serverName}" is stdio but declares a url; remove the url`)
      }
    } else if (entry.url === undefined || entry.url.length === 0) {
      throw new Error(`mcp-manager: server "${serverName}" (streamable-http) requires a url`)
    }
  }
}

/**
 * Status service for the web configuration page: the manager's per-server
 * activation snapshot, read-only and process-local.
 */
export class McpManagerService extends Service {
  /**
   * @param ctx - plugin context; the service registration rides this fiber.
   * @param core - the manager core owning the mounted instances.
   */
  constructor(ctx: Context, private readonly core: ManagerCore) {
    super(ctx, 'mcpManager')
  }

  /** Snapshot of every server's activation status. */
  list(): McpServerStatusView[] {
    return this.core.list()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpManager: McpManagerService
  }

  interface Events {
    /**
     * Emitted after every reconcile settles (initial mount, a settings change,
     * or a server activation failure), carrying the complete status snapshot.
     * JSON-compatible payload: the web page and the invariant companion read
     * the same authoritative view of what is mounted.
     * @param statuses - one entry per configured-and-enabled server, in mount order.
     * @mode emit
     */
    'mcp/synced'(statuses: McpServerStatusView[]): void
  }
}

// ---- Plugin apply ----

/**
 * Read the `mcp:` settings section and keep the mounted mcp-client instances
 * in sync with it. A settings change reconciles in place; with no settings
 * service the composition entry (usually empty) is the whole section.
 * @param ctx - plugin context carrying the settings seam.
 * @param config - composition entry config, the `base` layer of the section.
 */
export function apply(ctx: Context, config: ManagerConfig): void {
  let current: () => ManagerConfig = () => config
  const core = new ManagerCore(ctx, () => current())
  // Service registration rides this fiber; disposal removes it.
  new McpManagerService(ctx, core)
  installSettingsSection(ctx, NS, Config, config, {
    validate: validateSection,
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      core.reconcile().catch((error: unknown) => {
        // A reconcile failure must never take the settings watcher down: the
        // previous mounted set keeps serving and the error is logged with the
        // server context the generic settings watcher diagnostic lacks.
        ctx.logger.error('mcp-manager: keeping the previously mounted servers after a refused update')
        ctx.logger.error(error)
      })
    },
  })
}
