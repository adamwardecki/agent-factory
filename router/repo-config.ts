// The per-repo config, .github/factory.json on the default branch. Everything repo-specific the router and the stage
// jobs need comes from the RepoConfig this returns; nothing reads the JSON directly.

import { hasLevels, parseRoles, type Roles } from './authority.ts';
import { ConfigError, STAGE_WORKFLOWS, type StageWorkflow } from './config.ts';
import { isRecord, oneOf } from './util.ts';

export const AUTH_MODES = ['oauth_token', 'oidc'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type Limits = { maxRounds: number; maxRebases: number; maxAttempts: number; maxActive: number };
export type Commands = { install: string | null; test: string; lint: string | null; typecheck: string | null; testFile: string | null };

export type RepoConfig = {
  roles: Roles;
  defaultBranch: string;
  toolchain: { node: string | null; python: string | null };
  commands: Commands;
  riskyPaths: string[]; // the baseline, the toolchain's manifests, then the repo's own
  prSkill: string | null;
  models: Record<StageWorkflow, string>;
  maxTurns: Record<StageWorkflow, number>;
  limits: Limits;
};

// Files the agents load or run, and the factory's own files: a change to any of them waits for /approve before
// anything runs on the branch.
export const BASELINE_RISKY: readonly string[] = [
  '.github/**',
  '**/.claude/**',
  'AGENTS.md',
  '**/CLAUDE.md',
  '**/CLAUDE.local.md',
  '.mcp.json',
  '.claude.json',
  'docs/agents/**',
  'GLOSSARY*.md',
  'CONTEXT*.md',
  '**/docs/adr/**',
  '.factory/**',
  '.gitignore',
  '.gitmodules',
];

const TOOLCHAIN_RISKY = {
  node: ['**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/.npmrc'],
  python: ['**/pyproject.toml', '**/requirements*.txt', '**/poetry.lock', '**/uv.lock', '**/setup.py', '**/setup.cfg'],
};

const DEFAULT_MODELS: Record<StageWorkflow, string> = { plan: 'claude-opus-5-5', build: 'claude-sonnet-5-5', review: 'claude-opus-5-5', fix: 'claude-sonnet-5-5' };
const DEFAULT_TURNS: Record<StageWorkflow, number> = { plan: 60, build: 150, review: 60, fix: 100 };
const DEFAULT_LIMITS: Limits = { maxRounds: 3, maxRebases: 2, maxAttempts: 2, maxActive: 1 };

// C0 and C1 controls, DEL, and the two Unicode line separators.
const isControl = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
};

function optString(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(`${field} must be a non-empty string`);
  // These values become job outputs (`name=value` lines), prompts and workflow inputs. A newline would write another
  // output; any control character has no business in a name or a version.
  if ([...v].some(isControl)) throw new ConfigError(`${field} must not contain control characters or line breaks`);
  return v;
}

// Commands become Bash allow rules, the agents' Checks list and the verify job's steps; one line each, so a value
// can't smuggle a second command. There is no CI workflow setting: the factory runs these commands itself (verify),
// and the repo's own CI waits for a maintainer's approval on the PR.
function command(v: unknown, field: string, required: boolean): string | null {
  const s = optString(v, field);
  if (s === null) {
    if (required) throw new ConfigError(`${field} is required`);
    return null;
  }
  // Control characters (a NUL, a tab, a line separator) and edge whitespace have no place in a command, and the
  // check is what keeps a value from smuggling a second one.
  if ([...s].some(isControl) || s !== s.trim() || s.length > 200) {
    throw new ConfigError(`${field} must be one line of at most 200 characters, with no control characters or surrounding spaces`);
  }
  return s;
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function int(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${field} must be a whole number from ${min} to ${max}`);
  return v;
}

function perStage<T>(v: unknown, field: string, defaults: Record<StageWorkflow, T>, read: (x: unknown, f: string) => T): Record<StageWorkflow, T> {
  const out = { ...defaults };
  if (v === undefined) return out;
  if (!isRecord(v)) throw new ConfigError(`${field} must be an object`);
  for (const stage of STAGE_WORKFLOWS) if (v[stage] !== undefined) out[stage] = read(v[stage], `${field}.${stage}`);
  return out;
}

export function parseAuthMode(v: string | undefined): AuthMode {
  if (v === undefined || v === '') return 'oauth_token';
  if (!oneOf(AUTH_MODES, v)) throw new ConfigError(`the auth mode must be oauth_token or oidc, not ${JSON.stringify(v)}`);
  return v;
}

const TOP_FIELDS = ['$schema', 'version', 'roles', 'concurrency', 'defaultBranch', 'toolchain', 'commands', 'riskyPaths', 'prSkill', 'models', 'maxTurns', 'limits'];

// An optional section of the config. Missing is empty; anything but an object is an error, because ignoring
// `toolchain: "node"` would silently drop the node manifests from the risky paths.
function section(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const v = raw[name];
  if (v === undefined) return {};
  if (!isRecord(v)) throw new ConfigError(`${name} must be an object`);
  return v;
}

// An unknown field is an error, not something to ignore: riskypaths, spelled wrong, would silently remove a protection.
function onlyKnown(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ConfigError(`unknown field "${where}${key}"; the fields here are ${allowed.join(', ')}`);
  }
}

export function parseRepoConfig(raw: unknown, authMode: AuthMode = 'oauth_token'): RepoConfig {
  if (!isRecord(raw)) throw new ConfigError('factory.json must be a JSON object');
  // The old design had a CI workflow setting. The factory now runs its own verify stage, so say why it is gone.
  if (raw.ci !== undefined) throw new ConfigError('ci is not a setting: the factory runs its own verify stage with commands, and the repo\'s CI waits for a maintainer');
  onlyKnown(raw, [...TOP_FIELDS, 'preset', 'triageLabels'], '');
  if (raw.version === undefined) throw new ConfigError('factory.json version is missing (expected 1)');
  if (raw.version !== 1) throw new ConfigError(`factory.json version ${JSON.stringify(raw.version)} is not supported by this factory release (expected 1)`);
  if (isRecord(raw.roles)) onlyKnown(raw.roles, ['queue', 'approve'], 'roles.');
  const roles = parseRoles(raw.roles);
  // A level lets everyone who can push spend the credential; with a personal subscription that is one person's plan.
  if (authMode === 'oauth_token' && hasLevels(roles)) {
    throw new ConfigError('roles: permission levels (@write, @maintain, @admin) need the oidc auth mode; with a subscription token, list logins');
  }
  const toolchain = section(raw, 'toolchain');
  if (!isRecord(raw.commands)) throw new ConfigError('commands must be an object with at least test');
  const c = raw.commands;
  onlyKnown(c, ['install', 'test', 'lint', 'typecheck', 'testFile', 'extra'], 'commands.');
  onlyKnown(toolchain, ['node', 'python', 'go'], 'toolchain.');
  // Settings a later release adds. Ignoring one silently would leave the repo believing it was in force.
  for (const [field, value] of [['preset', raw.preset], ['triageLabels', raw.triageLabels], ['commands.extra', c.extra], ['toolchain.go', toolchain.go]] as const) {
    if (value !== undefined) throw new ConfigError(`${field} is not supported by this factory release yet; remove it`);
  }
  if (raw.riskyPaths !== undefined && (!Array.isArray(raw.riskyPaths) || !raw.riskyPaths.every((p) => typeof p === 'string' && p !== ''))) {
    throw new ConfigError('riskyPaths must be a list of path globs');
  }
  const own = Array.isArray(raw.riskyPaths) ? raw.riskyPaths.filter((p): p is string => typeof p === 'string') : [];
  const node = optString(toolchain.node, 'toolchain.node');
  const python = optString(toolchain.python, 'toolchain.python');
  const limits = section(raw, 'limits');
  const concurrency = section(raw, 'concurrency');
  onlyKnown(limits, ['maxRounds', 'maxRebases', 'maxAttempts'], 'limits.');
  onlyKnown(concurrency, ['maxActive'], 'concurrency.');
  for (const field of ['models', 'maxTurns']) onlyKnown(section(raw, field), STAGE_WORKFLOWS, `${field}.`);
  // The admission queue handles any cap; running more than one issue at once is switched on in phase 4, once one
  // at a time has merged a PR.
  if (concurrency.maxActive !== undefined && concurrency.maxActive !== 1) {
    throw new ConfigError('concurrency.maxActive above 1 is not supported by this factory release yet; leave it out or set 1');
  }
  return {
    roles,
    defaultBranch: optString(raw.defaultBranch, 'defaultBranch') ?? 'main',
    toolchain: { node, python },
    commands: {
      install: command(c.install, 'commands.install', false),
      test: command(c.test, 'commands.test', true) ?? '',
      lint: command(c.lint, 'commands.lint', false),
      typecheck: command(c.typecheck, 'commands.typecheck', false),
      testFile: command(c.testFile, 'commands.testFile', false),
    },
    riskyPaths: [...BASELINE_RISKY, ...(node ? TOOLCHAIN_RISKY.node : []), ...(python ? TOOLCHAIN_RISKY.python : []), ...own],
    prSkill: optString(raw.prSkill, 'prSkill'),
    models: perStage(raw.models, 'models', DEFAULT_MODELS, (x, f) => optString(x, f) ?? fail(`${f} must be a non-empty string`)),
    maxTurns: perStage(raw.maxTurns, 'maxTurns', DEFAULT_TURNS, (x, f) => int(x, f, 1, 500, 1)),
    limits: {
      maxRounds: int(limits.maxRounds, 'limits.maxRounds', 1, 10, DEFAULT_LIMITS.maxRounds),
      maxRebases: int(limits.maxRebases, 'limits.maxRebases', 1, 10, DEFAULT_LIMITS.maxRebases),
      maxAttempts: int(limits.maxAttempts, 'limits.maxAttempts', 1, 5, DEFAULT_LIMITS.maxAttempts),
      maxActive: DEFAULT_LIMITS.maxActive,
    },
  };
}
