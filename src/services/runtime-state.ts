import type { EventBus } from '../engine/event-bus.ts';
import { createEnvelope } from '../engine/event-bus.ts';
import type { SQLiteStore } from './store.ts';
import { isoNow } from './ids.ts';

export type RuntimeEnterInput = {
  workspaceId: string;
  scopeType: string;
  scopeId: string;
  mode: string;
  reason: string;
  channelId?: string;
  details?: Record<string, unknown>;
  until?: Date;
};

function runtimeId(input: RuntimeEnterInput): string {
  return `runtime:${input.workspaceId}:${input.scopeType}:${input.scopeId}:${input.mode}:${input.reason}`;
}

export class RuntimeStateService {
  private readonly store: SQLiteStore;
  private readonly bus: EventBus;

  constructor(store: SQLiteStore, bus: EventBus) {
    this.store = store;
    this.bus = bus;
  }

  async enter(input: RuntimeEnterInput): Promise<any> {
    const id = runtimeId(input);
    const inserted = this.store.transaction(() => {
      const result = this.store.prepare(`
        INSERT OR IGNORE INTO workspace_runtime_state (
          id, workspace_id, scope_type, scope_id, channel_id, mode, reason,
          status, details_json, until, created_at, updated_at
        ) VALUES (
          @id, @workspace_id, @scope_type, @scope_id, @channel_id, @mode, @reason,
          'active', @details_json, @until, @now, @now
        )
      `).run({
        id,
        workspace_id: input.workspaceId,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        channel_id: input.channelId,
        mode: input.mode,
        reason: input.reason,
        details_json: input.details ? JSON.stringify(input.details) : null,
        until: input.until?.toISOString(),
        now: isoNow(),
      });
      return result.changes === 1;
    });

    const row = this.store.prepare(`
      SELECT id, workspace_id AS workspaceId, scope_type AS scopeType, scope_id AS scopeId,
             channel_id AS channelId, mode, reason, status, details_json AS detailsJson,
             until, resolved_at AS resolvedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM workspace_runtime_state
      WHERE id = ?
    `).get(id);

    if (inserted && input.reason !== 'control_bot_token_invalid') {
      await this.bus.emit(
        'outbound.requested',
        createEnvelope({
          name: 'outbound.requested',
          workspaceId: input.workspaceId || '__system__',
          correlationId: `runtime:${id}`,
        }),
        {
          kind: 'notice',
          audience: 'owner',
          content: { text: `${input.mode}:${input.reason}` },
          dedupeKey: `system_notice:runtime:${id}`,
          suppressIfKillSwitch: false,
        },
        'runtime',
      );
    }
    return row;
  }

  active(input?: { workspaceId?: string; scopeType?: string; scopeId?: string }): any[] {
    const conditions = [`status = 'active'`, `resolved_at IS NULL`];
    const params: Record<string, unknown> = {};
    if (input?.workspaceId) {
      conditions.push('workspace_id = @workspace_id');
      params.workspace_id = input.workspaceId;
    }
    if (input?.scopeType) {
      conditions.push('scope_type = @scope_type');
      params.scope_type = input.scopeType;
    }
    if (input?.scopeId) {
      conditions.push('scope_id = @scope_id');
      params.scope_id = input.scopeId;
    }
    return this.store.prepare(`
      SELECT id, workspace_id AS workspaceId, scope_type AS scopeType, scope_id AS scopeId,
             channel_id AS channelId, mode, reason, status, until,
             created_at AS createdAt, updated_at AS updatedAt
      FROM workspace_runtime_state
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at, id
    `).all(params);
  }

  resolve(input: { workspaceId: string; scopeType: string; scopeId: string; mode: string; reason: string }): boolean {
    const result = this.store.prepare(`
      UPDATE workspace_runtime_state
      SET status = 'resolved', resolved_at = @now, updated_at = @now
      WHERE workspace_id = @workspace_id
        AND scope_type = @scope_type
        AND scope_id = @scope_id
        AND mode = @mode
        AND reason = @reason
        AND status = 'active'
    `).run({
      workspace_id: input.workspaceId,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      mode: input.mode,
      reason: input.reason,
      now: isoNow(),
    });
    return result.changes > 0;
  }
}
