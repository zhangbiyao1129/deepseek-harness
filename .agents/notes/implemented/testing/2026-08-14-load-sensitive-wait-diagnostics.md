# Agent Note: durable-wait diagnostics and unobserved plugin readiness

Status: implemented

English | [中文](2026-08-14-load-sensitive-wait-diagnostics.zh.md)

> Scope: two test-infrastructure defects that surface as flaky suites under whole-suite load — the snapshot harness's `waitFor*` diagnostics and the invariant setup's plugin-readiness wrapper. The load sensitivity of real-filesystem watcher suites is named here as a known gap, not fixed.

## Problem

Two failures looked like flakiness and were not.

`packages/test-support/acp-snapshot` builds every durable wait on `vi.waitFor`, with the descriptive reason thrown from inside the polled callback. `vi.waitFor` reports its own `Timed out in waitFor!` when the deadline arrives before an attempt completes, and the callback reads session logs from disk. A scenario step passing a short `timeoutMs` — `waitForEventAfterTurnEnd` with `timeoutMs: 20` is the checked-in case — therefore loses the harness's reason whenever the first attempt is still in IO at expiry. The negative-path test asserts that reason, so it failed for a cause unrelated to what it covers, and any scenario author debugging a real timeout got text naming neither the session nor the awaited record.

`scripts/test-invariants.ts` wraps `RegistryService.plugin` and returns a thenable whose `then` is bound to a fresh readiness promise. Product code may instead join the raw fiber with `handle.await()` — the established alternative, used in ten places including `mcp-manager`'s `ManagerCore.mount` and `agent-presets`' standing mount. Nothing then observes the wrapper's promise, so a plugin whose activation rejects produced an unhandled rejection: `mcp-manager`'s suite reported all tests passing plus one error, and Vitest warns that such an error can falsify results.

## Decision

**One `waitForDurable` helper owns every durable wait, and expiry always carries the caller's diagnostic.** The helper polls a `settled: () => Promise<boolean>` predicate and converts any expiry into `diagnostic()`, so the reason no longer depends on which deadline wins the race. All eight wait sites — turn start/end, child turn end, goal phase, inbox message, title, typed event, workspace file — pass a predicate and a message builder instead of repeating the `vi.waitFor` options. `waitForPersistedTurnStart` keeps its own malformed-record capture: a parse failure settles the wait and rethrows, because retrying could only re-read the same record.

**The readiness wrapper marks its own promise observed.** `joinInvariantStartup` attaches a no-op `catch` to the readiness chain while `joined.then` still delegates to it, so a caller that awaits the wrapper receives the identical rejection and a caller that awaits the raw fiber no longer leaves one unhandled. Product code keeps both join styles.

## Consequences

Snapshot scenarios can assert timeout reasons, and a real timeout names the session and the record. The cost is one indirection between a wait site and its `vi.waitFor` call, and `settled` predicates must report absence by returning `false` rather than throwing — a predicate that throws is retried and then reported as expiry, which is correct for transient read failures and wrong for a permanent one, so the malformed-record case handles itself explicitly.

Marking the readiness chain observed means an unawaited wrapper no longer surfaces its rejection anywhere. Nothing is lost today: the rejection reaches whoever awaits the wrapper, and product code that uses `handle.await()` already handles activation failure at its own call site. A future test that relies on an unawaited mount surfacing a global unhandled rejection would need to await the wrapper instead.

**Known gap: real-watcher suites remain load-sensitive.** `packages/boot/app-boot/tests/hmr-config.spec.ts` still fails intermittently under `pnpm run test`, and the failing case varies per run. The cause is host saturation rather than event coalescing: 818 test files accumulate 612–664 s of test time inside ~120 s of wall clock, and the first Chokidar notification does not arrive inside a 10 s deadline. Three attempts were made and none held; they are recorded under Alternatives so the next attempt does not repeat them. The same saturation reaches `bash-local`, `terminal-bash`, `tool-bash-persistent`, `subprocess-local`, and the apiproxy SSE-abort case.

## Alternatives considered

- **Raise the deadlines in the watcher suites.** Rejected as the primary fix: the failures are not late deliveries but absent first events, so a larger deadline trades one arbitrary number for another without naming the cause. The 30 s `it` budgets these cases already carry stay, matching the file's pre-existing alias case.
- **Retrigger the filesystem write until the notification arrives.** Tried and kept where it removes a genuine fixed-sleep assumption (`hmr-config`'s failure-broadcast case, `user-patches`' six write-then-await pairs, whose content varies per attempt through a YAML comment so size- and mtime-based deduplication cannot hide a retry). It did not fix the flakiness, because coalescing was not the cause.
- **Select Chokidar's polling backend for the affected cases.** Rejected on evidence: `usePolling` is not a field of the HMR plugin's `Config`, so schemastery dropped it silently and the option never reached Chokidar. Three call sites had carried it since before this change and were exercising native watching all along; all of them are removed here rather than left to imply a backend choice that does not exist.
- **Move the watcher suites into the `process-bound` Vitest project.** Rejected on evidence: that project exists for exactly this class of contention and already holds `app-boot.spec.ts`, but three full runs with the two files moved still produced a failing round, so the move changed the topology without earning it.
- **Let each wait site keep its own `vi.waitFor` and wrap only the expiry.** Rejected: the message would still be built in two places per site, and eight copies of the poll options are the duplication that let the defect hide.

## Testing

`packages/test-support/acp-snapshot` passes 211 tests, and the four previously flaky `waitFor*` cases have not failed in any full run since. `packages/mcp/mcp-manager` reports 18 passing tests with no unhandled error. `packages/settings`, `packages/schedule`, `packages/llm/llm`, and `packages/preset` — 55 files, 1045 tests, the suites that assert a rejecting `ctx.plugin` — confirm the readiness change does not swallow a genuine failure. `pnpm run test:snapshot` passes 115 tests; `doc-sync` passes 28 gates.
