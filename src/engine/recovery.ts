import type { EventBus } from './event-bus.ts';
import { createEnvelope } from './event-bus.ts';
import type { OutboxService } from '../services/outbox.ts';
import type { InboundLifecycle } from '../services/inbound-lifecycle.ts';

// Crash-recovery boot step (overview operations.idempotent_delivery.inbound_crash_recovery +
// crash_safety). Run ONCE on engine start, BEFORE serving new traffic, so both halves of the
// journey are reconciled deterministically:
//   1. Outbox: expired 'sending' rows -> 'ambiguous', stale 'pending' rows -> 'dropped'
//      (no blind retry of an unknown remote outcome).
//   2. Inbound: 'pending' rows that HAVE a persisted messages row are re-driven by re-emitting
//      message.routed (the engine is the infra producer here — the Workspace Router module does
//      not exist until build_order step 3); 'pending' rows with no messages row are left to
//      platform redelivery; stale pending rows are committed without re-drive.
// The recovery primitives themselves (OutboxService.reconcileAfterRestart /
// InboundLifecycle.restartRedrive) are proven against a REAL process kill in
// tests/step-1/real-crash.test.ts; this wires them into the lifecycle so a real boot recovers
// automatically instead of leaving it to a manual call.
export type AllowedSourcesResolver = (workspaceId: string) => string[];

export class RecoveryCoordinator {
  private readonly bus: EventBus;
  private readonly outbox: OutboxService;
  private readonly inbound: InboundLifecycle;
  private readonly maxStalenessMs: number;
  private readonly now: () => Date;
  private readonly resolveAllowedSources: AllowedSourcesResolver;

  constructor(input: {
    bus: EventBus;
    outbox: OutboxService;
    inbound: InboundLifecycle;
    maxStalenessMs: number;
    now?: () => Date;
    resolveAllowedSources?: AllowedSourcesResolver;
  }) {
    this.bus = input.bus;
    this.outbox = input.outbox;
    this.inbound = input.inbound;
    this.maxStalenessMs = input.maxStalenessMs;
    this.now = input.now ?? (() => new Date());
    this.resolveAllowedSources = input.resolveAllowedSources ?? (() => []);
  }

  async recover(): Promise<{ outboxReconciled: boolean; redriven: number }> {
    const now = this.now();
    this.outbox.reconcileAfterRestart(now, this.maxStalenessMs);

    const redriven = this.inbound.restartRedrive(now, this.maxStalenessMs);
    for (const row of redriven) {
      await this.bus.emit(
        'message.routed',
        createEnvelope({
          name: 'message.routed',
          workspaceId: row.workspaceId,
          correlationId: row.correlationId,
          subjectUserId: row.userId,
        }),
        {
          message: {
            id: row.messageId,
            platform: 'telegram',
            channelId: row.channelId,
            sender: { id: row.userId },
            content: { text: row.text },
            timestamp: now.toISOString(),
          },
          workspace: { id: row.workspaceId },
          allowedSources: this.resolveAllowedSources(row.workspaceId),
        },
        'engine',
      );
    }

    return { outboxReconciled: true, redriven: redriven.length };
  }
}
