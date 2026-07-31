# Market quote snapshot boundary

## Decision

BTC, VOO, and IBIT prices are operational market observations. They are not
retirement ledger records and do not belong in `financeDocuments`.

The current implementation boundary remains client-owned:

- Apple keeps its last successful quotes in device-local `UserDefaults`.
- Linux must fetch through a closed Electron main/preload capability because
  renderer networking is denied.
- Android may fetch through its native repository.
- Every client emits the shared `MarketQuoteSnapshot` contract before finance
  selectors consume a price.

This requires no Convex schema change or deployment. Synced account fields such
as `weeklyContributionCents` and `weeklyContributionDay` remain projections and
schedule labels only. No Vogel Vault client executes a brokerage market order.

## Shared snapshot

A structurally complete snapshot contains exactly one entry for each closed
symbol: `BTC`, `VOO`, and `IBIT`.

```text
MarketQuoteSnapshot
  quotes:
    - symbol: BTC | VOO | IBIT
      priceCents: integer cents | null
      source: non-empty string
      fetchedAt: ISO-8601 string | null
      status: live | stale | unavailable
```

`live` and `stale` require a positive price, source, and fetch time.
`unavailable` requires `priceCents: null`. A recorded Bitcoin buy price, a
hard-coded fallback, and a stored holding value must never be labeled `live`.

The shared selectors accept stale quotes because stale data is still evidenced
data, but preserve the status so the client can label it. An unavailable BTC
quote makes combined USD/BTC net-worth conversions unavailable; it does not
turn them into zero.

## Minimal future Convex boundary

If quote acquisition is centralized later, add one fixed-symbol Convex action
that returns the same snapshot:

```text
marketQuotes:getSnapshot({})
  -> { quotes: MarketQuote[3], complete: true }
```

The action must:

- accept no ticker, hostname, URL, or redirect target from a caller;
- fetch only reviewed HTTPS endpoints for the three fixed symbols;
- cap time and response size and validate positive decimal prices;
- convert prices to `v.int64()` cents before returning them;
- return all three entries, using `unavailable` rather than omitting a symbol;
- retain source and fetch time for every usable observation;
- contain no household read token, sync token, or vendor secret in its result.

`complete` would describe response structure, not quote freshness. A complete
snapshot may contain stale or unavailable entries.

Do not add quote fields to `financeDocuments`, mutate production household
data, or persist a quote history merely to support this boundary. A durable
quote table would be a separate reviewed feature with retention and provenance
requirements, not an extension of this contract.
