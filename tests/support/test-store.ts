import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteStore } from '../../src/services/store.ts';

export function createTestStore(name: string): SQLiteStore {
  const dir = join(tmpdir(), `keeper-${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return new SQLiteStore(join(dir, 'state.db'));
}

export function createTestDbPath(name: string): string {
  const dir = join(tmpdir(), `keeper-${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return join(dir, 'state.db');
}
