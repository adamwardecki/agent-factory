// Small helpers shared by the router modules. Copied from job-tracker-mcp's plugin util so the factory has no
// dependency on that repo.

// Narrow a string to one of a fixed list of literals.
export function oneOf<const T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

// A plain JSON object (not null, not an array).
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// For logs: the stack when there is one.
export function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
