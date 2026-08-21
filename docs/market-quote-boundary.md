# Market quote snapshot boundary

## Decision

BTC, VOO, and IBIT prices are operational market observations. They are not
retirement ledger records and do not belong in `financeDocuments`.

`MarketQuoteSnapshot` remains a transport-neutral domain contract. The selected
Linux and Android implementation is one shared Convex-backed snapshot/cache,
not separate device caches synchronized with each other:

- Linux and Android read the same Convex snapshot through an authenticated path
  consistent with the existing runtime-injected client read authentication.
- Only an internal, bounded Convex refresh path acquires upstream quotes.
- Clients cannot supply a ticker, hostname, URL, or redirect target.
- Apple keeps its existing device-local quote cache until a later reviewed
  migration to the same snapshot.

The reviewed Convex implementation stores only the latest operational quote
state, refreshes it through an internal action, and exposes it through the
authenticated fixed-symbol query below. Synced account fields such as
`weeklyContributionCents` and `weeklyContributionDay` remain projections and
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
      fetchedAt: canonical UTC ISO-8601 string | null
      status: live | stale | unavailable
```

`live` and `stale` require a positive price, source, and real canonical UTC
fetch time (`YYYY-MM-DDTHH:mm:ssZ`, optionally with exactly three millisecond
digits).
`unavailable` requires `priceCents: null`. A recorded Bitcoin buy price, a
hard-coded fallback, and a stored holding value must never be labeled `live`.

The shared selectors accept stale quotes because stale data is still evidenced
data, but preserve the status so the client can label it. An unavailable quote
also remains explicit through fallback valuations rather than collapsing into
an absent observation. An unavailable BTC quote makes combined USD/BTC
net-worth conversions unavailable; it does not turn them into zero.

## Selected Convex boundary

The implementation exposes one authenticated, fixed-symbol read returning the
shared snapshot:

```text
marketQuotes:getSnapshot({ token })
  -> { quotes: MarketQuote[3], complete: true }
```

The read must:

- validate the same runtime-injected read credential pattern used by the
  existing client read boundary;
- accept no symbol, ticker, hostname, URL, or redirect target from a caller;
- return all three entries, using `unavailable` rather than omitting a symbol;
- return exact `v.int64()` cents, the successful source, and the successful
  acquisition timestamp for every usable observation;
- derive effective freshness from the canonical success timestamp when read,
  treating an aged stored `live` row as `stale` even if scheduled expiry was
  delayed, and refusing invalid or materially future timestamps;
- contain no household read token, sync token, upstream credential, or other
  secret in its result.

`complete` describes response structure, not quote freshness. A complete
snapshot may contain stale or unavailable entries.

Scheduled expiry keeps stored status useful but is only an optimization. Every
read derives effective freshness again from the canonical success timestamp.

An internal refresh action owns acquisition and cache updates. It must:

- fetch only reviewed HTTPS endpoints for BTC, VOO, and IBIT;
- use fixed redirect policy, bounded timeout and response size, and validate a
  positive decimal price before exact integer-cent conversion;
- update each symbol's price, source, and success timestamp only after that
  symbol succeeds;
- preserve a prior successful observation as `stale` when a later acquisition
  fails;
- return `unavailable` when acquisition fails and no prior successful
  observation exists;
- allow one symbol to fail without discarding successful observations for the
  other two.

Linux and Android consume this server snapshot directly. They do not replicate
or synchronize quote state device-to-device. Any short-lived in-memory client
cache is only a presentation optimization and must preserve the server's
source, success timestamp, and status.

Do not add quote fields to `financeDocuments`, mutate production household
finance data, or treat a cache refresh as a trade. The Convex implementation
contains only the minimal quote-cache storage required for this boundary;
durable quote history needs its own retention and provenance review.
