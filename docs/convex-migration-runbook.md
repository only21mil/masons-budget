# Convex production row-migration and verification runbook

Target deployment: `prod:keen-elephant-452`

## Current production state

The row schema and authenticated `tables:*` API are deployed, and the reviewed
row migration has been applied. The five formerly skipped document sources are
migrated:

| Source blob | Typed destination |
| --- | --- |
| `budget` | `budgetDocuments` |
| `mason-budget` | `budgetDocuments` |
| `btc-balance-snapshot` | `btcBalanceDocuments` plus `btcAccounts` |
| `finances` | `financeDocuments` |
| `son-balances` | `btcBalanceDocuments` plus `btcAccounts` |

The production document counts measured before this documentation update were
2 `budgetDocuments`, 2 `btcBalanceDocuments`, and 1 `financeDocuments`. The
other measured row counts include 911 transactions (905 Victor and 6 Mason),
31 BTC buys, 31 BTC bill pays, 16 income rows, and 25 todos.

This docs-only change did not re-probe production. Treat those numbers as the
last recorded observation, not proof of the current response. Verify them with
the read-only procedure below.

Do **not** start a new migration merely because this runbook exists. A production
write, schema change, migration, or deployment requires Victor's explicit
approval, a reviewed immutable commit, current backups, and confirmation that no
other lane is touching Convex.

## Contracts that verification must prove

### Transaction sign

Purchases are positive for every owner, refunds are negative, and Income
contributes zero to budget spend. For every returned transaction:

```text
category == "Income"  => spendAmount == 0
category != "Income"  => spendAmount == amountCents
hasOppositeSpendSign  == (spendAmount < 0)
displaySpendAmount    == abs(spendAmount)
```

This was measured against production, not inferred from the old blob contract:
Victor's 905 rows contained 888 positive purchases and 16 genuine negative
refunds; Mason's 6 transaction rows were positive.

Verification: capture and inspect a complete authenticated
`tables:listTransactions` response, assert the relationships above over a
nonempty row set, and separately assert the Victor and Mason counts. A test over
an empty array or hand-written fixture does not prove production behavior.

### Convex HTTP wire format

Every client row request must explicitly include:

```json
{
  "path": "tables:rowCounts",
  "args": { "token": "<runtime-injected; never commit or print>" },
  "format": "convex_encoded_json"
}
```

With `format: "convex_encoded_json"`, a `v.int64()` arrives as
`{"$integer":"<base64>"}`. The Base64 payload decodes to exactly eight
little-endian two's-complement bytes. With plain `format: "json"`, the same
integer arrives as a decimal string. The strict clients expect the tagged form;
requesting `"json"` caused a total row-read failure.

Verification has two independent parts:

1. Capture the redacted outgoing request and prove the format parameter is
   exactly `"convex_encoded_json"`.
2. Decode a real response and compare tagged values with independently known
   integer cents/satoshis. The shared decoder tests prove byte order and signed
   bounds; they do not prove the production request selected that format.

Never place the real read token in a command line, committed capture, log, or
document. Use the approved runtime-injected path and redact evidence.

### Canonical financial sources

- **BTC net worth:** use exactly one adult `btcBalanceDocuments` total. The
  authoritative snapshot is 541,782,856 satoshis (5.41782856 BTC) as of
  2026-07-16. `btcAccounts` is a projection of the same snapshot, and
  `balanceDocuments` is an older 487,970,749-satoshi observation. Adding any of
  these sources double-counts the household stack.
- **Income:** use only the dedicated `income` table. The measured source has
  16 rows totaling $34,893.47. Transaction rows with `category == "Income"` are
  mirrors and contribute zero.
- **BTC bill payments:** show the 31-row, $25,634.05 `btcBillPays` ledger as its
  own section. Do not feed it into an existing balance, spend, income, or
  net-worth total; current balances already reflect that spend.

Verification: read the named source, require the recorded row/document
cardinality, sum integer cents or satoshis only, and trace the client aggregator
to prove no overlapping table is included. Never verify a source-selection rule
by checking only the final displayed number.

### Missing required sources

An empty required financial source is **unavailable**, not zero. `$0.00` is
valid only when the authoritative source is present and explicitly reports zero.
This rule does not apply to non-financial collections; zero open todos is a
valid result.

Verification: exercise at least three states independently—missing source,
present explicit zero, and present nonzero—and assert both the status and the
rendered value. A numeric-only assertion cannot distinguish missing from zero.

## Read-only production verification

Use a clean checkout of the exact reviewed commit. Confirm the deployment name
out of band and inspect only secret names/presence, never values.

1. Run the read-auth verifier through the approved token-injection path and
   require `STATE: ENFORCED`. `OPEN`, `TOKEN-UNCONFIGURED`,
   `WRONG-KNOWN-GOOD`, `OUTAGE`, `CLOSED-UNCONFIRMED`, and `UNKNOWN` are stop
   conditions.
2. Capture an authenticated `tables:rowCounts` request and prove it used
   `format: "convex_encoded_json"`.
3. Require the recorded counts above, including all five document sources.
   Record the observed `btcAccounts` count and reconcile it against the nested
   accounts in the two BTC documents; do not invent an expected count.
4. Query each typed source and check owner/scope boundaries. An adult
   `netWorth` BTC-document query must return exactly one adult document; a
   `visible` query may also return Mason's document.
5. Run the transaction-sign, canonical-source, and required-source checks above.
6. Compare migration provenance and canonical round-trip evidence with the
   unchanged `dataFiles` blobs. Also prove `syncVersions` and
   `todoTombstones` were not changed by migration.

A successful HTTP status, `complete: true`, or nonzero count proves only that
one signal. Preserve redacted evidence for every independent check.

## Deployment order for the corrected sign projection

**Convex must be deployed before any client build carrying the corrected sign
projection.**

1. Victor approves the production deployment sequence.
2. Confirm the immutable reviewed backend commit and that no other lane is
   deploying or writing.
3. Confirm `ALLOW_TOKENLESS_READ` and `ALLOW_TOKENLESS_SYNC` are absent, while
   the required tokens are present. Presence is checked without revealing
   values; the hatches outrank the tokens.
4. Run the repository checks from `AGENTS.md` and require nonzero test discovery.
5. Deploy the reviewed Convex bundle.
6. Run the complete read-only verification above. In particular, verify a real
   transaction response satisfies `spendAmount == amountCents` for every
   non-Income row.
7. Only after production passes may a corrected client build begin.

The fixed clients reject a transaction row when the spend projection contradicts
the stored amount. One rejected row discards the whole response, so a client
shipped before the backend recreates the prior 100% read outage.

## Future migrations or repairs

The current production migration is complete. A future source addition or
repair needs a new reviewed plan; do not replay the original apply as a routine
health check.

If a migration is explicitly approved:

1. Take the production-targeted no-write dry run and preserve its redacted JSON.
2. Require a backend-generated `sha256:` frozen-plan fingerprint over the
   complete ordered projection.
3. Have two people review counts, source presence, owners, integer money sums,
   canonical round trip, and the exact fingerprint.
4. Apply only with that exact `--expected-plan-fingerprint`. A mismatch means
   stop and take a new dry run; never replace the reviewed fingerprint during an
   apply attempt.
5. Require `rowCountMatches`, `moneySumsMatch`, `roundTripRowsMatch`,
   `exactRoundTrip`, and `ok` to be true with no problems.
6. Run standalone post-apply verification and a no-write idempotency plan. The
   latter must report zero new and zero changed rows.

Dry-run verification is deferred because it writes nothing; do not report that
as stored-row verification. Apply and post-apply checks are the read-back proof.

## Failure and rollback

- Stop on an auth-state mismatch, wrong deployment, schema warning, fingerprint
  mismatch, malformed wire value, count mismatch, money mismatch, incomplete
  response, or changed blob-world fingerprint.
- Do not delete, patch, or retry production rows ad hoc. Preserve redacted
  evidence and diagnose read-only.
- Do **not** redeploy the old pre-row-schema bundle (`0a5c75d`) as a generic
  rollback. Production now contains populated row tables and clients depend on
  the row API. Any rollback must use an explicitly reviewed, row-compatible
  bundle whose exact commit was recorded before deployment.
- If the corrected projection deploy fails, keep or restore the last verified
  row-compatible Convex bundle. Do not start a client build.
- Never mutate `dataFiles`, `syncVersions`, or `todoTombstones` as part of a row
  rollback.

The safe response to uncertainty is to leave the already-migrated data in place,
keep clients on the last verified configuration, and open a GitHub issue with
redacted evidence.
