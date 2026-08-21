# Convex production deploy preflight

Target: `prod:keen-elephant-452`  
Reviewed source: `build/finish-vogel-vault` at `e2d0781`  
Recorded production evidence date: 2026-07-26  
Preflight date: 2026-07-27
Current-use review: 2026-08-21

> **Historical pre-deploy record.** The row schema/API were subsequently
> deployed and the migration was applied. Do not use this document as current
> deployment state or as an instruction to deploy again. See `docs/HANDOFF.md`
> for the present architecture and use a fresh approved preflight for any
> production operation. Statements below are preserved as evidence about the
> reviewed `e2d0781` bundle before that deployment. The rollback bundle formerly
> named in section 5 is unsafe for current production and has been superseded by
> the proof-derived procedure below.

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

## Evidence boundary: recorded 2026-07-27, not current state

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

## 5. Current deploy rollback procedure

This section is the single rollback authority for a current production
operation. The reviewed promotion amendment delegates here and does not define
another rollback path.

> **Do not deploy commit `0a5c75d` to current production.** It remains the
> correct pre-backfill rollback bundle for the historical 2026-07-27 operation
> only. Production had 74 live functions on 2026-08-21. `0a5c75d` would keep 16
> and remove 58, including 3 current `dataFiles` functions and all 55 functions
> in `tables`, `writeback`, `migrate`, `marketQuotes`, `readCanary`,
> `operatorImport`, and `btcLedger`. It would remove the row API used by the
> shipped Android and Linux clients and cause an outage.

For the operation reviewed on 2026-08-21, the measured rollback point is commit
`e1af28546920fd1ae8daefb541d0c8f5dbadfa3c`, tree
`c092895e6c8e5fd69986ec29fcc022ee2f6e8cd2`. It exactly matched the deployed
function bundle. Its production dry run targeted `prod:keen-elephant-452`,
exited 0 in 4 seconds, and found no function, index, or schema delta. The only
reported deployment change was the Node.js action server version. Codegen and
the dry run left its worktree clean.

The frozen production function-spec baseline is
`/home/victor/work/vv-parent/prod-function-spec-baseline.json`, SHA-256
`b44e4be47f7deec189516386acd156eb6d6df50fcdfd90f2c6647a5e98be2c46`,
with the production URL and 74 functions. The corroborating 74 sorted
`module.js:name` identifiers are frozen at
`/home/victor/work/vv-parent/prod-function-identifiers.txt`, SHA-256
`3ff6358ade141753d19138e5d65259975a3592ef89d3d0efe1de9baf56eef799`.
Independent direct-export and TypeScript AST scans produced that same identifier
hash with zero missing and zero extra identifiers.

Those values bind only the reviewed 2026-08-21 operation. Immediately before
every future promotion, remeasure the deployed state, prove its exact commit,
and freeze a new full SHA, tree, function-spec baseline, identifier inventory,
auth result, and dry-run result. Never turn the dated SHA above into a permanent
rollback target. Never substitute `main`, the candidate's parent, another
historical SHA, or a function-name inventory. Different function bodies can
export identical names.

### Prove and stage the rollback bundle before deploying

1. Read the deployment history for `prod:keen-elephant-452`. Record the newest
   successful deploy entry and its message. It must identify one unambiguous
   full 40-character lowercase commit SHA. Preserve audit evidence. If the
   history does not prove the SHA, stop and ask the production owner. Do not
   infer it.
2. Resolve that exact commit and tree. From a dedicated parent shell, use the
   fail-closed staging procedure below. Replace the operation-specific SHA and
   tree only with newly measured values. The destination must not already exist;
   this procedure does not delete or reuse a path.

   ```bash
   set -euo pipefail
   set +x

   repo=/home/victor/work/vv-parent/repo
   rollback_sha=e1af28546920fd1ae8daefb541d0c8f5dbadfa3c
   rollback_tree=c092895e6c8e5fd69986ec29fcc022ee2f6e8cd2
   rollback_dir="/home/victor/work/vogel-vault-rollback-${rollback_sha}"

   [[ "$rollback_sha" =~ ^[0-9a-f]{40}$ ]]
   test "$(git -C "$repo" cat-file -t "$rollback_sha")" = commit
   test "$(git -C "$repo" rev-parse "${rollback_sha}^{commit}")" = "$rollback_sha"
   test "$(git -C "$repo" rev-parse "${rollback_sha}^{tree}")" = "$rollback_tree"
   test ! -e "$rollback_dir"
   git -C "$repo" worktree add --detach "$rollback_dir" "$rollback_sha"

   test "$(git -C "$rollback_dir" rev-parse HEAD)" = "$rollback_sha"
   test "$(git -C "$rollback_dir" rev-parse 'HEAD^{tree}')" = "$rollback_tree"
   test -z "$(git -C "$rollback_dir" status --porcelain)"
   cd "$rollback_dir"
   npm ci
   test "$(git -C "$rollback_dir" rev-parse HEAD)" = "$rollback_sha"
   test "$(git -C "$rollback_dir" rev-parse 'HEAD^{tree}')" = "$rollback_tree"
   test -z "$(git -C "$rollback_dir" status --porcelain)"
   ```

3. Keep this credentialed stage in the parent shell. Keep tracing disabled.
   Never put deploy keys or tokens in prompts, files, logs, or command arguments,
   and never print their values. Load the sanctioned
   `/home/victor/.config/sats/secrets.env` into that process, confirm the target,
   confirm both configured token names are present, and confirm both tokenless
   hatches are absent. Require `scripts/verify-read-auth.sh --expect enforced`
   to report `STATE: ENFORCED` without exposing a credential.
4. Run the authorized production dry run from the rollback worktree. Its
   `--codegen enable` stage can change generated files, so re-read the exact
   HEAD, tree, and cleanliness immediately after the combined codegen and dry
   run. Do not accept or clean up a changed checkout.

   ```bash
   set +x
   trap 'unset CONVEX_DEPLOY_KEY CONVEX_READ_TOKEN CONVEX_SYNC_TOKEN' EXIT
   set -a
   . /home/victor/.config/sats/secrets.env
   set +a

   scripts/verify-read-auth.sh --expect enforced

   CONVEX_DEPLOYMENT=prod:keen-elephant-452 \
     npx convex deploy \
       --dry-run \
       --typecheck enable \
       --codegen enable \
       --message "preflight rollback bundle ${rollback_sha}"

   test "$(git -C "$rollback_dir" rev-parse HEAD)" = "$rollback_sha"
   test "$(git -C "$rollback_dir" rev-parse 'HEAD^{tree}')" = "$rollback_tree"
   test -z "$(git -C "$rollback_dir" status --porcelain)"
   ```

5. Freeze only structural, redacted evidence. Record the exact rollback SHA and
   tree, clean status after dependency installation and after codegen plus dry
   run, the function-spec baseline and hash, the identifier inventory and hash,
   the auth result, dry-run target, exit status, elapsed time, and reported
   delta. Do not retain raw credential-bearing output.
6. Any missing served module or function blocks the rollback plan. Matching names
   are necessary corroboration, but only the deployment-history and exact-bundle
   proof establish the rollback commit. Production deployment must not begin
   until the owner approves the candidate and this exact rollback target.

### Execute rollback only after a failed approved deploy

Keep production writers quiet during deployment, verification, and any rollback.
From the already verified rollback worktree, recheck the exact SHA, tree, and
clean status, then redeploy only with the production owner's explicit approval.
Keep tracing disabled and use the same parent-process credential boundary:

```bash
set -euo pipefail
set +x

repo=/home/victor/work/vv-parent/repo
rollback_sha=e1af28546920fd1ae8daefb541d0c8f5dbadfa3c
rollback_tree=c092895e6c8e5fd69986ec29fcc022ee2f6e8cd2
rollback_dir="/home/victor/work/vogel-vault-rollback-${rollback_sha}"

[[ "$rollback_sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$repo" cat-file -t "$rollback_sha")" = commit
test "$(git -C "$repo" rev-parse "${rollback_sha}^{commit}")" = "$rollback_sha"
test "$(git -C "$repo" rev-parse "${rollback_sha}^{tree}")" = "$rollback_tree"
test -d "$rollback_dir"
test "$(git -C "$rollback_dir" rev-parse HEAD)" = "$rollback_sha"
test "$(git -C "$rollback_dir" rev-parse 'HEAD^{tree}')" = "$rollback_tree"
test -z "$(git -C "$rollback_dir" status --porcelain)"

cd "$rollback_dir"
trap 'unset CONVEX_DEPLOY_KEY CONVEX_READ_TOKEN CONVEX_SYNC_TOKEN' EXIT
set -a
. /home/victor/.config/sats/secrets.env
set +a

CONVEX_DEPLOYMENT=prod:keen-elephant-452 \
  npx convex deploy \
    --typecheck enable \
    --codegen enable \
    --message "rollback failed deploy to ${rollback_sha}"

test "$(git -C "$rollback_dir" rev-parse HEAD)" = "$rollback_sha"
test "$(git -C "$rollback_dir" rev-parse 'HEAD^{tree}')" = "$rollback_tree"
test -z "$(git -C "$rollback_dir" status --porcelain)"
```

Afterward, verify in this order:

1. Confirm both tokenless hatches remain absent and both configured tokens remain
   present, without printing values.
2. Require the known-good read-auth probe to report `STATE: ENFORCED`.
3. Refetch the complete production function spec using the same byte-stable
   method that created the frozen immediate-predeploy baseline. Require exact
   SHA-256 equality with that baseline. For the reviewed 2026-08-21 operation,
   the required hash is
   `b44e4be47f7deec189516386acd156eb6d6df50fcdfd90f2c6647a5e98be2c46`.
   Mechanically check the refetched file:

   ```bash
   baseline_sha=b44e4be47f7deec189516386acd156eb6d6df50fcdfd90f2c6647a5e98be2c46
   umask 077
   refetched_spec="$(mktemp /home/victor/work/vv-parent/prod-function-spec-after-rollback.XXXXXX)"
   npx convex function-spec > "$refetched_spec"
   test "$(sha256sum "$refetched_spec" | cut -d' ' -f1)" = "$baseline_sha"
   ```

   For a future operation, use its newly frozen immediate-predeploy baseline
   and hash instead. A function-name match or a count of 74 is insufficient.
4. Exercise the shipped row and blob readers plus the write paths affected by the
   failed deployment.
5. End the quiet-writer window only after the production owner accepts the
   evidence.

Code rollback does not undo data mutations. If the failed candidate wrote fields
or documents that the proven rollback schema does not accept, do not deploy the
old schema blindly. Keep authentication fail-closed and prepare a separately
reviewed compatibility rollback that restores the previous function behavior
while retaining schema support for the new stored data. Do not delete row
documents ad hoc.

Never change deployment environment variables during a code rollback. In
particular, never set either tokenless hatch to recover from a bad deploy. A
hatch opens authentication; it does not restore code.

### Historical evidence retained for audit

For the 2026-07-27 pre-backfill operation, `0a5c75d` had the same
`convex/dataFiles.ts` bytes as `e2d0781`, declared only the five legacy tables,
and omitted `convex/tables.ts`, `convex/migrate.ts`, and `convex/writeback.ts`.
That made it a valid rollback for that historical, pre-row deployment. The later
row migration and client cutover permanently ended that scope.
