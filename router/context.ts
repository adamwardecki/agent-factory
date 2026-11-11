// Builds .factory/context.md: the only inputs the build, review and fix agents work from. The brief and the factory
// review count only with a valid signature; notes count only from the queue role, as their authors left them.
// Nothing else from the issue or PR threads goes in: those are untrusted text on a public repo. The Checks and
// Commits sections carry what the stage skills must not hardcode: the repo's commands and the SHAs to work from.

import { branchFor, ROUTER_LOGIN, type RunWorkflow } from './config.ts';
import type { Comment, Edit, Review } from './github.ts';
import { type FactoryState, parseCommand, parseReview } from './markers.ts';
import type { Commands } from './repo-config.ts';
import { canonical, verify } from './sign.ts';

export type Commits = {
  defaultBranch: string;
  base: string; // the default branch's head when the stage started
  head: string | null; // the PR head the stage runs on (review, fix)
  bundleOn: string | null; // the commit the agent's bundle must build on (build, fix)
};

export type ContextInput = {
  stage: 'build' | 'review' | 'fix';
  issue: number;
  key: string;
  state: FactoryState;
  comments: readonly Comment[]; // the issue thread
  reviews: readonly Review[];
  prComments: readonly Comment[]; // review comments on lines of the diff
  prConversation: readonly Comment[];
  edits: ReadonlyMap<string, Edit>;
  mayNote: (login: string) => boolean; // the queue role; prepare.ts looks every author and editor up first
  commands: Commands;
  commits: Commits;
  prSkill: string | null;
};

export function noteCandidates(i: Pick<ContextInput, 'reviews' | 'prComments' | 'prConversation'>): (Comment | Review)[] {
  const said = <T extends { body: string }>(xs: readonly T[]) => xs.filter((x) => x.body.trim() !== '');
  return [...said(i.reviews), ...said(i.prComments), ...said(i.prConversation).filter((c) => parseCommand(c.body) === null)];
}

function checks(c: Commands, stage: ContextInput['stage']): string {
  if (stage === 'review') return 'You run no commands. The factory ran the checks below on this commit before you started, and they passed.';
  const lines = [
    `- Tests: \`${c.test}\``,
    ...(c.lint ? [`- Lint: \`${c.lint}\``] : []),
    ...(c.typecheck ? [`- Typecheck: \`${c.typecheck}\``] : []),
    ...(c.testFile ? [`- One test file: \`${c.testFile} <file>\``] : []),
  ];
  return `Run these exactly as written. They are the only commands you may run besides git, and the factory runs the same ones on your commits afterwards.\n\n${lines.join('\n')}`;
}

function commits(c: Commits): string {
  return [
    `- Default branch: \`${c.defaultBranch}\`, at \`${c.base}\` when this stage started`,
    ...(c.head ? [`- The PR head you are on: \`${c.head}\``] : []),
    ...(c.bundleOn ? [`- Bundle your commits on top of: \`${c.bundleOn}\``] : []),
  ].join('\n');
}

export function buildContext(i: ContextInput): string {
  const brief = i.comments.find((c) => c.id === i.state.brief && c.author === ROUTER_LOGIN);
  if (!brief || !verify(i.key, i.issue, 'brief', brief.body)) throw new Error(`Issue #${i.issue}: no signed brief with comment id ${i.state.brief}; run the planner again`);
  const parts = [`# Factory context: issue #${i.issue}`, `Branch: \`${branchFor(i.issue)}\``];
  if (i.state.pr) parts.push(`PR: #${i.state.pr}`);
  parts.push('## Brief', canonical(brief.body));
  parts.push('## Checks', checks(i.commands, i.stage));
  parts.push('## Commits', commits(i.commits));
  if (i.stage === 'build' && i.prSkill) {
    parts.push('## PR conventions', `Read the skill at \`${i.prSkill}\` and follow its conventions for the PR title and body. Skip any step that installs tools, pushes, opens the PR or watches CI: the factory does those.`);
  }
  if (i.stage === 'fix') {
    parts.push(`## Why this fix round: ${i.state.fixReason ?? 'unknown'}`);
    const review = i.reviews.findLast((r) => r.author === ROUTER_LOGIN && parseReview(r.body) !== null && verify(i.key, i.issue, 'review', r.body));
    if (review) parts.push('## Factory review', canonical(review.body));
    const notes = noteCandidates(i).filter((n) => {
      if (n.author === ROUTER_LOGIN || !i.mayNote(n.author)) return false;
      const e = i.edits.get(n.nodeId);
      return e !== undefined && (e.lastEditedAt === null || (e.editor !== null && i.mayNote(e.editor)));
    });
    if (notes.length > 0) parts.push('## Maintainer comments', notes.map((n) => `- ${n.body}`).join('\n'));
    // The prepare job appends the failed verify log under this heading.
    if (i.state.fixReason === 'ci') parts.push('## Failed checks');
  }
  return `${parts.join('\n\n')}\n`;
}

// The id of the verify run whose log the fixer reads: the run the router acted on (state.ciRun), never one found
// later by branch name. state.runs is no fallback: it also holds the agent stages' runs. Only a run of this repo
// counts; anything else is null.
export function ciRunId(state: FactoryState, repo: string): number | null {
  const prefix = `https://github.com/${repo}/actions/runs/`;
  const url = state.ciRun;
  if (!repo || !url?.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (!/^[1-9]\d{0,14}$/.test(rest)) return null;
  return Number(rest);
}

// The PR head verify, review or fix must find on the branch: the one the router's diff gate checked
// (state.gatedSha). A push since then was not checked, so the job stops rather than run on it. null for plan and
// build, which run on the default branch.
export function gatedHead(state: FactoryState, workflow: RunWorkflow): string | null {
  if (workflow === 'plan' || workflow === 'build') return null;
  const sha = state.gatedSha;
  if (sha === undefined) throw new Error(`no PR head recorded for this ${workflow} run; the router sets one when it dispatches the stage`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the recorded PR head is not a commit SHA: ${JSON.stringify(sha)}`);
  return sha;
}
