import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEvent } from '../router/events.ts';

const REPO = 'o/r';
const ours = { full_name: REPO };
const fork = { full_name: 'mallory/r' };
const parse = (name: string, payload: unknown) => parseEvent(name, payload, REPO);

function build(name: string, payload: unknown, issue = 7) {
  const parsed = parse(name, payload);
  assert.ok(parsed && parsed !== 'sweep' && 'target' in parsed, `expected an event for ${name}`);
  return { target: parsed.target, event: parsed.build(issue) };
}

test('schedule and manual runs sweep', () => {
  assert.equal(parse('schedule', {}), 'sweep');
  assert.equal(parse('workflow_dispatch', {}), 'sweep');
});

test('adding agent:queued queues the issue', () => {
  const { target, event } = build('issues', { action: 'labeled', label: { name: 'agent:queued' }, issue: { number: 7 }, sender: { login: 'adamwardecki' } });
  assert.deepEqual(target, { issue: 7 });
  assert.deepEqual(event, { kind: 'queued', issue: 7, actor: 'adamwardecki' });
  assert.equal(parse('issues', { action: 'labeled', label: { name: 'bug' }, issue: { number: 7 } }), null);
});

test('slash commands on issues and PRs', () => {
  const onIssue = build('issue_comment', { action: 'created', issue: { number: 7 }, comment: { body: '/approve', user: { login: 'adamwardecki' } } });
  assert.deepEqual(onIssue.target, { issue: 7 });
  assert.deepEqual(onIssue.event, { kind: 'command', issue: 7, command: 'approve', actor: 'adamwardecki' });
  const onPr = build('issue_comment', { action: 'created', issue: { number: 51, pull_request: {} }, comment: { body: '/stop', user: { login: 'adamwardecki' } } });
  assert.deepEqual(onPr.target, { pr: 51 });
  assert.equal(parse('issue_comment', { action: 'created', issue: { number: 7 }, comment: { body: 'nice' } }), null);
});

test('a changes-requested review on a factory branch', () => {
  const { target, event } = build('pull_request_review', {
    action: 'submitted',
    review: { state: 'changes_requested', user: { login: 'adamwardecki' } },
    pull_request: { head: { ref: 'factory/issue-7', repo: ours } },
  });
  assert.deepEqual(target, { issue: 7 });
  assert.deepEqual(event, { kind: 'changes-requested', issue: 7, actor: 'adamwardecki' });
  assert.equal(parse('pull_request_review', { action: 'submitted', review: { state: 'approved' }, pull_request: { head: { ref: 'factory/issue-7', repo: ours } } }), null);
  assert.equal(parse('pull_request_review', { action: 'submitted', review: { state: 'changes_requested' }, pull_request: { head: { ref: 'main', repo: ours } } }), null);
});

test('a closed factory PR', () => {
  const { event } = build('pull_request_target', { action: 'closed', pull_request: { number: 51, head: { ref: 'factory/issue-7', repo: ours } } });
  assert.deepEqual(event, { kind: 'pr-closed', issue: 7, pr: 51 });
  assert.equal(parse('pull_request_target', { action: 'closed', pull_request: { head: { ref: 'factory/issue-7', repo: ours } } }), null);
});



// Forged and foreign runs and PRs

const stageRun = (extra: Record<string, unknown> = {}) => ({
  action: 'completed',
  workflow_run: {
    name: 'factory-stage',
    display_title: 'factory-build #7 mhs1abc',
    event: 'workflow_dispatch',
    path: '.github/workflows/factory-stage.yml',
    head_repository: ours,
    html_url: 'https://github.com/o/r/actions/runs/5',
    conclusion: 'success',
    status: 'completed',
    updated_at: '2026-11-09T11:40:00Z',
    ...extra,
  },
});

test('workflow_run events are ignored: they never fire for runs GITHUB_TOKEN dispatched', () => {
  assert.equal(parse('workflow_run', stageRun()), null);
  assert.equal(parse('workflow_run', { action: 'completed', workflow_run: { head_repository: fork } }), null);
});

test('a report dispatch carries the stage, issue, attempt, run and result', () => {
  const inputs = { report_stage: 'verify', report_issue: '49', report_attempt: 'mhs1abc', report_run_id: '42870928742', report_result: 'failure' };
  assert.deepEqual(parse('workflow_dispatch', { inputs }), { report: { workflow: 'verify', issue: 49, attempt: 'mhs1abc', runId: 42870928742, result: 'failure' } });
});

test('a malformed report is ignored, not treated as a sweep', () => {
  const good = { report_stage: 'build', report_issue: '1', report_attempt: 'mhs1abc', report_run_id: '2', report_result: 'success' };
  for (const bad of [{ report_stage: 'deploy' }, { report_issue: 'x' }, { report_result: 'maybe' }, { report_attempt: '' }, { report_attempt: 'a b' }]) {
    assert.equal(parse('workflow_dispatch', { inputs: { ...good, ...bad } }), null, JSON.stringify(bad));
  }
  assert.equal(parse('workflow_dispatch', { inputs: {} }), 'sweep', 'a plain manual run');
});

test('reviews and closes on a fork\'s PR from a factory-named branch are ignored', () => {
  const review = { action: 'submitted', review: { state: 'changes_requested', user: { login: 'adamwardecki' } }, pull_request: { head: { ref: 'factory/issue-7', repo: fork } } };
  assert.equal(parse('pull_request_review', review), null);
  assert.equal(parse('pull_request_target', { action: 'closed', pull_request: { number: 52, head: { ref: 'factory/issue-7', repo: fork } } }), null);
  assert.equal(parse('pull_request_target', { action: 'closed', pull_request: { number: 52, head: { ref: 'factory/issue-7', repo: null } } }), null);
});
