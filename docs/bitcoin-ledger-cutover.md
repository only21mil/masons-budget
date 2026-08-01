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
6. Immediately read back the document and every `btcAccounts` mirror. Verify
   exact account quantities, all three totals, equal document/mirror sats,
   `postingActivatedAtMs` present, and a document revision newer than the
   preflight revision.
7. Run one controlled low-value test for each posting type and verify after
   each operation: buy credits River; BTC bill pay debits River;
   sat-denominated Income credits River; owned-wallet transfer debits source by
   principal plus fee and credits destination by principal; deleting that test
   transfer reverses both postings.

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
