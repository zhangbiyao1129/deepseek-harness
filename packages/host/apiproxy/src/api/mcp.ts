/**
 * mcp domain contract: the web face of the MCP server manager
 * (`ctx.mcpManager`). The read-only `mcp.list` reports the activation status
 * of every configured MCP server; configuration itself lives in the `mcp`
 * user-settings namespace and is edited through the existing `settings.*`
 * methods.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Wire view of one MCP server's activation status. */
export interface McpServerView {
  /** The settings map key and mcp-client `serverName`. */
  serverName: string
  /** `pending` while the initial connection + tool sync runs; `running` after it settles; `error` when the instance failed to activate. */
  status: 'pending' | 'running' | 'error'
  /** Activation failure text, present only in `error`. */
  error?: string
}

/** Mcp-domain unary methods (the map keys mcp.* of RpcMethodMap). */
export interface McpApi {
  /**
   * Snapshot of every configured MCP server's activation status, in settings
   * declaration order. The response is empty on a deployment that mounts no
   * mcp-manager; the client distinguishes that from a zero-server section by
   * the settings descriptor, which also carries the configurable entries.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ servers: McpServerView[] }>>
}
