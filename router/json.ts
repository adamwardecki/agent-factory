// Narrowing helpers for GitHub JSON, which arrives as unknown.

import { issueForBranch, type StageWorkflow, stageWorkflowFile } from './config.ts';
import type { RunSnapshot } from './decide.ts';
import { isRecord } from './util.ts';

export function dig(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
export const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// A workflow run from the REST API or a workflow_run payload.
export function runFrom(r: unknown, workflow: StageWorkflow | 'ci'): RunSnapshot {
  return {
    workflow,
    conclusion: str(dig(r, 'conclusion')) || null,
    headSha: str(dig(r, 'head_sha')),
    url: str(dig(r, 'html_url')),
    createdAt: str(dig(r, 'created_at')) || null,
    completedAt: dig(r, 'status') === 'completed' ? str(dig(r, 'updated_at')) || null : null,
  };
}

// Whether a PR head or run head lives in this repo. A fork can name its branch factory/issue-<n>, and its PRs and
// their runs then look like the factory's own.
export const inRepo = (head: unknown, repo: string): boolean => repo !== '' && str(dig(head, 'full_name')) === repo;

// A run of a stage workflow the router dispatched: this repo, a workflow_dispatch, and the stage's own file. The
// run-name alone proves nothing, since any workflow can set it.
export function isStageRun(r: unknown, workflow: StageWorkflow, repo: string): boolean {
  return inRepo(dig(r, 'head_repository'), repo) && dig(r, 'event') === 'workflow_dispatch' && dig(r, 'path') === `.github/workflows/${stageWorkflowFile(workflow)}`;
}

// A CI run on a factory branch of this repo.
export const isCiRun = (r: unknown, repo: string): boolean => inRepo(dig(r, 'head_repository'), repo) && issueForBranch(str(dig(r, 'head_branch'))) !== null;
