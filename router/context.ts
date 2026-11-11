// Builds .factory/context.md: the only inputs the build, review and fix agents work from. It includes the brief
// (by id, only from the factory bot, and only as posted), the factory review, and the maintainer's comments. Nothing
// else from the issue or PR threads goes in: those are untrusted text on a public repo.

import { branchFor, MAINTAINER } from './config.ts';
import type { Comment, Review } from './github.ts';
import { type FactoryState, parseCommand, parseReview } from './markers.ts';
import { type Edits, editedOnlyBy } from './snapshot.ts';

export type ContextInput = {
  stage: 'build' | 'review' | 'fix';
  issue: number;
  bot: string;
  state: FactoryState;
  comments: readonly Comment[]; // the issue thread
  reviews: readonly Review[];
  prComments: readonly Comment[]; // the PR's review comments, on lines of the diff
  prConversation: readonly Comment[]; // the PR's conversation comments
  edits: Edits; // who last edited each of the comments above (commentEditors)
};

// The maintainer's notes on the PR. Commands are for the router, not the fixer. Anyone with write access (the
// factory's App included) can edit a comment, so a note counts only as the maintainer last left it.
function maintainerNotes(i: Omit<ContextInput, 'stage' | 'issue' | 'edits'>): (Comment | Review)[] {
  const mine = <T extends { author: string; body: string }>(xs: readonly T[]) => xs.filter((x) => x.author === MAINTAINER && x.body.trim() !== '');
  return [...mine(i.reviews), ...mine(i.prComments), ...mine(i.prConversation).filter((c) => parseCommand(c.body) === null)];
}

// The node ids buildContext needs edit history for: the brief and the maintainer's notes. stage-context.ts adds the
// state comment's, so one lookup covers all of them.
export function contextLookups(i: Omit<ContextInput, 'stage' | 'issue' | 'edits'>): string[] {
  const brief = i.comments.find((c) => c.id === i.state.brief && c.author === i.bot);
  return [...(brief ? [brief] : []), ...maintainerNotes(i)].map((x) => x.nodeId);
}

export function buildContext(i: ContextInput): string {
  const brief = i.comments.find((c) => c.id === i.state.brief && c.author === i.bot);
  if (!brief) throw new Error(`Issue #${i.issue}: no brief from ${i.bot} with comment id ${i.state.brief}`);
  // The maintainer approved the brief's Touches as posted; an edit could add paths or instructions after that.
  if (!editedOnlyBy(brief, i.edits, null)) throw new Error(`Issue #${i.issue}: the brief (comment id ${brief.id}) was edited after it was posted; run the planner again`);
  const parts = [`# Factory context: issue #${i.issue}`, `Branch: \`${branchFor(i.issue)}\``];
  if (i.state.pr) parts.push(`PR: #${i.state.pr}`);
  parts.push('## Brief', brief.body);
  if (i.stage === 'fix') {
    parts.push(`## Why this fix round: ${i.state.fixReason ?? 'unknown'}`);
    const review = i.reviews.findLast((r) => r.author === i.bot && parseReview(r.body) !== null);
    if (review) parts.push('## Factory review', review.body);
    const notes = maintainerNotes(i).filter((n) => editedOnlyBy(n, i.edits, MAINTAINER));
    if (notes.length > 0) parts.push('## Maintainer comments', notes.map((n) => `- ${n.body}`).join('\n'));
    // The workflow appends the failed CI log under this heading.
    if (i.state.fixReason === 'ci') parts.push('## CI failure');
  }
  return `${parts.join('\n\n')}\n`;
}

// The id of the CI run whose log the fixer reads: the run the router acted on (state.ciRun), never one found later
// by branch name, which a fork's run could match. state.runs is no fallback: it also holds the stage runs. Only a
// run of this repo counts; anything else is null.
export function ciRunId(state: FactoryState, repo: string): number | null {
  const prefix = `https://github.com/${repo}/actions/runs/`;
  const url = state.ciRun;
  if (!repo || !url?.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (!/^[1-9]\d{0,14}$/.test(rest)) return null;
  return Number(rest);
}

// The PR head the review or fix job must find after switching to the branch: the one the router's diff gate checked
// (state.gatedSha). A push since then was not checked, so the job stops rather than run on it. null for build, which
// runs on main.
export function gatedHead(state: FactoryState, stage: ContextInput['stage']): string | null {
  if (stage === 'build') return null;
  const sha = state.gatedSha;
  if (sha === undefined) throw new Error(`no PR head recorded for this ${stage} round; the router sets one when it dispatches the stage`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the recorded PR head is not a commit SHA: ${JSON.stringify(sha)}`);
  return sha;
}
