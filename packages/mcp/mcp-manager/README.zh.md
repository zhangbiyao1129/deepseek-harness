# @deepseek-ai/dsh-mcp-manager

[English](README.md) | 中文

MCP 服务器管理器插件：读取用户设置中的 `mcp:` 段，为每个配置的服务器维护一个 [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.md) 实例并与其保持同步。添加、删除、重命名、禁用或重新配置服务器都会就地调和已挂载的实例——无需重启，也无需编辑 `cordis.yml`。

## 用法

在宿主组合中挂载管理器（`dsh-base` bundle 已包含），然后在设置文档中配置服务器：

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

每个启用的条目都作为独立的 mcp-client 实例挂载，`serverName` 取自映射键；模型可以看到每个已配置服务器的工具并作为原生工具调用（`mcp__<serverName>__<rawName>`）。任何来源的设置修改（Web MCP 页面、设置文档或任意设置写入）都会就地调和已挂载的实例，无需重启。

Dormant 姿态：段为空（或未挂载设置服务）时，零个 mcp-client 实例挂载，`ctx.tools` 上也不注册任何内容。管理器只发布自己的 `mcpManager` 状态服务，供 Web MCP 页面读取。

## 配置

| 字段 | 传输 | 说明 |
|---|---|---|
| `transport` | 两者 | `"stdio"` 或 `"streamable-http"` |
| `command` | stdio | 启动服务器的可执行文件（必填） |
| `args` | stdio | 直接传递的参数，数组每个元素一个 |
| `env` | stdio | 在清理后的环境变量之上合并的额外环境变量 |
| `cwd` | stdio | 子进程的工作目录 |
| `url` | http | MCP 端点地址（必填） |
| `headers` | http | 附加到 MCP 请求的额外请求头 |
| `toolCallTimeoutMs` | 两者 | 单次工具调用超时（默认 `60000`） |
| `failOnStartupError` | 两者 | 初始连接或工具同步失败时拒绝该实例（默认 `false`） |
| `reconnect` | 两者 | 自动重连策略，与 mcp-client 相同（采用默认值） |
| `enabled` | 两者 | 为 `false` 时条目保留在文档中但不会挂载（默认 `true`） |

映射键即 `serverName`：`[A-Za-z0-9_-]{1,32}`，在段内唯一。stdio 条目声明 `url`（或 HTTP 条目缺少 `url`）会在设置写入时被拒绝；设置接缝在持久化前校验整个段。

## 状态服务

管理器提供 `ctx.mcpManager`（只读、进程内）：`list()` 为每个启用的服务器返回一个 `{ serverName, status, error? }` 条目，其中 `status` 为 `pending`（初始连接 + 工具同步进行中）、`running`（客户端实例已激活）或 `error`（激活失败，附带失败文本）。每次调和完成后，管理器都会发出携带相同快照的 `mcp/synced` 事件；Web MCP 页面通过 `mcp.list` API 读取该快照。

## 模型体验

### 挂载的 MCP 工具

#### 模型看到什么

每个启用服务器的工具都以 `mcp__<serverName>__<rawName>`（或其确定性规范化形式）作为原生工具出现，携带服务器提供的描述和输入 schema——与直接组合 mcp-client 行注册的效果完全一致，因为每个条目挂载的都是真实的 mcp-client 插件。编辑段会就地重新挂载变更的服务器；已删除或禁用的服务器的工具会注销；激活失败的服务器不暴露任何工具。

#### Token 影响

服务器工具注册期间，每次请求都承担依赖数据的 schema 成本，服务器限定名称还会为每个工具定义和调用增加 token——与 mcp-client 桥接的核算一致（[README](../mcp-client/README.md)）。

#### KV 缓存影响

挂载的服务器集合不变时前缀稳定。重新挂载变更的服务器会替换其工具定义，并可能从第一个变更的 schema token 起使复用失效；编辑段但某服务器条目逐字节不变时，其实例保持挂载，前缀保持稳定。

## 已知限制与待办

- 重连中的瞬态（重连退避、放弃）不会反映在 `mcpManager` 状态中；mcp-client 的重连循环记录日志，在实例完全停止前状态保持 `running`。
- 禁用条目与删除是仅有的开关；没有逐服务器暂停。
