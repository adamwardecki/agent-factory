import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  client,
  commentEditors,
  findPull,
  type Gh,
  GitHubError,
  latestCiRun,
  latestLabeler,
  latestStageRun,
  listComments,
  listReviews,
  pullBranch,
  pullSnapshot,
  removeLabel,
  setStageLabel,
} from '../router/github.ts';
import { dig, rows } from '../router/json.ts';

test('pullSnapshot lists both sides of a rename', async () => {
  const gh: Gh = {
    repo: 'o/r',
    call: async (_method, path) => {
      if (path.startsWith('/repos/o/r/pulls/51/files')) {
        return [{ filename: 'docs/gates.ts', previous_filename: 'plugin/hooks/gates.ts', status: 'renamed' }, { filename: 'docs/setup.md', status: 'modified' }];
      }
      return { head: { sha: 'abc' }, state: 'open', mergeable_state: 'clean', node_id: 'PR_1' };
    },
  };
  const snap = await pullSnapshot(gh, 51);
  assert.deepEqual(snap.files, ['docs/gates.ts', 'plugin/hooks/gates.ts', 'docs/setup.md']);
});

test('latestLabeler reads the newest labelling of that label across timeline pages', async () => {
  const labeled = (name: string, login: string, at: string) => ({ event: 'labeled', label: { name }, actor: { login }, created_at: at });
  const first = [
    labeled('agent:queued', 'someone', '2026-11-09T09:00:00Z'),
    ...Array.from({ length: 99 }, () => ({ event: 'commented', actor: { login: 'x' }, created_at: '2026-11-09T09:30:00Z' })),
  ];
  const second = [labeled('agent:queued', 'adamwardecki', '2026-11-09T10:00:00Z'), labeled('bug', 'factory-app[bot]', '2026-11-09T11:00:00Z'), { event: 'unlabeled', label: { name: 'agent:queued' }, actor: { login: 'y' }, created_at: '2026-11-09T11:30:00Z' }];
  const gh: Gh = {
    repo: 'o/r',
    call: async (_method, path) => {
      assert.match(path, /^\/repos\/o\/r\/issues\/7\/timeline\?/);
      return path.endsWith('page=1') ? first : second;
    },
  };
  assert.deepEqual(await latestLabeler(gh, 7, 'agent:queued'), { login: 'adamwardecki', at: '2026-11-09T10:00:00Z' });
  assert.equal(await latestLabeler(gh, 7, 'agent:ready'), null);
});

type Call = { method: string; path: string; body?: unknown };
function fake(reply: (c: Call) => unknown): Gh & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    repo: 'o/r',
    calls,
    call: async (method, path, body) => {
      const c = { method, path, body };
      calls.push(c);
      return reply(c);
    },
  };
}

test('pullSnapshot reads whether the PR is a draft', async () => {
  const gh = fake((c) => (c.path.includes('/files') ? [] : { head: { sha: 'abc' }, state: 'open', draft: false, node_id: 'PR_1' }));
  assert.equal((await pullSnapshot(gh, 51)).draft, false);
  const draft = fake((c) => (c.path.includes('/files') ? [] : { head: { sha: 'abc' }, state: 'open', draft: true }));
  assert.equal((await pullSnapshot(draft, 51)).draft, true);
});

test('comments and reviews carry their GraphQL node id', async () => {
  const gh = fake((c) => (c.path.includes('/reviews') ? [{ id: 2, node_id: 'PRR_2', user: { login: 'a' }, body: 'b', state: 'COMMENTED' }] : [{ id: 1, node_id: 'IC_1', user: { login: 'a' }, body: 'b' }]));
  assert.equal((await listComments(gh, 7))[0]?.nodeId, 'IC_1');
  assert.equal((await listReviews(gh, 51))[0]?.nodeId, 'PRR_2');
});

const pull = (n: number, repo: string | null) => ({ number: n, head: { ref: 'factory/issue-7', repo: repo === null ? null : { full_name: repo } } });

test('findPull and pullBranch only return PRs whose head is in this repo', async () => {
  assert.equal(await findPull(fake(() => [pull(60, 'mallory/r'), pull(51, 'o/r')]), 7), 51);
  assert.equal(await findPull(fake(() => [pull(60, 'mallory/r'), pull(61, null)]), 7), null);
  assert.equal(await pullBranch(fake(() => pull(51, 'o/r')), 51), 'factory/issue-7');
  assert.equal(await pullBranch(fake(() => pull(60, 'mallory/r')), 60), null);
  assert.equal(await pullBranch(fake(() => pull(61, null)), 61), null);
});

const wfRun = (id: number, extra: Record<string, unknown>) => ({
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  head_sha: 'sha-1',
  status: 'completed',
  conclusion: 'success',
  head_repository: { full_name: 'o/r' },
  ...extra,
});

test('latestStageRun skips runs that were not dispatched from the stage workflow in this repo', async () => {
  const good = { display_title: 'factory-build #7', event: 'workflow_dispatch', path: '.github/workflows/factory-build.yml' };
  const gh = fake(() => ({
    workflow_runs: [
      wfRun(1, { ...good, head_repository: { full_name: 'mallory/r' } }),
      wfRun(2, { ...good, event: 'pull_request' }),
      wfRun(3, { ...good, path: '.github/workflows/x.yml' }),
      wfRun(4, { ...good, display_title: 'factory-build #8' }),
      wfRun(5, good),
    ],
  }));
  assert.equal((await latestStageRun(gh, 'build', 7))?.url, 'https://github.com/o/r/actions/runs/5');
  assert.equal(await latestStageRun(fake(() => ({ workflow_runs: [wfRun(1, { ...good, event: 'push' })] })), 'build', 7), null);
});

test('latestCiRun skips a fork\'s run on the same commit and runs on another branch', async () => {
  const gh = fake(() => ({
    workflow_runs: [
      wfRun(1, { head_branch: 'factory/issue-7', head_repository: { full_name: 'mallory/r' } }),
      wfRun(2, { head_branch: 'factory/issue-8' }),
      wfRun(3, { head_branch: 'factory/issue-7' }),
    ],
  }));
  assert.equal((await latestCiRun(gh, 7, 'sha-1'))?.url, 'https://github.com/o/r/actions/runs/3');
  assert.match(gh.calls[0]?.path ?? '', /head_sha=sha-1/);
});

test('commentEditors looks up every id in batches and names bots as REST does', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `IC_${i}`);
  const gh = fake((c) => {
    const vars = rows(dig(c.body, 'variables', 'ids')).filter((x): x is string => typeof x === 'string');
    return {
      data: {
        nodes: vars.map((id) => {
          if (id === 'IC_0') return { __typename: 'IssueComment', id, editor: null, lastEditedAt: null };
          if (id === 'IC_1') return { __typename: 'IssueComment', id, editor: { login: 'github-actions', __typename: 'Bot' }, lastEditedAt: '2026-11-09T11:00:00Z' };
          if (id === 'IC_2') return { __typename: 'IssueComment', id, editor: { login: 'adamwardecki', __typename: 'User' }, lastEditedAt: '2026-11-09T11:00:00Z' };
          if (id === 'IC_3') return null;
          if (id === 'IC_4') return { __typename: 'Issue', id };
          return { __typename: 'PullRequestReviewComment', id, editor: null, lastEditedAt: null };
        }),
      },
    };
  });
  const edits = await commentEditors(gh, [...ids, 'IC_0', '']);
  assert.equal(gh.calls.length, 2);
  assert.ok(gh.calls.every((c) => c.method === 'POST' && c.path === '/graphql'));
  assert.deepEqual(edits.get('IC_0'), { editor: null, lastEditedAt: null });
  assert.deepEqual(edits.get('IC_1'), { editor: 'github-actions[bot]', lastEditedAt: '2026-11-09T11:00:00Z' });
  assert.deepEqual(edits.get('IC_2'), { editor: 'adamwardecki', lastEditedAt: '2026-11-09T11:00:00Z' });
  assert.equal(edits.has('IC_3'), false);
  assert.equal(edits.has('IC_4'), false);
  assert.equal(edits.size, 148);
  const none = fake(() => assert.fail('no call for no ids'));
  assert.equal((await commentEditors(none, [])).size, 0);
});

test('commentEditors fails when GraphQL returns no nodes', async () => {
  await assert.rejects(commentEditors(fake(() => ({ errors: [{ message: 'bad' }] })), ['IC_1']), /bad/);
});

test('removeLabel treats a label that is already gone as removed', async () => {
  await removeLabel(fake(() => { throw new GitHubError('gone', 404); }), 7, 'agent:ci');
  await assert.rejects(removeLabel(fake(() => { throw new GitHubError('down', 500); }), 7, 'agent:ci'), /down/);
});

test('setStageLabel adds the new stage label before removing the old ones', async () => {
  const gh = fake(() => undefined);
  const after = await setStageLabel(gh, 7, ['bug', 'agent:ci', 'agent:fixing'], 'agent:in-review');
  assert.deepEqual(gh.calls.map((c) => `${c.method} ${c.path}`), [
    'POST /repos/o/r/issues/7/labels',
    'DELETE /repos/o/r/issues/7/labels/agent%3Aci',
    'DELETE /repos/o/r/issues/7/labels/agent%3Afixing',
  ]);
  assert.deepEqual(after, ['bug', 'agent:in-review']);
  const done = fake(() => undefined);
  assert.deepEqual(await setStageLabel(done, 7, ['agent:ready'], null), []);
  assert.deepEqual(done.calls.map((c) => c.method), ['DELETE']);
  const same = fake(() => undefined);
  await setStageLabel(same, 7, ['agent:ci'], 'agent:ci');
  assert.equal(same.calls.length, 0);
});

test('a failed call throws a GitHubError with the HTTP status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Not Found', { status: 404 }));
  const err = await client('token', 'o/r').call('GET', '/repos/o/r').catch((e: unknown) => e);
  assert.ok(err instanceof GitHubError);
  assert.equal(err.status, 404);
});
