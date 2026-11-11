import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment, Edit, Review } from '../router/github.ts';
import { BRIEF_MARKER, renderState } from '../router/markers.ts';
import { briefFrom, changesRequestedFrom, commandFrom, editedOnlyBy, editLookups, stateFrom } from '../router/snapshot.ts';

const state = { stage: 'ci' as const, since: '2026-11-09T11:00:00.000Z', round: 0, attempts: 0, runs: [] };
const BOT = 'factory-app[bot]';
const ROUTER = 'github-actions[bot]';

const comment = (id: number, author: string, body: string, at = '2026-11-09T11:00:00Z'): Comment => ({ id, nodeId: `IC_${id}`, author, body, at });
const NEVER: Edit = { editor: null, lastEditedAt: null };
const by = (editor: string): Edit => ({ editor, lastEditedAt: '2026-11-09T11:30:00Z' });
// Every comment never edited, except the ones given.
function edits(comments: readonly Comment[], changed: Record<number, Edit> = {}): Map<string, Edit> {
  return new Map(comments.map((c) => [c.nodeId, changed[c.id] ?? NEVER]));
}

test('state comes only from the router account, latest first', () => {
  const comments = [
    comment(1, ROUTER, renderState({ ...state, stage: 'planning' }), '2026-11-09T10:00:00Z'),
    comment(2, ROUTER, renderState(state)),
    comment(3, 'someone', renderState({ ...state, stage: 'ready' }), '2026-11-09T11:05:00Z'),
  ];
  assert.deepEqual(stateFrom(comments, edits(comments)), { id: 2, state });
});

test('no router comment means no state', () => {
  const comments = [comment(3, 'someone', renderState(state))];
  assert.equal(stateFrom(comments, edits(comments)), null);
});

test('the state comment counts only if the router was its last editor', () => {
  const comments = [comment(1, ROUTER, renderState({ ...state, stage: 'planning' })), comment(2, ROUTER, renderState(state))];
  assert.deepEqual(stateFrom(comments, edits(comments, { 2: by(ROUTER) }))?.id, 2);
  // Someone else's edit voids it, and the router's older comment does not stand in for it.
  assert.equal(stateFrom(comments, edits(comments, { 2: by(BOT) })), null);
  assert.equal(stateFrom(comments, edits(comments, { 2: by('adamwardecki') })), null);
  assert.equal(stateFrom(comments, edits(comments, { 2: { editor: null, lastEditedAt: '2026-11-09T11:30:00Z' } })), null);
  // Not looked up counts as edited.
  assert.equal(stateFrom(comments, new Map()), null);
});

const BRIEF = `${BRIEF_MARKER}\n**Touches:**\n- \`docs/x.md\``;

test('the brief is the factory bot\'s latest, and only if it was never edited', () => {
  const comments = [comment(1, BOT, BRIEF, '2026-11-09T10:00:00Z'), comment(2, BOT, BRIEF.replace('x.md', 'y.md')), comment(3, 'someone', BRIEF, '2026-11-09T11:10:00Z')];
  assert.deepEqual(briefFrom(comments, BOT, edits(comments)), { id: 2, touches: ['docs/y.md'], at: '2026-11-09T11:00:00Z' });
  assert.equal(briefFrom(comments, BOT, edits(comments, { 2: by(BOT) })), null);
  assert.equal(briefFrom(comments, BOT, new Map()), null);
});

test('commands count from the maintainer, unedited or last edited by the maintainer', () => {
  const comments = [
    comment(1, 'adamwardecki', '/stop', '2026-11-09T10:00:00Z'),
    comment(2, 'adamwardecki', '/approve', '2026-11-09T11:00:00Z'),
    comment(3, 'someone', '/retry', '2026-11-09T11:10:00Z'),
    comment(4, 'adamwardecki', 'thanks', '2026-11-09T11:20:00Z'),
  ];
  assert.deepEqual(commandFrom(comments, edits(comments)), { command: 'approve', at: '2026-11-09T11:00:00Z', actor: 'adamwardecki' });
  assert.equal(commandFrom(comments, edits(comments, { 2: by('adamwardecki') }))?.command, 'approve');
  // An approval someone else edited into the maintainer's comment does not count; the older command does.
  assert.equal(commandFrom(comments, edits(comments, { 2: by(BOT) }))?.command, 'stop');
  assert.equal(commandFrom([], new Map()), null);
});

test('editedOnlyBy accepts never-edited comments and the allowed editor only', () => {
  const c = comment(1, 'adamwardecki', 'x');
  assert.ok(editedOnlyBy(c, edits([c]), null));
  assert.ok(editedOnlyBy(c, edits([c], { 1: by('adamwardecki') }), 'adamwardecki'));
  assert.ok(!editedOnlyBy(c, edits([c], { 1: by('adamwardecki') }), null));
  assert.ok(!editedOnlyBy(c, edits([c], { 1: by('mallory') }), 'adamwardecki'));
  assert.ok(!editedOnlyBy(c, new Map(), 'adamwardecki'));
});

test('editLookups asks only about the comments the snapshot could use', () => {
  const comments = [
    comment(1, ROUTER, renderState({ ...state, stage: 'planning' })),
    comment(2, ROUTER, renderState(state)),
    comment(3, ROUTER, 'Factory stopped'),
    comment(4, BOT, BRIEF),
    comment(5, 'adamwardecki', '/approve'),
    comment(6, 'adamwardecki', 'hello'),
    comment(7, 'someone', '/stop'),
  ];
  const prComments = [comment(8, 'adamwardecki', '/retry'), comment(9, BOT, 'pushed')];
  assert.deepEqual(editLookups(comments, prComments, BOT).sort(), ['IC_2', 'IC_4', 'IC_5', 'IC_8']);
});

test('the latest changes-requested review is the maintainer\'s, whatever its body', () => {
  const review = (author: string, st: string, at: string): Review => ({ nodeId: `R_${at}`, author, body: '', at, state: st });
  const reviews = [
    review('adamwardecki', 'CHANGES_REQUESTED', '2026-11-09T10:00:00Z'),
    review('adamwardecki', 'CHANGES_REQUESTED', '2026-11-09T11:00:00Z'),
    review('someone', 'CHANGES_REQUESTED', '2026-11-09T11:30:00Z'),
    review('adamwardecki', 'COMMENTED', '2026-11-09T11:40:00Z'),
  ];
  assert.deepEqual(changesRequestedFrom(reviews), { at: '2026-11-09T11:00:00Z', actor: 'adamwardecki' });
  assert.equal(changesRequestedFrom([review('someone', 'CHANGES_REQUESTED', '2026-11-09T11:30:00Z')]), null);
});
