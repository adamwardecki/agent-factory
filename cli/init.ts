// `init`: installs the contract on a repo. It holds no state: each step looks at what's there and does only what's
// missing, so running it twice changes nothing the second time. Files go through a pull request, never a push to the
// default branch: no bypass of branch rules is needed, and the maintainer reviews what will run.

import { randomBytes } from 'node:crypto';
import { CONFIG_PATH, ConfigError } from '../router/config.ts';
import { defaultBranch, GitHubError, readRepoFile } from '../router/github.ts';
import { dig, str } from '../router/json.ts';
import { parseRepoConfig } from '../router/repo-config.ts';
import { CALLERS, callerVars, render } from '../scripts/render-callers.ts';
import { hasErrors, INSTALL_BRANCH, preflight, report } from './doctor.ts';
import type { Host } from './host.ts';
import { CLAUDE_SECRET, changedFiles, createLabel, type FileChange, getVariable, labelNames, labelProblems, openPullFrom, parsePin, proposeFiles, SIGNING_SECRET, secretNames, setVariable, wrongCaseMessage } from './repo.ts';

export type InitOptions = {
  factoryRef: string; // the commit of the factory repo the callers pin
  sweep: string; // the sweep's cron
  templates: Record<string, string>; // caller file name -> template text, from the factory clone
  // For a first factory.json, when the repo has none.
  queue: string[];
  node: string | null;
  python: string | null;
  install: string | null;
  test: string | null;
  lint: string | null;
  typecheck: string | null;
};

export type InitResult = { done: string[]; next: string[]; pr: number | null };

// The first factory.json, from the flags. The repo owns it from then on: init never rewrites one that exists.
export function firstConfig(o: InitOptions): string {
  if (!o.test) throw new ConfigError('the repo has no .github/factory.json; pass at least --test <command> (and --queue <login>) for a first one');
  if (o.queue.length === 0) throw new ConfigError('the repo has no .github/factory.json; pass --queue <login>[,<login>...] for who may queue issues');
  const toolchain = { ...(o.node ? { node: o.node } : {}), ...(o.python ? { python: o.python } : {}) };
  const commands = { ...(o.install ? { install: o.install } : {}), test: o.test, ...(o.lint ? { lint: o.lint } : {}), ...(o.typecheck ? { typecheck: o.typecheck } : {}) };
  const config = { version: 1, roles: { queue: o.queue }, toolchain, commands };
  // The same check the router runs, so a bad flag fails here and not on the first queued issue.
  parseRepoConfig(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function withFactoryIgnored(gitignore: string | null): string | null {
  const text = gitignore ?? '';
  if (/^\/?\.factory\/?$/m.test(text)) return null;
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}# The factory's agents work here (agent-factory)\n.factory/\n`;
}

export async function init(h: Host, o: InitOptions): Promise<InitResult> {
  const done: string[] = [];
  const next: string[] = [];

  // 1. What can fail before anything exists stops everything.
  const pre = await preflight(h);
  if (hasErrors(pre)) throw new Error(`init stopped before changing anything:\n${report(pre.filter((f) => f.level === 'error'))}`);

  // 2. The files, worked out before any write: a bad flag for a first factory.json stops init with nothing changed.
  // While the install PR is open, its branch is where the files are.
  const base = await defaultBranch(h.gh);
  const openInstall = await openPullFrom(h.gh, INSTALL_BRANCH);
  const read = async (path: string) => (await readRepoFile(h.gh, path, base)) ?? (openInstall !== null ? await readRepoFile(h.gh, path, INSTALL_BRANCH) : null);
  const vars = callerVars(h.factory.repo, o.factoryRef, o.sweep);
  const files: FileChange[] = [];
  for (const name of CALLERS) {
    const path = `.github/workflows/${name}`;
    const existing = await read(path);
    const pin = existing === null ? null : parsePin(existing);
    // Installed callers stay as they are: their sweep is the repo's choice, and moving the pin is upgrade's job,
    // with its version checks. Callers without a readable pin (an older install) are replaced.
    if (pin) {
      if (pin.sha !== o.factoryRef) next.push(`the callers pin ${pin.sha}; to move them to this clone's ${o.factoryRef}, run \`upgrade ${o.factoryRef}\``);
      continue;
    }
    const template = o.templates[name];
    if (template === undefined) throw new Error(`no template for ${name}`);
    files.push({ path, content: render(template, vars) });
  }
  if ((await read(CONFIG_PATH)) === null) files.push({ path: CONFIG_PATH, content: firstConfig(o) });
  const ignore = withFactoryIgnored(await readRepoFile(h.gh, '.gitignore', base));
  if (ignore !== null && !(openInstall !== null && withFactoryIgnored(await readRepoFile(h.gh, '.gitignore', INSTALL_BRANCH)) === null)) files.push({ path: '.gitignore', content: ignore });

  // A factory label in another case can't be created next to it (GitHub compares names without case), and the
  // router wouldn't match it. Checked before any write.
  const labels = labelProblems(await labelNames(h.gh));
  if (labels.wrongCase.length > 0) throw new Error(`init stopped before changing anything:\n${labels.wrongCase.map(wrongCaseMessage).join('\n')}`);

  // 3. Repo settings, each only if missing. The pull request setting goes first: an organisation can forbid
  // changing it (GitHub answers 409), and then nothing else should have been written.
  const w = await h.gh.call('GET', `/repos/${h.gh.repo}/actions/permissions/workflow`);
  if (dig(w, 'can_approve_pull_request_reviews') !== true) {
    try {
      // Both fields go back: the API resets one that's left out.
      await h.gh.call('PUT', `/repos/${h.gh.repo}/actions/permissions/workflow`, { default_workflow_permissions: str(dig(w, 'default_workflow_permissions')) || 'read', can_approve_pull_request_reviews: true });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 409) throw new Error('init stopped before changing anything: the organisation doesn\'t let this repo allow Actions to create pull requests; an organisation owner has to allow it');
      throw err;
    }
    done.push('turned on "Allow GitHub Actions to create and approve pull requests"');
  }

  for (const l of labels.missing) await createLabel(h.gh, l);
  if (labels.missing.length > 0) done.push(`created labels: ${labels.missing.join(', ')}`);

  if ((await getVariable(h.gh, 'FACTORY_DRY_RUN')) === null) {
    await setVariable(h.gh, 'FACTORY_DRY_RUN', '1');
    done.push('set FACTORY_DRY_RUN=1 (dry run)');
  }

  const secrets = new Set(await secretNames(h.gh));
  if (!secrets.has(SIGNING_SECRET)) {
    // 64 hex characters. It goes straight to gh on stdin and is never printed.
    await h.setSecret(SIGNING_SECRET, randomBytes(32).toString('hex'));
    done.push(`generated the ${SIGNING_SECRET} secret`);
  }

  // 4. The files, in one pull request.
  const changed = await changedFiles(h.gh, base, files);
  let pr: number | null = null;
  if (openInstall !== null) {
    pr = openInstall;
    done.push(`install PR #${openInstall} is already open`);
    next.push(`review and merge PR #${openInstall}`);
  } else if (changed.length > 0) {
    const body = [
      'Installs the agent factory. Generated by `agent-factory` (`cli/factory.ts init`).',
      '',
      ...changed.map((f) => `- \`${f.path}\``),
      '',
      `New callers pin \`${h.factory.repo}\` at \`${o.factoryRef}\`. Nothing runs until this is merged, and then only as a dry run until \`FACTORY_DRY_RUN\` is \`0\`.`,
    ].join('\n');
    const r = await proposeFiles(h.gh, INSTALL_BRANCH, changed, 'Install the agent factory', body);
    pr = r.pr;
    done.push(`opened install PR #${r.pr}`);
    next.push(`review and merge PR #${r.pr}`);
  }

  // 5. What's left for a person.
  if (!secrets.has(CLAUDE_SECRET)) next.push(`set the Claude credential: \`claude setup-token\`, then \`gh secret set ${CLAUDE_SECRET} --repo ${h.gh.repo}\``);
  if ((await getVariable(h.gh, 'FACTORY_DRY_RUN')) !== '0') next.push(`when a dry run looks right, go live: \`gh variable set FACTORY_DRY_RUN --body 0 --repo ${h.gh.repo}\``);
  return { done, next, pr };
}
