// Reads issues from GitHub into the snapshots decide.ts works on.

import { MAINTAINER, ROUTER_LOGIN, RUNNER_FOR, STAGES, stageLabel } from './config.ts';
import type { IssueSnapshot } from './decide.ts';
import {
  type Comment,
  commentEditors,
  type Edit,
  findPull,
  type Gh,
  issueLabels,
  latestCiRun,
  latestLabeler,
  latestStageRun,
  listComments,
  listReviews,
  openIssuesWithLabel,
  pullSnapshot,
  type Review,
} from './github.ts';
import { BRIEF_MARKER, type FactoryState, parseBriefTouches, parseCommand, parseReview, parseState } from './markers.ts';

export type Loaded = { snap: IssueSnapshot; stateCommentId: number | null; prNodeId: string | null };
export type Edits = ReadonlyMap<string, Edit>;

// Authorship alone is not enough: anyone with write access, the factory's App included, can edit a comment. A
// comment counts only if it was never edited or `editor` edited it last. One that was not looked up counts as edited.
export function editedOnlyBy(c: { nodeId: string }, edits: Edits, editor: string | null): boolean {
  const e = edits.get(c.nodeId);
  if (!e) return false;
  return e.lastEditedAt === null || (editor !== null && e.editor === editor);
}

// The router's latest state comment, before its edits are checked (stateFrom checks them).
export function stateCandidate(comments: readonly Comment[]): { comment: Comment; state: FactoryState } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (!c || c.author !== ROUTER_LOGIN) continue;
    const state = parseState(c.body);
    if (state) return { comment: c, state };
  }
  return null;
}

// The router's latest state comment. Only comments by the router account count, so nobody can forge a stage; and
// only as the router last wrote it. An older state comment does not stand in for a tampered one: it would be stale.
export function stateFrom(comments: readonly Comment[], edits: Edits): { id: number; state: FactoryState } | null {
  const found = stateCandidate(comments);
  return found && editedOnlyBy(found.comment, edits, ROUTER_LOGIN) ? { id: found.comment.id, state: found.state } : null;
}

const briefCandidate = (comments: readonly Comment[], bot: string) => comments.findLast((c) => c.author === bot && c.body.includes(BRIEF_MARKER));

// The factory bot's latest brief, if it was never edited: the maintainer approves the Touches it was posted with.
export function briefFrom(comments: readonly Comment[], bot: string, edits: Edits): IssueSnapshot['brief'] {
  const c = briefCandidate(comments, bot);
  const touches = c && editedOnlyBy(c, edits, null) ? parseBriefTouches(c.body) : null;
  return c && touches ? { id: c.id, touches, at: c.at } : null;
}

const commandComments = (comments: readonly Comment[]) => comments.filter((c) => c.author === MAINTAINER && parseCommand(c.body) !== null);

// The maintainer's latest slash command, from comments only the maintainer has edited.
export function commandFrom(comments: readonly Comment[], edits: Edits): IssueSnapshot['lastCommand'] {
  const commands = commandComments(comments)
    .filter((c) => editedOnlyBy(c, edits, MAINTAINER))
    .flatMap((c) => {
      const command = parseCommand(c.body);
      return command ? [{ command, at: c.at, actor: c.author }] : [];
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return commands.at(-1) ?? null;
}

// The node ids the snapshot needs edit history for, so load makes one lookup.
export function editLookups(comments: readonly Comment[], prComments: readonly Comment[], bot: string): string[] {
  return [stateCandidate(comments)?.comment, briefCandidate(comments, bot), ...commandComments([...comments, ...prComments])].flatMap((c) => (c ? [c.nodeId] : []));
}

// Reviews cannot be retargeted by an edit: the state is fixed when the review is submitted.
export function changesRequestedFrom(reviews: readonly Review[]): IssueSnapshot['lastChangesRequested'] {
  const r = reviews.findLast((x) => x.author === MAINTAINER && x.state === 'CHANGES_REQUESTED');
  return r ? { at: r.at, actor: r.author } : null;
}

export async function load(gh: Gh, issue: number, bot: string): Promise<Loaded> {
  const [comments, labels] = await Promise.all([listComments(gh, issue), issueLabels(gh, issue)]);
  // The timeline costs a call per page, and who queued an issue only matters while the label is on it.
  const queued = stageLabel('queued');
  const queuedBy = labels.includes(queued) ? await latestLabeler(gh, issue, queued) : null;

  // The PR comes from the state comment before its edits are checked, so one lookup covers both threads. If the
  // state turns out tampered, the snapshot has no state, and decide.ts acts on no PR without one.
  const prNumber = stateCandidate(comments)?.state.pr ?? (await findPull(gh, issue));
  const pr = prNumber ? await pullSnapshot(gh, prNumber) : null;
  const reviews = pr ? await listReviews(gh, pr.number) : [];
  const prComments = pr ? await listComments(gh, pr.number) : [];
  const edits = await commentEditors(gh, editLookups(comments, prComments, bot));

  const found = stateFrom(comments, edits);
  const state = found?.state ?? null;
  // Reviews count only from the factory bot: anyone can review on a public repo.
  const reviewRow = reviews.findLast((r) => r.author === bot && parseReview(r.body) !== null);
  const verdict = reviewRow ? parseReview(reviewRow.body) : null;

  const stage = state?.stage;
  const workflow = stage ? RUNNER_FOR[stage] : undefined;
  const lastRun = stage === 'ci' && pr ? await latestCiRun(gh, issue, pr.headSha) : workflow ? await latestStageRun(gh, workflow, issue) : null;

  return {
    stateCommentId: found?.id ?? null,
    prNodeId: pr?.nodeId ?? null,
    snap: {
      number: issue,
      state,
      labels,
      queuedBy,
      brief: briefFrom(comments, bot, edits),
      pr,
      review: reviewRow && verdict ? { blocking: verdict.blocking, at: reviewRow.at } : null,
      lastCommand: commandFrom([...comments, ...prComments], edits),
      lastChangesRequested: changesRequestedFrom(reviews),
      lastRun,
    },
  };
}

// Every open issue carrying a stage label (done carries none).
export async function loadAll(gh: Gh, bot: string): Promise<Map<number, Loaded>> {
  const numbers = new Set<number>();
  for (const stage of STAGES) {
    if (stage === 'done') continue;
    for (const n of await openIssuesWithLabel(gh, stageLabel(stage))) numbers.add(n);
  }
  const out = new Map<number, Loaded>();
  for (const n of numbers) out.set(n, await load(gh, n, bot));
  return out;
}
