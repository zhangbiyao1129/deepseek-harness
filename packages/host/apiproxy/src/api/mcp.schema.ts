/**
 * mcp domain zod schemas (names derived from map keys: mcpListRequestSchema /
 * mcpListValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { McpServerView } from './mcp.ts'

/** One MCP server's activation status row. */
export const mcpServerViewSchema = z.object({
  serverName: z.string().min(1),
  status: z.union([z.literal('pending'), z.literal('running'), z.literal('error')]),
  error: z.string().optional(),
}) satisfies z.ZodType<Wire<McpServerView>>

/** mcp.list request payload. */
export const mcpListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'mcp.list'>>>

/** mcp.list response value. */
export const mcpListValueSchema = z.object({
  servers: z.array(mcpServerViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'mcp.list'>>>
