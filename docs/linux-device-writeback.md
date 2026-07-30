# Linux device writeback

The Linux client uses a per-device credential. It never receives or sends
`CONVEX_SYNC_TOKEN`; that household operator credential is accepted only by the
trusted pairing-mint path.

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
- `tables:{upsert,delete}TodoFromDevice`
- `tables:{upsert,delete}BudgetCategoryFromDevice`
- `tables:{upsert,delete}BtcBuyFromDevice`
- `tables:{upsert,delete}BtcBillPayFromDevice`
- `tables:{upsert,delete}BtcAccountFromDevice`

Every call requires `deviceId`, `deviceToken`, a closed owner/source pair, and a
validated payload. Upserts return exactly
`{ok:true,entityId,outcome:"inserted"|"updated"}`; deletes return exactly
`{ok:true,entityId,removed}`. `dataFiles:revokeMobileDevice` lets a device revoke
itself and is idempotent.

Linux todo and financial writes use `updatedAtMs` for optimistic concurrency.
An upsert omits `baseUpdatedAtMs` only for a genuinely new natural key/document;
updates and all deletes send the timestamp read from the row or enclosing
budget/BTC document. Stale writes fail atomically with a structured
`ENTITY_CONFLICT`. Exact delete retries return `removed:false` through the
matching tombstone, while a never-seen key fails with `ENTITY_NOT_FOUND`.

Rachel's financial intent is stored in the canonical shared adult ledger under
Victor. This applies to transactions, budgets, BTC buys, bill pays, and
accounts; no financial row persists `owner:"rachel"`. Mason and Maddox remain
their own closed source owners where those resources support them.

`lastSeenAt` moves only after an authorized mutation succeeds. Authentication,
capability, owner, validation, and collision failures leave it unchanged.
Income and retirement remain read-only.

## Delete convergence

Row deletes upsert an indexed natural-key tombstone even when the target was
already absent. The internal migration consults at most 256 tombstones per
entity/source through `rowTombstones.by_type_source`; exceeding that bound fails
closed. Todo deletes also retain `todoTombstones` while shipped clients still
read the legacy blob.

Budget category renames replace the original array position atomically, reject
case-insensitive collisions, require the displayed month to match the stored
document, and tombstone the old name. BTC account writes update
`btcBalanceDocuments` first, recompute exact totals, then reconcile the
`btcAccounts` row mirror in the same transaction.

BTC fiat valuation is optional. A supplied
`fiatValuation:{cents,priceCents?,quotedAt?,source?,confidence?}` is retained
with its provenance. Omitting it preserves an existing canonical valuation; a
new unvalued account remains unvalued and makes the aggregate fiat total absent.
The backend never fabricates zero.

## Trusted pairing mint

On the trusted operator machine:

```bash
npm run linux-pairing:create -- --out /private/path/linux-device-pairing.json
```

The command requires `CONVEX_SYNC_TOKEN`, mints the household-admin set of all
four grants explicitly, and writes the claim secret to a new `0600` file
without printing it. It will send the credential only to the exact approved
household origin `https://keen-elephant-452.convex.cloud`, refuses redirects,
and validates a bounded response before writing anything. Review configuration
without a token or side effect:

```bash
npm run linux-pairing:create -- --dry-run --out /private/path/linux-device-pairing.json
```

The artifact contains one raw `pairingCode`. Paste that code only into the
native-confirmed pairing UI. The native main process supplies the trusted
Convex origin; it must never select an origin from pairing-file contents or
renderer input.

The existing `mobile-pairing:create` command intentionally omits capabilities,
so bundled mobile pairings remain todo-only.
