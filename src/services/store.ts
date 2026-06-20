import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { load as loadSqliteVec } from 'sqlite-vec';

export type StatementParams = Record<string, unknown> | unknown[];
const SCHEMA_VERSION = 2;

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
  const parsed = YAML.parse(readFileSync(input.schemaPath, 'utf8'));
  const tables = parsed.data_model.tables as Record<string, string>;
  if (version >= SCHEMA_VERSION) return;

  db.transaction(() => {
    if (version < 1) {
      for (const ddl of Object.values(tables)) {
        db.exec(renderSchemaSql(ddl, input.embeddingDimension));
      }
    } else if (version < 2) {
      db.exec(renderAdditiveSchemaSql(tables.scheduler_ticks, input.embeddingDimension));
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

function renderSchemaSql(ddl: string, embeddingDimension: number): string {
  return ddl.replaceAll('${embedding_dim}', String(embeddingDimension));
}

function renderAdditiveSchemaSql(ddl: string, embeddingDimension: number): string {
  return renderSchemaSql(ddl, embeddingDimension)
    .replace(/\bCREATE TABLE\b/g, 'CREATE TABLE IF NOT EXISTS')
    .replace(/\bCREATE INDEX\b/g, 'CREATE INDEX IF NOT EXISTS')
    .replace(/\bCREATE UNIQUE INDEX\b/g, 'CREATE UNIQUE INDEX IF NOT EXISTS');
}
