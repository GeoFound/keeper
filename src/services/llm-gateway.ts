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
  dayTimezone?: string;
  resetAt?: Date;
  mediaHoldMode?: string;
};

type UsageRecord = {
  costUsd: number;
  tokensIn?: number;
  tokensOut?: number;
};

type ReservationContext = {
  recordUsage(usage: UsageRecord): void;
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

  async withReservation<T>(input: ReservationInput, call: (ctx: ReservationContext) => Promise<T>): Promise<T> {
    const reserved = this.reserve(input);
    if (!reserved.ok) {
      if (input.scopeType === 'workspace' && input.lane === 'generative') {
        await this.runtime.enter({
          workspaceId: input.scopeId,
          scopeType: 'workspace',
          scopeId: input.scopeId,
          mode: 'read_only',
          reason: 'budget_exhausted',
          until: runtimeHoldUntil(input),
          details: { lane: input.lane, day: input.day },
        });
      }
      if (input.scopeType === 'workspace' && input.lane === 'safety') {
        await this.runtime.enter({
          workspaceId: input.scopeId,
          scopeType: 'workspace',
          scopeId: input.scopeId,
          mode: 'safety_hold',
          reason: 'safety_budget_exhausted',
          until: runtimeHoldUntil(input),
          details: { lane: input.lane, day: input.day },
        });
      }
      if (input.scopeType === 'workspace' && input.lane.includes('media')) {
        await this.runtime.enter({
          workspaceId: input.scopeId,
          scopeType: 'workspace',
          scopeId: input.scopeId,
          mode: 'media_hold',
          reason: 'media_budget_exhausted',
          until: runtimeHoldUntil(input),
          details: {
            lane: input.lane,
            day: input.day,
            disposition: input.mediaHoldMode ?? 'silent_delete_unscanned',
          },
        });
      }
      throw new Error(`budget exhausted for ${input.scopeType}:${input.scopeId}:${input.lane}`);
    }

    let usage: UsageRecord | undefined;
    try {
      const result = await call({
        recordUsage(record) {
          if (!Number.isFinite(record.costUsd) || record.costUsd < 0) throw new Error('actual LLM cost must be a non-negative finite number');
          usage = record;
        },
      });
      this.reconcileSuccess(input, usage ?? { costUsd: input.estimateUsd });
      return result;
    } catch (error) {
      this.release(input);
      throw error;
    }
  }

  private reserve(input: ReservationInput): { ok: boolean } {
    return this.store.transaction(() => {
      if (input.scopeType === 'source') {
        const row = this.ensureSourceBudgetRow(input);
        if (!row) return { ok: false };
        const current = this.store.prepare(`
          SELECT ingest_budget_usd, ingest_reserved_usd, ingest_actual_usd
          FROM ingest_budget_state
          WHERE source_id = ? AND day = ?
        `).get(input.scopeId, input.day) as any;
        if (!current || current.ingest_actual_usd + current.ingest_reserved_usd + input.estimateUsd > current.ingest_budget_usd) return { ok: false };
        this.store.prepare(`
          UPDATE ingest_budget_state
          SET ingest_reserved_usd = ingest_reserved_usd + @estimate, updated_at = CURRENT_TIMESTAMP
          WHERE source_id = @scope_id AND day = @day
        `).run({ estimate: input.estimateUsd, scope_id: input.scopeId, day: input.day });
        return { ok: true };
      }

      const ensured = this.ensureWorkspaceBudgetRow(input);
      if (!ensured) return { ok: false };
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

  private ensureWorkspaceBudgetRow(input: ReservationInput): boolean {
    const existing = this.store.prepare(`
      SELECT 1 FROM daily_budget_state WHERE workspace_id = ? AND day = ?
    `).get(input.scopeId, input.day);
    if (existing) return true;

    const prior = this.store.prepare(`
      SELECT generative_budget_usd, safety_budget_usd, media_scan_cap
      FROM daily_budget_state
      WHERE workspace_id = ? AND day < ?
      ORDER BY day DESC
      LIMIT 1
    `).get(input.scopeId, input.day) as any;
    if (!prior) return false;

    this.store.prepare(`
      INSERT OR IGNORE INTO daily_budget_state (
        workspace_id, day, generative_budget_usd, safety_budget_usd, media_scan_cap
      ) VALUES (
        @workspace_id, @day, @generative_budget_usd, @safety_budget_usd, @media_scan_cap
      )
    `).run({
      workspace_id: input.scopeId,
      day: input.day,
      generative_budget_usd: prior.generative_budget_usd,
      safety_budget_usd: prior.safety_budget_usd,
      media_scan_cap: prior.media_scan_cap,
    });
    return true;
  }

  private ensureSourceBudgetRow(input: ReservationInput): boolean {
    const existing = this.store.prepare(`
      SELECT 1 FROM ingest_budget_state WHERE source_id = ? AND day = ?
    `).get(input.scopeId, input.day);
    if (existing) return true;

    const prior = this.store.prepare(`
      SELECT ingest_budget_usd
      FROM ingest_budget_state
      WHERE source_id = ? AND day < ?
      ORDER BY day DESC
      LIMIT 1
    `).get(input.scopeId, input.day) as any;
    if (!prior) return false;

    this.store.prepare(`
      INSERT OR IGNORE INTO ingest_budget_state (source_id, day, ingest_budget_usd)
      VALUES (@source_id, @day, @ingest_budget_usd)
    `).run({
      source_id: input.scopeId,
      day: input.day,
      ingest_budget_usd: prior.ingest_budget_usd,
    });
    return true;
  }

  private reconcileSuccess(input: ReservationInput, usage: UsageRecord): void {
    this.store.transaction(() => {
      if (input.scopeType === 'source') {
        this.store.prepare(`
          UPDATE ingest_budget_state
          SET ingest_reserved_usd = MAX(0, ingest_reserved_usd - @estimate),
              ingest_actual_usd = ingest_actual_usd + @actual,
              updated_at = CURRENT_TIMESTAMP
          WHERE source_id = @scope_id AND day = @day
        `).run({ estimate: input.estimateUsd, actual: usage.costUsd, scope_id: input.scopeId, day: input.day });
      } else {
        const lane = input.lane === 'generative' ? 'generative' : 'safety';
        const reservedColumn = lane === 'generative' ? 'generative_reserved_usd' : 'safety_reserved_usd';
        const actualColumn = lane === 'generative' ? 'generative_actual_usd' : 'safety_actual_usd';
        this.store.prepare(`
          UPDATE daily_budget_state
          SET ${reservedColumn} = MAX(0, ${reservedColumn} - @estimate),
              ${actualColumn} = ${actualColumn} + @actual,
              updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = @scope_id AND day = @day
        `).run({ estimate: input.estimateUsd, actual: usage.costUsd, scope_id: input.scopeId, day: input.day });
      }
      this.upsertUsage(input, usage);
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

  private upsertUsage(input: ReservationInput, usage: UsageRecord): void {
    const scopeColumns = input.scopeType === 'workspace'
      ? { workspace_id: input.scopeId, source_id: null }
      : { workspace_id: null, source_id: input.scopeId };
    this.store.prepare(`
      INSERT INTO llm_usage (
        scope_type, scope_id, workspace_id, source_id, day, day_timezone,
        model, purpose, tokens_in, tokens_out, cost_usd, calls
      ) VALUES (
        @scope_type, @scope_id, @workspace_id, @source_id, @day, @day_timezone,
        @model, @purpose, @tokens_in, @tokens_out, @cost, 1
      )
      ON CONFLICT(scope_type, scope_id, day, model, purpose) DO UPDATE SET
        tokens_in = tokens_in + excluded.tokens_in,
        tokens_out = tokens_out + excluded.tokens_out,
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
      tokens_in: usage.tokensIn ?? 0,
      tokens_out: usage.tokensOut ?? 0,
      cost: usage.costUsd,
    });
  }
}

function runtimeHoldUntil(input: ReservationInput): Date | undefined {
  if (input.resetAt) return input.resetAt;
  if (input.scopeType !== 'workspace') return undefined;
  return endOfLocalDay(input.day, input.dayTimezone ?? 'UTC');
}

function endOfLocalDay(day: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) throw new Error(`invalid budget day ${day}`);
  const next = new Date(Date.UTC(year, month - 1, date + 1, 0, 0, 0));
  return zonedLocalTimeToUtc({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    date: next.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
    timeZone,
  });
}

function zonedLocalTimeToUtc(input: {
  year: number;
  month: number;
  date: number;
  hour: number;
  minute: number;
  second: number;
  timeZone: string;
}): Date {
  const desiredAsUtc = Date.UTC(input.year, input.month - 1, input.date, input.hour, input.minute, input.second);
  let guess = desiredAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedParts(new Date(guess), input.timeZone);
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.date, parts.hour, parts.minute, parts.second);
    guess = desiredAsUtc - (localAsUtc - guess);
  }
  return new Date(guess);
}

function zonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  date: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    date: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}
