import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchFor, factoryBotLogin, issueForBranch, runTitle, stageLabel } from '../router/config.ts';

test('branch names round-trip to issue numbers', () => {
  assert.equal(branchFor(12), 'factory/issue-12');
  assert.equal(issueForBranch('factory/issue-12'), 12);
});

test('branches outside the factory map to no issue', () => {
  assert.equal(issueForBranch('adamwardecki/feature'), null);
  assert.equal(issueForBranch('factory/issue-12-extra'), null);
});

test('labels and run titles use the documented formats', () => {
  assert.equal(stageLabel('in-review'), 'agent:in-review');
  assert.equal(runTitle('build', 7), 'factory-build #7');
});

test('FACTORY_BOT_LOGIN must be an App slug with [bot]', (t) => {
  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.FACTORY_BOT_LOGIN;
    else process.env.FACTORY_BOT_LOGIN = v;
  };
  const before = process.env.FACTORY_BOT_LOGIN;
  t.after(() => set(before));
  set('factory-app[bot]');
  assert.equal(factoryBotLogin(), 'factory-app[bot]');
  for (const bad of [undefined, '', '[bot]', 'adamwardecki', 'Factory[bot]', '-app[bot]', 'a b[bot]', 'app[bot] ', 'x[bot][bot]', 'app/../[bot]']) {
    set(bad);
    assert.throws(() => factoryBotLogin(), /FACTORY_BOT_LOGIN/, String(bad));
  }
});
