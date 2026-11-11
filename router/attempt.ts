// Only the attempt the signed state names may act. The prepare job checks this before the agent starts, and the
// publish job checks it again immediately before every write: a /stop, a block or a newer attempt in between makes
// the run stale, and a stale run must change nothing.

import { type RunWorkflow, STAGE_FOR } from './config.ts';
import type { FactoryState } from './markers.ts';

// Why this run may not act, or null when it is the current attempt of the stage the issue is in.
export function stale(state: FactoryState | null, workflow: RunWorkflow, attempt: string): string | null {
  if (!state) return 'the issue has no signed factory state';
  if (state.stage !== STAGE_FOR[workflow]) return `the issue is at ${state.stage}, not ${STAGE_FOR[workflow]}`;
  if (state.attempt !== attempt) return `attempt ${attempt} is no longer current (now ${state.attempt ?? 'none'})`;
  return null;
}
