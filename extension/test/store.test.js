import { test } from 'node:test';
import assert from 'node:assert';
import { hasSeen, markSeen, trimSeenIds } from '../src/notification-store.js';
import { isAllowedBuildUrl } from '../src/url-validation.js';

test('hasSeen returns true for existing ID', () => {
  const ids = ['id1', 'id2', 'id3'];
  assert.strictEqual(hasSeen(ids, 'id2'), true);
});

test('hasSeen returns false for missing ID', () => {
  const ids = ['id1', 'id2', 'id3'];
  assert.strictEqual(hasSeen(ids, 'id4'), false);
});

test('markSeen adds new ID', () => {
  const ids = ['id1', 'id2'];
  const result = markSeen(ids, 'id3');
  assert.deepStrictEqual(result, ['id1', 'id2', 'id3']);
});

test('markSeen does not add duplicate ID', () => {
  const ids = ['id1', 'id2'];
  const result = markSeen(ids, 'id2');
  assert.deepStrictEqual(result, ['id1', 'id2']);
});

test('trimSeenIds keeps all IDs when under limit', () => {
  const ids = ['id1', 'id2', 'id3'];
  const result = trimSeenIds(ids, 10);
  assert.deepStrictEqual(result, ['id1', 'id2', 'id3']);
});

test('trimSeenIds keeps most recent IDs when over limit', () => {
  const ids = ['id1', 'id2', 'id3', 'id4', 'id5'];
  const result = trimSeenIds(ids, 3);
  assert.deepStrictEqual(result, ['id3', 'id4', 'id5']);
});

test('isAllowedBuildUrl accepts same origin', () => {
  const url = 'https://teamcity.example/viewLog.html?buildId=123';
  const baseUrl = 'https://teamcity.example';
  assert.strictEqual(isAllowedBuildUrl(url, baseUrl), true);
});

test('isAllowedBuildUrl rejects different host', () => {
  const url = 'https://evil.com/viewLog.html?buildId=123';
  const baseUrl = 'https://teamcity.example';
  assert.strictEqual(isAllowedBuildUrl(url, baseUrl), false);
});

test('isAllowedBuildUrl rejects subdomain attack', () => {
  const url = 'https://teamcity.example.evil.com/viewLog.html?buildId=123';
  const baseUrl = 'https://teamcity.example';
  assert.strictEqual(isAllowedBuildUrl(url, baseUrl), false);
});

test('isAllowedBuildUrl rejects different scheme', () => {
  const url = 'http://teamcity.example/viewLog.html?buildId=123';
  const baseUrl = 'https://teamcity.example';
  assert.strictEqual(isAllowedBuildUrl(url, baseUrl), false);
});

test('isAllowedBuildUrl rejects different port', () => {
  const url = 'https://teamcity.example:8080/viewLog.html?buildId=123';
  const baseUrl = 'https://teamcity.example';
  assert.strictEqual(isAllowedBuildUrl(url, baseUrl), false);
});

test('isAllowedBuildUrl handles invalid URLs gracefully', () => {
  assert.strictEqual(isAllowedBuildUrl('not-a-url', 'https://teamcity.example'), false);
  assert.strictEqual(isAllowedBuildUrl('https://teamcity.example', 'not-a-url'), false);
});
