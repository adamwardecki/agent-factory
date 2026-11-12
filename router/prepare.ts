// CLI for the prepare job of every stage: runs where the signing key is but the agent isn't.
//   1. Refuses unless the issue's signed state is at this stage and this attempt. A stale dispatch stops here.
//   2. Writes the stage's immutable inputs as job outputs (to $GITHUB_OUTPUT). The publish job takes them from
//      there, not from an artifact: the agent job could overwrite an artifact, but not another job's outputs.
//   3. For build, review and fix, writes <outDir>/context.md, and <outDir>/ci-run-id for a fix round after red checks.
// Usage: node --no-warnings router/prepare.ts <plan|build|verify|review|fix> <issue> <attempt> <outDir>
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, FACTORY_SIGNING_KEY, FACTORY_AUTH_MODE, GITHUB_OUTPUT.

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stale } from './attempt.ts';
import { createAuthority } from './authority.ts';
import { ATTEMPT, branchFor, CONFIG_PATH, RUN_WORKFLOWS, type RunWorkflow } from './config.ts';
import { buildContext, ciRunId, gatedHead, noteCandidates } from './context.ts';
import { branchHead, client, collaboratorRole, commentEditors, defaultBranch, type Gh, listComments, listReviewComments, listReviews, readRepoFile } from './github.ts';
import type { FactoryState } from './markers.ts';
import { parseAuthMode, parseRepoConfig, type RepoConfig } from './repo-config.ts';
import { stateFrom } from './snapshot.ts';
import { allowedTools } from './tools.ts';
import { errorText, oneOf } from './util.ts';

export type Prepared = { workflow: RunWorkflow; attempt: string; defaultBranch: string; baseSha: string; branchSha: string | null; state: FactoryState };

// The job outputs. Every value is one line: commands were checked for that when factory.json was parsed, and the
// rest are SHAs, numbers and fixed words.
export function outputs(p: Prepared, config: RepoConfig): Record<string, string> {
  const gated = gatedHead(p.state, p.workflow);
  const c = config.commands;
  const checked = (o: Record<string, string>): Record<string, string> => {
    // Each output is one `name=value` line of $GITHUB_OUTPUT; a newline in a value would write another output.
    for (const [k, v] of Object.entries(o)) if (/[\r\n]/.test(v)) throw new Error(`the ${k} output has a line break`);
    return o;
  };
  const common = {
    attempt: p.attempt,
    'default-branch': p.defaultBranch,
    'base-sha': p.baseSha,
    'branch-sha': p.branchSha ?? '',
    'gated-sha': gated ?? '',
    pr: p.state.pr === undefined ? '' : String(p.state.pr),
    'fix-reason': p.workflow === 'fix' ? (p.state.fixReason ?? '') : '',
    node: config.toolchain.node ?? '',
    python: config.toolchain.python ?? '',
  };
  if (p.workflow === 'verify') return checked({ ...common, install: c.install ?? '', test: c.test, lint: c.lint ?? '', typecheck: c.typecheck ?? '' });
  const runsCode = p.workflow === 'build' || p.workflow === 'fix';
  return checked({
    ...common,
    model: config.models[p.workflow],
    'max-turns': String(config.maxTurns[p.workflow]),
    'allowed-tools': allowedTools(p.workflow, config).join(','),
    // The planner runs no code and reads the issue with gh, which the scrub would break.
    scrub: p.workflow === 'plan' ? '' : '1',
    install: runsCode ? (c.install ?? '') : '',
  });
}

async function context(gh: Gh, issue: number, key: string, p: Prepared, config: RepoConfig, comments: Awaited<ReturnType<typeof listComments>>): Promise<string | null> {
  if (p.workflow === 'plan' || p.workflow === 'verify') return null;
  const pr = p.state.pr;
  const [reviews, prComments, prConversation] = pr ? await Promise.all([listReviews(gh, pr), listReviewComments(gh, pr), listComments(gh, pr)]) : [[], [], []];
  const notes = noteCandidates({ reviews, prComments, prConversation });
  const edits = await commentEditors(gh, notes.map((n) => n.nodeId));
  // buildContext is synchronous; look every author and editor up first.
  const authority = createAuthority(config.roles, (login) => collaboratorRole(gh, login));
  for (const n of notes) await authority.check('queue', n.author);
  for (const e of edits.values()) if (e.editor) await authority.check('queue', e.editor);
  const gated = gatedHead(p.state, p.workflow);
  return buildContext({
    stage: p.workflow,
    issue,
    key,
    state: p.state,
    comments,
    reviews,
    prComments,
    prConversation,
    edits,
    mayNote: (l) => authority.known('queue', l),
    commands: config.commands,
    commits: {
      defaultBranch: p.defaultBranch,
      base: p.baseSha,
      head: gated,
      // A build and a rebase build on the default branch; any other fix builds on the head the router checked.
      bundleOn: p.workflow === 'review' ? null : p.workflow === 'build' || p.state.fixReason === 'rebase' ? p.baseSha : gated,
    },
    prSkill: config.prSkill,
  });
}

async function main(): Promise<void> {
  const [workflow, issueArg, attempt, outDir] = process.argv.slice(2);
  if (!oneOf(RUN_WORKFLOWS, workflow) || !attempt || !ATTEMPT.test(attempt) || !outDir) throw new Error('usage: prepare.ts <plan|build|verify|review|fix> <issue> <attempt> <outDir>');
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) throw new Error(`not an issue number: ${issueArg}`);
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, FACTORY_SIGNING_KEY: key, GITHUB_OUTPUT: outputFile } = process.env;
  if (!token || !repo || !key || !outputFile) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, FACTORY_SIGNING_KEY and GITHUB_OUTPUT must be set');
  const gh = client(token, repo);

  const comments = await listComments(gh, issue);
  const state = stateFrom(comments, issue, key).found?.state ?? null;
  const why = stale(state, workflow, attempt);
  if (why || !state) throw new Error(`Issue #${issue}: this run may not act: ${why}`);

  const ref = await defaultBranch(gh);
  const text = await readRepoFile(gh, CONFIG_PATH, ref);
  if (text === null) throw new Error(`${CONFIG_PATH} is missing on ${ref}`);
  const config = parseRepoConfig(JSON.parse(text), parseAuthMode(process.env.FACTORY_AUTH_MODE));
  const baseSha = await branchHead(gh, ref);
  if (!baseSha) throw new Error(`the default branch ${ref} has no head`);
  const p: Prepared = { workflow, attempt, defaultBranch: ref, baseSha, branchSha: await branchHead(gh, branchFor(issue)), state };

  appendFileSync(outputFile, Object.entries(outputs(p, config)).map(([k, v]) => `${k}=${v}\n`).join(''));
  mkdirSync(outDir, { recursive: true });
  for (const f of ['context.md', 'ci-run-id']) rmSync(join(outDir, f), { force: true });
  const md = await context(gh, issue, key, p, config, comments);
  if (md !== null) writeFileSync(join(outDir, 'context.md'), md);
  if (workflow === 'fix' && state.fixReason === 'ci') {
    const id = ciRunId(state, repo);
    if (id === null) process.stderr.write(`Issue #${issue}: no verify run recorded for this fix round; ci-run-id not written\n`);
    else writeFileSync(join(outDir, 'ci-run-id'), `${id}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(errorText(err));
    process.exit(1);
  });
}
