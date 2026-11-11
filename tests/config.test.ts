import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attemptId, BOT_EMAIL, branchFor, isDryRun, isPaused, issueForBranch, parseRunTitle, RUN_WORKFLOWS, RUNNER_FOR, runTitle, STAGE_FOR, STAGE_WORKFLOW_PATH, stageLabel } from '../router/config.ts';

test('branch names round-trip to issue numbers', () => {
  assert.equal(branchFor(12), 'factory/issue-12');
  assert.equal(issueForBranch('factory/issue-12'), 12);
});

test('branches outside the factory map to no issue', () => {
  assert.equal(issueForBranch('adamwardecki/feature'), null);
  assert.equal(issueForBranch('factory/issue-12-extra'), null);
});

test('labels use the documented format, and the stage workflow and bot identity are fixed', () => {
  assert.equal(stageLabel('in-review'), 'agent:in-review');
  assert.equal(STAGE_WORKFLOW_PATH, '.github/workflows/factory-stage.yml');
  assert.equal(BOT_EMAIL, '41898282+github-actions[bot]@users.noreply.github.com');
});

test('run titles carry the workflow, issue and attempt, and parse back', () => {
  assert.equal(runTitle('build', 7, 'mhs1abc'), 'factory-build #7 mhs1abc');
  assert.deepEqual(parseRunTitle('factory-verify #49 mhs1abc'), { workflow: 'verify', issue: 49, attempt: 'mhs1abc' });
  for (const bad of ['factory-build #7', 'factory-deploy #7 abc', 'factory-build #0 abc', 'factory-build #7 ABC', 'x factory-build #7 abc', 'factory-build #7 abc x']) {
    assert.equal(parseRunTitle(bad), null, bad);
  }
});

test('attempt ids differ from one millisecond to the next', () => {
  const a = attemptId(new Date('2026-11-09T12:00:00.000Z'));
  assert.match(a, /^[0-9a-z]{8,9}$/);
  assert.notEqual(a, attemptId(new Date('2026-11-09T12:00:00.001Z')));
});

test('every dispatched workflow maps to its stage and back', () => {
  for (const w of RUN_WORKFLOWS) assert.equal(RUNNER_FOR[STAGE_FOR[w]], w);
  assert.equal(STAGE_FOR.verify, 'ci');
});

test('dry run and pause fail safe on a typo', () => {
  assert.equal(isDryRun('0'), false);
  for (const v of [undefined, '', '1', ')', 'false', ' 0']) assert.equal(isDryRun(v), true, String(v));
  for (const v of [undefined, '', '0']) assert.equal(isPaused(v), false, String(v));
  for (const v of ['1', 'true', ')', ' ']) assert.equal(isPaused(v), true, v);
});
