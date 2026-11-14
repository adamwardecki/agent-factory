// `doctor`: checks a repo against the install contract and prints what's wrong. It only reads. Workflow files are
// read as text (there's no YAML parser), so what it says about them is a hint, not a proof.

import { CONFIG_PATH, ConfigError, isDryRun, isPaused } from '../router/config.ts';
import { defaultBranch, GitHubError, readRepoFile } from '../router/github.ts';
import { dig, rows, str } from '../router/json.ts';
import { parseRepoConfig } from '../router/repo-config.ts';
import type { Host } from './host.ts';
import {
  CALLER_PATHS,
  CLAUDE_SECRET,
  commitExists,
  getVariable,
  issuesInFlight,
  labelNames,
  labelProblems,
  openPullFrom,
  parsePin,
  releaseVersions,
  SIGNING_SECRET,
  secretNames,
  wrongCaseMessage,
} from './repo.ts';

export type Level = 'error' | 'warning' | 'info';
export type Finding = { level: Level; check: string; message: string };

// The branch init opens its pull request from. doctor names that PR instead of reporting missing files.
export const INSTALL_BRANCH = 'factory/install';

const status = (err: unknown) => (err instanceof GitHubError ? err.status : null);
// A 403 or 404 on a settings or rules endpoint means this token or plan can't read it, not that it's wrong.
const unreadable = (err: unknown) => status(err) === 403 || status(err) === 404;

async function access(h: Host): Promise<Finding[]> {
  const out: Finding[] = [];
  const repo = await h.gh.call('GET', `/repos/${h.gh.repo}`);
  if (dig(repo, 'permissions', 'admin') !== true) out.push({ level: 'error', check: 'access', message: `the gh token has no admin access to ${h.gh.repo}; secrets, variables and Actions settings need it, so the other checks can't run` });
  const scopes = await h.scopes();
  if (scopes === null) {
    out.push({ level: 'warning', check: 'access', message: 'the gh token reports no scopes (a fine-grained token?); it needs Administration, Secrets, Variables, Workflows, Contents, Issues and Pull requests write on this repo' });
  } else {
    for (const s of ['repo', 'workflow']) if (!scopes.includes(s)) out.push({ level: 'error', check: 'access', message: `the gh token lacks the ${s} scope: run \`gh auth refresh -s ${s}\`` });
  }
  return out;
}

// GitHub's allowed-actions patterns: * matches anything, the rest is literal.
const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`);

async function actions(h: Host): Promise<Finding[]> {
  const p = await h.gh.call('GET', `/repos/${h.gh.repo}/actions/permissions`);
  if (dig(p, 'enabled') !== true) return [{ level: 'error', check: 'actions', message: 'GitHub Actions is turned off for this repo' }];
  const allowed = str(dig(p, 'allowed_actions'));
  if (allowed === 'local_only') return [{ level: 'error', check: 'actions', message: 'Actions only allows actions from this repo; the factory needs its own repo, actions/* and anthropics/claude-code-action' }];
  if (allowed !== 'selected') return [];
  const sel = await h.gh.call('GET', `/repos/${h.gh.repo}/actions/permissions/selected-actions`);
  const patterns = rows(dig(sel, 'patterns_allowed')).map(str).map(glob);
  const needed = [`${h.factory.repo}/.github/workflows/stage.yml@0000000000000000000000000000000000000000`, 'anthropics/claude-code-action@0000000000000000000000000000000000000000'];
  const out: Finding[] = [];
  for (const n of needed) if (!patterns.some((re) => re.test(n))) out.push({ level: 'error', check: 'actions', message: `the allowed-actions policy doesn't admit ${n.split('@')[0]}` });
  if (dig(sel, 'github_owned_allowed') !== true) out.push({ level: 'error', check: 'actions', message: 'the allowed-actions policy doesn\'t admit actions made by GitHub (actions/checkout and others)' });
  return out;
}

async function pullRequestSetting(h: Host, preflight: boolean): Promise<Finding[]> {
  const out: Finding[] = [];
  const owner = h.gh.repo.split('/')[0] ?? '';
  const repo = await h.gh.call('GET', `/repos/${h.gh.repo}`);
  if (dig(repo, 'owner', 'type') === 'Organization') {
    try {
      const org = await h.gh.call('GET', `/orgs/${owner}/actions/permissions/workflow`);
      if (dig(org, 'can_approve_pull_request_reviews') === false) out.push({ level: 'error', check: 'pull requests', message: `the organisation ${owner} doesn't let Actions create pull requests; an organisation owner has to allow it` });
    } catch (err) {
      if (!unreadable(err)) throw err;
      out.push({ level: 'info', check: 'pull requests', message: `couldn't read the organisation's Actions setting for pull requests` });
    }
  }
  // init turns the repo setting on itself, so before init only the organisation's lock matters.
  if (preflight) return out;
  const w = await h.gh.call('GET', `/repos/${h.gh.repo}/actions/permissions/workflow`);
  if (dig(w, 'can_approve_pull_request_reviews') !== true) out.push({ level: 'error', check: 'pull requests', message: '"Allow GitHub Actions to create and approve pull requests" is off; init turns it on' });
  return out;
}

// Rules on the factory's branches. The publish job pushes unsigned commits and force-pushes after a rebase.
async function branchRules(h: Host): Promise<Finding[]> {
  let rules: unknown[];
  try {
    rules = rows(await h.gh.call('GET', `/repos/${h.gh.repo}/rules/branches/${encodeURIComponent('factory/issue-1')}`));
  } catch (err) {
    if (!unreadable(err)) throw err;
    return [{ level: 'info', check: 'branch rules', message: 'couldn\'t read the rules for factory/issue-* (rulesets need a paid plan on private repos)' }];
  }
  const why: Record<string, string> = {
    required_signatures: 'requires signed commits, and the publish job pushes unsigned ones',
    pull_request: 'requires a pull request, and the publish job pushes to factory/issue-<n> directly',
    required_status_checks: 'requires status checks before a push, and the publish job pushes commits nothing has checked yet',
    required_deployments: 'requires deployments before a push, and the publish job pushes directly',
    merge_queue: 'requires a merge queue, and the publish job pushes directly',
    creation: 'restricts creating branches, and the publish job creates factory/issue-<n>',
    update: 'restricts updating branches, and the publish job pushes to factory/issue-<n>',
    non_fast_forward: 'blocks force pushes, and a rebase round force-pushes',
  };
  return rules.flatMap((r) => {
    const reason = why[str(dig(r, 'type'))];
    return reason ? [{ level: 'error' as const, check: 'branch rules', message: `a rule on factory/issue-* ${reason}` }] : [];
  });
}

async function contract(h: Host, base: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const install = await openPullFrom(h.gh, INSTALL_BRANCH);
  const pending = (what: string): Finding =>
    install !== null
      ? { level: 'info', check: 'install', message: `${what} is in install PR #${install}, not yet merged` }
      : { level: 'error', check: 'install', message: `${what} is missing on ${base}; run init` };

  const config = await readRepoFile(h.gh, CONFIG_PATH, base);
  if (config === null) out.push(pending(CONFIG_PATH));
  else {
    try {
      parseRepoConfig(JSON.parse(config));
    } catch (err) {
      if (!(err instanceof ConfigError || err instanceof SyntaxError)) throw err;
      out.push({ level: 'error', check: 'config', message: `${CONFIG_PATH}: ${err.message}` });
    }
  }

  for (const path of CALLER_PATHS) {
    const text = await readRepoFile(h.gh, path, base);
    if (text === null) {
      out.push(pending(path));
      continue;
    }
    const pin = parsePin(text);
    if (!pin) {
      out.push({ level: 'error', check: 'callers', message: `${path} has no pinned \`uses: <owner>/<repo>/.github/workflows/<file>@<sha>\` line` });
      continue;
    }
    if (pin.factoryRepo !== h.factory.repo) {
      out.push({ level: 'warning', check: 'callers', message: `${path} pins ${pin.factoryRepo}, not ${h.factory.repo}` });
      continue;
    }
    if (!(await commitExists(h.factory, pin.sha))) {
      out.push({ level: 'error', check: 'callers', message: `${path} pins ${pin.sha}, which isn't a commit of ${pin.factoryRepo}` });
      continue;
    }
    // The release the callers pin is what has to understand them, whatever this clone is at.
    const speaks = (await releaseVersions(h.factory, pin.sha)).interface;
    if (pin.interface !== speaks) out.push({ level: 'error', check: 'callers', message: `${path} speaks caller interface ${pin.interface ?? 'unknown'}; the release it pins speaks ${speaks}` });
  }

  const gitignore = (await readRepoFile(h.gh, '.gitignore', base)) ?? '';
  if (!/^\/?\.factory\/?$/m.test(gitignore)) out.push({ level: 'warning', check: 'install', message: '.gitignore doesn\'t list .factory/; linters that read .gitignore will trip over the agents\' working directory' });

  const labels = labelProblems(await labelNames(h.gh));
  if (labels.missing.length > 0) out.push({ level: 'error', check: 'labels', message: `missing labels: ${labels.missing.join(', ')}; init creates them` });
  for (const w of labels.wrongCase) out.push({ level: 'error', check: 'labels', message: wrongCaseMessage(w) });

  const secrets = new Set(await secretNames(h.gh));
  if (!secrets.has(SIGNING_SECRET)) out.push({ level: 'error', check: 'secrets', message: `the ${SIGNING_SECRET} secret is missing; init generates it` });
  if (!secrets.has(CLAUDE_SECRET)) out.push({ level: 'error', check: 'secrets', message: `the ${CLAUDE_SECRET} secret is missing: run \`claude setup-token\`, then \`gh secret set ${CLAUDE_SECRET} --repo ${h.gh.repo}\`` });
  return out;
}

// What the default branch's rules mean for a factory PR. Read from rulesets and from classic branch protection.
async function defaultBranchRules(h: Host, base: string): Promise<Finding[]> {
  const checks: string[] = [];
  let reviews = 0;
  let readable = false;
  try {
    for (const r of rows(await h.gh.call('GET', `/repos/${h.gh.repo}/rules/branches/${encodeURIComponent(base)}`))) {
      if (dig(r, 'type') === 'required_status_checks') for (const c of rows(dig(r, 'parameters', 'required_status_checks'))) checks.push(str(dig(c, 'context')));
      if (dig(r, 'type') === 'pull_request') reviews = Math.max(reviews, Number(dig(r, 'parameters', 'required_approving_review_count') ?? 0));
    }
    readable = true;
  } catch (err) {
    if (!unreadable(err)) throw err;
  }
  try {
    const p = await h.gh.call('GET', `/repos/${h.gh.repo}/branches/${encodeURIComponent(base)}/protection`);
    for (const c of rows(dig(p, 'required_status_checks', 'contexts'))) checks.push(str(c));
    reviews = Math.max(reviews, Number(dig(p, 'required_pull_request_reviews', 'required_approving_review_count') ?? 0));
    readable = true;
  } catch (err) {
    // 404: no classic protection on the branch, which is an answer.
    if (status(err) === 404) readable = true;
    else if (!unreadable(err)) throw err;
  }
  if (!readable) return [{ level: 'info', check: 'default branch', message: `couldn't read the rules on ${base}` }];
  const out: Finding[] = [];
  const unique = [...new Set(checks)];
  if (unique.length > 0) out.push({ level: 'info', check: 'default branch', message: `${base} requires ${unique.join(', ')}: on a factory PR they run only after someone approves the workflow runs` });
  if (reviews < 1) out.push({ level: 'warning', check: 'default branch', message: `${base} doesn't require an approving review; the factory never merges, but nothing stops someone else merging unreviewed work` });
  const signoff = unique.filter((c) => /\b(cla|dco)\b/i.test(c));
  if (signoff.length > 0) out.push({ level: 'warning', check: 'default branch', message: `${signoff.join(', ')} is required: the factory's commits are by github-actions[bot], which can't sign a CLA or DCO` });
  return out;
}

async function running(h: Host): Promise<Finding[]> {
  const dry = await getVariable(h.gh, 'FACTORY_DRY_RUN');
  const paused = await getVariable(h.gh, 'FACTORY_PAUSED');
  const flight = await issuesInFlight(h.gh);
  return [
    { level: 'info', check: 'mode', message: isDryRun(dry ?? undefined) ? `dry run (FACTORY_DRY_RUN ${dry === null ? 'unset' : `is ${JSON.stringify(dry)}`}); go live with \`gh variable set FACTORY_DRY_RUN --body 0 --repo ${h.gh.repo}\`` : 'live (FACTORY_DRY_RUN=0)' },
    ...(isPaused(paused ?? undefined) ? [{ level: 'info' as const, check: 'mode', message: `paused (FACTORY_PAUSED is ${JSON.stringify(paused)})` }] : []),
    { level: 'info', check: 'issues', message: flight.length === 0 ? 'no issues in flight' : `in flight: ${flight.map((n) => `#${n}`).join(', ')}` },
  ];
}

// The checks that can fail before anything is installed. init runs these and stops on an error.
// Without admin access the settings endpoints answer 403, so the checks stop at the access findings.
export async function preflight(h: Host): Promise<Finding[]> {
  const first = await access(h);
  if (hasErrors(first)) return first;
  return [...first, ...(await actions(h)), ...(await pullRequestSetting(h, true)), ...(await branchRules(h))];
}

export async function doctor(h: Host): Promise<Finding[]> {
  const base = await defaultBranch(h.gh);
  const first = await access(h);
  if (hasErrors(first)) return first;
  return [
    ...first,
    ...(await actions(h)),
    ...(await pullRequestSetting(h, false)),
    ...(await branchRules(h)),
    ...(await contract(h, base)),
    ...(await defaultBranchRules(h, base)),
    ...(await running(h)),
  ];
}

const ORDER: Record<Level, number> = { error: 0, warning: 1, info: 2 };
export function report(findings: readonly Finding[]): string {
  return [...findings]
    .sort((a, b) => ORDER[a.level] - ORDER[b.level])
    .map((f) => `${f.level.padEnd(7)} ${f.check}: ${f.message}`)
    .join('\n');
}

export const hasErrors = (findings: readonly Finding[]) => findings.some((f) => f.level === 'error');

