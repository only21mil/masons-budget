// Shared deployment-token gates for public Convex surfaces.
//
// Canonical home for validateReadToken / validateSyncToken / warnPermissive.
// Previously mirrored in dataFiles.ts, tables.ts, writeback.ts, and
// marketQuotes.ts so callers could not tell which file answered. Keep behavior
// identical: hatch outranks token, timing-safe compare, asymmetric throws
// (sync → Error, read → ConvexError), generic client-visible rejections.

import { ConvexError } from "convex/values";

import { timingSafeEqualStrings } from "./deviceAuth";

declare const process: { env: Record<string, string | undefined> };

// ─────────────────────────────────────────────────────────────────────────────
// THE ESCAPE HATCH OUTRANKS THE TOKEN. Read this before changing either gate.
//
// ALLOW_TOKENLESS_{READ,SYNC}="true" admits the call even when the matching
// token IS configured. The hatch is checked first, on purpose.
//
// Why, given that it means a configured token can sit there doing nothing: the
// two designs fail in opposite directions, and only one of them is recoverable
// by someone who is not already logged in.
//
//   hatch loses  → enforcement starts the instant CONVEX_READ_TOKEN is set, so
//                  the documented "set the token, THEN ship clients" order
//                  locks out every client mid-sequence — including the
//                  TestFlight build in Victor's pocket. Failure mode:
//                  "everybody is locked out, remotely, right now."
//   hatch wins   → setting the token is inert until the hatch is removed, so
//                  the order in the runbook actually works and removing one
//                  env var is a complete, atomic rollback. Failure mode:
//                  "enforcement quietly did not happen."
//
// The second failure is the one we can see and undo. scripts/verify-read-auth.sh
// probes the live deployment and prints OPEN vs ENFORCED, so "enforcement
// quietly did not happen" is one command away from being noticed. Nothing
// detects "everyone is locked out" except the household discovering it.
//
// ⚠️ THE HAZARD THIS BUYS, NAMED OUT LOUD: while a hatch is "true" the
// corresponding token is IGNORED. A deployment can have CONVEX_READ_TOKEN set,
// look configured in `npx convex env list`, and still be serving the family's
// finances to anyone with the URL. A set token is NOT evidence of enforcement.
// The only evidence is scripts/verify-read-auth.sh reporting ENFORCED — and the
// permissive admissions logged below. Never leave a hatch on past its soak.
//
// Cutover order (docs/convex-read-auth-cutover.md is authoritative):
//   set ALLOW_TOKENLESS_READ=true → deploy the gated code (still permissive) →
//   set CONVEX_READ_TOKEN and ship clients that send it (still permissive) →
//   confirm → remove the hatch. Removing the hatch is the enforcement flip;
//   re-setting it is the rollback.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log every permissive admission. Deliberately not throttled or sampled: a
 * hatch is a temporary cutover state measured in hours, and a line per call is
 * what makes "we are still open" impossible to miss in the deployment log. If
 * this is noisy, the hatch has outlived its purpose — remove it.
 *
 * Never logs a token, or whether the caller supplied one that matched.
 */
function warnPermissive(hatchVar: string, tokenVar: string, tokenSet: boolean) {
  console.warn(
    tokenSet
      ? `PERMISSIVE: ${hatchVar}=true is admitting this call and ${tokenVar} ` +
          `is set but IGNORED. This deployment is NOT enforcing auth. Remove ` +
          `${hatchVar} to flip enforcement on.`
      : `PERMISSIVE: ${hatchVar}=true is admitting this call unauthenticated ` +
          `(${tokenVar} is not configured). This deployment is NOT enforcing auth.`,
  );
}

// SAT-1326: FAIL-CLOSED token validation. Previously an unset CONVEX_SYNC_TOKEN
// silently allowed all mutations (open). Now an unset token rejects every
// mutation unless ALLOW_TOKENLESS_SYNC === "true".
//
// Every approved caller of these mutations must send CONVEX_SYNC_TOKEN before
// ALLOW_TOKENLESS_SYNC comes off, or its writes lock out.
//
// UNAUTHENTICATED-CALLER ERROR DISCIPLINE: the client-visible rejection is
// generic and names no environment variable. The specific configuration detail
// (which variable is missing) goes to the server log only, so a prober learns
// that the door is locked, not which key unlocks it.
export function validateSyncToken(token?: string) {
  const expected = process.env.CONVEX_SYNC_TOKEN;
  if (process.env.ALLOW_TOKENLESS_SYNC === "true") {
    warnPermissive(
      "ALLOW_TOKENLESS_SYNC",
      "CONVEX_SYNC_TOKEN",
      Boolean(expected),
    );
    return;
  }
  if (!expected) {
    console.error(
      "AUTH-FAIL-CLOSED: CONVEX_SYNC_TOKEN is not configured; every write " +
        "is being rejected. Configure the deployment write credential — do " +
        "not set ALLOW_TOKENLESS_SYNC to recover.",
    );
    throw new Error(
      "Unauthorized: write auth is not configured (fail-closed).",
    );
  }
  if (!token || !timingSafeEqualStrings(token, expected)) {
    throw new Error("Unauthorized: invalid sync token");
  }
}

// SAT-READ-AUTH: reads were entirely unauthenticated until 2026-07-26. Anyone
// who knew the deployment URL — which is committed in this repo and baked into
// every shipped client binary — could read the family's full financial history.
// Confirmed live against production before this change.
//
// Same shape as validateSyncToken, same hatch precedence, for the reason in the
// banner above. Same generic-error discipline: no environment variable names
// reach an unauthenticated caller.
export function validateReadToken(token?: string) {
  const expected = process.env.CONVEX_READ_TOKEN;
  if (process.env.ALLOW_TOKENLESS_READ === "true") {
    warnPermissive(
      "ALLOW_TOKENLESS_READ",
      "CONVEX_READ_TOKEN",
      Boolean(expected),
    );
    return;
  }
  if (!expected) {
    console.error(
      "AUTH-FAIL-CLOSED: CONVEX_READ_TOKEN is not configured; every read " +
        "is being rejected. Configure the deployment read credential — do " +
        "not set ALLOW_TOKENLESS_READ to recover.",
    );
    throw new ConvexError(
      "Unauthorized: read auth is not configured (fail-closed).",
    );
  }
  if (!token || !timingSafeEqualStrings(token, expected)) {
    throw new ConvexError("Unauthorized: invalid read token");
  }
}
