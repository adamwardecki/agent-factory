import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stale } from '../router/attempt.ts';
import type { FactoryState } from '../router/markers.ts';

const st = (stage: FactoryState['stage'], attempt?: string): FactoryState => ({ stage, since: '2026-11-09T11:00:00Z', round: 0, attempts: 0, runs: [], attempt });

test('only the current attempt of the stage the issue is in may act', () => {
  assert.equal(stale(st('building', 'a1'), 'build', 'a1'), null);
  assert.equal(stale(st('ci', 'a1'), 'verify', 'a1'), null);
  assert.match(stale(st('building', 'a2'), 'build', 'a1') ?? '', /no longer current/);
  assert.match(stale(st('blocked'), 'build', 'a1') ?? '', /at blocked, not building/);
  assert.match(stale(st('ci', 'a1'), 'build', 'a1') ?? '', /at ci, not building/);
  assert.match(stale(st('building'), 'build', 'a1') ?? '', /no longer current/);
  assert.match(stale(null, 'build', 'a1') ?? '', /no signed factory state/);
});
