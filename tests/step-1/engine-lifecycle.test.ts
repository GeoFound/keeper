import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from '../support/test-store.ts';
import { ObservabilityService } from '../../src/services/observability.ts';
import { EventBus } from '../../src/engine/event-bus.ts';
import { EngineCore } from '../../src/engine/core.ts';

test('engine registers modules, starts, stops, and calls module health checks', async () => {
  const store = createTestStore('engine-core');
  const bus = new EventBus({ observability: new ObservabilityService(store) });
  const engine = new EngineCore(bus);

  engine.register({
    name: 'HealthProbe',
    subscribes: [],
    publishes: [],
    handle() {},
    healthCheck() {
      return { ok: true };
    },
  });

  await engine.start();
  assert.equal(engine.isRunning(), true);
  assert.deepEqual(await engine.healthCheck(), { HealthProbe: { ok: true } });
  engine.stop();
  assert.equal(engine.isRunning(), false);
});
