import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASELINE_RISKY, parseAuthMode, parseRepoConfig } from '../router/repo-config.ts';

const minimal = { version: 1, roles: { queue: ['alice'] }, commands: { test: 'npm test' } };

test('a minimal config gets the defaults', () => {
  const c = parseRepoConfig(minimal);
  assert.deepEqual(c.roles, { queue: [{ login: 'alice' }], approve: [{ login: 'alice' }] });
  assert.equal(c.defaultBranch, 'main');
  assert.deepEqual(c.commands, { install: null, test: 'npm test', lint: null, typecheck: null, testFile: null });
  assert.deepEqual(c.limits, { maxRounds: 3, maxRebases: 2, maxAttempts: 2, maxActive: 1 });
  assert.equal(c.models.plan, 'claude-opus-5-5');
  assert.equal(c.maxTurns.build, 150);
  assert.equal(c.prSkill, null);
  assert.deepEqual(c.toolchain, { node: null, python: null });
  assert.deepEqual(c.riskyPaths, BASELINE_RISKY);
});

test('every field can be set', () => {
  const c = parseRepoConfig({
    ...minimal,
    roles: { queue: ['alice', 'bob'], approve: ['alice'] },
    defaultBranch: 'trunk',
    toolchain: { node: '24.x' },
    commands: { install: 'npm ci', test: 'npm test', lint: 'npm run lint', typecheck: 'npm run typecheck', testFile: 'node --test' },
    riskyPaths: ['src/db/**'],
    prSkill: '.claude/skills/create-pr',
    models: { review: 'claude-sonnet-5-5' },
    maxTurns: { fix: 80 },
    limits: { maxRounds: 4 },
    concurrency: { maxActive: 1 },
  });
  assert.equal(c.defaultBranch, 'trunk');
  assert.deepEqual(c.roles.approve, [{ login: 'alice' }]);
  assert.equal(c.models.review, 'claude-sonnet-5-5');
  assert.equal(c.models.build, 'claude-sonnet-5-5');
  assert.equal(c.maxTurns.fix, 80);
  assert.deepEqual(c.limits, { maxRounds: 4, maxRebases: 2, maxAttempts: 2, maxActive: 1 });
  assert.ok(c.riskyPaths.includes('src/db/**'));
  assert.ok(c.riskyPaths.includes('**/package-lock.json'), 'a node toolchain adds its manifests and lockfiles');
});

test('invalid configs name the field', () => {
  assert.throws(() => parseRepoConfig(null), /JSON object/);
  assert.throws(() => parseRepoConfig({ ...minimal, version: 2 }), /version 2/);
  assert.throws(() => parseRepoConfig({ ...minimal, roles: { queue: [] } }), /roles\.queue/);
  assert.throws(() => parseRepoConfig({ ...minimal, roles: undefined, maintainers: ['alice'] }), /roles/);
  assert.throws(() => parseRepoConfig({ ...minimal, commands: {} }), /commands\.test/);
  assert.throws(() => parseRepoConfig({ ...minimal, commands: { test: 'npm test\nrm -rf /' } }), /commands\.test/);
  assert.throws(() => parseRepoConfig({ ...minimal, limits: { maxRounds: 0 } }), /limits\.maxRounds/);
  assert.throws(() => parseRepoConfig({ ...minimal, riskyPaths: ['ok', 3] }), /riskyPaths/);
});

test('what later phases switch on is refused for now, with the reason', () => {
  assert.throws(() => parseRepoConfig({ ...minimal, concurrency: { maxActive: 2 } }), /maxActive above 1/);
  assert.throws(() => parseRepoConfig({ ...minimal, roles: { queue: ['@write'] } }), /need the oidc auth mode/);
  assert.deepEqual(parseRepoConfig({ ...minimal, roles: { queue: ['@write'] } }, 'oidc').roles.queue, [{ level: 'write' }]);
  assert.throws(() => parseRepoConfig({ ...minimal, preset: 'node' }), /preset is not supported/);
  assert.throws(() => parseRepoConfig({ ...minimal, triageLabels: {} }), /triageLabels is not supported/);
  assert.throws(() => parseRepoConfig({ ...minimal, commands: { test: 'npm test', extra: ['npm run x'] } }), /commands\.extra is not supported/);
  assert.equal(parseAuthMode(undefined), 'oauth_token');
  assert.equal(parseAuthMode('oidc'), 'oidc');
  assert.throws(() => parseAuthMode('api_key'), /auth mode/);
});
