import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDbPath } from '../support/test-store.ts';
import { SQLiteStore } from '../../src/services/store.ts';
import { OutboxService } from '../../src/services/outbox.ts';
import { InboundLifecycle } from '../../src/services/inbound-lifecycle.ts';

async function runKilledScenario(scenario: string, dbPath: string): Promise<void> {
  const childPath = fileURLToPath(new URL('../support/crash-child.ts', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', childPath, scenario, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let sawReady = false;
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('ready')) sawReady = true;
    });
    child.on('error', reject);
    child.on('exit', (_code, signal) => {
      if (signal !== 'SIGKILL') reject(new Error(`expected SIGKILL, got ${signal}; stderr=${stderr}`));
      else if (!sawReady) reject(new Error(`child died before durable checkpoint; stderr=${stderr}`));
      else resolve();
    });
  });
}

test('real process kill after outbox sending restarts as ambiguous from disk', async () => {
  const dbPath = createTestDbPath('real-outbox-crash');
  await runKilledScenario('outbox-sending', dbPath);

  const restarted = new SQLiteStore(dbPath);
  const outbox = new OutboxService(restarted);
  outbox.reconcileAfterRestart(new Date('2026-06-19T00:20:00.000Z'), 10 * 60 * 1000);
  assert.equal(outbox.get('reply:corr:crash')?.status, 'ambiguous');
});

test('real process kill after persisted inbound message redrives from disk', async () => {
  const dbPath = createTestDbPath('real-inbound-crash');
  await runKilledScenario('inbound-after-message-before-outbox', dbPath);

  const restarted = new SQLiteStore(dbPath);
  const inbound = new InboundLifecycle(restarted);
  const redriven = inbound.restartRedrive(new Date('2026-06-19T00:01:00.000Z'), 10 * 60 * 1000);
  assert.deepEqual(redriven.map((row) => row.messageId), ['telegram:native-chat:55']);
});

test('real process kill after pipeline abort stays committed after restart', async () => {
  const dbPath = createTestDbPath('real-inbound-abort');
  await runKilledScenario('inbound-aborted', dbPath);

  const restarted = new SQLiteStore(dbPath);
  const inbound = new InboundLifecycle(restarted);
  assert.equal(inbound.restartRedrive(new Date('2026-06-19T00:01:00.000Z'), 10 * 60 * 1000).length, 0);
  assert.equal(inbound.get('telegram:update:abort')?.status, 'committed');
});
