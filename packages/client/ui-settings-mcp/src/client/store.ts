/**
 * MCP settings page store: one snapshot joining the `mcp` settings namespace
 * (the configured servers, from `settings.describe`) with the live activation
 * statuses (`mcp.list`). The host stays the single fact source — every
 * mutation writes through the wire and the page re-renders from the next
 * describe, pushed or refetched.
 */

import type { IApiClient, McpServerView, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** The `mcp` user-settings namespace key. */
export const MCP_SETTINGS_NAMESPACE = 'mcp'

/** One configured server as it resolves in the settings namespace value. */
export interface McpServerEntryView {
  transport: 'stdio' | 'streamable-http'
  /** stdio: executable to spawn. */
  command?: string
  /** stdio: arguments passed directly. */
  args?: string[]
  /** stdio: extra env vars. */
  env?: Record<string, string>
  /** stdio: working directory. */
  cwd?: string
  /** streamable-http: endpoint URL. */
  url?: string
  /** streamable-http: extra headers. */
  headers?: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs?: number
  /** Whether the entry is mounted (false keeps it in the document only). */
  enabled?: boolean
}

/** One joined row: the configured entry plus its live activation status. */
export interface McpServerRow {
  /** The settings map key and mcp-client `serverName`. */
  serverName: string
  /** The resolved entry (schema defaults applied). */
  entry: McpServerEntryView
  /** Whether the user layer carries this entry (a removal restores nothing beneath). */
  removable: boolean
  /** Live activation status from `mcp.list`, absent while the manager reports none. */
  status: McpServerView | undefined
}

/** Page snapshot. */
export interface McpSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configured server joined with its status, in settings order. */
  rows: readonly McpServerRow[]
  /** The `mcp` namespace view (schema and revision), for the editor's writes. */
  namespace: SettingsNamespaceView | undefined
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- Editor text <-> structured value conversions ----

/** Split one argument per line, trimming blank lines (arguments may contain spaces). */
export function parseArgs(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/** Serialize args back to the editor's one-per-line text. */
export function formatArgs(args: readonly string[] | undefined): string {
  return (args ?? []).join('\n')
}

/** Parse `KEY=VALUE` lines into an env record; blank lines are skipped. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    out[trimmed.slice(0, separator)] = trimmed.slice(separator + 1)
  }
  return out
}

/** Serialize an env record back to `KEY=VALUE` lines. */
export function formatEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')
}

/** Parse `Key: Value` lines into a header record; blank lines are skipped. */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const separator = trimmed.indexOf(':')
    if (separator <= 0) continue
    out[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
  }
  return out
}

/** Serialize a header record back to `Key: Value` lines. */
export function formatHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {}).map(([key, value]) => `${key}: ${value}`).join('\n')
}

// ---- Editor draft <-> entry conversion ----

/** The editor's field state, initialized from an entry or blank. */
export interface ServerEditorDraft {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command: string
  argsText: string
  envText: string
  cwd: string
  url: string
  headersText: string
  toolCallTimeoutMs: string
  enabled: boolean
}

/** Initialize the editor draft from an entry (blank when adding). */
export function draftFrom(serverName: string | undefined, entry: McpServerEntryView | undefined): ServerEditorDraft {
  return {
    serverName: serverName ?? '',
    transport: entry?.transport ?? 'stdio',
    command: entry?.command ?? '',
    argsText: formatArgs(entry?.args),
    envText: formatEnv(entry?.env),
    cwd: entry?.cwd ?? '',
    url: entry?.url ?? '',
    headersText: formatHeaders(entry?.headers),
    toolCallTimeoutMs: entry?.toolCallTimeoutMs === undefined ? '' : String(entry.toolCallTimeoutMs),
    enabled: entry?.enabled !== false,
  }
}

/**
 * The entry a draft resolves to; `problem` names the first missing or invalid
 * field. The serverName pattern mirrors the manager's settings validation, so
 * a draft that passes here also passes the seam's section validation.
 */
export function entryFrom(draft: ServerEditorDraft): { entry: McpServerEntryView; problem: string | undefined } {
  const serverName = draft.serverName.trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    return {
      entry: {} as McpServerEntryView,
      problem: serverName === '' ? 'server name: required' : 'server name: letters, digits, - and _, at most 32 characters',
    }
  }
  const base: McpServerEntryView = {
    transport: draft.transport,
    enabled: draft.enabled,
  }
  const timeout = Number(draft.toolCallTimeoutMs)
  if (draft.toolCallTimeoutMs.trim().length > 0) {
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return { entry: {} as McpServerEntryView, problem: 'tool call timeout must be a positive number' }
    }
    base.toolCallTimeoutMs = timeout
  }
  if (draft.transport === 'stdio') {
    const command = draft.command.trim()
    if (command.length === 0) return { entry: {} as McpServerEntryView, problem: 'command is required for stdio servers' }
    const args = parseArgs(draft.argsText)
    const env = parseEnv(draft.envText)
    const cwd = draft.cwd.trim()
    return {
      entry: {
        ...base,
        command,
        ...args.length > 0 ? { args } : {},
        ...Object.keys(env).length > 0 ? { env } : {},
        ...cwd.length > 0 ? { cwd } : {},
      },
      problem: undefined,
    }
  }
  const url = draft.url.trim()
  if (url.length === 0) return { entry: {} as McpServerEntryView, problem: 'url is required for streamable-http servers' }
  const headers = parseHeaders(draft.headersText)
  return {
    entry: {
      ...base,
      url,
      ...Object.keys(headers).length > 0 ? { headers } : {},
    },
    problem: undefined,
  }
}

/**
 * The MCP settings page controller (one per settings surface).
 */
export class McpSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<McpSettingsState> = createSnapshotStore<McpSettingsState>({
    status: 'idle', error: null, writable: false, rows: [], namespace: undefined,
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (settings and mcp domains).
   */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'mcp'>) {}

  /**
   * Refresh the whole page snapshot: the `mcp` namespace and the live statuses
   * in parallel. A failure keeps the last good rows and surfaces the error.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let writable: boolean
    let namespace: SettingsNamespaceView | undefined
    let statuses: McpServerView[]
    try {
      const [settingsResponse, mcpResponse] = await Promise.all([
        this.api.settings.describe({}),
        this.api.mcp.list({}),
      ])
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      if (!mcpResponse.result.ok) throw new Error(mcpResponse.result.error.message)
      writable = settingsResponse.result.value.writable
      namespace = settingsResponse.result.value.namespaces.find(ns => ns.ns === MCP_SETTINGS_NAMESPACE)
      statuses = mcpResponse.result.value.servers
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.writable = writable
      s.namespace = namespace
      const value = namespace?.value as { servers?: Record<string, McpServerEntryView> } | undefined
      const user = namespace?.user as { servers?: Record<string, unknown> } | undefined
      const servers = value?.servers ?? {}
      s.rows = Object.entries(servers).map(([serverName, entry]) => ({
        serverName,
        entry,
        removable: user?.servers !== undefined && Object.hasOwn(user.servers, serverName),
        status: statuses.find(status => status.serverName === serverName),
      }))
    })
  }
}
