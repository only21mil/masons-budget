# Transaction owner enforcement

Transaction rows use one canonical ledger owner:

- Victor and Rachel write adult financial rows as `victor`.
- Mason and Maddox write rows under their own profiles.
- The active actor/viewer remains separate from ledger ownership.

## Current compatibility phase

Apple and Android send both `owner` and `sourceFile` for transaction upserts and
deletes. The Convex upsert arguments remain optional for already-shipped clients.
On upsert, Convex treats the source file as authoritative and canonicalizes the
row owner to that file's owner. Deletes remain source-scoped and reject an
explicit owner that does not match the stored row.

## Staged enforcement

After telemetry or a release-age check confirms older clients are retired:

1. Make `transaction.owner` and `sourceFile` required in
   `tables:upsertTransaction`.
2. Make `owner` and `sourceFile` required in `tables:deleteTransaction`.
3. Reject owner/source-file mismatches instead of canonicalizing them.
4. Run the transaction mutation tests, deploy Convex through the approved
   production process, then verify Apple and Android writes.

This change deliberately does not deploy Convex or tighten the public validator.
