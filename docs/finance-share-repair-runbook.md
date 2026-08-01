# Finance share-quantity repair runbook

Target deployment: `prod:keen-elephant-452`

> **One-time repair, not a synchronization.** This rewrites the single stored
> `financeDocuments` row so its share quantities match the tightened shares
> contract. It is not part of the row cutover, it migrates no new file, and it
> must never be generalized into "re-run the migration". Read
> `docs/convex-migration-runbook.md` first: it owns the plan-fingerprint gate,
> the evidence rules, and the deploy/rollback procedure this document reuses.

Nothing here is fresh evidence about production. Every command below was written
against `convex/migrate.ts`, `scripts/convex-migrate.mjs` and the `convex-test`
suite; no `convex deploy`, `env`, `run`, `data`, or `export` command was executed
while preparing it. Confirm each command's output shape against a dev deployment
before running it with `--prod`.

## What is being repaired, and what is not

The stored row was projected before the shares contract existed. Two shapes in
it are real data that the contract now spells differently:

- lot and holding quantities written straight from IEEE-754 doubles, carrying
  15–16 fractional digits against a retained scale of 12;
- a `statement_reconciliation` lot that removes shares and is therefore stored
  negative.

`convex/documentProjection.ts` now canonicalizes both at projection time, so
re-projecting the untouched source blob over the existing row replaces the noisy
text with quantized text and keeps the sign. The read path in `convex/tables.ts`
repairs the same values on the fly, so **the application is already correct
without this repair** — it is a one-line constant warning per read that says the
stored row is still pre-canonical. That makes this a low-urgency cleanup that
must never be run under time pressure.

Not repaired here, and not in scope: the `dataFiles` blob. It is the source of
truth for the shipped clients that have not been cut over, and no step below
writes to `dataFiles`, `syncVersions`, or `todoTombstones`.

## Preconditions

All of these must hold before any command in the next section runs.

1. **Clients ship first — before the backend deploy in precondition 2 and
   before the repair.** Every client that has not been updated fails the whole
   finance document closed the moment the backend emits a signed lot, so
   backend-first ordering breaks every installed client at once.

   - The updated, same-signed Android APK containing the signed-lot decoder is
     **installed on the Fold**, and confirmed by reading the app's version and
     build identity off the device — not from memory, and not from the fact that
     a build was produced:

     ```bash
     adb shell dumpsys package com.sats21m.vogelvault \
       | grep -E 'versionName|versionCode|firstInstallTime|lastUpdateTime'
     ```

     The reported `versionName`/`versionCode` must be the build produced from
     the reviewed checkout. Anything older, or any doubt, is a stop.
   - Any active Linux client is running a build that contains the signed-lot
     transport change. If a stale Linux client is running anywhere, update or
     shut it down before continuing.

2. **The deployed code is the reviewed checkout.** Work from a clean, pinned
   worktree of the merge commit that contains the canonicalizing projection, run
   `npm ci`, and confirm generated types are not stale:

   ```bash
   scripts/verify-convex-generated-freshness.sh
   ```

   Then deploy that exact commit per `docs/convex-migration-runbook.md` §4. A
   repair applied against an older deployed projection writes the *old* text
   back and silently undoes itself.

3. **Read auth is enforced.**

   ```bash
   read -rsp "Convex production read token: " vv_read_token
   printf '\n'
   CONVEX_READ_TOKEN="$vv_read_token" scripts/verify-read-auth.sh --expect enforced
   unset vv_read_token
   ```

   Good: exit 0 with `STATE: ENFORCED`. Anything else is a stop.

4. **The backend agrees there is exactly one finances row to update.**

   ```bash
   run_dir="$(mktemp -d "$HOME/work/vogel-vault-finance-repair.XXXXXX")"
   chmod 700 "$run_dir"
   umask 077

   npx convex run --prod migrate:status > "$run_dir/status.json"
   jq -e '
     .files[] | select(.file == "finances")
     | .blobPresent == true
       and .blobUnreadable == false
       and .migratedRowCount == 1
       and .projectedRowCount == 1
       and .runtimeLocked == false
   ' "$run_dir/status.json"
   ```

   `blobPresent: false` means there is nothing to project — stop.
   `migratedRowCount: 0` means this is an *insert*, not a repair, and belongs to
   the migration runbook with its two-person review. `runtimeLocked: true` means
   `finances` has accepted runtime writes since cutover; the migration refuses it
   by design and so does this repair.

5. **`$run_dir` is not `/tmp`.** `/tmp` is a RAM-backed tmpfs on every fleet
   machine, and the snapshot below holds the complete household finance row.

## Blob-freshness proof — run this before the repair, not after

The repair re-projects the current blob. That is only a *quantity* repair if the
blob's content has not changed since the row was written; if it has, the same
command silently publishes new financial content under the label "repair".

Take both sides:

```bash
npx convex run --prod --inline-query \
  'await ctx.db.query("dataFiles").withIndex("by_name", (q) => q.eq("name", "finances")).unique().then((d) => ({ version: d.version, updatedAt: d.updatedAt }))' \
  > "$run_dir/blob-freshness.json"

npx convex run --prod --inline-query \
  'await ctx.db.query("financeDocuments").withIndex("by_source_file", (q) => q.eq("sourceFile", "finances")).unique().then((d) => ({ creationTime: d._creationTime }))' \
  > "$run_dir/row-freshness.json"

jq -e --argjson row "$(cat "$run_dir/row-freshness.json")" \
  '.updatedAt <= $row.creationTime' "$run_dir/blob-freshness.json"
```

Good: the blob's `updatedAt` predates the stored row's `_creationTime`. The row
was projected from this blob, so re-projecting changes only what the projection
itself now spells differently.

Bad, and a hard stop: `updatedAt` is newer than the row. A sync has written new
finances content since the migration. That is an ordinary migration with new
data, not a repair — take it through `docs/convex-migration-runbook.md` with its
full review, and do not use this document.

Corroborate with the machine-checkable half. `verifyFile` compares the row's
retained `migrationRawJson` against the current blob:

```bash
node scripts/convex-migrate.mjs --verify --only finances --prod --json \
  > "$run_dir/pre-verify.json"
jq -e '
  .files[] | select(.file == "finances") | .verification
  | .ok and .rowCountMatches and .moneySumsMatch
    and .roundTripRowsMatch and .exactRoundTrip
' "$run_dir/pre-verify.json"
```

Read that result narrowly. `exactRoundTrip: true` proves the row's retained
source still equals the blob. **It is not evidence that the share quantities are
repaired, and it never will be** — it compares raw source to raw source and
never looks at a projected share string. It will read `true` both before and
after this repair. Anyone offering it as proof of the repair has proved nothing.

## The repair

### 1. Dry run, scoped to one file

```bash
node scripts/convex-migrate.mjs --only finances --prod --json \
  > "$run_dir/repair-dry-run.json"

jq -e '
  .files[] | select(.file == "finances") | .counts
  | .updated == 1 and .inserted == 0 and .unchanged == 0
' "$run_dir/repair-dry-run.json"
```

Good: `updated: 1`. That is the whole point — the existing row is patched in
place.

Bad, and a hard stop in each case:

- `inserted: 1`. The backend does not consider the stored row a match for the
  projected one, so applying would **add a second row and leave the legacy one
  behind**, which every reader then has to choose between. Do not apply.
  Diagnose the natural key with read-only inspection.
- `unchanged: 1`. There is nothing to repair. Either the repair already ran or
  the deployed code is not the reviewed checkout. Stop and re-check
  precondition 2.
- Any file other than `finances` appears in the plan. `--only finances` was
  dropped; re-run with it.

### 2. Snapshot the row before writing

```bash
npx convex run --prod --inline-query \
  'await ctx.db.query("financeDocuments").collect()' \
  > "$run_dir/finance-row-before.json"
chmod 600 "$run_dir/finance-row-before.json"
jq -e 'type == "array" and length == 1' "$run_dir/finance-row-before.json"
```

This file holds the complete household finance row. It is mode `0600`, it lives
under `$run_dir` (mode `0700`, not `/tmp`), it is never printed, pasted into a
prompt, attached to a PR, or committed, and it is `shred -u`'d at cleanup. It
exists for exactly two purposes: the rollback path below, and the before/after
signed-lot count in step 5.

Record the signed-lot count now, as a number and nothing else:

```bash
signed_lots_before="$(
  jq -er '[.[] | .accounts[] | .holdings[] | .lots[]
          | select(.sharesDecimal | startswith("-"))] | length' \
    "$run_dir/finance-row-before.json"
)"
printf 'signed lots before: %s\n' "$signed_lots_before"
```

Record whatever number this prints. It is the baseline for step 5, which
requires the count to be **equal** afterwards. Do not compare it against an
expected value: this document states no expected per-account contents, and a
count that differs from an operator's recollection is not by itself a finding.

### 3. Apply, bound to the reviewed plan

```bash
plan_fingerprint="$(
  jq -er '
    .operation.frozenPlan
    | select(.fingerprintState == "provided")
    | .fingerprint
    | select(test("^sha256:[0-9a-f]{64}$"))
  ' "$run_dir/repair-dry-run.json"
)"
test -n "$plan_fingerprint"

node scripts/convex-migrate.mjs \
  --apply \
  --only finances \
  --prod \
  --confirm-production \
  --expected-plan-fingerprint "$plan_fingerprint" \
  --json \
  > "$run_dir/repair-apply.json"
```

Do not pass `--batch-size`. The default is 1000, the file projects one document,
and the backend only runs its in-transaction read-back verification when the
whole file fits in one batch from cursor 0. A batch size of 1 would apply the
write with **no** transactional verification and no rollback on mismatch.

Do not type, infer, or regenerate `plan_fingerprint`. If the CLI reports
`PLAN_FINGERPRINT_MISMATCH`, the blob changed between the dry run and now: stop,
preserve the evidence, and start again from the blob-freshness proof.

```bash
jq -e '
  .outcome == "success"
  and .operation.frozenPlan.expectedFingerprintMatched == true
  and .execution.state == "completed"
  and (.files[] | select(.file == "finances")
       | .verifiedInTransaction == true
         and .counts.updated == 1
         and .counts.inserted == 0
         and .verification.ok == true
         and .verification.problemCount == 0)
' "$run_dir/repair-apply.json"
```

`problemCount`, not `problems`: the CLI redacts the backend verification down to
counts and booleans before writing JSON (`safeVerification` in
`scripts/convex-migrate.mjs`), so the problem *messages* never reach the file. A
gate written against `.verification.problems` passes vacuously — jq gives `null`
a length of `0` — and proves nothing.

### 4. Post-apply verification and idempotency

```bash
node scripts/convex-migrate.mjs --verify --only finances --prod --json \
  > "$run_dir/post-verify.json"
jq -e '
  .files[] | select(.file == "finances")
  | .state == "verify"
  and (.verification
       | .ok and .rowCountMatches and .moneySumsMatch
         and .roundTripRowsMatch and .exactRoundTrip
         and .problemCount == 0)
' "$run_dir/post-verify.json"

node scripts/convex-migrate.mjs --only finances --prod --json \
  > "$run_dir/idempotency-dry-run.json"
jq -e '
  .files[] | select(.file == "finances") | .counts
  | .unchanged == 1 and .updated == 0 and .inserted == 0
' "$run_dir/idempotency-dry-run.json"
```

`unchanged: 1` is what closes the repair: the stored row is now byte-identical
to what the current projection produces, so a re-run is a no-op.

### 5. Structural check on the stored text, printing no values

The counts above prove a write happened and round-tripped. They do not prove the
stored *share strings* are canonical. This does, and it emits only integers:

```bash
npx convex run --prod --inline-query \
  'await ctx.db.query("financeDocuments").collect()' \
  > "$run_dir/finance-row-after.json"
chmod 600 "$run_dir/finance-row-after.json"

jq -e --argjson before "$signed_lots_before" '
  def shares: [.[] | .accounts[] | .holdings[]
               | (.sharesDecimal, (.lots[] | .sharesDecimal))];
  def lotShares: [.[] | .accounts[] | .holdings[] | .lots[] | .sharesDecimal];
  {
    quantities:        (shares | length),
    overlongFractions: ([shares[] | select(test("\\.[0-9]{13,}$"))] | length),
    nonCanonical:      ([shares[]
                         | select(test("^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$") | not)]
                        | length),
    signedLots:        ([lotShares[] | select(startswith("-"))] | length)
  }
  | debug
  | .overlongFractions == 0 and .nonCanonical == 0 and .signedLots == $before
' "$run_dir/finance-row-after.json"
```

Good: `overlongFractions` and `nonCanonical` are `0`, and `signedLots` equals the
count taken before the repair. No quantity, account key, holding name or ticker
is printed — only four integers.

`signedLots` lower than `$before` has exactly one legitimate explanation: a
negative lot whose magnitude was smaller than half the retained scale rounds away
to plain `0`, because minus zero has no canonical spelling. Treat any drop as a
stop until you have identified which lot changed sign using the two `0600`
snapshots and nothing else. `signedLots` *higher* than `$before` is never
legitimate.

Finally, repeat the enforced read-auth probe from precondition 3, and confirm a
`tables:getFinanceDocument` read from a client no longer emits the constant
`financeDocuments: repaired non-canonical stored share quantities at read time`
warning in the Convex function logs. That warning disappearing is the
user-visible close-out; it carries no identifiers, so it is safe to grep for.

## Rollback

The blob is never mutated by any step above, so the authoritative source that
every not-yet-cut-over client reads is unaffected by any failure here. There are
two recovery paths, in order of preference.

**Re-project (preferred).** The row is a pure function of the blob and the
deployed projection. Redeploy the previous Convex bundle per
`docs/convex-migration-runbook.md` §Rollback, then re-run the dry run and apply
from step 1. The old projection writes the old text back. Nothing is lost,
because nothing in the row is authored — it is all derived.

**Restore the snapshot (only if re-projection is impossible).**
`$run_dir/finance-row-before.json` holds the exact prior row. Restoring it
requires a reviewed, targeted mutation that does not exist today; write one, have
it reviewed, and apply it from a pinned checkout. Do not improvise with
`convex import`, which replaces tables rather than patching a row.

If the apply itself fails, stop. Each file verifies inside its own mutation, so a
verification failure throws and Convex rolls that file's writes back atomically;
the row is either fully repaired or untouched. Preserve `repair-dry-run.json`,
`repair-apply.json`, and any `post-verify.json` with no secrets and no raw
financial records, and check that the apply evidence reports
`execution.writeSafety.classification`. `"possible"` means an attempted apply
transaction had an unobservable outcome — re-read the row before doing anything
else.

## Must NOT

- **No `dataFiles:sync` or `dataFiles:remove` for `finances`.** The blob is the
  source of truth for the shipped clients. This repair is downstream of it and
  never writes upstream.
- **No full-catalogue `--apply`.** Always `--only finances`. An unscoped apply
  re-projects every migratable file, which is a different, much larger change
  requiring the migration runbook's two-person review.
- **No `npx convex import`, and never `--replace`.** It replaces table contents
  wholesale. Nothing in this repair replaces a table.
- **No `--batch-size`.** See step 3: a batch smaller than the file disables the
  in-transaction verification that makes the write safe.
- **No `exactRoundTrip` as proof of share repair.** It compares the row's
  retained raw source to the raw blob and never sees a projected share string.
  It reads `true` before and after. The step 5 structural check is the only
  evidence that the stored quantities are canonical.
- **No repair while `runtimeLocked` is true**, and no removing the lock to make
  the command run. The lock means something other than the migration owns the
  row now.
- **No printing, pasting, or committing the row snapshots.** They are the
  complete household finance record.

## Cleanup

Only after every check above has passed:

```bash
shred -u "$run_dir"/finance-row-before.json "$run_dir"/finance-row-after.json
```

Copy the redacted JSON evidence documents — which contain counts, fingerprints
and states, never rows — to the approved encrypted evidence location, then:

```bash
case "$run_dir" in
  "$HOME"/work/vogel-vault-finance-repair.??????)
    rm -rf -- "$run_dir"
    ;;
  *)
    echo "Refusing unexpected cleanup path: $run_dir" >&2
    false
    ;;
esac
```
