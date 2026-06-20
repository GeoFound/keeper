export type DailyTickConfig = {
  workspaceId: string;
  timezone: string;
  localTime: string;
};

export class SchedulerService {
  dueDailyTicks(workspaces: DailyTickConfig[], now: Date): Array<DailyTickConfig & { dueAt: string }> {
    return workspaces
      .filter((workspace) => this.localMinute(workspace.timezone, now) === workspace.localTime)
      .map((workspace) => ({ ...workspace, dueAt: now.toISOString() }));
  }

  private localMinute(timezone: string, now: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
    return `${hour}:${minute}`;
  }
}
