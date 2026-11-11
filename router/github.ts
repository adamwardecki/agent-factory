// A thin GitHub REST and GraphQL client for the factory. No retries: the sweep runs every 30 minutes and picks up
// whatever a failed run left behind.

import { branchFor, CI_WORKFLOW_FILE, LABEL_PREFIX, runTitle, type StageWorkflow, stageWorkflowFile } from './config.ts';
import type { PullSnapshot, RunSnapshot } from './decide.ts';
import { dig, inRepo, isCiRun, isStageRun, num, rows, runFrom, str } from './json.ts';

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

export async function pullSnapshot(gh: Gh, pr: number): Promise<PullSnapshot & { nodeId: string }> {
  const p = await gh.call('GET', `/repos/${gh.repo}/pulls/${pr}`);
  // A rename lists its old path too: moving a file out of a risky directory changes that directory.
  const files = (await paged(gh, `/repos/${gh.repo}/pulls/${pr}/files`)).flatMap((f) => {
    const old = str(dig(f, 'previous_filename'));
    return old ? [str(dig(f, 'filename')), old] : [str(dig(f, 'filename'))];
  });
  return {
    number: pr,
    headSha: str(dig(p, 'head', 'sha')),
    open: dig(p, 'state') === 'open',
    draft: dig(p, 'draft') === true,
    conflicting: dig(p, 'mergeable_state') === 'dirty',
    files,
    nodeId: str(dig(p, 'node_id')),
  };
}

// Checked as events.ts checks a workflow_run event, so the sweep cannot pick a run the event path would ignore.
export async function latestStageRun(gh: Gh, workflow: StageWorkflow, issue: number): Promise<RunSnapshot | null> {
  const runs = rows(dig(await gh.call('GET', `/repos/${gh.repo}/actions/workflows/${stageWorkflowFile(workflow)}/runs?event=workflow_dispatch&per_page=30`), 'workflow_runs'));
  const r = runs.find((x) => dig(x, 'display_title') === runTitle(workflow, issue) && isStageRun(x, workflow, gh.repo));
  return r ? runFrom(r, workflow) : null;
}

// A fork can push the same commit, and its PR's CI run then has the same head sha.
export async function latestCiRun(gh: Gh, issue: number, headSha: string): Promise<RunSnapshot | null> {
  const runs = rows(dig(await gh.call('GET', `/repos/${gh.repo}/actions/workflows/${CI_WORKFLOW_FILE}/runs?head_sha=${headSha}&per_page=20`), 'workflow_runs'));
  const r = runs.find((x) => isCiRun(x, gh.repo) && dig(x, 'head_branch') === branchFor(issue));
  return r ? runFrom(r, 'ci') : null;
}

export type Edit = { editor: string | null; lastEditedAt: string | null };

// The comment, review and review-comment types; any other node is not something the factory reads.
const EDITABLE = ['IssueComment', 'PullRequestReview', 'PullRequestReviewComment'];
const EDITORS_QUERY = 'query($ids: [ID!]!) { nodes(ids: $ids) { __typename id ... on Comment { editor { login __typename } lastEditedAt } } }';

// Who last edited each comment, by node id. REST shows only the author, and anyone with write access (the factory's
// App included) can edit a comment. GraphQL names a bot without the "[bot]" REST adds, so it is added back here. Ids
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

export async function dispatch(gh: Gh, workflow: StageWorkflow, issue: number): Promise<void> {
  await gh.call('POST', `/repos/${gh.repo}/actions/workflows/${stageWorkflowFile(workflow)}/dispatches`, { ref: 'main', inputs: { issue: String(issue) } });
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
