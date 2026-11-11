import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthority, parseRoles } from '../router/authority.ts';
import type { Comment, Edit } from '../router/github.ts';
import { renderState, withAttempt } from '../router/markers.ts';
import { sign } from '../router/sign.ts';
import { briefFrom, changesRequestedFrom, commandFrom, reviewFrom, stateFrom } from '../router/snapshot.ts';

const KEY = 'k'.repeat(64);
const OLD_KEY = 'o'.repeat(64);
const BOT = 'github-actions[bot]';
const state = { stage: 'ci' as const, since: '2026-11-09T11:00:00.000Z', round: 0, attempts: 0, runs: [], attempt: 'mhs1abc' };
const c = (id: number, author: string, body: string, at = '2026-11-09T11:00:00Z'): Comment => ({ id, nodeId: `n${id}`, author, body, at });
const unedited: Edit = { editor: null, lastEditedAt: null };
const none = { found: null, retiredKey: false, newer: false };

test('state counts only from the router with a valid signature for this issue', () => {
  const good = c(1, BOT, sign(KEY, 7, 'state', renderState(state)));
  assert.deepEqual(stateFrom([good], 7, KEY), { found: { id: 1, state }, retiredKey: false, newer: false });
  assert.deepEqual(stateFrom([good], 8, KEY), none);
  assert.deepEqual(stateFrom([c(2, BOT, renderState(state))], 7, KEY), none, 'unsigned');
  assert.deepEqual(stateFrom([c(3, 'mallory', good.body)], 7, KEY), none, 'wrong author');
  assert.deepEqual(stateFrom([c(4, BOT, good.body.replace('"ci"', '"ready"'))], 7, KEY), none, 'edited');
});

test('a forged state comment after the real one does not hide it', () => {
  const good = c(1, BOT, sign(KEY, 7, 'state', renderState(state)));
  const forged = c(2, BOT, renderState({ ...state, stage: 'ready' }));
  assert.equal(stateFrom([good, forged], 7, KEY).found?.id, 1);
});

test('state signed with a replaced key is reported as that, not as missing', () => {
  const old = c(1, BOT, sign(OLD_KEY, 7, 'state', renderState(state)));
  assert.deepEqual(stateFrom([old], 7, KEY), { found: null, retiredKey: true, newer: false });
});

test('state written by a newer release is reported as that', () => {
  const newer = c(1, BOT, sign(KEY, 7, 'state', renderState(state).replace('"v":1', '"v":2')));
  assert.deepEqual(stateFrom([newer], 7, KEY), { found: null, retiredKey: false, newer: true });
});

test('a brief counts only when signed, and carries its attempt', () => {
  const body = '<!-- factory:brief v1 -->\n## Agent Brief\n\n**Touches:**\n- `docs/a.md`';
  const signed = c(9, BOT, sign(KEY, 7, 'brief', withAttempt(body, 'mhs1abc')));
  assert.deepEqual(briefFrom([signed], 7, KEY), { id: 9, touches: ['docs/a.md'], at: signed.at, attempt: 'mhs1abc' });
  assert.equal(briefFrom([c(9, BOT, body)], 7, KEY), null);
});

test('a review counts only when signed, and carries the commit and attempt it was stamped with', () => {
  const body = '<!-- factory:review {"blocking":0,"nits":1,"sha":"abc","attempt":"mhs1abc"} -->\nFine.';
  const r = (b: string, author = BOT) => ({ nodeId: 'r', author, body: b, at: '2026-11-09T11:20:00Z', state: 'COMMENTED' });
  assert.deepEqual(reviewFrom([r(sign(KEY, 7, 'review', body))], 7, KEY), { blocking: 0, at: '2026-11-09T11:20:00Z', sha: 'abc', attempt: 'mhs1abc' });
  assert.equal(reviewFrom([r(body)], 7, KEY), null, 'unsigned');
  assert.equal(reviewFrom([r(sign(KEY, 7, 'review', body), 'mallory')], 7, KEY), null, 'wrong author');
});

test('a command counts from someone with its role, unedited or edited by someone with that role', async () => {
  const a = createAuthority(parseRoles({ queue: ['alice', 'bob'], approve: ['alice'] }), async () => null);
  const edits = (ids: number[]) => new Map<string, Edit>(ids.map((i) => [`n${i}`, unedited]));
  const bobApproves = [c(1, 'alice', '/stop', '2026-11-09T10:00:00Z'), c(2, 'bob', '/approve', '2026-11-09T12:00:00Z'), c(3, 'mallory', '/retry', '2026-11-09T13:00:00Z')];
  assert.deepEqual(await commandFrom(bobApproves, edits([1, 2, 3]), a), { command: 'stop', at: '2026-11-09T10:00:00Z', actor: 'alice' }, 'bob may queue, not approve');
  const bobRetries = [c(1, 'alice', '/stop', '2026-11-09T10:00:00Z'), c(2, 'bob', '/retry', '2026-11-09T12:00:00Z')];
  assert.deepEqual(await commandFrom(bobRetries, edits([1, 2]), a), { command: 'retry', at: '2026-11-09T12:00:00Z', actor: 'bob' });
  const tampered = edits([1, 2]).set('n2', { editor: 'mallory', lastEditedAt: '2026-11-09T12:30:00Z' });
  assert.equal((await commandFrom(bobRetries, tampered, a))?.actor, 'alice');
  assert.equal(await commandFrom(bobRetries, new Map(), a), null, 'a comment whose edit history was not looked up counts as edited');
});

test('changes requested count from the queue role only', async () => {
  const a = createAuthority(parseRoles({ queue: ['alice'] }), async () => null);
  const r = (author: string, at: string) => ({ nodeId: author, author, body: '', at, state: 'CHANGES_REQUESTED' });
  assert.deepEqual(await changesRequestedFrom([r('alice', '2026-11-09T10:00:00Z'), r('mallory', '2026-11-09T11:00:00Z')], a), { at: '2026-11-09T10:00:00Z', actor: 'alice' });
});
