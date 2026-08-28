# Linux device writeback

The Linux client uses a per-device credential. It never receives or sends
`CONVEX_SYNC_TOKEN`; that household operator credential is accepted only by the
trusted pairing-mint path.

Desktop row writes are enabled only when the main process starts with
`VOGEL_VAULT_DEVICE_WRITES=1`; pairing alone does not enable mutations.

## Installed launcher

After an approved AppImage has been packaged, install it from the repository:

```bash
cd linux
npm run install:linux -- --appimage /approved/path/Vogel-Vault-<version>-x86_64.AppImage
```

The installer puts the raw artifact under `~/.local/opt/vogel-vault/`. It makes
both `~/.local/bin/vogel-vault` and `~/.local/bin/vogel-vault-launch` resolve to
the same repository-owned launcher, and writes the desktop entry against
`~/.local/bin/vogel-vault`. The launcher reads the Convex read credential from
the login keyring, enables authenticated reads and device writes, then executes
the installed AppImage. A missing keyring credential stops the launch instead
of silently opening the installed app with demo fixtures.

Do not replace either command with a symlink to the raw AppImage. Directly
running the artifact is an unconfigured diagnostic launch and may use the
sanitized demo fallback.

## Capabilities

Pairings and devices may carry this closed set:

- `todos:write`
- `transactions:write`
- `budget:write`
- `bitcoin:write`

An absent capability field is the compatibility value `["todos:write"]`.
An explicit empty array grants nothing. Claiming copies the server-minted field
verbatim and returns its normalized value; a claimant cannot request grants.
Duplicates are removed in the canonical order above, so at most four grants are
stored or returned.

The explicitly full-capability Linux credential is a household-admin
credential. Its capabilities authorize writes for every closed owner/source
pair supported by the resource; the renderer does not supply an authoritative
actor identity. The server accepts no actor field and derives no authorization
from UI state or ownership labels. Owner checks instead keep the request,
payload, source file, and any existing natural key consistent.

The existing `dataFiles:{upsert,complete,remove}TodoFromMobile` functions
explicitly require `todos:write`. Linux row writes use:

- `tables:{upsert,delete}TransactionFromDevice`
- `tables:{upsert,delete,restore}TodoFromDevice`
- `tables:{upsert,delete}BudgetCategoryFromDevice`
- `tables:{upsert,delete}BtcBuyFromDevice`
- `tables:{upsert,delete}BtcBillPayFromDevice`
- `tables:{upsert,delete}BtcAccountFromDevice`

Every call requires `deviceId`, `deviceToken`, a closed owner/source pair, and a
validated payload. Upserts return exactly
`{ok:true,entityId,outcome:"inserted"|"updated"}`; deletes return exactly
`{ok:true,entityId,removed}`. `dataFiles:revokeMobileDevice` lets a device revoke
itself and is idempotent.

Validation is enforced again at the Convex mutation boundary rather than
trusted to the Electron client. Identifiers are canonical, bounded, non-empty
strings; text is bounded and control-character-free; revisions are
non-negative safe integers; money and sats obey each resource's sign rules.
Ledger dates and todo due dates are real `yyyy-MM-dd` calendar days. Device
timestamps (`todo.createdAt`, `updatedAt`, `completedAt`, BTC account `asOf`,
and valuation `quotedAt`) are real UTC ISO instants ending in `Z`. A structured
`VALIDATION_FAILED` response commits no rows, tombstones, cutover lock, or
`lastSeenAt` update.

Linux todo and financial writes use `updatedAtMs` for optimistic concurrency.
An upsert omits `baseUpdatedAtMs` only for a genuinely new natural key/document;
updates and all deletes send the timestamp read from the row or enclosing
budget/BTC document. Stale writes fail atomically with a structured
`ENTITY_CONFLICT`. Exact delete retries return `removed:false` through the
matching tombstone, while a never-seen key fails with `ENTITY_NOT_FOUND`.

Rachel's financial intent is stored in the canonical shared adult ledger under
Victor. This applies to transactions, budgets, BTC buys, bill pays, and
accounts; no financial row persists `owner:"rachel"`. Mason and Maddox remain
their own closed source owners where those resources support them. The sole
`bitcoin-bill-pays` source is adult-only, so a child bill-pay upsert or delete
fails with `OWNER_SOURCE_MISMATCH`.

`lastSeenAt` moves only after an authorized mutation succeeds. Authentication,
capability, owner, validation, and collision failures leave it unchanged.
Income and retirement remain read-only.

## Delete convergence

Row deletes upsert an indexed natural-key tombstone even when the target was
already absent. The internal migration consults at most 256 tombstones per
entity/source through `rowTombstones.by_type_source`; exceeding that bound fails
closed. Todo deletes also retain `todoTombstones` while shipped clients still
read the legacy blob. An accepted Todo delete stores the complete authoritative
typed row in its revision-bound row tombstone. Undo restores only that server
capsule, never the lossy client projection, then removes the row tombstone so the
same deletion cannot be replayed. The compatibility `todoTombstones` marker stays
until a later reviewed cutover rewrites or removes the stale legacy blob; restore
and later row-native edits cannot clear it and re-expose stale Apple content.

Budget category renames replace the original array position atomically, reject
case-insensitive collisions, require the displayed month to match the stored
document, and use one case-folded tombstone identity for rename, delete, retry,
and migration suppression. BTC account writes update
`btcBalanceDocuments` first, recompute exact totals, then reconcile the
`btcAccounts` row mirror in the same transaction.

BTC fiat valuation is optional. A supplied
`fiatValuation:{cents,priceCents?,quotedAt?,source?,confidence?}` is retained
with its provenance. Omitting it preserves an existing canonical valuation; a
new unvalued account remains unvalued and makes the aggregate fiat total absent.
The backend never fabricates zero.

## Runtime cutover lock

Every successful runtime core insert, update, or delete atomically creates a
single indexed `runtimeSourceLocks` row for its source file. This applies to
trusted sync-token entry points and per-device entry points, including budget
and BTC document/mirror writes. The marker is permanent migration ownership
state, not a mutex.

Once present, `migrate:migrateFile` refuses dry-run and apply and
`migrate:verifyFile` refuses verification with `RUNTIME_SOURCE_LOCKED`, before
reading the legacy source blob or migrated targets. Legacy migration is a
one-shot bootstrap and never becomes a bidirectional synchronizer that could
overwrite runtime edits, creates, or tombstones. Migration projection and
migration writes do not create the lock themselves.

Natural-key reads use fail-closed uniqueness checks. A duplicate pairing ID,
legacy source blob, row natural key, or BTC mirror key is reported instead of
silently choosing or overwriting one physical document.

## Trusted pairing mint

On the trusted operator machine:

```bash
npm run linux-pairing:create -- --profile victor --out /private/path/linux-device-pairing.json
```

The command requires `CONVEX_SYNC_TOKEN`, mints the household-admin set of all
four grants explicitly, and writes the claim secret to a new `0600` file
without printing it. It will send the credential only to the exact approved
household origin `https://keen-elephant-452.convex.cloud`, refuses redirects,
and validates a bounded response before writing anything. Review configuration
without a token or side effect:

```bash
npm run linux-pairing:create -- --dry-run --profile victor --out /private/path/linux-device-pairing.json
```

`--profile` is required and accepts `victor`, `rachel`, `mason`, or `maddox`.
The claimed device credential is bound to that task profile. The main process
allows mutations only while the same profile is active, even when an adult can
read or switch into other profiles. To move write authority to another profile,
unpair the installed device, mint a new pairing for that profile, and claim it.
The app stores one device credential at a time.

The artifact contains one raw `pairingCode`. Paste that code only into the
native-confirmed pairing UI. The native main process supplies the trusted
Convex origin; it must never select an origin from pairing-file contents or
renderer input.

The existing `mobile-pairing:create` command intentionally omits capabilities,
so bundled mobile pairings remain todo-only.
