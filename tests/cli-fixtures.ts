// Shared fixtures for the CLI tests: two factory releases, and a repo as init leaves it.

import { readFileSync } from 'node:fs';
import { FACTORY_LABELS } from '../cli/repo.ts';
import { CALLERS, callerVars, render } from '../scripts/render-callers.ts';
import { type Fake, type FakeFactory, type FakeRepo, fake, fakeRepo } from './fake-github.ts';

export const PIN = 'a'.repeat(40);
export const NEXT = 'b'.repeat(40);
export const templates: Record<string, string> = Object.fromEntries(CALLERS.map((n) => [n, readFileSync(new URL(`../templates/${n}`, import.meta.url), 'utf8')]));

const configTs = (iface: number, state: number) => `export const CALLER_INTERFACE = ${iface};\nexport const STATE_VERSION = ${state};\n`;

// A factory repo with a release at each SHA: its templates, and its caller interface and state versions.
export function factoryWith(versions: Record<string, [number, number]> = { [PIN]: [1, 1], [NEXT]: [1, 1] }): FakeFactory {
  const commits = new Map<string, Map<string, string>>();
  for (const [sha, [i, s]] of Object.entries(versions)) {
    commits.set(sha, new Map([['router/config.ts', configTs(i, s)], ...CALLERS.map((n): [string, string] => [`templates/${n}`, templates[n] ?? ''])]));
  }
  return { commits };
}

// A repo with the whole contract in place, as if init ran and its PR was merged, and the Claude token was set.
export function installed(change: (r: FakeRepo) => void = () => {}): Fake {
  const repo = fakeRepo({
    labels: new Set(FACTORY_LABELS),
    secrets: new Map([
      ['FACTORY_SIGNING_KEY', '***'],
      ['CLAUDE_CODE_OAUTH_TOKEN', '***'],
    ]),
    variables: new Map([['FACTORY_DRY_RUN', '1']]),
    workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true },
    branchRules: { main: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }] },
  });
  const main = repo.branches.get('main');
  const vars = callerVars('o/agent-factory', PIN, '*/30 * * * *');
  for (const n of CALLERS) main?.set(`.github/workflows/${n}`, render(templates[n] ?? '', vars));
  main?.set('.github/factory.json', '{ "version": 1, "roles": { "queue": ["alice"] }, "commands": { "test": "npm test" } }\n');
  main?.set('.gitignore', '.factory/\n');
  change(repo);
  return fake(repo, factoryWith());
}

// The install PR merged: the install branch's files on main.
export function merge(f: Fake, branch = 'factory/install'): void {
  const files = f.repo.branches.get(branch);
  if (!files) throw new Error(`no branch ${branch}`);
  f.repo.branches.set('main', new Map(files));
  for (const p of f.repo.pulls) if (p.head === branch) p.state = 'closed';
}

// The findings' messages at one level, or all of them, one per line.
export const messages = (f: readonly { level: string; message: string }[], level?: 'error' | 'warning' | 'info') =>
  f
    .filter((x) => !level || x.level === level)
    .map((x) => x.message)
    .join('\n');
