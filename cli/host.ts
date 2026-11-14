// What the CLI needs from the outside world, behind one type so the tests can hand in a fake. The real host takes
// the token of the logged-in `gh` and talks to the REST API with the router's own client: the same calls, the same
// errors, the same status codes. Two things go through `gh` itself: secrets, which the API only accepts encrypted
// with the repo's public key (Node has no sealed box), and the token.

import { execFileSync, spawnSync } from 'node:child_process';
import { client, type Gh } from '../router/github.ts';

export type Host = {
  // The REST API on the target repo, and on the factory repo the callers pin.
  gh: Gh;
  factory: Gh;
  // Sets an Actions secret. The value goes to `gh` on stdin, never in argv, where other users' `ps` would see it.
  setSecret: (name: string, value: string) => Promise<void>;
  // The classic token scopes GitHub reports for the token; null when it reports none (a fine-grained token).
  scopes: () => Promise<string[] | null>;
};

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function checkRepo(repo: string): string {
  if (!REPO.test(repo)) throw new Error(`not an owner/repo: ${JSON.stringify(repo)}`);
  return repo;
}

// The factory repo from the clone's origin remote, in either of the forms git prints.
export function repoFromRemote(url: string): string {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m?.[1]) throw new Error(`the origin remote ${JSON.stringify(url.trim())} is not a GitHub repo; pass --factory <owner/repo>`);
  return checkRepo(m[1]);
}

export function realHost(repo: string, factoryRepo: string): Host {
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  if (!token) throw new Error('gh is not logged in: run `gh auth login`');
  return {
    gh: client(token, checkRepo(repo)),
    factory: client(token, checkRepo(factoryRepo)),
    setSecret: async (name, value) => {
      const r = spawnSync('gh', ['secret', 'set', name, '--repo', repo, '--app', 'actions'], { input: value, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`gh secret set ${name} failed: ${(r.stderr || r.stdout).trim()}`);
    },
    scopes: async () => {
      const res = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } });
      const header = res.headers.get('x-oauth-scopes');
      return header === null ? null : header.split(',').map((s) => s.trim()).filter(Boolean);
    },
  };
}
