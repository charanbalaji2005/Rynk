/**
 * Build a child-process environment. Rynk's own credentials are never
 * inherited by user applications.
 */
const BLOCKED = [/^RYNK_DAEMON_TOKEN$/, /^RYNK_INTERNAL_/];

export function sanitizeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || BLOCKED.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue; // reject malformed keys
    if (BLOCKED.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}
