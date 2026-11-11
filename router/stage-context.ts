// CLI for the stage workflow: writes the stage's context to <outDir>/context.md, for review and fix the PR head the
// router checked to <outDir>/head-sha, and, for a CI fix round, the id of the failed CI run to <outDir>/ci-run-id. Runs from main's checkout, before the job switches to the PR branch, so a
// branch cannot change what its own agents are told.
// Usage: node --no-warnings factory/stage-context.ts <build|review|fix> <issue> <outDir>
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, FACTORY_BOT_LOGIN.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factoryBotLogin } from './config.ts';
import { buildContext, ciRunId, contextLookups, gatedHead } from './context.ts';
import { client, commentEditors, listComments, listReviewComments, listReviews } from './github.ts';
import { stateCandidate, stateFrom } from './snapshot.ts';
import { errorText, oneOf } from './util.ts';

async function main(): Promise<void> {
  const [stage, issueArg, outDir] = process.argv.slice(2);
  if (!oneOf(['build', 'review', 'fix'] as const, stage) || !outDir) throw new Error('usage: stage-context.ts <build|review|fix> <issue> <outDir>');
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) throw new Error(`not an issue number: ${issueArg}`);
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY must be set');
  const bot = factoryBotLogin();
  const gh = client(token, repo);

  const comments = await listComments(gh, issue);
  // The PR comes from the state comment before its edits are checked, so one lookup covers both threads.
  const candidate = stateCandidate(comments);
  if (!candidate) throw new Error(`Issue #${issue} has no factory state`);
  const pr = candidate.state.pr;
  const [reviews, prComments, prConversation] = pr ? await Promise.all([listReviews(gh, pr), listReviewComments(gh, pr), listComments(gh, pr)]) : [[], [], []];
  const threads = { bot, state: candidate.state, comments, reviews, prComments, prConversation };
  const edits = await commentEditors(gh, [candidate.comment.nodeId, ...contextLookups(threads)]);
  const found = stateFrom(comments, edits);
  if (!found) throw new Error(`Issue #${issue}: the factory state comment was edited by someone other than the router`);

  const head = gatedHead(found.state, stage);
  mkdirSync(outDir, { recursive: true });
  // Files left from an earlier run (a local one) must not stand in for this round's.
  for (const f of ['ci-run-id', 'head-sha']) rmSync(join(outDir, f), { force: true });
  writeFileSync(join(outDir, 'context.md'), buildContext({ ...threads, state: found.state, stage, issue, edits }));
  if (head !== null) writeFileSync(join(outDir, 'head-sha'), `${head}\n`);
  if (stage === 'fix' && found.state.fixReason === 'ci') {
    const id = ciRunId(found.state, repo);
    // Without a recorded run the fixer works without the log; picking a run by branch name could pick a fork's.
    if (id === null) process.stderr.write(`Issue #${issue}: no CI run recorded for this fix round; ci-run-id not written\n`);
    else writeFileSync(join(outDir, 'ci-run-id'), `${id}\n`);
  }
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});
