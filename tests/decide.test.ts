import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Stage } from '../router/config.ts';
import {
  type Action,
  type Ctx,
  decideEvent,
  type IssueSnapshot,
  next,
  type PullSnapshot,
  type RunSnapshot,
  sweep,
} from '../router/decide.ts';
import type { FactoryState } from '../router/markers.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const SINCE = '2026-11-09T11:00:00.000Z';
const ctx: Ctx = { now: NOW, risky: ['plugin/hooks/**', 'factory/**', 'AGENTS.md', '.claude/**'] };

function st(stage: Stage, extra: Partial<FactoryState> = {}): FactoryState {
  return { stage, since: SINCE, round: 0, attempts: 0, runs: [], ...extra };
}
function snap(state: FactoryState | null, extra: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return { number: 7, state, labels: [], queuedBy: null, brief: null, pr: null, review: null, lastCommand: null, lastChangesRequested: null, lastRun: null, ...extra };
}
function pr(extra: Partial<PullSnapshot> = {}): PullSnapshot {
  return { number: 51, headSha: 'sha-1', open: true, draft: true, conflicting: false, files: ['plugin/servers/tracker/src/report.ts'], ...extra };
}
function run(workflow: RunSnapshot['workflow'], conclusion: string | null = 'success', extra: Partial<RunSnapshot> = {}): RunSnapshot {
  return { workflow, conclusion, headSha: 'sha-1', url: `https://example.test/runs/${workflow}-${conclusion}`, createdAt: '2026-11-09T11:10:00Z', completedAt: '2026-11-09T11:30:00Z', ...extra };
}
const saves = (a: Action[]) => a.flatMap((x) => (x.kind === 'save' ? [x.state] : []));
const stages = (a: Action[]) => saves(a).map((s) => s.stage);
const dispatches = (a: Action[]) => a.flatMap((x) => (x.kind === 'dispatch' ? [x.workflow] : []));
const comments = (a: Action[]) => a.flatMap((x) => (x.kind === 'comment' ? [x.body] : []));
const finished = (s: IssueSnapshot, r: RunSnapshot) => decideEvent({ kind: 'run-finished', issue: 7, run: r }, s, ctx);

test('the maintainer queues an issue', () => {
  const a = decideEvent({ kind: 'queued', issue: 7, actor: 'adamwardecki' }, snap(null), ctx);
  assert.deepEqual(stages(a), ['queued']);
  assert.equal(saves(a)[0]?.since, NOW.toISOString());
  assert.deepEqual(dispatches(a), []);
});

test('nobody else can queue, and an issue in progress is not requeued', () => {
  assert.deepEqual(decideEvent({ kind: 'queued', issue: 7, actor: 'someone' }, snap(null), ctx), []);
  assert.deepEqual(decideEvent({ kind: 'queued', issue: 7, actor: 'adamwardecki' }, snap(st('building')), ctx), []);
});

test('a blocked issue can be queued again from scratch', () => {
  const a = decideEvent({ kind: 'queued', issue: 7, actor: 'adamwardecki' }, snap(st('blocked', { round: 3 })), ctx);
  assert.equal(saves(a)[0]?.round, 0);
});

test('next starts the oldest queued issue when the factory is idle', () => {
  const older = { ...snap(st('queued', { since: '2026-11-09T09:00:00Z' })), number: 3 };
  const newer = { ...snap(st('queued', { since: '2026-11-09T10:00:00Z' })), number: 4 };
  const waiting = { ...snap(st('ready')), number: 5 };
  const a = next([newer, older, waiting], ctx);
  assert.deepEqual(stages(a), ['planning']);
  assert.deepEqual(dispatches(a), ['plan']);
  assert.ok(a.some((x) => x.kind === 'save' && x.issue === 3));
  assert.ok(a.some((x) => x.kind === 'unlabel' && x.labels.includes('ready-for-agent')));
});

test('next does nothing while another issue is active', () => {
  const busy = { ...snap(st('in-review')), number: 2 };
  const queued = { ...snap(st('queued')), number: 3 };
  assert.deepEqual(next([busy, queued], ctx), []);
});

test('a closed PR finishes the issue', () => {
  assert.deepEqual(stages(decideEvent({ kind: 'pr-closed', issue: 7, pr: 51 }, snap(st('ready', { pr: 51 })), ctx)), ['done']);
  assert.deepEqual(stages(decideEvent({ kind: 'pr-closed', issue: 7, pr: 51 }, snap(st('building')), ctx)), ['done']);
  assert.deepEqual(decideEvent({ kind: 'pr-closed', issue: 7, pr: 51 }, snap(st('done')), ctx), []);
});

const BRIEF = { id: 900, touches: ['plugin/servers/tracker/src/report.ts'], at: '2026-11-09T11:20:00Z' };

test('a plan with a brief on safe paths goes straight to building', () => {
  const a = finished(snap(st('planning'), { brief: BRIEF, labels: ['ready-for-agent'] }), run('plan'));
  assert.deepEqual(stages(a), ['building']);
  assert.equal(saves(a)[0]?.brief, 900);
  assert.deepEqual(dispatches(a), ['build']);
  assert.deepEqual(saves(a)[0]?.runs, ['https://example.test/runs/plan-success']);
});

test('a plan touching risky paths waits for approval and lists them', () => {
  const risky = { ...BRIEF, touches: ['plugin/hooks/gates.ts', 'docs/setup.md'] };
  const a = finished(snap(st('planning'), { brief: risky, labels: ['ready-for-agent'] }), run('plan'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.approvalFor, 'plan');
  assert.deepEqual(dispatches(a), []);
  assert.match(comments(a)[0] ?? '', /`plugin\/hooks\/gates.ts`/);
  assert.doesNotMatch(comments(a)[0] ?? '', /docs\/setup.md/);
});

test('a plan with an empty Touches list waits for approval', () => {
  const a = finished(snap(st('planning'), { brief: { ...BRIEF, touches: [] }, labels: ['ready-for-agent'] }), run('plan'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
});

test('a planner that needs a human blocks the issue', () => {
  const a = finished(snap(st('planning'), { labels: ['needs-info'] }), run('plan'));
  assert.deepEqual(stages(a), ['blocked']);
  assert.equal(saves(a)[0]?.blockedFrom, 'planning');
  assert.match(comments(a)[0] ?? '', /\/retry/);
});

test('a plan without a fresh brief is a failed attempt, and the second one blocks', () => {
  const stale = { ...BRIEF, at: '2026-11-09T10:00:00Z' };
  const first = finished(snap(st('planning'), { brief: stale, labels: ['ready-for-agent'] }), run('plan'));
  assert.deepEqual(stages(first), ['planning']);
  assert.equal(saves(first)[0]?.attempts, 1);
  assert.equal(saves(first)[0]?.failedAt, NOW.toISOString());
  assert.deepEqual(dispatches(first), []);
  const second = finished(snap(st('planning', { attempts: 1 })), run('plan', 'success', { url: 'https://example.test/runs/2' }));
  assert.deepEqual(stages(second), ['blocked']);
});

test('a failed stage run counts as a failed attempt', () => {
  const a = finished(snap(st('building')), run('build', 'failure'));
  assert.equal(saves(a)[0]?.attempts, 1);
});

test('runs for another stage, still going, cancelled, already seen or older than the stage are ignored', () => {
  const s = snap(st('building'), { pr: pr() });
  assert.deepEqual(finished(s, run('plan')), []);
  assert.deepEqual(finished(s, run('build', 'success', { completedAt: null })), []);
  assert.deepEqual(finished(s, run('build', 'cancelled')), []);
  assert.deepEqual(finished(s, run('build', 'success', { createdAt: '2026-11-09T09:50:00Z', completedAt: '2026-11-09T10:00:00Z' })), []);
  const seen = snap(st('building', { runs: ['https://example.test/runs/build-success'] }), { pr: pr() });
  assert.deepEqual(finished(seen, run('build')), []);
});

test('a build that opened a PR waits for CI', () => {
  const a = finished(snap(st('building'), { pr: pr() }), run('build'));
  assert.deepEqual(stages(a), ['ci']);
  assert.equal(saves(a)[0]?.pr, 51);
  assert.deepEqual(dispatches(a), []);
});

test('a build without an open PR is a failed attempt', () => {
  const a = finished(snap(st('building'), { pr: pr({ open: false }) }), run('build'));
  assert.equal(saves(a)[0]?.attempts, 1);
});

test('green CI on the PR head goes to review; CI on an older head is ignored', () => {
  const s = snap(st('ci', { pr: 51 }), { pr: pr() });
  assert.deepEqual(stages(finished(s, run('ci'))), ['in-review']);
  assert.deepEqual(dispatches(finished(s, run('ci'))), ['review']);
  assert.deepEqual(finished(s, run('ci', 'success', { headSha: 'old' })), []);
});

test('red CI goes to the fixer and counts a round', () => {
  const a = finished(snap(st('ci', { pr: 51, round: 1 }), { pr: pr() }), run('ci', 'failure'));
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.round, 2);
  assert.equal(saves(a)[0]?.fixReason, 'ci');
  assert.equal(saves(a)[0]?.headSha, 'sha-1');
  assert.deepEqual(dispatches(a), ['fix']);
});

test('red CI after the last round blocks', () => {
  const a = finished(snap(st('ci', { pr: 51, round: 3 }), { pr: pr() }), run('ci', 'failure'));
  assert.deepEqual(stages(a), ['blocked']);
  assert.match(comments(a)[0] ?? '', /3 fix rounds/);
});

test('a review with blocking findings goes to the fixer', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr(), review: { blocking: 2, at: '2026-11-09T11:20:00Z' } });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'review');
  assert.equal(saves(a)[0]?.round, 1);
});

test('a clean review on safe files marks the PR ready', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr(), review: { blocking: 0, at: '2026-11-09T11:20:00Z' } });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['ready']);
  assert.ok(a.some((x) => x.kind === 'pr-ready' && x.pr === 51));
});

test('a clean review on a risky diff waits for approval', () => {
  const s = snap(st('in-review', { pr: 51 }), {
    pr: pr({ files: ['plugin/hooks/gates.ts'] }),
    review: { blocking: 0, at: '2026-11-09T11:20:00Z' },
  });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.approvalFor, 'diff');
  assert.equal(saves(a)[0]?.afterApproval, 'ready');
  assert.equal(saves(a)[0]?.approvalSha, 'sha-1');
  assert.ok(!a.some((x) => x.kind === 'pr-ready'));
});

test('a review run without a fresh factory review is a failed attempt', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr(), review: { blocking: 0, at: '2026-11-09T10:00:00Z' } });
  assert.equal(saves(finished(s, run('review')))[0]?.attempts, 1);
});

test('a fix that pushed goes back to CI; one that pushed nothing is a failed attempt', () => {
  const pushed = finished(snap(st('fixing', { pr: 51, headSha: 'sha-0' }), { pr: pr() }), run('fix'));
  assert.deepEqual(stages(pushed), ['ci']);
  const idle = finished(snap(st('fixing', { pr: 51, headSha: 'sha-1' }), { pr: pr() }), run('fix'));
  assert.equal(saves(idle)[0]?.attempts, 1);
});

const cmd = (s: IssueSnapshot, command: 'approve' | 'stop' | 'retry', actor = 'adamwardecki') =>
  decideEvent({ kind: 'command', issue: 7, command, actor }, s, ctx);

test('/approve on a plan starts the build; only the maintainer can approve', () => {
  const s = snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 }));
  assert.deepEqual(dispatches(cmd(s, 'approve')), ['build']);
  assert.equal(saves(cmd(s, 'approve'))[0]?.approvalFor, undefined);
  assert.deepEqual(cmd(s, 'approve', 'someone'), []);
});

test('/approve on a risky diff marks the PR ready', () => {
  const a = cmd(snap(st('awaiting-approval', { approvalFor: 'diff', pr: 51 })), 'approve');
  assert.deepEqual(stages(a), ['ready']);
  assert.ok(a.some((x) => x.kind === 'pr-ready' && x.pr === 51));
});

test('/approve outside awaiting-approval does nothing', () => {
  assert.deepEqual(cmd(snap(st('building')), 'approve'), []);
});

test('/stop blocks an issue in any live stage', () => {
  const a = cmd(snap(st('fixing')), 'stop');
  assert.deepEqual(stages(a), ['blocked']);
  assert.equal(saves(a)[0]?.blockedFrom, 'fixing');
  assert.deepEqual(cmd(snap(st('done')), 'stop'), []);
});

test('/retry resumes the blocked stage and keeps the round count', () => {
  const a = cmd(snap(st('blocked', { blockedFrom: 'planning', blockedFor: 'attempts', round: 2 })), 'retry');
  assert.deepEqual(stages(a), ['planning']);
  assert.equal(saves(a)[0]?.round, 2);
  assert.equal(saves(a)[0]?.blockedFor, undefined);
  assert.equal(saves(a)[0]?.blockedFrom, undefined);
  assert.deepEqual(dispatches(a), ['plan']);
});

test('/retry after the round cap at CI goes to the fixer with a fresh round count', () => {
  const a = cmd(snap(st('blocked', { blockedFrom: 'ci', blockedFor: 'rounds', round: 3, pr: 51 }), { pr: pr() }), 'retry');
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'ci');
  assert.equal(saves(a)[0]?.round, 0);
  assert.equal(saves(a)[0]?.headSha, 'sha-1');
  assert.deepEqual(dispatches(a), ['fix']);
});

test('the maintainer requesting changes on a ready PR starts an uncounted fix round', () => {
  const s = snap(st('ready', { pr: 51, round: 3 }), { pr: pr() });
  const a = decideEvent({ kind: 'changes-requested', issue: 7, actor: 'adamwardecki' }, s, ctx);
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.round, 3);
  assert.equal(saves(a)[0]?.fixReason, 'maintainer');
  assert.deepEqual(decideEvent({ kind: 'changes-requested', issue: 7, actor: 'someone' }, s, ctx), []);
});

test('the sweep retries a failed stage after an hour and keeps the attempt count', () => {
  const early = snap(st('building', { attempts: 1, failedAt: '2026-11-09T11:30:00Z' }));
  assert.deepEqual(sweep([early], ctx), []);
  const late = snap(st('building', { attempts: 1, failedAt: '2026-11-09T10:30:00Z' }));
  const a = sweep([late], ctx);
  assert.deepEqual(dispatches(a), ['build']);
  assert.equal(saves(a)[0]?.attempts, 1);
  assert.equal(saves(a)[0]?.failedAt, undefined);
});

test('the sweep processes a finished run whose event was missed', () => {
  const s = snap(st('building'), { pr: pr(), lastRun: run('build') });
  assert.deepEqual(stages(sweep([s], ctx)), ['ci']);
});

test('the sweep blocks a stage with no progress for 90 minutes', () => {
  const s = snap(st('in-review', { since: '2026-11-09T10:00:00Z' }), { lastRun: run('review', null, { completedAt: null }) });
  const a = sweep([s], ctx);
  assert.deepEqual(stages(a), ['blocked']);
  assert.match(comments(a)[0] ?? '', /90 minutes/);
});

test('the sweep processes a missed /approve', () => {
  const s = snap(st('awaiting-approval', { approvalFor: 'plan' }), { lastCommand: { command: 'approve', at: '2026-11-09T11:10:00Z', actor: 'adamwardecki' } });
  assert.deepEqual(dispatches(sweep([s], ctx)), ['build']);
  const old = snap(st('awaiting-approval', { approvalFor: 'plan' }), { lastCommand: { command: 'approve', at: '2026-11-09T10:10:00Z', actor: 'adamwardecki' } });
  assert.deepEqual(sweep([old], ctx), []);
});

test('the sweep picks up an agent:queued label whose event was missed, then starts it', () => {
  const a = sweep([snap(null, { labels: ['agent:queued'], queuedBy: { login: 'adamwardecki', at: '2026-11-09T11:50:00Z' } })], ctx);
  assert.deepEqual(stages(a), ['queued', 'planning']);
  assert.deepEqual(dispatches(a), ['plan']);
});

test('the sweep sends a conflicting ready PR back to rebase before starting new work', () => {
  const ready = { ...snap(st('ready', { pr: 51 }), { pr: pr({ conflicting: true }) }), number: 3 };
  const queued = { ...snap(st('queued')), number: 4 };
  const a = sweep([ready, queued], ctx);
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'rebase');
});

// Who queued the issue

const BY_MAINTAINER = { login: 'adamwardecki', at: '2026-11-09T11:50:00Z' };

test('the sweep does not queue an issue someone else labelled', () => {
  assert.deepEqual(sweep([snap(null, { labels: ['agent:queued'], queuedBy: { login: 'factory-app[bot]', at: '2026-11-09T11:50:00Z' } })], ctx), []);
  assert.deepEqual(sweep([snap(null, { labels: ['agent:queued'] })], ctx), []);
});

test('the sweep re-queues a blocked or done issue the maintainer labelled after it stopped', () => {
  for (const stage of ['blocked', 'done'] as const) {
    const a = sweep([snap(st(stage, { blockedFrom: 'ci', round: 3 }), { labels: ['agent:queued'], queuedBy: BY_MAINTAINER })], ctx);
    assert.deepEqual(stages(a), ['queued', 'planning']);
    assert.equal(saves(a)[0]?.round, 0);
  }
});

test('the sweep does not re-queue on a labelling older than the block, or by someone else', () => {
  const old = snap(st('blocked'), { labels: ['agent:queued'], queuedBy: { login: 'adamwardecki', at: '2026-11-09T10:00:00Z' } });
  assert.deepEqual(sweep([old], ctx), []);
  const other = snap(st('blocked'), { labels: ['agent:queued'], queuedBy: { login: 'someone', at: '2026-11-09T11:50:00Z' } });
  assert.deepEqual(sweep([other], ctx), []);
  const live = snap(st('building'), { labels: ['agent:queued'], queuedBy: BY_MAINTAINER });
  assert.deepEqual(stages(sweep([live], ctx)), []);
});

// Run freshness

test('a build run created before the stage began is ignored even if it finished after', () => {
  const s = snap(st('building'), { pr: pr() });
  assert.deepEqual(finished(s, run('build', 'success', { createdAt: '2026-11-09T10:55:00Z', completedAt: '2026-11-09T11:30:00Z' })), []);
  assert.deepEqual(finished(s, run('build', 'success', { createdAt: null })), []);
});

test('a run created in the same second the stage began counts', () => {
  // GitHub timestamps have whole seconds; the state's since has milliseconds.
  const s = snap(st('building', { since: '2026-11-09T11:00:00.700Z' }), { pr: pr() });
  assert.deepEqual(stages(finished(s, run('build', 'success', { createdAt: '2026-11-09T11:00:00Z' }))), ['ci']);
  assert.deepEqual(finished(s, run('build', 'success', { createdAt: '2026-11-09T10:59:59Z' })), []);
});

// Rebases

test('a rebase fix does not count a round but counts a rebase', () => {
  const ready = snap(st('ready', { pr: 51, round: 2 }), { pr: pr({ conflicting: true }) });
  const a = next([ready], ctx);
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.round, 2);
  assert.equal(saves(a)[0]?.rebases, 1);
  assert.deepEqual(dispatches(a), ['fix']);
});

test('the third rebase in a row blocks instead', () => {
  const ready = snap(st('ready', { pr: 51, rebases: 2, fixReason: 'rebase' }), { pr: pr({ conflicting: true }) });
  const a = next([ready], ctx);
  assert.deepEqual(stages(a), ['blocked']);
  assert.equal(saves(a)[0]?.blockedFor, 'rebases');
  assert.equal(saves(a)[0]?.blockedFrom, 'ready');
  assert.deepEqual(dispatches(a), []);
  assert.match(comments(a)[0] ?? '', /2 rebases/);
});

test('reaching ready through a rebase keeps the count; any other way resets it', () => {
  const review = { blocking: 0, at: '2026-11-09T11:20:00Z' };
  const afterRebase = finished(snap(st('in-review', { pr: 51, rebases: 1, fixReason: 'rebase' }), { pr: pr(), review }), run('review'));
  assert.deepEqual(stages(afterRebase), ['ready']);
  assert.equal(saves(afterRebase)[0]?.rebases, 1);
  const afterReview = finished(snap(st('in-review', { pr: 51, rebases: 1, fixReason: 'review' }), { pr: pr(), review }), run('review'));
  assert.equal(saves(afterReview)[0]?.rebases, undefined);
  const approved = cmd(snap(st('awaiting-approval', { approvalFor: 'diff', pr: 51, rebases: 2, fixReason: 'maintainer' })), 'approve');
  assert.equal(saves(approved)[0]?.rebases, undefined);
});

test('/retry after the rebase cap returns to ready with the count cleared', () => {
  const a = cmd(snap(st('blocked', { blockedFrom: 'ready', blockedFor: 'rebases', rebases: 2, round: 1, pr: 51 }), { pr: pr() }), 'retry');
  assert.deepEqual(stages(a), ['ready']);
  assert.equal(saves(a)[0]?.rebases, undefined);
  assert.equal(saves(a)[0]?.round, 1);
  assert.deepEqual(dispatches(a), []);
});

// Why an issue was blocked, and what /retry does about it

test('each way of blocking records why', () => {
  const failed = finished(snap(st('building', { attempts: 1 })), run('build', 'failure'));
  assert.equal(saves(failed)[0]?.blockedFor, 'attempts');
  const rounds = finished(snap(st('ci', { pr: 51, round: 3 }), { pr: pr() }), run('ci', 'failure'));
  assert.equal(saves(rounds)[0]?.blockedFor, 'rounds');
  const human = finished(snap(st('planning'), { labels: ['needs-info'] }), run('plan'));
  assert.equal(saves(human)[0]?.blockedFor, 'human');
  assert.equal(saves(cmd(snap(st('fixing')), 'stop'))[0]?.blockedFor, 'stop');
  const stuck = sweep([snap(st('in-review', { since: '2026-11-09T10:00:00Z' }))], ctx);
  assert.equal(saves(stuck)[0]?.blockedFor, 'stuck');
});

test('the round cap is also reached through blocking reviews', () => {
  const s = snap(st('in-review', { pr: 51, round: 3 }), { pr: pr(), review: { blocking: 1, at: '2026-11-09T11:20:00Z' } });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['blocked']);
  assert.equal(saves(a)[0]?.blockedFrom, 'in-review');
  assert.equal(saves(a)[0]?.blockedFor, 'rounds');
});

test('/retry after the round cap at review sends the findings to the fixer, not the reviewer', () => {
  const a = cmd(snap(st('blocked', { blockedFrom: 'in-review', blockedFor: 'rounds', round: 3, pr: 51 }), { pr: pr() }), 'retry');
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'review');
  assert.equal(saves(a)[0]?.round, 0);
  assert.deepEqual(dispatches(a), ['fix']);
});

test('/retry after CI was stuck or stopped waits on CI again rather than calling the fixer', () => {
  for (const blockedFor of ['stuck', 'stop'] as const) {
    const a = cmd(snap(st('blocked', { blockedFrom: 'ci', blockedFor, round: 1, pr: 51 }), { pr: pr() }), 'retry');
    assert.deepEqual(stages(a), ['ci']);
    assert.equal(saves(a)[0]?.round, 1);
    assert.deepEqual(dispatches(a), []);
  }
});

test('/retry of a stopped fixer resumes it with its reason', () => {
  const a = cmd(snap(st('blocked', { blockedFrom: 'fixing', blockedFor: 'stop', fixReason: 'maintainer', pr: 51 }), { pr: pr() }), 'retry');
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'maintainer');
  assert.equal(saves(a)[0]?.headSha, 'sha-1');
});

test('/retry into the fixer without a PR does nothing', () => {
  assert.deepEqual(cmd(snap(st('blocked', { blockedFrom: 'fixing', blockedFor: 'stuck', fixReason: 'ci' })), 'retry'), []);
  assert.deepEqual(cmd(snap(st('blocked', { blockedFrom: 'ci', blockedFor: 'rounds', round: 3 })), 'retry'), []);
});

test('/stop on a blocked issue and /retry on one that is not blocked do nothing', () => {
  assert.deepEqual(cmd(snap(st('blocked', { blockedFrom: 'ci' })), 'stop'), []);
  assert.deepEqual(cmd(snap(st('building')), 'retry'), []);
});

// Smaller rules

test('/approve needs to know what it approves', () => {
  assert.deepEqual(cmd(snap(st('awaiting-approval')), 'approve'), []);
  assert.deepEqual(stages(cmd(snap(st('awaiting-approval', { approvalFor: 'plan' })), 'approve')), ['building']);
});

test('a fix run with no recorded head is a failed attempt', () => {
  const a = finished(snap(st('fixing', { pr: 51 }), { pr: pr() }), run('fix'));
  assert.equal(saves(a)[0]?.attempts, 1);
});

test('a closed PR other than the issue\'s own does not finish it', () => {
  assert.deepEqual(decideEvent({ kind: 'pr-closed', issue: 7, pr: 60 }, snap(st('ready', { pr: 51 })), ctx), []);
});

test('commands and finished runs on an issue without state do nothing', () => {
  assert.deepEqual(cmd(snap(null), 'retry'), []);
  assert.deepEqual(finished(snap(null), run('build')), []);
});

test('next sends a conflicting ready PR to rebase', () => {
  const a = next([snap(st('ready', { pr: 51 }), { pr: pr({ conflicting: true }) })], ctx);
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'rebase');
});

test('the sweep leaves old ready, awaiting-approval and blocked issues alone', () => {
  const old = '2026-11-08T08:00:00.000Z';
  const s = [
    { ...snap(st('ready', { since: old, pr: 51 }), { pr: pr() }), number: 3 },
    { ...snap(st('awaiting-approval', { since: old, approvalFor: 'plan' })), number: 4 },
    { ...snap(st('blocked', { since: old, blockedFrom: 'ci' })), number: 5 },
  ];
  assert.deepEqual(sweep(s, ctx), []);
});

test('the sweep does not call a stage stuck before 90 minutes', () => {
  const s = snap(st('in-review', { since: '2026-11-09T10:31:00Z' }), { lastRun: run('review', null, { completedAt: null }) });
  assert.deepEqual(sweep([s], ctx), []);
});

test('a sweep retry restarts the stage clock', () => {
  const a = sweep([snap(st('building', { attempts: 1, failedAt: '2026-11-09T10:30:00Z' }))], ctx);
  assert.equal(saves(a)[0]?.since, NOW.toISOString());
});

test('the sweep ignores a /stop from before the stage began, and commands by anyone else', () => {
  const old = snap(st('building'), { lastCommand: { command: 'stop', at: '2026-11-09T10:10:00Z', actor: 'adamwardecki' } });
  assert.deepEqual(sweep([old], ctx), []);
  const other = snap(st('building'), { lastCommand: { command: 'stop', at: '2026-11-09T11:10:00Z', actor: 'someone' } });
  assert.deepEqual(sweep([other], ctx), []);
});

test('a stage waiting to be retried ignores its last run until the retry', () => {
  const s = snap(st('building', { attempts: 1, failedAt: '2026-11-09T11:30:00Z' }), { pr: pr(), lastRun: run('build') });
  assert.deepEqual(sweep([s], ctx), []);
});

// The diff gate: agents run on the PR branch from review on, so its risky files are checked before they do

const RISKY_PR = { files: ['AGENTS.md', 'docs/setup.md'] };
const CLEAN = { blocking: 0, at: '2026-11-09T11:20:00Z' };

test('green CI on a PR changing risky files waits for approval before the reviewer runs', () => {
  const a = finished(snap(st('ci', { pr: 51 }), { pr: pr(RISKY_PR) }), run('ci'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.deepEqual(dispatches(a), []);
  const s = saves(a)[0];
  assert.equal(s?.approvalFor, 'diff');
  assert.equal(s?.afterApproval, 'review');
  assert.equal(s?.approvalSha, 'sha-1');
  assert.match(comments(a)[0] ?? '', /`AGENTS.md`/);
  assert.doesNotMatch(comments(a)[0] ?? '', /docs\/setup.md/);
});

test('red CI on a PR changing risky files waits for approval before the fixer runs', () => {
  const a = finished(snap(st('ci', { pr: 51, round: 1 }), { pr: pr(RISKY_PR) }), run('ci', 'failure'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.deepEqual(dispatches(a), []);
  const s = saves(a)[0];
  assert.equal(s?.afterApproval, 'fix');
  assert.equal(s?.fixReason, 'ci');
  assert.equal(s?.round, 2);
});

test('a blocking review on a risky diff waits for approval before the fixer runs', () => {
  const a = finished(snap(st('in-review', { pr: 51 }), { pr: pr(RISKY_PR), review: { blocking: 1, at: '2026-11-09T11:20:00Z' } }), run('review'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.afterApproval, 'fix');
  assert.equal(saves(a)[0]?.fixReason, 'review');
});

test('the maintainer\'s change request and a rebase on a risky diff wait for approval too', () => {
  const s = snap(st('ready', { pr: 51 }), { pr: pr(RISKY_PR) });
  const a = decideEvent({ kind: 'changes-requested', issue: 7, actor: 'adamwardecki' }, s, ctx);
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.fixReason, 'maintainer');
  const rebase = next([snap(st('ready', { pr: 51 }), { pr: pr({ ...RISKY_PR, conflicting: true }) })], ctx);
  assert.deepEqual(stages(rebase), ['awaiting-approval']);
  assert.equal(saves(rebase)[0]?.rebases, 1);
});

const gated = (extra: Partial<FactoryState>) => st('awaiting-approval', { pr: 51, approvalFor: 'diff', approvalSha: 'sha-1', ...extra });

test('/approve on a gated diff continues to review and records the approved head', () => {
  const a = cmd(snap(gated({ afterApproval: 'review' }), { pr: pr(RISKY_PR) }), 'approve');
  assert.deepEqual(stages(a), ['in-review']);
  assert.deepEqual(dispatches(a), ['review']);
  const s = saves(a)[0];
  assert.equal(s?.approvedSha, 'sha-1');
  assert.equal(s?.approvalFor, undefined);
  assert.equal(s?.afterApproval, undefined);
  assert.equal(s?.approvalSha, undefined);
});

test('/approve on a gated diff continues into the fixer with the stored reason and round', () => {
  const a = cmd(snap(gated({ afterApproval: 'fix', fixReason: 'ci', round: 2 }), { pr: pr(RISKY_PR) }), 'approve');
  assert.deepEqual(stages(a), ['fixing']);
  assert.deepEqual(dispatches(a), ['fix']);
  assert.equal(saves(a)[0]?.fixReason, 'ci');
  assert.equal(saves(a)[0]?.round, 2);
  assert.equal(saves(a)[0]?.headSha, 'sha-1');
});

test('/approve on a gated diff bound for ready marks the PR ready', () => {
  const a = cmd(snap(gated({ afterApproval: 'ready' }), { pr: pr(RISKY_PR) }), 'approve');
  assert.deepEqual(stages(a), ['ready']);
  assert.ok(a.some((x) => x.kind === 'pr-ready' && x.pr === 51));
});

test('/approve after a push the approval request did not list checks the new head again', () => {
  const moved = snap(gated({ afterApproval: 'review', approvalSha: 'sha-0' }), { pr: pr(RISKY_PR) });
  const a = cmd(moved, 'approve');
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.approvalSha, 'sha-1');
  assert.equal(saves(a)[0]?.afterApproval, 'review');
  assert.deepEqual(dispatches(a), []);
  // A push that left no risky files needs no second approval.
  assert.deepEqual(stages(cmd(snap(gated({ afterApproval: 'review', approvalSha: 'sha-0' }), { pr: pr() }), 'approve')), ['in-review']);
  // A diff approval written before the head was recorded is checked again too.
  assert.deepEqual(stages(cmd(snap(gated({ afterApproval: undefined, approvalSha: undefined }), { pr: pr(RISKY_PR) }), 'approve')), ['awaiting-approval']);
});

test('an approved head skips the gate until the next push', () => {
  const approved = snap(st('in-review', { pr: 51, approvedSha: 'sha-1' }), { pr: pr(RISKY_PR), review: CLEAN });
  assert.deepEqual(stages(finished(approved, run('review'))), ['ready']);
  const pushed = snap(st('in-review', { pr: 51, approvedSha: 'sha-0' }), { pr: pr(RISKY_PR), review: CLEAN });
  assert.deepEqual(stages(finished(pushed, run('review'))), ['awaiting-approval']);
  const ci = snap(st('ci', { pr: 51, approvedSha: 'sha-1' }), { pr: pr(RISKY_PR) });
  assert.deepEqual(stages(finished(ci, run('ci'))), ['in-review']);
});

test('/approve on a plan records the brief\'s Touches; a different brief records none', () => {
  const brief = { id: 900, touches: ['plugin/hooks', 'docs/x.md'], at: '2026-11-09T11:20:00Z' };
  const a = cmd(snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 }), { brief }), 'approve');
  assert.deepEqual(saves(a)[0]?.approvedTouches, ['plugin/hooks', 'docs/x.md']);
  const other = cmd(snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 }), { brief: { ...brief, id: 901 } }), 'approve');
  assert.deepEqual(saves(other)[0]?.approvedTouches, []);
  const none = cmd(snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 })), 'approve');
  assert.deepEqual(saves(none)[0]?.approvedTouches, []);
});

test('a diff inside the approved Touches needs no second approval; anything outside them does', () => {
  const plan = { approvedTouches: ['plugin/hooks'] };
  const inside = snap(st('ci', { pr: 51, ...plan }), { pr: pr({ files: ['plugin/hooks/gates.ts', 'docs/x.md'] }) });
  assert.deepEqual(stages(finished(inside, run('ci'))), ['in-review']);
  const ready = snap(st('in-review', { pr: 51, ...plan }), { pr: pr({ files: ['plugin/hooks/gates.ts'] }), review: CLEAN });
  assert.deepEqual(stages(finished(ready, run('review'))), ['ready']);
  const outside = snap(st('ci', { pr: 51, ...plan }), { pr: pr({ files: ['plugin/hooks/gates.ts', 'AGENTS.md'] }) });
  const a = finished(outside, run('ci'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.match(comments(a)[0] ?? '', /`AGENTS.md`/);
  assert.doesNotMatch(comments(a)[0] ?? '', /gates.ts/);
});

test('a new plan does not inherit an earlier plan\'s approved Touches', () => {
  const a = finished(snap(st('planning', { approvedTouches: ['plugin/hooks'] }), { brief: BRIEF, labels: ['ready-for-agent'] }), run('plan'));
  assert.deepEqual(stages(a), ['building']);
  assert.equal(saves(a)[0]?.approvedTouches, undefined);
});

test('retrying the fixer or the reviewer on a risky diff waits for approval', () => {
  const late = snap(st('fixing', { pr: 51, attempts: 1, failedAt: '2026-11-09T10:30:00Z', fixReason: 'ci', headSha: 'sha-0' }), { pr: pr(RISKY_PR) });
  const swept = sweep([late], ctx);
  assert.deepEqual(stages(swept), ['awaiting-approval']);
  assert.equal(saves(swept)[0]?.afterApproval, 'fix');
  assert.deepEqual(dispatches(swept), []);
  const stopped = cmd(snap(st('blocked', { blockedFrom: 'fixing', blockedFor: 'stop', fixReason: 'maintainer', pr: 51 }), { pr: pr(RISKY_PR) }), 'retry');
  assert.deepEqual(stages(stopped), ['awaiting-approval']);
  assert.equal(saves(stopped)[0]?.blockedFrom, undefined);
  const review = cmd(snap(st('blocked', { blockedFrom: 'in-review', blockedFor: 'stuck', pr: 51 }), { pr: pr(RISKY_PR) }), 'retry');
  assert.deepEqual(stages(review), ['awaiting-approval']);
  assert.equal(saves(review)[0]?.afterApproval, 'review');
  const rounds = cmd(snap(st('blocked', { blockedFrom: 'ci', blockedFor: 'rounds', round: 3, pr: 51 }), { pr: pr(RISKY_PR) }), 'retry');
  assert.deepEqual(stages(rounds), ['awaiting-approval']);
  assert.equal(saves(rounds)[0]?.round, 0);
});

// The CI run the fixer reads

test('the router records the CI run it acted on', () => {
  const red = run('ci', 'failure', { url: 'https://github.com/o/r/actions/runs/41' });
  assert.equal(saves(finished(snap(st('ci', { pr: 51 }), { pr: pr() }), red))[0]?.ciRun, red.url);
  assert.equal(saves(finished(snap(st('ci', { pr: 51, round: 3 }), { pr: pr() }), red))[0]?.ciRun, red.url);
  // A failed fixer run does not replace it: the retried fixer still needs the CI log.
  const failedFix = finished(snap(st('fixing', { pr: 51, ciRun: red.url, headSha: 'sha-0' }), { pr: pr() }), run('fix', 'failure'));
  assert.equal(saves(failedFix)[0]?.ciRun, red.url);
});

// A changes-requested review the router missed

test('the sweep recovers the maintainer\'s changes-requested review on a ready PR', () => {
  const at = (t: string, actor = 'adamwardecki') => ({ lastChangesRequested: { at: t, actor }, pr: pr() });
  const a = sweep([snap(st('ready', { pr: 51 }), at('2026-11-09T11:30:00Z'))], ctx);
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'maintainer');
  assert.deepEqual(sweep([snap(st('ready', { pr: 51 }), at('2026-11-09T10:30:00Z'))], ctx), []);
  assert.deepEqual(sweep([snap(st('ready', { pr: 51 }), at('2026-11-09T11:30:00Z', 'someone'))], ctx), []);
  assert.deepEqual(sweep([snap(st('in-review', { pr: 51 }), at('2026-11-09T11:30:00Z'))], ctx), []);
  const risky = sweep([snap(st('ready', { pr: 51 }), { ...at('2026-11-09T11:30:00Z'), pr: pr(RISKY_PR) })], ctx);
  assert.deepEqual(stages(risky), ['awaiting-approval']);
});

// The event path: main.ts applies the event's actions, then asks next with them, so a dry run (which writes
// nothing to reload) logs the same sequence a real run takes

test('next after an event sees the event\'s saves, as the sweep does', () => {
  const s = snap(null, { labels: ['agent:queued'], queuedBy: { login: 'adamwardecki', at: '2026-11-09T11:50:00Z' } });
  const ev = decideEvent({ kind: 'queued', issue: 7, actor: 'adamwardecki' }, s, ctx);
  assert.deepEqual(next([s], ctx), []);
  const after = next([s], ctx, ev);
  assert.deepEqual(
    [...ev, ...after].map((a) => a.kind),
    ['save', 'save', 'unlabel', 'dispatch'],
  );
  assert.deepEqual(stages(after), ['planning']);
  assert.deepEqual(dispatches(after), ['plan']);
});

test('next after an event that made an issue active starts nothing', () => {
  const waiting = snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 }), { brief: { ...BRIEF, id: 900 } });
  const queued = { ...snap(st('queued')), number: 3 };
  const ev = cmd(waiting, 'approve');
  assert.deepEqual(stages(ev), ['building']);
  assert.deepEqual(stages(next([waiting, queued], ctx)), ['planning']);
  assert.deepEqual(next([waiting, queued], ctx, ev), []);
});

// A PR close the router missed

test('the sweep finishes an issue whose own PR was closed', () => {
  for (const stage of ['ci', 'in-review', 'fixing', 'ready', 'awaiting-approval', 'blocked'] as const) {
    assert.deepEqual(stages(sweep([snap(st(stage, { pr: 51 }), { pr: pr({ open: false }) })], ctx)), ['done'], stage);
  }
  assert.deepEqual(sweep([snap(st('done', { pr: 51 }), { pr: pr({ open: false }) })], ctx), []);
  // Another PR closing does not finish it.
  assert.deepEqual(stages(sweep([snap(st('ready', { pr: 50 }), { pr: pr({ open: false }) })], ctx)), []);
});

test('the sweep does not finish a re-queued issue on the closed PR of its earlier run', () => {
  // A new run has no PR yet; the loader finds the last one from the branch, which closed before the issue was queued.
  for (const stage of ['planning', 'building'] as const) {
    assert.ok(!stages(sweep([snap(st(stage), { pr: pr({ open: false }) })], ctx)).includes('done'), stage);
  }
});

// The head the router let through: the stage refuses to run on any other

test('dispatching the reviewer or the fixer records the PR head the diff gate checked', () => {
  const green = finished(snap(st('ci', { pr: 51 }), { pr: pr({ headSha: 'sha-9' }) }), run('ci', 'success', { headSha: 'sha-9' }));
  assert.deepEqual(dispatches(green), ['review']);
  assert.equal(saves(green)[0]?.gatedSha, 'sha-9');
  const red = finished(snap(st('ci', { pr: 51 }), { pr: pr({ headSha: 'sha-9' }) }), run('ci', 'failure', { headSha: 'sha-9' }));
  assert.deepEqual(dispatches(red), ['fix']);
  assert.equal(saves(red)[0]?.gatedSha, 'sha-9');
  const approved = cmd(snap(gated({ afterApproval: 'review' }), { pr: pr(RISKY_PR) }), 'approve');
  assert.equal(saves(approved)[0]?.gatedSha, 'sha-1');
});

test('a sweep retry of the reviewer or the fixer records the head it checked, which may have moved', () => {
  const failed = { attempts: 1, failedAt: '2026-11-09T10:30:00Z', pr: 51, gatedSha: 'sha-0', headSha: 'sha-0' };
  for (const stage of ['in-review', 'fixing'] as const) {
    const a = sweep([snap(st(stage, failed), { pr: pr({ headSha: 'sha-2' }) })], ctx);
    assert.equal(dispatches(a).length, 1, stage);
    assert.equal(saves(a)[0]?.gatedSha, 'sha-2', stage);
  }
  // The fixer's own push check still compares with the head it was first dispatched on.
  const fix = sweep([snap(st('fixing', failed), { pr: pr({ headSha: 'sha-2' }) })], ctx);
  assert.equal(saves(fix)[0]?.headSha, 'sha-0');
});

test('without a PR the reviewer and the fixer are not dispatched; the issue blocks', () => {
  const cases = [
    decideEvent({ kind: 'changes-requested', issue: 7, actor: 'adamwardecki' }, snap(st('ready', { pr: 51 })), ctx),
    cmd(snap(st('blocked', { blockedFrom: 'in-review', blockedFor: 'stuck', pr: 51 })), 'retry'),
    cmd(snap(gated({ afterApproval: 'fix', fixReason: 'ci' })), 'approve'),
    sweep([snap(st('in-review', { attempts: 1, failedAt: '2026-11-09T10:30:00Z', pr: 51 }))], ctx),
    sweep([snap(st('fixing', { attempts: 1, failedAt: '2026-11-09T10:30:00Z', pr: 51, headSha: 'sha-0' }))], ctx),
  ];
  for (const a of cases) {
    assert.deepEqual(dispatches(a), []);
    assert.deepEqual(stages(a), ['blocked']);
    assert.equal(saves(a)[0]?.blockedFor, 'no-pr');
    assert.match(comments(a)[0] ?? '', /PR/);
  }
});
