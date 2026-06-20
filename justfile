# Command contract for the AI community engine.
# Targets are stubs until the matching spec/overview.yaml build_order step lands.
# The verify-* / scan-punts recipes below are the EXECUTION DISCIPLINE: a step is
# "done" only when its gate is green (see spec/acceptance.yaml). scan-punts works
# now; verify-* fail closed until the real test runner lands at build_order step 1.

set tempdir := "/tmp"

default:
    @just --list

# Install dependencies and prepare local data dirs.
setup:
    npm install

# Run the bot locally (long-lived connection).
dev:
    npm run build

# (overview.yaml quality_gates.architecture: no_cross_module_imports, declared_events_only,
#  envelope_conformance, content_isolation, ... + the safety/redteam gates.)
# Architecture invariants — the gates that must be green on EVERY step.
check:
    npm run check

# Run tests.
test:
    npm test

# Build for deploy.
build:
    npm run build

# ---------------------------------------------------------------------------
# OBSERVABILITY — human read-interface over the event_journal (operations.observability).
# The whole product's flow is human-inspectable; these land at build_order step 1.
# ---------------------------------------------------------------------------

# Full ordered story of ONE message/action (every event + decision + failure for its correlationId).
trace id:
    node --experimental-strip-types src/cli/observe.ts trace {{id}}

# Live stream of events as they flow (tail the journal / structured log).
tail:
    node --experimental-strip-types src/cli/observe.ts tail

# Recent activity for an entity (a message id, user id, or channel id).
inspect target:
    node --experimental-strip-types src/cli/observe.ts inspect {{target}}

# Filtered journal query (e.g. just journal --since 1h --name reply.generated --level error).
journal *args:
    node --experimental-strip-types src/cli/observe.ts journal {{args}}

# Remove local build/cache artifacts.
clean:
    @echo "clean: no generated build artifacts"

# ---------------------------------------------------------------------------
# EXECUTION DISCIPLINE (see spec/acceptance.yaml + AGENTS.md "Build discipline")
# ---------------------------------------------------------------------------

# Legitimate deferrals (spec `future` / flags OFF) live behind feature flags, not
# these markers. Runs NOW (passes trivially until src/ exists).
# Anti-laziness scan: fail if shipped src/ punts work that belongs to a done step.
scan-punts:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d src ]; then echo "scan-punts: no src/ yet — OK"; exit 0; fi
    pattern='TODO|FIXME|XXX|NotImplemented|not implemented|throw new Error\("?(stub|placeholder|unimplemented)|@stub|PLACEHOLDER|phase ?2|later step|punt'
    if grep -rInE "$pattern" src 2>/dev/null; then
        echo "✗ scan-punts: deferral markers found in src/ — finish the step or split it, do not punt."; exit 1
    fi
    echo "✓ scan-punts: clean"

# Prove ONE build_order step is fully done: its acceptance capabilities green.
# Usage: just verify-step 5
verify-step step:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "verify-step {{step}}: capabilities in spec/acceptance.yaml steps[{{step}}]"
    just scan-punts
    if [ "{{step}}" != "1" ]; then
        echo "verify-step {{step}}: tests/step-{{step}}/ absent — step not built yet (write evidence FIRST)"; exit 1
    fi
    npm run verify:step1
    test -s ".evidence/step-{{step}}.md"

# Credential-gated REAL smoke for a step (real_smoke / real_runtime evidence).
# Split from `verify-step` so the local loop stays fast + offline (adapter contract
# simulator) while the real path is proven once with secrets via dev-secret. Records
# redacted evidence; failures block a production launch, not local spec iteration.
# Usage: just verify-real step-2   (see spec/acceptance.yaml real_evidence_layering,
# evidence_types.real_smoke; production_readiness.telegram_real_e2e is the full matrix.)
verify-real target:
    @echo "verify-real {{target}}: credential-gated live smoke — not implemented yet (build_order step 2 wires the real runner; run under dev-secret, never with plaintext keys)"
    @exit 1

# Regression ratchet: every step 1..N (plus architecture gates) must still pass
# before step N+1 may start. Usage: just verify-through 5
verify-through n:
    #!/usr/bin/env bash
    set -euo pipefail
    just check
    for i in $(seq 1 {{n}}); do
        echo "=== verify-through: step $i ==="
        just verify-step "$i"
    done
    echo "✓ verify-through {{n}}: all steps 1..{{n}} + architecture gates green"

# Production-readiness gate (separate track — NOT required for functional steps).
# Usage: just verify-prod observability   |   just verify-prod all
verify-prod id:
    @echo "verify-prod {{id}}: see spec/production_readiness.yaml — not implemented until the production track is opened"
    @exit 1

# Security review (the redteam corpora + secret/dependency scans).
security-review:
    @echo "security-review: not implemented yet (production_readiness.security)"
    @exit 1
