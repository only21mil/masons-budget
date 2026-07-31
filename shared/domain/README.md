# Shared client contract

This directory is the language-neutral contract for every Vogel Vault client.
Client authors must read this file before adding or replacing a server-response
decoder. The executable vectors live in
[`fixtures/visibility-cases.json`](fixtures/visibility-cases.json).
Finance, quote, exact valuation, net-worth, budget-health, and category
drill-down parity is pinned by
[`fixtures/finance-market-cases.json`](fixtures/finance-market-cases.json).

## Current data boundary

Convex is the system of record. Shipped clients read the Convex row tables over
the HTTP API with a runtime-injected read token. Row decoders preserve the field
aliases still present in stored records. A separate operational market-quote
cache acquires fixed BTC, VOO, and IBIT prices through an internal Convex action;
clients do not synchronize quote caches device-to-device.

## Server responses are open objects

A server response carrying fields that a client does not know about **must
decode successfully**. Adding an object field server-side is a compatible
change. Rejecting an otherwise valid response because an object has an unknown
field is a client defect.

This rule applies at every server-authored object boundary: the Convex response
wrapper, row/document envelopes, row and document objects, and nested ordinary
objects. Validate every known required field and reject malformed known fields,
but select the known fields rather than comparing the object's complete key set
to an allowlist.

The rule does not make closed values open:

- `owner` remains the closed union `victor | rachel | mason | maddox`; refuse an
  unknown owner. The legacy missing-owner default is only for untagged blob
  records.
- Discriminated unions and enums remain closed unless their own contract says
  otherwise.
- With the Convex HTTP API request parameter `format: "convex_encoded_json"`,
  a `v.int64()` uses the byte- and shape-exact `{"$integer":"..."}` wrapper. It
  is a tagged scalar representation, not an extensible response record.
- With `format: "json"`, the same `v.int64()` is a decimal string such as
  `"2500"`; it is not a malformed tagged value. A `v.float64()` remains a plain
  JSON number in both formats.
- Client-authored request objects may stay closed.
- The surviving blob path and its stored bytes remain unchanged.

`fixtures/convex-int64-wire-cases.json` records both HTTP formats under
`formatCases`, and the contract test executes each case according to its
`validForFormat` value. A decimal string is valid for a `v.int64()` only with
`format: "json"`; raw numbers and decimal strings are invalid for that field
with `format: "convex_encoded_json"`. The fixture's `strictParserScope` makes
explicit that its `valid` and `invalid` arrays exercise the strict tagged-scalar
parser for a `v.int64()` under `convex_encoded_json`.

`serverResponseCompatibility` in the shared fixture contains row-count and
transaction-envelope responses with deliberate unknown members at multiple
levels. Every client decoder parity suite must pass those complete response
objects through its production decoder and assert the known decoded values.
Do not sanitize the fixture by deleting its unknown fields before decoding.

## Transaction spend

All money is integer minor units (`bigint`, `Long`, or `Int64`), never floating
point.

For every non-Income transaction:

- `spendAmount` is the **signed budget contribution**. Adult and child rows both
  use the production storage convention: purchases are positive and
  credits/refunds are negative.
- `displaySpendAmount` is the rendering magnitude, always non-negative.
- `hasOppositeSpendSign` is `spendAmount < 0`.

Income contributes zero. A refund retains its negative contribution, positive
display magnitude, and `hasOppositeSpendSign: true`.

`spendContract` in the shared fixture pins an adult spend, child spend, income,
and adult refund. Decoder and domain parity suites must run all four cases.

## Related invariants

`canSee` is wider than `sharesNetWorth`: adults may see child data, but adult net
worth includes adults only. These rules remain pinned by the same fixture.

## Retirement data and market quotes

Convex finance accounts, holdings, contribution amounts, and contribution days
are synchronized household data. Contribution schedules are projections and
labels; they do not instruct a client to place a market order.

BTC, VOO, and IBIT quotes are a separate operational snapshot. Each observation
has integer-cent price evidence, source, fetch time, and an explicit
`live | stale | unavailable` status. The live Convex boundary and its fixed,
bounded upstream acquisition path are documented in
[`../../docs/market-quote-boundary.md`](../../docs/market-quote-boundary.md).

Net worth uses the canonical scoped BTC satoshi balance plus net-worth-scoped
finance accounts. Holdings are valued once; the document-level retirement
projection is never added on top of the same accounts.

Quote fetch times use canonical UTC ISO-8601: `YYYY-MM-DDTHH:mm:ssZ` or the
same form with exactly three millisecond digits. Live and stale observations
must carry a real timestamp in that form; calendar rollovers, offsets, and
other normalized spellings are rejected. Unavailable observations remain in
valuation results so clients can distinguish them from a snapshot that has not
loaded.

The shared display contract persists `btc | sats | usd`, defaults unknown keys
to `btc`, and keeps the Budget surface in USD regardless of that preference.
Clients should import these helpers rather than repeat conversion formulas.

`FinanceParityTest` reads `fixtures/finance-market-cases.json` outside the
Android Gradle root. Integration must retain that exact path in
`sharedDomainParityFixtures` in `android/domain/build.gradle.kts` so fixture
edits invalidate `:domain:test`; the verification task must remain a dependency
of the domain test task.
