# Dependency security audit — 2026-07-27

Audited commit: `3054fb9bfa9256dedddeffa355947baa604f1fd9`

This audit covered the root npm project, both npm workspaces, and the Android
Gradle dependency graph. It did not build a distributable, deploy, read
production, or touch a device.

## Resolution update — 2026-07-30

The Linux foundation upgrade moved the shipped runtime to Electron `43.2.0`,
the package verifier to `@electron/asar` `4.2.1`, Electron Builder to the
patched v26 release `26.15.7`, and the lint stack to ESLint `10.8.0`.
Narrow root overrides keep Electron Builder's Linux package path on the audited
ASAR/universal/EJS releases. They require Node 22.12 or newer; CI uses Node 24.

A full `npm audit` reports 10 cascading high-severity package nodes from the
`brace-expansion` finding through Electron Builder's Windows-only Squirrel
toolchain. `temp@0.9.4` requires the callback API from rimraf 2; forcing it to
rimraf 6 made tracked cleanup throw a `TypeError`, so the incompatible override
was removed and an executable cleanup test now protects that contract. This
repository packages only Linux `.deb` and AppImage targets, and neither calls
`electron-winstaller`, `temp`, rimraf, or the affected glob expansion path.
`npm audit --omit=dev` remains clean, but that view alone is not treated as
proof of shipped-runtime safety.

Typecheck, lint, tests, the preload-boundary guard, and the canonical Linux
build pass. The distributable package and packaged-app smoke remain part of the
approval-gated package verification; the dependency upgrade does not waive
that gate.

## Measured results

| Scope | Command/result |
|---|---|
| Root npm graph | `npm audit --json`: exit 1, 20 high-severity package nodes |
| Linux workspace | `npm audit --workspace @vogel-vault/linux --json`: exit 1, the same 20 nodes |
| Shared domain workspace | `npm audit --workspace @vogel-vault/domain --json`: exit 0, zero findings |
| Root and Linux production-only npm view | `npm audit --omit=dev`: exit 0, zero findings |
| Android full report | `:domain:dependencies :app:dependencies`: exit 0, `BUILD SUCCESSFUL`, 9,006 lines |
| Android shipped runtime | 102 unique resolved Maven coordinates across `debugRuntimeClasspath` and `releaseRuntimeClasspath`; an OSV batch query returned zero matches |
| Android unit-test runtime | OSV matched `org.bouncycastle:bcprov-jdk18on:1.78.1`, pulled only through Robolectric |

The npm production-only result must not be used as a release safety claim.
Electron is a `devDependency` because it is build tooling from npm's point of
view, but its binary is the Linux application runtime that gets shipped.

`npm audit fix --package-lock-only` made no manifest or lockfile change and
still exited 1. `npm outdated` showed that every dependency's current version
already equals the newest version allowed by its declared range. The remaining
fixes require major-version changes or have no non-breaking fix, so this lane
did not force them.

## Residual findings and reachability

### Electron 33.4.11 — shipped runtime

The registry groups 18 Electron advisories under one high-severity finding:

- [GHSA-3c8v-cfp5-9885](https://github.com/advisories/GHSA-3c8v-cfp5-9885)
  is reachable in the narrow sense that the Linux app uses
  `requestSingleInstanceLock` and handles `second-instance`. Exploitation still
  requires a local attacker, but this is a real shipped code path.
- [GHSA-vmqv-hx8q-j7mg](https://github.com/advisories/GHSA-vmqv-hx8q-j7mg)
  applies if an attacker can modify installed application resources. The Linux
  packages enable ASAR packaging but do not configure Electron's ASAR-integrity
  feature.
- The macOS/Windows-only API findings are not reachable from the Linux package:
  [GHSA-5rqw-r77c-jp79](https://github.com/advisories/GHSA-5rqw-r77c-jp79),
  [GHSA-mwmh-mq4g-g6gr](https://github.com/advisories/GHSA-mwmh-mq4g-g6gr),
  [GHSA-jjp3-mq3x-295m](https://github.com/advisories/GHSA-jjp3-mq3x-295m),
  and [GHSA-jfqx-fxh3-c62j](https://github.com/advisories/GHSA-jfqx-fxh3-c62j).
- The app does not use offscreen rendering, downloads, PowerMonitor, USB,
  clipboard reads, custom protocols, service workers, or child windows. It
  disables worker Node integration, denies all permission requests, blocks
  renderer navigation/network access, and denies every `window.open`. Those
  controls make the affected paths in
  [GHSA-532v-xpq5-8h95](https://github.com/advisories/GHSA-532v-xpq5-8h95),
  [GHSA-8x5q-pvf5-64mp](https://github.com/advisories/GHSA-8x5q-pvf5-64mp),
  [GHSA-9w97-2464-8783](https://github.com/advisories/GHSA-9w97-2464-8783),
  [GHSA-8337-3p73-46f4](https://github.com/advisories/GHSA-8337-3p73-46f4),
  [GHSA-9899-m83m-qhpj](https://github.com/advisories/GHSA-9899-m83m-qhpj),
  [GHSA-f37v-82c4-4x64](https://github.com/advisories/GHSA-f37v-82c4-4x64),
  [GHSA-f3pv-wv63-48x8](https://github.com/advisories/GHSA-f3pv-wv63-48x8),
  [GHSA-4p4r-m79c-wq3v](https://github.com/advisories/GHSA-4p4r-m79c-wq3v),
  [GHSA-xj5x-m3f3-5x3h](https://github.com/advisories/GHSA-xj5x-m3f3-5x3h),
  [GHSA-xwr5-m59h-vwqr](https://github.com/advisories/GHSA-xwr5-m59h-vwqr),
  [GHSA-r5p7-gp4j-qhrx](https://github.com/advisories/GHSA-r5p7-gp4j-qhrx),
  and [GHSA-9wfr-w7mm-pc7f](https://github.com/advisories/GHSA-9wfr-w7mm-pc7f)
  absent or explicitly mitigated in the current source.

`npm audit` proposes Electron 43.2.0. Moving from 33 to 43 crosses ten Electron
majors and changes Chromium, Node, V8, native ABI, and Electron APIs. It needs a
dedicated compatibility pass plus the Linux package, package-verification,
sandboxed-window, and packaged-app smoke checks.

### brace-expansion — build and lint tooling

[GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg)
is present through vulnerable `minimatch` versions under direct
`@electron/asar` 3.4.1, Electron Builder 26.15.3, and ESLint 9.39.5. These paths
run only during packaging, package verification/smoke extraction, or linting.
Their glob inputs are repository-controlled; family financial data does not
become a glob pattern. The denial-of-service path is therefore not reachable
from the shipped application runtime.

The registry offers no non-breaking resolution. It proposes
`@electron/asar` 4.2.1 and ESLint 10.8.0, both majors; the current Electron
Builder 26 line has no clean audit result. ASAR 4 also changes the
`listPackage` contract used by the package verifier, so that upgrade needs code
and artifact verification rather than a lockfile override.

### Bouncy Castle 1.78.1 — Android unit tests only

Robolectric 4.14.1 brings `org.bouncycastle:bcprov-jdk18on:1.78.1` into
`debugUnitTestRuntimeClasspath`. It is absent from both Android shipped runtime
graphs and the app never calls Bouncy Castle:

- [GHSA-574f-3g2m-x479](https://github.com/advisories/GHSA-574f-3g2m-x479):
  GOST CTR keystream reuse, fixed for this artifact in 1.80.2 (and 1.81.1).
- [GHSA-c3fc-8qff-9hwx](https://github.com/advisories/GHSA-c3fc-8qff-9hwx):
  LDAP injection, fixed in 1.84.

Neither affected API is used by the test suite. Removing both findings requires
upgrading Robolectric or constraining its transitive Bouncy Castle dependency
to 1.84+, followed by the Android unit-test and lint suite. That Gradle manifest
change is outside this dependency-lockfile lane.
