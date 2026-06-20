import type { EventEnvelope } from '../engine/event-bus.ts';
import { isRawScopeDeferredEvent } from '../engine/event-bus.ts';
import type { SQLiteStore } from './store.ts';
import { redactString, skeletonDigest, stableDigest } from './redaction.ts';
import { isoNow, newId } from './ids.ts';

type JournalRow = {
  event_id?: string;
  correlation_id: string;
  causation_id?: string;
  workspace_id: string;
  subject_user_id?: string;
  channel_id?: string;
  platform_message_id?: string;
  contains_user_text: number;
  privacy_tier: string;
  name: string;
  kind: string;
  stage?: string;
  level: string;
  reason?: string;
  payload_digest?: string;
  at: string;
};

export class ObservabilityService {
  private readonly store: SQLiteStore;
  private readonly buffer: JournalRow[] = [];
  private scheduled = false;

  constructor(store: SQLiteStore) {
    this.store = store;
  }

  recordEvent(name: string, envelope: EventEnvelope, payload: any, producer = 'system'): void {
    const skeleton = envelope.workspaceId === '' && isRawScopeDeferredEvent(name);
    this.enqueue({
      event_id: envelope.eventId,
      correlation_id: envelope.correlationId,
      causation_id: envelope.causationId,
      workspace_id: envelope.workspaceId,
      subject_user_id: envelope.subjectUserId,
      channel_id: payload?.channelId,
      platform_message_id: payload?.messageId ?? payload?.platformMessageId,
      contains_user_text: skeleton ? 0 : containsUserText(payload),
      privacy_tier: skeleton ? 'audit_skeleton' : 'user_payload_digest',
      name,
      kind: 'event',
      stage: producer,
      level: 'info',
      payload_digest: skeleton ? skeletonDigest(payload) : stableDigest(payload),
      at: envelope.timestamp ?? envelope.at,
    });
  }

  traceDecision(input: { workspaceId: string; correlationId: string; name: string; reason: string; subjectUserId?: string }): void {
    this.enqueue({
      event_id: newId('trace'),
      correlation_id: input.correlationId,
      workspace_id: input.workspaceId,
      subject_user_id: input.subjectUserId,
      contains_user_text: 0,
      privacy_tier: 'audit_skeleton',
      name: input.name,
      kind: 'decision',
      level: 'info',
      reason: input.reason,
      payload_digest: stableDigest({ reason: input.reason }),
      at: isoNow(),
    });
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const rows = this.buffer.splice(0);
    this.scheduled = false;
    const insert = this.store.prepare(`
      INSERT INTO event_journal (
        event_id, correlation_id, causation_id, workspace_id, subject_user_id, channel_id,
        platform_message_id, contains_user_text, privacy_tier, name, kind, stage, level,
        reason, payload_digest, at
      ) VALUES (
        @event_id, @correlation_id, @causation_id, @workspace_id, @subject_user_id, @channel_id,
        @platform_message_id, @contains_user_text, @privacy_tier, @name, @kind, @stage, @level,
        @reason, @payload_digest, @at
      )
    `);
    this.store.transaction(() => {
      for (const row of rows) insert.run(row);
    });
  }

  trace(correlationId: string): any[] {
    this.flush();
    return this.store.prepare(`
      SELECT
        id, event_id AS eventId, correlation_id AS correlationId, causation_id AS causationId,
        workspace_id AS workspaceId, subject_user_id AS subjectUserId, channel_id AS channelId,
        privacy_tier AS privacyTier, name, kind, stage, level, reason, payload_digest AS payloadDigest, at
      FROM event_journal
      WHERE correlation_id = ?
      ORDER BY at, id
    `).all(correlationId);
  }

  tail(limit: number): any[] {
    this.flush();
    return this.store.prepare(`
      SELECT
        id, correlation_id AS correlationId, workspace_id AS workspaceId,
        subject_user_id AS subjectUserId, privacy_tier AS privacyTier,
        name, kind, level, reason, payload_digest AS payloadDigest, at
      FROM event_journal
      ORDER BY id DESC
      LIMIT ?
    `).all(limit).reverse();
  }

  inspect(target: string): any[] {
    this.flush();
    const redactedTarget = redactString(target);
    return this.store.prepare(`
      SELECT
        id, correlation_id AS correlationId, workspace_id AS workspaceId,
        subject_user_id AS subjectUserId, channel_id AS channelId,
        privacy_tier AS privacyTier, name, kind, level, reason, payload_digest AS payloadDigest, at
      FROM event_journal
      WHERE workspace_id = @target
         OR subject_user_id = @target
         OR channel_id = @target
         OR correlation_id = @target
         OR payload_digest LIKE @likeTarget
      ORDER BY at, id
    `).all({ target, likeTarget: `%${redactedTarget}%` });
  }

  private enqueue(row: JournalRow): void {
    this.buffer.push({
      event_id: row.event_id ?? null,
      correlation_id: row.correlation_id,
      causation_id: row.causation_id ?? null,
      workspace_id: row.workspace_id,
      subject_user_id: row.subject_user_id ?? null,
      channel_id: row.channel_id ?? null,
      platform_message_id: row.platform_message_id ?? null,
      contains_user_text: row.contains_user_text,
      privacy_tier: row.privacy_tier,
      name: row.name,
      kind: row.kind,
      stage: row.stage ?? null,
      level: row.level,
      reason: row.reason ?? null,
      payload_digest: row.payload_digest ?? null,
      at: row.at,
    } as JournalRow);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.flush());
    }
  }
}

function containsUserText(payload: any): number {
  if (typeof payload?.content?.text === 'string') return 1;
  if (typeof payload?.text === 'string') return 1;
  if (typeof payload?.message?.content?.text === 'string') return 1;
  return 0;
}
