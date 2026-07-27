# Convex Read-Auth Cutover and Rollback Runbook

Read authentication is no longer awaiting cutover. The 2026-07-26 cutover
recorded production as `ENFORCED` and recorded `ALLOW_TOKENLESS_READ` as removed.
This document preserves the original `STATE: OPEN` output as historical evidence
and keeps the rollback/rotation mechanics that still apply.

**No production probe was run while updating this document.** Treat the status
below as the recorded 2026-07-26 result, not a fresh runtime observation.
Remaining auth hardening belongs under
[umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).

Companion script: `scripts/verify-read-auth.sh`.

---

## Current recorded posture

- Convex `validateReadToken` gates `dataFiles:get`, `getVersions`, `list`, and
  `listTodoTombstones`.
- The 2026-07-26 cutover recorded all four checks passing: no token blocked,
  wrong token blocked, the correct token listed 13 files, and tokenless
  `dataFiles:get` blocked.
- The same cutover recorded `ALLOW_TOKENLESS_READ` as absent.
- Clients must receive `CONVEX_READ_TOKEN` through their approved runtime
  configuration. Never hardcode, bundle, commit, print, or document its value.
- `CONVEX_SYNC_TOKEN` and `ALLOW_TOKENLESS_SYNC` use the same precedence for
  writes. Read auth does not authorize a production mutation.

To establish current evidence in an approved operational session, run:

```bash
scripts/verify-read-auth.sh --expect enforced
CONVEX_READ_TOKEN="$THE_TOKEN" scripts/verify-read-auth.sh
```

Both halves matter. An unauthenticated rejection without a known-good success can
also mean outage or a mismatched token.

---

## Historical pre-cutover transcript — not current status

The following was captured before the gate was deployed and before the hatch was
removed. Keep it for provenance; never quote it as the deployment's present
posture.

```text
$ scripts/verify-read-auth.sh
verify-read-auth: https://keen-elephant-452.convex.cloud
  probe: dataFiles:list (metadata only — never dataFiles:get)
  unauthenticated query: ACCEPTED (13 data files visible)
STATE: OPEN
```

At that point, the deployment URL alone was sufficient to list/read the
household data, and the deployed function validators rejected an added `token`
argument. The cutover therefore had to deploy token-aware validators while an
escape hatch kept old clients working, configure readers, then remove the hatch.
That sequence is complete; it remains useful only for rollback and rotation.

---

## The precedence rule

`ALLOW_TOKENLESS_READ=true` outranks `CONVEX_READ_TOKEN`:

```text
if (ALLOW_TOKENLESS_READ === "true") admit permissively
else if CONVEX_READ_TOKEN is absent reject
else if the supplied token does not match reject
else admit
```

This gives operators a one-command rollback, but it creates a sharp trap: a set
`CONVEX_READ_TOKEN` proves nothing while the hatch is present. The deployment can
look configured and still admit tokenless callers.

The observable signals are:

- `scripts/verify-read-auth.sh` reports `STATE: OPEN` when tokenless reads work.
- A permissive admission writes a `PERMISSIVE:` line to the deployment log.
- `scripts/verify-read-auth.sh --expect enforced`, followed by a known-good-token
  probe, is the required enforcement check.

Never leave the hatch enabled after an incident or token rotation.

---

## Incident rollback

Every production config change is approval-gated. If an enforcing deployment
locks out a legitimate reader, restore service first, then diagnose.

```bash
export DEPLOY="CONVEX_DEPLOYMENT=prod:keen-elephant-452"
env $DEPLOY npx convex env set ALLOW_TOKENLESS_READ true
scripts/verify-read-auth.sh --expect open
```

This immediately reopens reads without changing `CONVEX_READ_TOKEN` or
redeploying functions. That exposure is intentional but temporary.

While permissive:

1. Identify every affected reader.
2. Confirm its approved runtime configuration contains the read token.
3. Confirm the reader actually attaches the token to every Convex blob query.
4. Exercise the reader while the hatch is still open.
5. Inspect deployment logs for expected `PERMISSIVE:` admissions; these prove the
   hatch is active, not that a client sent the right token.

Then restore enforcement:

```bash
env $DEPLOY npx convex env remove ALLOW_TOKENLESS_READ
scripts/verify-read-auth.sh --expect enforced
CONVEX_READ_TOKEN="$THE_TOKEN" scripts/verify-read-auth.sh
```

Afterward, exercise the affected client and confirm
`ALLOW_TOKENLESS_READ` is absent from `npx convex env list`. If the known-good
probe fails, treat that as an outage and re-arm the hatch before debugging.

Do not attempt a partial client fix while the household is locked out. Roll back,
fix, remove the hatch, and verify both rejection and known-good success.

---

## Token rotation

Rotation uses the same temporary permissive window:

1. Obtain Victor's approval for the production config change.
2. Set `ALLOW_TOKENLESS_READ=true` and verify `STATE: OPEN`.
3. Replace `CONVEX_READ_TOKEN` on the deployment. Its new value is inert while
   the hatch is enabled.
4. Roll the same value to every reader through approved runtime configuration.
5. Exercise every reader; do not infer readiness from the server accepting it.
6. Remove `ALLOW_TOKENLESS_READ`.
7. Verify unauthenticated and wrong-token rejection plus known-good success.
8. Confirm the hatch remains absent.

The permissive window exposes reads to anyone with the deployment URL. Keep it
short and supervised.

---

## Client failure symptoms

- **Swift:** Convex returns HTTP 200 with a function error; the app may show empty
  or stale screens rather than a network failure. The current `MC2Reader` name is
  legacy blob compatibility, not a live MC2 service.
- **Linux/Android:** any production row/blob reader must attach the runtime token
  on every query and must not fall back to fixtures after an auth failure.
- **Verify script:** `ENFORCED` without a known-good success is not enough;
  `OPEN` when enforcement is expected means the hatch is admitting tokenless
  calls; `OUTAGE` is a rollback trigger.
- **Deployment log:** a `PERMISSIVE:` line outside an approved incident/rotation
  window means reads are open and requires immediate reconciliation.

MC2 mission-control is gone and cannot be part of an auth validation or rollback
plan. Swift `MC2*` symbols survive only to decode the existing Convex blobs.

---

## What the verification script proves

It does:

- Query only `dataFiles:list` for the normal probes; it never fetches financial
  payloads with `dataFiles:get`.
- Compare unauthenticated, deliberately wrong-token, and optional known-good
  behavior.
- Classify `OPEN`, `ENFORCED`, `OUTAGE`, `CLOSED-UNCONFIRMED`, or `UNKNOWN`.
- Support `--expect open|enforced` as an operational gate.
- Keep token values out of argv and remove its mode-0600 request temp directory.

It does not:

- Prove that a particular client sends a token.
- Prove current production posture unless it was run in the current approved
  session and its output was inspected.
- Authorize a deployment, environment mutation, migration, or app release.
- Make the historical `STATE: OPEN` transcript current.
