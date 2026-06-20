export type DailyTickConfig = {
  workspaceId: string;
  timezone: string;
  localTime: string;
  jobId?: string;
};

export class SchedulerService {
  private readonly fired = new Set<string>();

  dueDailyTicks(workspaces: DailyTickConfig[], now: Date): Array<DailyTickConfig & { dueAt: string }> {
    const due: Array<DailyTickConfig & { dueAt: string }> = [];
    for (const workspace of workspaces) {
      const local = this.localParts(workspace.timezone, now);
      if (local.minute < workspace.localTime) continue;
      const key = `${workspace.workspaceId}:${workspace.jobId ?? workspace.localTime}:${local.date}`;
      if (this.fired.has(key)) continue;
      this.fired.add(key);
      due.push({ ...workspace, dueAt: now.toISOString() });
    }
    return due;
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
