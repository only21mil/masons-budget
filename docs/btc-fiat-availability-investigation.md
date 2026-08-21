# BTC fiat availability: production investigation and fix specification

Status: investigation and implementation specification only. This change does
not alter production code, stored finance data, Convex deployment state, or any
client. Implementation is tracked by
[issue #189](https://github.com/only21mil/masons-budget/issues/189).

## Executive finding

The canonical adult BTC balance is authoritative for quantity only. Production
contains 541,782,856 sats with high balance confidence, but it contains no
supported fiat valuation. The `$0.00` is not caused by an int64 conversion or a
field dropped by the public query:

1. The authoritative `dataFiles` document explicitly stores `fiat: 0` for all
   five accounts and for the total.
2. `projectBtcBalanceDocument` converts those explicit zeros to `0n`.
3. The typed `btcBalanceDocuments` and `btcAccounts` rows store those zeros.
4. `publicBtcBalanceDocument` and `projectBtcAccount` publish them unchanged.
5. Android and Linux model fiat as a required integer, so their formatters
   cannot distinguish "known zero" from "not valued."

The raw metadata describes an authoritative reconciliation of the BTC quantity
from a self-custody screenshot. It contains no BTC/USD quote, valuation source,
or valuation time. Its unqualified `confidence: "high"` therefore has evidence
for the sats figure, not the fiat figure.

The recurring defect is broader than the `confidence` string. Android discards
the string and Linux does not consult it when formatting fiat. Both clients
nevertheless promote a successful document read to one document-wide
live/available state, then render every required field as trustworthy. Mixed
quality fields need independent availability and provenance.

## Production evidence

The following read-only queries were made on 2026-07-29 against
`keen-elephant-452.convex.cloud/api/query`, using
`format: "convex_encoded_json"` and a runtime-injected read token. No token or
raw request was printed or saved.

| Query | Relevant production result |
| --- | --- |
| `dataFiles:get`, name `btc-balance-snapshot` | Blob version 36, updated `2026-07-16T01:57:12.156Z`; `asOf` `2026-07-16T01:56:49.739734Z`; total BTC `5.41782856`; total fiat field present and equal to `0`; all five account fiat fields present and equal to `0`; metadata basis is an authoritative reconciliation snapshot and confidence is `high`. |
| `tables:listBtcBalanceDocuments`, Victor, `netWorth` | One complete row; total `541782856` sats, `0` fiat cents, `0` exchange sats, `541782856` self-custody sats; confidence `high`. |
| `tables:listBtcAccounts`, Victor, `netWorth` | Five rows; the cold-storage row has `541782856` sats and `0` fiat cents; the other rows have zero sats and zero fiat cents. |
| `tables:getBtcSnapshotMetadata`, Victor, `netWorth` | The same `asOf`, balance basis, source, and `high` confidence as the blob. No valuation-specific metadata exists. |
| `dataFiles:list` | There are 13 blobs. None is a market-price or valuation document. |
| `dataFiles:get` / `tables:listBalanceDocuments` for `balances` | This older balance source is dated 2026-06-18, has a different BTC total, and has no total USD value or BTC price. It cannot supply the missing valuation. |

The five public account rows and the atomic document agree exactly with the
blob. This rules out a projection that drops a nonzero fiat field.

## Adversarial root-cause checks

### Hypothesis: decimal or int64 conversion silently produced zero

Rejected. The input token is already the exact JSON number `0`.
`projectBtcBalanceDocument` calls `parseMinorUnits(..., 2)` and correctly
produces `0n`. Its existing unit test also proves a nonzero `1.005` token becomes
`101n`, so the conversion does not generically collapse values to zero.

### Hypothesis: the public query dropped a stored valuation

Rejected. The blob, document row, account rows, and public query all contain
zero. `publicBtcBalanceDocument` and `projectBtcAccount` are identity
projections for `fiatCents`.

### Hypothesis: another canonical production source can restore fiat

Rejected. The only other balance document is older, has a different quantity,
and contains neither a total fiat value nor a price. There is no price document
in `dataFiles`.

### Hypothesis: zero can always be reinterpreted as unavailable

Rejected as a general contract. Zero sats really are worth zero dollars, and a
very small positive sat balance can round to zero cents at a real price. The
wire model needs an explicit availability/provenance discriminator. A
`sats > 0 && fiatCents == 0` check is acceptable only as a conservative
compatibility rule for legacy rows that lack that discriminator, not as the new
source of truth.

### Hypothesis: clients directly inherit the `"high"` string

Rejected mechanically, confirmed semantically:

- Android decodes `confidence` in `PublicBtcBalanceDocumentDto` but drops it in
  `BtcBalanceDocumentRow.toDomain`.
- Linux preserves it in `BTCSnapshot`, but no renderer reads it.
- Android's `toBtcBalanceSlice` marks the whole document live. Linux's
  `BitcoinSnapshotNotice` calls fiat available when the document merely exists.

Thus no line assigns `confidence` to fiat, but the document-wide trust state
has the same effect. The raw source and basis mention only BTC reconciliation,
so treating their confidence as valuation confidence is unsupported.

## Decision

Clients must be able to represent **sats known, fiat unavailable**. For the
current production document the correct display is:

- BTC/SATS: render `5.41782856 BTC` / `541,782,856 sats`, with the balance
  snapshot date and its high quantity confidence if confidence is shown.
- USD: render `Price unavailable` or `USD valuation unavailable`. Never render
  `$0.00`, and never mark the USD field live merely because the sats document
  loaded.

Do not retroactively invent a fiat value for the 2026-07-16 snapshot. A real
canonical snapshot valuation would require, at minimum, the integer-cent
BTC/USD quote, quote source, quote timestamp, derivation/rounding rule, and
valuation-specific confidence stored atomically with the balance. None of that
evidence survives.

For future snapshots, valuation may be optional. If ingestion obtains a quote,
store a provenance-carrying value such as:

```text
balanceEvidence:
  asOf, source, basis, confidence

fiatValuation: null | {
  cents,
  priceCents,
  quotedAt,
  source,
  confidence
}
```

The current unqualified `confidence` must be treated as balance/sats confidence
and should become `balanceEvidence.confidence` (or `satsConfidence`) in the
public contract. It must never be reused as
`fiatValuation.confidence`.

Keep any legacy `fiatCents` field only for transition compatibility. New clients
must require `fiatValuation` (or an equivalent explicit `fiatAvailable` flag)
before rendering it. A nullable valuation object is preferable to a sentinel
because its cents can legitimately be zero.

## Price-service decision

A client price service is suitable only for a separately labelled,
display-time estimate. It is not the canonical snapshot valuation:

- The balance is as of 2026-07-16; multiplying it by a later quote combines two
  different times.
- Per-device fetch success, caches, and fallbacks make clients disagree.
- A fallback without quote time and source recreates plausible but unsupported
  precision.
- Writing a client-derived estimate back would make presentation state part of
  the ledger.

The current repository does not in fact contain a Linux live-price service.
Linux and Android use the newest visible BTC buy price, explicitly labelled as
not live. Apple alone has a live fetch chain
(`BTCPriceService.fetchLivePrice`: Vogel Vault, CoinGecko, then Coinbase), plus
a stored quote and a hard-coded `$104,000` fallback. The hard-coded fallback is
especially unsuitable as financial source of truth. Apple may continue to show
a current estimate if it carries the quote source and `fetchedAt`; failure or an
unproven fallback must produce unavailable. Linux/Android may show their dated
recorded-buy estimate, but it must remain distinct from the canonical snapshot
fiat field.

## Required implementation sites

The implementation should be split into a release-safety contract change and a
separately approved stored-row cleanup. The first stage fixes every shipped
reader without requiring a production data mutation.

### Convex public contract: required for the safety fix

- `convex/tables.ts`
  - Add one normalization helper used by both public shapes. For a legacy row
    with no explicit valuation discriminator, zero fiat on positive sats is
    unavailable; positive fiat is a legacy embedded valuation with unknown
    confidence; zero sats may render as zero.
  - `projectBtcAccount`: expose optional valuation instead of an unconditional
    required `fiatCents`.
  - `publicBtcBalanceDocument`: expose valuation availability separately for
    each account and the total; expose the existing confidence as balance
    confidence only.
  - `listBtcAccounts` and `listBtcBalanceDocuments`: retain their current
    visibility and completeness behavior; only their returned value contract
    changes.
  - `getBtcSnapshotMetadata`: name/document confidence as balance confidence,
    not fiat confidence.
  - `upsertBtcAccount`: once stored rows support it, require explicit valuation
    provenance when a fiat value is supplied.
- `convex/tables.test.ts`
  - Pin the exact production-shaped case: `541782856n` sats, `0n` stored fiat,
    balance confidence `high` produces sats available and fiat unavailable.
  - Pin zero sats/zero fiat as a legitimate zero.
  - Pin a tiny positive balance with an explicitly available valuation that
    rounds to zero cents, proving zero is not the discriminator.
  - Pin positive legacy fiat as available but with no invented high
    confidence.

### Stored projection: required before the next approved remigration/write path

- `convex/documentProjection.ts`
  - `BtcBalanceDocumentRow`, `projectBtcBalanceDocument`, and
    `childBtcAccount`: model valuation as optional/provenanced. Do not emit `0n`
    as Mason's or the adult household's valuation merely because no valuation
    exists in the blob.
  - Continue decoding the old blob shape. Preserve real positive embedded fiat,
    but do not synthesize its price, source, or confidence.
- `convex/schema.ts`
  - `btcBalanceAccountValidator`, `btcAccounts`, and
    `btcBalanceDocuments.totals`: add the availability/provenance shape without
    invalidating existing rows during rollout.
- `convex/migrate.ts`
  - `MONEY_PATHS.btcBalanceDocument` / `MONEY_SCALES`: stop treating an absent
    valuation as a required money zero.
  - `projectBtcAccountRows`: carry availability and provenance.
  - BTC account verification in `verifyProjectedSource`: compare availability
    as well as exact sats/cents; sum fiat only where valuation is available.
  - Plan/fingerprint generation must include the new fields so a reviewed
    remigration cannot silently preserve the old ambiguity.
- `convex/documentProjection.test.ts` and `convex/migrate.test.ts`
  - Replace the tests that require missing son-balance fiat to become `0n`.
  - Add old-shape, explicit-valuation, unavailable, and round-to-zero cases.

Any production row correction/remigration remains approval-gated. The client
and public-query safety fix must not wait for it.

### Linux

- `linux/shared/ipc.ts`
  - `VogelVaultBtcAccountRow`, `VogelVaultBtcBalanceAccount`,
    `VogelVaultBtcBalanceTotals`, and `VogelVaultBtcBalanceDocument`: represent
    valuation availability/provenance and balance confidence separately.
- `linux/electron/convexRows.ts`
  - `btcAccount`, `btcBalanceAccount`, and `btcBalanceDocument`: decode the new
    optional value without converting null/missing to `0n`. Continue rejecting
    malformed int64 values.
- `shared/domain/src/readModel.ts`
  - `BTCAccount`, `BTCTotals`, `BTCSnapshot`, and `normalizeBTCSnapshot`: carry a
    nullable/provenanced valuation. Legacy normalization must apply the same
    conservative compatibility rule as Convex.
- `linux/src/renderer/data/convexRows.ts`
  - `btcAccount` and `btcBalanceDocument`: preserve unavailable.
  - `priceFromBalanceDocument`: return unavailable rather than numeric zero;
    never derive a price from unavailable fiat.
  - `loadConvexRowEnvelope`: keep the BTC slice live for known sats while
    keeping its fiat subprojection unavailable.
- `linux/src/renderer/pages/finance/index.tsx`
  - `BitcoinSnapshotNotice`: availability must depend on valuation, not document
    presence. Its unavailable copy must say the balance is known but no USD
    valuation exists.
  - `formatSnapshotBitcoin`: accept unavailable fiat and return
    `PRICE_UNAVAILABLE` for USD.
  - `DashboardPage`, `stackColumns`, `BitcoinOverviewPage`, and `NetWorthPage`:
    remove `?? 0n` fiat defaults; gate every USD KPI, hint, and account cell on
    valuation availability.
  - The direct `formatUsd(totalFiat)` "Value" and "Fiat estimate" KPIs and the
    implied-price/self-custody/exchange paths are all affected.
- `linux/src/renderer/pages/admin/index.tsx`
  - The BTC account `fiat_usd` cell must render unavailable instead of `$0.00`.
- `linux/src/renderer/data/fixtures.ts`
  - Add a production-shaped known-sats/unavailable-fiat fixture; stop deriving
    `btcPriceUsd` from unavailable fiat.
- Tests:
  - `linux/test/convex-row-repository.test.ts`: wire decoding for null/available
    valuation and malformed valuation.
  - `linux/test/convex-row-data.test.ts`: preserve separate sats/fiat status and
    never derive a zero price from missing valuation.
  - `linux/test/bitcoin-display-unit.test.ts`: replace the document-presence
    availability premise introduced by commit `d9ac538`; assert all Dashboard,
    Bitcoin Overview, Net Worth, and account-table USD surfaces contain
    `Price unavailable` and do not contain `$0.00` for the production-shaped
    positive stack.
  - `linux/test/routes.test.ts`: stop requiring a fiat total when valuation is
    unavailable; retain the positive-valuation case.

### Android

- `android/app/src/main/kotlin/com/sats21m/vogelvault/data/PublicRowDtos.kt`
  - `PublicBtcAccountDto`, `BtcBalanceAccountRow`,
    `BtcBalanceTotalsRow`, and `BtcBalanceDocumentRow`: make valuation
    availability explicit.
  - `PublicBtcAccountDto.decode`,
    `PublicBtcBalanceDocumentDto.decode`, and its `decodeAccount`: accept
    unavailable, preserve valid zero, and reject malformed int64 values.
- `android/domain/src/main/kotlin/com/sats21m/vogelvault/domain/ReadModel.kt`
  - `BtcAccount` and `BtcBalance`: make fiat optional/provenanced.
  - Add a fiat-specific unavailable predicate. Do not extend
    `netWorthFiguresUnavailable`, because sats remain valid and must keep
    rendering.
- `android/app/src/main/kotlin/com/sats21m/vogelvault/data/RowReadModelLoader.kt`
  - `BtcBalanceDocumentRow.toDomain`: preserve availability and carry balance
    confidence separately if exposed.
  - `toBtcBalanceSlice`: continue marking the balance slice live when sats are
    valid; do not let that status imply fiat is live.
- `android/app/src/main/kotlin/com/sats21m/vogelvault/ui/Screens.kt`
  - `bitcoin`, `netWorth`, `accountList`, and
    `VaultUiState.formatBalance`: gate USD independently and render
    `Money.PRICE_UNAVAILABLE` for the production-shaped document.
  - `balanceSnapshotBasis` must not imply the balance snapshot date is a fiat
    quote date.
- If standalone BTC account rows become nullable, update the Room boundary:
  `CacheEntities.kt` (`CachedBtcAccountEntity`), `CachedRowDataSource.kt`
  mappings, `VaultDatabase.kt` version/migration, exported schema JSON, and
  `VaultCacheDaoTest.kt`. A cached zero must not resurrect the bug offline.
- `android/domain/.../Fixtures.kt`: add an unavailable valuation fixture rather
  than summing placeholder zeros.
- Tests:
  - `RowQueryRepositoryTest.kt`: encoded null/available valuation and malformed
    value cases.
  - `RowReadModelLoaderTest.kt`: the exact `541_782_856`/unavailable case keeps
    `Freshness.LIVE` for sats and unavailable for fiat.
  - `FinancialScreenValuesTest.kt`: every USD surface renders unavailable while
    BTC/SATS remain exact.

### Apple compatibility

Apple views currently value sats with `BTCPriceService` and do not consume
`CanonicalBTCBalance.totalFiatCents`, so they do not display this particular
`$0.00`. They still decode the same public contract and must not break when
valuation becomes optional:

- `MasonsBudget/MasonsBudget/Models/ConvexRows.swift`
  - `ConvexBTCAccountRow`, `ConvexBTCBalanceDocumentRow.Account`,
    `.Totals`, `ConvexBTCSnapshotMetadataRow`, `CanonicalBTCBalance.Account`,
    and `CanonicalBTCBalance`: carry optional valuation and split balance
    confidence from valuation confidence.
  - `CanonicalFinancialProjection.btcBalance`: preserve known sats even when
    fiat is unavailable.
- `MasonsBudget/MasonsBudgetTests/ConvexRowsTests.swift`
  - Add encoded/decode and projection coverage for known sats/unavailable fiat.
  - Keep the existing empty/ambiguous document checks; they test document
    availability, not field availability.
- `BTCPriceService` should not populate the canonical row model. If an Apple
  screen shows a current estimate, it must use a real stored/fetched quote with
  source and timestamp. `fallbackPriceUSD` must not be presented as canonical
  or as a live quote.

### Production-wire regression coverage

- `scripts/convex-wire-golden.mjs`: add `tables:listBtcBalanceDocuments` to the
  capture set so the canonical document contract is exercised in both wire
  formats.
- Add the corresponding fixtures under
  `shared/domain/fixtures/convex-wire-golden/`.
- Extend `linux/test/convex-wire-golden-values.test.ts`, Android
  `ConvexWireGoldenTest.kt`, and Apple wire-fixture decoding to assert that the
  production-shaped positive sats row has unavailable fiat.

Golden capture alone is insufficient: a golden can faithfully pin a bad value.
The semantic assertion must explicitly say that positive sats with no
valuation evidence never render as a confident zero.

## Acceptance criteria

1. The exact production-shaped input (`541782856` sats, stored `0` fiat,
   balance confidence `high`, no valuation metadata) returns sats as available
   and fiat as unavailable through Convex, Linux, Android, and Apple decoding.
2. No Dashboard, Bitcoin, Net Worth, account list, admin table, offline cache,
   or alternate display-unit path renders `$0.00` for that input.
3. BTC and SATS remain visible; the whole balance slice is not downgraded to
   error/empty merely because fiat is unavailable.
4. Zero sats may render `$0.00`.
5. An explicitly sourced valuation that rounds a tiny positive balance to zero
   cents may render `$0.00`, proving availability is not inferred from the
   number alone.
6. Balance confidence never populates valuation confidence.
7. A current client-side estimate, if shown, includes both the balance `asOf`
   and quote source/time and is never stored as the canonical snapshot.
8. Existing blob shapes continue to decode.
9. Tests cover both `json` and `convex_encoded_json` response formats.
