// Router entry, run by agent-factory's reusable router workflow in the target repo. Level-triggered: every run loads
// the repo's factory.json from the default branch and every issue the factory holds, decides, and applies. The
// event that woke it only adds what a snapshot can't show (who labelled, which run reported). Any FACTORY_DRY_RUN
// other than exactly "0" logs the actions and writes nothing; FACTORY_PAUSED stops the router before it reads anything.
// Env: GITHUB_REPOSITORY, GITHUB_TOKEN, FACTORY_SIGNING_KEY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, and optionally
// FACTORY_DRY_RUN, FACTORY_PAUSED, FACTORY_AUTH_MODE.

import { readFileSync } from 'node:fs';
import { COMMAND_ROLES, createAuthority, holdsAny } from './authority.ts';
import { CONFIG_PATH, ConfigError, isDryRun, isPaused, issueForBranch, stageLabel } from './config.ts';
import { type Action, type Ctx, decideEvent, type FactoryEvent, next, settle, sweep } from './decide.ts';
import { parseEvent } from './events.ts';
import {
  cancelRun,
  client,
  collaboratorRole,
  createComment,
  defaultBranch,
  dispatchStage,
  findRun,
  type Gh,
  getRun,
  markReady,
  openIssuesWithLabel,
  pullBranch,
  readRepoFile,
  removeLabel,
  requestReview,
  runJobs,
  setStageLabel,
  updateComment,
} from './github.ts';
import { dig, num } from './json.ts';
import { renderState } from './markers.ts';
import { parseAuthMode, parseRepoConfig, type RepoConfig } from './repo-config.ts';
import { checkReport } from './report.ts';
import { sign } from './sign.ts';
import { type Loaded, loadAll, type Trust } from './snapshot.ts';
import { errorText } from './util.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

type Apply = { gh: Gh; key: string; ref: string; dry: boolean };

async function apply(a: Apply, loaded: Map<number, Loaded>, actions: readonly Action[]): Promise<void> {
  for (const x of actions) {
    console.log(`${a.dry ? '[dry run] ' : ''}${JSON.stringify(x)}`);
    if (a.dry) continue;
    const l = loaded.get(x.issue);
    switch (x.kind) {
      case 'save': {
        const body = sign(a.key, x.issue, 'state', renderState(x.state));
        if (l?.stateCommentId) await updateComment(a.gh, l.stateCommentId, body);
        else {
          const id = await createComment(a.gh, x.issue, body);
          if (l) l.stateCommentId = id;
        }
        const labels = await setStageLabel(a.gh, x.issue, l?.snap.labels ?? [], x.state.stage === 'done' ? null : stageLabel(x.state.stage));
        if (l) l.snap.labels = labels;
        break;
      }
      case 'unlabel': {
        const have = l?.snap.labels ?? [];
        for (const label of x.labels) if (have.includes(label)) await removeLabel(a.gh, x.issue, label);
        if (l) l.snap.labels = have.filter((y) => !x.labels.includes(y));
        break;
      }
      case 'comment':
        await createComment(a.gh, x.issue, x.body);
        break;
      case 'dispatch':
        // The state naming this attempt was saved just above: the run's prepare job checks for it.
        await dispatchStage(a.gh, x.workflow, x.issue, x.attempt, a.ref);
        break;
      case 'cancel': {
        const id = num(dig(await findRun(a.gh, x.workflow, x.issue, x.attempt), 'id'));
        if (id !== null) await cancelRun(a.gh, id);
        break;
      }
      case 'pr-ready': {
        if (!l?.prNodeId) throw new Error(`PR #${x.pr} of issue #${x.issue} is not in the loaded snapshots`);
        // A PR back from a fix round on an already-ready PR is not a draft; GitHub refuses to mark it ready again.
        if (l.snap.pr?.draft) await markReady(a.gh, l.prNodeId);
        if (x.reviewer) await requestReview(a.gh, x.pr, x.reviewer);
        break;
      }
    }
  }
}

async function loadConfig(gh: Gh, ref: string): Promise<RepoConfig> {
  const text = await readRepoFile(gh, CONFIG_PATH, ref);
  if (text === null) throw new ConfigError(`${CONFIG_PATH} is missing on ${ref}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${CONFIG_PATH} is not valid JSON`);
  }
  return parseRepoConfig(raw, parseAuthMode(process.env.FACTORY_AUTH_MODE));
}

// A broken config stops the factory; tell each queued issue, so whoever queued it sees why nothing happens.
async function reportConfigError(gh: Gh, err: ConfigError, dry: boolean): Promise<void> {
  console.error(`Config error: ${err.message}`);
  if (dry) return;
  for (const n of await openIssuesWithLabel(gh, stageLabel('queued'))) {
    await createComment(gh, n, `The factory can't run: ${err.message}`);
  }
}

async function main(): Promise<void> {
  if (isPaused(process.env.FACTORY_PAUSED)) {
    console.log('FACTORY_PAUSED is set: the factory is paused. Nothing read, nothing written.');
    return;
  }
  const repo = env('GITHUB_REPOSITORY');
  const gh = client(env('GITHUB_TOKEN'), repo);
  const key = env('FACTORY_SIGNING_KEY');
  const dry = isDryRun(process.env.FACTORY_DRY_RUN);
  const ref = await defaultBranch(gh);
  let config: RepoConfig;
  try {
    config = await loadConfig(gh, ref);
  } catch (err) {
    if (err instanceof ConfigError) return reportConfigError(gh, err, dry);
    throw err;
  }
  const authority = createAuthority(config.roles, (login) => collaboratorRole(gh, login));
  const trust: Trust = { key, authority };
  const now = new Date();
  const ctx: Ctx = { now, risky: config.riskyPaths, limits: config.limits, can: (role, login) => authority.known(role, login), fallbackReviewer: authority.reviewer };
  const ap: Apply = { gh, key, ref, dry };

  const parsed = parseEvent(env('GITHUB_EVENT_NAME'), JSON.parse(readFileSync(env('GITHUB_EVENT_PATH'), 'utf8')), repo);
  if (parsed === null) {
    console.log('Event ignored.');
    return;
  }
  // Work out the event before loading, so its issue is loaded even if it carries no stage label yet.
  let event: FactoryEvent | null = null;
  if (parsed !== 'sweep') {
    if ('report' in parsed) {
      const r = parsed.report;
      const run = checkReport(r, await getRun(gh, r.runId), await runJobs(gh, r.runId), repo, now);
      if (!run) {
        console.log(`Report for run ${r.runId} does not match a ${r.workflow} run of issue #${r.issue}, attempt ${r.attempt}; ignored.`);
        return;
      }
      event = { kind: 'run-finished', issue: r.issue, run };
    } else {
      // A comment on a PR resolves to an issue only when the PR's head is in this repo.
      const issue = 'issue' in parsed.target ? parsed.target.issue : issueForBranch((await pullBranch(gh, parsed.target.pr)) ?? '');
      if (issue === null) {
        console.log('Not a factory PR.');
        return;
      }
      event = parsed.build(issue);
    }
    // decide.ts reads authority.known(); look the event's actor up before deciding.
    if (event.kind === 'command') await holdsAny(authority, COMMAND_ROLES[event.command], event.actor);
    else if ('actor' in event) await authority.check('queue', event.actor);
  }

  // Every issue is loaded before anything is decided, so the event is admitted against the real number of active
  // issues.
  const all = await loadAll(gh, trust, now, event ? [event.issue] : []);
  for (const [n, l] of all) {
    if (!l.newerState) continue;
    console.log(`::warning::Issue #${n}: its state was written by a newer agent-factory release than this pin; left alone. Pin that release or newer.`);
    all.delete(n);
  }
  const snaps = [...all.values()].map((l) => l.snap);
  if (event === null) return apply(ap, all, sweep(snaps, ctx));
  const target = all.get(event.issue);
  if (!target) return;
  const settled = settle(snaps, decideEvent(event, target.snap, ctx), ctx);
  await apply(ap, all, [...settled, ...next(snaps, ctx, settled)]);
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});
