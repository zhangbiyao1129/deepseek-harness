# @deepseek-ai/dsh-client-ui-settings-mcp

English | [中文](README.zh.md)

MCP settings page plugin. Registers the MCP section on the Settings page (after the Models page), where the user configures external MCP servers in the `mcp` user-settings namespace and sees each server's activation status.

The page joins two wire domains into one snapshot: `settings.describe` (the `mcp` namespace's resolved value — the configured servers, with schema defaults applied) and `mcp.list` (the manager's per-server activation status). Each configured server renders as one card row showing its name, transport, enabled state, and a status dot (`Connected`, `Connecting…`, or `Failed to connect` with the failure text). Editing expands the row's editor card; the add flow opens the same card blank; deletion requires a confirmation dialog naming the server.

The editor is one hand-written card for both transports: a locked server-name field on existing rows (renaming is atomic — a single `settings.mutate` unsets the old key and sets the new one), the transport select, the stdio fields (`command`, one argument per line, `KEY=VALUE` env lines, `cwd`) or the HTTP fields (`url`, `Key: Value` header lines), the tool-call timeout, and an enabled toggle. Every save validates locally (server-name pattern, required transport fields, positive timeout) and then lands as `settings.mutate` path ops, so the settings seam's own section validation is the second gate and a rejected write names the exact problem. The page never restates fields it did not touch: only the edited server's key is set or unset.

Once loaded, the page subscribes to forwarded `settings/document-updated` events plus local `connection/reset`, so an external `settings.yaml` edit or a second tab converges without polling.

## Model Experience

None, as the section renders a browser configuration UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No per-server pause or test button** — the only on/off switch is the enabled toggle (keeps the entry in the document, disconnects it), and connection health beyond the activation status is left to the manager's logs.
- **Reconnect states are not pushed** — the status dot reflects the last page load; a server that drops after loading keeps its `Connected` dot until the next refresh, because `mcp/synced` is not forwarded to the browser.
- **Headers and env are free-form text** — the editor parses `Key: Value` / `KEY=VALUE` lines; a line without a separator is silently skipped rather than refused.
