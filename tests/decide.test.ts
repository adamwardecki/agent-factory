import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUNNER_FOR, type Stage } from '../router/config.ts';
import {
  type Action,
  type Ctx,
  decideEvent,
  type IssueSnapshot,
  next,
  type PullSnapshot,
  type RunSnapshot,
  settle,
  sweep,
} from '../router/decide.ts';
import type { FactoryState } from '../router/markers.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const SINCE = '2026-11-09T11:00:00.000Z';
// The attempt every helper state, run, brief, PR footer and review carries unless a test says otherwise.
const A = 'a1';
const ctx: Ctx = {
  now: NOW,
  risky: ['plugin/hooks/**', 'factory/**', 'AGENTS.md', '.claude/**'],
  limits: { maxRounds: 3, maxRebases: 2, maxAttempts: 2, maxActive: 1 },
  // adamwardecki holds both roles; alice may queue but not approve.
  can: (role, login) => login === 'adamwardecki' || (role === 'queue' && login === 'alice'),
  fallbackReviewer: 'adamwardecki',
  defaultBranch: 'main',
  reserved: 0,
};
const HEAD = 'sha-1';
const AFTER_VERIFY: readonly Stage[] = ['in-review', 'fixing', 'ready', 'awaiting-approval', 'blocked', 'waiting'];
const withActive = (maxActive: number): Ctx => ({ ...ctx, limits: { ...ctx.limits, maxActive } });

function st(stage: Stage, extra: Partial<FactoryState> = {}): FactoryState {
  // The usual consistent picture: the PR head is HEAD, verify was dispatched on it, and later stages saw it pass.
  const shas = stage === 'ci' ? { gatedSha: HEAD } : AFTER_VERIFY.includes(stage) ? { verifiedSha: HEAD } : {};
  return { stage, since: SINCE, round: 0, attempts: 0, runs: [], ...(RUNNER_FOR[stage] ? { attempt: A } : {}), ...shas, ...extra };
}
function snap(state: FactoryState | null, extra: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return { number: 7, state, retiredKey: false, labels: [], queuedBy: null, brief: null, pr: null, review: null, lastCommand: null, lastChangesRequested: null, lastRun: null, ...extra };
}
function pr(extra: Partial<PullSnapshot> = {}): PullSnapshot {
  return { number: 51, headSha: 'sha-1', open: true, draft: true, conflicting: false, files: ['plugin/servers/tracker/src/report.ts'], signed: true, attempt: A, base: 'main', ...extra };
}
function run(workflow: RunSnapshot['workflow'], conclusion: string | null = 'success', extra: Partial<RunSnapshot> = {}): RunSnapshot {
  return { workflow, attempt: A, conclusion, url: `https://example.test/runs/${workflow}-${conclusion}`, completedAt: '2026-11-09T11:30:00Z', ...extra };
}
const saves = (a: Action[]) => a.flatMap((x) => (x.kind === 'save' ? [x.state] : []));
const stages = (a: Action[]) => saves(a).map((s) => s.stage);
const dispatches = (a: Action[]) => a.flatMap((x) => (x.kind === 'dispatch' ? [x.workflow] : []));
const comments = (a: Action[]) => a.flatMap((x) => (x.kind === 'comment' ? [x.body] : []));
const finished = (s: IssueSnapshot, r: RunSnapshot) => decideEvent({ kind: 'run-finished', issue: 7, run: r }, s, ctx);
const at = (n: number, s: IssueSnapshot): IssueSnapshot => ({ ...s, number: n });
const savedStages = (a: Action[]) => a.flatMap((x) => (x.kind === 'save' ? [`${x.issue}:${x.state.stage}`] : []));

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
  // Before a run has recorded its PR, a close is last round's PR, not this one's.
  assert.deepEqual(decideEvent({ kind: 'pr-closed', issue: 7, pr: 51 }, snap(st('building')), ctx), []);
  assert.deepEqual(decideEvent({ kind: 'pr-closed', issue: 7, pr: 51 }, snap(st('done')), ctx), []);
});

const BRIEF = { id: 900, touches: ['plugin/servers/tracker/src/report.ts'], at: '2026-11-09T11:20:00Z', attempt: A };
// A signed factory review of HEAD by the current attempt.
const rv = (blocking: number, extra: Partial<NonNullable<IssueSnapshot['review']>> = {}) => ({ blocking, at: '2026-11-09T11:20:00Z', sha: HEAD, attempt: A, ...extra });

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
  const stale = { ...BRIEF, attempt: 'old' };
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

test('runs for another stage or attempt, still going, cancelled or already seen are ignored', () => {
  const s = snap(st('building'), { pr: pr() });
  assert.deepEqual(finished(s, run('plan')), []);
  assert.deepEqual(finished(s, run('build', 'success', { completedAt: null })), []);
  assert.deepEqual(finished(s, run('build', 'skipped')), []);
  assert.deepEqual(finished(s, run('build', 'cancelled', { attempt: 'old' })), [], 'a run the router cancelled when it left that attempt');
  assert.deepEqual(finished(s, run('build', 'success', { attempt: 'old' })), []);
  assert.deepEqual(finished(s, run('build', 'success', { attempt: null })), []);
  const seen = snap(st('building', { runs: ['https://example.test/runs/build-success'] }), { pr: pr() });
  assert.deepEqual(finished(seen, run('build')), []);
});

test('a run of the current attempt that was cancelled counts as failed: a job that hits its timeout looks like that', () => {
  const a = finished(snap(st('building'), { pr: pr() }), run('build', 'cancelled'));
  assert.equal(saves(a)[0]?.attempts, 1);
  assert.ok(saves(a)[0]?.failedAt);
  const v = finished(snap(st('ci', { pr: 51, gatedSha: HEAD }), { pr: pr() }), run('verify', 'cancelled'));
  assert.equal(saves(v)[0]?.attempts, 1);
});

test('a refused credential blocks the issue at once and says to renew the token', () => {
  for (const [stage, workflow] of [['planning', 'plan'], ['building', 'build'], ['fixing', 'fix']] as const) {
    const a = finished(snap(st(stage, { pr: 51, headSha: 'sha-0' }), { pr: pr() }), run(workflow, 'credential'));
    assert.deepEqual(stages(a), ['blocked'], stage);
    assert.equal(saves(a)[0]?.blockedFor, 'credential');
    assert.equal(saves(a)[0]?.blockedFrom, stage);
    assert.match(comments(a)[0] ?? '', /claude setup-token/);
    assert.match(comments(a)[0] ?? '', /gh secret set CLAUDE_CODE_OAUTH_TOKEN/);
  }
  // /retry after renewing starts the stage again.
  const again = cmd(snap(st('blocked', { blockedFrom: 'building', blockedFor: 'credential' })), 'retry');
  assert.deepEqual(stages(again), ['building']);
});

test('a usage limit waits for the retry without spending an attempt, even on the last one', () => {
  for (const [stage, workflow] of [['planning', 'plan'], ['building', 'build'], ['fixing', 'fix']] as const) {
    const a = finished(snap(st(stage, { pr: 51, headSha: 'sha-0', attempts: 1 }), { pr: pr() }), run(workflow, 'usage-limit'));
    assert.deepEqual(stages(a), [stage], stage);
    assert.equal(saves(a)[0]?.attempts, 1, 'no attempt spent');
    assert.equal(saves(a)[0]?.failedAt, NOW.toISOString(), 'retried after the usual delay');
    assert.equal(saves(a)[0]?.runs.length, 1, 'the run is recorded, so it is not judged again');
    assert.deepEqual(comments(a), []);
  }
});

test('a build that opened a signed PR goes to verify on its head', () => {
  const a = finished(snap(st('building'), { pr: pr() }), run('build'));
  assert.deepEqual(stages(a), ['ci']);
  assert.equal(saves(a)[0]?.pr, 51);
  assert.equal(saves(a)[0]?.gatedSha, HEAD);
  assert.deepEqual(dispatches(a), ['verify']);
});

test('a build without an open PR is a failed attempt', () => {
  const a = finished(snap(st('building'), { pr: pr({ open: false }) }), run('build'));
  assert.equal(saves(a)[0]?.attempts, 1);
});

test('green verify records the verified commit and goes to review; another attempt is ignored', () => {
  const s = snap(st('ci', { pr: 51 }), { pr: pr() });
  const a = finished(s, run('verify'));
  assert.deepEqual(stages(a), ['in-review']);
  assert.equal(saves(a)[0]?.verifiedSha, HEAD);
  assert.deepEqual(dispatches(a), ['review']);
  assert.deepEqual(finished(s, run('verify', 'success', { attempt: 'old' })), []);
});

test('red CI goes to the fixer and counts a round', () => {
  const a = finished(snap(st('ci', { pr: 51, round: 1 }), { pr: pr() }), run('verify', 'failure'));
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.round, 2);
  assert.equal(saves(a)[0]?.fixReason, 'ci');
  assert.equal(saves(a)[0]?.headSha, 'sha-1');
  assert.deepEqual(dispatches(a), ['fix']);
});

test('red CI after the last round blocks', () => {
  const a = finished(snap(st('ci', { pr: 51, round: 3 }), { pr: pr() }), run('verify', 'failure'));
  assert.deepEqual(stages(a), ['blocked']);
  assert.match(comments(a)[0] ?? '', /3 fix rounds/);
});

test('a review with blocking findings goes to the fixer', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr(), review: rv(2) });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'review');
  assert.equal(saves(a)[0]?.round, 1);
});

test('a clean review on safe files marks the PR ready', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr(), review: rv(0) });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['ready']);
  assert.ok(a.some((x) => x.kind === 'pr-ready' && x.pr === 51));
});

test('a clean review on a risky diff waits for approval', () => {
  const s = snap(st('in-review', { pr: 51 }), {
    pr: pr({ files: ['plugin/hooks/gates.ts'] }),
    review: rv(0),
  });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.approvalFor, 'diff');
  assert.equal(saves(a)[0]?.afterApproval, 'ready');
  assert.equal(saves(a)[0]?.approvalSha, 'sha-1');
  assert.ok(!a.some((x) => x.kind === 'pr-ready'));
});

test('a review run without a fresh factory review is a failed attempt', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr(), review: rv(0, { attempt: 'old' }) });
  assert.equal(saves(finished(s, run('review')))[0]?.attempts, 1);
});

test('a fix that pushed goes back to CI; one that pushed nothing is a failed attempt', () => {
  const pushed = finished(snap(st('fixing', { pr: 51, headSha: 'sha-0' }), { pr: pr() }), run('fix'));
  assert.deepEqual(stages(pushed), ['ci']);
  const idle = finished(snap(st('fixing', { pr: 51, headSha: 'sha-1' }), { pr: pr() }), run('fix'));
  assert.equal(saves(idle)[0]?.attempts, 1);
});

test('a fix whose push GitHub has not yet put on the PR waits instead of failing', () => {
  const lagging = snap(st('fixing', { pr: 51, headSha: 'sha-1' }), { pr: pr({ branchSha: 'sha-2' }) });
  assert.deepEqual(finished(lagging, run('fix')), []);
  assert.deepEqual(sweep([{ ...lagging, lastRun: run('fix') }], ctx), []);
  const idle = snap(st('fixing', { pr: 51, headSha: 'sha-1' }), { pr: pr({ branchSha: 'sha-1' }) });
  assert.equal(saves(finished(idle, run('fix')))[0]?.attempts, 1);
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
  const a = cmd(snap(st('awaiting-approval', { approvalFor: 'diff', pr: 51 }), { pr: pr(), review: rv(0) }), 'approve');
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

test('the sweep marks a ready PR that is still a draft: the first attempt failed after the state was saved', () => {
  const s = snap(st('ready', { pr: 51, queuedBy: 'alice' }), { pr: pr({ draft: true }) });
  const a = sweep([s], ctx);
  assert.deepEqual(a.filter((x) => x.kind === 'pr-ready'), [{ kind: 'pr-ready', issue: 7, pr: 51, reviewer: 'alice' }]);
  assert.deepEqual(sweep([snap(st('ready', { pr: 51 }), { pr: pr({ draft: false }) })], ctx), []);
  assert.deepEqual(sweep([snap(st('ready', { pr: 51 }), { pr: pr({ draft: true, open: false }) })], ctx).filter((x) => x.kind === 'pr-ready'), []);
});

test('the sweep dispatches an attempt again when no run for it shows up after ten minutes', () => {
  const lost = snap(st('building', { attempt: 'a9', since: '2026-11-09T11:40:00.000Z' }));
  const a = sweep([lost], ctx);
  assert.deepEqual(a, [{ kind: 'dispatch', issue: 7, workflow: 'build', attempt: 'a9' }]);
  assert.deepEqual(sweep([snap(st('building', { since: '2026-11-09T11:55:00.000Z' }))], ctx), [], 'too soon');
  assert.deepEqual(stages(sweep([snap(st('building', { since: '2026-11-09T10:00:00.000Z' }))], ctx)), ['blocked'], 'after 90 minutes it is stuck, not retried');
  assert.deepEqual(sweep([snap(st('building', { since: '2026-11-09T11:40:00.000Z' }), { lastRun: run('build', null, { completedAt: null }) })], ctx), [], 'a run exists');
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
  const review = rv(0);
  const afterRebase = finished(snap(st('in-review', { pr: 51, rebases: 1, fixReason: 'rebase' }), { pr: pr(), review }), run('review'));
  assert.deepEqual(stages(afterRebase), ['ready']);
  assert.equal(saves(afterRebase)[0]?.rebases, 1);
  const afterReview = finished(snap(st('in-review', { pr: 51, rebases: 1, fixReason: 'review' }), { pr: pr(), review }), run('review'));
  assert.equal(saves(afterReview)[0]?.rebases, undefined);
  const approved = cmd(snap(st('awaiting-approval', { approvalFor: 'diff', pr: 51, rebases: 2, fixReason: 'maintainer' }), { pr: pr(), review }), 'approve');
  assert.equal(saves(approved)[0]?.rebases, undefined);
});

test('/retry after the rebase cap returns to ready with the count cleared, when the head was verified and reviewed', () => {
  const a = cmd(snap(st('blocked', { blockedFrom: 'ready', blockedFor: 'rebases', rebases: 2, round: 1, pr: 51 }), { pr: pr(), review: rv(0) }), 'retry');
  assert.deepEqual(stages(a), ['ready']);
  assert.equal(saves(a)[0]?.rebases, undefined);
  assert.equal(saves(a)[0]?.round, 1);
  assert.deepEqual(dispatches(a), []);
});

test('/retry into ready goes through the SHA checks: a head that moved while blocked is verified again', () => {
  for (const blockedFor of ['rebases', 'stop'] as const) {
    const moved = cmd(snap(st('blocked', { blockedFrom: 'ready', blockedFor, pr: 51 }), { pr: pr({ headSha: 'sha-9' }), review: rv(0) }), 'retry');
    assert.deepEqual(stages(moved), ['ci'], blockedFor);
    assert.deepEqual(dispatches(moved), ['verify'], blockedFor);
    assert.ok(!moved.some((x) => x.kind === 'pr-ready'), blockedFor);
    // Verified on this head but reviewed on another: the reviewer runs again.
    const unreviewed = cmd(snap(st('blocked', { blockedFrom: 'ready', blockedFor, pr: 51 }), { pr: pr(), review: rv(0, { sha: 'sha-0' }) }), 'retry');
    assert.deepEqual(dispatches(unreviewed), ['review'], blockedFor);
  }
  // Without a PR there is nothing to check, so the issue stays blocked.
  assert.deepEqual(cmd(snap(st('blocked', { blockedFrom: 'ready', blockedFor: 'stop', pr: 51 })), 'retry'), []);
});

test('/retry after a /stop at waiting keeps what the issue was waiting to run', () => {
  const waiting = at(7, snap(st('waiting', { resume: 'build' })));
  const stopped = decideEvent({ kind: 'command', issue: 7, command: 'stop', actor: 'adamwardecki' }, waiting, ctx);
  assert.equal(saves(stopped)[0]?.resume, 'build', 'the blocked state remembers it');
  const back = cmd(snap(saves(stopped)[0] ?? null), 'retry');
  assert.deepEqual(stages(back), ['waiting']);
  assert.equal(saves(back)[0]?.resume, 'build');
  // And the next free slot starts it, instead of calling it stuck.
  assert.deepEqual(savedStages(next([at(7, snap(saves(back)[0] ?? null))], ctx)), ['7:building']);
});

// Why an issue was blocked, and what /retry does about it

test('each way of blocking records why', () => {
  const failed = finished(snap(st('building', { attempts: 1 })), run('build', 'failure'));
  assert.equal(saves(failed)[0]?.blockedFor, 'attempts');
  const rounds = finished(snap(st('ci', { pr: 51, round: 3 }), { pr: pr() }), run('verify', 'failure'));
  assert.equal(saves(rounds)[0]?.blockedFor, 'rounds');
  const human = finished(snap(st('planning'), { labels: ['needs-info'] }), run('plan'));
  assert.equal(saves(human)[0]?.blockedFor, 'human');
  assert.equal(saves(cmd(snap(st('fixing')), 'stop'))[0]?.blockedFor, 'stop');
  const stuck = sweep([snap(st('in-review', { since: '2026-11-09T10:00:00Z' }))], ctx);
  assert.equal(saves(stuck)[0]?.blockedFor, 'stuck');
});

test('the round cap is also reached through blocking reviews', () => {
  const s = snap(st('in-review', { pr: 51, round: 3 }), { pr: pr(), review: rv(1) });
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

test('/retry after verify was stuck or stopped runs verify again rather than calling the fixer', () => {
  for (const blockedFor of ['stuck', 'stop'] as const) {
    const a = cmd(snap(st('blocked', { blockedFrom: 'ci', blockedFor, round: 1, pr: 51 }), { pr: pr() }), 'retry');
    assert.deepEqual(stages(a), ['ci']);
    assert.equal(saves(a)[0]?.round, 1);
    assert.deepEqual(dispatches(a), ['verify']);
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
  const going = { lastRun: run('build', null, { completedAt: null }) };
  const old = snap(st('building'), { ...going, lastCommand: { command: 'stop', at: '2026-11-09T10:10:00Z', actor: 'adamwardecki' } });
  assert.deepEqual(sweep([old], ctx), []);
  const other = snap(st('building'), { ...going, lastCommand: { command: 'stop', at: '2026-11-09T11:10:00Z', actor: 'someone' } });
  assert.deepEqual(sweep([other], ctx), []);
});

test('a stage waiting to be retried ignores its last run until the retry', () => {
  const s = snap(st('building', { attempts: 1, failedAt: '2026-11-09T11:30:00Z' }), { pr: pr(), lastRun: run('build') });
  assert.deepEqual(sweep([s], ctx), []);
});

// The diff gate: agents run on the PR branch from review on, so its risky files are checked before they do

const RISKY_PR = { files: ['AGENTS.md', 'docs/setup.md'] };
const CLEAN = rv(0);

test('green CI on a PR changing risky files waits for approval before the reviewer runs', () => {
  const a = finished(snap(st('ci', { pr: 51 }), { pr: pr(RISKY_PR) }), run('verify'));
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
  const a = finished(snap(st('ci', { pr: 51, round: 1 }), { pr: pr(RISKY_PR) }), run('verify', 'failure'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.deepEqual(dispatches(a), []);
  const s = saves(a)[0];
  assert.equal(s?.afterApproval, 'fix');
  assert.equal(s?.fixReason, 'ci');
  assert.equal(s?.round, 2);
});

test('a blocking review on a risky diff waits for approval before the fixer runs', () => {
  const a = finished(snap(st('in-review', { pr: 51 }), { pr: pr(RISKY_PR), review: rv(1) }), run('review'));
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
  const a = cmd(snap(gated({ afterApproval: 'ready' }), { pr: pr(RISKY_PR), review: rv(0) }), 'approve');
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
  assert.deepEqual(stages(finished(ci, run('verify'))), ['in-review']);
});

test('/approve on a plan records the brief\'s Touches; a different brief records none', () => {
  const brief = { id: 900, touches: ['plugin/hooks', 'docs/x.md'], at: '2026-11-09T11:20:00Z', attempt: A };
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
  assert.deepEqual(stages(finished(inside, run('verify'))), ['in-review']);
  const ready = snap(st('in-review', { pr: 51, ...plan }), { pr: pr({ files: ['plugin/hooks/gates.ts'] }), review: CLEAN });
  assert.deepEqual(stages(finished(ready, run('review'))), ['ready']);
  const outside = snap(st('ci', { pr: 51, ...plan }), { pr: pr({ files: ['plugin/hooks/gates.ts', 'AGENTS.md'] }) });
  const a = finished(outside, run('verify'));
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
  const red = run('verify', 'failure', { url: 'https://github.com/o/r/actions/runs/41' });
  assert.equal(saves(finished(snap(st('ci', { pr: 51 }), { pr: pr() }), red))[0]?.ciRun, red.url);
  assert.equal(saves(finished(snap(st('ci', { pr: 51, round: 3 }), { pr: pr() }), red))[0]?.ciRun, red.url);
  // A failed fixer run does not replace it: the retried fixer still needs the CI log.
  const failedFix = finished(snap(st('fixing', { pr: 51, ciRun: red.url, headSha: 'sha-0' }), { pr: pr() }), run('fix', 'failure'));
  assert.equal(saves(failedFix)[0]?.ciRun, red.url);
});

// A changes-requested review the router missed

test('the sweep recovers the maintainer\'s changes-requested review on a ready PR', () => {
  const at = (t: string, actor = 'adamwardecki') => ({ lastChangesRequested: { at: t, actor }, pr: pr({ draft: false }) });
  const a = sweep([snap(st('ready', { pr: 51 }), at('2026-11-09T11:30:00Z'))], ctx);
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'maintainer');
  assert.deepEqual(sweep([snap(st('ready', { pr: 51 }), at('2026-11-09T10:30:00Z'))], ctx), []);
  assert.deepEqual(sweep([snap(st('ready', { pr: 51 }), at('2026-11-09T11:30:00Z', 'someone'))], ctx), []);
  assert.deepEqual(sweep([snap(st('in-review', { pr: 51 }), { ...at('2026-11-09T11:30:00Z'), lastRun: run('review', null, { completedAt: null }) })], ctx), []);
  const risky = sweep([snap(st('ready', { pr: 51 }), { ...at('2026-11-09T11:30:00Z'), pr: pr({ ...RISKY_PR, draft: false }) })], ctx);
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
  const green = finished(snap(st('ci', { pr: 51, gatedSha: 'sha-9' }), { pr: pr({ headSha: 'sha-9' }) }), run('verify'));
  assert.deepEqual(dispatches(green), ['review']);
  assert.equal(saves(green)[0]?.gatedSha, 'sha-9');
  const red = finished(snap(st('ci', { pr: 51, gatedSha: 'sha-9' }), { pr: pr({ headSha: 'sha-9' }) }), run('verify', 'failure'));
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

// --- Roles ---------------------------------------------------------------------------------------------------------

test('queueing records who queued; only the queue role can queue', () => {
  const a = decideEvent({ kind: 'queued', issue: 7, actor: 'alice' }, snap(null), ctx);
  assert.equal(saves(a)[0]?.queuedBy, 'alice');
  assert.deepEqual(decideEvent({ kind: 'queued', issue: 7, actor: 'mallory' }, snap(null), ctx), []);
});

test('the queue role can /stop and /retry but not /approve', () => {
  const waiting = snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 }), { brief: BRIEF });
  assert.deepEqual(cmd(waiting, 'approve', 'alice'), [], 'alice may queue, not approve');
  assert.deepEqual(stages(cmd(waiting, 'approve', 'adamwardecki')), ['building']);
  assert.deepEqual(stages(cmd(snap(st('building')), 'stop', 'alice')), ['blocked']);
  assert.deepEqual(stages(cmd(snap(st('blocked', { blockedFrom: 'planning', blockedFor: 'stop' })), 'retry', 'alice')), ['planning']);
  // The sweep applies the same rule to a command it recovers.
  const missed = snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 }), { brief: BRIEF, lastCommand: { command: 'approve', at: '2026-11-09T11:30:00Z', actor: 'alice' } });
  assert.deepEqual(sweep([missed], ctx), []);
});

test('a ready PR asks whoever queued it to review, then the fallback', () => {
  const s = snap(st('in-review', { pr: 51, queuedBy: 'alice' }), { pr: pr(), review: rv(0) });
  assert.ok(finished(s, run('review')).some((x) => x.kind === 'pr-ready' && x.pr === 51 && x.reviewer === 'alice'));
  const b = finished(snap(st('in-review', { pr: 51 }), { pr: pr(), review: rv(0) }), run('review'));
  assert.ok(b.some((x) => x.kind === 'pr-ready' && x.reviewer === 'adamwardecki'));
});

test('limits come from the repo config', () => {
  const tight: Ctx = { ...ctx, limits: { ...ctx.limits, maxRounds: 1 } };
  const a = decideEvent({ kind: 'run-finished', issue: 7, run: run('verify', 'failure') }, snap(st('ci', { pr: 51, round: 1 }), { pr: pr() }), tight);
  assert.deepEqual(stages(a), ['blocked']);
});

// --- Attempts ------------------------------------------------------------------------------------------------------

const attempts = (a: Action[]) => a.flatMap((x) => (x.kind === 'dispatch' ? [x.attempt] : []));
const cancels = (a: Action[]) => a.flatMap((x) => (x.kind === 'cancel' ? [`${x.workflow} ${x.attempt}`] : []));

test('every entry into a stage with a workflow gets a new attempt, and the dispatch carries it', () => {
  const a = finished(snap(st('planning'), { brief: BRIEF, labels: ['ready-for-agent'] }), run('plan'));
  const attempt = saves(a)[0]?.attempt;
  assert.ok(attempt && attempt !== A);
  assert.deepEqual(attempts(a), [attempt]);
  // A stage that waits on a person has no attempt.
  const waiting = finished(snap(st('planning'), { brief: { ...BRIEF, touches: ['plugin/hooks/x.ts'] }, labels: ['ready-for-agent'] }), run('plan'));
  assert.equal(saves(waiting)[0]?.attempt, undefined);
});

test('/stop cancels the run of the attempt it stops', () => {
  const a = cmd(snap(st('building')), 'stop');
  assert.deepEqual(stages(a), ['blocked']);
  assert.deepEqual(cancels(a), [`build ${A}`]);
  assert.deepEqual(cancels(cmd(snap(st('ready', { pr: 51 }), { pr: pr() }), 'stop')), [], 'nothing runs while an issue waits on a person');
});

test('a build whose PR was signed for another attempt is not this build', () => {
  const stale = finished(snap(st('building'), { pr: pr({ attempt: 'old' }) }), run('build'));
  assert.equal(saves(stale)[0]?.attempts, 1);
  assert.deepEqual(dispatches(stale), []);
  const unsigned = finished(snap(st('building'), { pr: pr({ signed: false, attempt: null }) }), run('build'));
  assert.equal(saves(unsigned)[0]?.attempts, 1);
});

// --- Verify and the SHAs -------------------------------------------------------------------------------------------

test('a build with a risky diff waits for approval before verify runs anything on it', () => {
  const a = finished(snap(st('building'), { pr: pr({ files: ['plugin/hooks/gates.ts'] }) }), run('build'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.afterApproval, 'verify');
  assert.deepEqual(dispatches(a), []);
  const approved = cmd(snap(saves(a)[0] ?? null, { pr: pr({ files: ['plugin/hooks/gates.ts'] }) }), 'approve');
  assert.deepEqual(dispatches(approved), ['verify']);
});

test('a verify run that broke before its checks finished is a failed attempt, not a fix round', () => {
  const a = finished(snap(st('ci', { pr: 51 }), { pr: pr() }), run('verify', 'startup_failure'));
  assert.deepEqual(stages(a), ['ci']);
  assert.equal(saves(a)[0]?.attempts, 1);
  assert.deepEqual(dispatches(a), []);
});

test('a fix that pushed goes back through verify, not straight to review', () => {
  const a = finished(snap(st('fixing', { pr: 51, headSha: 'sha-0' }), { pr: pr() }), run('fix'));
  assert.deepEqual(dispatches(a), ['verify']);
  assert.equal(saves(a)[0]?.gatedSha, HEAD);
});

test('the head changed during review: the old review cannot make the new head ready', () => {
  // Verify passed and the reviewer read sha-1; someone pushed sha-2 while it ran.
  const s = snap(st('in-review', { pr: 51 }), { pr: pr({ headSha: 'sha-2' }), review: rv(0) });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['ci'], 'the new head goes back through verify');
  assert.deepEqual(dispatches(a), ['verify']);
  assert.equal(saves(a)[0]?.gatedSha, 'sha-2');
  assert.ok(!a.some((x) => x.kind === 'pr-ready'));
  // Once verify passes on sha-2, the review of sha-1 still doesn't count: the reviewer runs again.
  const verified = snap(saves(a)[0] ?? null, { pr: pr({ headSha: 'sha-2' }), review: rv(0) });
  const b = finished(verified, run('verify', 'success', { attempt: saves(a)[0]?.attempt ?? null }));
  assert.deepEqual(dispatches(b), ['review']);
  assert.equal(saves(b)[0]?.verifiedSha, 'sha-2');
});

test('ready needs the head, the review and verify to name the same commit', () => {
  const approve = (extra: Partial<FactoryState>, review: IssueSnapshot['review']) =>
    cmd(snap(st('awaiting-approval', { approvalFor: 'diff', afterApproval: 'ready', pr: 51, ...extra }), { pr: pr(), review }), 'approve');
  assert.deepEqual(stages(approve({}, rv(0))), ['ready']);
  assert.deepEqual(dispatches(approve({ verifiedSha: 'sha-0' }, rv(0))), ['verify'], 'verify passed on another commit');
  assert.deepEqual(dispatches(approve({}, rv(0, { sha: 'sha-0' }))), ['review'], 'the review is of another commit');
  assert.deepEqual(dispatches(approve({}, null)), ['review']);
});

// --- Admission -----------------------------------------------------------------------------------------------------


test('/approve at capacity: the approved issue waits for a slot instead of starting a second active issue', () => {
  const busy = at(2, snap(st('building')));
  const approved = at(7, snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 }), { brief: BRIEF }));
  const raw = decideEvent({ kind: 'command', issue: 7, command: 'approve', actor: 'adamwardecki' }, approved, ctx);
  assert.deepEqual(dispatches(raw), ['build'], 'decideEvent alone would start it');
  const a = settle([busy, approved], raw, ctx);
  assert.deepEqual(savedStages(a), ['7:waiting']);
  assert.equal(saves(a)[0]?.resume, 'build');
  assert.equal(saves(a)[0]?.attempt, undefined);
  assert.deepEqual(saves(a)[0]?.approvedTouches, BRIEF.touches, 'the approval is kept for when it starts');
  assert.deepEqual(dispatches(a), []);
  assert.deepEqual(next([busy, approved], ctx, a), [], 'and nothing else starts either');
  // With a second slot it starts at once.
  assert.deepEqual(dispatches(settle([busy, approved], raw, withActive(2))), ['build']);
});

test('/retry and a changes-requested review pass through the same queue', () => {
  const busy = at(2, snap(st('in-review', { pr: 50 })));
  const blocked = at(7, snap(st('blocked', { blockedFrom: 'planning', blockedFor: 'stop' })));
  const retried = settle([busy, blocked], decideEvent({ kind: 'command', issue: 7, command: 'retry', actor: 'adamwardecki' }, blocked, ctx), ctx);
  assert.deepEqual(savedStages(retried), ['7:waiting']);
  assert.equal(saves(retried)[0]?.resume, 'plan');
  const ready = at(8, snap(st('ready', { pr: 51 }), { pr: pr() }));
  const asked = settle([busy, ready], decideEvent({ kind: 'changes-requested', issue: 8, actor: 'adamwardecki' }, ready, ctx), ctx);
  assert.deepEqual(savedStages(asked), ['8:waiting']);
  assert.equal(saves(asked)[0]?.resume, 'fix');
  assert.equal(saves(asked)[0]?.fixReason, 'maintainer');
});

test('an issue that stays active keeps its slot, and one that leaves frees it', () => {
  const building = at(2, snap(st('building'), { pr: pr() }));
  const moves = decideEvent({ kind: 'run-finished', issue: 2, run: run('build') }, building, ctx);
  assert.deepEqual(dispatches(settle([building], moves, ctx)), ['verify'], 'building to ci is not a new admission');
  const queued = at(3, snap(st('queued')));
  const stopped = settle([building, queued], decideEvent({ kind: 'command', issue: 2, command: 'stop', actor: 'adamwardecki' }, building, ctx), ctx);
  assert.deepEqual(savedStages(next([building, queued], ctx, stopped)), ['3:planning'], 'the stop freed the slot');
});

test('a free slot goes to waiting issues first, oldest first, then rebases, then queued issues', () => {
  const waitingOld = at(4, snap(st('waiting', { resume: 'build', since: '2026-11-09T09:00:00Z' })));
  const waitingNew = at(5, snap(st('waiting', { resume: 'plan', since: '2026-11-09T10:00:00Z' })));
  const conflicting = at(6, snap(st('ready', { pr: 51 }), { pr: pr({ conflicting: true }) }));
  const queued = at(3, snap(st('queued', { since: '2026-11-09T08:00:00Z' })));
  const all = [queued, conflicting, waitingNew, waitingOld];
  assert.deepEqual(savedStages(next(all, ctx)), ['4:building']);
  assert.deepEqual(savedStages(next(all, withActive(2))), ['4:building', '5:planning']);
  assert.deepEqual(savedStages(next(all, withActive(4))), ['4:building', '5:planning', '6:fixing', '3:planning']);
});

test('a waiting issue bound for the PR branch is checked again when its slot comes', () => {
  const waiting = st('waiting', { resume: 'review', pr: 51 });
  // The PR moved while it waited: verify first.
  assert.deepEqual(dispatches(next([snap(waiting, { pr: pr({ headSha: 'sha-2' }) })], ctx)), ['verify']);
  // The PR now has a risky diff: it asks for approval and takes no slot, so the queued issue starts.
  const risky = at(7, snap(waiting, { pr: pr({ files: ['plugin/hooks/gates.ts'] }) }));
  assert.deepEqual(savedStages(next([risky, at(3, snap(st('queued')))], ctx)), ['7:awaiting-approval', '3:planning']);
  // The PR is gone: blocked.
  assert.deepEqual(savedStages(next([at(7, snap(waiting))], ctx)), ['7:blocked']);
});

test('never more than maxActive issues are active after a sweep', () => {
  const failedA = at(1, snap(st('planning', { attempts: 1, failedAt: '2026-11-09T10:30:00Z' })));
  const approvedB = at(2, snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 }), { brief: BRIEF, lastCommand: { command: 'approve', at: '2026-11-09T11:30:00Z', actor: 'adamwardecki' } }));
  const queuedC = at(3, snap(st('queued')));
  for (const max of [1, 2, 3]) {
    const a = sweep([failedA, approvedB, queuedC], withActive(max));
    const after = new Map<number, Stage>([[1, 'planning'], [2, 'awaiting-approval'], [3, 'queued']]);
    for (const x of a) if (x.kind === 'save') after.set(x.issue, x.state.stage);
    const active = [...after.values()].filter((s) => ['planning', 'building', 'ci', 'in-review', 'fixing'].includes(s)).length;
    assert.equal(active, max, `maxActive ${max}`);
    assert.equal(dispatches(a).length, max, 'every active issue has a run, and no parked one does');
  }
});

test('a rebase that hits its cap leaves the slot for a queued issue', () => {
  const capped = at(3, snap(st('ready', { pr: 51, rebases: 2, fixReason: 'rebase' }), { pr: pr({ conflicting: true }) }));
  assert.deepEqual(savedStages(next([capped, at(5, snap(st('queued')))], ctx)), ['3:blocked', '5:planning']);
});

// --- Key rotation --------------------------------------------------------------------------------------------------

test('state signed with a replaced key blocks the issue once; a fresh label starts it over', () => {
  const lost = snap(null, { retiredKey: true, labels: ['agent:building'] });
  const a = sweep([lost], ctx);
  assert.deepEqual(stages(a), ['blocked']);
  assert.equal(saves(a)[0]?.blockedFor, 'key-rotated');
  assert.match(comments(a)[0] ?? '', /agent:queued/);
  assert.deepEqual(cmd(snap(saves(a)[0] ?? null), 'retry'), [], '/retry cannot recover state that was lost');
  const requeued = snap(null, { retiredKey: true, labels: ['agent:queued'], queuedBy: { login: 'alice', at: '2026-11-09T11:50:00Z' } });
  assert.deepEqual(stages(sweep([requeued], ctx)), ['queued', 'planning']);
});

// --- Found by the independent review of the state machine ---------------------------------------------------------

test('closing an older PR does not finish a re-queued issue on the event path either', () => {
  const requeued = snap(st('planning'), { pr: null });
  assert.deepEqual(decideEvent({ kind: 'pr-closed', issue: 7, pr: 51 }, requeued, ctx), [], 'the new run has recorded no PR yet');
  assert.deepEqual(decideEvent({ kind: 'pr-closed', issue: 7, pr: 51 }, snap(st('building', { pr: 52 })), ctx), []);
  assert.deepEqual(stages(decideEvent({ kind: 'pr-closed', issue: 7, pr: 52 }, snap(st('building', { pr: 52 })), ctx)), ['done']);
});

test('a PR that is closed cannot be verified, reviewed or marked ready: its own close finishes the issue', () => {
  const closed = pr({ open: false });
  const done = finished(snap(st('in-review', { pr: 51 }), { pr: closed, review: rv(0) }), run('review'));
  assert.deepEqual(stages(done), ['done']);
  assert.ok(!done.some((x) => x.kind === 'pr-ready'));
  // A PR that is not the issue's own is not a reason to finish it, only to stop.
  const other = finished(snap(st('in-review', { pr: 50 }), { pr: closed, review: rv(0) }), run('review'));
  assert.deepEqual(stages(other), ['blocked']);
  assert.equal(saves(other)[0]?.blockedFor, 'no-pr');
  // A waiting issue is not resumed onto a closed PR.
  assert.deepEqual(savedStages(next([at(7, snap(st('waiting', { resume: 'review', pr: 51 }), { pr: closed }))], ctx)), ['7:done']);
});

test('a PR into another base is not the factory build', () => {
  const stray = finished(snap(st('building'), { pr: pr({ base: 'release' }) }), run('build'));
  assert.equal(saves(stray)[0]?.attempts, 1, 'a failed attempt, not a verify');
  assert.deepEqual(dispatches(stray), []);
  const gated = cmd(snap(st('blocked', { blockedFrom: 'in-review', blockedFor: 'stuck', pr: 51 }), { pr: pr({ base: 'release' }) }), 'retry');
  assert.equal(saves(gated)[0]?.blockedFor, 'no-pr');
});

test('a changes request on a ready PR is never refused for rounds it did not add', () => {
  const lowered: Ctx = { ...ctx, limits: { ...ctx.limits, maxRounds: 2 } };
  const ready = snap(st('ready', { pr: 51, round: 3 }), { pr: pr(), review: rv(0) });
  const a = decideEvent({ kind: 'changes-requested', issue: 7, actor: 'adamwardecki' }, ready, lowered);
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.round, 3, 'a person\'s request adds no round');
  // The cap still applies to the rounds that do count.
  assert.deepEqual(stages(finished(snap(st('in-review', { pr: 51, round: 2 }), { pr: pr(), review: rv(1) }), run('review'))), ['fixing']);
  assert.deepEqual(stages(finished(snap(st('in-review', { pr: 51, round: 3 }), { pr: pr(), review: rv(1) }), run('review'))), ['blocked']);
});

test('a retried stage keeps its failed-attempt count only if it is the same stage', () => {
  const failed = { attempts: 1, failedAt: '2026-11-09T10:30:00Z', pr: 51 };
  // The reviewer failed once; the head moved, so the retry is a verify run, which has had no failures.
  const moved = sweep([snap(st('in-review', failed), { pr: pr({ headSha: 'sha-2' }) })], ctx);
  assert.deepEqual(stages(moved), ['ci']);
  assert.equal(saves(moved)[0]?.attempts, 0);
  // The same stage again keeps it, so the last allowed attempt still blocks.
  const same = sweep([snap(st('in-review', failed), { pr: pr() })], ctx);
  assert.deepEqual(stages(same), ['in-review']);
  assert.equal(saves(same)[0]?.attempts, 1);
});

test('the sweep does not replay an /approve written before the approval request, even in the same second', () => {
  const requested = st('awaiting-approval', { approvalFor: 'plan', brief: 900, since: '2026-11-09T11:59:59.900Z' });
  const early = snap(requested, { brief: BRIEF, lastCommand: { command: 'approve', at: '2026-11-09T11:59:59Z', actor: 'adamwardecki' } });
  assert.deepEqual(sweep([early], ctx), []);
  const later = snap(requested, { brief: BRIEF, lastCommand: { command: 'approve', at: '2026-11-09T12:00:00Z', actor: 'adamwardecki' } });
  assert.deepEqual(stages(sweep([later], ctx)), ['building']);
  // Other commands keep the whole-second rule: a /stop in the same second still counts.
  const stop = snap(st('building', { since: '2026-11-09T11:59:59.900Z' }), { lastCommand: { command: 'stop', at: '2026-11-09T11:59:59Z', actor: 'adamwardecki' } });
  assert.deepEqual(stages(sweep([stop], ctx)), ['blocked']);
});

test('a clean review on a conflicting PR does not mark it ready and rebase it in the same run', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr({ conflicting: true }), review: rv(0) });
  const raw = finished(s, run('review'));
  assert.deepEqual(stages(raw), ['ready']);
  const after = [...raw, ...next([s], ctx, raw)];
  assert.deepEqual(stages(after), ['ready'], 'the rebase waits for the next sweep');
});

test('a /retry of an approval that blocked after /approve asks for approval again', () => {
  // /approve cleared approvalFor, then the gate blocked (no PR): the blocked state remembers nothing to approve.
  const blocked = snap(st('blocked', { blockedFrom: 'awaiting-approval', blockedFor: 'no-pr', pr: 51 }), { pr: pr({ files: ['plugin/hooks/gates.ts'] }), review: rv(0) });
  const a = cmd(blocked, 'retry');
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.approvalFor, 'diff');
  assert.deepEqual(stages(cmd(snap(saves(a)[0] ?? null, { pr: pr({ files: ['plugin/hooks/gates.ts'] }), review: rv(0) }), 'approve')), ['ready']);
});

test('a waiting issue that lost what it was waiting for goes back to the queue on /retry', () => {
  const lost = cmd(snap(st('blocked', { blockedFrom: 'waiting', blockedFor: 'stuck' })), 'retry');
  assert.deepEqual(stages(lost), ['queued']);
});

test('an issue whose state a newer release wrote still takes its slot, so the cap holds in a mixed rollout', () => {
  // main.ts passes the number of such active issues as `reserved`.
  const busy = at(2, snap(st('building')));
  const queued = at(3, snap(st('queued')));
  assert.deepEqual(next([busy, queued], { ...withActive(2), reserved: 1 }), []);
  assert.deepEqual(savedStages(next([busy, queued], { ...withActive(3), reserved: 1 })), ['3:planning']);
  assert.deepEqual(savedStages(next([queued], { ...withActive(1), reserved: 0 })), ['3:planning']);
});
