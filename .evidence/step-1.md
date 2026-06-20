# Step 1 Evidence — Engine core

Date: 2026-06-19

This file supersedes the earlier Step 1 evidence that used an in-process JSON-backed store. The accepted evidence below is from the SQLite/WAL implementation with real child-process SIGKILL crash injection.

## Federation checks

Command: `ai-cap check cost.budget`

Output:

```text
能力: cost.budget
  ○ 暂无服务提供 —— 本项目可自行实现（重复是允许的，保持独立）
  联邦现状: 0 个项目提供 · 0 个项目消费 · 2 个项目各自实现
```

Command: `ai-cap check llm.route`

Output:

```text
能力: llm.route
  ○ 暂无服务提供 —— 本项目可自行实现（重复是允许的，保持独立）
  联邦现状: 0 个项目提供 · 0 个项目消费 · 8 个项目各自实现
```

Command: `ai-cap check chat.gateway`

Output:

```text
能力: chat.gateway
  ○ 暂无服务提供 —— 本项目可自行实现（重复是允许的，保持独立）
  联邦现状: 0 个项目提供 · 0 个项目消费 · 1 个项目各自实现
```

Command: `ai-cap check governance.gate`

Output:

```text
能力: governance.gate
  ○ 暂无服务提供 —— 本项目可自行实现（重复是允许的，保持独立）
  联邦现状: 0 个项目提供 · 0 个项目消费 · 2 个项目各自实现
```

## Verification

Command: `just check`

Output:

```text
npm run check

> keeper@0.1.0 check
> node --test --experimental-strip-types tests/static/*.test.ts tests/step-1/*.test.ts

✔ spec wiring remains internally consistent (225.828127ms)
✔ static architecture gates reject direct module coupling and unsafe privileged paths (2.052372ms)
✔ SQLite schema is applied from the authoritative data model with WAL enabled (23.836043ms)
✔ real crash evidence uses child process kill, not in-process restart simulation only (2.016513ms)
✔ config loads, validates hard floor, uniqueness, embedding dimension, and launch profile (25.055328ms)
✔ config rejects dangerous or ambiguous inputs and preserves prior config on bad reload (11.703156ms)
✔ config can be loaded from YAML files (47.880753ms)
✔ engine registers modules, starts, stops, and calls module health checks (44.444584ms)
✔ bus delivers only declared events and rejects undeclared module emissions (64.52939ms)
✔ every catalog event has a schema and envelope scope rules are enforced (32.686667ms)
✔ raw empty-workspace events are journaled as skeleton-only with subject stamping (31.258293ms)
✔ payload schemas reject malformed catalog payloads (19.318675ms)
✔ inbound_updates re-drive after routing and commit after pipeline abort (72.052061ms)
✔ pending without a persisted message waits for platform replay and stale pending commits (27.710451ms)
✔ real process kill after outbox sending restarts as ambiguous from disk (313.461531ms)
✔ real process kill after persisted inbound message redrives from disk (122.219054ms)
✔ real process kill after pipeline abort stays committed after restart (113.592439ms)
✔ RuntimeStateService is idempotent and emits one deduped owner alert (60.745082ms)
✔ LLMGateway reserves atomically and releases failed reservations (19.434004ms)
✔ LLMGateway keeps ingest source budgets and media holds separate (21.294644ms)
✔ Outbox handles dedupe, ambiguous sending rows, staleness, and bot-turn reservation (12.9263ms)
✔ DataLifecycleService is the bounded cross-owner delete/redaction plane (8.645124ms)
✔ owner outbound notices use suppressIfKillSwitch=false and are still journaled (10.137524ms)
✔ scheduler fires workspace-local ticks and catches up once (24.734231ms)
✔ trace, tail, inspect, structured logs, and secret redaction work (38.804514ms)
✔ event journal writes are buffered off the hot path and flushed explicitly (11.404006ms)
✔ test/development Echo harness wires inbound bus to unified outbox (42.255399ms)
✔ Echo harness is rejected in production (14.692273ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 883.306332
```

Command: `just build`

Output:

```text
npm run build

> keeper@0.1.0 build
> node --experimental-strip-types src/index.ts --healthcheck

keeper engine core ok
```

Command: `just scan-punts`

Output:

```text
✓ scan-punts: clean
```

Command: `npm run verify:step1`

Output:

```text
> keeper@0.1.0 verify:step1
> node --test --experimental-strip-types tests/step-1/*.test.ts tests/static/*.test.ts

✔ spec wiring remains internally consistent (182.371083ms)
✔ static architecture gates reject direct module coupling and unsafe privileged paths (2.097312ms)
✔ SQLite schema is applied from the authoritative data model with WAL enabled (16.204195ms)
✔ real crash evidence uses child process kill, not in-process restart simulation only (0.837409ms)
✔ config loads, validates hard floor, uniqueness, embedding dimension, and launch profile (15.686814ms)
✔ config rejects dangerous or ambiguous inputs and preserves prior config on bad reload (11.796272ms)
✔ config can be loaded from YAML files (30.790154ms)
✔ engine registers modules, starts, stops, and calls module health checks (44.441998ms)
✔ bus delivers only declared events and rejects undeclared module emissions (54.074941ms)
✔ every catalog event has a schema and envelope scope rules are enforced (15.101376ms)
✔ raw empty-workspace events are journaled as skeleton-only with subject stamping (14.952653ms)
✔ payload schemas reject malformed catalog payloads (9.407221ms)
✔ inbound_updates re-drive after routing and commit after pipeline abort (40.432893ms)
✔ pending without a persisted message waits for platform replay and stale pending commits (18.488048ms)
✔ real process kill after outbox sending restarts as ambiguous from disk (222.325251ms)
✔ real process kill after persisted inbound message redrives from disk (113.768238ms)
✔ real process kill after pipeline abort stays committed after restart (107.923143ms)
✔ RuntimeStateService is idempotent and emits one deduped owner alert (37.861056ms)
✔ LLMGateway reserves atomically and releases failed reservations (11.650021ms)
✔ LLMGateway keeps ingest source budgets and media holds separate (9.410695ms)
✔ Outbox handles dedupe, ambiguous sending rows, staleness, and bot-turn reservation (8.848053ms)
✔ DataLifecycleService is the bounded cross-owner delete/redaction plane (7.339372ms)
✔ owner outbound notices use suppressIfKillSwitch=false and are still journaled (7.4339ms)
✔ scheduler fires workspace-local ticks and catches up once (22.034816ms)
✔ trace, tail, inspect, structured logs, and secret redaction work (57.411856ms)
✔ event journal writes are buffered off the hot path and flushed explicitly (14.593857ms)
✔ test/development Echo harness wires inbound bus to unified outbox (47.39801ms)
✔ Echo harness is rejected in production (14.797248ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 681.430618
```

Command: `just verify-through 1`

Output:

```text
npm run check

> keeper@0.1.0 check
> node --test --experimental-strip-types tests/static/*.test.ts tests/step-1/*.test.ts

✔ tests/static/architecture.test.ts (505.805403ms)
✔ tests/step-1/config-loader.test.ts (488.118618ms)
✔ tests/step-1/engine-lifecycle.test.ts (506.312178ms)
✔ tests/step-1/event-bus.test.ts (531.138795ms)
✔ tests/step-1/inbound-crash.test.ts (471.577691ms)
✔ tests/step-1/real-crash.test.ts (785.743708ms)
✔ tests/step-1/runtime-budget-outbox.test.ts (536.612314ms)
✔ tests/step-1/scheduler-observability.test.ts (545.868625ms)
✔ tests/step-1/walking-skeleton.test.ts (516.972573ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 811.021855
=== verify-through: step 1 ===
verify-step 1: capabilities in spec/acceptance.yaml steps[1]
✓ scan-punts: clean

> keeper@0.1.0 verify:step1
> node --test --experimental-strip-types tests/step-1/*.test.ts tests/static/*.test.ts

✔ tests/static/architecture.test.ts (465.906125ms)
✔ tests/step-1/config-loader.test.ts (460.719303ms)
✔ tests/step-1/engine-lifecycle.test.ts (358.319359ms)
✔ tests/step-1/event-bus.test.ts (493.752609ms)
✔ tests/step-1/inbound-crash.test.ts (321.05297ms)
✔ tests/step-1/real-crash.test.ts (717.178723ms)
✔ tests/step-1/runtime-budget-outbox.test.ts (469.115934ms)
✔ tests/step-1/scheduler-observability.test.ts (484.467854ms)
✔ tests/step-1/walking-skeleton.test.ts (415.432767ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 743.072228
✓ verify-through 1: all steps 1..1 + architecture gates green
```

## Final rerun after sqlite-vec enforcement

Command: `just check`

Output:

```text
npm run check

> keeper@0.1.0 check
> node --test --experimental-strip-types tests/static/*.test.ts tests/step-1/*.test.ts

✔ spec wiring remains internally consistent (261.128889ms)
✔ static architecture gates reject direct module coupling and unsafe privileged paths (2.342078ms)
✔ SQLite schema is applied from the authoritative data model with WAL enabled (19.48669ms)
✔ real crash evidence uses child process kill, not in-process restart simulation only (0.7696ms)
✔ config loads, validates hard floor, uniqueness, embedding dimension, and launch profile (33.751463ms)
✔ config rejects dangerous or ambiguous inputs and preserves prior config on bad reload (12.619132ms)
✔ config can be loaded from YAML files (45.367082ms)
✔ engine registers modules, starts, stops, and calls module health checks (64.688864ms)
✔ bus delivers only declared events and rejects undeclared module emissions (36.470104ms)
✔ every catalog event has a schema and envelope scope rules are enforced (20.813135ms)
✔ raw empty-workspace events are journaled as skeleton-only with subject stamping (13.423222ms)
✔ payload schemas reject malformed catalog payloads (12.914568ms)
✔ inbound_updates re-drive after routing and commit after pipeline abort (96.25669ms)
✔ pending without a persisted message waits for platform replay and stale pending commits (28.855138ms)
✔ real process kill after outbox sending restarts as ambiguous from disk (293.627749ms)
✔ real process kill after persisted inbound message redrives from disk (123.9574ms)
✔ real process kill after pipeline abort stays committed after restart (119.870147ms)
✔ RuntimeStateService is idempotent and emits one deduped owner alert (59.34412ms)
✔ LLMGateway reserves atomically and releases failed reservations (31.212496ms)
✔ LLMGateway keeps ingest source budgets and media holds separate (18.849689ms)
✔ Outbox handles dedupe, ambiguous sending rows, staleness, and bot-turn reservation (20.562377ms)
✔ DataLifecycleService is the bounded cross-owner delete/redaction plane (12.807301ms)
✔ owner outbound notices use suppressIfKillSwitch=false and are still journaled (14.27123ms)
✔ scheduler fires workspace-local ticks and catches up once (22.842635ms)
✔ trace, tail, inspect, structured logs, and secret redaction work (46.221487ms)
✔ event journal writes are buffered off the hot path and flushed explicitly (17.740634ms)
✔ test/development Echo harness wires inbound bus to unified outbox (40.81815ms)
✔ Echo harness is rejected in production (20.581877ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1082.661081
```

Command: `npm run verify:step1`

Output:

```text
> keeper@0.1.0 verify:step1
> node --test --experimental-strip-types tests/step-1/*.test.ts tests/static/*.test.ts

✔ spec wiring remains internally consistent (265.231672ms)
✔ static architecture gates reject direct module coupling and unsafe privileged paths (2.184492ms)
✔ SQLite schema is applied from the authoritative data model with WAL enabled (27.648843ms)
✔ real crash evidence uses child process kill, not in-process restart simulation only (1.613909ms)
✔ config loads, validates hard floor, uniqueness, embedding dimension, and launch profile (19.141043ms)
✔ config rejects dangerous or ambiguous inputs and preserves prior config on bad reload (11.957732ms)
✔ config can be loaded from YAML files (51.344116ms)
✔ engine registers modules, starts, stops, and calls module health checks (76.745627ms)
✔ bus delivers only declared events and rejects undeclared module emissions (41.027826ms)
✔ every catalog event has a schema and envelope scope rules are enforced (21.863589ms)
✔ raw empty-workspace events are journaled as skeleton-only with subject stamping (35.998642ms)
✔ payload schemas reject malformed catalog payloads (17.233851ms)
✔ inbound_updates re-drive after routing and commit after pipeline abort (52.476783ms)
✔ pending without a persisted message waits for platform replay and stale pending commits (17.461307ms)
✔ real process kill after outbox sending restarts as ambiguous from disk (427.200078ms)
✔ real process kill after persisted inbound message redrives from disk (144.254861ms)
✔ real process kill after pipeline abort stays committed after restart (119.083098ms)
✔ RuntimeStateService is idempotent and emits one deduped owner alert (65.048077ms)
✔ LLMGateway reserves atomically and releases failed reservations (36.271134ms)
✔ LLMGateway keeps ingest source budgets and media holds separate (52.194857ms)
✔ Outbox handles dedupe, ambiguous sending rows, staleness, and bot-turn reservation (33.03206ms)
✔ DataLifecycleService is the bounded cross-owner delete/redaction plane (16.388884ms)
✔ owner outbound notices use suppressIfKillSwitch=false and are still journaled (17.021063ms)
✔ scheduler fires workspace-local ticks and catches up once (22.46142ms)
✔ trace, tail, inspect, structured logs, and secret redaction work (41.339992ms)
✔ event journal writes are buffered off the hot path and flushed explicitly (17.726203ms)
✔ test/development Echo harness wires inbound bus to unified outbox (47.542718ms)
✔ Echo harness is rejected in production (20.157973ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1037.602201
```

Command: `just verify-through 1`

Output:

```text
npm run check

> keeper@0.1.0 check
> node --test --experimental-strip-types tests/static/*.test.ts tests/step-1/*.test.ts

✔ tests/static/architecture.test.ts (486.0534ms)
✔ tests/step-1/config-loader.test.ts (398.531473ms)
✔ tests/step-1/engine-lifecycle.test.ts (407.657192ms)
✔ tests/step-1/event-bus.test.ts (455.577795ms)
✔ tests/step-1/inbound-crash.test.ts (344.893957ms)
✔ tests/step-1/real-crash.test.ts (731.061292ms)
✔ tests/step-1/runtime-budget-outbox.test.ts (523.323064ms)
✔ tests/step-1/scheduler-observability.test.ts (466.777295ms)
✔ tests/step-1/walking-skeleton.test.ts (405.208635ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 756.505175
=== verify-through: step 1 ===
verify-step 1: capabilities in spec/acceptance.yaml steps[1]
✓ scan-punts: clean

> keeper@0.1.0 verify:step1
> node --test --experimental-strip-types tests/step-1/*.test.ts tests/static/*.test.ts

✔ tests/static/architecture.test.ts (338.292787ms)
✔ tests/step-1/config-loader.test.ts (309.156163ms)
✔ tests/step-1/engine-lifecycle.test.ts (295.79908ms)
✔ tests/step-1/event-bus.test.ts (349.383379ms)
✔ tests/step-1/inbound-crash.test.ts (230.926922ms)
✔ tests/step-1/real-crash.test.ts (575.68034ms)
✔ tests/step-1/runtime-budget-outbox.test.ts (363.840564ms)
✔ tests/step-1/scheduler-observability.test.ts (328.80725ms)
✔ tests/step-1/walking-skeleton.test.ts (314.83615ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 599.637562
✓ verify-through 1: all steps 1..1 + architecture gates green
```

## Round 2 — residual fixes (post-review hardening)

Fixes: (1) crash recovery wired into `EngineCore.start()` via `RecoveryCoordinator` (outbox
reconcile + inbound re-drive re-emitting `message.routed` as the `engine` infra producer),
proven to be driven by `start()` itself; (2) `observe` CLI defaults to the engine DB
`data/bot.db` (`KEEPER_DB` override); (3) committed sanitized `config/` directory that validates
against the loader in CI; (4) `table_ownership` static gate broadened from
`workspace_runtime_state`-only to a per-table owner allowlist over ALL `INSERT/UPDATE/DELETE` in
`src/`, with the DataLifecycleService lifecycle exception. Spec updated in the same change:
`inbound_updates` added to `lifecycle_policies.retention_sweep` (authorizes the bounded
committed-row prune; pending rows are never pruned).

Command: `npm test`

Output (tail):

```text
✔ every table mutation in src comes from its declared owner (table_ownership)
✔ the committed sanitized config/ directory validates against the loader
✔ engine.start() runs crash recovery: reconciles the outbox and re-drives inbound
ℹ tests 31
ℹ pass 31
ℹ fail 0
```

Negative control — the ownership gate BITES (inject `DELETE FROM outbox` into a non-owner file):

```text
✖ every table mutation in src comes from its declared owner (table_ownership)
  AssertionError: scheduler.ts mutates outbox but is not its declared owner (table_ownership)
(reverted; gate green again)
```

Command: `just build && just scan-punts && just verify-through 1`

Output (tail):

```text
keeper engine core ok
✓ scan-punts: clean
✓ verify-through 1: all steps 1..1 + architecture gates green
```

