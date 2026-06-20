import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from '../support/test-store.ts';
import { InboundLifecycle } from '../../src/services/inbound-lifecycle.ts';

test('inbound_updates re-drive after routing and commit after pipeline abort', () => {
  const store = createTestStore('inbound');
  const inbound = new InboundLifecycle(store);
  const updateKey = 'telegram:update:1';

  inbound.claim(updateKey, {
    platform: 'telegram',
    channelId: 'native-chat',
    platformMessageId: '55',
    updateKind: 'message',
    updateIdentity: 'update-1',
    receivedAt: new Date('2026-06-19T00:00:00.000Z'),
  });
  inbound.persistRoutedMessage(updateKey, {
    id: 'telegram:native-chat:55',
    workspaceId: 'ws-main',
    channelId: 'telegram:native-chat',
    userId: 'telegram:user',
    text: 'hello',
  });

  const redriven = inbound.restartRedrive(new Date('2026-06-19T00:01:00.000Z'), 10 * 60 * 1000);
  assert.deepEqual(redriven.map((row) => row.messageId), ['telegram:native-chat:55']);

  inbound.commitForPipelineFailure(updateKey, {
    workspaceId: 'ws-main',
    correlationId: 'corr:telegram:native-chat:55',
    stage: 'persona',
    kind: 'error',
    reason: 'seeded failure',
  });

  assert.equal(inbound.get(updateKey).status, 'committed');
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM pipeline_failures').get().count, 1);
  assert.equal(inbound.restartRedrive(new Date('2026-06-19T00:02:00.000Z'), 10 * 60 * 1000).length, 0);
});

test('pending without a persisted message waits for platform replay and stale pending commits', () => {
  const store = createTestStore('inbound-stale');
  const inbound = new InboundLifecycle(store);
  inbound.claim('telegram:update:2', {
    platform: 'telegram',
    channelId: 'native-chat',
    platformMessageId: '56',
    updateKind: 'message',
    updateIdentity: 'update-2',
    receivedAt: new Date('2026-06-19T00:00:00.000Z'),
  });

  assert.equal(inbound.restartRedrive(new Date('2026-06-19T00:01:00.000Z'), 10 * 60 * 1000).length, 0);
  inbound.restartRedrive(new Date('2026-06-19T00:20:00.000Z'), 10 * 60 * 1000);
  assert.equal(inbound.get('telegram:update:2').status, 'committed');
});
