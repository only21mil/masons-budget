# Convex production deploy hatch state

Checked: 2026-09-02 (docs refreshed; production environment not re-probed from
this checkout — no deployment binding and no authorized operator session here)

Target: production (`prod:keen-elephant-452`)

## Implemented verification (code)

The hatches are fail-open ONLY on the exact opt-in string. Every gate evaluates
`process.env.ALLOW_TOKENLESS_{READ,SYNC} === "true"` — literally `true`,
lowercase, no whitespace. Any other value (`TRUE`, `1`, `yes`, `" true"`,
`false`) leaves the gate fail-closed. This exact-literal contract is pinned by
`convex/mutationAuth.test.ts` ("only the exact string \"true\" opens the
hatch") and `convex/readAuth.test.ts`.

Gates implementing the precedence (hatch checked first, then token):

| Module | Sync gate | Read gate |
| --- | --- | --- |
| `convex/dataFiles.ts` | `validateSyncToken` | `validateReadToken` |
| `convex/tables.ts` (mirror) | `validateSyncToken` | `validateReadToken` |
| `convex/marketQuotes.ts` | — | `validateReadToken` |

`convex/readCanary.ts` is deliberately hatch-free and fails closed on an
unconfigured token, so it always reports the true configured posture.

Unauthenticated callers receive a generic rejection that names no environment
variable; the specific variable and recovery guidance is logged server-side
only (`AUTH-FAIL-CLOSED: …`). Fail-open admissions still log `PERMISSIVE` on
every call.

## Production state

| Variable | Current production state |
| --- | --- |
| `ALLOW_TOKENLESS_READ` | **Unknown.** The environment listing failed on the last authorized attempt (2026-07-27, see history below). Repository documentation recorded it absent on 2026-07-26, but that is not a current production observation. |
| `ALLOW_TOKENLESS_SYNC` | **Unknown.** Both the environment listing and the direct read failed on the same attempt. |
| `CONVEX_READ_TOKEN` | **Unknown** (presence only could not be determined). |
| `CONVEX_SYNC_TOKEN` | **Unknown** (presence only could not be determined). |

**Do not deploy from this evidence.** The earlier attempt failed before reaching
the deployment (`No CONVEX_DEPLOYMENT set`); no `convex dev`, deploy, run,
import/export, or environment mutation was performed then, and none has been
performed since from an audit context.

## How to verify auth in production (both sides)

Both probes are metadata-equivalent: the read probe queries file metadata only,
and the write probe targets `dataFiles:remove` on a random name that cannot
exist, so it is a no-op whether auth is open or enforced. Neither prints
payloads, server error text, or token values; known-good tokens are copied to
mode-0600 files and removed from child environments.

Read side (existing since the 2026-07-26 cutover):

```bash
CONVEX_READ_TOKEN="$CONVEX_READ_TOKEN" \
  scripts/verify-read-auth.sh --expect enforced
```

Write side (added 2026-09-02 — this is the check that had never been run):

```bash
CONVEX_SYNC_TOKEN="$CONVEX_SYNC_TOKEN" \
  scripts/verify-sync-auth.sh --expect enforced
```

`ENFORCED` from both proves the deployment currently rejects anonymous and
wrong credentials on both gates and accepts the configured ones. `OPEN` from
either means a hatch is set or a token is missing — treat as an incident: find
the variable with `npx convex env list --prod` (authorized operator only),
remove the hatch, and re-run the probe:

```bash
npx convex env remove ALLOW_TOKENLESS_READ --prod
npx convex env remove ALLOW_TOKENLESS_SYNC --prod
```

`TOKEN-UNCONFIGURED` means the deployment has no credential configured: reads
and writes fail closed, and clients are locked out — set the token, do not set
the hatch.

## Required state and deploy gate

The deploy gate requires both `ALLOW_TOKENLESS_READ` and `ALLOW_TOKENLESS_SYNC`
to be absent, with both `CONVEX_READ_TOKEN` and `CONVEX_SYNC_TOKEN` configured,
and both probes reporting `ENFORCED`. A configured token is not sufficient when
its matching hatch is `"true"` because the hatch is evaluated first.

After an authorized operator supplies the production deployment binding, run
both probes and do not deploy unless the required state is confirmed. A hatch
may be re-set only as an approved incident rollback (see
docs/convex-read-auth-cutover.md), and must be removed again with the probes
re-run before the next deploy.

## History

- 2026-07-26: read-auth cutover recorded `ENFORCED` for reads
  (docs/convex-read-auth-cutover.md). Write-side state was not probed.
- 2026-07-27: environment listing attempt failed with no deployment binding;
  both hatch values recorded **Unknown** (previous version of this file).
- 2026-09-02: hatch contract made explicit and test-pinned (literal `"true"`
  only); `scripts/verify-sync-auth.sh` added so the write gate can finally be
  probed like the read gate. Production still requires an authorized run of
  both probes to close the record.
