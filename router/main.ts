// Router entry, run by .github/workflows/factory-router.yml. Reads the event, snapshots the issue, asks decide.ts
// what to do and applies it; then starts the next queued issue if the factory is idle. FACTORY_DRY_RUN=1 logs the
// actions without writing anything.
// Env: GITHUB_REPOSITORY, GITHUB_TOKEN, FACTORY_DISPATCH_TOKEN, FACTORY_BOT_LOGIN, GITHUB_EVENT_NAME,
// GITHUB_EVENT_PATH, FACTORY_DRY_RUN (optional).

import { readFileSync } from 'node:fs';
import { factoryBotLogin, issueForBranch, MAINTAINER, stageLabel } from './config.ts';
import { type Action, type Ctx, decideEvent, next, sweep } from './decide.ts';
import { parseEvent } from './events.ts';
import { client, createComment, dispatch, type Gh, markReady, pullBranch, removeLabel, requestReview, setStageLabel, updateComment } from './github.ts';
import { parseGlobList } from './globs.ts';
import { renderState } from './markers.ts';
import { type Loaded, load, loadAll } from './snapshot.ts';
import { errorText } from './util.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function apply(gh: Gh, dispatcher: Gh, loaded: Map<number, Loaded>, actions: readonly Action[], dry: boolean): Promise<void> {
  for (const a of actions) {
    console.log(`${dry ? '[dry run] ' : ''}${JSON.stringify(a)}`);
    if (dry) continue;
    const l = a.kind === 'pr-ready' ? undefined : loaded.get(a.issue);
    switch (a.kind) {
      case 'save': {
        const body = renderState(a.state);
        if (l?.stateCommentId) await updateComment(gh, l.stateCommentId, body);
        else {
          const id = await createComment(gh, a.issue, body);
          if (l) l.stateCommentId = id;
        }
        const labels = await setStageLabel(gh, a.issue, l?.snap.labels ?? [], a.state.stage === 'done' ? null : stageLabel(a.state.stage));
        if (l) l.snap.labels = labels;
        break;
      }
      case 'unlabel': {
        const have = l?.snap.labels ?? [];
        for (const label of a.labels) if (have.includes(label)) await removeLabel(gh, a.issue, label);
        if (l) l.snap.labels = have.filter((x) => !a.labels.includes(x));
        break;
      }
      case 'comment':
        await createComment(gh, a.issue, a.body);
        break;
      case 'dispatch':
        await dispatch(dispatcher, a.workflow, a.issue);
        break;
      case 'pr-ready': {
        const found = [...loaded.values()].find((x) => x.snap.pr?.number === a.pr);
        if (!found?.prNodeId) throw new Error(`PR #${a.pr} is not in the loaded snapshots`);
        // The App token, not GITHUB_TOKEN: GitHub refuses markPullRequestReadyForReview from GITHUB_TOKEN on a PR
        // another app opened ("Resource not accessible by integration"). A PR back from a fix round on an
        // already-ready PR is not a draft; GitHub refuses to mark it ready again.
        if (found.snap.pr?.draft) await markReady(dispatcher, found.prNodeId);
        await requestReview(dispatcher, a.pr, MAINTAINER);
        break;
      }
    }
  }
}

async function main(): Promise<void> {
  const repo = env('GITHUB_REPOSITORY');
  const gh = client(env('GITHUB_TOKEN'), repo);
  const dispatcher = client(env('FACTORY_DISPATCH_TOKEN'), repo);
  const bot = factoryBotLogin();
  const dry = process.env.FACTORY_DRY_RUN === '1';

  const parsed = parseEvent(env('GITHUB_EVENT_NAME'), JSON.parse(readFileSync(env('GITHUB_EVENT_PATH'), 'utf8')), repo);
  if (parsed === null) {
    console.log('Event ignored.');
    return;
  }
  const risky = parseGlobList(readFileSync(new URL('./risky-paths.txt', import.meta.url), 'utf8'));
  const ctx: Ctx = { now: new Date(), risky };
  let eventActions: Action[] = [];
  if (parsed !== 'sweep') {
    // A comment on a PR resolves to an issue only when the PR's head is in this repo: a fork can name its branch
    // factory/issue-<n>.
    const issue = 'issue' in parsed.target ? parsed.target.issue : issueForBranch((await pullBranch(gh, parsed.target.pr)) ?? '');
    if (issue === null) {
      console.log('Not a factory PR.');
      return;
    }
    const one = new Map([[issue, await load(gh, issue, bot)]]);
    const loaded = one.get(issue);
    if (loaded) {
      eventActions = decideEvent(parsed.build(issue), loaded.snap, ctx);
      await apply(gh, dispatcher, one, eventActions, dry);
    }
  }
  const all = await loadAll(gh, bot);
  const snaps = [...all.values()].map((l) => l.snap);
  // The event's actions again: a dry run wrote nothing, so the reload still shows the issue as before the event.
  await apply(gh, dispatcher, all, parsed === 'sweep' ? sweep(snaps, ctx) : next(snaps, ctx, eventActions), dry);
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});
