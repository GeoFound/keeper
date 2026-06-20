import { SQLiteStore } from '../services/store.ts';
import { ObservabilityService } from '../services/observability.ts';

// Default to the engine's database (config.yaml database.path = ./data/bot.db). KEEPER_DB
// overrides it (KEEPER_STATE_FILE is kept as a back-compat alias). Without this the CLI used to
// open a different, empty file, so `just trace/tail/inspect` showed nothing.
const [, , command, ...args] = process.argv;
const dbPath = process.env.KEEPER_DB ?? process.env.KEEPER_STATE_FILE ?? 'data/bot.db';
const store = new SQLiteStore(dbPath);
const observability = new ObservabilityService(store);

function printRows(rows: unknown[]): void {
  for (const row of rows) console.log(JSON.stringify(row));
}

switch (command) {
  case 'trace':
    printRows(observability.trace(args[0] ?? ''));
    break;
  case 'tail':
    printRows(observability.tail(Number(args[0] ?? 50)));
    break;
  case 'inspect':
    printRows(observability.inspect(args[0] ?? ''));
    break;
  case 'journal':
    printRows(store.prepare(`
      SELECT id, correlation_id AS correlationId, workspace_id AS workspaceId,
             subject_user_id AS subjectUserId, name, kind, level, reason,
             payload_digest AS payloadDigest, at
      FROM event_journal
      ORDER BY at, id
    `).all());
    break;
  default:
    console.error('usage: observe trace <correlationId> | tail [limit] | inspect <target> | journal');
    process.exit(2);
}
