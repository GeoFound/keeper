import type { SQLiteStore } from './store.ts';

export class DataLifecycleService {
  private readonly store: SQLiteStore;

  constructor(store: SQLiteStore) {
    this.store = store;
  }

  forget(input: { workspaceId: string; userId: string; correlationId: string }): { deleted: number; redacted: number } {
    return this.store.transaction(() => {
      let deleted = 0;
      deleted += this.store.prepare(`
        DELETE FROM messages
        WHERE workspace_id = @workspace_id AND sender_id = @user_id
      `).run({ workspace_id: input.workspaceId, user_id: input.userId }).changes;
      deleted += this.store.prepare(`
        DELETE FROM command_attempts
        WHERE workspace_id = @workspace_id AND sender_id = @user_id
      `).run({ workspace_id: input.workspaceId, user_id: input.userId }).changes;
      deleted += this.store.prepare(`
        DELETE FROM leads
        WHERE workspace_id = @workspace_id AND user_id = @user_id
      `).run({ workspace_id: input.workspaceId, user_id: input.userId }).changes;

      const redacted = this.store.prepare(`
        UPDATE event_journal
        SET payload_digest = CASE WHEN payload_digest IS NULL THEN NULL ELSE '[redacted]' END,
            reason = CASE WHEN reason IS NULL THEN NULL ELSE '[redacted]' END,
            redacted_at = CURRENT_TIMESTAMP
        WHERE workspace_id = @workspace_id AND subject_user_id = @user_id
      `).run({ workspace_id: input.workspaceId, user_id: input.userId }).changes;
      return { deleted, redacted };
    });
  }

  sweep(now: Date, retentionDays: number): { deleted: number } {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.store.transaction(() => {
      let deleted = 0;
      deleted += this.store.prepare(`
        DELETE FROM messages WHERE datetime(created_at) < datetime(@cutoff)
      `).run({ cutoff }).changes;
      deleted += this.store.prepare(`
        DELETE FROM event_journal WHERE datetime(at) < datetime(@cutoff)
      `).run({ cutoff }).changes;
      deleted += this.store.prepare(`
        DELETE FROM inbound_updates
        WHERE status = 'committed' AND datetime(COALESCE(committed_at, received_at)) < datetime(@cutoff)
      `).run({ cutoff }).changes;
      deleted += this.store.prepare(`
        DELETE FROM outbox
        WHERE status IN ('sent', 'dropped', 'failed', 'ambiguous')
          AND dedupe_key NOT LIKE 'member_notice:%'
          AND datetime(COALESCE(sent_at, trigger_at, created_at)) < datetime(@cutoff)
      `).run({ cutoff }).changes;
      return { deleted };
    });
  }
}
