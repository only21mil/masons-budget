# Convex production row-migration runbook

Target deployment: `prod:keen-elephant-452`

> **Completed-operation record; do not rerun as synchronization.** The row
> schema/API were deployed and this migration was applied. The sequence below is
> retained for audit provenance, not as a current deployment plan. A rerun can
> resurrect row-native deletes while compatible blobs still contain the old
> record. See `docs/HANDOFF.md` for the current row-write path.

This was the operator sequence for adding the row schema and projecting the
then-authoritative `dataFiles` blobs into row tables. It did not cut any client
over to the rows. The blob path had to remain byte-identical:
`dataFiles`, `syncVersions`, and `todoTombstones` were not migration targets.

The recorded production payload has 905 adult transactions, 31 BTC buys, and
25 todos. Nothing in this document is fresh evidence about the deployment:
the runbook was tested with `convex-test` only. No `convex deploy`, `dev`, `env`,
or `run` command was executed while preparing it.

## Plan-binding safety gate

The dry run uses the same projection and diff as apply and writes nothing. It
cannot read back hypothetical rows, so its expected verification message is:

```text
verification: deferred — a dry run writes nothing to verify
```

The backend now also computes a frozen plan fingerprint. Good JSON evidence
reports:

```json
{
  "fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "fingerprintState": "provided"
}
```

The fingerprint is SHA-256 over the complete ordered projection for every
migratable source file. Each row's deterministic id/key, closed-union owner,
every integer-minor-unit money value, all other projected application fields,
and migration provenance participate. Per-file fingerprints are also emitted;
the global fingerprint binds the whole source set, including missing files.
`migratedAt` is the only reserved exclusion because it would be an
execution-time wall-clock value; no current projection writes it. Convex `_id`
and `_creationTime` are not projected fields and therefore never enter a
pre-insert plan.

Apply requires `--expected-plan-fingerprint`. The CLI compares it with the
current backend status before invoking a mutation, and every backend apply
mutation independently recomputes and compares the full plan again before its
first insert or patch. A blob change after dry run therefore refuses the apply
instead of silently applying a different projection. Deferred dry-run
verification remains honest: the three-way count, exact-money-sum, and
canonical round-trip verification still runs against stored rows during apply
and again in the post-apply query.

There is a second deploy gate: confirm in the Convex dashboard that
`ALLOW_TOKENLESS_SYNC` is absent. The repository has no recorded observation of
its production value. If it is `"true"`, deploying the new public mutations
would make them tokenless even when `CONVEX_SYNC_TOKEN` is configured.

## 1. Approval and immutable inputs

Victor must explicitly approve this production session. Before opening a
terminal, confirm all of the following:

- Both encrypted backups still have their independently verified hashes.
- The migration PR, the production deploy-preflight PR, and the frozen-plan
  binding change are merged into `build/finish-vogel-vault`.
- No other lane is deploying Convex or writing the ledger.
- The exact reviewed merge commit has been recorded as `REVIEWED_SHA`.
- In the Convex dashboard for `keen-elephant-452`,
  `ALLOW_TOKENLESS_READ` and `ALLOW_TOKENLESS_SYNC` are absent, while
  `CONVEX_READ_TOKEN` and `CONVEX_SYNC_TOKEN` are present. Inspect names and
  presence only; do not copy or print values.

Stop if any item is false or unknown.

## 2. Prepare a clean, pinned checkout

Use a new temporary checkout. Replace the placeholder with the exact approved
40-character commit; never deploy a moving branch name.

```bash
run_dir="$(mktemp -d /tmp/vogel-vault-convex-migration.XXXXXX)"
git clone https://github.com/only21mil/masons-budget.git "$run_dir/repo"
cd "$run_dir/repo"
git fetch origin build/finish-vogel-vault

reviewed_sha='REPLACE_WITH_APPROVED_40_CHARACTER_SHA'
test "${#reviewed_sha}" -eq 40
git cat-file -e "${reviewed_sha}^{commit}"
git merge-base --is-ancestor "$reviewed_sha" origin/build/finish-vogel-vault
git switch --detach "$reviewed_sha"
test -z "$(git status --porcelain)"

npm ci

# Local checksum and API inventory check. No remote generation or deployment.
# This does not prove full declaration freshness.
npm run codegen

npm run convex:test
git diff --check
```

Good:

- `npm ci` exits 0 without changing tracked files.
- `npm run codegen` passes the local checksum and API inventory checks and
  leaves `convex/_generated` unchanged. Before deployment, complete the separate
  approved remote freshness procedure in [Convex codegen safety](convex-codegen-safety.md).
  It may persist schema/index preparation state and is not authorized by this
  local verification block. Missing approved credential injection is a stop.
- `npm run convex:test` reports every test passing.
- `git diff --check` prints nothing and exits 0.
- `git status --porcelain` remains empty.

Bad: any nonzero exit, generated declaration drift, skipped migration suite,
tracked-file change, or SHA that is not an ancestor of the integration branch.
Stop before deployment.

## 3. Reconfirm the authentication gates

Immediately before deploy, repeat the dashboard presence check from step 1.
The required state is:

| Variable | Required state |
| --- | --- |
| `ALLOW_TOKENLESS_READ` | absent |
| `ALLOW_TOKENLESS_SYNC` | absent |
| `CONVEX_READ_TOKEN` | present |
| `CONVEX_SYNC_TOKEN` | present |

The hatches outrank the tokens. A present token does not make a present
`ALLOW_TOKENLESS_*="true"` hatch safe. Stop on any mismatch.

## 4. Deploy the reviewed schema and functions

This is the first production-changing command. It deploys code, the five
additive row-table declarations, and indexes. It does not invoke the migration.

```bash
CONVEX_DEPLOYMENT=prod:keen-elephant-452 \
  npx convex deploy \
    --message "add reviewed Vogel Vault row schema and migration functions"
```

Good: the command exits 0 and reports a successful deploy to
`prod:keen-elephant-452`. No migration output should appear because deploy does
not invoke `migrate:migrateFile`.

Bad: wrong target, schema rejection, typecheck/bundle failure, authorization
failure, or any unexpected destructive schema warning. Stop. Do not attempt the
backfill. Use the code-deploy rollback below if any part of the new bundle was
published.

## 5. Verify read auth, then take the no-write production plan

Read the token without echoing it or placing it in shell history:

```bash
read -rsp "Convex production read token: " vv_read_token
printf '\n'
CONVEX_READ_TOKEN="$vv_read_token" \
  scripts/verify-read-auth.sh --expect enforced
unset vv_read_token
```

Good: the probe exits 0 with `STATE: ENFORCED`. `OPEN`,
`TOKEN-UNCONFIGURED`, `WRONG-KNOWN-GOOD`, `OUTAGE`, `CLOSED-UNCONFIRMED`, and
`UNKNOWN` are all stop conditions.

Now run the migration driver's production dry run:

```bash
node scripts/convex-migrate.mjs \
  --prod \
  --json \
  > "$run_dir/migration-dry-run.json"
```

Good:

- The command exits 0 and says `Target class: production`, `Mode: dry-run`,
  and `Dry run complete. Nothing was written.`
- `transactions` reports 905 blob rows and 905 new rows.
- `bitcoin-buys` reports 31 blob rows and 31 new rows.
- `todos` reports 25 blob rows and 25 new rows.
- Every other present migratable blob has an explicit plan; absent blobs say
  they were skipped rather than invented.
- Every file says verification is deferred because this command wrote nothing.
- The JSON document has `outcome: "success"`,
  `version: 2`, `execution.writeSafety.classification: "none"`,
  `operation.frozenPlan.fingerprintState: "provided"`, a valid
  `sha256:` fingerprint, and no raw rows, record IDs, monetary totals, token,
  or deployment identifier.

Bad: a production count differs from the recorded source, a blob is unreadable,
an expected blob is absent, a row is unexpectedly already present or changed,
the target class is not production, the fingerprint is missing or malformed,
child output leaks into the JSON, or the command exits nonzero. Stop and
investigate the blob/read-only status; do not apply.

## 6. Review, copy the fingerprint, and apply the frozen plan

Two people must review `"$run_dir/migration-dry-run.json"`. Require the counts
and plan states listed in step 5, then copy the global backend fingerprint from
the reviewed evidence without recording raw financial data:

```bash
plan_fingerprint="$(
  jq -er '
    .operation.frozenPlan
    | select(.fingerprintState == "provided")
    | .fingerprint
    | select(test("^sha256:[0-9a-f]{64}$"))
  ' "$run_dir/migration-dry-run.json"
)"
test -n "$plan_fingerprint"
```

Do not type, infer, truncate, or regenerate the value. Use that exact shell
variable in the approved apply:

```bash
node scripts/convex-migrate.mjs \
  --apply \
  --prod \
  --confirm-production \
  --expected-plan-fingerprint "$plan_fingerprint" \
  --json \
  > "$run_dir/migration-apply.json"
```

Good: the command reaches migration, exits 0, and the apply evidence reports
`expectedFingerprintMatched: true` with the same fingerprint as the reviewed
dry run. When at least one completed batch inserted or updated rows, require
`outcome: "success"`, `execution.state: "completed"`,
`execution.writeSafety.classification: "writes-completed"`, and `failure: null`.
A successful no-op apply with no inserted or updated rows instead reports
`execution.writeSafety.classification: "none"`. Continue with the applied
verification checks below.

If the CLI reports `PLAN_FINGERPRINT_MISMATCH`, or the backend refuses a batch
for a plan fingerprint mismatch, stop immediately. Do not replace
`plan_fingerprint` with the newly observed value and do not retry apply. Preserve
the reviewed dry-run evidence, determine which `dataFiles` blob changed and
why using read-only inspection, then take a completely new dry run. Both
reviewers must review and approve that new plan before its new fingerprint can
be used. Rows from any earlier fully completed file may still exist if a source
changed during a multi-file apply; leave them in place and follow the
apply-failure procedure below. The authoritative blob path remains untouched.

## 7. Required applied and post-apply evidence

After the approved, plan-bound apply command exists, its good human-readable
result for the recorded adult transactions is:

```text
transactions         → transactions   905 rows  wrote 905 new, 0 changed, 0 already current
    verification: OK  count OK (905/905)  sums OK  round-trip rows OK  exact YES
```

The 31 BTC buys and 25 todos must have the same `OK`/`YES` verification shape
with their own exact counts. Every present file must report:

- `verification: OK`
- `count OK`
- `sums OK`
- `round-trip rows OK`
- `exact YES`
- `problems=0` (or no `problems` suffix)

Any `FAILED`, `BROKEN`, `exact NO`, nonzero problem count, missing verification,
or nonzero exit is bad. The driver redacts problem details; preserve its JSON
evidence and diagnose from a read-only checkout rather than printing financial
records.

Then rerun verification without migrating:

```bash
node scripts/convex-migrate.mjs \
  --verify \
  --prod \
  --json \
  > "$run_dir/migration-post-verify.json"
```

Good: exit 0, every present file is in `verify` state, and all five verification
signals above are good. Bad: anything else.

Finally, take a no-write idempotency plan:

```bash
node scripts/convex-migrate.mjs \
  --prod \
  --json \
  > "$run_dir/migration-idempotency-dry-run.json"
```

Good: recorded files report `0 new`, `0 changed`, and every migrated row as
`already current` (905 for adult transactions, 31 for BTC buys, 25 for todos).
Do not run two extra production applies merely to demonstrate idempotency; the
local `convex-test` suite already proves three consecutive applied transaction
runs insert `905`, then `0`, then `0`.

Repeat the read-auth probe from step 5 and require `STATE: ENFORCED`.

## Good versus bad verification

The verification report separates the three defect classes:

| Signal | Good | Defect it diagnoses independently |
| --- | --- | --- |
| `rowCountMatches` | `true` | Missing or duplicate final row even when money sums and all overlapping canonical rows agree. |
| `moneySumsMatch` | `true` | Altered integer minor-unit column even when count and stored source provenance agree. |
| `roundTripRowsMatch` | `true` | Altered source provenance even when count and every money sum agree. |
| `exactRoundTrip` | `true` | Conjunction of equal count and equal canonical source rows. |
| `ok` | `true` | All checks passed and `problems` is empty. |

`convex/migrate.test.ts` corrupts each dimension separately and requires that
only its corresponding diagnostic becomes false. The same suite dry-runs and
applies production-shaped fixtures, checks the real recorded counts, and
canonical-serializes all application fields in `dataFiles`, `syncVersions`, and
`todoTombstones` before and after. It includes both `version` fields and every
timestamp/data field; system `_id` and `_creationTime` fields are intentionally
not part of the application blob contract.

## Rollback

### Deploy fails before migration

Do not invoke the migration. Restore the known legacy function/schema bundle at
commit `0a5c75d` from a separate worktree:

```bash
rollback_dir="$(mktemp -d /tmp/vogel-vault-convex-rollback.XXXXXX)"
git worktree add --detach "$rollback_dir" 0a5c75d
if (
  cd "$rollback_dir"
  npm ci &&
  CONVEX_DEPLOYMENT=prod:keen-elephant-452 \
    npx convex deploy \
      --message "rollback row-schema deploy to known legacy Convex bundle 0a5c75d"
); then
  git worktree remove --force "$rollback_dir"
else
  echo "Rollback deploy failed; retained $rollback_dir for diagnosis." >&2
  false
fi
```

Reconfirm both hatches are absent and repeat the enforced read-auth probe. This
rollback restores deployed code and saved schema; it does not restore data
because deploy itself did not migrate data.

### Apply or verification fails

Stop immediately. Do not delete, patch, or retry rows, and do not touch
`dataFiles`, `syncVersions`, or `todoTombstones`.

The default batch size is 1000, so the recorded 905-row transaction file and
every smaller file fit in one mutation. Each file verifies inside its mutation;
a failure throws and rolls that file back atomically. Files completed earlier
in the script may still have verified rows. They are inert because clients have
not been cut over and the authoritative blobs are unchanged.

Preserve `migration-dry-run.json`, `migration-apply.json`, and any
`migration-post-verify.json` without adding secrets or raw financial records.
If completed earlier batches reported inserts or updates, the failed apply
evidence must say
`execution.writeSafety.classification: "writes-completed-before-failure"`;
`"possible"` means an attempted apply transaction had an unobservable outcome.
Use the code-deploy rollback above to remove the new callable surface if
necessary. Do not attempt ad hoc row cleanup: removing row declarations does not
necessarily delete stored documents, and cleanup requires its own reviewed,
targeted plan.

### Cleanup after a completely successful session

Only after the apply, standalone verification, idempotency dry run, and auth
probe all pass, copy the redacted evidence documents to the approved encrypted
evidence location. Then remove the temporary checkout:

```bash
case "$run_dir" in
  /tmp/vogel-vault-convex-migration.??????)
    test -d "$run_dir/repo/.git"
    cd /tmp
    rm -rf -- "$run_dir"
    ;;
  *)
    echo "Refusing unexpected cleanup path: $run_dir" >&2
    false
    ;;
esac
```

Before running that final command, print and inspect `"$run_dir"` and confirm it
is the temporary directory created in step 2.
