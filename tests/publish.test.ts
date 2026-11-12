// The publish job's promises, without a network: nothing is written unless every output checks out, nothing is
// written once the attempt is no longer current, and running it twice writes nothing twice.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractError, type Git } from '../router/contract.ts';
import type { Gh } from '../router/github.ts';
import { dig, str } from '../router/json.ts';
import { type FactoryState, renderState } from '../router/markers.ts';
import { collect, type Deps, type Files, inputFromEnv, type PublishInput, publish, type Write } from '../router/publish.ts';
import { sign, verify } from '../router/sign.ts';

const KEY = 'k'.repeat(64);
const BOT = 'github-actions[bot]';
const A = 'mhs1abc';
const SHA = (c: string) => c.repeat(40);
const BRIEF = '<!-- factory:brief v1 -->\n## Agent Brief\n\n**Touches:**\n- `docs/a.md`';

const input = (stage: PublishInput['stage'], extra: Partial<PublishInput> = {}): PublishInput => ({
  stage,
  issue: 7,
  attempt: A,
  baseSha: SHA('b'),
  branchSha: null,
  gatedSha: null,
  pr: null,
  fixReason: null,
  defaultBranch: 'main',
  ...extra,
});

const files = (content: Record<string, string>): Files => ({
  path: (name) => `/out/${name}`,
  size: (name) => content[name]?.length ?? 0,
  read: (name) => {
    const v = content[name];
    if (v === undefined) throw new ContractError(`the agent did not write .factory/out/${name}`);
    return v;
  },
});

// A git that accepts any bundle and reports `tip` as its head; it records every command.
function fakeGit(tip: string, remote = '') {
  const calls: string[][] = [];
  const git: Git = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return tip;
    if (args[0] === 'ls-remote') return remote ? `${remote}\trefs/heads/factory/issue-7` : '';
    return '';
  };
  return { git, calls, pushes: () => calls.filter((c) => c[0] === 'push') };
}

// A GitHub with one issue thread, one PR thread and one list of reviews. Records every write.
function fakeGh(state: FactoryState | null, opts: { openPull?: number } = {}) {
  const threads = new Map<number, { id: number; node_id: string; user: { login: string }; body: string; created_at: string }[]>();
  const reviews: { node_id: string; user: { login: string }; body: string; submitted_at: string; state: string }[] = [];
  const writes: string[] = [];
  let id = 100;
  const post = (n: number, body: string) => threads.set(n, [...(threads.get(n) ?? []), { id: id++, node_id: `n${id}`, user: { login: BOT }, body, created_at: '2026-11-10T10:00:00Z' }]);
  if (state) post(7, sign(KEY, 7, 'state', renderState(state)));
  const gh: Gh = {
    repo: 'o/r',
    call: async (method, path, body) => {
      const comments = /\/issues\/(\d+)\/comments/.exec(path);
      if (comments && method === 'GET') return path.includes('page=1') ? (threads.get(Number(comments[1])) ?? []) : [];
      if (path.includes('/reviews') && method === 'GET') return path.includes('page=1') ? reviews : [];
      if (path.includes('/pulls?state=open')) return opts.openPull ? [{ number: opts.openPull, head: { repo: { full_name: 'o/r' } } }] : [];
      if (method === 'GET') throw new Error(`unexpected read ${path}`);
      writes.push(`${method} ${path}`);
      if (comments) post(Number(comments[1]), str(dig(body, 'body')));
      if (path.includes('/reviews')) reviews.push({ node_id: 'r', user: { login: BOT }, body: str(dig(body, 'body')), submitted_at: '2026-11-10T10:00:00Z', state: 'COMMENTED' });
      return { id: 1, number: 51 };
    },
  };
  return { gh, writes, threads, reviews, setState: (s: FactoryState) => post(7, sign(KEY, 7, 'state', renderState(s))) };
}

const state = (stage: FactoryState['stage'], extra: Partial<FactoryState> = {}): FactoryState => ({ stage, since: '2026-11-10T09:00:00.000Z', round: 0, attempts: 0, runs: [], attempt: A, ...extra });
const deps = (gh: Gh, git: Git, paused = false): Deps => ({ gh, git, key: KEY, paused, log: () => {} });

test('a plan publishes a signed brief that names its attempt, then the label', async () => {
  const w = collect(input('plan'), KEY, files({ outcome: 'ready-for-agent', 'comment.md': BRIEF }), fakeGit('').git);
  assert.deepEqual(w.map((x) => x.kind), ['comment', 'label']);
  const first = w[0];
  assert.ok(first?.kind === 'comment' && verify(KEY, 7, 'brief', first.body));
  assert.match(first.kind === 'comment' ? first.body : '', /<!-- factory:attempt mhs1abc -->\n<!-- factory:sig /);
  const g = fakeGh(state('planning'));
  assert.equal(await publish(input('plan'), w, deps(g.gh, fakeGit('').git)), 'done');
  assert.deepEqual(g.writes, ['POST /repos/o/r/issues/7/comments', 'POST /repos/o/r/issues/7/labels']);
});

test('malformed output makes zero remote writes, whichever file is wrong', () => {
  const git = fakeGit(SHA('c'));
  const good = { 'pr.md': 'Add a thing\n\nBody.', 'branch.bundle': 'x' };
  const cases: [PublishInput, Record<string, string>, RegExp][] = [
    [input('plan'), { outcome: 'ship-it', 'comment.md': BRIEF }, /outcome/],
    [input('plan'), { outcome: 'ready-for-agent' }, /comment\.md/],
    [input('build'), { 'branch.bundle': 'x' }, /pr\.md/],
    [input('build'), { ...good, 'pr.md': '\nno title' }, /title/],
    [input('build'), { ...good, 'pr.md': 'Title\n\n<!-- factory:sig 00000000.00 -->' }, /factory marker/],
    [input('review', { pr: 51, gatedSha: SHA('a') }), { 'review.md': 'LGTM' }, /marker/],
    [input('review'), { 'review.md': '<!-- factory:review {"blocking":0,"nits":0} -->' }, /no PR/],
    [input('fix', { pr: 51, gatedSha: SHA('a') }), { 'branch.bundle': 'x' }, /fix\.md/],
    [input('fix', { pr: 51, gatedSha: SHA('a') }), { 'fix.md': '  ', 'branch.bundle': 'x' }, /empty/],
  ];
  for (const [i, content, why] of cases) assert.throws(() => collect(i, KEY, files(content), git.git), why);
  // collect never touches the remote: it only verifies and imports the bundle.
  assert.deepEqual(git.pushes(), []);
  assert.ok(git.calls.every((c) => !c.includes('origin')));
});

test('a bad bundle fails before the text that came with it is published', () => {
  const git: Git = (args) => {
    if (args[0] === 'bundle') throw new Error('bad bundle');
    return '';
  };
  assert.throws(() => collect(input('build'), KEY, files({ 'pr.md': 'Title\n\nBody.', 'branch.bundle': 'x' }), git), /does not verify/);
});

test('publication after /stop: a run whose attempt is no longer current writes nothing', async () => {
  const w = collect(input('build'), KEY, files({ 'pr.md': 'Add a thing\n\nBody.', 'branch.bundle': 'x' }), fakeGit(SHA('c')).git);
  for (const now of [state('blocked', { blockedFrom: 'building', blockedFor: 'stop', attempt: undefined }), state('building', { attempt: 'newer1' }), state('ci'), null]) {
    const g = fakeGh(now);
    const git = fakeGit(SHA('c'));
    assert.equal(await publish(input('build'), w, deps(g.gh, git.git)), 'stopped');
    assert.deepEqual(g.writes, []);
    assert.deepEqual(git.pushes(), []);
  }
});

test('a /stop that lands between two writes stops before the second', async () => {
  const w = collect(input('build'), KEY, files({ 'pr.md': 'Add a thing\n\nBody.', 'branch.bundle': 'x' }), fakeGit(SHA('c')).git);
  const g = fakeGh(state('building'));
  const base = fakeGit(SHA('c'));
  const git: Git = (args) => {
    const out = base.git(args);
    // The maintainer's /stop is processed while the push is in flight.
    if (args[0] === 'push') g.setState(state('blocked', { blockedFrom: 'building', blockedFor: 'stop', attempt: undefined }));
    return out;
  };
  assert.equal(await publish(input('build'), w, deps(g.gh, git)), 'stopped');
  assert.equal(base.pushes().length, 1, 'the push already in flight completes');
  assert.deepEqual(g.writes, [], 'the PR is never opened');
});

test('a paused factory writes nothing', async () => {
  const w = collect(input('plan'), KEY, files({ outcome: 'needs-info', 'comment.md': 'Which browser?' }), fakeGit('').git);
  const g = fakeGh(state('planning'));
  assert.equal(await publish(input('plan'), w, deps(g.gh, fakeGit('').git, true)), 'stopped');
  assert.deepEqual(g.writes, []);
});

test('build pushes with a lease on the head prepare saw, or on the branch not existing', async () => {
  const run = async (branchSha: string | null) => {
    const i = input('build', { branchSha });
    const git = fakeGit(SHA('c'), branchSha ?? '');
    await publish(i, collect(i, KEY, files({ 'pr.md': 'Add a thing\n\nBody.', 'branch.bundle': 'x' }), git.git), deps(fakeGh(state('building')).gh, git.git));
    return git.pushes()[0];
  };
  assert.deepEqual(await run(null), ['push', '-q', '--force-with-lease=refs/heads/factory/issue-7:', 'origin', `${SHA('c')}:refs/heads/factory/issue-7`]);
  assert.deepEqual(await run(SHA('d')), ['push', '-q', `--force-with-lease=refs/heads/factory/issue-7:${SHA('d')}`, 'origin', `${SHA('c')}:refs/heads/factory/issue-7`]);
});

test('a fix builds on the gated head, a rebase on the default branch, and both lease on the gated head', () => {
  const content = { 'fix.md': 'Fixed the null check.', 'branch.bundle': 'x' };
  const bases = (fixReason: PublishInput['fixReason']) => {
    const git = fakeGit(SHA('c'));
    const w = collect(input('fix', { pr: 51, gatedSha: SHA('a'), fixReason }), KEY, files(content), git.git);
    const push = w.find((x): x is Extract<Write, { kind: 'push' }> => x.kind === 'push');
    return { base: git.calls.find((c) => c[0] === 'merge-base')?.[2], expect: push?.expect };
  };
  assert.deepEqual(bases('review'), { base: SHA('a'), expect: SHA('a') });
  assert.deepEqual(bases('rebase'), { base: SHA('b'), expect: SHA('a') });
});

test('a review is stamped with the commit prepare recorded, whatever the agent wrote, and posted on that commit', async () => {
  const i = input('review', { pr: 51, gatedSha: SHA('a') });
  const text = `<!-- factory:review {"blocking":0,"nits":1,"sha":"${SHA('f')}","attempt":"forged"} -->\n## Standards\nFine.`;
  const w = collect(i, KEY, files({ 'review.md': text }), fakeGit('').git);
  const review = w[0];
  assert.ok(review?.kind === 'review');
  assert.equal(review.sha, SHA('a'));
  assert.match(review.body, new RegExp(`"sha":"${SHA('a')}","attempt":"${A}"`));
  assert.doesNotMatch(review.body, /forged/);
  assert.ok(verify(KEY, 7, 'review', review.body));
  const g = fakeGh(state('in-review'));
  await publish(i, w, deps(g.gh, fakeGit('').git));
  assert.deepEqual(g.writes, ['POST /repos/o/r/pulls/51/reviews']);
});

test('running the job again for the same attempt writes nothing twice', async () => {
  const build = input('build');
  const w = collect(build, KEY, files({ 'pr.md': 'Add a thing\n\nBody.', 'branch.bundle': 'x' }), fakeGit(SHA('c')).git);
  // Second run: the branch already has the tip and the PR is open, so the push is skipped and the PR updated.
  const g = fakeGh(state('building'), { openPull: 51 });
  const git = fakeGit(SHA('c'), SHA('c'));
  assert.equal(await publish(build, w, deps(g.gh, git.git)), 'done');
  assert.deepEqual(git.pushes(), []);
  assert.deepEqual(g.writes, ['PATCH /repos/o/r/pulls/51']);

  const plan = input('plan');
  const pw = collect(plan, KEY, files({ outcome: 'ready-for-agent', 'comment.md': BRIEF }), fakeGit('').git);
  const p = fakeGh(state('planning'));
  await publish(plan, pw, deps(p.gh, fakeGit('').git));
  await publish(plan, pw, deps(p.gh, fakeGit('').git));
  assert.equal(p.writes.filter((x) => x.endsWith('/comments')).length, 1);

  const review = input('review', { pr: 51, gatedSha: SHA('a') });
  const rw = collect(review, KEY, files({ 'review.md': '<!-- factory:review {"blocking":0,"nits":0} -->\nFine.' }), fakeGit('').git);
  const r = fakeGh(state('in-review'));
  await publish(review, rw, deps(r.gh, fakeGit('').git));
  await publish(review, rw, deps(r.gh, fakeGit('').git));
  assert.equal(r.writes.length, 1);
});

test('the PR body closes its issue, names the attempt, and is inert otherwise', () => {
  const w = collect(input('build'), KEY, files({ 'pr.md': 'Add a thing\n\nThanks @alice. Fixes #99.', 'branch.bundle': 'x' }), fakeGit(SHA('c')).git);
  const pull = w.find((x): x is Extract<Write, { kind: 'pull' }> => x.kind === 'pull');
  assert.ok(pull && verify(KEY, 7, 'pr', pull.body));
  assert.match(pull.body, /\n\nCloses #7\n<!-- factory:attempt mhs1abc -->/);
  assert.doesNotMatch(pull.body, /@alice|Fixes #99/);
});

test('the job inputs must be well-formed', () => {
  const env = { STAGE: 'fix', ISSUE: '7', ATTEMPT: A, BASE_SHA: SHA('b'), BRANCH_SHA: '', GATED_SHA: SHA('a'), PR: '51', FIX_REASON: 'rebase', DEFAULT_BRANCH: 'main' };
  assert.deepEqual(inputFromEnv(env), { stage: 'fix', issue: 7, attempt: A, baseSha: SHA('b'), branchSha: null, gatedSha: SHA('a'), pr: 51, fixReason: 'rebase', defaultBranch: 'main' });
  assert.throws(() => inputFromEnv({ ...env, STAGE: 'verify' }), /STAGE/);
  assert.throws(() => inputFromEnv({ ...env, ATTEMPT: 'x y' }), /ATTEMPT/);
  assert.throws(() => inputFromEnv({ ...env, BASE_SHA: 'main' }), /BASE_SHA/);
  assert.throws(() => inputFromEnv({ ...env, GATED_SHA: 'HEAD' }), /GATED_SHA/);
});
