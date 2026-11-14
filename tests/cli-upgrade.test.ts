import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALLER_PATHS, parsePin } from '../cli/repo.ts';
import { upgrade } from '../cli/upgrade.ts';
import { factoryWith, installed, NEXT, PIN } from './cli-fixtures.ts';
import { fake } from './fake-github.ts';

test('upgrade opens a pull request with the callers at the new pin, keeping the sweep', async () => {
  const f = installed((r) => {
    const p = '.github/workflows/factory-router.yml';
    r.branches.get('main')?.set(p, (r.branches.get('main')?.get(p) ?? '').replace("- cron: '*/30 * * * *'", "- cron: '0 * * * *'"));
  });
  const r = await upgrade(f.host, NEXT);
  assert.equal(r.pr, 100);
  const files = f.repo.branches.get(`factory/upgrade-${NEXT.slice(0, 7)}`);
  for (const p of CALLER_PATHS) assert.equal(parsePin(files?.get(p) ?? '')?.sha, NEXT, p);
  assert.equal(parsePin(files?.get(CALLER_PATHS[0] ?? '') ?? '')?.cron, '0 * * * *');
  const before = f.writes.length;
  assert.match((await upgrade(f.host, NEXT)).message, /already open/);
  assert.equal(f.writes.length, before);
  assert.match((await upgrade(f.host, PIN)).message, /already pin/);
});

test('upgrade to a newer state version waits until no issue still holds a state older than the pinned release\'s', async () => {
  const state = (v: number) => `<!-- factory:state {"v":${v},"stage":"ready","since":"2026-11-14T00:00:00.000Z","round":0,"attempts":0,"runs":[]} -->\nFactory: **ready**`;
  const old = installed((r) => r.issues.push({ number: 7, labels: ['agent:ready'], comments: ['hello', state(1)] }));
  old.factory.commits = factoryWith({ [PIN]: [1, 2], [NEXT]: [1, 3] }).commits;
  await assert.rejects(upgrade(old.host, NEXT), /#7 still holds state version 1/);
  assert.deepEqual(old.writes, []);
  const moved = installed((r) => r.issues.push({ number: 7, labels: ['agent:ready'], comments: [state(1), state(2)] }));
  moved.factory.commits = factoryWith({ [PIN]: [1, 2], [NEXT]: [1, 3] }).commits;
  assert.equal((await upgrade(moved.host, NEXT)).pr, 100);
});

test('upgrade refuses a release more than one version away, a downgrade, and an unknown commit', async () => {
  const cases: [Record<string, [number, number]>, RegExp][] = [
    [{ [PIN]: [1, 1], [NEXT]: [3, 1] }, /caller interface 3, more than one step from 1; upgrade to a release with caller interface 2 first/],
    [{ [PIN]: [1, 1], [NEXT]: [1, 3] }, /state version 3, more than one step/],
    [{ [PIN]: [1, 2], [NEXT]: [1, 1] }, /older than the pinned release/],
  ];
  for (const [versions, re] of cases) {
    const f = installed();
    f.factory.commits = factoryWith(versions).commits;
    await assert.rejects(upgrade(f.host, NEXT), re);
    assert.deepEqual(f.writes, []);
  }
  await assert.rejects(upgrade(installed().host, 'd'.repeat(40)), /isn't a commit/);
  await assert.rejects(upgrade(fake(undefined, factoryWith()).host, NEXT), /run init first/);
});
