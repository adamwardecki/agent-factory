// The publish job: the only place a stage's output reaches GitHub. Two steps.
//   collect  local only: reads and checks every output file and the bundle against the stage's contract, and returns
//            the writes to make. If anything is wrong, nothing has been written.
//   publish  makes the writes in order. Immediately before each one it re-reads the signed state and stops if this
//            run is no longer the current attempt of its stage (a /stop, a block, a newer attempt) or the factory is
//            paused. Each write is idempotent for the attempt, so running the job again after a partial failure is
//            safe.
// Runs agent-factory code only; never the target repo's.
// Usage: node --no-warnings router/publish.ts
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, FACTORY_SIGNING_KEY, FACTORY_PAUSED, OUT_DIR (the agent's .factory/out),
// REPO_DIR (a full clone of the target repo), and the prepare job's outputs: STAGE, ISSUE, ATTEMPT, BASE_SHA,
// BRANCH_SHA, GATED_SHA, PR, FIX_REASON, DEFAULT_BRANCH.

import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { stale } from './attempt.ts';
import { ATTEMPT, branchFor, isPaused, ROUTER_LOGIN, STAGE_WORKFLOWS, type StageWorkflow } from './config.ts';
import { ContractError, checkBundle, checkPlan, checkReview, checkText, type Git, gitIn, inert, MAX_BUNDLE_BYTES, MAX_TEXT, splitPr } from './contract.ts';
import { addLabel, client, createComment, createPull, findOpenPull, type Gh, listComments, listReviews, postReview, updatePull } from './github.ts';
import { attemptOf, FIX_REASONS, type FixReason, parseReview, stampReview, withAttempt } from './markers.ts';
import { type SigKind, sign, verify } from './sign.ts';
import { stateFrom } from './snapshot.ts';
import { errorText, oneOf } from './util.ts';

// What the prepare job fixed before the agent ran. They arrive as job outputs, which the agent job can't change.
export type PublishInput = {
  stage: StageWorkflow;
  issue: number;
  attempt: string;
  baseSha: string; // the default branch's head when the stage started
  branchSha: string | null; // the factory branch's head then; null when the branch did not exist
  gatedSha: string | null; // the PR head the diff gate checked (review, fix)
  pr: number | null;
  fixReason: FixReason | null;
  defaultBranch: string;
};

// The agent's output directory.
export type Files = { read(name: string): string; size(name: string): number; path(name: string): string };

// The agent's output directory on disk. Only plain files count: an uploaded artifact could hold a symlink to
// anything on the runner, and a file is checked for size before it is read into memory.
export function fsFiles(dir: string): Files {
  const stat = (name: string) => {
    let st: Stats;
    try {
      st = lstatSync(join(dir, name));
    } catch {
      return null;
    }
    if (!st.isFile()) throw new ContractError(`.factory/out/${name} is not a regular file`);
    return st;
  };
  return {
    path: (name) => join(dir, name),
    size: (name) => stat(name)?.size ?? 0,
    read: (name) => {
      const st = stat(name);
      if (!st) throw new ContractError(`the agent did not write .factory/out/${name}`);
      // MAX_TEXT characters, at most four bytes each.
      if (st.size > MAX_TEXT * 4) throw new ContractError(`.factory/out/${name} is ${st.size} bytes, larger than the ${MAX_TEXT * 4} a text file may be`);
      return readFileSync(join(dir, name), 'utf8');
    },
  };
}

export type Write =
  | { kind: 'comment'; on: number; sig: SigKind; body: string }
  | { kind: 'label'; label: string }
  | { kind: 'push'; branch: string; tip: string; expect: string | null }
  | { kind: 'pull'; title: string; body: string; head: string; base: string }
  | { kind: 'review'; pr: number; body: string; sha: string };

const SHA = /^[0-9a-f]{40}$/;

function bundleTip(files: Files, git: Git, base: string): string {
  if (files.size('branch.bundle') > MAX_BUNDLE_BYTES) throw new ContractError(`branch.bundle is larger than ${MAX_BUNDLE_BYTES} bytes`);
  return checkBundle(git, files.path('branch.bundle'), base).tip;
}

// Everything the stage will write, or a ContractError. No network, no remote change.
export function collect(i: PublishInput, key: string, files: Files, git: Git): Write[] {
  const branch = branchFor(i.issue);
  const signed = (kind: SigKind, text: string) => sign(key, i.issue, kind, withAttempt(text, i.attempt));
  switch (i.stage) {
    case 'plan': {
      const plan = checkPlan(files.read('outcome'), files.read('comment.md'));
      const kind = plan.outcome === 'ready-for-agent' ? 'brief' : 'note';
      return [
        { kind: 'comment', on: i.issue, sig: kind, body: signed(kind, plan.comment) },
        { kind: 'label', label: plan.outcome },
      ];
    }
    case 'build': {
      const { title, body } = splitPr(files.read('pr.md'));
      const tip = bundleTip(files, git, i.baseSha);
      return [
        // The lease is on the head prepare saw: a retry must not replace commits someone pushed while the builder ran.
        { kind: 'push', branch, tip, expect: i.branchSha },
        { kind: 'pull', title, body: signed('pr', `${body}\n\nCloses #${i.issue}`), head: branch, base: i.defaultBranch },
      ];
    }
    case 'review': {
      if (i.pr === null || i.gatedSha === null) throw new ContractError('the review stage has no PR or reviewed commit recorded');
      // The reviewer wrote the counts; the commit it read and the attempt come from prepare, never from its text.
      const body = stampReview(checkReview(files.read('review.md')), i.gatedSha, i.attempt);
      if (body === null) throw new ContractError('the review must start with the factory review marker and whole counts');
      return [{ kind: 'review', pr: i.pr, body: sign(key, i.issue, 'review', body), sha: i.gatedSha }];
    }
    case 'fix': {
      if (i.pr === null || i.gatedSha === null) throw new ContractError('the fix stage has no PR or branch head recorded');
      const note = inert(checkText(files.read('fix.md'), 'fix.md'));
      // A fix builds on the head the router checked, unless it is a rebase onto the default branch.
      const tip = bundleTip(files, git, i.fixReason === 'rebase' ? i.baseSha : i.gatedSha);
      return [
        { kind: 'push', branch, tip, expect: i.gatedSha },
        { kind: 'comment', on: i.pr, sig: 'fix', body: signed('fix', note) },
      ];
    }
  }
}

export type Deps = { gh: Gh; git: Git; key: string; paused: boolean; log: (line: string) => void };

async function execute(w: Write, i: PublishInput, d: Deps): Promise<void> {
  const mine = (body: string, kind: SigKind) => verify(d.key, i.issue, kind, body);
  switch (w.kind) {
    case 'comment': {
      const have = await listComments(d.gh, w.on);
      if (have.some((c) => c.author === ROUTER_LOGIN && attemptOf(c.body) === i.attempt && mine(c.body, w.sig))) return d.log(`comment on #${w.on} already posted`);
      await createComment(d.gh, w.on, w.body);
      return;
    }
    case 'label':
      await addLabel(d.gh, i.issue, w.label);
      return;
    case 'push': {
      const remote = d.git(['ls-remote', 'origin', `refs/heads/${w.branch}`]).split(/\s/)[0] ?? '';
      if (remote === w.tip) return d.log(`${w.branch} is already at ${w.tip}`);
      // An empty expected value means the branch must not exist.
      d.git(['push', '-q', `--force-with-lease=refs/heads/${w.branch}:${w.expect ?? ''}`, 'origin', `${w.tip}:refs/heads/${w.branch}`]);
      return;
    }
    case 'pull': {
      const open = await findOpenPull(d.gh, i.issue);
      if (open === null) await createPull(d.gh, w);
      else await updatePull(d.gh, open, { title: w.title, body: w.body });
      return;
    }
    case 'review': {
      const have = await listReviews(d.gh, w.pr);
      if (have.some((r) => r.author === ROUTER_LOGIN && parseReview(r.body)?.attempt === i.attempt && mine(r.body, 'review'))) return d.log(`review on #${w.pr} already posted`);
      await postReview(d.gh, w.pr, w.body, w.sha);
      return;
    }
  }
}

// 'stopped' when the run lost its authority part-way: what was written before stays, and is inert (it names an
// attempt the router no longer accepts).
export async function publish(i: PublishInput, writes: readonly Write[], d: Deps): Promise<'done' | 'stopped'> {
  for (const w of writes) {
    const why = d.paused ? 'the factory is paused' : stale(stateFrom(await listComments(d.gh, i.issue), i.issue, d.key).found?.state ?? null, i.stage, i.attempt);
    if (why) {
      d.log(`Not writing (${w.kind}): ${why}.`);
      return 'stopped';
    }
    await execute(w, i, d);
  }
  return 'done';
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function inputFromEnv(env: NodeJS.ProcessEnv): PublishInput {
  const stage = env.STAGE;
  const issue = Number(env.ISSUE);
  const attempt = env.ATTEMPT ?? '';
  if (!oneOf(STAGE_WORKFLOWS, stage) || !Number.isInteger(issue) || issue <= 0 || !ATTEMPT.test(attempt)) throw new Error('STAGE, ISSUE and ATTEMPT must name an agent stage, an issue number and an attempt');
  const sha = (name: string, required: boolean): string | null => {
    const v = env[name] ?? '';
    if (v === '' && !required) return null;
    if (!SHA.test(v)) throw new Error(`${name} must be a commit SHA`);
    return v;
  };
  const pr = env.PR ? Number(env.PR) : null;
  if (pr !== null && (!Number.isInteger(pr) || pr <= 0)) throw new Error('PR must be a pull request number');
  const fixReason = env.FIX_REASON ?? '';
  if (!env.DEFAULT_BRANCH) throw new Error('DEFAULT_BRANCH is not set');
  return {
    stage,
    issue,
    attempt,
    baseSha: sha('BASE_SHA', true) ?? '',
    branchSha: sha('BRANCH_SHA', false),
    gatedSha: sha('GATED_SHA', false),
    pr,
    fixReason: oneOf(FIX_REASONS, fixReason) ? fixReason : null,
    defaultBranch: env.DEFAULT_BRANCH,
  };
}

async function main(): Promise<void> {
  const input = inputFromEnv(process.env);
  const out = need('OUT_DIR');
  const key = need('FACTORY_SIGNING_KEY');
  const files = fsFiles(out);
  const git = gitIn(need('REPO_DIR'));
  const writes = collect(input, key, files, git);
  const d: Deps = { gh: client(need('GITHUB_TOKEN'), need('GITHUB_REPOSITORY')), git, key, paused: isPaused(process.env.FACTORY_PAUSED), log: (line) => console.log(line) };
  console.log(`${input.stage} #${input.issue} ${input.attempt}: ${await publish(input, writes, d)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof ContractError ? `Contract: ${err.message}` : errorText(err));
    process.exit(1);
  });
}
