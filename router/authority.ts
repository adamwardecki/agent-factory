// Who may drive the factory. roles in factory.json has two lists, because they are different powers:
//   queue    spends the Claude credential and steers agents: add agent:queued, /retry, /stop, request changes, and
//            write the PR comments the fixer reads;
//   approve  is a security decision: /approve a risky plan or diff (and /stop).
// Each list holds GitHub logins and permission levels. A level is checked against the actor's permission on the repo
// at the time of each event, so someone removed from the repo stops counting at once.

import { ConfigError } from './config.ts';
import type { Command } from './markers.ts';
import { isRecord, oneOf } from './util.ts';

export const ROLES = ['queue', 'approve'] as const;
export type Role = (typeof ROLES)[number];

export const LEVELS = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
export type Level = (typeof LEVELS)[number];
export type Selector = { login: string } | { level: Level };
export type Roles = Record<Role, Selector[]>;

// The roles that may give each command. Anyone who may start work or approve it may stop it.
export const COMMAND_ROLES: Record<Command, readonly Role[]> = { approve: ['approve'], stop: ['queue', 'approve'], retry: ['queue'] };

// Read is open to everyone on a public repo, and triage cannot push; neither may queue work or approve a risky diff.
const ALLOWED_LEVELS: readonly Level[] = ['write', 'maintain', 'admin'];
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function parseSelectors(v: unknown, field: string): Selector[] {
  if (!Array.isArray(v) || v.length === 0) throw new ConfigError(`${field} must be a non-empty list of GitHub logins or @write, @maintain, @admin`);
  return v.map((entry): Selector => {
    if (typeof entry !== 'string') throw new ConfigError(`${field}: ${JSON.stringify(entry)} is not a string`);
    if (entry.startsWith('@')) {
      const level = entry.slice(1);
      if (!oneOf(LEVELS, level) || !ALLOWED_LEVELS.includes(level)) throw new ConfigError(`${field}: ${entry} is not allowed; use @write, @maintain or @admin`);
      return { level };
    }
    if (!LOGIN.test(entry)) throw new ConfigError(`${field}: ${JSON.stringify(entry)} is not a GitHub login`);
    return { login: entry };
  });
}

// roles.queue is required; roles.approve defaults to the same list, so a solo repo writes one.
export function parseRoles(v: unknown): Roles {
  if (!isRecord(v)) throw new ConfigError('roles must be an object with a queue list (and optionally an approve list)');
  const queue = parseSelectors(v.queue, 'roles.queue');
  return { queue, approve: v.approve === undefined ? queue : parseSelectors(v.approve, 'roles.approve') };
}

export const hasLevels = (roles: Roles): boolean => ROLES.some((r) => roles[r].some((s) => 'level' in s));

// GitHub's repo role for a login (read, triage, write, maintain, admin), or null when the account has no access.
export type RoleLookup = (login: string) => Promise<string | null>;

export type Authority = {
  // Whether this login holds the role; looks its permission up when a level is configured, once per run.
  check(role: Role, login: string): Promise<boolean>;
  // Whether a login already checked in this run holds the role. decide.ts is synchronous and uses this; main.ts
  // checks every actor it passes in first.
  known(role: Role, login: string): boolean;
  // Who is asked to review a ready PR when the state doesn't say who queued it: the first plain login in approve,
  // then in queue.
  reviewer: string | null;
};

// Another workflow or App must never drive the factory, whatever its permission.
export const isBot = (login: string): boolean => login === '' || login.endsWith('[bot]') || login === 'github-actions';

export function createAuthority(roles: Roles, lookup: RoleLookup): Authority {
  const logins = (r: Role) => new Set(roles[r].flatMap((s) => ('login' in s ? [s.login.toLowerCase()] : [])));
  const minLevel = (r: Role) => {
    const levels = roles[r].flatMap((s) => ('level' in s ? [LEVELS.indexOf(s.level)] : []));
    return levels.length > 0 ? Math.min(...levels) : null;
  };
  const listed: Record<Role, Set<string>> = { queue: logins('queue'), approve: logins('approve') };
  const min: Record<Role, number | null> = { queue: minLevel('queue'), approve: minLevel('approve') };
  const needsLookup = hasLevels(roles);
  // The login's level on the repo as an index into LEVELS, or -1 without access.
  const levelOf = new Map<string, number>();

  function known(role: Role, login: string): boolean {
    const key = login.toLowerCase();
    if (isBot(key)) return false;
    if (listed[role].has(key)) return true;
    const m = min[role];
    const have = levelOf.get(key);
    return m !== null && have !== undefined && have >= m;
  }
  async function check(role: Role, login: string): Promise<boolean> {
    const key = login.toLowerCase();
    if (!isBot(key) && needsLookup && !levelOf.has(key)) {
      const r = await lookup(login);
      levelOf.set(key, oneOf(LEVELS, r) ? LEVELS.indexOf(r) : -1);
    }
    return known(role, login);
  }
  const first = (r: Role) => roles[r].find((s): s is { login: string } => 'login' in s)?.login ?? null;
  return { check, known, reviewer: first('approve') ?? first('queue') };
}

// Whether the login holds any of the roles. Looks it up first.
export async function holdsAny(a: Authority, roles: readonly Role[], login: string): Promise<boolean> {
  for (const r of roles) if (await a.check(r, login)) return true;
  return false;
}
