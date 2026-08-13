/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-settings-mcp`.
 * @module @deepseek-ai/dsh-client-ui-settings-mcp/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-mcp'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-mcp-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a nav-entry-only settings section plugin that reads
 * the `mcp` namespace and `mcp.list` through existing wire APIs and emits no
 * cordis events of its own.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
