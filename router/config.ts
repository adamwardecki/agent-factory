// Constants shared by the router, the prepare job and the publish job.

// The identity every factory write comes from: the workflow's GITHUB_TOKEN. No other module names it, so a later App
// mode changes these three values and the token the jobs are handed, nothing else.
export const ROUTER_LOGIN = 'github-actions[bot]';
export const BOT_NAME = 'github-actions[bot]';
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

export const STAGES = ['queued', 'waiting', 'planning', 'awaiting-approval', 'building', 'ci', 'in-review', 'fixing', 'ready', 'blocked', 'done'] as const;
export type Stage = (typeof STAGES)[number];

// Stages that occupy a slot. ready and awaiting-approval wait on a person, and waiting waits for a slot.
export const ACTIVE_STAGES: readonly Stage[] = ['planning', 'building', 'ci', 'in-review', 'fixing'];

// The agent stages: each runs Claude in the stage workflow.
export const STAGE_WORKFLOWS = ['plan', 'build', 'review', 'fix'] as const;
export type StageWorkflow = (typeof STAGE_WORKFLOWS)[number];
// Everything the router dispatches: the agent stages, and verify, the factory's own restricted CI.
export const RUN_WORKFLOWS = ['plan', 'build', 'verify', 'review', 'fix'] as const;
export type RunWorkflow = (typeof RUN_WORKFLOWS)[number];

// The workflow each dispatching stage runs, and back.
export const RUNNER_FOR: Partial<Record<Stage, RunWorkflow>> = { planning: 'plan', building: 'build', ci: 'verify', 'in-review': 'review', fixing: 'fix' };
export const STAGE_FOR: Record<RunWorkflow, Stage> = { plan: 'planning', build: 'building', verify: 'ci', review: 'in-review', fix: 'fixing' };

// One caller workflow per repo runs every stage; the stage is an input, and the run-name says which.
export const STAGE_WORKFLOW_FILE = 'factory-stage.yml';
export const STAGE_WORKFLOW_PATH = `.github/workflows/${STAGE_WORKFLOW_FILE}`;
export const ROUTER_WORKFLOW_FILE = 'factory-router.yml';
export const CONFIG_PATH = '.github/factory.json';

// A new id on every entry into a stage that runs a workflow: the entry time in base 36, so an issue never sees the
// same id twice, even after /stop and a re-queue. Only the attempt the state names may publish or move the issue on.
export const attemptId = (now: Date): string => now.getTime().toString(36);
export const ATTEMPT = /^[0-9a-z]{1,16}$/;

// The run-name of a stage run. workflow_run payloads and the runs API carry it as display_title.
export const runTitle = (w: RunWorkflow, issue: number, attempt: string) => `factory-${w} #${issue} ${attempt}`;
export function parseRunTitle(title: string): { workflow: RunWorkflow; issue: number; attempt: string } | null {
  const m = /^factory-([a-z]+) #([1-9]\d{0,9}) ([0-9a-z]{1,16})$/.exec(title);
  const workflow = RUN_WORKFLOWS.find((w) => w === m?.[1]);
  return m && workflow ? { workflow, issue: Number(m[2]), attempt: m[3] ?? '' } : null;
}

export const LABEL_PREFIX = 'agent:';
export const stageLabel = (s: Stage) => `${LABEL_PREFIX}${s}`;

// Matt Pocock's triage roles. The planner picks exactly one of these three; the publish job sets it.
export const TRIAGE_READY = 'ready-for-agent';
export const TRIAGE_STOP = ['needs-info', 'ready-for-human'] as const;

export const branchFor = (issue: number) => `factory/issue-${issue}`;
export function issueForBranch(branch: string): number | null {
  const m = /^factory\/issue-(\d+)$/.exec(branch);
  return m ? Number(m[1]) : null;
}

export const RETRY_AFTER_MS = 60 * 60 * 1000;
// A stage whose run has not shown up this long after it was entered is dispatched again.
export const DISPATCH_RETRY_AFTER_MS = 10 * 60 * 1000;
export const STUCK_AFTER_MS = 90 * 60 * 1000;

// The version of the state comment's hidden data. A release reads this version and the one before it, and writes this
// one, so an upgrade never strands an issue in flight.
export const STATE_VERSION = 1;

// FACTORY_DRY_RUN: anything but exactly "0" is a dry run, so a typo fails safe. FACTORY_PAUSED: anything but unset,
// empty or exactly "0" is paused, for the same reason.
export const isDryRun = (v: string | undefined): boolean => v !== '0';
export const isPaused = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0';

// A problem in .github/factory.json. The router reports its message on the queued issue, so it names the field.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
