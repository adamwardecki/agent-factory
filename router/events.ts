// Turns a GitHub Actions event into a factory event. 'sweep' for the cron and plain manual runs. A report for the
// dispatch a stage's last job sends: workflow_run doesn't fire for runs GITHUB_TOKEN dispatched (phase 0, check 1),
// so there is no workflow_run case, and a report that never arrives is picked up by the next sweep. null for events
// the factory ignores. The issue behind a PR comment is resolved by main.ts.
// Only PRs and runs whose head is in `repo` count: a fork can name its branch factory/issue-<n>.

import { ATTEMPT, issueForBranch, RUN_WORKFLOWS, type RunWorkflow, stageLabel } from './config.ts';
import type { FactoryEvent } from './decide.ts';
import { dig, inRepo, num, str } from './json.ts';
import { parseCommand } from './markers.ts';
import { oneOf } from './util.ts';

export type Target = { issue: number } | { pr: number };
export type Report = { workflow: RunWorkflow; issue: number; attempt: string; runId: number; result: 'success' | 'failure' };
export type Parsed = 'sweep' | { report: Report } | { target: Target; build: (issue: number) => FactoryEvent } | null;

// Inputs are strings; anything malformed is not a report. main.ts checks the run itself before trusting it.
function report(inputs: unknown): Report | null {
  const workflow = str(dig(inputs, 'report_stage'));
  const issue = Number(str(dig(inputs, 'report_issue')));
  const attempt = str(dig(inputs, 'report_attempt'));
  const runId = Number(str(dig(inputs, 'report_run_id')));
  const result = str(dig(inputs, 'report_result'));
  if (!oneOf(RUN_WORKFLOWS, workflow) || !Number.isInteger(issue) || issue <= 0 || !Number.isInteger(runId) || runId <= 0) return null;
  if (!ATTEMPT.test(attempt) || (result !== 'success' && result !== 'failure')) return null;
  return { workflow, issue, attempt, runId, result };
}

export function parseEvent(name: string, p: unknown, repo: string): Parsed {
  const action = dig(p, 'action');
  switch (name) {
    case 'schedule':
      return 'sweep';
    case 'workflow_dispatch': {
      const inputs = dig(p, 'inputs');
      if (str(dig(inputs, 'report_run_id')) === '') return 'sweep';
      const r = report(inputs);
      return r ? { report: r } : null;
    }
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
    default:
      return null;
  }
}
