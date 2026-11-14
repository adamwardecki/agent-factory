// What a stage run did, read from the run and its jobs. Two callers: the router when a report dispatch arrives (the
// run's last job sends one, because workflow_run may not fire for runs GITHUB_TOKEN started), and the sweep, which
// looks the current attempt's run up itself. Anyone with write access can dispatch a report, so it counts only if
// the run it names is this repo's stage run for that stage, issue and attempt. A forged "success" still can't move
// an issue on: decide.ts then checks the stage's real output (a signed brief, PR or review).

import { CREDENTIAL_STEP, LIMIT_STEP, parseRunTitle, type RunWorkflow } from './config.ts';
import type { RunSnapshot } from './decide.ts';
import type { Report } from './events.ts';
import type { Job } from './github.ts';
import { dig, isStageRun, str } from './json.ts';

// A job of the reusable workflow shows up as "<caller job> / <job>".
const job = (jobs: readonly Job[], name: string) => jobs.find((j) => j.name === name || j.name.endsWith(` / ${name}`));

// The run's result for decide.ts. For an agent stage, 'success' needs prepare, agent and publish to have succeeded.
// For verify, 'success' and 'failure' are the result of the repo's checks; anything else means the run broke before
// they could tell. The last job is still running when it reports, so its own word stands in for its conclusion.
export function conclude(workflow: RunWorkflow, jobs: readonly Job[], reported?: 'success' | 'failure'): string {
  if (jobs.some((j) => j.conclusion === 'cancelled')) return 'cancelled';
  // The agent job's credential step fails only when Claude refused the credential before its first model call.
  const failedStep = (name: string) => workflow !== 'verify' && job(jobs, 'agent')?.steps?.some((s) => s.name === name && s.conclusion === 'failure');
  if (failedStep(CREDENTIAL_STEP)) return 'credential';
  if (failedStep(LIMIT_STEP)) return 'usage-limit';
  const ok = (name: string) => job(jobs, name)?.conclusion === 'success';
  if (workflow === 'verify') {
    if (!ok('prepare')) return 'startup_failure';
    const c = job(jobs, 'verify')?.conclusion;
    return c === 'success' || c === 'failure' ? c : 'startup_failure';
  }
  const publish = job(jobs, 'publish');
  const published = publish?.conclusion === 'success' || (publish !== undefined && publish.conclusion === null && reported === 'success');
  return ok('prepare') && ok('agent') && published ? 'success' : 'failure';
}

// null when the run is not a stage run of this repo. completedAt is null while the run is going, unless its last
// job has reported: then the run is as good as finished.
export function runSnapshot(run: unknown, jobs: readonly Job[], repo: string, now: Date, reported?: 'success' | 'failure'): (RunSnapshot & { issue: number }) | null {
  const title = isStageRun(run, repo) ? parseRunTitle(str(dig(run, 'display_title'))) : null;
  if (!title) return null;
  const done = dig(run, 'status') === 'completed';
  // A report counts only from the run's last job: the one that is allowed to still be running, with every job before
  // it finished. A report sent earlier is not about anything that has happened yet. Anyone with write access can
  // dispatch one, and an early forged "failure" must not burn an attempt of a run that is still going.
  const last = title.workflow === 'verify' ? 'report' : 'publish';
  const others = jobs.filter((j) => j.name !== last && !j.name.endsWith(` / ${last}`));
  const reporter = job(jobs, last);
  const reportable = reported !== undefined && reporter?.status === 'in_progress' && others.length > 0 && others.every((j) => j.status === 'completed');
  // Jobs can all be finished a moment before the run itself reads completed.
  const finished = done || reportable || (reporter?.status === 'completed' && jobs.every((j) => j.status === 'completed'));
  return {
    issue: title.issue,
    workflow: title.workflow,
    attempt: title.attempt,
    conclusion: finished ? conclude(title.workflow, jobs, reported) : null,
    url: str(dig(run, 'html_url')),
    completedAt: done ? str(dig(run, 'updated_at')) || now.toISOString() : finished ? now.toISOString() : null,
  };
}

export function checkReport(r: Report, run: unknown, jobs: readonly Job[], repo: string, now: Date): RunSnapshot | null {
  const s = runSnapshot(run, jobs, repo, now, r.result);
  if (!s || s.workflow !== r.workflow || s.issue !== r.issue || s.attempt !== r.attempt) return null;
  const { issue: _issue, ...snapshot } = s;
  return snapshot;
}
