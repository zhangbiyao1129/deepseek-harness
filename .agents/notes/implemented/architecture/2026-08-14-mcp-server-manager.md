# Agent Note: settings-driven MCP server management

Status: implemented

English | [中文](2026-08-14-mcp-server-manager.zh.md)

> Scope: the runtime MCP capability for `dsh` — the settings-driven `dsh-mcp-manager` plugin that mounts one `dsh-mcp-client` instance per configured server, the read-only `mcp.list` wire domain, the `mcp` settings-namespace exposure to configuration clients, and the web MCP page (`ui-settings-mcp`). The `mcp-client` bridge package itself is unchanged.

## Problem

`dsh-mcp-client` existed but was never wired: the [shipped-roster decision](2026-07-31-even-out-shipped-tool-rosters.md) deliberately withheld it from the shipped rows — a per-server composition row would have to name a third-party server and spawn it on every launch, and "the layer that would make MCP a default" (a bridge reading a user's server list and mounting one client per entry) did not exist. The runtime therefore had no MCP capability, the web UI had no way to add a custom server, and the only path was editing `cordis.yml` per server and restarting.

## Decision

**A dormant manager plugin, not a composed row per server.** `dsh-mcp-manager` follows the `llm-pi-ai` dormant-mount pattern: it registers the `mcp` user-settings namespace (schema = map of `serverName` to server entry, mirroring the mcp-client Config minus `serverName`) and reconciles mounted mcp-client instances in place against the resolved section. `installSettingsSection` keeps the entry config as the base layer and the settings seam as the authoritative source; a section edit — any source, including the web page — re-mounts changed servers without a restart. The `serverName` is the settings map key, so the entry needs no redundant identity field; the seam's `validate` hook refuses cross-field mistakes (stdio without a command, HTTP without a url, a stdio entry declaring a url) at the write.

**Mounted instances stay mcp-client instances.** Each enabled entry mounts the real `dsh-mcp-client` plugin through `ctx.plugin()` under the manager fiber with `serverName` injected, so tool registration, reconnect policy, and naming (`mcp__<serverName>__<rawName>`) are exactly the bridge's own. Disposal of the manager fiber (or a removed entry) tears the instances down; a server whose activation rejects records `error` status and every other server keeps serving.

**Status travels on a read-only snapshot, configuration on the existing settings domain.** The manager provides `ctx.mcpManager` (`list()`), emits `mcp/synced` after every reconcile with the same snapshot, and exposes one new wire method (`mcp.list`) with no write surface — configuration writes go through the existing `settings.*` methods, which already carry revision conflict detection and seam validation. The `mcp` namespace joins the `WEB_SETTINGS_NAMESPACES` allowlist, the explicit gate that keeps a registering plugin from becoming remotely writable by default.

**The web page is a settings section, not a new shell.** `ui-settings-mcp` registers a `settings.section` entry (order 20, after Models) and renders a three-domain-free join: the `mcp` namespace view from `settings.describe` plus the status snapshot from `mcp.list`. One hand-written editor card serves both transports, with local validation mirroring the manager's section validation; saves land as `settings.mutate` path ops (a rename is an atomic unset + set in one mutate). The page follows the Models page's invalidation wiring: forwarded `settings/document-updated` plus `connection/reset` converge without polling.

## Alternatives considered

- **Composed rows per server** (the mcp-client README's documented usage) — rejected as the only path: it required editing `cordis.yml` per server, mounting each row in every profile, and a restart per change; the manager makes servers user settings instead of composition facts.
- **A full mcp CRUD wire domain** — rejected: `settings.*` already provides validate-then-persist writes with conflict detection; a parallel write surface would duplicate the seam.
- **Mocking the mcp-client module in tests** — rejected on evidence: vitest cannot intercept the externalized `lib/` import from the manager's source, so the manager core takes the client plugin as an injectable factory and tests feed it a recording stub. (See the note's test section: the first attempt's `vi.mock` registered but never matched, and `deps.inline` is gone in vitest 4.)

## Testing

The manager's `tests/manager.spec.ts` drives `ManagerCore` directly with a stub client factory (mount/unmount/diff/status/error-recovery/`mcp/synced`), plus dormant settings-integration tests with a real `FileSettingsProvider`. The page's `store.client.spec.ts` and `section.client.spec.tsx` cover the join, the editor conversions, and the wire writes. The real `settings → manager → mcp-client → tools` chain is exercised by the runtime verification on the branch.
