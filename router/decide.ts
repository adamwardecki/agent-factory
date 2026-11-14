// The factory's state machine. Pure: given an event and a snapshot of one issue (or all of them, for the sweep),
// return the actions to take. snapshot.ts reads GitHub into snapshots and main.ts applies the actions, so every
// rule here is tested without the network.

import { COMMAND_ROLES, type Role } from './authority.ts';
import {
  ACTIVE_STAGES,
  attemptId,
  branchFor,
  DISPATCH_RETRY_AFTER_MS,
  RETRY_AFTER_MS,
  RUNNER_FOR,
  type RunWorkflow,
  STUCK_AFTER_MS,
  type Stage,
  stageLabel,
  TRIAGE_READY,
  TRIAGE_STOP,
} from './config.ts';
import { coveredBy, riskyFiles, riskyTouches } from './globs.ts';
import type { AfterApproval, BlockReason, Command, FactoryState, FixReason } from './markers.ts';
import type { Limits } from './repo-config.ts';
import { oneOf } from './util.ts';

export type PullSnapshot = {
  number: number;
  headSha: string;
  // What the branch itself points at. The PR's head can trail it for a moment after a push.
  branchSha?: string;
  open: boolean;
  base: string; // the branch the PR targets; the factory's PRs target the default branch
  draft: boolean;
  conflicting: boolean;
  files: string[];
  signed: boolean; // the publish job's signed footer is in the PR body
  attempt: string | null; // the build attempt that footer names
};
export type RunSnapshot = {
  workflow: RunWorkflow;
  attempt: string | null; // from the run's title
  // For an agent stage: 'success' only if prepare, agent and publish all succeeded. For verify: 'success' or 'failure'
  // is the result of the checks; anything else means the run broke before it could tell. 'credential': the agent
  // job's credential step says Claude refused the credential.
  conclusion: string | null;
  url: string;
  completedAt: string | null; // null while the run is still going
};
export type IssueSnapshot = {
  number: number;
  state: FactoryState | null;
  retiredKey: boolean; // the newest state comment is signed with a signing key that has since been replaced
  labels: string[];
  queuedBy: { login: string; at: string } | null; // who last added agent:queued, while it is on the issue
  brief: { id: number; touches: string[]; at: string; attempt: string | null } | null; // latest signed brief
  pr: PullSnapshot | null;
  review: { blocking: number; at: string; sha: string | null; attempt: string | null } | null; // latest signed review
  lastCommand: { command: Command; at: string; actor: string } | null; // the latest slash command from someone with its role
  lastChangesRequested: { at: string; actor: string } | null; // the latest changes-requested review from the queue role
  lastRun: RunSnapshot | null; // the current attempt's run, if it exists
};
export type Ctx = {
  now: Date;
  risky: readonly string[];
  limits: Limits;
  // Whether a login holds a role. main.ts looks every actor it passes in up before deciding.
  can: (role: Role, login: string) => boolean;
  // Asked to review a ready PR when the state doesn't say who queued it.
  fallbackReviewer: string | null;
  defaultBranch: string;
  // Active issues the router can't see, because a newer release wrote their state. They still hold a slot.
  reserved: number;
};

export type FactoryEvent =
  | { kind: 'queued'; issue: number; actor: string }
  | { kind: 'command'; issue: number; command: Command; actor: string }
  | { kind: 'run-finished'; issue: number; run: RunSnapshot }
  | { kind: 'changes-requested'; issue: number; actor: string }
  | { kind: 'pr-closed'; issue: number; pr: number };

export type Action =
  | { kind: 'save'; issue: number; state: FactoryState }
  | { kind: 'dispatch'; issue: number; workflow: RunWorkflow; attempt: string }
  | { kind: 'cancel'; issue: number; workflow: RunWorkflow; attempt: string }
  | { kind: 'comment'; issue: number; body: string }
  | { kind: 'unlabel'; issue: number; labels: string[] }
  | { kind: 'pr-ready'; issue: number; pr: number; reviewer: string | null };

// GitHub's timestamps are whole seconds and since has milliseconds, so a comment from the same second the stage
// began would otherwise read as older than it.
const notBefore = (at: string, since: string) => Date.parse(at) >= Math.floor(Date.parse(since) / 1000) * 1000;

const mayCommand = (cmd: Command, actor: string, ctx: Ctx) => COMMAND_ROLES[cmd].some((r) => ctx.can(r, actor));

export function initialState(stage: Stage, now: Date): FactoryState {
  return { stage, since: now.toISOString(), round: 0, attempts: 0, runs: [] };
}

// Move to a stage and dispatch its workflow, if it has one. Per-stage counters reset unless the patch keeps them.
// Every entry into a stage with a workflow gets a new attempt id; a stage without one has none.
function enter(issue: number, prev: FactoryState, stage: Stage, ctx: Ctx, patch: Partial<FactoryState> = {}): Action[] {
  const workflow = RUNNER_FOR[stage];
  const attempt = workflow ? attemptId(ctx.now) : undefined;
  const state: FactoryState = { ...prev, attempts: 0, failedAt: undefined, resume: undefined, ...patch, stage, since: ctx.now.toISOString(), attempt };
  const actions: Action[] = [{ kind: 'save', issue, state }];
  // A fresh plan must not inherit the last plan's triage outcome.
  if (stage === 'planning') actions.push({ kind: 'unlabel', issue, labels: [TRIAGE_READY, ...TRIAGE_STOP] });
  if (workflow && attempt) actions.push({ kind: 'dispatch', issue, workflow, attempt });
  return actions;
}

// Stops the run of the attempt an issue is leaving, if it has one. Its publish job would refuse to write anyway
// (the attempt is no longer current); cancelling saves the minutes and the Claude usage.
function cancelRun(issue: number, prev: FactoryState): Action[] {
  const workflow = RUNNER_FOR[prev.stage];
  return workflow && prev.attempt ? [{ kind: 'cancel', issue, workflow, attempt: prev.attempt }] : [];
}

export function decideEvent(ev: FactoryEvent, snap: IssueSnapshot, ctx: Ctx): Action[] {
  const st = snap.state;
  switch (ev.kind) {
    case 'queued':
      if (!ctx.can('queue', ev.actor)) return [];
      if (st && st.stage !== 'done' && st.stage !== 'blocked') return [];
      return [{ kind: 'save', issue: ev.issue, state: { ...initialState('queued', ctx.now), queuedBy: ev.actor } }];
    case 'command':
      return st && mayCommand(ev.command, ev.actor, ctx) ? command(ev.issue, st, snap, ev.command, ctx) : [];
    case 'run-finished':
      return st ? runFinished(ev.issue, st, snap, ev.run, ctx) : [];
    case 'changes-requested':
      return ctx.can('queue', ev.actor) && st?.stage === 'ready' ? toFix(ev.issue, st, snap, 'maintainer', ctx) : [];
    case 'pr-closed':
      // Only the issue's own PR finishes it. An older PR from the same branch closing must not, and before a run has
      // recorded its PR there is no "own" PR yet: closing last round's PR after a re-queue is the usual order.
      if (!st || st.stage === 'done' || st.pr === undefined || st.pr !== ev.pr) return [];
      return [...enter(ev.issue, st, 'done', ctx), ...cancelRun(ev.issue, st)];
  }
}

const CREDENTIAL_REFUSED =
  'Claude refused the credential before its first model call; the subscription token has probably expired. Renew it: run `claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN` for this repo.';

function block(issue: number, prev: FactoryState, reason: string, blockedFor: BlockReason, ctx: Ctx): Action[] {
  const blockedFrom = prev.stage === 'blocked' ? prev.blockedFrom : prev.stage;
  return [
    // A waiting issue keeps what it was waiting to run, so /retry can put it back in the queue (enter() clears it).
    ...enter(issue, prev, 'blocked', ctx, { blockedFrom, blockedFor, resume: prev.resume }),
    ...cancelRun(issue, prev),
    { kind: 'comment', issue, body: `Factory stopped at **${blockedFrom}**: ${reason}\n\nFix the cause, then comment \`/retry\`.` },
  ];
}

// A stage run failed or broke its contract. The sweep retries it after RETRY_AFTER_MS (a subscription usage window
// may need to reset); the last allowed attempt blocks instead.
function fail(issue: number, prev: FactoryState, reason: string, ctx: Ctx): Action[] {
  const attempts = prev.attempts + 1;
  const max = ctx.limits.maxAttempts;
  if (attempts >= max) return block(issue, prev, `${reason} (attempt ${attempts} of ${max}).`, 'attempts', ctx);
  return [{ kind: 'save', issue, state: { ...prev, attempts, failedAt: ctx.now.toISOString() } }];
}

function toFix(issue: number, prev: FactoryState, snap: IssueSnapshot, reason: FixReason, ctx: Ctx): Action[] {
  // Rebases have their own cap: a rebase that never clears the conflict would loop through verify and review forever.
  if (reason === 'rebase') {
    const rebases = (prev.rebases ?? 0) + 1;
    const max = ctx.limits.maxRebases;
    if (rebases > max) return block(issue, prev, `the PR conflicts with the default branch again after ${max} rebases.`, 'rebases', ctx);
    return onward(issue, prev, snap, 'fix', ctx, { rebases, fixReason: reason });
  }
  // Only verify's and the reviewer's rounds count toward the cap; a person's requests add none, so they are never
  // refused for rounds already spent (the cap may have been lowered since).
  const round = prev.round + (reason === 'ci' || reason === 'review' ? 1 : 0);
  if (reason !== 'maintainer' && round > ctx.limits.maxRounds) return block(issue, prev, `still not passing after ${ctx.limits.maxRounds} fix rounds.`, 'rounds', ctx);
  return onward(issue, prev, snap, 'fix', ctx, { round, fixReason: reason });
}

// The PR's risky files nobody has approved: none while the head is the one approved, otherwise those outside the
// approved plan's Touches. A plan approval covers only the paths it named.
function unapprovedRisky(st: FactoryState, pr: PullSnapshot | null, ctx: Ctx): string[] {
  if (!pr || (pr.headSha !== '' && pr.headSha === st.approvedSha)) return [];
  const hits = riskyFiles(pr.files, ctx.risky);
  const covered = new Set(coveredBy(hits, st.approvedTouches ?? []));
  return hits.filter((f) => !covered.has(f));
}

// The diff gate. From verify on, the factory runs what the PR branch holds (its tests and package scripts, and for
// review and fix its agent instructions and settings), so a risky diff waits for /approve before any of that runs,
// and before the PR is marked ready. null when the diff passes. The patch is what the stage would have been entered
// with; it is kept for /approve.
function diffGate(issue: number, st: FactoryState, snap: IssueSnapshot, to: AfterApproval, ctx: Ctx, patch: Partial<FactoryState> = {}): Action[] | null {
  // No PR means no diff to check, not a clean one: the stage would run on whatever the branch holds.
  if (!snap.pr) return block(issue, st, `no PR from \`${branchFor(issue)}\` was found, so its diff cannot be checked.`, 'no-pr', ctx);
  // The diff is read against the default branch; a PR into another base would be checked against the wrong files.
  if (snap.pr.base !== ctx.defaultBranch) return block(issue, st, `PR #${snap.pr.number} targets \`${snap.pr.base}\`, not \`${ctx.defaultBranch}\`, so its diff cannot be checked.`, 'no-pr', ctx);
  // A closed PR can't be verified, reviewed or marked ready. Its own close finishes the issue; any other PR is not
  // something to continue on.
  if (!snap.pr.open) {
    if (st.pr === snap.pr.number) return [...enter(issue, st, 'done', ctx), ...cancelRun(issue, st)];
    return block(issue, st, `PR #${snap.pr.number} is closed, so there is nothing to check.`, 'no-pr', ctx);
  }
  const hits = unapprovedRisky(st, snap.pr, ctx);
  if (hits.length === 0) return null;
  return askApproval(issue, st, 'diff', hits, ctx, { ...patch, afterApproval: to, approvalSha: snap.pr.headSha });
}

// The only way into verify, review, fix or ready. The diff must pass the gate, and the SHAs must agree:
//   review runs only on the head verify passed on;
//   ready needs the head, the review and verify to name the same commit;
//   a head that moved goes back through verify (and so through this gate) first.
// Each stage records the head the gate checked (gatedSha): its job refuses to run on another.
function onward(issue: number, st: FactoryState, snap: IssueSnapshot, to: AfterApproval, ctx: Ctx, patch: Partial<FactoryState> = {}): Action[] {
  const gate = diffGate(issue, st, snap, to, ctx, patch);
  if (gate) return gate;
  const pr = snap.pr;
  if (!pr) return []; // unreachable: the gate blocks without a PR
  const head = pr.headSha;
  const verified = ({ ...st, ...patch }).verifiedSha === head;
  const verify = () => enter(issue, st, 'ci', ctx, { ...patch, gatedSha: head });
  const review = () => enter(issue, st, 'in-review', ctx, { ...patch, gatedSha: head });
  switch (to) {
    case 'verify':
      return verify();
    case 'review':
      return verified ? review() : verify();
    case 'fix':
      return enter(issue, st, 'fixing', ctx, { ...patch, headSha: head, gatedSha: head });
    case 'ready':
      if (!verified) return verify();
      // A review counts only for the commit it reviewed.
      if (!snap.review || snap.review.sha !== head) return review();
      if (snap.review.blocking > 0) return toFix(issue, { ...st, ...patch }, snap, 'review', ctx);
      return toReady(issue, { ...st, ...patch }, pr.number, ctx);
  }
}

// A PR that reached ready through a rebase keeps its rebase count, so the conflict → rebase → ready loop stays
// capped; reaching ready any other way means real work landed in between, and the count starts over.
function toReady(issue: number, prev: FactoryState, pr: number, ctx: Ctx): Action[] {
  const rebases = prev.fixReason === 'rebase' ? prev.rebases : undefined;
  return [...enter(issue, prev, 'ready', ctx, { approvalFor: undefined, rebases }), { kind: 'pr-ready', issue, pr, reviewer: prev.queuedBy ?? ctx.fallbackReviewer }];
}

function askApproval(issue: number, prev: FactoryState, approvalFor: 'plan' | 'diff', hits: string[], ctx: Ctx, patch: Partial<FactoryState> = {}): Action[] {
  const what = approvalFor === 'plan' ? 'The brief touches' : `The PR changes, at \`${patch.approvalSha ?? 'unknown'}\`,`;
  const list = hits.map((h) => `- \`${h}\``).join('\n');
  // A later push is checked again, so the approval covers exactly the commit listed.
  const scope = approvalFor === 'diff' ? ' A push after this commit is checked again.' : '';
  return [
    ...enter(issue, prev, 'awaiting-approval', ctx, { ...patch, approvalFor }),
    {
      kind: 'comment',
      issue,
      body: `${what} risky paths (the factory's baseline and \`riskyPaths\` in \`.github/factory.json\`):\n\n${list}\n\nComment \`/approve\` to continue or \`/stop\` to stop.${scope}`,
    },
  ];
}

function runFinished(issue: number, st: FactoryState, snap: IssueSnapshot, run: RunSnapshot, ctx: Ctx): Action[] {
  const expected = RUNNER_FOR[st.stage];
  if (!expected || run.workflow !== expected || !run.completedAt || st.runs.includes(run.url)) return [];
  // Only the attempt the state names counts. A run from an earlier entry into the stage is stale, however late it ends.
  if (!st.attempt || run.attempt !== st.attempt) return [];
  // Only a run the router cancelled itself is cancelled by anyone else's hand, and those belong to attempts it has
  // already left (dropped above). A job that hits its timeout also reads as cancelled; that is a failed attempt.
  if (run.conclusion === 'skipped') return [];
  const seen: FactoryState = { ...st, runs: [...st.runs, run.url] };
  if (expected === 'verify') return verified(issue, seen, snap, run, ctx);
  // Retrying can't help until someone renews the credential, so the issue stops now and says how, once.
  if (run.conclusion === 'credential') return block(issue, seen, CREDENTIAL_REFUSED, 'credential', ctx);
  if (run.conclusion !== 'success') return fail(issue, seen, `the ${expected} run ended with "${run.conclusion}"`, ctx);
  switch (expected) {
    case 'plan':
      return planned(issue, seen, snap, ctx);
    case 'build':
      return built(issue, seen, snap, ctx);
    case 'review':
      return reviewed(issue, seen, snap, ctx);
    case 'fix':
      return fixed(issue, seen, snap, ctx);
  }
}

// Verify ran the repo's checks on gatedSha. Green: that commit is verified, on to review. Red: to the fixer, which
// reads the failed log from this run (a run picked later by branch name could be anyone's). Anything else: the run
// broke before the checks could tell, which is a failed attempt, not a fix round.
function verified(issue: number, st: FactoryState, snap: IssueSnapshot, run: RunSnapshot, ctx: Ctx): Action[] {
  const ci: FactoryState = { ...st, ciRun: run.url };
  if (run.conclusion === 'success') return onward(issue, { ...ci, verifiedSha: st.gatedSha }, snap, 'review', ctx);
  if (run.conclusion === 'failure') return toFix(issue, ci, snap, 'ci', ctx);
  return fail(issue, st, `the verify run ended with "${run.conclusion}" before its checks finished`, ctx);
}

function planned(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  if (snap.labels.some((l) => oneOf(TRIAGE_STOP, l))) return block(issue, st, 'the planner needs a human; see its comment.', 'human', ctx);
  const brief = snap.brief && snap.brief.attempt === st.attempt ? snap.brief : null;
  if (!brief || !snap.labels.includes(TRIAGE_READY)) return fail(issue, st, 'the planner finished without a brief and the ready-for-agent label', ctx);
  const hits = riskyTouches(brief.touches, ctx.risky);
  // A new plan must not inherit what an earlier plan was approved to touch.
  const patch = { brief: brief.id, approvedTouches: undefined };
  if (hits.length > 0) return askApproval(issue, st, 'plan', hits, ctx, patch);
  return enter(issue, st, 'building', ctx, patch);
}

function built(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  // Only the publish job signs PR bodies, and it names the attempt: a PR anyone else opened from the branch, or one
  // an earlier build left, is not this build.
  if (!snap.pr?.open || snap.pr.base !== ctx.defaultBranch || !snap.pr.signed || snap.pr.attempt !== st.attempt) {
    return fail(issue, st, `the builder finished without an open PR from \`${branchFor(issue)}\` signed for this attempt`, ctx);
  }
  return onward(issue, st, snap, 'verify', ctx, { pr: snap.pr.number });
}

function reviewed(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  const review = snap.review && snap.review.attempt === st.attempt ? snap.review : null;
  if (!review || !snap.pr) return fail(issue, st, 'the reviewer finished without posting a factory review', ctx);
  if (review.blocking > 0) return toFix(issue, st, snap, 'review', ctx);
  // The diff is checked again here: a plan can drift, or have been steered, after its paths were approved. And the
  // head may have moved while the reviewer read the old one; onward sends that back through verify.
  return onward(issue, st, snap, 'ready', ctx);
}

function fixed(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  // Without the head the fixer started from, nothing shows that it pushed.
  if (!snap.pr || st.headSha === undefined) return fail(issue, st, 'the fixer finished without pushing a commit', ctx);
  if (snap.pr.headSha === st.headSha) {
    // The branch already moved but the PR has not caught up: look again on the next sweep rather than burn an attempt.
    if (snap.pr.branchSha && snap.pr.branchSha !== st.headSha) return [];
    return fail(issue, st, 'the fixer finished without pushing a commit', ctx);
  }
  return onward(issue, st, snap, 'verify', ctx);
}

function command(issue: number, st: FactoryState, snap: IssueSnapshot, cmd: Command, ctx: Ctx): Action[] {
  switch (cmd) {
    case 'approve':
      if (st.stage !== 'awaiting-approval') return [];
      // A state without approvalFor was not written by askApproval; guessing could skip the diff check.
      if (st.approvalFor === 'plan') {
        // Only the brief whose Touches the request listed; a newer one was not what was approved.
        const approvedTouches = snap.brief && snap.brief.id === st.brief ? snap.brief.touches : [];
        return enter(issue, st, 'building', ctx, { approvalFor: undefined, approvedTouches });
      }
      if (st.approvalFor === 'diff') {
        // The approval covers the head the request listed. If the PR moved since, the gate checks the new head.
        const approved: FactoryState = { ...st, approvalFor: undefined, afterApproval: undefined, approvalSha: undefined, approvedSha: st.approvalSha };
        return onward(issue, approved, snap, st.afterApproval ?? 'ready', ctx);
      }
      return [];
    case 'stop':
      return st.stage === 'blocked' || st.stage === 'done' ? [] : block(issue, st, 'stopped by a maintainer.', 'stop', ctx);
    case 'retry':
      return st.stage === 'blocked' ? retry(issue, st, snap, ctx) : [];
  }
}

// /retry picks its way back in from why the issue stopped, not just where.
function retry(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  const from = st.blockedFrom;
  if (!from) return [];
  const clear = { blockedFrom: undefined, blockedFor: undefined };
  // Out of rounds: the last verify log or review still has the problem, so the fixer gets a fresh set of rounds for
  // it. Re-running the reviewer would only repeat the findings.
  if (st.blockedFor === 'rounds' && (from === 'ci' || from === 'in-review')) {
    if (!snap.pr) return [];
    return onward(issue, st, snap, 'fix', ctx, { ...clear, round: 0, fixReason: from === 'ci' ? 'ci' : 'review' });
  }
  // Back to ready with the count cleared; the next idle sweep rebases again if the PR still conflicts. Ready is a
  // claim about one commit, so it goes through the SHA checks like any other way in.
  if (st.blockedFor === 'rebases') return snap.pr ? onward(issue, st, snap, 'ready', ctx, { ...clear, rebases: undefined }) : [];
  if (from === 'fixing') {
    // The fixer compares the PR head after its run with this one; without a PR there is nothing to fix.
    if (!snap.pr) return [];
    return onward(issue, st, snap, 'fix', ctx, clear);
  }
  // Stuck or stopped at verify: no failure is known, so run verify again and let its result decide.
  if (from === 'ci') return onward(issue, st, snap, 'verify', ctx, clear);
  if (from === 'in-review') return onward(issue, st, snap, 'review', ctx, clear);
  if (from === 'ready') return snap.pr ? onward(issue, st, snap, 'ready', ctx, clear) : [];
  // An approval that blocked right after /approve has nothing left to approve: ask again through the strictest gate.
  if (from === 'awaiting-approval' && st.approvalFor === undefined) return snap.pr ? onward(issue, st, snap, 'ready', ctx, clear) : [];
  // A waiting issue goes back to waiting for a slot, and the next free one starts it. One that lost what it was
  // waiting to run starts over from the queue.
  if (from === 'waiting') return st.resume ? enter(issue, st, 'waiting', ctx, { ...clear, resume: st.resume }) : enter(issue, st, 'queued', ctx, clear);
  return enter(issue, st, from, ctx, clear);
}

const isActive = (s: FactoryState | null | undefined): boolean => s !== null && s !== undefined && ACTIVE_STAGES.includes(s.stage);

// The stage the actions leave an issue in: the last save, if there is one.
function stageAfter(actions: readonly Action[]): Stage | undefined {
  let stage: Stage | undefined;
  for (const a of actions) if (a.kind === 'save') stage = a.state.stage;
  return stage;
}

// No slot was free for an issue that was about to become active. Keep everything the transition decided (round,
// fix reason, approvals), but leave the issue in `waiting` with the workflow it was about to run, and dispatch nothing.
function park(actions: readonly Action[]): Action[] {
  const last = actions.findLastIndex((a) => a.kind === 'save');
  return actions.flatMap((a, i): Action[] => {
    if (a.kind === 'dispatch') return [];
    if (a.kind !== 'save' || i !== last) return [a];
    return [{ ...a, state: { ...a.state, stage: 'waiting', resume: RUNNER_FOR[a.state.stage], attempt: undefined } }];
  });
}

// The admission queue. Every move from an inactive stage to an active one passes through the maxActive cap: /approve,
// /retry, a changes-requested review and the sweep's recoveries, not only the start of a queued issue. A move that
// doesn't fit is parked in `waiting`. Issues that were already active keep their slots.
export function settle(snaps: readonly IssueSnapshot[], actions: readonly Action[], ctx: Ctx): Action[] {
  const before = new Map<number, FactoryState | null>(snaps.map((s) => [s.number, s.state]));
  const groups = new Map<number, Action[]>();
  for (const a of actions) {
    const g = groups.get(a.issue);
    if (g) g.push(a);
    else groups.set(a.issue, [a]);
  }
  let active = ctx.reserved;
  for (const [issue, state] of before) {
    if (!isActive(state)) continue;
    const to = stageAfter(groups.get(issue) ?? []);
    if (to === undefined || ACTIVE_STAGES.includes(to)) active++;
  }
  const out: Action[] = [];
  for (const [issue, acts] of groups) {
    const to = stageAfter(acts);
    if (to === undefined || !ACTIVE_STAGES.includes(to) || isActive(before.get(issue))) out.push(...acts);
    else if (active < ctx.limits.maxActive) {
      active++;
      out.push(...acts);
    } else out.push(...park(acts));
  }
  return out;
}

// A waiting issue gets its slot. The stages that run on the PR branch go back through onward(): the PR may have
// moved, or been closed, while the issue waited.
function resume(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  switch (st.resume) {
    case 'plan':
      return enter(issue, st, 'planning', ctx);
    case 'build':
      return enter(issue, st, 'building', ctx);
    case 'verify':
    case 'review':
    case 'fix':
      return onward(issue, st, snap, st.resume, ctx, { resume: undefined });
    case undefined:
      return block(issue, st, 'the issue was waiting for a slot, but its state does not say for what.', 'stuck', ctx);
  }
}

// Fills free slots up to maxActive, in this order: waiting issues (oldest first), ready PRs that now conflict with
// the default branch (back to the fixer to rebase), then the oldest queued issues. Waiting on a person takes no
// slot; neither does a resume or a rebase that ends up blocked or awaiting approval.
function startNext(snaps: readonly IssueSnapshot[], actions: readonly Action[], ctx: Ctx): Action[] {
  const after = new Map<number, FactoryState | null>(snaps.map((s) => [s.number, s.state]));
  for (const a of actions) if (a.kind === 'save') after.set(a.issue, a.state);
  const snapOf = new Map(snaps.map((s) => [s.number, s]));
  let free = ctx.limits.maxActive - ctx.reserved - [...after.values()].filter(isActive).length;
  // An issue the actions just moved is judged on the next run: a clean review on a conflicting PR claims `ready`, and
  // the rebase is for after the reviewer has been asked about the commit it actually reviewed.
  const touched = new Set(actions.flatMap((a) => (a.kind === 'save' ? [a.issue] : [])));
  const out: Action[] = [];
  const take = (acts: Action[]) => {
    out.push(...acts);
    const to = stageAfter(acts);
    if (to !== undefined && ACTIVE_STAGES.includes(to)) free--;
  };
  const oldest = (stage: Stage) =>
    [...after.entries()].filter((e): e is [number, FactoryState] => e[1]?.stage === stage).sort((a, b) => Date.parse(a[1].since) - Date.parse(b[1].since));

  for (const [issue, state] of oldest('waiting')) {
    const s = snapOf.get(issue);
    if (free <= 0) return out;
    if (s) take(resume(issue, state, s, ctx));
  }
  for (const s of snaps) {
    if (free <= 0) return out;
    const state = after.get(s.number);
    if (state?.stage === 'ready' && s.pr?.conflicting && !touched.has(s.number)) take(toFix(s.number, state, s, 'rebase', ctx));
  }
  for (const [issue, state] of oldest('queued')) {
    if (free <= 0) return out;
    take(enter(issue, state, 'planning', ctx));
  }
  return out;
}

// What to start once an event's actions are in. main.ts passes the event's settled actions: the snapshots still show
// the issue as it was before the event.
export function next(snaps: readonly IssueSnapshot[], ctx: Ctx, eventActions: readonly Action[] = []): Action[] {
  return startNext(snaps, eventActions, ctx);
}

// The sweep. Recovers what the event path can miss (the router's concurrency group can drop pending runs), retries
// failed stages, blocks stuck ones, then fills free slots.
export function sweep(snaps: readonly IssueSnapshot[], ctx: Ctx): Action[] {
  const actions = settle(snaps, snaps.flatMap((s) => sweepOne(s, ctx)), ctx);
  return [...actions, ...startNext(snaps, actions, ctx)];
}

// The label alone is not enough to queue: any workflow can write labels, and only the queue role starts work. A
// blocked or done issue is queued again only by a labelling after it stopped.
function queuedByRole(snap: IssueSnapshot, ctx: Ctx): boolean {
  const by = snap.queuedBy;
  if (!snap.labels.includes(stageLabel('queued')) || !by || !ctx.can('queue', by.login)) return false;
  const st = snap.state;
  return !st || ((st.stage === 'blocked' || st.stage === 'done') && notBefore(by.at, st.since));
}

function sweepOne(snap: IssueSnapshot, ctx: Ctx): Action[] {
  const st = snap.state;
  if (queuedByRole(snap, ctx)) return [{ kind: 'save', issue: snap.number, state: { ...initialState('queued', ctx.now), queuedBy: snap.queuedBy?.login } }];
  if (!st) {
    // State signed with a replaced key can't be trusted or recovered. Say so once: the new state is signed with the
    // current key, so the next sweep reads it as an ordinary blocked issue.
    if (!snap.retiredKey) return [];
    return [
      { kind: 'save', issue: snap.number, state: { ...initialState('blocked', ctx.now), blockedFor: 'key-rotated' } },
      { kind: 'comment', issue: snap.number, body: "The factory's signing key was replaced, so this issue's earlier state can no longer be verified. Add `agent:queued` again to start it over." },
    ];
  }
  // The close event can be dropped by the router's concurrency group. Only the PR the state recorded counts: before
  // a run records one, the loader finds the branch's last PR, which may be from a run that already finished.
  if (snap.pr && !snap.pr.open && st.stage !== 'done' && snap.pr.number === st.pr) return [...enter(snap.number, st, 'done', ctx), ...cancelRun(snap.number, st)];
  // snapshot.ts already keeps only commands from someone with the role; checked again so a loader change cannot open
  // this up.
  const cmd = snap.lastCommand;
  // An /approve must come strictly after the request it answers: whole-second timestamps would otherwise let one
  // written just before the request count as an answer to it.
  const answers = cmd && (cmd.command === 'approve' ? Date.parse(cmd.at) > Date.parse(st.since) : notBefore(cmd.at, st.since));
  if (cmd && answers && mayCommand(cmd.command, cmd.actor, ctx)) {
    const acted = command(snap.number, st, snap, cmd.command, ctx);
    if (acted.length > 0) return acted;
  }
  // The event can be dropped by the router's concurrency group; the review itself stays on the PR.
  const cr = snap.lastChangesRequested;
  if (st.stage === 'ready' && cr && ctx.can('queue', cr.actor) && notBefore(cr.at, st.since)) return toFix(snap.number, st, snap, 'maintainer', ctx);
  // Marking the PR ready comes after the state is saved; if it failed, nothing else would ever try again. It is safe
  // to repeat: a PR that is no longer a draft is left as it is.
  // Only for a while: after that a draft is more likely someone's choice than a failure.
  if (st.stage === 'ready' && snap.pr?.open && snap.pr.draft && snap.pr.number === st.pr && ctx.now.getTime() - Date.parse(st.since) <= STUCK_AFTER_MS) {
    return [{ kind: 'pr-ready', issue: snap.number, pr: snap.pr.number, reviewer: st.queuedBy ?? ctx.fallbackReviewer }];
  }
  if (!ACTIVE_STAGES.includes(st.stage)) return [];
  if (st.failedAt) {
    const due = ctx.now.getTime() - Date.parse(st.failedAt) >= RETRY_AFTER_MS;
    if (!due) return [];
    // A failed fixer may have pushed before it failed, so a retry on the PR branch goes in like any other run on it:
    // through the gate, on the head the gate just checked.
    if (st.stage === 'fixing') {
      // headSha stays the head the fixer was first dispatched on: if the failed run pushed, the retry has "pushed".
      const gate = diffGate(snap.number, st, snap, 'fix', ctx);
      return gate ?? enter(snap.number, st, 'fixing', ctx, { attempts: st.attempts, gatedSha: snap.pr?.headSha });
    }
    const to = st.stage === 'ci' ? 'verify' : st.stage === 'in-review' ? 'review' : null;
    // The failed-attempt count belongs to the stage that failed: if the head moved, the retry is a different stage.
    const retried = to ? onward(snap.number, st, snap, to, ctx, { attempts: st.attempts }) : enter(snap.number, st, st.stage, ctx, { attempts: st.attempts });
    return retried.map((a) => (a.kind === 'save' && a.state.stage !== st.stage ? { ...a, state: { ...a.state, attempts: 0 } } : a));
  }
  if (snap.lastRun) {
    const acted = runFinished(snap.number, st, snap, snap.lastRun, ctx);
    if (acted.length > 0) return acted;
  }
  // The dispatch comes after the state is saved too. No run for the attempt after this long means it never started.
  const idle = ctx.now.getTime() - Date.parse(st.since);
  if (!snap.lastRun && st.attempt && RUNNER_FOR[st.stage] && idle > DISPATCH_RETRY_AFTER_MS && idle <= STUCK_AFTER_MS) {
    return [{ kind: 'dispatch', issue: snap.number, workflow: RUNNER_FOR[st.stage] as RunWorkflow, attempt: st.attempt }];
  }
  if (ctx.now.getTime() - Date.parse(st.since) > STUCK_AFTER_MS) {
    return block(snap.number, st, `no progress for ${STUCK_AFTER_MS / 60000} minutes.`, 'stuck', ctx);
  }
  return [];
}
