// A thin GitHub REST and GraphQL client for the factory. No retries: the sweep runs every 30 minutes and picks up
// whatever a failed run left behind. Every write the factory makes goes through a function here, with the client it
// was handed: nothing in this file knows which identity the token belongs to.

import { branchFor, LABEL_PREFIX, type RunWorkflow, runTitle, STAGE_WORKFLOW_FILE } from './config.ts';
import type { PullSnapshot } from './decide.ts';
import { dig, inRepo, isStageRun, num, rows, str } from './json.ts';

export type Gh = { repo: string; call: (method: string, path: string, body?: unknown) => Promise<unknown> };
// nodeId is the GraphQL id, for looking up who last edited the comment or review (commentEditors).
export type Comment = { id: number; nodeId: string; author: string; body: string; at: string };
export type Review = { nodeId: string; author: string; body: string; at: string; state: string };

// A failed REST call. The status lets a caller accept an expected failure, such as a 404 for a label already gone.
export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function client(token: string, repo: string): Gh {
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(`GitHub ${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`, res.status);
    return text ? JSON.parse(text) : undefined;
  }
  return { repo, call };
}

async function paged(gh: Gh, path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; ; page++) {
    const batch = rows(await gh.call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

const toComment = (r: unknown): Comment => ({
  id: num(dig(r, 'id')) ?? 0,
  nodeId: str(dig(r, 'node_id')),
  author: str(dig(r, 'user', 'login')),
  body: str(dig(r, 'body')),
  at: str(dig(r, 'created_at')),
});

export async function listComments(gh: Gh, issue: number): Promise<Comment[]> {
  return (await paged(gh, `/repos/${gh.repo}/issues/${issue}/comments`)).map(toComment);
}

export async function listReviewComments(gh: Gh, pr: number): Promise<Comment[]> {
  return (await paged(gh, `/repos/${gh.repo}/pulls/${pr}/comments`)).map((r) => {
    const c = toComment(r);
    return { ...c, body: `\`${str(dig(r, 'path'))}\`: ${c.body}` };
  });
}

export async function listReviews(gh: Gh, pr: number): Promise<Review[]> {
  return (await paged(gh, `/repos/${gh.repo}/pulls/${pr}/reviews`)).map((r) => ({
    nodeId: str(dig(r, 'node_id')),
    author: str(dig(r, 'user', 'login')),
    body: str(dig(r, 'body')),
    at: str(dig(r, 'submitted_at')),
    state: str(dig(r, 'state')),
  }));
}

// Who last added the label, and when, from the issue timeline (oldest first). null if it was never added.
export async function latestLabeler(gh: Gh, issue: number, label: string): Promise<{ login: string; at: string } | null> {
  const row = (await paged(gh, `/repos/${gh.repo}/issues/${issue}/timeline`)).findLast((e) => dig(e, 'event') === 'labeled' && dig(e, 'label', 'name') === label);
  return row ? { login: str(dig(row, 'actor', 'login')), at: str(dig(row, 'created_at')) } : null;
}

export async function issueLabels(gh: Gh, issue: number): Promise<string[]> {
  return rows(dig(await gh.call('GET', `/repos/${gh.repo}/issues/${issue}`), 'labels')).map((l) => str(dig(l, 'name')));
}

export async function openIssuesWithLabel(gh: Gh, label: string): Promise<number[]> {
  return (await paged(gh, `/repos/${gh.repo}/issues?state=open&labels=${encodeURIComponent(label)}`))
    .filter((r) => dig(r, 'pull_request') === undefined)
    .map((r) => num(dig(r, 'number')))
    .filter((n): n is number => n !== null);
}

// The newest PR from the issue's factory branch in this repo, open or closed. A fork's PR from a branch of the same
// name is not the factory's.
export async function findPull(gh: Gh, issue: number): Promise<number | null> {
  const owner = gh.repo.split('/')[0] ?? '';
  const list = rows(await gh.call('GET', `/repos/${gh.repo}/pulls?state=all&head=${owner}:${encodeURIComponent(branchFor(issue))}&per_page=10`));
  return num(dig(list.find((p) => inRepo(dig(p, 'head', 'repo'), gh.repo)), 'number'));
}

// The PR's head branch, or null when the head is in another repo (a fork).
export async function pullBranch(gh: Gh, pr: number): Promise<string | null> {
  const p = await gh.call('GET', `/repos/${gh.repo}/pulls/${pr}`);
  return inRepo(dig(p, 'head', 'repo'), gh.repo) ? str(dig(p, 'head', 'ref')) : null;
}

// An open PR from the issue's factory branch in this repo: the one a build updates rather than opening a second.
export async function findOpenPull(gh: Gh, issue: number): Promise<number | null> {
  const owner = gh.repo.split('/')[0] ?? '';
  const list = rows(await gh.call('GET', `/repos/${gh.repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branchFor(issue))}&per_page=10`));
  return num(dig(list.find((p) => inRepo(dig(p, 'head', 'repo'), gh.repo)), 'number'));
}

// signed and attempt come from the body's signed footer, which snapshot.ts checks.
// GitHub works out whether an open PR conflicts in the background, after a push to it or its base, and says
// 'unknown' until then; asking starts the work. Right after a merge, the router run that the merge woke would
// otherwise read a PR the merge made conflicting as clean, and leave it to a sweep.
const MERGEABLE_TRIES = 5;
const MERGEABLE_WAIT_MS = 2000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function pullSnapshot(gh: Gh, pr: number, wait: (ms: number) => Promise<void> = sleep): Promise<Omit<PullSnapshot, 'signed' | 'attempt'> & { nodeId: string; body: string }> {
  let p = await gh.call('GET', `/repos/${gh.repo}/pulls/${pr}`);
  for (let i = 1; i < MERGEABLE_TRIES && dig(p, 'state') === 'open' && dig(p, 'mergeable_state') === 'unknown'; i++) {
    await wait(MERGEABLE_WAIT_MS);
    p = await gh.call('GET', `/repos/${gh.repo}/pulls/${pr}`);
  }
  // A rename lists its old path too: moving a file out of a risky directory changes that directory.
  const files = (await paged(gh, `/repos/${gh.repo}/pulls/${pr}/files`)).flatMap((f) => {
    const old = str(dig(f, 'previous_filename'));
    return old ? [str(dig(f, 'filename')), old] : [str(dig(f, 'filename'))];
  });
  return {
    number: pr,
    headSha: str(dig(p, 'head', 'sha')),
    open: dig(p, 'state') === 'open',
    base: str(dig(p, 'base', 'ref')),
    draft: dig(p, 'draft') === true,
    conflicting: dig(p, 'mergeable_state') === 'dirty',
    files,
    nodeId: str(dig(p, 'node_id')),
    body: str(dig(p, 'body')),
  };
}

// The stage run the router dispatched for this attempt, as the API returns it; null before GitHub has created it.
// The title names the attempt, and isStageRun checks what a title can't prove: this repo, a dispatch, the stage file.
export async function findRun(gh: Gh, workflow: RunWorkflow, issue: number, attempt: string): Promise<unknown> {
  const runs = rows(dig(await gh.call('GET', `/repos/${gh.repo}/actions/workflows/${STAGE_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=50`), 'workflow_runs'));
  return runs.find((x) => dig(x, 'display_title') === runTitle(workflow, issue, attempt) && isStageRun(x, gh.repo)) ?? null;
}

export async function getRun(gh: Gh, id: number): Promise<unknown> {
  return gh.call('GET', `/repos/${gh.repo}/actions/runs/${id}`);
}

export type Job = { name: string; conclusion: string | null; status: string };
export async function runJobs(gh: Gh, id: number): Promise<Job[]> {
  return rows(dig(await gh.call('GET', `/repos/${gh.repo}/actions/runs/${id}/jobs?per_page=100`), 'jobs')).map((j) => ({
    name: str(dig(j, 'name')),
    conclusion: str(dig(j, 'conclusion')) || null,
    status: str(dig(j, 'status')),
  }));
}

// A run that already finished can't be cancelled (409); that is what the caller wanted anyway.
export async function cancelRun(gh: Gh, id: number): Promise<void> {
  try {
    await gh.call('POST', `/repos/${gh.repo}/actions/runs/${id}/cancel`);
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 409)) throw err;
  }
}

export async function defaultBranch(gh: Gh): Promise<string> {
  return str(dig(await gh.call('GET', `/repos/${gh.repo}`), 'default_branch'));
}

// The commit a branch points at; null when the branch doesn't exist.
export async function branchHead(gh: Gh, branch: string): Promise<string | null> {
  try {
    return str(dig(await gh.call('GET', `/repos/${gh.repo}/git/ref/heads/${branch}`), 'object', 'sha')) || null;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

// A file on a given ref, decoded; null when it doesn't exist.
export async function readRepoFile(gh: Gh, path: string, ref: string): Promise<string | null> {
  try {
    const r = await gh.call('GET', `/repos/${gh.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    return Buffer.from(str(dig(r, 'content')), 'base64').toString('utf8');
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

// The login's role on the repo (read, triage, write, maintain, admin), or null without access.
export async function collaboratorRole(gh: Gh, login: string): Promise<string | null> {
  try {
    return str(dig(await gh.call('GET', `/repos/${gh.repo}/collaborators/${encodeURIComponent(login)}/permission`), 'role_name')) || null;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

export type Edit = { editor: string | null; lastEditedAt: string | null };

// The comment, review and review-comment types; any other node is not something the factory reads.
const EDITABLE = ['IssueComment', 'PullRequestReview', 'PullRequestReviewComment'];
const EDITORS_QUERY = 'query($ids: [ID!]!) { nodes(ids: $ids) { __typename id ... on Comment { editor { login __typename } lastEditedAt } } }';

// Who last edited each comment, by node id. REST shows only the author, and anyone with write access can
// edit a comment. GraphQL names a bot without the "[bot]" REST adds, so it is added back here. Ids
// that were not found are missing from the map: callers treat them as edited by someone unknown.
export async function commentEditors(gh: Gh, nodeIds: readonly string[]): Promise<Map<string, Edit>> {
  const ids = [...new Set(nodeIds.filter((id) => id !== ''))];
  const out = new Map<string, Edit>();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await gh.call('POST', '/graphql', { query: EDITORS_QUERY, variables: { ids: ids.slice(i, i + 100) } });
    const nodes = dig(res, 'data', 'nodes');
    if (!Array.isArray(nodes)) throw new Error(`comment editor lookup failed: ${JSON.stringify(dig(res, 'errors'))}`);
    for (const n of nodes) {
      const id = str(dig(n, 'id'));
      if (!id || !EDITABLE.includes(str(dig(n, '__typename')))) continue;
      const login = str(dig(n, 'editor', 'login'));
      const bot = dig(n, 'editor', '__typename') === 'Bot' && !login.endsWith('[bot]');
      out.set(id, { editor: login ? `${login}${bot ? '[bot]' : ''}` : null, lastEditedAt: str(dig(n, 'lastEditedAt')) || null });
    }
  }
  return out;
}

export async function createComment(gh: Gh, issue: number, body: string): Promise<number | null> {
  return num(dig(await gh.call('POST', `/repos/${gh.repo}/issues/${issue}/comments`, { body }), 'id'));
}

export async function updateComment(gh: Gh, id: number, body: string): Promise<void> {
  await gh.call('PATCH', `/repos/${gh.repo}/issues/comments/${id}`, { body });
}

export async function addLabel(gh: Gh, issue: number, label: string): Promise<void> {
  await gh.call('POST', `/repos/${gh.repo}/issues/${issue}/labels`, { labels: [label] });
}

// A label already gone (removed by hand, or by an earlier run that failed later) counts as removed.
export async function removeLabel(gh: Gh, issue: number, label: string): Promise<void> {
  try {
    await gh.call('DELETE', `/repos/${gh.repo}/issues/${issue}/labels/${encodeURIComponent(label)}`);
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) throw err;
  }
}

// Moves the issue to one stage label (none for done) and returns its labels after. The new label goes on first: a
// run that fails between the calls leaves two stage labels, which the next save cleans up, rather than none, which
// would drop the issue out of the sweep (loadAll finds issues by their stage label).
export async function setStageLabel(gh: Gh, issue: number, have: readonly string[], want: string | null): Promise<string[]> {
  if (want && !have.includes(want)) await addLabel(gh, issue, want);
  for (const label of have) if (label.startsWith(LABEL_PREFIX) && label !== want) await removeLabel(gh, issue, label);
  return [...have.filter((x) => !x.startsWith(LABEL_PREFIX)), ...(want ? [want] : [])];
}

// ref is the default branch: the caller workflow, and so the factory code it pins, always comes from there.
export async function dispatchStage(gh: Gh, workflow: RunWorkflow, issue: number, attempt: string, ref: string): Promise<void> {
  await gh.call('POST', `/repos/${gh.repo}/actions/workflows/${STAGE_WORKFLOW_FILE}/dispatches`, { ref, inputs: { stage: workflow, issue: String(issue), attempt } });
}

export async function createPull(gh: Gh, p: { title: string; body: string; head: string; base: string }): Promise<number | null> {
  return num(dig(await gh.call('POST', `/repos/${gh.repo}/pulls`, { ...p, draft: true }), 'number'));
}

export async function updatePull(gh: Gh, pr: number, p: { title: string; body: string }): Promise<void> {
  await gh.call('PATCH', `/repos/${gh.repo}/pulls/${pr}`, p);
}

// commit_id ties the review to the commit the reviewer read, whatever the PR head is by now.
export async function postReview(gh: Gh, pr: number, body: string, commitId: string): Promise<void> {
  await gh.call('POST', `/repos/${gh.repo}/pulls/${pr}/reviews`, { event: 'COMMENT', body, commit_id: commitId });
}

export async function markReady(gh: Gh, nodeId: string): Promise<void> {
  const res = await gh.call('POST', '/graphql', {
    query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }',
    variables: { id: nodeId },
  });
  if (dig(res, 'errors') !== undefined) throw new Error(`markPullRequestReadyForReview failed: ${JSON.stringify(dig(res, 'errors'))}`);
}

export async function requestReview(gh: Gh, pr: number, login: string): Promise<void> {
  await gh.call('POST', `/repos/${gh.repo}/pulls/${pr}/requested_reviewers`, { reviewers: [login] });
}
