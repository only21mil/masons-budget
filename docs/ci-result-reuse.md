# Premerge qualification and landing evidence

Budget runs its affected checks before merge. `clients.yml`, `swift.yml` and
`workflow-lint.yml` have no `push` trigger. Landing does not start another Linux,
Android or Apple CI run, reinstall dependencies, repeat simulator tests or
produce a design packet.

The lightweight landing verifier reads trusted GitHub source evidence and the
actual landed commit. `deploy.yml` calls that verifier directly through
`release_check_gate.mjs`; a JSON receipt supplied on stdin cannot authorize a
release. It retains `protected-ci-landing.json` with original provider identities
and a separate actual landing identity. Review, canonical promotion authority,
release approval and signing readiness remain separate gates.

## What qualifies

Internal, non-draft PRs targeting the current `main` capture execution inputs in
`ci-reuse-ATTEMPT-JOB` artifacts. Capture refuses a tested merge tree that differs
from the candidate tree or a base that has moved. The normal checks then run
once. Artifacts are uploaded only after the corresponding job succeeds.

Every source workflow has its own tree/policy proof, including Workflow lint and
the cheap Apple detector. Platform proofs retain the existing Node dependency,
Gradle runtime and Xcode bindings. The reviewed Gradle collector resolves actual
lint engines and records ordered classpaths; it preserves the narrowly qualified
Kotlin IDE metadata exclusion. Its invocation disables all graph tasks except
the dependency collector, so collecting inputs does not build the app.

The landing verifier requires:

- Successful, completed source PR workflows from the fixed repository and
  expected workflow paths; each required check is bound to its configured App,
  selected source suite and the owning provider job.
- The latest execution of each source job, its original attempt and matching
  artifact. Failed-jobs reruns retain earlier successful job attempts. A later
  failure, cancellation, pending execution or unexplained skip cannot fall back
  to an older success. Neither a workflow rerun nor an unrelated job refreshes
  the original job's 24-hour expiry.
- GitHub's artifact archive digest, complete source inputs, workflow and verifier
  hashes, unchanged public protection policy and `BUDGET_CI_REUSE_EPOCH`.
- Equal candidate, tested and landed trees. A two-parent landing must have the
  exact tested base and candidate as its ordered parents. A fast-forward keeps
  the candidate SHA and must descend from the tested base.
- Stable source workflows, checks, protection and current main across the
  final readback. The PR readback compares its authority fields (number, state,
  draft, head/base/merge commits and repositories, author, permissions,
  labels); nested repository metadata such as `updated_at` may drift, and both
  complete snapshots remain in the receipt's API evidence.

Checks are selected within the source suites. Later unrelated skipped checks on
the same SHA do not replace the executed source result. A title/body-only Swift
run may be ignored only when the provider's explicit no-op guard succeeded and
its own captured source proof binds the same base, tree, workflow and event.

The existing PR path rules may prove Linux, Android, credential tooling, Apple
project consistency or Apple build inapplicable. Those results remain skips;
they are omitted from the list of reused successes and cannot supply a platform
execution proof. Missing or failed applicable checks refuse qualification.

## Source context and release context

The receipt describes the original successful execution. It does not claim that
a second runner has equivalent mutable simulator state or that current package
registries still serve the same bytes. No second platform execution happens at
landing. Tree, workflow, verifier, source dependency/context artifacts and policy
epoch bind the result being reused. Increment `BUDGET_CI_REUSE_EPOCH` when a
relevant toolchain/dependency policy change requires fresh qualification; that
change invalidates earlier proofs.

Linux build verification remains premerge work. APK assembly, stable debug
signing, screenshot/design packets and their uploads run only under the explicit
manual Clients dispatch conditions. Apple archives, signing and upload stay in
their manual release workflows. Release builds use their fresh release context;
they do not turn a prior source check into a new execution or trigger a blanket
postmerge suite.

## Canonical authority and bootstrap

GitHub is Budget's CI mirror. The hosted verifier checks provider main and source
objects; it does not claim to contact the private canonical relay. The delivery
controller must separately retain fresh authoritative Budget relay main and PR
readback, the reviewed candidate, tested base and actual landing parents,
GitHub mirror equality, and a later complete no-op mirror cycle. An operator-
written SHA receipt is not canonical authority.

The first candidate carrying this policy must receive fresh review and qualify
once on its own PR before promotion. Older green runs, including runs made by
the previous partial step-reuse adapter, lack `qualification_version: 2` and
cannot be relabeled as valid. Preserve required-check enforcement; if repository
rules require a merge queue, its required execution remains required. Do not
bypass rules to force a fast-forward.

After all source workflows complete, run `--verify-candidate` from the clean
candidate checkout to retain `protected-ci-candidate.json` before promotion.
It requires the captured tested base to remain the current main and records no
landed commit.

After the canonical-first promotion and mirror readback, run the landing
verifier from the clean, exact landed checkout with a read-only GitHub token and
the current policy epoch in the environment:

```bash
GITHUB_REPOSITORY=only21mil/masons-budget \
  python3 .github/workflows/scripts/protected_ci_reuse.py \
  --verify-landing "$(git rev-parse HEAD)"
```

This command performs API/Git verification only. No CI workflow dispatch is
needed after merge. A refusal stops promotion/release follow-through; investigate
its reason and qualify the affected reviewed source again if inputs are missing,
expired or changed. Do not manufacture proof for an old run, silently launch a
full main suite, or rewrite a source SHA to match the landing.

## Focused checks

```bash
python3 -B .github/workflows/scripts/tests/test_protected_ci_reuse.py
node --test .github/workflows/scripts/tests/release_check_gate.test.mjs
python3 -B .github/workflows/scripts/tests/test_apple_changed_tree.py
python3 -B .github/workflows/scripts/tests/test_clients_credential_tooling.py
python3 -B .github/workflows/scripts/tests/test_ci_reuse_dependencies.py \
  --gradle /path/to/already-installed/gradle
actionlint .github/workflows/clients.yml .github/workflows/swift.yml \
  .github/workflows/workflow-lint.yml .github/workflows/deploy.yml
```

The Gradle fixture checks are offline and use isolated temporary Gradle homes.
They do not build an app or contact Maven.
