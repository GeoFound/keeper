import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestStore } from '../support/test-store.ts';
import { EventBus, createEnvelope } from '../../src/engine/event-bus.ts';
import { ObservabilityService } from '../../src/services/observability.ts';
import { SchedulerService } from '../../src/services/scheduler.ts';
import { StructuredLogger } from '../../src/services/structured-logger.ts';

test('scheduler fires workspace-local ticks and catches up once', () => {
  const scheduler = new SchedulerService();
  const ticks = scheduler.dueDailyTicks(
    [
      { workspaceId: 'tokyo', timezone: 'Asia/Tokyo', localTime: '09:00' },
      { workspaceId: 'utc', timezone: 'UTC', localTime: '09:00' },
    ],
    new Date('2026-06-19T00:00:00.000Z'),
  );
  assert.equal(ticks.some((tick) => tick.workspaceId === 'tokyo'), true);
  assert.equal(ticks.some((tick) => tick.workspaceId === 'utc'), false);

  const restarted = new SchedulerService();
  assert.equal(
    restarted.dueDailyTicks(
      [{ workspaceId: 'tokyo', timezone: 'Asia/Tokyo', localTime: '09:00', jobId: 'digest' }],
      new Date('2026-06-18T23:59:00.000Z'),
    ).length,
    0,
  );
  const caughtUp = restarted.dueDailyTicks(
    [{ workspaceId: 'tokyo', timezone: 'Asia/Tokyo', localTime: '09:00', jobId: 'digest' }],
    new Date('2026-06-19T00:05:00.000Z'),
  );
  assert.equal(caughtUp.length, 1);
  assert.equal(
    restarted.dueDailyTicks(
      [{ workspaceId: 'tokyo', timezone: 'Asia/Tokyo', localTime: '09:00', jobId: 'digest' }],
      new Date('2026-06-19T00:06:00.000Z'),
    ).length,
    0,
  );
});

test('trace, tail, inspect, structured logs, and secret redaction work', async () => {
  const store = createTestStore('observe');
  const observability = new ObservabilityService(store);
  const bus = new EventBus({ observability });
  const logger = new StructuredLogger(store);

  await bus.emit(
    'outbound.requested',
    createEnvelope({ name: 'outbound.requested', workspaceId: 'ws-main', correlationId: 'corr:obs' }),
    {
      kind: 'notice',
      audience: 'owner',
      content: { text: 'hello sk-proj-canary token 123456:ABCDEF' },
      dedupeKey: 'system_notice:obs',
      suppressIfKillSwitch: false,
    },
    'system',
  );
  observability.traceDecision({
    workspaceId: 'ws-main',
    correlationId: 'corr:obs',
    name: 'decision.no_reply',
    reason: 'posture==stay_silent',
  });
  logger.info({ workspaceId: 'ws-main', correlationId: 'corr:obs', module: 'probe' }, 'session_string=1ABCDEF api sk-proj-canary');

  observability.flush();
  assert.equal(observability.trace('corr:obs').length, 2);
  assert.equal(observability.tail(10).length, 2);
  assert.equal(observability.inspect('ws-main').length, 2);
  assert.equal(
    store.prepare("SELECT COUNT(*) AS count FROM event_journal WHERE payload_digest LIKE '%sk-proj-canary%'").get().count,
    0,
  );
  const logPath = join(dirname(store.filePath), 'logs', 'keeper.jsonl');
  assert.equal(existsSync(logPath), true);
  assert.equal(readFileSync(logPath, 'utf8').includes('sk-proj-canary'), false);
});

test('event journal writes are buffered off the hot path and flushed explicitly', () => {
  const store = createTestStore('observe-buffer');
  const observability = new ObservabilityService(store);
  observability.recordEvent(
    'outbound.requested',
    {
      eventId: 'evt:test',
      name: 'outbound.requested',
      workspaceId: 'ws-main',
      correlationId: 'corr:buffer',
      at: new Date('2026-06-19T00:00:00.000Z').toISOString(),
    },
    {
      kind: 'notice',
      audience: 'owner',
      content: { text: 'buffered' },
      dedupeKey: 'system_notice:buffer',
      suppressIfKillSwitch: false,
    },
  );

  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM event_journal').get().count, 0);
  observability.flush();
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM event_journal').get().count, 1);
});
