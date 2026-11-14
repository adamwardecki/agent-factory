import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CREDENTIAL_STEP } from '../router/config.ts';
import { checkReport, conclude, runSnapshot } from '../router/report.ts';

const run = {
  path: '.github/workflows/factory-stage.yml',
  event: 'workflow_dispatch',
  head_repository: { full_name: 'o/r' },
  display_title: 'factory-build #49 mhs1abc',
  html_url: 'https://github.com/o/r/actions/runs/9',
  status: 'in_progress',
};
const jobs = [
  { name: 'stage / prepare', conclusion: 'success', status: 'completed' },
  { name: 'stage / agent', conclusion: 'success', status: 'completed' },
  { name: 'stage / publish', conclusion: null, status: 'in_progress' },
];
const r = { workflow: 'build' as const, issue: 49, attempt: 'mhs1abc', runId: 9, result: 'success' as const };
const NOW = new Date('2026-11-10T10:05:00Z');

test('a report about a real stage run becomes a finished run for that attempt', () => {
  assert.deepEqual(checkReport(r, run, jobs, 'o/r', NOW), {
    workflow: 'build',
    attempt: 'mhs1abc',
    conclusion: 'success',
    url: 'https://github.com/o/r/actions/runs/9',
    completedAt: NOW.toISOString(),
  });
});

test('success needs prepare, agent and publish', () => {
  const failed = jobs.map((j) => (j.name.endsWith('agent') ? { ...j, conclusion: 'failure' } : j));
  assert.equal(checkReport(r, run, failed, 'o/r', NOW)?.conclusion, 'failure');
  assert.equal(checkReport({ ...r, result: 'failure' }, run, jobs, 'o/r', NOW)?.conclusion, 'failure');
  assert.equal(conclude('build', jobs), 'failure', 'without a report, a publish job still running is not a success');
  assert.equal(conclude('build', jobs.map((j) => ({ ...j, conclusion: 'success' }))), 'success');
});

test('reports about other runs, issues or attempts are refused', () => {
  assert.equal(checkReport(r, { ...run, path: '.github/workflows/other.yml' }, jobs, 'o/r', NOW), null);
  assert.equal(checkReport(r, { ...run, event: 'push' }, jobs, 'o/r', NOW), null);
  assert.equal(checkReport(r, { ...run, head_repository: { full_name: 'fork/r' } }, jobs, 'o/r', NOW), null);
  assert.equal(checkReport(r, { ...run, display_title: 'factory-build #50 mhs1abc' }, jobs, 'o/r', NOW), null);
  assert.equal(checkReport(r, { ...run, display_title: 'factory-build #49 older1' }, jobs, 'o/r', NOW), null);
  assert.equal(checkReport(r, { ...run, display_title: 'factory-build #49' }, jobs, 'o/r', NOW), null);
  assert.equal(checkReport({ ...r, workflow: 'plan' }, run, jobs, 'o/r', NOW), null);
});

test('a report sent while an earlier job is still running is ignored, not counted as a failure', () => {
  const early = jobs.map((j) => (j.name.endsWith('agent') ? { ...j, conclusion: null, status: 'in_progress' } : j));
  assert.equal(checkReport(r, run, early, 'o/r', NOW)?.completedAt, null, 'the agent job has not finished: nothing has happened yet');
  assert.equal(checkReport(r, run, early, 'o/r', NOW)?.conclusion, null);
  // The reporting job itself is the only one allowed to still be running.
  assert.equal(checkReport(r, run, jobs, 'o/r', NOW)?.conclusion, 'success');
  // And it has to be there: a report with no publish job in the run proves nothing.
  assert.equal(checkReport(r, run, jobs.slice(0, 2), 'o/r', NOW)?.completedAt, null);
  const verifyRun = { ...run, display_title: 'factory-verify #49 mhs1abc' };
  const vr = { ...r, workflow: 'verify' as const };
  const running = [
    { name: 'verify / prepare', conclusion: 'success', status: 'completed' },
    { name: 'verify / verify', conclusion: null, status: 'in_progress' },
    { name: 'verify / report', conclusion: null, status: 'in_progress' },
  ];
  assert.equal(checkReport(vr, verifyRun, running, 'o/r', NOW)?.completedAt, null, 'a forged report while the checks still run');
});

test('verify tells red checks from a run that broke before them', () => {
  const v = (prepare: string | null, verify: string | null) => [
    { name: 'verify / prepare', conclusion: prepare, status: 'completed' },
    { name: 'verify / verify', conclusion: verify, status: 'completed' },
    { name: 'verify / report', conclusion: null, status: 'in_progress' },
  ];
  assert.equal(conclude('verify', v('success', 'success')), 'success');
  assert.equal(conclude('verify', v('success', 'failure')), 'failure');
  assert.equal(conclude('verify', v('failure', 'skipped')), 'startup_failure');
  assert.equal(conclude('verify', v('success', 'cancelled')), 'cancelled');
});

test('the sweep reads a run that is still going as unfinished', () => {
  const s = runSnapshot(run, jobs, 'o/r', NOW);
  assert.equal(s?.completedAt, null);
  assert.equal(s?.conclusion, null);
  const done = runSnapshot({ ...run, status: 'completed', updated_at: '2026-11-10T10:04:00Z' }, jobs.map((j) => ({ ...j, conclusion: 'success' })), 'o/r', NOW);
  assert.equal(done?.completedAt, '2026-11-10T10:04:00Z');
  assert.equal(done?.conclusion, 'success');
});

test('a run whose jobs have all finished counts as finished before the run itself reads completed', () => {
  const allDone = [
    { name: 'verify / prepare', conclusion: 'success', status: 'completed' },
    { name: 'verify / verify', conclusion: 'failure', status: 'completed' },
    { name: 'verify / report', conclusion: 'success', status: 'completed' },
  ];
  const s = runSnapshot({ ...run, display_title: 'factory-verify #49 mhs1abc', status: 'in_progress' }, allDone, 'o/r', NOW);
  assert.equal(s?.conclusion, 'failure');
  assert.ok(s?.completedAt);
  // Without the reporting job there is nothing to go on, and a job still running means the run is not over.
  assert.equal(runSnapshot({ ...run, display_title: 'factory-verify #49 mhs1abc', status: 'in_progress' }, allDone.slice(0, 2), 'o/r', NOW)?.completedAt, null);
  assert.equal(runSnapshot({ ...run, display_title: 'factory-verify #49 mhs1abc', status: 'in_progress' }, [...allDone.slice(0, 2), { name: 'verify / report', conclusion: null, status: 'in_progress' }], 'o/r', NOW)?.completedAt, null);
});

test('an agent job whose credential step failed reads as a refused credential, and only that step counts', () => {
  const agent = (steps: { name: string; conclusion: string | null }[]) => [
    { name: 'stage / prepare', conclusion: 'success', status: 'completed' },
    { name: 'stage / agent', conclusion: 'failure', status: 'completed', steps },
    { name: 'stage / publish', conclusion: 'success', status: 'completed' },
  ];
  assert.equal(conclude('build', agent([{ name: CREDENTIAL_STEP, conclusion: 'failure' }])), 'credential');
  assert.equal(conclude('build', agent([{ name: CREDENTIAL_STEP, conclusion: 'success' }])), 'failure', 'checked and passed: another failure');
  assert.equal(conclude('build', agent([{ name: CREDENTIAL_STEP, conclusion: 'skipped' }])), 'failure');
  assert.equal(conclude('build', agent([{ name: 'Run tests', conclusion: 'failure' }])), 'failure');
  assert.equal(conclude('build', agent([])), 'failure');
});
