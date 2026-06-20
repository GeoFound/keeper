import type { SQLiteStore } from './store.ts';

export type DailyTickConfig = {
  workspaceId: string;
  timezone: string;
  localTime: string;
  jobId?: string;
};

export class SchedulerService {
  private readonly fired = new Set<string>();
  private readonly store?: SQLiteStore;

  constructor(store?: SQLiteStore) {
    this.store = store;
  }

  dueDailyTicks(workspaces: DailyTickConfig[], now: Date): Array<DailyTickConfig & { dueAt: string }> {
    const due: Array<DailyTickConfig & { dueAt: string }> = [];
    for (const workspace of workspaces) {
      const local = this.localParts(workspace.timezone, now);
      if (local.minute < workspace.localTime) continue;
      const jobId = workspace.jobId ?? workspace.localTime;
      const key = `${workspace.workspaceId}:${jobId}:${local.date}`;
      if (!this.claimTick({ ...workspace, jobId, localDate: local.date, key, firedAt: now })) continue;
      due.push({ ...workspace, dueAt: now.toISOString() });
    }
    return due;
  }

  private claimTick(input: DailyTickConfig & { jobId: string; localDate: string; key: string; firedAt: Date }): boolean {
    if (!this.store) {
      if (this.fired.has(input.key)) return false;
      this.fired.add(input.key);
      return true;
    }

    const result = this.store.prepare(`
      INSERT OR IGNORE INTO scheduler_ticks (
        id, workspace_id, job_id, local_date, timezone, local_time, fired_at
      ) VALUES (
        @id, @workspace_id, @job_id, @local_date, @timezone, @local_time, @fired_at
      )
    `).run({
      id: `sched:${input.key}`,
      workspace_id: input.workspaceId,
      job_id: input.jobId,
      local_date: input.localDate,
      timezone: input.timezone,
      local_time: input.localTime,
      fired_at: input.firedAt.toISOString(),
    });
    return result.changes === 1;
  }

  private localParts(timezone: string, now: Date): { date: string; minute: string } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
    const month = parts.find((part) => part.type === 'month')?.value ?? '01';
    const day = parts.find((part) => part.type === 'day')?.value ?? '01';
    const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
    return { date: `${year}-${month}-${day}`, minute: `${hour}:${minute}` };
  }
}
