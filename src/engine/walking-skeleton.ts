import { EngineCore } from './core.ts';
import { EventBus, createEnvelope } from './event-bus.ts';
import { RecoveryCoordinator } from './recovery.ts';
import { ObservabilityService } from '../services/observability.ts';
import { OutboxService } from '../services/outbox.ts';
import { InboundLifecycle } from '../services/inbound-lifecycle.ts';
import type { SQLiteStore } from '../services/store.ts';

const DEFAULT_MAX_STALENESS_MS = 600_000; // delivery.reply_max_staleness_seconds (600s) default

export function createEchoHarness(input: {
  store: SQLiteStore;
  environment: 'test' | 'development' | 'production';
  maxStalenessMs?: number;
  now?: () => Date;
}) {
  if (input.environment === 'production') {
    throw new Error('echo harness is restricted to test/development');
  }

  const observability = new ObservabilityService(input.store);
  const bus = new EventBus({ observability });
  const outbox = new OutboxService(input.store);
  outbox.registerBusConsumer(bus);
  const inbound = new InboundLifecycle(input.store);
  const engine = new EngineCore(bus);

  // Crash recovery runs automatically on engine.start() (overview inbound_crash_recovery):
  // reconcile the outbox + re-drive interrupted inbound rows BEFORE serving new traffic.
  const recovery = new RecoveryCoordinator({
    bus,
    outbox,
    inbound,
    maxStalenessMs: input.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS,
    now: input.now,
  });
  engine.registerStartupTask(() => recovery.recover());

  engine.register({
    name: 'EchoHarness',
    subscribes: ['message.received'],
    publishes: ['outbound.requested'],
    async handle(event) {
      const message = event.payload as any;
      await bus.emit(
        'outbound.requested',
        createEnvelope({
          name: 'outbound.requested',
          workspaceId: event.envelope.workspaceId || 'ws-main',
          correlationId: event.envelope.correlationId,
          causationId: event.envelope.eventId,
          subjectUserId: event.envelope.subjectUserId,
        }),
        {
          kind: 'notice',
          audience: 'community',
          channelId: message.channelId,
          content: { text: `echo: ${message.content?.text ?? ''}` },
          dedupeKey: `echo:${event.envelope.correlationId}`,
          suppressIfKillSwitch: true,
        },
        'EchoHarness',
      );
    },
    healthCheck() {
      return { ok: true };
    },
  });

  return { engine, bus, outbox, inbound, observability, recovery };
}
