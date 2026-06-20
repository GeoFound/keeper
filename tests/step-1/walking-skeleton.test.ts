import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from '../support/test-store.ts';
import { createEchoHarness } from '../../src/engine/walking-skeleton.ts';
import { createEnvelope } from '../../src/engine/event-bus.ts';

test('test/development Echo harness wires inbound bus to unified outbox', async () => {
  const store = createTestStore('echo-harness');
  const { engine, bus, outbox, observability } = createEchoHarness({ store, environment: 'test' });
  await engine.start();

  await bus.emit(
    'message.received',
    createEnvelope({
      name: 'message.received',
      workspaceId: 'ws-main',
      correlationId: 'corr:echo:1',
      subjectUserId: 'telegram:u1',
    }),
    {
      id: 'telegram:chat:m1',
      platform: 'telegram',
      channelId: 'telegram:chat',
      sender: { id: 'telegram:u1', isAdmin: false },
      content: { text: 'hello' },
      timestamp: new Date('2026-06-19T00:00:00.000Z').toISOString(),
      raw: {},
    },
    'system',
  );

  observability.flush();
  assert.equal(engine.isRunning(), true);
  assert.equal(outbox.get('echo:corr:echo:1')?.status, 'pending');
  assert.equal(observability.trace('corr:echo:1').map((row) => row.name).includes('outbound.requested'), true);
});

test('Echo harness is rejected in production', () => {
  assert.throws(() => createEchoHarness({ store: createTestStore('echo-prod'), environment: 'production' }), /restricted/);
});

test('engine.start() runs crash recovery: reconciles the outbox and re-drives inbound', async () => {
  const store = createTestStore('recovery-on-start');
  const t0 = new Date('2026-06-19T00:00:00.000Z');
  const recoverAt = new Date('2026-06-19T00:20:00.000Z');
  const { engine, outbox, inbound, observability } = createEchoHarness({
    store,
    environment: 'test',
    now: () => recoverAt,
  });

  // State a crash would leave behind: an outbox row that reached 'sending' (unknown remote
  // outcome) and an inbound update that was routed (messages row persisted) but never reached
  // its terminal outbox row.
  outbox.request({
    dedupeKey: 'reply:corr:recover',
    workspaceId: 'ws-main',
    correlationId: 'corr:recover',
    audience: 'community',
    channelId: 'telegram:chat',
    kind: 'reply',
    content: { text: 'half-sent before crash' },
    suppressIfKillSwitch: false,
    triggerAt: t0,
  });
  outbox.movePendingToSending('reply:corr:recover', { now: t0, maxConsecutiveBotMessages: 2 });

  inbound.claim('telegram:update:recover', {
    platform: 'telegram',
    channelId: 'native-chat',
    platformMessageId: '77',
    updateKind: 'message',
    updateIdentity: 'update-recover',
    correlationId: 'corr:recover-inbound',
    receivedAt: recoverAt,
  });
  inbound.persistRoutedMessage('telegram:update:recover', {
    id: 'telegram:native-chat:77',
    workspaceId: 'ws-main',
    channelId: 'telegram:native-chat',
    userId: 'telegram:u9',
    text: 'routed before crash',
  });

  // start() must drive recovery automatically — not a manual reconcile/redrive call.
  await engine.start();
  observability.flush();

  assert.equal(outbox.get('reply:corr:recover')?.status, 'ambiguous');
  assert.equal(
    observability.trace('corr:recover-inbound').map((row) => row.name).includes('message.routed'),
    true,
  );
});
