# Shared client contract

This directory is the language-neutral contract for every Vogel Vault client.
Client authors must read this file before adding or replacing a server-response
decoder. The executable vectors live in
[`fixtures/visibility-cases.json`](fixtures/visibility-cases.json).

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
- The Convex `{"$integer":"..."}` wrapper remains byte- and shape-exact. It is a
  tagged scalar representation, not an extensible response record.
- Client-authored request objects may stay closed.
- The surviving blob path and its stored bytes remain unchanged.

`serverResponseCompatibility` in the shared fixture contains row-count and
transaction-envelope responses with deliberate unknown members at multiple
levels. Every client decoder parity suite must pass those complete response
objects through its production decoder and assert the known decoded values.
Do not sanitize the fixture by deleting its unknown fields before decoding.

## Transaction spend

All money is integer minor units (`bigint`, `Long`, or `Int64`), never floating
point.

For every non-Income transaction:

- `spendAmount` is the **signed budget contribution**. Adult rows use
  `-amountCents`; child rows use `amountCents`. Positive means spent and negative
  means a credit/refund that reduces spend.
- `displaySpendAmount` is the rendering magnitude, always non-negative.
- `hasOppositeSpendSign` is `spendAmount < 0`.

Income contributes zero. A valid refund and a corrupt wrong-sign legacy row are
indistinguishable on read because the legacy row has no persisted write-side
kind. Both must retain the negative contribution, positive display magnitude,
and `hasOppositeSpendSign: true`.

`spendContract` in the shared fixture pins an adult spend, child spend, income,
adult refund, and corrupt wrong-sign row. Decoder and domain parity suites must
run all five cases.

## Related invariants

`canSee` is wider than `sharesNetWorth`: adults may see child data, but adult net
worth includes adults only. These rules remain pinned by the same fixture.
