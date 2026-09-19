# Convex production deploy preflight

Historical deployment packet. Decision #431 retired `convex/writeback.ts` and
nine uncalled `dataFiles` ledger/todo mutations on 2026-09-18. The function
inventory and rollback revisions below describe that earlier candidate, not
the current deployable API. Use `docs/HANDOFF.md` for the current write routes.


Target: `prod:keen-elephant-452`  
Reviewed source: `build/finish-vogel-vault` at `e2d0781`  
Recorded production evidence date: 2026-07-26  
Preflight date: 2026-07-27

> **Historical pre-deploy record.** The row schema/API were subsequently
> deployed and the migration was applied. Do not use this document as current
> deployment state or as an instruction to deploy again. See `docs/HANDOFF.md`
> for the present architecture and use a fresh approved preflight for any
> production operation. Statements below are preserved as evidence about the
> reviewed `e2d0781` bundle before that deployment.

## Verdict

**Do not deploy until `ALLOW_TOKENLESS_SYNC` is confirmed absent on the target.**
Its production value is not recorded in this repository, and this preflight was
explicitly performed without querying the deployment. If it is `"true"`, all
nine newly deployed public mutations listed below will admit a caller without a
sync token. A configured `CONVEX_SYNC_TOKEN` does not make that safe because the
hatch is checked first and outranks the token.

The recorded read posture is safer but is not fresh evidence:
`docs/convex-read-auth-cutover.md` records `ALLOW_TOKENLESS_READ` as absent and
production reads as `ENFORCED` on 2026-07-26. That document explicitly says it
did not re-probe production when it was updated.

Subject to confirming both hatches absent, deploying this source is additive:
it registers five new row-table schemas and their indexes and publishes 17 new
functions. It does not invoke a migration and does not modify a document.
Afterward, the backfill is a separate, explicit operation.

## Evidence boundary

No `convex deploy`, `dev`, `env`, or `run` command was used for this preflight.
Therefore “today” below means the state recorded in committed repository
evidence, not a fresh inspection of `keen-elephant-452`.

At the 2026-07-27 preflight, the committed evidence agreed on these facts:

- The then-current `AGENTS.md` and `docs/HANDOFF.md` recorded only the legacy
  blob tables and said the row schema/backfill/writeback were not yet deployed.
- The then-current `docs/HANDOFF.md` recorded 13 `dataFiles` documents and counts
  of 905 transactions, 31 BTC buys, and 25 todos.
- `docs/convex-read-auth-cutover.md` records the 2026-07-26 read-auth result and
  explicitly warns that it is not a current probe.
- `docs/convex-migration-runbook.md` is not present at reviewed commit
  `e2d0781`; no claim in this preflight depends on it.

The last point is a documentation/evidence gap, not permission to infer target
state.

## 1. Tables: recorded production versus the proposed schema

This list covers application tables, not Convex system tables.

### Production state recorded for the preflight

| Existing table | Proposed action |
| --- | --- |
| `dataFiles` | Keep exactly the same declaration and `by_name` index. |
| `syncVersions` | Keep exactly the same declaration and `by_name` index. |
| `todoTombstones` | Keep exactly the same declaration and `by_todo_id` index. |
| `mobilePairings` | Keep exactly the same declaration and `by_pair_id` index. |
| `mobileDevices` | Keep exactly the same declaration and `by_device_id` index. |

### Newly declared/created by this deploy

| New table | New indexes |
| --- | --- |
| `transactions` | `by_source_tx_id`, `by_owner_month`, `by_owner_date`, `by_month`, `by_date` |
| `todos` | `by_todo_id`, `by_owner_done`, `by_done_updated`, `by_updated` |
| `btcBuys` | `by_source_buy_id`, `by_owner_date`, `by_owner_month`, `by_date` |
| `btcBillPays` | `by_source_bill_pay_id`, `by_owner_date`, `by_owner_month`, `by_date` |
| `btcAccounts` | `by_owner_key`, `by_owner_custody`, `by_key` |

These are the only five additions in `convex/schema.ts`. The schema diff from
the known legacy bundle at `0a5c75d` to `e2d0781` changes explanatory comments,
adds the closed owner/custody validators, and appends those five table
declarations. It does not change or remove a field or index on any of the five
legacy tables. `convex/dataFiles.ts` is also byte-identical at those two commits.

Accordingly, **no existing application table is altered and none is dropped**.
The deploy adds saved schema and indexes for the row tables. Convex only
materializes table documents when a mutation inserts them, so these tables
remain empty until the separately invoked backfill or a public row mutation
writes to them.

Relevant code: `convex/schema.ts:76-282`. Historical comparison:

```bash
git diff 0a5c75d..e2d0781 -- convex/schema.ts
git diff --exit-code 0a5c75d:convex/dataFiles.ts e2d0781:convex/dataFiles.ts
```

## 2. Newly public HTTP-callable functions and their gates

“HTTP-callable” here means a public Convex query or mutation callable through
the Convex client/HTTP query and mutation endpoints. There is no new
`httpAction`.

### Public queries

Every query below calls `validateReadToken(token)` before database access.
For each function, the exact gate is:

```text
if ALLOW_TOKENLESS_READ == "true": allow without checking the token
else if CONVEX_READ_TOKEN is absent: reject
else if the supplied token is absent or unequal: reject
else: allow
```

| Newly callable query | Auth gate |
| --- | --- |
| `tables:listTransactions` | `validateReadToken`; read hatch first, otherwise exact `CONVEX_READ_TOKEN`. |
| `tables:listTodos` | `validateReadToken`; read hatch first, otherwise exact `CONVEX_READ_TOKEN`. |
| `tables:listBtcBuys` | `validateReadToken`; read hatch first, otherwise exact `CONVEX_READ_TOKEN`. |
| `tables:listBtcBillPays` | `validateReadToken`; read hatch first, otherwise exact `CONVEX_READ_TOKEN`. |
| `tables:listBtcAccounts` | `validateReadToken`; read hatch first, otherwise exact `CONVEX_READ_TOKEN`. |
| `tables:getBudgetDocument` | `validateReadToken`; read hatch first, otherwise exact `CONVEX_READ_TOKEN`. |
| `tables:getBtcSnapshotMetadata` | `validateReadToken`; read hatch first, otherwise exact `CONVEX_READ_TOKEN`. |
| `tables:rowCounts` | `validateReadToken`; read hatch first, otherwise exact `CONVEX_READ_TOKEN`. |

The shared read token is household-level authentication, not person-level
identity. A token holder supplies `viewer`; the server applies the visibility or
net-worth scope associated with that asserted viewer, but does not prove the
caller is that family member. `convex/tables.ts:149-161` states this limitation
directly.

### Public mutations

Every mutation below calls `validateSyncToken(token)` before database access.
For each function, the exact gate is:

```text
if ALLOW_TOKENLESS_SYNC == "true": allow without checking the token
else if CONVEX_SYNC_TOKEN is absent: reject
else if the supplied token is absent or unequal: reject
else: allow
```

| Newly callable mutation | Auth gate | Data it can change after deploy |
| --- | --- | --- |
| `tables:upsertTransaction` | `validateSyncToken`; sync hatch first, otherwise exact `CONVEX_SYNC_TOKEN`. | `transactions` rows only. |
| `tables:upsertTodo` | `validateSyncToken`; sync hatch first, otherwise exact `CONVEX_SYNC_TOKEN`. | `todos` rows only. |
| `tables:deleteTodo` | `validateSyncToken`; sync hatch first, otherwise exact `CONVEX_SYNC_TOKEN`. | `todos` rows only; deliberately does not touch legacy tombstones. |
| `tables:upsertBtcBuy` | `validateSyncToken`; sync hatch first, otherwise exact `CONVEX_SYNC_TOKEN`. | `btcBuys` rows only. |
| `tables:upsertBtcAccount` | `validateSyncToken`; sync hatch first, otherwise exact `CONVEX_SYNC_TOKEN`. | `btcAccounts` rows only. |
| `writeback:createTransaction` | `validateSyncToken`; sync hatch first, otherwise exact `CONVEX_SYNC_TOKEN`. | Legacy transaction blob, its sync version, and `writeback-audit`. |
| `writeback:editTransaction` | `validateSyncToken`; sync hatch first, otherwise exact `CONVEX_SYNC_TOKEN`. | Legacy transaction blob, its sync version, and `writeback-audit`. |
| `writeback:createTodo` | `validateSyncToken`; sync hatch first, otherwise exact `CONVEX_SYNC_TOKEN`. | Legacy todos blob, its sync version, and `writeback-audit`. |
| `writeback:editTodo` | `validateSyncToken`; sync hatch first, otherwise exact `CONVEX_SYNC_TOKEN`. | Legacy todos blob, its sync version, and `writeback-audit`. |

This is why the unknown sync-hatch state blocks the deploy: the last four
mutations can change the surviving authoritative blobs once called. They are
strict validating write paths, but authentication becomes optional if the hatch
is enabled.

Code evidence:

- `convex/tables.ts:596-895` calls the read gate in all eight public queries.
- `convex/tables.ts:1140-1288` calls the sync gate in all five public mutations.
- `convex/writeback.ts:866-1315` calls the sync gate in all four public
  mutations.
- `convex/tables.ts:63-112` and `convex/writeback.ts:64-106` implement the
  hatch-first gates.

### Not public

`migrate:status`, `migrate:migrateFile`, and `migrate:verifyFile` are declared
with `internalQuery`/`internalMutation`, not `query`/`mutation`. They require
deployment-admin authority and are not callable by an ordinary client over the
public Convex API. Deploying them does not run them.

The existing `dataFiles:*` public surface is not newly exposed by this deploy.
Its implementation is byte-identical to the known legacy bundle at `0a5c75d`.

## 3. What the deploy itself changes

**Deploying the schema/function bundle alone changes no existing document.**
It changes deployed code, saved schema, and index configuration.

The proof is:

1. Production `npx convex deploy` typechecks, bundles, and pushes functions,
   indexes, and schema. It does not invoke a production function; the CLI's
   optional `--preview-run` applies only to preview deployments.
2. The schema is declarative. Its diff only appends five row-table declarations
   and their indexes; it contains no data operation.
3. No module performs a database write at module load. Writes exist only inside
   mutation handlers, which run only when called.
4. The backfill functions are internal and do not run on deploy.
   `migrate:migrateFile` defaults `apply` to `false`; its only `db.insert` and
   `db.patch` calls are guarded by `if (apply)`.
5. `convex/migrate.test.ts` snapshots all of `dataFiles`, `syncVersions`, and
   `todoTombstones`. It proves both the default dry run and an applied migration
   leave that “blob world” byte-for-byte equal. The applied migration writes
   only the new row tables.

The honest operational consequence is broader than “no data changes”: after
the deploy, the 17 functions above exist and can change data if somebody calls
them with an accepted credential—or without one while the matching hatch is
enabled. Schema deploy and backfill must therefore remain separate steps.

Convex documents the deploy operation and additive schema safety here:

- <https://docs.convex.dev/cli/reference/deploy>
- <https://docs.convex.dev/production/overview#making-safe-changes>

## 4. Escape-hatch state and required post-deploy state

| Variable | What is known on `keen-elephant-452` | Required post-deploy state |
| --- | --- | --- |
| `ALLOW_TOKENLESS_READ` | Recorded **absent** on 2026-07-26; not freshly verified in this preflight. | **Absent**, with `CONVEX_READ_TOKEN` configured and a known-good/anonymous/wrong-token probe reporting `ENFORCED`. |
| `ALLOW_TOKENLESS_SYNC` | **Unknown.** No committed production observation records its value, and this preflight did not query the deployment. | **Absent**, with `CONVEX_SYNC_TOKEN` configured. |

For both gates the hatch outranks a set token. If either hatch equals the exact
string `"true"`, that entire gate is permissive. Listing a matching token as
configured does not prove enforcement.

The parent deploy session must establish target state before deploying:

1. Confirm `ALLOW_TOKENLESS_READ` is absent, without printing token values.
2. Confirm `ALLOW_TOKENLESS_SYNC` is absent, without printing token values.
3. Confirm `CONVEX_READ_TOKEN` and `CONVEX_SYNC_TOKEN` are present, again without
   printing values.
4. Run the repository's known-good read probe after deploy:

   ```bash
   CONVEX_READ_TOKEN="$THE_TOKEN" scripts/verify-read-auth.sh --expect enforced
   ```

Do not set either hatch as part of this schema deploy. A hatch is an
incident-only availability rollback that deliberately opens the corresponding
surface.

## 5. Exact deploy rollback

This rollback is for a bad schema/function deploy **before the backfill is
invoked**. Stop the sequence immediately; do not run the migration merely to
test whether the deploy can be salvaged.

Commit `0a5c75d` is the reproducible rollback bundle:

- it has the same `convex/dataFiles.ts` bytes as `e2d0781`, including the
  currently recorded fail-closed read/sync gates;
- its `convex/schema.ts` declares only the five legacy tables;
- it contains neither `convex/tables.ts`, `convex/migrate.ts`, nor
  `convex/writeback.ts`.

From a clean clone of this repository:

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

That redeploy removes the 17 newly public functions and restores the legacy
saved schema/function bundle. It does not restore data because the deploy did
not change any data. Deployment environment variables are separate state and
must not be changed during this rollback.

Then verify, in this order:

1. Confirm both tokenless hatches are absent.
2. Run the known-good read-auth probe with `--expect enforced`.
3. Exercise the shipped blob reader.
4. Confirm no migration was run and do not start it until the deploy defect has
   been corrected and re-reviewed.

If the backfill has already started, redeploying `0a5c75d` still closes the new
public surface and restores the legacy client path, but it is **not** a data
rollback. Do not delete row documents ad hoc: the blobs remain authoritative,
and any cleanup of partially populated row tables requires its own reviewed,
targeted plan. Removing a table from the saved schema does not itself delete its
documents; Convex permits data tables that are not declared in the schema.

If the immediate defect is that `ALLOW_TOKENLESS_SYNC=true`, first remove that
hatch to close unauthenticated mutation access, then perform the code rollback
above. Never use either tokenless hatch to roll back a bad deploy; a hatch rolls
authentication back to open, not code back to safe.
