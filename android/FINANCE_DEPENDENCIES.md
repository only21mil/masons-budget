# Android finance read dependencies

The Android client owns its finance decoder, repository, state, and UI. It expects two authenticated Convex reads supplied by the shared/backend integration:

- `tables:getFinanceDocument({ viewer, scope: "netWorth" })` returns `{ document, complete }` using the exact integer/decimal fields decoded by `FinanceReadDecoder`.
- `marketQuotes:getSnapshot({})` returns a complete, exactly-once BTC/VOO/IBIT quote set with `live`, `stale`, or `unavailable` status.

Until both functions exist in the deployed backend, Android reports the corresponding surface as unavailable. It does not substitute fixture prices, the newest BTC buy price, document-level retirement totals, or cached values from another client.

The Kotlin finance selectors were reproduced from the Android portion of shared finance PR #248. The shared JSON parity fixture remains owned by that PR and is deliberately not copied into this client branch; Android-local tests cover the integrated selector and presentation boundary here.

Display-unit conversion for retirement holdings and adult net worth uses only the operational BTC quote from the paired quote snapshot. Canonical account fiat remains canonical, and budget values remain USD-only.
