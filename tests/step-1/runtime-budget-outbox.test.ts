import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from '../support/test-store.ts';
import { EventBus, createEnvelope } from '../../src/engine/event-bus.ts';
import { ObservabilityService } from '../../src/services/observability.ts';
import { RuntimeStateService } from '../../src/services/runtime-state.ts';
import { LLMGateway } from '../../src/services/llm-gateway.ts';
import { OutboxService } from '../../src/services/outbox.ts';
import { DataLifecycleService } from '../../src/services/data-lifecycle.ts';

test('RuntimeStateService is idempotent and emits one deduped owner alert', async () => {
  const store = createTestStore('runtime-state');
  const bus = new EventBus({ observability: new ObservabilityService(store) });
  const outbox = new OutboxService(store);
  outbox.registerBusConsumer(bus);
  const runtime = new RuntimeStateService(store, bus);

  await runtime.enter({
    workspaceId: 'ws-main',
    scopeType: 'workspace',
    scopeId: 'ws-main',
    mode: 'read_only',
    reason: 'budget_exhausted',
  });
  await runtime.enter({
    workspaceId: 'ws-main',
    scopeType: 'workspace',
    scopeId: 'ws-main',
    mode: 'read_only',
    reason: 'budget_exhausted',
  });

  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM workspace_runtime_state').get().count, 1);
  assert.equal(store.prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key LIKE 'system_notice:runtime:%'").get().count, 1);
});

test('RuntimeStateService expires timed holds and reactivates through the same deduped incident row', async () => {
  const store = createTestStore('runtime-state-expiry');
  const bus = new EventBus({ observability: new ObservabilityService(store) });
  new OutboxService(store).registerBusConsumer(bus);
  const runtime = new RuntimeStateService(store, bus);

  await runtime.enter({
    workspaceId: 'ws-main',
    scopeType: 'workspace',
    scopeId: 'ws-main',
    mode: 'read_only',
    reason: 'budget_exhausted',
    until: new Date('2026-06-20T00:00:00.000Z'),
    now: new Date('2026-06-19T12:00:00.000Z'),
  });

  assert.equal(runtime.active({ workspaceId: 'ws-main', now: new Date('2026-06-19T23:59:00.000Z') }).length, 1);
  assert.equal(runtime.active({ workspaceId: 'ws-main', now: new Date('2026-06-20T00:00:01.000Z') }).length, 0);

  await runtime.enter({
    workspaceId: 'ws-main',
    scopeType: 'workspace',
    scopeId: 'ws-main',
    mode: 'read_only',
    reason: 'budget_exhausted',
    until: new Date('2026-06-21T00:00:00.000Z'),
    now: new Date('2026-06-20T12:00:00.000Z'),
  });

  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM workspace_runtime_state').get().count, 1);
  assert.equal(store.prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key LIKE 'system_notice:runtime:%'").get().count, 1);
  assert.equal(runtime.active({ workspaceId: 'ws-main', now: new Date('2026-06-20T12:01:00.000Z') }).length, 1);
});

test('LLMGateway reserves atomically and releases failed reservations', async () => {
  const store = createTestStore('budget');
  const bus = new EventBus({ observability: new ObservabilityService(store) });
  new OutboxService(store).registerBusConsumer(bus);
  const runtime = new RuntimeStateService(store, bus);
  const gateway = new LLMGateway(store, runtime);
  gateway.seedBudget({ scopeType: 'workspace', scopeId: 'ws-main', lane: 'generative', day: '2026-06-19', limitUsd: 1 });

  const calls = await Promise.allSettled([
    gateway.withReservation({ scopeType: 'workspace', scopeId: 'ws-main', lane: 'generative', day: '2026-06-19', estimateUsd: 0.7 }, async () => 1),
    gateway.withReservation({ scopeType: 'workspace', scopeId: 'ws-main', lane: 'generative', day: '2026-06-19', estimateUsd: 0.7 }, async () => 2),
  ]);

  assert.equal(calls.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM llm_usage').get().count, 1);
  assert.equal(store.prepare('SELECT generative_reserved_usd AS reserved FROM daily_budget_state').get().reserved, 0);
  const hold = store.prepare(`
    SELECT mode, until
    FROM workspace_runtime_state
    WHERE mode = 'read_only' AND reason = 'budget_exhausted'
  `).get() as any;
  assert.equal(hold.mode, 'read_only');
  assert.equal(hold.until, '2026-06-20T00:00:00.000Z');
  assert.equal(runtime.active({ workspaceId: 'ws-main', now: new Date('2026-06-19T12:00:00.000Z') }).length, 1);
  assert.equal(runtime.active({ workspaceId: 'ws-main', now: new Date('2026-06-20T00:00:01.000Z') }).length, 0);

  await assert.rejects(
    () =>
      gateway.withReservation({ scopeType: 'workspace', scopeId: 'ws-main', lane: 'generative', day: '2026-06-19', estimateUsd: 0.1 }, async () => {
        throw new Error('provider failed');
      }),
    /provider failed/,
  );
  assert.equal(store.prepare('SELECT generative_reserved_usd AS reserved FROM daily_budget_state').get().reserved, 0);
});

test('LLMGateway keeps ingest source budgets and media holds separate', async () => {
  const store = createTestStore('budget-lanes');
  const bus = new EventBus({ observability: new ObservabilityService(store) });
  new OutboxService(store).registerBusConsumer(bus);
  const runtime = new RuntimeStateService(store, bus);
  const gateway = new LLMGateway(store, runtime);

  gateway.seedBudget({ scopeType: 'source', scopeId: 'src-docs', lane: 'ingest', day: '2026-06-19', limitUsd: 1 });
  await gateway.withReservation({ scopeType: 'source', scopeId: 'src-docs', lane: 'ingest', day: '2026-06-19', estimateUsd: 0.2 }, async () => 'ok');
  assert.equal(store.prepare('SELECT ingest_actual_usd AS actual FROM ingest_budget_state').get().actual, 0.2);
  assert.equal(store.prepare('SELECT scope_type AS scopeType FROM llm_usage').get().scopeType, 'source');

  gateway.seedBudget({ scopeType: 'workspace', scopeId: 'ws-main', lane: 'media_safety', day: '2026-06-19', limitUsd: 0.1 });
  await assert.rejects(
    () =>
      gateway.withReservation(
        {
          scopeType: 'workspace',
          scopeId: 'ws-main',
          lane: 'media_safety',
          day: '2026-06-19',
          estimateUsd: 0.2,
          mediaHoldMode: 'silent_delete_unscanned',
        },
        async () => 'blocked',
      ),
    /budget exhausted/,
  );
  assert.equal(
    runtime.active({ workspaceId: 'ws-main', scopeType: 'workspace', now: new Date('2026-06-19T12:00:00.000Z') }).some((row) => row.mode === 'media_hold'),
    true,
  );
  assert.match(
    store.prepare("SELECT details_json AS details FROM workspace_runtime_state WHERE mode = 'media_hold'").get().details,
    /silent_delete_unscanned/,
  );

  gateway.seedBudget({ scopeType: 'workspace', scopeId: 'ws-safety', lane: 'safety', day: '2026-06-19', limitUsd: 0.1 });
  await assert.rejects(
    () =>
      gateway.withReservation({ scopeType: 'workspace', scopeId: 'ws-safety', lane: 'safety', day: '2026-06-19', estimateUsd: 0.2 }, async () => 'blocked'),
    /budget exhausted/,
  );
  assert.equal(
    runtime.active({ workspaceId: 'ws-safety', scopeType: 'workspace', now: new Date('2026-06-19T12:00:00.000Z') }).some((row) => row.mode === 'safety_hold'),
    true,
  );
});

test('Outbox handles dedupe, ambiguous sending rows, staleness, and bot-turn reservation', async () => {
  const store = createTestStore('outbox');
  const outbox = new OutboxService(store);
  store.prepare(`
    INSERT INTO channel_state (workspace_id, channel_id, last_human_message_at, consecutive_bot_messages)
    VALUES ('ws-main', 'telegram:chat', '2026-06-19T00:00:00.000Z', 0)
  `).run();

  const row = outbox.request({
    dedupeKey: 'proactive_post:1',
    workspaceId: 'ws-main',
    correlationId: 'corr:1',
    audience: 'community',
    channelId: 'telegram:chat',
    kind: 'proactive_post',
    content: { text: 'first' },
    suppressIfKillSwitch: true,
    triggerAt: new Date('2026-06-19T00:01:00.000Z'),
  });
  assert.equal(outbox.request({ ...row, content: { text: 'duplicate' } }).dedupeKey, row.dedupeKey);

  outbox.movePendingToSending(row.dedupeKey, {
    now: new Date('2026-06-19T00:02:00.000Z'),
    maxConsecutiveBotMessages: 1,
  });
  const second = outbox.request({
    dedupeKey: 'proactive_post:2',
    workspaceId: 'ws-main',
    correlationId: 'corr:2',
    audience: 'community',
    channelId: 'telegram:chat',
    kind: 'proactive_post',
    content: { text: 'second' },
    suppressIfKillSwitch: true,
    triggerAt: new Date('2026-06-19T00:02:00.000Z'),
  });
  outbox.movePendingToSending(second.dedupeKey, {
    now: new Date('2026-06-19T00:02:01.000Z'),
    maxConsecutiveBotMessages: 1,
  });
  assert.equal(outbox.get(second.dedupeKey)?.status, 'dropped');

  outbox.markSent(row.dedupeKey, 'platform-1', new Date('2026-06-19T00:02:05.000Z'));
  const sending = outbox.request({
    dedupeKey: 'reply:corr:ambiguous',
    workspaceId: 'ws-main',
    correlationId: 'corr:ambiguous',
    audience: 'community',
    channelId: 'telegram:chat',
    kind: 'reply',
    content: { text: 'reply' },
    suppressIfKillSwitch: false,
    triggerAt: new Date('2026-06-19T00:03:00.000Z'),
  });
  outbox.movePendingToSending(sending.dedupeKey, { now: new Date('2026-06-19T00:03:01.000Z'), maxConsecutiveBotMessages: 1 });
  outbox.reconcileAfterRestart(new Date('2026-06-19T00:20:00.000Z'), 10 * 60 * 1000);
  assert.equal(outbox.get(sending.dedupeKey)?.status, 'ambiguous');
});

test('reply.generated is written to the same outbox with a reply namespaced key', async () => {
  const store = createTestStore('reply-outbox');
  const observability = new ObservabilityService(store);
  const bus = new EventBus({ observability });
  const outbox = new OutboxService(store);
  outbox.registerBusConsumer(bus);

  await bus.emit(
    'reply.generated',
    createEnvelope({
      name: 'reply.generated',
      workspaceId: 'ws-main',
      correlationId: 'corr:reply-path',
      subjectUserId: 'telegram:u1',
    }),
    {
      trigger: {
        id: 'telegram:chat:1',
        platform: 'telegram',
        channelId: 'telegram:chat',
        sender: { id: 'telegram:u1', isAdmin: false },
        content: { text: 'hello' },
        timestamp: new Date('2026-06-19T00:00:00.000Z').toISOString(),
      },
      intent: { category: 'question', confidence: 1, mustReply: true },
      retrieval: [],
      directives: [],
      text: 'hi back',
    },
    'system',
  );

  const row = outbox.get('reply:corr:reply-path');
  assert.equal(row.status, 'pending');
  assert.equal(row.kind, 'reply');
  assert.equal(row.channelId, 'telegram:chat');
  assert.match(row.payloadJson, /hi back/);
  // A reply is reactive: it must NOT be proactive-kill-switch-suppressed (/quiet keeps replies).
  assert.equal(row.suppressIfKillSwitch, 0);
});

test('DataLifecycleService is the bounded cross-owner delete/redaction plane', async () => {
  const store = createTestStore('lifecycle');
  store.prepare(`
    INSERT INTO messages (id, workspace_id, platform, channel_id, platform_message_id, sender_id, text, created_at)
    VALUES ('m1', 'ws-main', 'telegram', 'telegram:chat', '1', 'telegram:u1', 'erase me', '2026-06-01T00:00:00.000Z')
  `).run();
  store.prepare(`
    INSERT INTO command_attempts (workspace_id, sender_id, text, created_at)
    VALUES ('ws-main', 'telegram:u1', '/ban', '2026-06-19T00:00:00.000Z')
  `).run();
  store.prepare(`
    INSERT INTO leads (workspace_id, user_id, evidence_json, created_at)
    VALUES ('ws-main', 'telegram:u1', '{"text":"secret"}', '2026-06-19T00:00:00.000Z')
  `).run();
  store.prepare(`
    INSERT INTO event_journal (name, kind, workspace_id, correlation_id, subject_user_id, privacy_tier, reason, payload_digest, at)
    VALUES ('message.clean', 'event', 'ws-main', 'corr:forget', 'telegram:u1', 'user_payload_digest', 'secret reason', 'secret', '2026-06-19T00:00:00.000Z')
  `).run();

  const lifecycle = new DataLifecycleService(store);
  const result = lifecycle.forget({ workspaceId: 'ws-main', userId: 'telegram:u1', correlationId: 'corr:forget' });
  assert.equal(result.deleted > 0, true);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  assert.deepEqual(store.prepare('SELECT reason, payload_digest AS payloadDigest FROM event_journal').get(), {
    reason: '[redacted]',
    payloadDigest: '[redacted]',
  });
});

test('owner outbound notices use suppressIfKillSwitch=false and are still journaled', async () => {
  const store = createTestStore('owner-notice');
  const observability = new ObservabilityService(store);
  const bus = new EventBus({ observability });
  await bus.emit(
    'outbound.requested',
    createEnvelope({ name: 'outbound.requested', workspaceId: '__system__', correlationId: 'corr:notice' }),
    {
      kind: 'notice',
      audience: 'owner',
      content: { text: 'runtime hold' },
      dedupeKey: 'system_notice:runtime:abc',
      suppressIfKillSwitch: false,
    },
    'system',
  );
  observability.flush();
  assert.equal(observability.trace('corr:notice').length, 1);
});
