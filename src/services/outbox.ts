import type { EventBus } from '../engine/event-bus.ts';
import type { SQLiteStore } from './store.ts';

type OutboxRequest = {
  dedupeKey: string;
  workspaceId: string;
  correlationId: string;
  audience: string;
  channelId?: string;
  dmUserId?: string;
  kind: string;
  content: unknown;
  suppressIfKillSwitch: boolean;
  triggerAt: Date | string;
  postSendActions?: Record<string, unknown>;
};

export class OutboxService {
  private readonly store: SQLiteStore;

  constructor(store: SQLiteStore) {
    this.store = store;
  }

  registerBusConsumer(bus: EventBus): void {
    bus.registerModule({
      name: 'Platform Adapter',
      subscribes: ['outbound.requested', 'reply.generated'],
      publishes: ['outbound.sent', 'reply.sent'],
      handle: async (event) => {
        if (event.envelope.name === 'outbound.requested') {
          const payload = event.payload as any;
          this.request({
            dedupeKey: payload.dedupeKey,
            workspaceId: event.envelope.workspaceId,
            correlationId: event.envelope.correlationId,
            audience: payload.audience,
            channelId: payload.channelId,
            dmUserId: payload.userId,
            kind: payload.kind,
            content: payload.content,
            suppressIfKillSwitch: payload.suppressIfKillSwitch,
            triggerAt: payload.triggerAt ?? new Date(),
            postSendActions: payload.postSendActions,
          });
        }
      },
    });
  }

  request(input: OutboxRequest): any {
    this.store.prepare(`
      INSERT OR IGNORE INTO outbox (
        dedupe_key, workspace_id, correlation_id, via, channel_id, dm_user_id, kind,
        payload_json, suppress_if_kill_switch, post_send_actions_json, status, not_before, trigger_at
      ) VALUES (
        @dedupe_key, @workspace_id, @correlation_id, @via, @channel_id, @dm_user_id, @kind,
        @payload_json, @suppress_if_kill_switch, @post_send_actions_json, 'pending', @trigger_at, @trigger_at
      )
    `).run({
      dedupe_key: input.dedupeKey,
      workspace_id: input.workspaceId,
      correlation_id: input.correlationId,
      via: input.audience === 'owner' ? 'control_bot' : 'userbot',
      channel_id: input.channelId,
      dm_user_id: input.dmUserId,
      kind: input.kind,
      payload_json: JSON.stringify(input.content),
      suppress_if_kill_switch: input.suppressIfKillSwitch ? 1 : 0,
      post_send_actions_json: input.postSendActions ? JSON.stringify(input.postSendActions) : null,
      trigger_at: new Date(input.triggerAt).toISOString(),
    });
    return this.get(input.dedupeKey);
  }

  movePendingToSending(dedupeKey: string, input: { now: Date; maxConsecutiveBotMessages: number }): any {
    return this.store.transaction(() => {
      const row = this.get(dedupeKey);
      if (!row || row.status !== 'pending') return row;
      if (row.triggerAt && new Date(row.triggerAt).getTime() > input.now.getTime()) return row;

      if (this.shouldReserveBotTurn(row)) {
        const count = this.reservedBotTurnsSinceLastHuman(row, input.now);
        if (count >= input.maxConsecutiveBotMessages) {
          this.store.prepare(`
            UPDATE outbox
            SET status = 'dropped', last_error = 'consecutive_bot_cap'
            WHERE dedupe_key = ?
          `).run(dedupeKey);
          return this.get(dedupeKey);
        }
        this.store.prepare(`
          UPDATE outbox
          SET bot_turn_reserved = 1, bot_turn_reserved_at = @now
          WHERE dedupe_key = @dedupe_key
        `).run({ dedupe_key: dedupeKey, now: input.now.toISOString() });
      }

      this.store.prepare(`
        UPDATE outbox
        SET status = 'sending',
            attempts = attempts + 1,
            send_started_at = @now,
            sending_lease_until = @lease
        WHERE dedupe_key = @dedupe_key AND status = 'pending'
      `).run({
        dedupe_key: dedupeKey,
        now: input.now.toISOString(),
        lease: new Date(input.now.getTime() + 60_000).toISOString(),
      });
      return this.get(dedupeKey);
    });
  }

  markSent(dedupeKey: string, platformMessageId: string, sentAt: Date): any {
    this.store.prepare(`
      UPDATE outbox
      SET status = 'sent', platform_message_id = @platform_message_id, sent_at = @sent_at
      WHERE dedupe_key = @dedupe_key
    `).run({ dedupe_key: dedupeKey, platform_message_id: platformMessageId, sent_at: sentAt.toISOString() });
    return this.get(dedupeKey);
  }

  reconcileAfterRestart(now: Date, maxStalenessMs: number): void {
    this.store.transaction(() => {
      this.store.prepare(`
        UPDATE outbox
        SET status = 'ambiguous', last_error = 'sending_unknown_after_restart'
        WHERE status = 'sending'
          AND datetime(COALESCE(sending_lease_until, send_started_at)) <= datetime(@now)
      `).run({ now: now.toISOString() });

      const staleCutoff = new Date(now.getTime() - maxStalenessMs).toISOString();
      this.store.prepare(`
        UPDATE outbox
        SET status = 'dropped', last_error = 'stale_trigger'
        WHERE status = 'pending'
          AND datetime(trigger_at) < datetime(@stale_cutoff)
      `).run({ stale_cutoff: staleCutoff });
    });
  }

  get(dedupeKey: string): any {
    return this.store.prepare(`
      SELECT
        dedupe_key AS dedupeKey,
        workspace_id AS workspaceId,
        correlation_id AS correlationId,
        via,
        channel_id AS channelId,
        dm_user_id AS dmUserId,
        kind,
        payload_json AS payloadJson,
        suppress_if_kill_switch AS suppressIfKillSwitch,
        bot_turn_reserved AS botTurnReserved,
        bot_turn_reserved_at AS botTurnReservedAt,
        status,
        attempts,
        not_before AS notBefore,
        trigger_at AS triggerAt,
        send_started_at AS sendStartedAt,
        sending_lease_until AS sendingLeaseUntil,
        platform_message_id AS platformMessageId,
        last_error AS lastError,
        created_at AS createdAt,
        sent_at AS sentAt
      FROM outbox
      WHERE dedupe_key = ?
    `).get(dedupeKey);
  }

  private shouldReserveBotTurn(row: any): boolean {
    return row.via === 'userbot' && row.kind !== 'reply' && Number(row.suppressIfKillSwitch) === 1;
  }

  private reservedBotTurnsSinceLastHuman(row: any, now: Date): number {
    const channel = this.store.prepare(`
      SELECT last_human_message_at AS lastHumanMessageAt
      FROM channel_state
      WHERE workspace_id = ? AND channel_id = ?
    `).get(row.workspaceId, row.channelId) as any;
    const floor = channel?.lastHumanMessageAt ?? '1970-01-01T00:00:00.000Z';
    const result = this.store.prepare(`
      SELECT COUNT(*) AS count
      FROM outbox
      WHERE workspace_id = @workspace_id
        AND channel_id = @channel_id
        AND bot_turn_reserved = 1
        AND status IN ('pending', 'sending', 'sent', 'ambiguous')
        AND datetime(COALESCE(bot_turn_reserved_at, sent_at, send_started_at, created_at)) >= datetime(@floor)
        AND datetime(COALESCE(bot_turn_reserved_at, sent_at, send_started_at, created_at)) <= datetime(@now)
    `).get({
      workspace_id: row.workspaceId,
      channel_id: row.channelId,
      floor,
      now: now.toISOString(),
    }) as any;
    return Number(result.count);
  }
}
