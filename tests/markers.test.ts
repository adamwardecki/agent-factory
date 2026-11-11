import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRIEF_MARKER,
  type FactoryState,
  parseBriefTouches,
  parseCommand,
  parseReview,
  parseState,
  renderState,
} from '../router/markers.ts';

const STATE: FactoryState = {
  stage: 'fixing',
  since: '2026-11-09T11:00:00.000Z',
  round: 2,
  attempts: 1,
  pr: 51,
  brief: 900,
  headSha: 'abc',
  fixReason: 'review',
  runs: ['https://example.test/runs/1'],
};

const marker = (v: Record<string, unknown>) => `<!-- factory:state ${JSON.stringify({ stage: 'ci', since: '2026-11-09T11:00:00.000Z', round: 0, attempts: 0, runs: [], ...v })} -->`;

test('blocked states round-trip with their reason and rebase count', () => {
  const blocked: FactoryState = { ...STATE, stage: 'blocked', blockedFrom: 'ready', blockedFor: 'rebases', rebases: 2 };
  assert.deepEqual(parseState(renderState(blocked)), blocked);
  const odd = parseState(marker({ blockedFor: 'boredom', rebases: -1 }));
  assert.equal(odd?.blockedFor, undefined);
  assert.equal(odd?.rebases, undefined);
});

test('a state whose since is not a time is rejected; an unreadable failedAt is dropped', () => {
  // A since that does not parse would make every age check NaN, and the issue would never retry or count as stuck.
  assert.equal(parseState(marker({ since: 'yesterday' })), null);
  assert.equal(parseState(marker({ failedAt: 'soon' }))?.failedAt, undefined);
  assert.equal(parseState(marker({ failedAt: '2026-11-09T11:30:00Z' }))?.failedAt, '2026-11-09T11:30:00Z');
});

test('state comments round-trip', () => {
  const body = renderState(STATE);
  assert.match(body, /Factory: \*\*fixing\*\* · PR #51 · fix round 2/);
  assert.deepEqual(parseState(body), STATE);
});

test('state parsing rejects missing, malformed and unknown-stage markers', () => {
  assert.equal(parseState('hello'), null);
  assert.equal(parseState('<!-- factory:state {not json} -->'), null);
  assert.equal(parseState('<!-- factory:state {"stage":"shipping","since":"x","round":0,"attempts":0,"runs":[]} -->'), null);
});

test('brief touches are read from the Factory block', () => {
  const body = [
    BRIEF_MARKER,
    '## Agent Brief',
    '**Summary:** add a thing',
    '### Factory',
    '**Seams:**',
    '- the record tool call',
    '',
    '**Touches:**',
    '',
    '- `plugin/servers/tracker/src/report.ts`',
    '* tests/tracker/report-activity.test.ts',
    '',
    '### Notes',
    'Trailing text',
  ].join('\n');
  assert.deepEqual(parseBriefTouches(body), ['plugin/servers/tracker/src/report.ts', 'tests/tracker/report-activity.test.ts']);
});

test('a brief without the marker or the Touches heading has no touches', () => {
  assert.equal(parseBriefTouches('**Touches:**\n- `a.ts`'), null);
  assert.equal(parseBriefTouches(`${BRIEF_MARKER}\n## Agent Brief`), null);
});

test('review markers carry the blocking count', () => {
  assert.deepEqual(parseReview('<!-- factory:review {"blocking":2,"nits":1} -->\n## Standards'), { blocking: 2, nits: 1 });
  assert.equal(parseReview('<!-- factory:review {"blocking":"2"} -->'), null);
  assert.equal(parseReview('LGTM'), null);
});

test('commands are a slash word at the start of the comment', () => {
  assert.equal(parseCommand('/approve'), 'approve');
  assert.equal(parseCommand('  /stop please\nthanks'), 'stop');
  assert.equal(parseCommand('/retry'), 'retry');
  assert.equal(parseCommand('/approved'), null);
  assert.equal(parseCommand('please /approve'), null);
  assert.equal(parseCommand('/approve-not-yet'), null);
  assert.equal(parseCommand('/approve.'), null);
  assert.equal(parseCommand('/stop-it'), null);
  assert.equal(parseCommand('/approve\nlooks good'), 'approve');
});

test('a full state round-trips', () => {
  const full: FactoryState = {
    stage: 'blocked',
    since: '2026-11-09T11:00:00.000Z',
    round: 3,
    attempts: 2,
    failedAt: '2026-11-09T11:30:00.000Z',
    pr: 51,
    brief: 900,
    approvalFor: 'diff',
    blockedFrom: 'ci',
    headSha: 'abc',
    fixReason: 'ci',
    runs: ['https://example.test/runs/1', 'https://example.test/runs/2'],
  };
  assert.deepEqual(parseState(renderState(full)), full);
});

test('state JSON cannot close its own comment', () => {
  const s = { ...STATE, headSha: 'x} -->' };
  const body = renderState(s);
  assert.equal(body.indexOf('-->'), body.lastIndexOf('-->'));
  assert.deepEqual(parseState(body), s);
});

test('state counters must be integers in range', () => {
  const base = { stage: 'ci', since: '2026-11-09T11:00:00Z', round: 0, attempts: 0, runs: [] };
  const body = (v: object) => `<!-- factory:state ${JSON.stringify({ ...base, ...v })} -->`;
  assert.notEqual(parseState(body({})), null);
  for (const bad of [{ round: -1 }, { round: 1.5 }, { attempts: -1 }, { attempts: 1.5 }]) assert.equal(parseState(body(bad)), null, JSON.stringify(bad));
  for (const bad of [{ pr: 0 }, { pr: -1 }, { pr: 1.5 }, { brief: 0 }, { brief: 2.5 }]) {
    const s = parseState(body(bad));
    assert.ok(s, JSON.stringify(bad));
    assert.equal(s.pr, undefined);
    assert.equal(s.brief, undefined);
  }
});

test('markers count only at the start of the body', () => {
  const state = renderState(STATE);
  assert.equal(parseState(`hello\n${state}`), null);
  assert.deepEqual(parseState(`\n  ${state}`), STATE);
  assert.equal(parseReview('LGTM\n<!-- factory:review {"blocking":0} -->'), null);
  assert.equal(parseBriefTouches(`Quoting:\n${BRIEF_MARKER}\n**Touches:**\n- \`a.ts\``), null);
  assert.deepEqual(parseBriefTouches(`\n${BRIEF_MARKER}\n**Touches:**\n- \`a.ts\``), ['a.ts']);
});

test('a review quoting a marker later in its text uses the one at the top', () => {
  const body = '<!-- factory:review {"blocking":1,"nits":0} -->\nThe diff adds `<!-- factory:review {"blocking":0} -->` to a doc.';
  assert.deepEqual(parseReview(body), { blocking: 1, nits: 0 });
});

test('review counts must be non-negative integers', () => {
  assert.equal(parseReview('<!-- factory:review {"blocking":-1} -->'), null);
  assert.equal(parseReview('<!-- factory:review {"blocking":1.5} -->'), null);
  assert.deepEqual(parseReview('<!-- factory:review {"blocking":0,"nits":-1} -->'), { blocking: 0, nits: 0 });
  assert.deepEqual(parseReview('<!-- factory:review {"blocking":0,"nits":1.5} -->'), { blocking: 0, nits: 0 });
});

const brief = (...touches: string[]) => [BRIEF_MARKER, '## Agent Brief', '**Touches:**', ...touches].join('\n');

test('a loose Touches list with blank lines between bullets keeps every entry', () => {
  assert.deepEqual(parseBriefTouches(brief('- `a.ts`', '', '- `plugin/hooks/gates.ts`', '', '* b.ts', '')), ['a.ts', 'plugin/hooks/gates.ts', 'b.ts']);
});

test('annotated Touches bullets yield their paths', () => {
  assert.deepEqual(parseBriefTouches(brief('- `a.ts` (new file)', '- b.ts: add a test', '- `c.ts`, the entry', '**Seams:**', '- not a path')), ['a.ts', 'b.ts', 'c.ts']);
});

test('a Touches bullet naming several backticked paths keeps all of them', () => {
  assert.deepEqual(parseBriefTouches(brief('- `docs/x.md` and `plugin/hooks/gates.ts`')), ['docs/x.md', 'plugin/hooks/gates.ts']);
});

test('a stray paragraph inside the Touches section voids the list', () => {
  assert.equal(parseBriefTouches(brief('- `a.ts`', '', 'Also the hooks.', '- `b.ts`')), null);
  assert.equal(parseBriefTouches(brief('- `a.ts`', '-')), null);
});

test('two Touches headings void the list', () => {
  assert.equal(parseBriefTouches(brief('- `a.ts`', '### More', '**TOUCHES:**', '- `plugin/hooks/gates.ts`')), null);
});

test('approval fields round-trip; malformed ones are dropped', () => {
  const s: FactoryState = {
    ...STATE,
    stage: 'awaiting-approval',
    approvalFor: 'diff',
    approvedTouches: ['plugin/hooks', 'docs/x.md'],
    approvalSha: 'sha-2',
    approvedSha: 'sha-1',
    afterApproval: 'fix',
    ciRun: 'https://github.com/o/r/actions/runs/12',
  };
  assert.deepEqual(parseState(renderState(s)), s);
  const odd = parseState(marker({ approvedTouches: 'plugin/hooks', approvedSha: '', approvalSha: 7, afterApproval: 'merge', ciRun: 3 }));
  assert.ok(odd);
  for (const k of ['approvedTouches', 'approvedSha', 'approvalSha', 'afterApproval', 'ciRun'] as const) assert.equal(odd[k], undefined, k);
  assert.deepEqual(parseState(marker({ approvedTouches: ['a.ts', 3, null] }))?.approvedTouches, ['a.ts']);
});

test('the gated head and the no-PR block reason round-trip; an empty gated head is dropped', () => {
  const s: FactoryState = { ...STATE, stage: 'blocked', blockedFrom: 'in-review', blockedFor: 'no-pr', gatedSha: 'sha-3' };
  assert.deepEqual(parseState(renderState(s)), s);
  assert.equal(parseState(marker({ gatedSha: '' }))?.gatedSha, undefined);
  assert.equal(parseState(marker({ gatedSha: 7 }))?.gatedSha, undefined);
});
