# @deepseek-ai/dsh-mcp-manager

English | [中文](README.zh.md)

MCP server manager plugin: reads the user-settings `mcp:` section and keeps one [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.md) instance per configured server in sync with it. Adding, removing, renaming, disabling, or reconfiguring a server reconciles the mounted instances in place — no restart, no `cordis.yml` edits.

## Usage

Mount the manager in the host composition (the `dsh-base` bundle already does) and configure servers in the settings document:

```yaml
# ~/.dsh/settings.yaml
mcp:
  servers:
    github:
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env:
        GITHUB_TOKEN: ghp_xxx
    memory:
      transport: streamable-http
      url: http://localhost:3000/mcp
      headers:
        Authorization: Bearer xxx
```

Each enabled entry mounts as its own mcp-client instance with `serverName` taken from the map key; the model sees every configured server's tools as native tools (`mcp__<serverName>__<rawName>`). A settings edit — through the web MCP page, the settings document, or any settings write — reconciles the mounted set without a restart.

Dormant posture: with an empty section (or no settings service mounted) zero mcp-client instances mount and nothing registers on `ctx.tools`. The manager only publishes its `mcpManager` status service, which the web MCP page reads.

## Config

| Field | Transport | Description |
|---|---|---|
| `transport` | both | `"stdio"` or `"streamable-http"` |
| `command` | stdio | Executable to spawn (required) |
| `args` | stdio | Arguments passed directly, one per array entry |
| `env` | stdio | Extra env vars merged on top of scrubbed ambient env |
| `cwd` | stdio | Working directory for the child process |
| `url` | http | MCP endpoint URL (required) |
| `headers` | http | Extra headers attached to MCP requests |
| `toolCallTimeoutMs` | both | Per-tool-call timeout (default `60000`) |
| `failOnStartupError` | both | Reject the instance when the initial connection or tool synchronization fails (default `false`) |
| `reconnect` | both | Automatic reconnect policy, as in mcp-client (defaults apply) |
| `enabled` | both | When `false` the entry stays in the document but is never mounted (default `true`) |

The map key is the `serverName`: `[A-Za-z0-9_-]{1,32}`, unique across the section. A stdio entry declaring `url` (or an HTTP entry missing `url`) is refused at the settings write; the settings seam validates the whole section before anything persists.

## Status service

The manager provides `ctx.mcpManager` (read-only, process-local): `list()` returns one `{ serverName, status, error? }` entry per enabled server, where `status` is `pending` (initial connection + tool sync running), `running` (the client instance activated), or `error` (activation failed, with the failure text). After every reconcile the manager emits `mcp/synced` with the same snapshot; the web MCP page reads the snapshot through the `mcp.list` API.

## Model Experience

### Mounted MCP tools

#### What the model sees

Each enabled server's tools appear as native tools named `mcp__<serverName>__<rawName>` (or their deterministic normalized forms), with the server-provided descriptions and input schemas — exactly what a directly-composed mcp-client row would register, because each entry mounts the real mcp-client plugin. A section edit re-mounts changed servers in place; tools from removed or disabled servers unregister, and a server that fails to activate exposes no tools.

#### Token effect

Data-dependent schema cost is paid on every request while a server's tools are registered, and the server-qualified name adds tokens to every tool definition and call — the same accounting as the mcp-client bridge ([README](../mcp-client/README.md)).

#### KV Cache effect

Prefix-stable while the mounted server set is unchanged. Re-mounting a changed server replaces its tool definitions and may invalidate reuse from the first changed schema token; a settings edit that leaves a server's entry byte-identical leaves its mounted instance untouched and the prefix stable.

## Known Limitations and Deferred Work

- A reconnected server's transient states (reconnect backoff, give-up) are not reflected in `mcpManager` status; the mcp-client reconnect loop logs them and the status stays `running` until the instance stops entirely.
- Disabled entries and removal are the only on/off switches; there is no per-server pause.
