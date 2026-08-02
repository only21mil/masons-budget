# Bitcoin ledger cutover

This release must remain unactivated until the production account inventory is
read back and Victor approves the production reconciliation mutation.

`CONVEX_SYNC_TOKEN` is a legacy full-admin write credential and can authorize
Bitcoin posting; it is not a paired-device capability. Keep it confined to the
existing trusted clients and operator tooling. Paired devices need both
`transactions:write` and `bitcoin:write` for sat-denominated Income.

## Reviewed opening quantities

- River: `7,426,251 sats` (`0.07426251 BTC`)
- Self custody total: `541,711,788 sats` (`5.41711788 BTC`)
- Household total: `549,138,039 sats` (`5.49138039 BTC`)

These totals came from Victor's 2026-08-01 screenshots. They do not identify how
to divide the self-custody total if production contains more than one
self-custody account, so never guess that allocation.

## Required sequence

1. Merge only after the terminal adversarial review passes.
2. Ship the Apple optional-fiat decoder before activation. Android already
   treats absent fiat valuation as unavailable, and Linux values Bitcoin from
   its operational market quote rather than stored fiat.
3. Deploy the reviewed backend. Do not create a buy, bill pay, sat-denominated
   Income row, or transfer yet; posting fails closed while
   `postingActivatedAtMs` is absent.
4. Read the production `btcBalanceDocuments` row through the reviewed
   `tables:listBtcBalanceDocuments` query with `viewer: "victor"` and
   `scope: "netWorth"`; its explicit projection includes `sourceFile`,
   `postingActivatedAtMs`, accounts, totals, and `updatedAtMs`. Verify all of the
   following before preparing mutation arguments:
   - source file is exactly `btc-balance-snapshot`;
   - owner is `victor`;
   - exactly one account key/label resolves to River;
   - every account key, label, and custody value is copied into the request;
   - the sum of exchange accounts is `7,426,251 sats`;
   - the sum of self-custody accounts is `541,711,788 sats`;
   - the sum of every account is `549,138,039 sats`;
   - `postingActivatedAtMs` is absent;
   - `expectedUpdatedAtMs` equals the just-read document revision.
   If an account or mirror is missing or metadata is wrong, stop and repair it
   through the reviewed `tables:upsertBtcAccount` pre-activation path using the
   full-admin sync credential. Read the document and mirrors back after every
   repair. Never activate a partial document or construct a mirror directly.
5. Obtain Victor's explicit production-mutation approval. Then invoke the
   internal `btcLedger:reconcileBtcAccounts` mutation once with the complete
   account list. Empty, partial, duplicate, metadata-mismatched, stale-revision,
   and second reconciliation requests fail closed.
   Reconciliation is intentionally limited to the adult household ledger;
   child Bitcoin posting is outside this release.
   `asOf` must begin with a real ISO date: it is the cutoff that decides which
   legacy sat-denominated Income rows are already inside these balances.
6. Immediately read back the document and every `btcAccounts` mirror. Verify
   exact account quantities, all three totals, equal document/mirror sats,
   `postingActivatedAtMs` present, and a document revision newer than the
   preflight revision.
   The mutation returns `baselinedIncomeTxIds` (legacy rows dated on or before
   `asOf`, now marked as already inside the reconciled balances) and
   `skippedIncomeTxIds` (rows left unmarked because their date is after the
   snapshot or is not a real `yyyy-MM-dd`, so their sats cannot be proven to be
   in these balances). Every skipped row must be posted deliberately afterwards
   or corrected; none of them may be assumed to be in the stack.
   The same two lists plus the `asOf` used are written durably onto the document
   as `activationBaseline` in the activation transaction, so a lost response is
   never the only copy. Read them back from the document rather than relying on
   the mutation reply: `tables:listBtcBalanceDocuments` projects
   `activationBaseline` alongside `postingActivatedAtMs`.

   Both reads and writes are token-gated and fail closed. Supply
   `CONVEX_READ_TOKEN` for every query and `CONVEX_SYNC_TOKEN` for every
   full-admin mutation. Do not set `ALLOW_TOKENLESS_READ` or
   `ALLOW_TOKENLESS_SYNC` on production to work around a missing token.

   Argument shape, exactly: `owner` is `"victor"`; `expectedUpdatedAtMs` is a
   plain number; `asOf` is the ISO string; `accounts` is the complete array of
   `{ key, label, custody, sats }`. Every `sats` value crosses the wire as an
   int64, not a JavaScript number — send it as a bigint from a script, or as
   Convex's tagged integer form from a raw client. A float here is rejected, and
   silently rounding a sat quantity is exactly the failure this ledger exists to
   prevent.
7. Run one controlled low-value test for each posting type and verify after
   each operation: buy credits River; BTC bill pay debits River;
   sat-denominated Income credits River; owned-wallet transfer debits source by
   principal plus fee and credits destination by principal; deleting that test
   transfer reverses both postings.
   Transfer arguments: `tables:upsertBtcTransfer` takes
   `{ transfer: { id, owner, date, fromAccountKey, toAccountKey, sats, feeSats,
   note? } }` with `sats` and `feeSats` as int64. Deletion through the
   full-admin path is `tables:deleteBtcTransfer { transferId, owner }` and needs
   no revision; *editing* an existing transfer does require `baseUpdatedAtMs`,
   read from `tables:listBtcTransfers`, because a changed transfer moves money
   on two accounts. Repeating the identical delete is a no-op, not a second
   reversal.

After activation, operator-import manifests containing new adult Bitcoin buys
or bill pays are rejected atomically. Record those rows through the reviewed
row mutation paths instead; do not split or partially replay a refused manifest.

## Stop conditions

Stop without mutating production if River is missing or ambiguous, an unknown
account appears, the self-custody allocation is not explicitly known, any sum
differs from the reviewed totals, the revision changes during preparation, a
posted Bitcoin row already exists, or activation is already present.

The production read and reconciliation are deliberately not part of the pull
request. They are a separate production gate requiring Victor's approval.
