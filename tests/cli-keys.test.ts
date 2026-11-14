import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pause, resume, rotateKey } from '../cli/keys.ts';
import { isPaused } from '../router/config.ts';
import { installed } from './cli-fixtures.ts';

test('rotate-key refuses while issues are in flight, unless --now', async () => {
  const f = installed((r) => r.issues.push({ number: 7, labels: ['agent:building'] }));
  await assert.rejects(rotateKey(f.host, false), /issues in flight: #7.*rotate-key --now/s);
  assert.deepEqual(f.writes, []);
  assert.match(await rotateKey(f.host, true), /blocks #7 with key-rotated/);
  assert.match(f.secretValues.get('FACTORY_SIGNING_KEY') ?? '', /^[0-9a-f]{64}$/);
  const idle = installed();
  assert.equal(await rotateKey(idle.host, false), 'replaced FACTORY_SIGNING_KEY');
});

test('pause sets FACTORY_PAUSED to a value the router reads as paused, and resume removes it', async () => {
  const f = installed();
  await pause(f.host);
  assert.ok(isPaused(f.repo.variables.get('FACTORY_PAUSED')));
  await pause(f.host);
  await resume(f.host);
  assert.ok(!isPaused(f.repo.variables.get('FACTORY_PAUSED')));
  assert.equal(f.repo.variables.has('FACTORY_PAUSED'), false);
  await resume(f.host);
});
