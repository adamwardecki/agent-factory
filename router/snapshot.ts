// Reads issues from GitHub into the snapshots decide.ts works on. The factory's own comments (state, brief, review,
// PR footer) count only with a valid signature; people's comments count only from someone with the role the comment
// needs, and only if nobody without it edited them since.

import { type Authority, COMMAND_ROLES, holdsAny, type Role } from './authority.ts';
import { ROUTER_LOGIN, RUNNER_FOR, STAGES, STATE_VERSION, stageLabel } from './config.ts';
import type { IssueSnapshot, RunSnapshot } from './decide.ts';
import {
  type Comment,
  commentEditors,
  type Edit,
  findPull,
  findRun,
  type Gh,
  issueLabels,
  latestLabeler,
  listComments,
  listReviews,
  openIssuesWithLabel,
  pullSnapshot,
  type Review,
  runJobs,
} from './github.ts';
import { dig, num } from './json.ts';
import { attemptOf, BRIEF_MARKER, type FactoryState, parseBriefTouches, parseCommand, parseReview, parseState, stateVersion } from './markers.ts';
import { runSnapshot } from './report.ts';
import { check, verify } from './sign.ts';

export type Trust = { key: string; authority: Authority };
// newerState: the state comment was written by a later factory release. The router leaves such an issue alone.
export type Loaded = { snap: IssueSnapshot; stateCommentId: number | null; prNodeId: string | null; newerState: boolean };
export type Edits = ReadonlyMap<string, Edit>;

export type FoundState = { found: { id: number; state: FactoryState } | null; retiredKey: boolean; newer: boolean };

// The newest state comment that verifies. A state comment signed with another key id means the signing key was
// replaced: older comments were signed with that key too, so the state is gone, and the caller is told why.
export function stateFrom(comments: readonly Comment[], issue: number, key: string): FoundState {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (!c || c.author !== ROUTER_LOGIN) continue;
    const version = stateVersion(c.body);
    if (version === null) continue;
    const sig = check(key, issue, 'state', c.body);
    if (sig === 'retired-key') return { found: null, retiredKey: true, newer: false };
    if (sig !== 'ok') continue;
    if (version > STATE_VERSION) return { found: null, retiredKey: false, newer: true };
    const state = parseState(c.body);
    if (state) return { found: { id: c.id, state }, retiredKey: false, newer: false };
  }
  return { found: null, retiredKey: false, newer: false };
}

export function briefComment(comments: readonly Comment[], issue: number, key: string): Comment | undefined {
  return comments.findLast((c) => c.author === ROUTER_LOGIN && c.body.trimStart().startsWith(BRIEF_MARKER) && verify(key, issue, 'brief', c.body));
}

export function briefFrom(comments: readonly Comment[], issue: number, key: string): IssueSnapshot['brief'] {
  const c = briefComment(comments, issue, key);
  const touches = c ? parseBriefTouches(c.body) : null;
  return c && touches ? { id: c.id, touches, at: c.at, attempt: attemptOf(c.body) } : null;
}

export function reviewFrom(reviews: readonly Review[], issue: number, key: string): IssueSnapshot['review'] {
  const r = reviews.findLast((x) => x.author === ROUTER_LOGIN && parseReview(x.body) !== null && verify(key, issue, 'review', x.body));
  const marker = r ? parseReview(r.body) : null;
  return r && marker ? { blocking: marker.blocking, at: r.at, sha: marker.sha, attempt: marker.attempt } : null;
}

// GraphQL reports a bot editor without the [bot] suffix.
const sameLogin = (a: string, b: string) => a.replace(/\[bot\]$/, '').toLowerCase() === b.replace(/\[bot\]$/, '').toLowerCase();

// A person's comment counts if its author holds one of the roles and nobody edited it, or the author or someone
// else with one of those roles did.
export async function trusted(c: { nodeId: string; author: string }, roles: readonly Role[], edits: Edits, authority: Authority): Promise<boolean> {
  if (!(await holdsAny(authority, roles, c.author))) return false;
  const e = edits.get(c.nodeId);
  if (!e) return false;
  return e.lastEditedAt === null || (e.editor !== null && (sameLogin(e.editor, c.author) || (await holdsAny(authority, roles, e.editor))));
}

// The newest slash command from someone who may give it.
export async function commandFrom(comments: readonly Comment[], edits: Edits, authority: Authority): Promise<IssueSnapshot['lastCommand']> {
  const candidates = comments.filter((c) => parseCommand(c.body) !== null).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const c of candidates) {
    const command = parseCommand(c.body);
    if (command && (await trusted(c, COMMAND_ROLES[command], edits, authority))) return { command, at: c.at, actor: c.author };
  }
  return null;
}

export async function changesRequestedFrom(reviews: readonly Review[], authority: Authority): Promise<IssueSnapshot['lastChangesRequested']> {
  const asked = reviews.filter((r) => r.state === 'CHANGES_REQUESTED').sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const r of asked) if (await authority.check('queue', r.author)) return { at: r.at, actor: r.author };
  return null;
}

// The current attempt's run, if GitHub has created it. Its jobs are read only once it has finished.
async function currentRun(gh: Gh, issue: number, state: FactoryState | null, now: Date): Promise<RunSnapshot | null> {
  const workflow = state ? RUNNER_FOR[state.stage] : undefined;
  if (!state?.attempt || !workflow) return null;
  const run = await findRun(gh, workflow, issue, state.attempt);
  const id = num(dig(run, 'id'));
  if (!run || id === null) return null;
  const s = runSnapshot(run, dig(run, 'status') === 'completed' ? await runJobs(gh, id) : [], gh.repo, now);
  if (!s) return null;
  return { workflow: s.workflow, attempt: s.attempt, conclusion: s.conclusion, url: s.url, completedAt: s.completedAt };
}

export async function load(gh: Gh, issue: number, trust: Trust, now: Date): Promise<Loaded> {
  const [comments, labels] = await Promise.all([listComments(gh, issue), issueLabels(gh, issue)]);
  const queued = stageLabel('queued');
  const queuedBy = labels.includes(queued) ? await latestLabeler(gh, issue, queued) : null;
  // decide.ts asks authority.known(); look the queuer up now so the answer is there.
  if (queuedBy) await trust.authority.check('queue', queuedBy.login);

  const { found, retiredKey, newer } = stateFrom(comments, issue, trust.key);
  const state = found?.state ?? null;
  const prNumber = state?.pr ?? (await findPull(gh, issue));
  const raw = prNumber ? await pullSnapshot(gh, prNumber) : null;
  const signed = raw ? verify(trust.key, issue, 'pr', raw.body) : false;
  const reviews = raw ? await listReviews(gh, raw.number) : [];
  const prComments = raw ? await listComments(gh, raw.number) : [];
  const all = [...comments, ...prComments];
  const edits = await commentEditors(gh, all.filter((c) => parseCommand(c.body) !== null).map((c) => c.nodeId));

  return {
    stateCommentId: found?.id ?? null,
    prNodeId: raw?.nodeId ?? null,
    newerState: newer,
    snap: {
      number: issue,
      state,
      retiredKey,
      labels,
      queuedBy,
      brief: briefFrom(comments, issue, trust.key),
      pr: raw
        ? { number: raw.number, headSha: raw.headSha, open: raw.open, draft: raw.draft, conflicting: raw.conflicting, files: raw.files, signed, attempt: signed ? attemptOf(raw.body) : null }
        : null,
      review: reviewFrom(reviews, issue, trust.key),
      lastCommand: await commandFrom(all, edits, trust.authority),
      lastChangesRequested: await changesRequestedFrom(reviews, trust.authority),
      lastRun: await currentRun(gh, issue, state, now),
    },
  };
}

// Every open issue carrying a stage label (done carries none), plus the issues named: an event's issue may carry no
// stage label yet.
export async function loadAll(gh: Gh, trust: Trust, now: Date, also: readonly number[] = []): Promise<Map<number, Loaded>> {
  const numbers = new Set<number>(also);
  for (const stage of STAGES) {
    if (stage === 'done') continue;
    for (const n of await openIssuesWithLabel(gh, stageLabel(stage))) numbers.add(n);
  }
  const out = new Map<number, Loaded>();
  for (const n of numbers) out.set(n, await load(gh, n, trust, now));
  return out;
}
