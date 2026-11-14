import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../cli/factory.ts';
import { installed } from './cli-fixtures.ts';
import { fake } from './fake-github.ts';

test('the CLI prints its usage without a command or a repo', async () => {
  const out: string[] = [];
  assert.equal(await main([], () => fake().host, (l) => out.push(l)), 2);
  assert.match(out.join('\n'), /usage:/);
  assert.equal(await main(['doctor'], () => fake().host, (l) => out.push(l)), 2);
  assert.equal(await main(['frobnicate', '--repo', 'o/app', '--factory', 'o/agent-factory'], () => fake().host, (l) => out.push(l)), 2);
});

test('the CLI runs doctor, and exits 1 only on an error', async () => {
  const out: string[] = [];
  assert.equal(await main(['doctor', '--repo', 'o/app', '--factory', 'o/agent-factory'], () => fake().host, (l) => out.push(l)), 1);
  assert.match(out.join('\n'), /^error/m);
  assert.equal(await main(['doctor', '--repo', 'o/app', '--factory', 'o/agent-factory'], () => installed().host, () => {}), 0);
});

test('the CLI refuses a repo that is not owner/name', async () => {
  await assert.rejects(main(['doctor', '--repo', 'not a repo', '--factory', 'o/agent-factory'], () => fake().host, () => {}), /not an owner\/repo/);
});
