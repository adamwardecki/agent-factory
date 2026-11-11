// Turns a GitHub Actions event into a factory event. 'sweep' for schedule and manual runs; null for events the
// factory ignores. The issue is resolved by main.ts, because a comment on a PR names the PR, not the issue. Only
// PRs and runs whose head is in `repo` count: a fork can name its branch factory/issue-<n>.

import { CI_WORKFLOW_NAME, issueForBranch, stageLabel } from './config.ts';
import type { FactoryEvent } from './decide.ts';
import { dig, inRepo, isCiRun, isStageRun, num, runFrom, str } from './json.ts';
import { parseCommand } from './markers.ts';

export type Target = { issue: number } | { pr: number };
export type Parsed = 'sweep' | { target: Target; build: (issue: number) => FactoryEvent } | null;

export function parseEvent(name: string, p: unknown, repo: string): Parsed {
  const action = dig(p, 'action');
  switch (name) {
    case 'schedule':
    case 'workflow_dispatch':
      return 'sweep';
    case 'issues': {
      const issue = num(dig(p, 'issue', 'number'));
      if (action !== 'labeled' || issue === null || dig(p, 'label', 'name') !== stageLabel('queued')) return null;
      const actor = str(dig(p, 'sender', 'login'));
      return { target: { issue }, build: (n) => ({ kind: 'queued', issue: n, actor }) };
    }
    case 'issue_comment': {
      const n = num(dig(p, 'issue', 'number'));
      const command = parseCommand(str(dig(p, 'comment', 'body')));
      if (action !== 'created' || n === null || !command) return null;
      const actor = str(dig(p, 'comment', 'user', 'login'));
      const target: Target = dig(p, 'issue', 'pull_request') !== undefined ? { pr: n } : { issue: n };
      return { target, build: (issue) => ({ kind: 'command', issue, command, actor }) };
    }
    case 'pull_request_review': {
      const issue = issueForBranch(str(dig(p, 'pull_request', 'head', 'ref')));
      if (action !== 'submitted' || issue === null || dig(p, 'review', 'state') !== 'changes_requested') return null;
      if (!inRepo(dig(p, 'pull_request', 'head', 'repo'), repo)) return null;
      const actor = str(dig(p, 'review', 'user', 'login'));
      return { target: { issue }, build: (n) => ({ kind: 'changes-requested', issue: n, actor }) };
    }
    case 'pull_request_target': {
      const issue = issueForBranch(str(dig(p, 'pull_request', 'head', 'ref')));
      const pr = num(dig(p, 'pull_request', 'number'));
      if (action !== 'closed' || issue === null || pr === null || !inRepo(dig(p, 'pull_request', 'head', 'repo'), repo)) return null;
      return { target: { issue }, build: (n) => ({ kind: 'pr-closed', issue: n, pr }) };
    }
    case 'workflow_run': {
      if (action !== 'completed') return null;
      const wr = dig(p, 'workflow_run');
      if (str(dig(wr, 'name')) === CI_WORKFLOW_NAME) {
        const issue = issueForBranch(str(dig(wr, 'head_branch')));
        if (issue === null || !isCiRun(wr, repo)) return null;
        return { target: { issue }, build: (n) => ({ kind: 'run-finished', issue: n, run: runFrom(wr, 'ci') }) };
      }
      const m = /^factory-(plan|build|review|fix) #(\d+)$/.exec(str(dig(wr, 'display_title')));
      const workflow = m?.[1];
      if (workflow !== 'plan' && workflow !== 'build' && workflow !== 'review' && workflow !== 'fix') return null;
      if (!isStageRun(wr, workflow, repo)) return null;
      const issue = Number(m?.[2]);
      return { target: { issue }, build: (n) => ({ kind: 'run-finished', issue: n, run: runFrom(wr, workflow) }) };
    }
    default:
      return null;
  }
}
