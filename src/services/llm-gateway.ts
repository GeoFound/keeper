import type { SQLiteStore } from './store.ts';
import type { RuntimeStateService } from './runtime-state.ts';

type BudgetInput = {
  scopeType: 'workspace' | 'source';
  scopeId: string;
  lane: 'generative' | 'safety' | 'media_safety' | 'ingest' | string;
  day: string;
  limitUsd: number;
};

type ReservationInput = {
  scopeType: 'workspace' | 'source';
  scopeId: string;
  lane: 'generative' | 'safety' | 'media_safety' | 'ingest' | string;
  day: string;
  estimateUsd: number;
  model?: string;
  purpose?: string;
};

export class LLMGateway {
  private readonly store: SQLiteStore;
  private readonly runtime: RuntimeStateService;

  constructor(store: SQLiteStore, runtime: RuntimeStateService) {
    this.store = store;
    this.runtime = runtime;
  }

  seedBudget(input: BudgetInput): void {
    if (input.scopeType === 'source') {
      this.store.prepare(`
        INSERT INTO ingest_budget_state (source_id, day, ingest_budget_usd)
        VALUES (@scope_id, @day, @limit)
        ON CONFLICT(source_id, day) DO UPDATE SET ingest_budget_usd = excluded.ingest_budget_usd
      `).run({ scope_id: input.scopeId, day: input.day, limit: input.limitUsd });
      return;
    }

    const existing = this.store.prepare(`
      SELECT * FROM daily_budget_state WHERE workspace_id = ? AND day = ?
    `).get(input.scopeId, input.day) as any;
    const values = {
      workspace_id: input.scopeId,
      day: input.day,
      generative: existing?.generative_budget_usd ?? 0,
      safety: existing?.safety_budget_usd ?? 0,
      mediaCap: existing?.media_scan_cap ?? 0,
    };
    if (input.lane === 'generative') values.generative = input.limitUsd;
    if (input.lane === 'safety' || input.lane === 'media_safety') values.safety = input.limitUsd;
    this.store.prepare(`
      INSERT INTO daily_budget_state (workspace_id, day, generative_budget_usd, safety_budget_usd, media_scan_cap)
      VALUES (@workspace_id, @day, @generative, @safety, @mediaCap)
      ON CONFLICT(workspace_id, day) DO UPDATE SET
        generative_budget_usd = excluded.generative_budget_usd,
        safety_budget_usd = excluded.safety_budget_usd,
        media_scan_cap = excluded.media_scan_cap,
        updated_at = CURRENT_TIMESTAMP
    `).run(values);
  }

  async withReservation<T>(input: ReservationInput, call: () => Promise<T>): Promise<T> {
    const reserved = this.reserve(input);
    if (!reserved.ok) {
      if (input.scopeType === 'workspace' && input.lane === 'generative') {
        await this.runtime.enter({
          workspaceId: input.scopeId,
          scopeType: 'workspace',
          scopeId: input.scopeId,
          mode: 'read_only',
          reason: 'budget_exhausted',
        });
      }
      if (input.scopeType === 'workspace' && input.lane.includes('media')) {
        await this.runtime.enter({
          workspaceId: input.scopeId,
          scopeType: 'workspace',
          scopeId: input.scopeId,
          mode: 'media_hold',
          reason: 'media_budget_exhausted',
        });
      }
      throw new Error(`budget exhausted for ${input.scopeType}:${input.scopeId}:${input.lane}`);
    }

    try {
      const result = await call();
      this.reconcileSuccess(input);
      return result;
    } catch (error) {
      this.release(input);
      throw error;
    }
  }

  private reserve(input: ReservationInput): { ok: boolean } {
    return this.store.transaction(() => {
      if (input.scopeType === 'source') {
        const row = this.store.prepare(`
          SELECT ingest_budget_usd, ingest_reserved_usd, ingest_actual_usd
          FROM ingest_budget_state
          WHERE source_id = ? AND day = ?
        `).get(input.scopeId, input.day) as any;
        if (!row || row.ingest_actual_usd + row.ingest_reserved_usd + input.estimateUsd > row.ingest_budget_usd) return { ok: false };
        this.store.prepare(`
          UPDATE ingest_budget_state
          SET ingest_reserved_usd = ingest_reserved_usd + @estimate, updated_at = CURRENT_TIMESTAMP
          WHERE source_id = @scope_id AND day = @day
        `).run({ estimate: input.estimateUsd, scope_id: input.scopeId, day: input.day });
        return { ok: true };
      }

      const lane = input.lane === 'generative' ? 'generative' : 'safety';
      const row = this.store.prepare(`
        SELECT generative_budget_usd, safety_budget_usd,
               generative_reserved_usd, safety_reserved_usd,
               generative_actual_usd, safety_actual_usd
        FROM daily_budget_state
        WHERE workspace_id = ? AND day = ?
      `).get(input.scopeId, input.day) as any;
      if (!row) return { ok: false };
      const budget = lane === 'generative' ? row.generative_budget_usd : row.safety_budget_usd;
      const reserved = lane === 'generative' ? row.generative_reserved_usd : row.safety_reserved_usd;
      const actual = lane === 'generative' ? row.generative_actual_usd : row.safety_actual_usd;
      if (actual + reserved + input.estimateUsd > budget) return { ok: false };
      const column = lane === 'generative' ? 'generative_reserved_usd' : 'safety_reserved_usd';
      this.store.prepare(`
        UPDATE daily_budget_state
        SET ${column} = ${column} + @estimate, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = @scope_id AND day = @day
      `).run({ estimate: input.estimateUsd, scope_id: input.scopeId, day: input.day });
      return { ok: true };
    });
  }

  private reconcileSuccess(input: ReservationInput): void {
    this.store.transaction(() => {
      if (input.scopeType === 'source') {
        this.store.prepare(`
          UPDATE ingest_budget_state
          SET ingest_reserved_usd = MAX(0, ingest_reserved_usd - @estimate),
              ingest_actual_usd = ingest_actual_usd + @estimate,
              updated_at = CURRENT_TIMESTAMP
          WHERE source_id = @scope_id AND day = @day
        `).run({ estimate: input.estimateUsd, scope_id: input.scopeId, day: input.day });
      } else {
        const lane = input.lane === 'generative' ? 'generative' : 'safety';
        const reservedColumn = lane === 'generative' ? 'generative_reserved_usd' : 'safety_reserved_usd';
        const actualColumn = lane === 'generative' ? 'generative_actual_usd' : 'safety_actual_usd';
        this.store.prepare(`
          UPDATE daily_budget_state
          SET ${reservedColumn} = MAX(0, ${reservedColumn} - @estimate),
              ${actualColumn} = ${actualColumn} + @estimate,
              updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = @scope_id AND day = @day
        `).run({ estimate: input.estimateUsd, scope_id: input.scopeId, day: input.day });
      }
      this.upsertUsage(input);
    });
  }

  private release(input: ReservationInput): void {
    if (input.scopeType === 'source') {
      this.store.prepare(`
        UPDATE ingest_budget_state
        SET ingest_reserved_usd = MAX(0, ingest_reserved_usd - @estimate), updated_at = CURRENT_TIMESTAMP
        WHERE source_id = @scope_id AND day = @day
      `).run({ estimate: input.estimateUsd, scope_id: input.scopeId, day: input.day });
      return;
    }
    const column = input.lane === 'generative' ? 'generative_reserved_usd' : 'safety_reserved_usd';
    this.store.prepare(`
      UPDATE daily_budget_state
      SET ${column} = MAX(0, ${column} - @estimate), updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = @scope_id AND day = @day
    `).run({ estimate: input.estimateUsd, scope_id: input.scopeId, day: input.day });
  }

  private upsertUsage(input: ReservationInput): void {
    const scopeColumns = input.scopeType === 'workspace'
      ? { workspace_id: input.scopeId, source_id: null }
      : { workspace_id: null, source_id: input.scopeId };
    this.store.prepare(`
      INSERT INTO llm_usage (
        scope_type, scope_id, workspace_id, source_id, day, day_timezone,
        model, purpose, cost_usd, calls
      ) VALUES (
        @scope_type, @scope_id, @workspace_id, @source_id, @day, @day_timezone,
        @model, @purpose, @cost, 1
      )
      ON CONFLICT(scope_type, scope_id, day, model, purpose) DO UPDATE SET
        cost_usd = cost_usd + excluded.cost_usd,
        calls = calls + 1
    `).run({
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      workspace_id: scopeColumns.workspace_id,
      source_id: scopeColumns.source_id,
      day: input.day,
      day_timezone: input.scopeType === 'workspace' ? 'workspace' : 'server',
      model: input.model ?? 'test-model',
      purpose: input.purpose ?? input.lane,
      cost: input.estimateUsd,
    });
  }
}
