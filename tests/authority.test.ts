import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMAND_ROLES, createAuthority, hasLevels, holdsAny, parseRoles, parseSelectors } from '../router/authority.ts';

test('a role accepts logins and write-or-above permission levels', () => {
  assert.deepEqual(parseSelectors(['alice', '@maintain'], 'roles.queue'), [{ login: 'alice' }, { level: 'maintain' }]);
  assert.deepEqual(parseSelectors(['@write', '@admin'], 'roles.queue'), [{ level: 'write' }, { level: 'admin' }]);
});

test('a role rejects empty lists, read and triage levels, bots and malformed entries', () => {
  assert.throws(() => parseSelectors([], 'roles.queue'), /roles\.queue/);
  assert.throws(() => parseSelectors('alice', 'roles.queue'), /roles\.queue/);
  assert.throws(() => parseSelectors(['@read'], 'roles.approve'), /roles\.approve: @read/);
  assert.throws(() => parseSelectors(['@triage'], 'roles.queue'), /@triage/);
  assert.throws(() => parseSelectors(['@org/team'], 'roles.queue'), /@org\/team/);
  assert.throws(() => parseSelectors(['not a login'], 'roles.queue'), /not a login/);
  assert.throws(() => parseSelectors(['renovate[bot]'], 'roles.queue'), /renovate/);
  assert.throws(() => parseSelectors(['github-actions'], 'roles.queue'), /bot/);
  assert.throws(() => parseSelectors(['GitHub-Actions'], 'roles.approve'), /bot/);
});

test('queue is required and approve defaults to it', () => {
  assert.deepEqual(parseRoles({ queue: ['alice'] }), { queue: [{ login: 'alice' }], approve: [{ login: 'alice' }] });
  assert.deepEqual(parseRoles({ queue: ['alice', 'bob'], approve: ['alice'] }).approve, [{ login: 'alice' }]);
  assert.throws(() => parseRoles(undefined), /roles/);
  assert.throws(() => parseRoles({ approve: ['alice'] }), /roles\.queue/);
  assert.equal(hasLevels(parseRoles({ queue: ['alice'] })), false);
  assert.equal(hasLevels(parseRoles({ queue: ['alice'], approve: ['@admin'] })), true);
});

const repoRoles: Record<string, string> = { bob: 'write', carol: 'maintain', dave: 'triage', erin: 'admin' };
function lookups() {
  const asked: string[] = [];
  const role = async (login: string) => {
    asked.push(login);
    return repoRoles[login] ?? null;
  };
  return { asked, role };
}

test('a listed login holds its role without a permission lookup', async () => {
  const l = lookups();
  const a = createAuthority(parseRoles({ queue: ['Alice', 'bob'], approve: ['alice'] }), l.role);
  assert.equal(await a.check('queue', 'alice'), true);
  assert.equal(await a.check('approve', 'alice'), true);
  assert.equal(await a.check('queue', 'bob'), true);
  assert.equal(await a.check('approve', 'bob'), false, 'queue does not imply approve');
  assert.equal(await a.check('queue', 'mallory'), false);
  assert.deepEqual(l.asked, []);
  assert.equal(a.reviewer, 'alice');
});

test('a permission level counts that level and above, looked up once per login', async () => {
  const l = lookups();
  const a = createAuthority(parseRoles({ queue: ['@write'], approve: ['@maintain'] }), l.role);
  assert.equal(await a.check('queue', 'bob'), true);
  assert.equal(await a.check('approve', 'bob'), false);
  assert.equal(await a.check('approve', 'carol'), true);
  assert.equal(await a.check('approve', 'erin'), true);
  assert.equal(await a.check('queue', 'dave'), false);
  assert.equal(await a.check('queue', 'carol'), true);
  assert.deepEqual(l.asked, ['bob', 'carol', 'erin', 'dave']);
  assert.equal(a.known('approve', 'carol'), true);
  assert.equal(a.known('approve', 'bob'), false);
  assert.equal(a.known('queue', 'zed'), false, 'never looked up');
  assert.equal(a.reviewer, null);
});

test('bots never count, even with admin access', async () => {
  const a = createAuthority(parseRoles({ queue: ['@write'] }), async () => 'admin');
  assert.equal(await a.check('queue', 'github-actions[bot]'), false);
  assert.equal(await a.check('queue', 'github-actions'), false);
  assert.equal(await a.check('approve', 'renovate[bot]'), false);
  assert.equal(await a.check('queue', ''), false);
});

test('each command has its roles: only approve may /approve, either may /stop', async () => {
  const a = createAuthority(parseRoles({ queue: ['alice', 'bob'], approve: ['alice'] }), async () => null);
  assert.equal(await holdsAny(a, COMMAND_ROLES.approve, 'bob'), false);
  assert.equal(await holdsAny(a, COMMAND_ROLES.approve, 'alice'), true);
  assert.equal(await holdsAny(a, COMMAND_ROLES.stop, 'bob'), true);
  assert.equal(await holdsAny(a, COMMAND_ROLES.retry, 'bob'), true);
  assert.equal(await holdsAny(a, COMMAND_ROLES.stop, 'mallory'), false);
});
