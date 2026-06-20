import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfigFromDir, loadConfigObject } from '../../src/config/loader.ts';
import { createConfigFixture } from '../support/fixtures.ts';

test('config loads, validates hard floor, uniqueness, embedding dimension, and launch profile', () => {
  const config = loadConfigObject(createConfigFixture());
  assert.equal(config.workspaces[0].moderation.hard_block.enabled, true);
  assert.equal(config.workspaces[0].features.evolution, false);
  assert.equal(config.workspaces[0].features.funnel, false);
  assert.equal(config.workspaces[0].features.cross_promotion, false);
  assert.equal(config.workspaces[0].features.user_memory, false);
  assert.equal(config.bot.llm.models.embedding_dimension, 1536);
  assert.equal(config.derivedChannelUids.get('telegram:-1001'), 'ws-main');
});

test('config rejects dangerous or ambiguous inputs and preserves prior config on bad reload', () => {
  const prior = loadConfigObject(createConfigFixture());

  assert.throws(() => {
    const bad = createConfigFixture();
    bad.workspaces[0].moderation.hard_block.enabled = false;
    loadConfigObject(bad);
  }, /hard_block/);

  assert.throws(() => {
    const bad = createConfigFixture();
    bad.workspaces.push({ ...bad.workspaces[0], id: 'ws-other' });
    loadConfigObject(bad);
  }, /channel/);

  assert.throws(() => {
    const bad = createConfigFixture();
    bad.workspaces[0].id = '__system__';
    loadConfigObject(bad);
  }, /__system__/);

  assert.throws(() => {
    const bad = createConfigFixture();
    bad.workspaces[0].id = 'Ws-Main';
    loadConfigObject(bad);
  }, /Invalid/);

  assert.throws(() => {
    const bad = createConfigFixture();
    bad.bot.delivery.pipeline_inflight_deadline_seconds = 120;
    loadConfigObject(bad);
  }, /pipeline_inflight_deadline/);

  assert.throws(() => {
    const bad = createConfigFixture();
    bad.workspaces[0].moderation.media.vision_classifier = 'off';
    loadConfigObject(bad);
  }, /best_effort/);

  assert.throws(() => {
    const bad = createConfigFixture();
    bad.bot.llm.models.embedding = 'openai/text-embedding-3-large';
    loadConfigObject(bad);
  }, /embedding_dimension/);

  const badReload = createConfigFixture();
  badReload.workspaces[0].moderation.hard_block.enabled = false;
  assert.equal(loadConfigObject(badReload, prior).workspaces[0].id, 'ws-main');

  const reloaded = loadConfigObject(createConfigFixture(), prior);
  assert.equal(reloaded.workspaces[0].id, 'ws-main');
});

test('config can be loaded from YAML files', () => {
  const config = loadConfigFromDir(new URL('../support/config-fixture', import.meta.url));
  assert.equal(config.workspaces[0].id, 'ws-main');
  assert.equal(config.sources[0].id, 'src-docs');
});

test('the committed sanitized config/ directory validates against the loader', () => {
  // Keeps config/** (the human decision surface, project_structure) in lock-step with the
  // loader schema: a drift in either fails CI instead of surfacing only when `just dev` runs.
  const config = loadConfigFromDir(new URL('../../config', import.meta.url));
  assert.equal(config.workspaces.length >= 1, true);
  const ws = config.workspaces[0];
  assert.equal(ws.launch_profile, 'minimum');
  assert.equal(ws.features.evolution, false);
  assert.equal(ws.features.funnel, false);
  assert.equal(ws.features.cross_promotion, false);
  assert.equal(ws.features.user_memory, false);
  // every workspace content source resolves to a declared source
  const sourceIds = new Set(config.sources.map((source) => source.id));
  for (const ref of ws.content_sources) assert.equal(sourceIds.has(ref), true, `unresolved source ${ref}`);
});
