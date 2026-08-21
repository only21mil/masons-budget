# Production monthly import operator

**Status: implementation runbook.** A merged revision, accepted independent
review, exact deployment readback, and every production apply remain separate
gates.

## Boundary

The monthly importer is a trusted, admin-only operator for canonical Convex
typed rows. It is not a client feature and must never place an administrative
deploy credential in an app, package, repository, log, shell history, or
generated artifact. The operator loads credentials at runtime from the
sanctioned host secrets store; only the public deployment-binding environment
variable may identify the target.

Input is a schema-versioned private manifest inherited through an already-open
file descriptor. Raw records never travel in argv, environment variables,
stdin, repository files, or path-based command options. The operator emits
structural, redacted evidence only: schema version, operation counts, boolean
checks, write disposition, and terminal status. Plan/state fingerprints remain
inside the private plan file. Neither stream may emit source rows,
descriptions, notes, amounts, credentials, or credential derivatives.

## Canonical operation

One manifest may contain at most 100 ledger rows plus one optional month
advance. The backend validates the complete manifest before writing and commits
all accepted transaction, income, Bitcoin, and month-advance changes in one
atomic Convex mutation.

- Transactions use deterministic stable IDs derived by the reviewed
  normalizer. Reapplying the same normalized record is an identical no-op; an
  existing stable ID with different canonical content is a conflict, never an
  overwrite.
- Income is created as a canonical typed row, or accepted as an identical
  no-op. It is not represented by a
  guessed transaction or a legacy budget/blob edit.
- Bill payments remain bill-payment records and are excluded from derived
  budget spending. Purchases and refunds retain the repository's signed-money
  contract; ordinary Income contributes zero to spending.
- Month advance updates the canonical budget month in place and carries the
  category definitions and budget configuration. It does not clone ledger
  activity, income, derived spend, or other monthly history. Missing
  intervening months stay missing; the operator never fabricates them.
- Runtime source locks and row tombstones remain authoritative. An import may
  not clear, bypass, or weaken them, and a deleted row may not be resurrected.

This path never invokes the one-shot blob-to-row migration, writes legacy
`dataFiles`, replays a compatibility blob, or uses a table-replacement import.
The retained migration runbook is provenance, not a monthly synchronization
tool.

## Dry run, apply, and readback

1. **Dry run:** validate target, manifest schema, privacy boundary, stable-ID
   uniqueness, owner/source rules, signs, calendar values, runtime locks,
   tombstones, month transition, and the 100-change ceiling. Return the exact
   redacted plan fingerprint and perform no writes.
2. **Apply:** require explicit production confirmation and the exact reviewed
   dry-run fingerprint. Revalidate inside the mutation, then commit the single
   atomic batch. A validation or mutation failure commits nothing.
3. **Readback:** query the canonical rows by their stable IDs and read the
   canonical income and budget-month state. Recompute the redacted structural
   fingerprint independently. Counts alone are not acceptance evidence.
4. **Replay check:** a dry run of the same manifest must bind the recorded
   receipt and verify every row again without writing. This proves idempotency
   without performing another production apply.

No production apply proceeds until implementation checks, independent review,
deployment approval, credential posture, target binding, dry-run evidence, and
a bounded rollback packet are all accepted.

## Rollback and unknown outcomes

Before apply, retain a private, bounded pre-apply snapshot sufficient to design
a compensating change for every inserted row and the prior budget-month state.
The importer intentionally exposes no automatic rollback. A confirmed bad
apply requires a new approval-gated, independently reviewed, revision-fenced
compensating mutation; it may remove only rows proven to have been created by
that batch and may restore the prior month/configuration only while the current
revision still matches. It must not use blobs or migration replay.

A timeout, disconnect, empty response, malformed response, or lost completion
marker after dispatch is **UNKNOWN**, not failure and not permission to retry.
Resolve it by readback against the stable IDs and batch fingerprint:

- all expected state present and matching: treat the apply as successful;
- none present and prior state matching: the atomic apply did not land, so the
  same reviewed manifest may be re-authorized;
- mixed, conflicting, or unreadable state: stop. Preserve evidence and require
  investigation and a new reviewed recovery plan.

Never “roll forward” an unknown outcome by rerunning the legacy migration or
blindly submitting another production batch.
