# Synthetic Convex wire golden fixtures

These files pin the exact Convex HTTP wire shapes the clients decode. **They are
synthetic**: stable IDs, round-dollar amounts, generic merchant/category names,
2099 dates, and `sample-*` / `synthetic-*` IDs. They carry no production
household data. Before 2026-09-02 this directory held verbatim production
captures; those were removed (audit 2026-09-02, finding 1) and every client
decoder test now asserts the synthetic values.

One file per `tables:*` query per `format` value:

    <query>.json.json                 request sent with "format":"json"
    <query>.convex_encoded_json.json  request sent with "format":"convex_encoded_json"

## What they show

`v.int64()` fields differ by format. Nothing else does.

| field class | `json` | `convex_encoded_json` |
|---|---|---|
| `v.int64()` money, `sats`, `priority`, `schemaVersion` | decimal string `"2500"` | `{"$integer":"xAkAAAAAAAA="}` |
| `v.float64()` (`updatedAtMs`) | plain number — unchanged | plain number — unchanged |
| `rowCounts` values | plain number — unchanged | plain number — unchanged |

The clients request `convex_encoded_json`, decode tagged `v.int64()` values, and
accept `updatedAtMs` as a plain safe integer in both formats.

## Coverage limits — read before trusting these

- `getBudgetDocument` models a populated adult household document, including tagged
  `savingsBps` history values and legacy display-month labels, with synthetic values.
- `listBtcAccounts` is bounded to three rows and reports `complete: false`, so the
  decoders' incomplete-envelope behaviour stays exercised.
- `updatedAtMs` is a non-zero safe integer (1700000000000), so the non-zero
  serialisation path is covered.

No credential appears in any fixture, and no capture from a live deployment is
committed. `scripts/capture-convex-wire-golden.mjs` still exists for local wire
debugging against a real deployment; never commit its output here — the
synthetic-content guard will fail CI if production-shaped values land in these
files.

## Provenance gate

`shared/domain/convex-wire-golden-provenance.json` (version 3, origin
`synthetic`) records the generator, the query/format matrix, SHA-256 of every
fixture body, and the SHA-256 of the committed per-query TypeScript dependency
closure the wire shapes were taken against. After dependencies are installed,
`scripts/check-convex-wire-golden-provenance.mjs` runs the attestation checks
and the Linux value decoder as one gate. It fails when a fixture is added or
changed without refreshed checksums, or when the schema changes without a
regeneration. It deliberately does not apply a freshness ladder: synthetic
fixtures do not go stale.

## Regenerating

    node scripts/generate-convex-wire-golden-fixtures.mjs
    node scripts/check-convex-wire-golden-synthetic.mjs
    node scripts/check-convex-wire-golden-provenance.mjs

The generator rewrites the fourteen fixture files and refreshes the provenance
checksums. The guard fails when any fixture value looks production-shaped
(real platform/employer/person markers, non-round cent or satoshi amounts, or
IDs without the synthetic prefixes).
