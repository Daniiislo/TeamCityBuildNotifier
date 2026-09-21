import { test } from 'node:test';
import assert from 'node:assert';
import { eventKind, KIND_ICON, KIND_LABEL, formatDuration, eventTimestamp, formatRelative, formatStamp } from '../src/event-style.js';

test('started event wins over status', () => {
  assert.strictEqual(eventKind({ event: 'started', status: 'SUCCESS' }), 'started');
});

test('finished statuses map to their own kind', () => {
  assert.strictEqual(eventKind({ event: 'finished', status: 'SUCCESS' }), 'success');
  assert.strictEqual(eventKind({ event: 'finished', status: 'FAILURE' }), 'failure');
  assert.strictEqual(eventKind({ event: 'finished', status: 'CANCELLED' }), 'cancelled');
});

test('unknown status does not fall through to started', () => {
  assert.strictEqual(eventKind({ event: 'finished', status: 'WAT' }), 'unknown');
  assert.strictEqual(eventKind({ event: 'finished' }), 'unknown');
});

test('every kind has an icon and a label', () => {
  for (const kind of ['success', 'failure', 'cancelled', 'started', 'unknown']) {
    assert.ok(KIND_ICON[kind], `missing icon for ${kind}`);
    assert.ok(KIND_LABEL[kind], `missing label for ${kind}`);
  }
});

test('formatDuration drops the minutes part under a minute', () => {
  assert.strictEqual(formatDuration(45), '45s');
  assert.strictEqual(formatDuration(125), '2m 5s');
  assert.strictEqual(formatDuration(0), '0s');
  assert.strictEqual(formatDuration(null), null);
  assert.strictEqual(formatDuration(undefined), null);
});

test('eventTimestamp prefers finishedAt, then startedAt, then receivedAt', () => {
  const finished = eventTimestamp({
    startedAt: '2026-05-21T06:27:42Z',
    finishedAt: '2026-05-21T06:50:12Z',
    receivedAt: '2026-05-21T07:00:00Z'
  });
  assert.strictEqual(finished.toISOString(), '2026-05-21T06:50:12.000Z');

  const running = eventTimestamp({ startedAt: '2026-05-21T06:27:42Z', finishedAt: null });
  assert.strictEqual(running.toISOString(), '2026-05-21T06:27:42.000Z');

  const fallback = eventTimestamp({ receivedAt: '2026-05-21T07:00:00Z' });
  assert.strictEqual(fallback.toISOString(), '2026-05-21T07:00:00.000Z');
});

test('eventTimestamp returns null rather than an Invalid Date', () => {
  assert.strictEqual(eventTimestamp({}), null);
  assert.strictEqual(eventTimestamp({ startedAt: 'not a date' }), null);
});

test('formatRelative buckets by the largest fitting unit', () => {
  const now = new Date('2026-05-21T12:00:00Z').getTime();
  const ago = seconds => formatRelative(new Date(now - seconds * 1000), now);

  assert.strictEqual(ago(10), 'just now');
  assert.match(ago(300), /5/);     // 5 minutes
  assert.match(ago(7200), /2/);    // 2 hours
  assert.match(ago(172800), /2/);  // 2 days
});

test('formatStamp drops the date only while it is still today', () => {
  const now = new Date('2026-05-21T12:00:00Z');
  const sameDay = formatStamp(new Date('2026-05-21T08:30:00Z'), now);
  const otherDay = formatStamp(new Date('2026-05-19T08:30:00Z'), now);

  assert.ok(sameDay.length < otherDay.length, `${sameDay} should be shorter than ${otherDay}`);
});
