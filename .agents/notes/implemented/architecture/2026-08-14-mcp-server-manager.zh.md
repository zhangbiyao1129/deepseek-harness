# Agent Note：设置驱动的 MCP 服务器管理

状态：已实现

[English](2026-08-14-mcp-server-manager.md) | 中文

> 范围：`dsh` 的运行时 MCP 能力——设置驱动的 `dsh-mcp-manager` 插件（为每个配置的服务器挂载一个 `dsh-mcp-client` 实例）、只读的 `mcp.list` wire 域、向配置客户端暴露的 `mcp` 设置命名空间，以及 Web MCP 页面（`ui-settings-mcp`）。`mcp-client` 桥接包本身未改动。

## 问题

`dsh-mcp-client` 存在但从未接线：[已交付工具清单决策](2026-07-31-even-out-shipped-tool-rosters.md) 有意将其从交付行中扣留——每个服务器的组合行必须点名一个第三方服务器并在每次启动时 spawn，而「让 MCP 成为默认的那一层」（读取用户服务器清单、按条目逐台挂载客户端的桥接）尚不存在。因此运行时完全没有 MCP 能力，Web UI 也无法添加自定义服务器，唯一路径是每个服务器编辑 `cordis.yml` 并重启。

## 决策

**采用 dormant 管理器插件，而非每个服务器一个组合行。** `dsh-mcp-manager` 遵循 `llm-pi-ai` 的 dormant-mount 模式：注册 `mcp` 用户设置命名空间（schema = `serverName` 到服务器条目的映射，镜像 mcp-client Config 减去 `serverName`），并就地调和已挂载的 mcp-client 实例与解析后的段。`installSettingsSection` 保持条目配置作为基础层、设置接缝作为权威来源；段的任何编辑（包括来自 Web 页面的编辑）都会重新挂载变更的服务器，无需重启。`serverName` 就是设置的映射键，因此条目不需要冗余的身份字段；接缝的 `validate` 钩子会在写入时拒绝跨字段错误（stdio 缺 command、HTTP 缺 url、stdio 条目声明 url）。

**挂载的实例仍然是 mcp-client 实例。** 每个启用的条目都在管理器 fiber 下通过 `ctx.plugin()` 挂载真实的 `dsh-mcp-client` 插件并注入 `serverName`，因此工具注册、重连策略和命名（`mcp__<serverName>__<rawName>`）完全由桥接包自身决定。管理器 fiber 的销毁（或删除条目）会拆除这些实例；激活失败的服务器记录 `error` 状态，其他所有服务器继续服务。

**状态走只读快照，配置走现有 settings 域。** 管理器提供 `ctx.mcpManager`（`list()`），每次调和完成后发出携带相同快照的 `mcp/synced`，并暴露一个新 wire 方法（`mcp.list`），不提供写入面——配置写入走现有 `settings.*` 方法，这些方法已带修订冲突检测和接缝校验。`mcp` 命名空间加入 `WEB_SETTINGS_NAMESPACES` 允许列表——这个显式闸门保证注册插件不会默认变得可被远程写入。

**Web 页面是一个设置分区，而非新的外壳。** `ui-settings-mcp` 注册一个 `settings.section` 条目（order 20，位于 Models 之后），渲染两个域合并的快照：来自 `settings.describe` 的 `mcp` 命名空间视图，加上来自 `mcp.list` 的状态快照。一张手写编辑器卡片服务两种传输方式，本地校验镜像管理器的段校验；保存以 `settings.mutate` 路径操作落地（重命名是单次 mutate 中的原子 unset + set）。页面遵循 Models 页面的失效接线：转发的 `settings/document-updated` 加 `connection/reset` 无需轮询即可收敛。

## 备选方案

- **每个服务器组合行**（mcp-client README 记载的用法）——作为唯一路径被拒绝：每个服务器都要编辑 `cordis.yml`、在每个 profile 挂载行、每次变更都要重启；管理器让服务器变成用户设置而非组合事实。
- **完整的 mcp CRUD wire 域**——被拒绝：`settings.*` 已经提供带冲突检测的校验后持久化写入；平行的写入面会重复接缝。
- **在测试中 mock mcp-client 模块**——基于证据被拒绝：vitest 无法拦截管理器源码对外部化 `lib/` 导入的引用，因此管理器核心把客户端插件作为可注入工厂，测试喂给它一个记录型 stub。（见本 note 的测试部分：第一次尝试的 `vi.mock` 已注册但从未命中，而 `deps.inline` 在 vitest 4 中已移除。）

## 测试

管理器的 `tests/manager.spec.ts` 用 stub 客户端工厂直接驱动 `ManagerCore`（挂载/卸载/差异/状态/错误恢复/`mcp/synced`），外加使用真实 `FileSettingsProvider` 的 dormant 设置集成测试。页面的 `store.client.spec.ts` 和 `section.client.spec.tsx` 覆盖合并、编辑器转换和 wire 写入。真实的 `settings → manager → mcp-client → tools` 链路由分支上的运行时验证覆盖。
