# Golden captures of real Convex production responses

Captured 2026-07-27 from `prod:keen-elephant-452` with a valid read token, straight off the
wire. **These are observations, not assertions.** Every other fixture in this repo was
hand-authored from a written assumption about Convex's encoding, and that assumption was wrong
— which is how a 100% client read failure shipped past 475 passing tests.

The transaction capture also preserves output from the pre-fix projection
defect. Production stores purchases as positive amounts for every owner and
refunds as negative; the stale projection wrongly negated positive adult
`amountCents` into `spendAmount` and flagged those purchases as opposite.
Corrected clients deliberately reject that projected shape; the files are not
rewritten because they remain historical wire evidence.

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

The strict decoders in every client accept ONLY the tagged form, while every client requests
`"json"`. That is the outage.

`updatedAtMs` is plain in BOTH formats, so no format change makes it decode as a Long. It is a
separate defect.

## Coverage limits — read before trusting these

- `getBudgetDocument` returns `document: null` in production, so **`savingsBps` is not captured
  here**. It is `v.int64()` in the schema but decoded as a plain number by Android and Linux —
  the inverse mismatch — and can only be proven by code inspection and unit tests, not by these
  files.
- `listBtcAccounts` returns zero rows in production.
- Every captured `updatedAtMs` is `0.0`; the migration did not carry a source timestamp, so
  these files cannot show how a non-zero timestamp serialises.

No credential appears in any capture — the token is a request argument and is never echoed.
Verified before commit.

## Provenance and freshness gate

`shared/domain/convex-wire-golden-provenance.json` records the production deployment, capture
date, query/format matrix, SHA-256 of every response body, and SHA-256 of the committed
`convex/schema.ts` the captures were taken against.
`scripts/check-convex-wire-golden-provenance.mjs` runs before the client decoders in CI. It
fails when a capture is added or changed without an updated attestation, when the schema
changes without a recapture, or when the capture is 60 days old. It emits a GitHub warning
after 30 days.

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
