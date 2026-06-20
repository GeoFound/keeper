import type { SQLiteStore } from './store.ts';
import { redactString, redactValue } from './redaction.ts';
import { isoNow } from './ids.ts';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class StructuredLogger {
  private readonly filePath: string;

  constructor(store: SQLiteStore, filePath?: string) {
    this.filePath = filePath ?? join(dirname(store.filePath), 'logs', 'keeper.jsonl');
  }

  info(context: { workspaceId: string; correlationId: string; module: string }, message: string): void {
    const line = JSON.stringify({
      level: 'info',
      at: isoNow(),
      ...redactValue(context),
      message: redactString(message),
    });
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${line}\n`);
  }
}
