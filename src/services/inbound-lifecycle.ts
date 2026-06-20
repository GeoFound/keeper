import type { SQLiteStore } from './store.ts';

type ClaimInput = {
  platform: string;
  channelId: string;
  platformMessageId: string;
  updateKind: string;
  updateIdentity: string;
  correlationId?: string;
  receivedAt: Date;
};

type MessageInput = {
  id: string;
  workspaceId: string;
  platform?: string;
  channelId: string;
  platformMessageId?: string;
  userId: string;
  senderName?: string;
  text: string;
  correlationId?: string;
};

export class InboundLifecycle {
  private readonly store: SQLiteStore;

  constructor(store: SQLiteStore) {
    this.store = store;
  }

  claim(updateKey: string, input: ClaimInput): any {
    const correlationId = input.correlationId ?? `corr:${input.platform}:${input.channelId}:${input.platformMessageId}`;
    this.store.prepare(`
      INSERT OR IGNORE INTO inbound_updates (
        id, platform, channel_id, platform_message_id, update_kind,
        update_identity, correlation_id, status, received_at
      ) VALUES (
        @id, @platform, @channel_id, @platform_message_id, @update_kind,
        @update_identity, @correlation_id, 'pending', @received_at
      )
    `).run({
      id: updateKey,
      platform: input.platform,
      channel_id: input.channelId,
      platform_message_id: input.platformMessageId,
      update_kind: input.updateKind,
      update_identity: input.updateIdentity,
      correlation_id: correlationId,
      received_at: input.receivedAt.toISOString(),
    });
    return this.get(updateKey);
  }

  persistRoutedMessage(updateKey: string, input: MessageInput): any {
    const inbound = this.get(updateKey);
    if (!inbound) throw new Error(`missing inbound update ${updateKey}`);
    const correlationId = input.correlationId ?? inbound.correlationId;
    this.store.prepare(`
      INSERT INTO messages (
        id, workspace_id, correlation_id, platform, channel_id, platform_message_id,
        sender_id, sender_name, text
      ) VALUES (
        @id, @workspace_id, @correlation_id, @platform, @channel_id, @platform_message_id,
        @sender_id, @sender_name, @text
      )
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      id: input.id,
      workspace_id: input.workspaceId,
      correlation_id: correlationId,
      platform: input.platform ?? 'telegram',
      channel_id: input.channelId,
      platform_message_id: input.platformMessageId ?? inbound.platformMessageId,
      sender_id: input.userId,
      sender_name: input.senderName,
      text: input.text,
    });
    return this.store.prepare('SELECT * FROM messages WHERE id = ?').get(input.id);
  }

  restartRedrive(now: Date, maxStalenessMs: number): any[] {
    return this.store.transaction(() => {
      const staleCutoff = new Date(now.getTime() - maxStalenessMs).toISOString();
      this.store.prepare(`
        UPDATE inbound_updates
        SET status = 'committed', committed_at = @now
        WHERE status = 'pending'
          AND datetime(received_at) < datetime(@stale_cutoff)
      `).run({ now: now.toISOString(), stale_cutoff: staleCutoff });

      return this.store.prepare(`
        SELECT
          u.id AS updateKey,
          u.correlation_id AS correlationId,
          m.id AS messageId,
          m.workspace_id AS workspaceId,
          m.channel_id AS channelId,
          m.sender_id AS userId,
          m.text AS text
        FROM inbound_updates u
        JOIN messages m ON m.correlation_id = u.correlation_id
        WHERE u.status = 'pending'
        ORDER BY u.received_at, u.id
      `).all();
    });
  }

  commitForPipelineFailure(updateKey: string, input: { workspaceId: string; correlationId: string; stage: string; kind: string; reason: string }): any {
    this.store.transaction(() => {
      this.store.prepare(`
        INSERT OR IGNORE INTO pipeline_failures (workspace_id, correlation_id, stage, kind, reason)
        VALUES (@workspace_id, @correlation_id, @stage, @kind, @reason)
      `).run({
        workspace_id: input.workspaceId,
        correlation_id: input.correlationId,
        stage: input.stage,
        kind: input.kind,
        reason: input.reason,
      });
      this.store.prepare(`
        UPDATE inbound_updates
        SET status = 'committed', committed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(updateKey);
    });
    return this.get(updateKey);
  }

  get(updateKey: string): any {
    return this.store.prepare(`
      SELECT
        id AS updateKey,
        platform,
        channel_id AS channelId,
        platform_message_id AS platformMessageId,
        update_kind AS updateKind,
        update_identity AS updateIdentity,
        correlation_id AS correlationId,
        status,
        received_at AS receivedAt,
        committed_at AS committedAt
      FROM inbound_updates
      WHERE id = ?
    `).get(updateKey);
  }
}
