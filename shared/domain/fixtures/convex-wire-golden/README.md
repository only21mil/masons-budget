# Golden captures of real Convex production responses

Captured 2026-07-28 from `prod:keen-elephant-452` with a valid read token, straight off the
wire. **These are observations, not assertions.** Every other fixture in this repo was
hand-authored from a written assumption about Convex's encoding, and that assumption was wrong
— which is how a 100% client read failure shipped past 475 passing tests.

The transaction capture reflects the corrected production projection:
purchases are positive for every owner, refunds are negative, and
`spendAmount` matches `amountCents`. Clients still derive presentation fields
locally from the canonical amount.

One file per `tables:*` query per `format` value:

    <query>.json.json                 request sent with "format":"json"
    <query>.convex_encoded_json.json  request sent with "format":"convex_encoded_json"

## What they show

`v.int64()` fields differ by format. Nothing else does.

| field class | `json` | `convex_encoded_json` |
|---|---|---|
| `v.int64()` money, `sats`, `priority`, `schemaVersion` | decimal string `"2500"` | `{"$integer":"xAkAAAAAAAA="}` |
| `v.float64()` (`updatedAtMs`) | `0.0` | `0.0` — unchanged |
| `rowCounts` values | plain number | plain number — unchanged |

The clients request `convex_encoded_json`, decode tagged `v.int64()` values, and
accept `updatedAtMs` as a plain safe integer in both formats.

## Coverage limits — read before trusting these

- `getBudgetDocument` now contains the migrated adult household document, including tagged
  `savingsBps` history values and the legacy display-month labels used by the authoritative
  blob. Client tests retain the null-document path with synthetic responses.
- `listBtcAccounts` is bounded to three rows in this capture and reports `complete: false`.
- Every captured `updatedAtMs` is `0.0`; the migration did not carry a source timestamp, so
  these files cannot show how a non-zero timestamp serialises.

No credential appears in any capture — the token is a request argument and is never echoed.
Verified before commit.

## Provenance and freshness gate

`shared/domain/convex-wire-golden-provenance.json` records the production deployment, capture
date, query/format matrix, SHA-256 of every response body, and SHA-256 of the committed
per-query TypeScript dependency closure the captures were taken against.
After dependencies are installed, `scripts/check-convex-wire-golden-provenance.mjs` runs the
attestation checks and the Linux production value decoder as one gate. It fails when a capture
is added or changed without an updated attestation, when the schema changes without a recapture,
when the capture is 60 days old, or when the decoder rejects a committed production value. It
emits a GitHub warning after 30 days.

This is deliberately an offline attestation, not a live-production check. It makes an
unattested fixture regeneration and age drift visible, but it cannot prove that the named
deployment still serves this wire shape, that the capture command reached production, or that
someone did not falsely update the attestation and expected values together. Those require
human review and a credentialed recapture.

## Refreshing

Re-capture with the read token from `$HOME/.config/sats/secrets.env`, POSTing
`{"path":"tables:<query>","args":{...,"token":"..."},"format":"<format>"}` to
`https://keen-elephant-452.convex.cloud/api/query`. Never commit the token.

Update `shared/domain/convex-wire-golden-provenance.json` with the new date, current schema
SHA-256 and response-body checksums, then run:

    node scripts/check-convex-wire-golden-provenance.mjs
