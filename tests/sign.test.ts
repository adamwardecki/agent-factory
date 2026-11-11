import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, check, keyId, sign, verify } from '../router/sign.ts';

const KEY = 'k'.repeat(64);

test('a signed body verifies for its issue and kind only', () => {
  const body = sign(KEY, 7, 'brief', '<!-- factory:brief v1 -->\nDo the thing.');
  assert.match(body, /\n<!-- factory:sig [0-9a-f]{8}\.[0-9a-f]{64} -->$/);
  assert.ok(body.includes(`factory:sig ${keyId(KEY)}.`));
  assert.equal(verify(KEY, 7, 'brief', body), true);
  assert.equal(check(KEY, 8, 'brief', body), 'bad');
  assert.equal(check(KEY, 7, 'review', body), 'bad');
});

test('any edit to the text breaks the signature', () => {
  const body = sign(KEY, 7, 'state', 'stage: building');
  assert.equal(check(KEY, 7, 'state', body.replace('building', 'ready')), 'bad');
});

test('a body signed with another key is told apart from a tampered one', () => {
  const body = sign(KEY, 7, 'state', 'stage: building');
  assert.equal(check('x'.repeat(64), 7, 'state', body), 'retired-key');
  assert.equal(verify('x'.repeat(64), 7, 'state', body), false);
});

test('GitHub line endings and trailing whitespace do not break it', () => {
  const body = sign(KEY, 7, 'review', 'line one  \nline two\n\n');
  assert.equal(verify(KEY, 7, 'review', `${body.replace(/\n/g, '\r\n')}\r\n`), true);
  assert.equal(canonical('a  \r\nb\t\n\n'), 'a\nb');
  assert.equal(canonical(body), 'line one\nline two', 'canonical drops the signature line');
});

test('unsigned and malformed bodies fail', () => {
  assert.equal(check(KEY, 7, 'brief', 'no signature'), 'unsigned');
  assert.equal(check(KEY, 7, 'brief', 'x\n<!-- factory:sig zz -->'), 'unsigned');
  assert.throws(() => sign('short', 7, 'brief', 'x'), /FACTORY_SIGNING_KEY/);
  assert.equal(check('short', 7, 'brief', sign(KEY, 7, 'brief', 'x')), 'bad', 'a key that is too short never verifies');
});
