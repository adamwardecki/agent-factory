// `rotate-key`, `pause` and `resume`.

import { randomBytes } from 'node:crypto';
import type { Host } from './host.ts';
import { deleteVariable, issuesInFlight, SIGNING_SECRET, setVariable } from './repo.ts';

// Markers signed with the old key stop verifying, so issues in flight lose their state: planned, pause and wait until
// nothing is in flight; after a leak, --now, and the router blocks each issue in flight with `key-rotated`.
export async function rotateKey(h: Host, now: boolean): Promise<string> {
  const flight = await issuesInFlight(h.gh);
  if (flight.length > 0 && !now) {
    throw new Error(
      `issues in flight: ${flight.map((n) => `#${n}`).join(', ')}. Their state is signed with the current key. Pause, wait until doctor shows none, then rotate; or, after a leak, rotate-key --now: each of them is then blocked with key-rotated, and re-adding agent:queued starts it over.`,
    );
  }
  await h.setSecret(SIGNING_SECRET, randomBytes(32).toString('hex'));
  return flight.length === 0 ? `replaced ${SIGNING_SECRET}` : `replaced ${SIGNING_SECRET}; the router blocks ${flight.map((n) => `#${n}`).join(', ')} with key-rotated on its next run`;
}

// The router and the publish job read anything but unset, empty or "0" as paused.
export async function pause(h: Host): Promise<string> {
  await setVariable(h.gh, 'FACTORY_PAUSED', '1');
  return 'paused: the router does nothing, and a running publish job makes no further write';
}

export async function resume(h: Host): Promise<string> {
  await deleteVariable(h.gh, 'FACTORY_PAUSED');
  return 'resumed: the next router run picks up where things stood';
}
