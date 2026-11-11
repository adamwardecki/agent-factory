// Narrowing helpers for GitHub JSON, which arrives as unknown.

import { STAGE_WORKFLOW_PATH } from './config.ts';
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

// Whether a PR head or run head lives in this repo. A fork can name its branch factory/issue-<n>, and its PRs and
// their runs then look like the factory's own.
export const inRepo = (head: unknown, repo: string): boolean => repo !== '' && str(dig(head, 'full_name')) === repo;

// A run of the repo's stage workflow that the router dispatched: this repo, a workflow_dispatch, and the stage file
// itself. The run-name alone proves nothing, since any workflow can set it.
export function isStageRun(r: unknown, repo: string): boolean {
  return inRepo(dig(r, 'head_repository'), repo) && dig(r, 'event') === 'workflow_dispatch' && dig(r, 'path') === STAGE_WORKFLOW_PATH;
}
