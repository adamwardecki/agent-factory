// Reads and writes on the target repo that more than one command needs: labels, variables, secrets, the callers'
// pin, the issues in flight, and the pull request every file change goes through.

import { LABEL_PREFIX, ROUTER_WORKFLOW_FILE, STAGE_WORKFLOW_FILE, STAGES, stageLabel, TRIAGE_READY, TRIAGE_STOP } from '../router/config.ts';
import { defaultBranch, type Gh, GitHubError, openIssuesWithLabel, paged, readRepoFile } from '../router/github.ts';
import { dig, num, rows, str } from '../router/json.ts';

// Every label the factory sets: a stage label for each stage but done (done carries none), and the planner's three.
export const FACTORY_LABELS: readonly string[] = [...STAGES.filter((s) => s !== 'done').map(stageLabel), TRIAGE_READY, ...TRIAGE_STOP];
export const CALLER_PATHS = [ROUTER_WORKFLOW_FILE, STAGE_WORKFLOW_FILE].map((f) => `.github/workflows/${f}`);
export const SIGNING_SECRET = 'FACTORY_SIGNING_KEY';
export const CLAUDE_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';

const notFound = (err: unknown) => err instanceof GitHubError && err.status === 404;

export async function labelNames(gh: Gh): Promise<string[]> {
  return (await paged(gh, `/repos/${gh.repo}/labels`)).map((l) => str(dig(l, 'name')));
}

// The factory labels the repo lacks, and those it has only in another case. GitHub treats label names without regard
// to case, so it refuses to create `ready-for-agent` next to `Ready-For-Agent`; the router matches them exactly.
export function labelProblems(have: readonly string[]): { missing: string[]; wrongCase: [string, string][] } {
  const exact = new Set(have);
  const lower = new Map(have.map((l) => [l.toLowerCase(), l]));
  const missing: string[] = [];
  const wrongCase: [string, string][] = [];
  for (const l of FACTORY_LABELS) {
    if (exact.has(l)) continue;
    const other = lower.get(l.toLowerCase());
    if (other) wrongCase.push([other, l]);
    else missing.push(l);
  }
  return { missing, wrongCase };
}

export const wrongCaseMessage = ([have, want]: [string, string]) => `the label "${have}" differs only in case from "${want}"; rename it to "${want}", because the factory matches labels exactly`;

export async function createLabel(gh: Gh, name: string): Promise<void> {
  const color = name.startsWith(LABEL_PREFIX) ? '5319e7' : 'c5def5';
  await gh.call('POST', `/repos/${gh.repo}/labels`, { name, color });
}

export async function secretNames(gh: Gh): Promise<string[]> {
  return rows(dig(await gh.call('GET', `/repos/${gh.repo}/actions/secrets?per_page=100`), 'secrets')).map((s) => str(dig(s, 'name')));
}

// An Actions variable's value; null when it isn't set.
export async function getVariable(gh: Gh, name: string): Promise<string | null> {
  try {
    return str(dig(await gh.call('GET', `/repos/${gh.repo}/actions/variables/${name}`), 'value'));
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

export async function setVariable(gh: Gh, name: string, value: string): Promise<void> {
  try {
    await gh.call('PATCH', `/repos/${gh.repo}/actions/variables/${name}`, { name, value });
  } catch (err) {
    if (!notFound(err)) throw err;
    await gh.call('POST', `/repos/${gh.repo}/actions/variables`, { name, value });
  }
}

export async function deleteVariable(gh: Gh, name: string): Promise<void> {
  try {
    await gh.call('DELETE', `/repos/${gh.repo}/actions/variables/${name}`);
  } catch (err) {
    if (!notFound(err)) throw err;
  }
}

// Open issues carrying any stage label. Each has a signed state comment, which a new signing key would no longer
// verify.
export async function issuesInFlight(gh: Gh): Promise<number[]> {
  const out = new Set<number>();
  for (const s of STAGES) if (s !== 'done') for (const n of await openIssuesWithLabel(gh, stageLabel(s))) out.add(n);
  return [...out].sort((a, b) => a - b);
}

// What a rendered caller pins. Read as text: the CLI has no YAML parser, so this matches the lines the templates write.
export type Pin = { factoryRepo: string; sha: string; interface: number | null; cron: string | null };
export function parsePin(text: string): Pin | null {
  const uses = /uses: ([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/\.github\/workflows\/[a-z-]+\.yml@([0-9a-f]{40})/.exec(text);
  if (!uses?.[1] || !uses[2]) return null;
  const iface = /^\s+interface: (\d+)\s*$/m.exec(text);
  const cron = /^\s+- cron: '([^']+)'\s*$/m.exec(text);
  return { factoryRepo: uses[1], sha: uses[2], interface: iface?.[1] ? Number(iface[1]) : null, cron: cron?.[1] ?? null };
}

// The interface and state versions of a factory release, read from the release itself.
export async function releaseVersions(factory: Gh, sha: string): Promise<{ interface: number; state: number }> {
  const config = await readRepoFile(factory, 'router/config.ts', sha);
  const iface = config && /^export const CALLER_INTERFACE = (\d+);/m.exec(config);
  const state = config && /^export const STATE_VERSION = (\d+);/m.exec(config);
  // Releases before the constant existed all speak interface 1.
  return { interface: iface?.[1] ? Number(iface[1]) : 1, state: state?.[1] ? Number(state[1]) : 1 };
}

export async function commitExists(factory: Gh, sha: string): Promise<boolean> {
  try {
    await factory.call('GET', `/repos/${factory.repo}/commits/${sha}`);
    return true;
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) return false;
    throw err;
  }
}

export type FileChange = { path: string; content: string };

// The open PR from a branch of this repo; null when there is none.
export async function openPullFrom(gh: Gh, branch: string): Promise<number | null> {
  const owner = gh.repo.split('/')[0] ?? '';
  const prs = rows(await gh.call('GET', `/repos/${gh.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`));
  return num(dig(prs[0], 'number'));
}

// The files whose content on the default branch differs from what's wanted.
export async function changedFiles(gh: Gh, base: string, files: readonly FileChange[]): Promise<FileChange[]> {
  const out: FileChange[] = [];
  for (const f of files) if ((await readRepoFile(gh, f.path, base)) !== f.content) out.push(f);
  return out;
}

// One pull request with these files, on `branch`, from the default branch's head. A branch left over without an
// open PR is reset first. Returns the PR number; an open PR from the branch is returned as it is, unchanged.
export async function proposeFiles(gh: Gh, branch: string, files: readonly FileChange[], title: string, body: string): Promise<{ pr: number; created: boolean }> {
  const open = await openPullFrom(gh, branch);
  if (open !== null) return { pr: open, created: false };
  const base = await defaultBranch(gh);
  const head = str(dig(await gh.call('GET', `/repos/${gh.repo}/git/ref/heads/${base}`), 'object', 'sha'));
  try {
    await gh.call('POST', `/repos/${gh.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  } catch (err) {
    // 422: the branch exists. Nothing open uses it, so it starts again from the default branch.
    if (!(err instanceof GitHubError && err.status === 422)) throw err;
    await gh.call('PATCH', `/repos/${gh.repo}/git/refs/heads/${branch}`, { sha: head, force: true });
  }
  for (const f of files) {
    let sha: string | undefined;
    try {
      sha = str(dig(await gh.call('GET', `/repos/${gh.repo}/contents/${f.path}?ref=${encodeURIComponent(branch)}`), 'sha')) || undefined;
    } catch (err) {
      if (!notFound(err)) throw err;
    }
    await gh.call('PUT', `/repos/${gh.repo}/contents/${f.path}`, {
      message: `${sha ? 'Update' : 'Add'} ${f.path}`,
      content: Buffer.from(f.content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    });
  }
  const pr = num(dig(await gh.call('POST', `/repos/${gh.repo}/pulls`, { title, body, head: branch, base }), 'number'));
  if (pr === null) throw new Error('GitHub did not return the new pull request number');
  return { pr, created: true };
}
