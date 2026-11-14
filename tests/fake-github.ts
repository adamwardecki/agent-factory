// An in-memory GitHub for the CLI tests: the endpoints the CLI calls, with the status codes the real API returns.
// Every call other than a GET is recorded in `writes`, so a test can assert that a second run changed nothing.

import type { Host } from '../cli/host.ts';
import { GitHubError } from '../router/github.ts';

export type FakeRepo = {
  admin: boolean;
  orgOwned: boolean;
  orgAllowsPrs: boolean | 'unreadable';
  // The organisation forbids changing the repo's PR setting: GitHub answers the repo-level PUT with 409.
  orgLocksPrSetting: boolean;
  actionsEnabled: boolean;
  allowedActions: 'all' | 'local_only' | 'selected';
  selected: { github_owned_allowed: boolean; patterns_allowed: string[] };
  workflow: { default_workflow_permissions: string; can_approve_pull_request_reviews: boolean };
  // null: the rules API answers 403, as on the Free plan for a private repo.
  branchRules: Record<string, { type: string; parameters?: unknown }[]> | null;
  protection: Record<string, unknown> | null;
  branches: Map<string, Map<string, string>>; // branch -> path -> content
  labels: Set<string>;
  secrets: Map<string, string>;
  variables: Map<string, string>;
  issues: { number: number; labels: string[]; comments?: string[] }[];
  pulls: { number: number; head: string; base: string; title: string; body: string; state: 'open' | 'closed' }[];
  scopes: string[] | null;
};

export function fakeRepo(extra: Partial<FakeRepo> = {}): FakeRepo {
  return {
    admin: true,
    orgOwned: false,
    orgAllowsPrs: true,
    orgLocksPrSetting: false,
    actionsEnabled: true,
    allowedActions: 'all',
    selected: { github_owned_allowed: true, patterns_allowed: [] },
    workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    branchRules: {},
    protection: null,
    branches: new Map([['main', new Map([['README.md', '# app\n']])]]),
    labels: new Set(['bug']),
    secrets: new Map(),
    variables: new Map(),
    issues: [],
    pulls: [],
    scopes: ['repo', 'workflow', 'read:org'],
    ...extra,
  };
}

// A factory repo: commits, and files at each commit.
export type FakeFactory = { commits: Map<string, Map<string, string>> };

export type Fake = { host: Host; repo: FakeRepo; factory: FakeFactory; writes: string[]; secretValues: Map<string, string> };

const fail = (status: number, what: string) => {
  throw new GitHubError(`GitHub ${what} failed with ${status}`, status);
};
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const sha = (s: string) => `${Buffer.from(s).toString('hex').slice(0, 40).padEnd(40, '0')}`;

export function fake(repo: FakeRepo = fakeRepo(), factory: FakeFactory = { commits: new Map() }, name = 'o/app', factoryName = 'o/agent-factory'): Fake {
  const writes: string[] = [];
  const secretValues = new Map<string, string>();
  let nextPr = 100;
  const R = `/repos/${name}`;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const what = `${method} ${path}`;
    if (method !== 'GET') writes.push(what);
    const [route = '', query = ''] = path.split('?');
    const q = new URLSearchParams(query);
    const b = (body ?? {}) as Record<string, unknown>;
    if (route === R) return { permissions: { admin: repo.admin }, owner: { type: repo.orgOwned ? 'Organization' : 'User' }, default_branch: 'main' };
    // Actions settings, secrets and variables need Administration access; GitHub answers 403 without it.
    if (!repo.admin && route.startsWith(`${R}/actions/`)) return fail(403, what);
    if (route === `${R}/actions/permissions`) return { enabled: repo.actionsEnabled, allowed_actions: repo.allowedActions };
    if (route === `${R}/actions/permissions/selected-actions`) return repo.selected;
    if (route === `${R}/actions/permissions/workflow`) {
      if (method === 'PUT') {
        if (repo.orgLocksPrSetting) return fail(409, what);
        repo.workflow = { default_workflow_permissions: String(b.default_workflow_permissions), can_approve_pull_request_reviews: b.can_approve_pull_request_reviews === true };
        return undefined;
      }
      return { ...repo.workflow };
    }
    if (route === `/orgs/${name.split('/')[0]}/actions/permissions/workflow`) {
      if (repo.orgAllowsPrs === 'unreadable') return fail(403, what);
      return { can_approve_pull_request_reviews: repo.orgAllowsPrs };
    }
    let m = new RegExp(`^${R}/rules/branches/(.+)$`).exec(route);
    if (m?.[1]) {
      if (repo.branchRules === null) return fail(403, what);
      return repo.branchRules[decodeURIComponent(m[1])] ?? [];
    }
    m = new RegExp(`^${R}/branches/(.+)/protection$`).exec(route);
    if (m) return repo.protection ?? fail(404, what);
    m = new RegExp(`^${R}/contents/(.+)$`).exec(route);
    if (m?.[1]) {
      const file = m[1];
      if (method === 'PUT') {
        const files = repo.branches.get(String(b.branch));
        if (!files) return fail(404, what);
        if (files.has(file) && b.sha !== sha(files.get(file) ?? '')) return fail(409, what);
        files.set(file, Buffer.from(String(b.content), 'base64').toString('utf8'));
        return {};
      }
      const content = repo.branches.get(q.get('ref') ?? 'main')?.get(file);
      return content === undefined ? fail(404, what) : { content: b64(content), sha: sha(content) };
    }
    if (route === `${R}/labels`) {
      if (method === 'POST') {
        // GitHub compares label names without regard to case.
        if ([...repo.labels].some((l) => l.toLowerCase() === String(b.name).toLowerCase())) return fail(422, what);
        repo.labels.add(String(b.name));
        return {};
      }
      return Number(q.get('page') ?? '1') > 1 ? [] : [...repo.labels].map((l) => ({ name: l }));
    }
    if (route === `${R}/actions/secrets`) return { secrets: [...repo.secrets.keys()].map((n) => ({ name: n })) };
    if (route === `${R}/actions/variables` && method === 'POST') {
      if (repo.variables.has(String(b.name))) return fail(409, what);
      repo.variables.set(String(b.name), String(b.value));
      return {};
    }
    m = new RegExp(`^${R}/actions/variables/([A-Z_]+)$`).exec(route);
    if (m?.[1]) {
      const v = m[1];
      if (!repo.variables.has(v)) return fail(404, what);
      if (method === 'PATCH') repo.variables.set(v, String(b.value));
      if (method === 'DELETE') repo.variables.delete(v);
      return method === 'GET' ? { name: v, value: repo.variables.get(v) } : undefined;
    }
    m = new RegExp(`^${R}/issues/(\\d+)/comments$`).exec(route);
    if (m?.[1]) {
      if (Number(q.get('page') ?? '1') > 1) return [];
      const issue = repo.issues.find((i) => i.number === Number(m?.[1]));
      return (issue?.comments ?? []).map((body, i) => ({ id: i + 1, node_id: `C_${i}`, user: { login: 'github-actions[bot]' }, body, created_at: '2026-11-14T00:00:00Z' }));
    }
    if (route === `${R}/issues`) {
      if (Number(q.get('page') ?? '1') > 1) return [];
      const label = q.get('labels') ?? '';
      return repo.issues.filter((i) => i.labels.includes(label)).map((i) => ({ number: i.number, labels: i.labels.map((n) => ({ name: n })) }));
    }
    if (route === `${R}/pulls`) {
      if (method === 'POST') {
        const pr = { number: nextPr++, head: String(b.head), base: String(b.base), title: String(b.title), body: String(b.body), state: 'open' as const };
        repo.pulls.push(pr);
        return { number: pr.number };
      }
      const [owner, head] = (q.get('head') ?? '').split(':');
      if (owner !== name.split('/')[0]) return [];
      return repo.pulls.filter((p) => p.state === 'open' && p.head === head).map((p) => ({ number: p.number }));
    }
    // A branch's head is `head-of-<branch>`; creating or moving a branch to one copies that branch's files.
    const at = (sha: unknown) => repo.branches.get(String(sha).replace(/^head-of-/, ''));
    m = new RegExp(`^${R}/git/ref/heads/(.+)$`).exec(route);
    if (m?.[1]) return repo.branches.has(m[1]) ? { object: { sha: `head-of-${m[1]}` } } : fail(404, what);
    if (route === `${R}/git/refs` && method === 'POST') {
      const branch = String(b.ref).replace('refs/heads/', '');
      const from = at(b.sha);
      if (repo.branches.has(branch) || !from) return fail(422, what);
      repo.branches.set(branch, new Map(from));
      return {};
    }
    m = new RegExp(`^${R}/git/refs/heads/(.+)$`).exec(route);
    if (m?.[1] && method === 'PATCH') {
      const from = at(b.sha);
      if (!from || b.force !== true) return fail(422, what);
      repo.branches.set(m[1], new Map(from));
      return {};
    }
    // The factory repo.
    m = new RegExp(`^/repos/${factoryName}/commits/(.+)$`).exec(route);
    if (m?.[1]) return factory.commits.has(m[1]) ? { sha: m[1] } : fail(422, what);
    m = new RegExp(`^/repos/${factoryName}/contents/(.+)$`).exec(route);
    if (m?.[1]) {
      const content = factory.commits.get(q.get('ref') ?? '')?.get(m[1]);
      return content === undefined ? fail(404, what) : { content: b64(content), sha: sha(content) };
    }
    throw new Error(`the fake GitHub has no ${what}`);
  }

  const host: Host = {
    gh: { repo: name, call },
    factory: { repo: factoryName, call },
    setSecret: async (n, value) => {
      writes.push(`secret ${n}`);
      repo.secrets.set(n, '***');
      secretValues.set(n, value);
    },
    scopes: async () => repo.scopes,
  };
  return { host, repo, factory, writes, secretValues };
}
