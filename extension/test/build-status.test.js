import { test } from 'node:test';
import assert from 'node:assert';
import { currentStatus } from '../src/build-status.js';

const started = (buildId, buildTypeId, startedAt) => ({
  event: 'started', status: 'RUNNING', buildId, buildTypeId, startedAt, finishedAt: null
});

const finished = (buildId, buildTypeId, status, startedAt, finishedAt) => ({
  event: 'finished', status, buildId, buildTypeId, startedAt, finishedAt
});

test('a started event with no finished event counts as running', () => {
  const { rows, counts } = currentStatus([started('1', 'Cfg_A', '2026-05-21T09:00:00Z')]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].running, true);
  assert.strictEqual(counts.running, 1);
});

test('a finished event closes out its started event', () => {
  const { rows, counts } = currentStatus([
    started('1', 'Cfg_A', '2026-05-21T09:00:00Z'),
    finished('1', 'Cfg_A', 'SUCCESS', '2026-05-21T09:00:00Z', '2026-05-21T09:05:00Z')
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].running, false);
  assert.deepStrictEqual(counts, { running: 0, success: 1, failure: 0, cancelled: 0 });
});

test('only the newest run of a build configuration is reported', () => {
  const { rows } = currentStatus([
    finished('1', 'Cfg_A', 'FAILURE', '2026-05-21T08:00:00Z', '2026-05-21T08:05:00Z'),
    finished('2', 'Cfg_A', 'SUCCESS', '2026-05-21T09:00:00Z', '2026-05-21T09:05:00Z')
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].build.buildId, '2');
  assert.strictEqual(rows[0].build.status, 'SUCCESS');
});

test('running builds sort ahead of finished ones', () => {
  const { rows } = currentStatus([
    finished('1', 'Cfg_A', 'SUCCESS', '2026-05-21T09:00:00Z', '2026-05-21T09:05:00Z'),
    started('2', 'Cfg_B', '2026-05-21T08:00:00Z')
  ]);
  assert.deepStrictEqual(rows.map(r => r.build.buildTypeId), ['Cfg_B', 'Cfg_A']);
});

test('finished rows sort newest first', () => {
  const { rows } = currentStatus([
    finished('1', 'Cfg_A', 'SUCCESS', '2026-05-21T08:00:00Z', '2026-05-21T08:05:00Z'),
    finished('2', 'Cfg_B', 'FAILURE', '2026-05-21T09:00:00Z', '2026-05-21T09:05:00Z')
  ]);
  assert.deepStrictEqual(rows.map(r => r.build.buildTypeId), ['Cfg_B', 'Cfg_A']);
});

test('an empty buffer yields no rows and zero counts', () => {
  const { rows, counts } = currentStatus([]);
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(counts, { running: 0, success: 0, failure: 0, cancelled: 0 });
});
