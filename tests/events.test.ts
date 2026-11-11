import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEvent } from '../router/events.ts';

const REPO = 'o/r';
const ours = { full_name: REPO };
const fork = { full_name: 'mallory/r' };
const parse = (name: string, payload: unknown) => parseEvent(name, payload, REPO);

function build(name: string, payload: unknown, issue = 7) {
  const parsed = parse(name, payload);
  assert.ok(parsed && parsed !== 'sweep', `expected an event for ${name}`);
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

test('a finished CI run on a factory branch', () => {
  const { target, event } = build('workflow_run', {
    action: 'completed',
    workflow_run: { name: 'CI', head_branch: 'factory/issue-7', head_repository: ours, head_sha: 'sha-1', html_url: 'https://example.test/r/1', conclusion: 'failure', status: 'completed', created_at: '2026-11-09T11:20:00Z', updated_at: '2026-11-09T11:30:00Z' },
  });
  assert.deepEqual(target, { issue: 7 });
  assert.deepEqual(event, {
    kind: 'run-finished',
    issue: 7,
    run: { workflow: 'ci', conclusion: 'failure', headSha: 'sha-1', url: 'https://example.test/r/1', createdAt: '2026-11-09T11:20:00Z', completedAt: '2026-11-09T11:30:00Z' },
  });
});

test('a finished stage run is matched by its run-name', () => {
  const { target, event } = build('workflow_run', {
    action: 'completed',
    workflow_run: { name: 'factory-review', display_title: 'factory-review #12', event: 'workflow_dispatch', path: '.github/workflows/factory-review.yml', head_repository: ours, head_sha: 'main-sha', html_url: 'https://example.test/r/2', conclusion: 'success', status: 'completed', updated_at: '2026-11-09T11:40:00Z' },
  }, 12);
  assert.deepEqual(target, { issue: 12 });
  assert.equal(event.kind === 'run-finished' && event.run.workflow, 'review');
  assert.equal(parse('workflow_run', { action: 'completed', workflow_run: { name: 'Pages', display_title: 'x' } }), null);
});

// Forged and foreign runs and PRs

const stageRun = (extra: Record<string, unknown> = {}) => ({
  action: 'completed',
  workflow_run: {
    name: 'factory-build',
    display_title: 'factory-build #7',
    event: 'workflow_dispatch',
    path: '.github/workflows/factory-build.yml',
    head_repository: ours,
    head_sha: 'main-sha',
    html_url: 'https://github.com/o/r/actions/runs/5',
    conclusion: 'success',
    status: 'completed',
    created_at: '2026-11-09T11:20:00Z',
    updated_at: '2026-11-09T11:40:00Z',
    ...extra,
  },
});

test('a stage run counts only when dispatched from this repo\'s own stage workflow', () => {
  assert.equal(build('workflow_run', stageRun()).event.kind, 'run-finished');
  // Any workflow can take a run-name like "factory-build #7"; a fork's pull_request run can too.
  assert.equal(parse('workflow_run', stageRun({ head_repository: fork })), null);
  assert.equal(parse('workflow_run', stageRun({ head_repository: null })), null);
  assert.equal(parse('workflow_run', stageRun({ event: 'pull_request' })), null);
  assert.equal(parse('workflow_run', stageRun({ path: '.github/workflows/other.yml' })), null);
  assert.equal(parse('workflow_run', stageRun({ path: '.github/workflows/factory-review.yml' })), null);
});

test('a CI run counts only from a factory branch in this repo', () => {
  const ci = (extra: Record<string, unknown>) => ({ action: 'completed', workflow_run: { name: 'CI', head_branch: 'factory/issue-7', head_repository: ours, status: 'completed', ...extra } });
  assert.ok(parse('workflow_run', ci({})));
  assert.equal(parse('workflow_run', ci({ head_repository: fork })), null);
  assert.equal(parse('workflow_run', ci({ head_repository: undefined })), null);
  assert.equal(parse('workflow_run', ci({ head_branch: 'main' })), null);
});

test('reviews and closes on a fork\'s PR from a factory-named branch are ignored', () => {
  const review = { action: 'submitted', review: { state: 'changes_requested', user: { login: 'adamwardecki' } }, pull_request: { head: { ref: 'factory/issue-7', repo: fork } } };
  assert.equal(parse('pull_request_review', review), null);
  assert.equal(parse('pull_request_target', { action: 'closed', pull_request: { number: 52, head: { ref: 'factory/issue-7', repo: fork } } }), null);
  assert.equal(parse('pull_request_target', { action: 'closed', pull_request: { number: 52, head: { ref: 'factory/issue-7', repo: null } } }), null);
});
