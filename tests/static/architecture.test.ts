import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import YAML from 'yaml';
import { createTestDbPath, createTestStore } from '../support/test-store.ts';
import { SQLiteStore } from '../../src/services/store.ts';

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
  } catch {
    return [];
  }
}

test('spec wiring remains internally consistent', () => {
  const overview = YAML.parse(readFileSync('spec/overview.yaml', 'utf8'));
  const acceptance = YAML.parse(readFileSync('spec/acceptance.yaml', 'utf8'));
  const events = YAML.parse(readFileSync('spec/events.yaml', 'utf8'));
  const modules = YAML.parse(readFileSync('spec/modules.yaml', 'utf8'));
  const model = YAML.parse(readFileSync('spec/data-model.yaml', 'utf8'));

  assert.deepEqual(
    overview.build_order.map((step: any) => step.step),
    acceptance.steps.map((step: any) => step.step),
  );
  assert.deepEqual(
    overview.quality_gates.per_step.map((step: any) => step.step),
    acceptance.steps.map((step: any) => step.step),
  );

  const gateIds = new Set(overview.quality_gates.architecture.map((gate: any) => gate.id));
  for (const capability of acceptance.steps.flatMap((step: any) => step.capabilities)) {
    if (capability.gate) assert.equal(gateIds.has(capability.gate), true, `missing gate ${capability.gate}`);
  }

  const catalog = new Set(events.events.catalog.map((event: any) => event.event));
  for (const [name, mod] of Object.entries<any>(modules.modules)) {
    for (const event of [...(mod.subscribes ?? []), ...(mod.publishes ?? [])]) {
      assert.equal(catalog.has(event), true, `${name} references ${event}`);
    }
  }

  assert.deepEqual(Object.keys(model.data_model.tables).sort(), Object.keys(model.data_model.ownership).sort());
  assert.ok(model.data_model.lifecycle_policies.retention_sweep);
  assert.ok(model.data_model.lifecycle_policies.user_forget);
});

test('static architecture gates reject direct module coupling and unsafe privileged paths', () => {
  const srcFiles = filesUnder('src').filter((file) => file.endsWith('.ts'));
  for (const file of srcFiles) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/store\.state/.test(text), false, `${file} bypasses SQLite repositories with mutable state`);
    if (file.includes('/src/modules/')) {
      assert.equal(/from ['"]\.\.\/.*modules\//.test(text), false, `${file} imports another module`);
      assert.equal(/\.(sendMessage|deleteMessage|banUser|muteUser|pinMessage)\(/.test(text), false, `${file} calls adapter directly`);
      assert.equal(/workspace_runtime_state/.test(text), false, `${file} writes runtime state directly`);
    }
    if (file.includes('/src/llm') || file.includes('/src/services/llm-gateway')) {
      assert.equal(/EventBus|\.emit\(|sendMessage|deleteMessage|banUser|muteUser|pinMessage/.test(text), false, `${file} gives LLM output authority`);
    }
    assert.equal(/\.(sendMessage|deleteMessage|banUser|muteUser|pinMessage)\(/.test(text), false, `${file} calls adapter directly`);
  }
});

test('SQLite schema is applied from the authoritative data model with WAL enabled', () => {
  const spec = YAML.parse(readFileSync('spec/data-model.yaml', 'utf8'));
  const store = createTestStore('schema');
  const journalMode = store.prepare('PRAGMA journal_mode').get().journal_mode;
  assert.equal(journalMode, 'wal');

  const actualTables = new Set(
    store.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')").all().map((row: any) => row.name),
  );
  for (const table of Object.keys(spec.data_model.tables)) {
    assert.equal(actualTables.has(table), true, `missing SQLite table ${table}`);
  }
  const vectorSql = store.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_vectors'").get().sql;
  assert.match(vectorSql, /USING vec0/i);
});

test('SQLite schema migrates v1 databases with the scheduler tick ledger', () => {
  const dbPath = createTestDbPath('schema-v1-migration');
  const seed = new Database(dbPath);
  seed.pragma('user_version = 1');
  seed.close();

  const store = new SQLiteStore(dbPath);
  assert.equal(store.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_ticks'").get().name, 'scheduler_ticks');
  assert.equal(store.prepare('PRAGMA user_version').get().user_version, 2);
});

test('real crash evidence uses child process kill, not in-process restart simulation only', () => {
  const crashTests = filesUnder('tests').filter((file) => file.endsWith('.ts')).map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.match(crashTests, /node:child_process/);
  assert.match(crashTests, /process\.kill\(process\.pid,\s*['"]SIGKILL['"]\)/);
});

test('every table mutation in src comes from its declared owner (table_ownership)', () => {
  const model = YAML.parse(readFileSync('spec/data-model.yaml', 'utf8'));
  const tables = new Set(Object.keys(model.data_model.tables));
  const lifecycle = model.data_model.lifecycle_policies;
  const lifecycleTables = new Set([
    ...Object.keys(lifecycle.retention_sweep),
    ...Object.keys(lifecycle.user_forget),
  ]);

  // Owner-in-CODE allowlist: each spec table -> the src file(s) permitted to issue
  // INSERT/UPDATE/DELETE on it AT THIS BUILD STEP. Steady-state spec owners whose modules arrive
  // in later build_order steps are noted; until then the inbound/recovery infra persists the
  // canonical rows crash recovery needs. DataLifecycleService (data-lifecycle.ts) is the ONLY
  // cross-owner writer and only for lifecycle_policies tables (the isLifecycle branch below).
  const TABLE_WRITERS: Record<string, string[]> = {
    workspace_runtime_state: ['runtime-state.ts'], // RuntimeStateService
    daily_budget_state: ['llm-gateway.ts'],        // LLMGateway
    ingest_budget_state: ['llm-gateway.ts'],       // LLMGateway
    llm_usage: ['llm-gateway.ts'],                 // LLMGateway
    outbox: ['outbox.ts'],                         // Delivery/Outbox
    event_journal: ['observability.ts'],           // Observability
    scheduler_ticks: ['scheduler.ts'],             // Scheduler
    inbound_updates: ['inbound-lifecycle.ts'],     // Delivery/Ingest infra
    messages: ['inbound-lifecycle.ts'],            // spec owner Workspace Router (step 3); pre-router ingest persists it now
    pipeline_failures: ['inbound-lifecycle.ts'],   // spec owner Pipeline supervisor (step 4); written at the inbound commit point now
  };
  const LIFECYCLE_FILE = 'data-lifecycle.ts';

  for (const table of Object.keys(TABLE_WRITERS)) {
    assert.equal(tables.has(table), true, `TABLE_WRITERS references unknown table ${table}`);
  }

  const mutation = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi;
  const srcFiles = filesUnder('src').filter((file) => file.endsWith('.ts'));
  let checked = 0;
  for (const file of srcFiles) {
    const base = file.split('/').pop() as string;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(mutation)) {
      const table = match[1];
      if (!tables.has(table)) continue; // not a spec domain table (e.g. UPDATE ... SET, pragmas)
      checked += 1;
      const isOwner = (TABLE_WRITERS[table] ?? []).includes(base);
      const isLifecycle = base === LIFECYCLE_FILE && lifecycleTables.has(table);
      assert.ok(isOwner || isLifecycle, `${base} mutates ${table} but is not its declared owner (table_ownership)`);
    }
  }
  assert.ok(checked > 0, 'expected at least one ownership-checked table mutation in src');
});
