import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventBus,
  EVENT_SCHEMAS,
  createEnvelope,
  isRawScopeDeferredEvent,
  isSourceScopedEvent,
} from '../../src/engine/event-bus.ts';
import { createTestStore } from '../support/test-store.ts';
import { ObservabilityService } from '../../src/services/observability.ts';

test('bus delivers only declared events and rejects undeclared module emissions', async () => {
  const store = createTestStore('bus-delivers');
  const observability = new ObservabilityService(store);
  const bus = new EventBus({ observability });
  const seen: unknown[] = [];

  bus.registerModule({
    name: 'Probe',
    subscribes: ['outbound.requested'],
    publishes: ['reply.sent'],
    async handle(event) {
      seen.push(event.payload);
    },
  });

  await bus.emit(
    'outbound.requested',
    createEnvelope({
      name: 'outbound.requested',
      workspaceId: 'ws-main',
      correlationId: 'corr:probe',
    }),
    {
      kind: 'notice',
      audience: 'owner',
      content: { text: 'hello' },
      dedupeKey: 'system_notice:probe',
      suppressIfKillSwitch: false,
    },
    'system',
  );

  assert.equal(seen.length, 1);
  await assert.rejects(
    () =>
      bus.emit(
        'message.clean',
        createEnvelope({ name: 'message.clean', workspaceId: 'ws-main', correlationId: 'corr:x' }),
        routedMessage(),
        'Probe',
      ),
    /not declared/,
  );
  assert.throws(
    () =>
      bus.registerModule({
        name: 'BadSubscriber',
        subscribes: ['missing.event'],
        publishes: [],
        handle() {},
      }),
    /unknown event/,
  );
});

test('every catalog event has a schema and envelope scope rules are enforced', async () => {
  assert.equal(Object.keys(EVENT_SCHEMAS).length, 43);
  const store = createTestStore('envelope');
  const bus = new EventBus({ observability: new ObservabilityService(store) });

  await assert.rejects(
    () =>
      bus.emit(
        'message.clean',
        createEnvelope({ name: 'message.clean', workspaceId: '', correlationId: 'corr:bad' }),
        routedMessage(),
        'system',
      ),
    /workspaceId/,
  );

  await assert.rejects(
    () =>
      bus.emit(
        'message.received',
        createEnvelope({ name: 'message.received', workspaceId: '', correlationId: 'corr:raw' }),
        unifiedMessage(),
        'system',
      ),
    /subjectUserId/,
  );

  await bus.emit(
    'knowledge.sync_due',
    createEnvelope({ name: 'knowledge.sync_due', workspaceId: '', correlationId: 'corr:source' }),
    { sourceId: 'src-docs', at: new Date().toISOString() },
    'system',
  );

  await assert.rejects(
    () =>
      bus.emit(
        'knowledge.updated',
        createEnvelope({ name: 'knowledge.updated', workspaceId: '', correlationId: 'corr:bad-source' }),
        { sourceId: '', added: 0, updated: 0, removed: 0 },
        'system',
      ),
    /sourceId|Invalid/,
  );

  await assert.rejects(
    () =>
      bus.emit(
        'knowledge.updated',
        createEnvelope({ name: 'knowledge.updated', workspaceId: 'ws-main', correlationId: 'corr:source-scope' }),
        { sourceId: 'src-docs', added: 0, updated: 0, removed: 0 },
        'system',
      ),
    /workspaceId must be empty/,
  );

  await assert.rejects(
    () =>
      bus.emit(
        'message.routed',
        createEnvelope({ name: 'message.routed', workspaceId: 'ws-main', correlationId: 'corr:routed' }),
        routedMessage(),
        'system',
      ),
    /subjectUserId/,
  );

  await assert.rejects(
    () =>
      bus.emit(
        'control.owner_action',
        createEnvelope({ name: 'control.owner_action', workspaceId: '', correlationId: 'corr:owner' }),
        { senderId: 'telegram:owner', kind: 'command' },
        'system',
      ),
    /subjectUserId/,
  );

  assert.equal(isRawScopeDeferredEvent('inbound.reaction'), true);
  assert.equal(isSourceScopedEvent('knowledge.updated'), true);
});

test('raw empty-workspace events are journaled as skeleton-only with subject stamping', async () => {
  const store = createTestStore('journal-skeleton');
  const observability = new ObservabilityService(store);
  const bus = new EventBus({ observability });

  await bus.emit(
    'message.received',
    createEnvelope({
      name: 'message.received',
      workspaceId: '',
      correlationId: 'corr:raw:1',
      subjectUserId: 'telegram:user-1',
    }),
    unifiedMessage({ sender: { id: 'telegram:user-1', isAdmin: false, displayName: 'Secret Name' }, content: { text: 'secret human text' } }),
    'system',
  );

  const rows = observability.trace('corr:raw:1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subjectUserId, 'telegram:user-1');
  assert.equal(rows[0].privacyTier, 'audit_skeleton');
  assert.equal(rows[0].payloadDigest?.includes('secret human text'), false);
  assert.equal(rows[0].payloadDigest?.includes('Secret Name'), false);
});

test('payload schemas reject malformed catalog payloads', async () => {
  const store = createTestStore('payload-schema');
  const bus = new EventBus({ observability: new ObservabilityService(store) });
  await assert.rejects(
    () =>
      bus.emit(
        'reply.generated',
        createEnvelope({
          name: 'reply.generated',
          workspaceId: 'ws-main',
          correlationId: 'corr:bad-payload',
          subjectUserId: 'telegram:u1',
        }),
        { trigger: unifiedMessage(), directives: [] },
        'system',
      ),
    /ZodError|Invalid/,
  );
});

function unifiedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'telegram:chat:m1',
    platform: 'telegram',
    channelId: 'telegram:chat',
    sender: { id: 'telegram:u1', isAdmin: false },
    content: { text: 'hello' },
    timestamp: new Date('2026-06-19T00:00:00.000Z').toISOString(),
    raw: {},
    ...overrides,
  };
}

function routedMessage() {
  return {
    message: unifiedMessage(),
    workspace: { id: 'ws-main', contentSources: ['src-docs'] },
    allowedSources: ['src-docs'],
  };
}
