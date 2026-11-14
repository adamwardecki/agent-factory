import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repoFromRemote } from '../cli/host.ts';
import { CALLER_PATHS, changedFiles, FACTORY_LABELS, parsePin, proposeFiles, releaseVersions } from '../cli/repo.ts';
import { factoryWith, installed, PIN } from './cli-fixtures.ts';
import { fake, fakeRepo } from './fake-github.ts';

test('the factory repo comes from the clone\'s origin remote in any of git\'s forms', () => {
  for (const url of ['https://github.com/o/agent-factory.git', 'https://github.com/o/agent-factory', 'git@github.com:o/agent-factory.git', 'ssh://git@github.com/o/agent-factory.git\n']) {
    assert.equal(repoFromRemote(url), 'o/agent-factory', url);
  }
  assert.throws(() => repoFromRemote('https://gitlab.com/o/agent-factory.git'), /--factory/);
});

test('the factory labels are every stage but done, and the planner\'s three', () => {
  assert.equal(FACTORY_LABELS.length, 13);
  assert.ok(FACTORY_LABELS.includes('agent:waiting') && FACTORY_LABELS.includes('ready-for-human'));
  assert.ok(!FACTORY_LABELS.includes('agent:done'));
});

test('a rendered caller\'s pin, interface and sweep are read back from its text', () => {
  const f = installed();
  const [router, stage] = CALLER_PATHS.map((p) => parsePin(f.repo.branches.get('main')?.get(p) ?? ''));
  assert.deepEqual(router, { factoryRepo: 'o/agent-factory', sha: PIN, interface: 1, cron: '*/30 * * * *' });
  assert.deepEqual(stage, { factoryRepo: 'o/agent-factory', sha: PIN, interface: 1, cron: null });
  assert.equal(parsePin('name: something else\n'), null);
});

test('a release\'s versions are read from its own router/config.ts', async () => {
  const f = fake(fakeRepo(), factoryWith({ [PIN]: [2, 3] }));
  assert.deepEqual(await releaseVersions(f.host.factory, PIN), { interface: 2, state: 3 });
});

test('proposeFiles opens one PR from a fresh branch, and returns an open one unchanged', async () => {
  const f = fake();
  const files = [{ path: 'a.txt', content: 'a\n' }];
  assert.deepEqual(await changedFiles(f.host.gh, 'main', files), files);
  const first = await proposeFiles(f.host.gh, 'factory/install', files, 'T', 'B');
  assert.deepEqual(first, { pr: 100, created: true });
  assert.equal(f.repo.branches.get('factory/install')?.get('a.txt'), 'a\n');
  assert.equal(f.repo.branches.get('main')?.get('a.txt'), undefined);
  const writes = f.writes.length;
  assert.deepEqual(await proposeFiles(f.host.gh, 'factory/install', [{ path: 'b.txt', content: 'b' }], 'T', 'B'), { pr: 100, created: false });
  assert.equal(f.writes.length, writes);
  // A branch left over from a closed PR starts again from the default branch.
  for (const p of f.repo.pulls) p.state = 'closed';
  f.repo.branches.get('factory/install')?.set('stale.txt', 'x');
  const again = await proposeFiles(f.host.gh, 'factory/install', files, 'T', 'B');
  assert.equal(again.created, true);
  assert.equal(f.repo.branches.get('factory/install')?.get('stale.txt'), undefined);
});
