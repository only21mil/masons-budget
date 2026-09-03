// The one household deployment every Convex path — reads, pairing, and
// mutations alike — may address.
//
// Reads originally accepted any HTTPS host named by the environment while
// mutations were pinned to this origin. That asymmetry let anything that could
// influence the environment (a copied dev shell, a wrapper script) redirect the
// token-bearing read request to a different host. Both transports now resolve
// their endpoint through this one module, so a configuration that fails the
// write path cannot secretly keep working for reads.

export const APPROVED_CONVEX_ORIGIN = "https://keen-elephant-452.convex.cloud"

/**
 * Resolve the one household deployment the main process approves.
 *
 * Pairing input never supplies transport routing. The environment is trusted
 * host configuration, but it is still parsed narrowly so a typo fails closed.
 */
export function resolveApprovedDeploymentOrigin(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 512) return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== APPROVED_CONVEX_ORIGIN
  ) {
    return null
  }
  return parsed.origin
}
