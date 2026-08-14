# Agent Note：持久等待的诊断信息与未被观察的插件就绪

状态：已实现

[English](2026-08-14-load-sensitive-wait-diagnostics.md) | 中文

> 范围：两个在全量负载下表现为 flaky 的测试基础设施缺陷——快照 harness 的 `waitFor*` 诊断信息，以及不变量 setup 的插件就绪包装。真实文件 watcher 套件的负载敏感性在此登记为已知缺口，未修复。

## 问题

两处失败看着像 flaky，其实不是。

`packages/test-support/acp-snapshot` 的每个持久等待都建在 `vi.waitFor` 上，描述性原因从被轮询的回调内部抛出。当截止时刻先于一次尝试完成到来时，`vi.waitFor` 报的是它自己的 `Timed out in waitFor!`，而该回调要从磁盘读会话日志。于是场景步骤传入较短的 `timeoutMs` 时——已检入的用例是 `waitForEventAfterTurnEnd` 配 `timeoutMs: 20`——只要首次尝试在到期时仍在 IO 中，harness 的原因就丢了。负向路径测试断言的正是那句原因，因此它失败于与其覆盖内容无关的原因；而任何调试真实超时的场景作者，拿到的文本既不含会话也不含所等待的记录。

`scripts/test-invariants.ts` 包装 `RegistryService.plugin`，返回一个 thenable，其 `then` 绑定到一个新建的就绪 promise。产品代码也可以改用 `handle.await()` 汇入原始 fiber——这是既有的另一种写法，有十处在用，包括 `mcp-manager` 的 `ManagerCore.mount` 和 `agent-presets` 的常驻挂载。此时没有任何人观察包装器的 promise，因此激活被拒的插件会产生未处理的 rejection：`mcp-manager` 的套件报告全部测试通过外加一个 error，而 Vitest 明确警告此类 error 可能使结果失真。

## 决策

**一个 `waitForDurable` helper 承担所有持久等待，到期必然携带调用方的诊断信息。** 该 helper 轮询 `settled: () => Promise<boolean>` 谓词，并把任何到期转换为 `diagnostic()`，于是原因不再取决于哪个截止时刻赢得竞争。全部八个等待点——轮次开始/结束、子轮次结束、目标阶段、收件箱消息、标题、指定类型事件、工作区文件——改为传入谓词与消息构造器，不再各自重复 `vi.waitFor` 的选项。`waitForPersistedTurnStart` 保留它自己的畸形记录捕获：解析失败会结束等待并重抛，因为重试只能再读到同一条记录。

**就绪包装把自己的 promise 标记为已观察。** `joinInvariantStartup` 给就绪链挂一个空 `catch`，同时 `joined.then` 仍委托给它，于是 await 包装器的调用方收到完全相同的 rejection，而 await 原始 fiber 的调用方不再留下未处理的 rejection。产品代码两种汇入写法都保持不变。

## 影响

快照场景可以断言超时原因，真实超时会点名会话与记录。代价是等待点与其 `vi.waitFor` 调用之间多了一层间接，且 `settled` 谓词必须以返回 `false` 表示"不存在"而非抛出——抛出的谓词会被重试并最终报为到期，这对瞬时读失败是正确的、对永久失败是错误的，所以畸形记录那一处显式自行处理。

把就绪链标记为已观察，意味着未被 await 的包装器不再在任何地方浮出它的 rejection。今天没有任何损失：rejection 会送达 await 包装器的一方，而使用 `handle.await()` 的产品代码已在各自调用点处理激活失败。将来若有测试依赖"未被 await 的挂载会浮出全局未处理 rejection"，它需要改为 await 包装器。

**已知缺口：真实 watcher 套件仍然负载敏感。** `packages/boot/app-boot/tests/hmr-config.spec.ts` 在 `pnpm run test` 下仍间歇失败，且每轮失败的用例都不同。原因是主机饱和而非事件合并：818 个测试文件在约 120 秒墙钟内累积 612–664 秒测试时间，第一个 Chokidar 通知在 10 秒截止内就没到。已尝试三种手法且都未奏效，记录在备选方案里，以免下一次重复。同一饱和还影响 `bash-local`、`terminal-bash`、`tool-bash-persistent`、`subprocess-local` 以及 apiproxy 的 SSE abort 用例。

## 备选方案

- **抬高 watcher 套件的截止时间。** 作为首选修法被拒：失败不是投递晚了而是首个事件根本没到，因此更大的截止时间只是用一个任意数字换另一个，并未点明原因。这些用例已有的 30 秒 `it` 预算保留，与该文件先前就存在的 alias 用例一致。
- **重试文件写入直到通知到达。** 已尝试，并在它确实消除了固定睡眠假设的地方保留（`hmr-config` 的失败广播用例，以及 `user-patches` 的六对"写入后等待"——其内容通过 YAML 注释按尝试次数变化，使基于大小和 mtime 的去重无法隐藏一次重试）。它没有修好 flaky，因为合并并不是原因。
- **为受影响用例选用 Chokidar 的轮询后端。** 基于证据被拒：`usePolling` 不是 HMR 插件 `Config` 的字段，schemastery 会静默丢弃它，该选项从未到达 Chokidar。有三处调用点在本次改动之前就带着它，实际一直在走原生 watch；此处将它们全部移除，而不是留着暗示一个并不存在的后端选择。
- **把 watcher 套件移入 `process-bound` 这个 Vitest project。** 基于证据被拒：该 project 正是为这类争用而设，且已收纳 `app-boot.spec.ts`，但把两个文件移进去后连跑三轮全量仍出现失败轮次，说明这次移动改变了拓扑却没有换来收益。
- **让每个等待点保留自己的 `vi.waitFor`，只包装到期分支。** 被拒：消息仍会在每处构造两遍，而八份轮询选项的重复正是让该缺陷藏身之处。

## 测试

`packages/test-support/acp-snapshot` 211 个测试通过，此后任何一轮全量中先前 flaky 的四个 `waitFor*` 用例都未再失败。`packages/mcp/mcp-manager` 报告 18 个测试通过且无未处理 error。`packages/settings`、`packages/schedule`、`packages/llm/llm`、`packages/preset`——55 个文件、1045 个测试，即断言 `ctx.plugin` 被拒的那些套件——确认就绪改动没有吞掉真实失败。`pnpm run test:snapshot` 115 个测试通过；`doc-sync` 28 个门禁通过。
