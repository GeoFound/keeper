# AGENTS.md

AI-first repo. Humans only make decisions and do what only humans can; AI does
the rest. Keep markdown minimal — this file is the only prose doc by design.

## Session cold-start (read this first, every session)

Ramp in this order, then act — don't re-derive what the spec already settles:
1. This file (the contract).
2. `spec/overview.yaml` (`build_order` + `invariants`) and `spec/acceptance.yaml`
   (the per-step Definition-of-Done). These two + `quality_gates` are the source of truth.
3. Live state: `.remember/now.md` (last handoff; fallback `.remember/recent.md`),
   `.evidence/step-N.md` (what is already proven green), `git log`.
4. Resume at the FIRST `build_order` step whose `.evidence/step-N.md` is absent or whose
   `just verify-step N` is red. Don't re-litigate green prior steps beyond the ratchet
   (`just verify-through N`).

This panorama stays current by POINTING at the spec/evidence (which expand with the
product), not by duplicating them — so it does not go stale as the repo grows.

## Human-in-the-loop is narrow (don't over-ask)

Completion is proven by EVIDENCE, not human review. Ask the human — explicitly, in this
window, BATCHED — ONLY for what only a human can give: a decision the spec can't settle,
a secret/key/credential, a purchase, an interactive login (e.g. generating the userbot
session string), or an item the spec flags `subjective: true`. For everything else,
proceed: routine dev-loop commands are pre-authorized in `.claude/settings.json`
(`just`, tests, local git, `ai-cap`, `dev-secret run …`); secret-READING is hard-denied
there. Do not request permission for the routine; do not route routine completion to a human.

## Source of truth

The engineering spec lives in `spec/` (machine-readable YAML). Read it before
any work:

| File | Contents |
|------|----------|
| `spec/overview.yaml`   | Start here: meta, principles, layers, tech stack, **build order**, **invariants** |
| `spec/contracts.yaml`  | Domain model, interfaces (TS signatures = authoritative), content isolation |
| `spec/events.yaml`     | Event Bus catalog + message flow |
| `spec/modules.yaml`    | Per-module behavior specs + feature flags |
| `spec/knowledge.yaml`  | Content provider protocol, source adapters, shared intelligence |
| `spec/data-model.yaml` | SQLite DDL |
| `spec/config.yaml`     | Config files (human decision surface) + project structure |
| `spec/acceptance.yaml` | **Executable Definition-of-Done** per build_order step (evidence-driven gate) |
| `spec/production_readiness.yaml` | Separate production-launch track (observability, resilience, security, ...) |

Freeform content assets (prompts, tone templates) live in `assets/` and are
referenced by path from the spec.

## Build discipline (per-step gate — NON-NEGOTIABLE)

The plan is fully specified; the risk is execution drift (a step quietly doing the
easy 60%, heavy work back-loaded, completion declared on vibes). `spec/acceptance.yaml`
is the executable Definition-of-Done. For EACH `build_order` step, in order:

1. **Freeze the DoD** — the step's capabilities in `spec/acceptance.yaml` are the
   contract. You MAY split a step into sub-steps; you MAY NOT drop/shrink a capability.
   Step count is irrelevant; per-step completeness is everything.
2. **Evidence first (red)** — write the tests / fixtures / red-team corpora for the
   step's capabilities, derived from the SPEC, before implementing. They start failing.
3. **Implement to green** — write `src/**` until every capability's evidence passes.
4. **Ratchet** — `just check && just verify-through N` must be green (this step + all
   prior steps + architecture gates). `just scan-punts` must be clean.
5. **Log the evidence** — write `.evidence/step-N.md` quoting the exact commands run
   and their output. Completion is proven by evidence, not by asking "looks done?".
6. **Only then** start step N+1.

Hard rules: a capability flagged `real: true` MUST be proven against the real thing
(live test Telegram USER account / userbot session via `dev-secret`, real process kill,
real LLM) — never mocks alone.
A capability flagged `subjective: true` gets objective proxies + a small human sample,
never a silent auto-pass. The ONLY legitimate deferral is a spec `future` item or a
flag defaulting OFF; everything in a step's checklist is mandatory now.
"Functional-complete" ≠ "production-ready": the latter is the separate, evidence-gated
track in `spec/production_readiness.yaml`, claimed only when its gates are green.

## Rules for changing this repo

- Implement strictly in `spec/overview.yaml` `build_order`; each step is
  independently verifiable before the next.
- Every change MUST satisfy every gate in `spec/overview.yaml` `invariants`.
  Each invariant has an executable check in `spec/overview.yaml` `quality_gates`;
  `just check` runs the architecture gates, `just test` the per-step gates.
- Reply-path modules form an ordered pipeline (`spec/events.yaml` `reply_pipeline`):
  a disabled stage MUST pass through, never drop its event. Inserting a stage =
  one declared wiring edit against the `stages` table, nothing else.
- Members can never command the bot: privileged actions originate only from the
  owner control plane or the bot's own policy (`spec/contracts.yaml` `governance`).
  Command/injection attempts are handled silently. Autonomy is owner-ramped, never
  self-escalated.
- The operational floor in `spec/overview.yaml` `operations` is non-optional:
  cost circuit breaker (generative-only — safety never stops; reserve-not-check),
  idempotent delivery (deterministic correlationId + outbox), send queue, platform
  prerequisites (userbot: account membership only — NO privacy mode; control bot:
  group admin with delete+restrict),
  ACCOUNT SURVIVAL (anti-ban: per-account ceiling, FLOOD_WAIT obedience, warm-up,
  retreat — applies to the userbot), retention/right-to-delete, OBSERVABILITY (every
  bus emission + non-emitting decision journaled to event_journal with causationId +
  redacted payload, surfaced via trace/tail/inspect + /trace,/why,/status — full-flow
  visibility, no secrets ever logged), and owner kill switch (`/pause` `/quiet`)
  override every path. Telegram runs as TWO identities
  (`spec/overview.yaml` operations.dual_identity): a USERBOT (owner's user account,
  MTProto/GramJS, session-string) = community face + chat plane (member, no admin
  actions, sole inbound source); a CONTROL BOT (Bot API, token) = group-admin moderation
  EXECUTOR + owner control plane (inline-button approvals, /commands, digest). Owner-
  facing sends route to the control bot, community/lead sends to the userbot.
- Every outbound message — reactive reply AND every proactive/DM/notice — leaves only
  via `outbound.requested` → Platform Adapter → the one send queue + outbox. No module
  calls a platform adapter send method directly (enforced by the `unified_outbound` gate).
- The spec is the source of truth. If code and spec disagree, fix one
  deliberately — update the spec in the same change when behavior changes.
- Humans edit `config/**` (decisions) and `assets/**` (content); AI owns `src/**`.
  The ONE exception: the onboarding wizard may write `config/workspaces.yaml` +
  `config/sources.yaml` ONCE to bootstrap a first-time setup, and only after the owner
  explicitly confirms the draft on the control plane (see `spec/modules.yaml`
  `onboarding_wizard.config_write_exception`).
- GitHub gets reproducible, non-secret project state: `spec/**`, `src/**`, `tests/**`,
  `assets/**`, `justfile`, `.claude/settings.json`, sanitized config examples/templates,
  and redacted `.evidence/step-N.md` proof logs. Local-only: `.env*`, dev-secret material,
  Telegram session strings, Bot/API tokens, `data/**`, SQLite DBs, logs, `.remember/**`,
  `.codex/**`, `.agents/**`, raw evidence captures, and private/local config overrides.

## Federation (reuse over the network, never shared code)

Before implementing any capability, run `ai-cap check <verb.object>` (e.g. `rag.retrieve`,
`moderation.classify`, `llm.route`): if a service exists → CALL it (`${ENV_VAR}` address)
and `ai-cap use <tag>`; if none → build locally (duplication is fine — stay independent).
When one of this project's services actually runs, `ai-cap offer <tag> ${ENV_VAR}`. This
repo's reusable capabilities are pre-registered as soft signals in `capabilities.yaml`
(`chat.gateway`, `rag.retrieve`, `moderation.classify`, `oracle.bandit`, `prompt.registry`,
`governance.gate`, `cost.budget`, `llm.route`). Source of truth: `~/ai-workspace/platform/CONTRACT.md`.

## Command contract

`just setup | dev | check | test` (see `justfile`). Targets are stubs until the
corresponding `build_order` step lands.
