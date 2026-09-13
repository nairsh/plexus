/**
 * Integration-test guard.
 *
 * The suites under tests/ that exercise the HTTP API need a server running
 * (pnpm dev) and, for some cases, live provider credentials. Neither exists in
 * CI, so they report whether the server is reachable and let each file skip
 * itself rather than failing the run.
 */

export async function isServerReachable(baseUrl: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/health`).catch(() => null);
  return Boolean(res?.ok);
}
