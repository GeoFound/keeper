import { SQLiteStore } from '../../src/services/store.ts';
import { OutboxService } from '../../src/services/outbox.ts';
import { InboundLifecycle } from '../../src/services/inbound-lifecycle.ts';
import { writeSync } from 'node:fs';

const [, , scenario, dbPath] = process.argv;
if (!scenario || !dbPath) throw new Error('usage: crash-child <scenario> <dbPath>');

const store = new SQLiteStore(dbPath);

if (scenario === 'outbox-sending') {
  const outbox = new OutboxService(store);
  outbox.request({
    dedupeKey: 'reply:corr:crash',
    workspaceId: 'ws-main',
    correlationId: 'corr:crash',
    audience: 'community',
    channelId: 'telegram:chat',
    kind: 'reply',
    content: { text: 'reply before crash' },
    suppressIfKillSwitch: false,
    triggerAt: new Date('2026-06-19T00:03:00.000Z'),
  });
  outbox.movePendingToSending('reply:corr:crash', {
    now: new Date('2026-06-19T00:03:01.000Z'),
    maxConsecutiveBotMessages: 2,
  });
}

if (scenario === 'inbound-after-message-before-outbox') {
  const inbound = new InboundLifecycle(store);
  inbound.claim('telegram:update:crash', {
    platform: 'telegram',
    channelId: 'native-chat',
    platformMessageId: '55',
    updateKind: 'message',
    updateIdentity: 'update-crash',
    receivedAt: new Date('2026-06-19T00:00:00.000Z'),
  });
  inbound.persistRoutedMessage('telegram:update:crash', {
    id: 'telegram:native-chat:55',
    workspaceId: 'ws-main',
    channelId: 'telegram:native-chat',
    userId: 'telegram:user',
    text: 'hello from killed process',
  });
}

if (scenario === 'inbound-aborted') {
  const inbound = new InboundLifecycle(store);
  inbound.claim('telegram:update:abort', {
    platform: 'telegram',
    channelId: 'native-chat',
    platformMessageId: '56',
    updateKind: 'message',
    updateIdentity: 'update-abort',
    receivedAt: new Date('2026-06-19T00:00:00.000Z'),
  });
  inbound.persistRoutedMessage('telegram:update:abort', {
    id: 'telegram:native-chat:56',
    workspaceId: 'ws-main',
    channelId: 'telegram:native-chat',
    userId: 'telegram:user',
    text: 'aborted before reply',
  });
  inbound.commitForPipelineFailure('telegram:update:abort', {
    workspaceId: 'ws-main',
    correlationId: 'corr:telegram:native-chat:56',
    stage: 'persona',
    kind: 'error',
    reason: 'seeded failure',
  });
}

store.close();
writeSync(1, 'ready\n');
process.kill(process.pid, 'SIGKILL');
