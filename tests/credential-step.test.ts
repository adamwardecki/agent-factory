// The agent job's credential step, run for real: its jq program, taken from stage.yml, against outputs of the kinds
// claude-code-action writes. Skipped where jq isn't installed (CI has it).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const stage = readFileSync(new URL('../.github/workflows/stage.yml', import.meta.url), 'utf8');
const program = /if jq -e '(.+)' "\$f" >\/dev\/null; then/.exec(stage)?.[1];
const hasJq = spawnSync('jq', ['--version']).status === 0;

function refused(output: unknown): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'factory-credential-'));
  const f = join(dir, 'out.json');
  writeFileSync(f, typeof output === 'string' ? output : JSON.stringify(output));
  try {
    execFileSync('jq', ['-e', program ?? '', f], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const result = (extra: Record<string, unknown>) => [{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0, ...extra }];

test('the credential step finds its jq program in stage.yml', () => {
  assert.ok(program, 'the step\'s `if jq -e \'...\' "$f"` line');
});

test('the credential step fires on a refused credential and on nothing else', { skip: !hasJq && 'jq is not installed' }, () => {
  // Seen in the sandbox with a dummy token.
  assert.equal(refused(result({ is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' })), true);
  assert.equal(refused(result({ is_error: true, result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}' })), true);
  assert.equal(refused(result({ is_error: true, result: 'Claude AI usage limit reached' })), false);
  assert.equal(refused(result({ is_error: true, total_cost_usd: 0.42, result: 'Failed to authenticate.' })), false, 'it got as far as a model call');
  assert.equal(refused(result({ is_error: false, result: 'Failed to authenticate.' })), false);
  assert.equal(refused({ not: 'an array' }), false);
  assert.equal(refused('not json'), false);
});
