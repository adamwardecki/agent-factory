// Constants shared by the factory router (main.ts) and the stage context builder (stage-context.ts).

export const MAINTAINER = 'adamwardecki';

// The router writes labels and comments with the workflow's GITHUB_TOKEN, so they come from this account.
// Events caused that way start no workflow runs, which keeps the router from waking itself.
export const ROUTER_LOGIN = 'github-actions[bot]';

// The GitHub App the stages act as ("<app-slug>[bot]"). Briefs and reviews count only when it wrote them, so a
// value that is not an App slug (an empty slug, a user's login) must not slip through.
export function factoryBotLogin(): string {
  const login = process.env.FACTORY_BOT_LOGIN ?? '';
  if (!/^[a-z0-9][a-z0-9-]*\[bot\]$/.test(login)) throw new Error('FACTORY_BOT_LOGIN must be set to "<app-slug>[bot]"');
  return login;
}

export const STAGES = ['queued', 'planning', 'awaiting-approval', 'building', 'ci', 'in-review', 'fixing', 'ready', 'blocked', 'done'] as const;
export type Stage = (typeof STAGES)[number];

// Stages that occupy the factory. ready and awaiting-approval wait on the maintainer, so the next issue may start.
export const ACTIVE_STAGES: readonly Stage[] = ['planning', 'building', 'ci', 'in-review', 'fixing'];

export const STAGE_WORKFLOWS = ['plan', 'build', 'review', 'fix'] as const;
export type StageWorkflow = (typeof STAGE_WORKFLOWS)[number];

// The workflow each dispatching stage runs. 'ci' has none: it waits on the repo's CI workflow.
export const RUNNER_FOR: Partial<Record<Stage, StageWorkflow>> = {
  planning: 'plan',
  building: 'build',
  'in-review': 'review',
  fixing: 'fix',
};

export const CI_WORKFLOW_NAME = 'CI';
export const CI_WORKFLOW_FILE = 'ci.yml';
export const stageWorkflowFile = (w: StageWorkflow) => `factory-${w}.yml`;
// The run-name of each stage workflow. workflow_run payloads carry it as display_title.
export const runTitle = (w: StageWorkflow, issue: number) => `factory-${w} #${issue}`;

export const LABEL_PREFIX = 'agent:';
export const stageLabel = (s: Stage) => `${LABEL_PREFIX}${s}`;

// Matt Pocock's triage roles. The planner sets exactly one of these three.
export const TRIAGE_READY = 'ready-for-agent';
export const TRIAGE_STOP = ['needs-info', 'ready-for-human'] as const;

export const branchFor = (issue: number) => `factory/issue-${issue}`;
export function issueForBranch(branch: string): number | null {
  const m = /^factory\/issue-(\d+)$/.exec(branch);
  return m ? Number(m[1]) : null;
}

export const MAX_ROUNDS = 3;
// Rebases in a row (ready → fixer → ready) before the factory stops; a rebase that never clears the conflict loops.
export const MAX_REBASES = 2;
export const MAX_ATTEMPTS = 2;
export const RETRY_AFTER_MS = 60 * 60 * 1000;
export const STUCK_AFTER_MS = 90 * 60 * 1000;
