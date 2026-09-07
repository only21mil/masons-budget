# Reusing ordinary CI results

Budget keeps exact-main checks and fresh artifact provenance while avoiding
repeated ordinary commands whose source and execution inputs are proven equal.
The repository-owned adapter is
`.github/workflows/scripts/protected_ci_reuse.py`, derived from Buzz's reviewed
proof contract. It does not approve a merge, sign an app, publish an artifact or
change an existing receipt's identity.

## Proof boundary

An internal PR job captures the exact candidate, tested commit, base, tree,
workflow bytes, named command scope, installed dependency context and public
protection inventory. The workflow uploads that proof only after successful
work. A later main job downloads the exact source run/job-attempt artifact and
verifies GitHub's archive digest, the successful job and its app-bound check.
It independently reads candidate and tested commit objects and their trees.

A failed-jobs rerun may retain successful jobs from an earlier attempt. Reuse
binds each job to its latest successful execution and original proof artifact,
while requiring the latest workflow result and current protected checks to
pass. A newer failed, skipped, cancelled or pending execution of that job cannot
fall back to an older success. The selected job must have completed within 24
hours; another job's rerun cannot refresh that age. Provenance distinguishes
the original job attempt from the latest successful workflow attempt.

Budget's normal fast-forward landing is eligible when main is the exact source
head, the push's previous commit is the captured tested base and provider
ancestry confirms that base. An ordered two-parent merge is also eligible when
its parents are exactly the captured base and source. Tested, candidate and
landed trees must agree. New reviewed workflow code can qualify in its own PR
run; it does not need to exist in the first parent.

The adapter selects original PR workflow suites explicitly. A pending main job
on a fast-forwarded SHA cannot be mistaken for that source run. Latest required
checks from the captured Apps must succeed. An unrelated skipped Linux, Android
or Apple context is accepted only when replaying the unchanged internal-PR path
rules against the exact source/base Git diff proves it inapplicable. A skipped
job can never supply reusable source evidence for itself. Missing, failed,
pending, cancelled, wrong-App or unexplained skipped checks refuse reuse.

Budget currently uses legacy branch protection with nine app-bound checks.
`GET /branches/main` exposes that check inventory to read-only CI tokens;
`GET /rules/branches/main` currently returns no rulesets. The adapter supports
both and binds public active ruleset metadata when present. Hidden legacy
strict/bypass/review settings remain part of the unchanged operator delivery
gate. The adapter independently requires exact tested-base and tree equality,
even when branch protection is non-strict. No administrator secret is added to
PR jobs.

Source evidence expires after 24 hours. A new source attempt, changed public
protection, workflow, relevant dependency or environment, moved main, missing
artifact or unsupported context runs the normal affected commands. A reused
proof cannot become a new source proof. Legacy green runs without these
dependency proofs therefore execute fresh on landing.

## Affected consumers

| Consumer | Eligible repeated commands | Work that remains fresh |
| --- | --- | --- |
| Clients, Shared domain contract | Typecheck and Swift contract parity tests | Checkout, dependency setup and exact-main proof |
| Clients, Production wire golden decoders | Synthetic/provenance checks and Linux decoder tests | Java/Gradle setup and Android wire decoder, whose online runtime resolution is outside the Node proof |
| Clients, Convex functions | Function/test typechecks and local auth/LWW tests | Dependency setup and committed-generated-type existence check |
| Clients, Linux client | Renderer/electron typechecks, lint, preload guard and render-matrix tests | Build, build output upload, Chromium installation, screenshots and design-packet upload |
| Clients, Android client | Domain tests, Android lint and ordinary app unit tests | Credential-injection guards, stable-keystore validation, APK assembly/upload, SDK declaration guard and design-packet production/verification/upload |
| Swift, Build and test the Apple client | Unsigned macOS compile | Xcode 26.6 assertion, MBP/fork routing, simulator preparation, iOS tests and failure xcresult upload |
| Swift, Verify committed Xcode project | None | Cheap prerequisite stays fresh before allocating the Mac |
| Clients/Swift changed-tree detectors | None | Commit/event applicability is evaluated for the new run |
| Clients, Credential mint tooling | None | Small security-sensitive tests stay fresh |
| Workflow lint | None | Cheap workflow, secret inventory, carrier and reuse-contract tests stay fresh |
| `changed-base` action | None | Existing PR/main/merge-group comparison authority and fallback remain unchanged |
| `release_check_gate.mjs` | None | Existing exact-main check selection and release applicability remain unchanged |
| `buzz-ios-release.yml`, `buzz-macos-release.yml` | None | Dispatch-only carrier source, signing and release gates remain unchanged |
| `deploy.yml`, `linux-package.yml`, `android-read-bootstrap.yml`, `release-preflight.yml`, `app-store-connect-preflight.yml`, `apple-certificates.yml`, `apple-signing-assets.yml` | None | Dispatch-only consumers have no automatic PR/main duplicate suite to adapt |

All 12 workflow triggers were inventoried. Merge-group and manual dispatch jobs
execute fresh; this change claims reuse only from qualified internal PR work to
its exact landing. Offline hosts are outside this workflow rollout.

Node proofs include installed dependency bytes, workspace links, tool versions
and the hosted image/OS package inventory. Android additionally resolves and
hashes external Gradle artifacts, plugin inputs, SDK package identities and the
checksum-verified offline Robolectric runtimes before deciding. Resolution
failure produces no dependency proof and leaves the ordinary checks enabled.
The Gradle collector never invokes an app build or test task.

For Kotlin JVM/Android projects, the collector excludes only generated
`*DependenciesMetadata` configurations with the `kotlin-metadata` usage,
`common` platform and `library` category. These IDE source-set buckets can
lack the Compose BOM inherited by the actual Android classpaths. The proof
records the excluded names and attributes; all other resolvable configurations
still require exact artifact bytes, including compiler, KSP, lint and test
inputs. Multiplatform projects receive no metadata exclusion. A missing BOM
or artifact on an actual compile/runtime classpath still refuses reuse.

The Mac compile proof binds the approved Xcode installation's signature,
compiler bytes, Xcode/Swift/SDK builds and OS version. A project with external
Swift packages is currently unproven and executes fresh. Persistent simulator
state is not used as equivalence evidence, so iOS tests always run.

Each main job summary names precisely which commands reused the original
run/attempt. Its `ci-reuse-ATTEMPT-JOB` artifact retains source and provider
evidence, accepted source applicability and current landing identity. Existing
build and design artifacts retain their original names and current-run
production; the adapter never republishes an old artifact as newly built.

## Focused verification

```bash
python3 -B .github/workflows/scripts/tests/test_protected_ci_reuse.py
python3 -B .github/workflows/scripts/tests/test_apple_changed_tree.py
python3 -B .github/workflows/scripts/tests/test_clients_credential_tooling.py
python3 -B .github/workflows/scripts/tests/test_ci_reuse_dependencies.py \
  --gradle /path/to/already-installed/gradle
actionlint .github/workflows/clients.yml .github/workflows/swift.yml \
  .github/workflows/workflow-lint.yml
```

The Gradle test uses only local fixture artifacts with `--offline` and an
isolated temporary Gradle home. It neither builds the app nor contacts Maven.
Review, source qualification, canonical-first PR/landing, current-main checks,
mirror readback and any separate release approval remain required.
