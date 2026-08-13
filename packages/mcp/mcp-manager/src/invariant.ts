/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mcp-manager`.
 * @module @deepseek-ai/dsh-mcp-manager/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { deepEqualJson } from '@deepseek-ai/dsh-settings'
import { NS, type ManagerConfig } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-manager'

/** Cordis companion plugin name. */
export const name = 'mcp-manager-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the reconcile-convergence contract: after every `mcp/synced` the
 * reported status set is exactly the settings section's enabled servers —
 * nothing mounted is unconfigured and no enabled server was silently skipped.
 * The event carries the manager's own snapshot, and the section read here is
 * the seam's authoritative resolved value, so the comparison is the manager's
 * own data against its own input.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('mcp/synced', (statuses) => {
    const seen = new Set<string>()
    for (const status of statuses) {
      if (seen.has(status.serverName)) {
        fail(`mcp/synced reported server "${status.serverName}" more than once`)
      }
      seen.add(status.serverName)
    }
    const settings = ctx.get('settings')
    if (settings === undefined) return
    const section = settings.get(NS) as ManagerConfig | undefined
    if (section === undefined) return
    const configured = new Set(
      Object.entries(section.servers)
        .filter(([, entry]) => entry.enabled)
        .map(([serverName]) => serverName),
    )
    const live = new Set(statuses.map(status => status.serverName))
    if (!deepEqualJson([...configured].sort(), [...live].sort())) {
      fail(
        `mcp/synced status set ${JSON.stringify([...live].sort())} does not match the enabled settings servers `
        + JSON.stringify([...configured].sort()),
      )
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
