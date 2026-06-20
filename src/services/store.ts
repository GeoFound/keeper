import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { load as loadSqliteVec } from 'sqlite-vec';

export type StatementParams = Record<string, unknown> | unknown[];

export class SQLiteStore {
  readonly filePath: string;
  readonly db: Database.Database;

  constructor(filePath: string, input?: { schemaPath?: string; embeddingDimension?: number }) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    loadSqliteVec(this.db);
    applySchema(this.db, {
      schemaPath: input?.schemaPath ?? resolve('spec/data-model.yaml'),
      embeddingDimension: input?.embeddingDimension ?? 1536,
    });
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

export class FileStore extends SQLiteStore {}

function applySchema(db: Database.Database, input: { schemaPath: string; embeddingDimension: number }): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= 1) return;
  const parsed = YAML.parse(readFileSync(input.schemaPath, 'utf8'));
  const tables = parsed.data_model.tables as Record<string, string>;
  db.transaction(() => {
    for (const [name, ddl] of Object.entries(tables)) {
      const sql = ddl.replaceAll('${embedding_dim}', String(input.embeddingDimension));
      db.exec(sql);
    }
    db.pragma('user_version = 1');
  })();
}
