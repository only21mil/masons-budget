# Mobile screenshot handoff, 2026-09-13

This is the current evidence set for the D1 screenshot follow-up in
[issue #352](https://github.com/only21mil/masons-budget/issues/352). It contains
94 approved synthetic PNGs copied without alteration. The
[image index](index.md) links every frame. The [manifest](manifest.json) records
SHA-256, byte size, pixel size, source revision, overlay, artifact identity and
reuse rationale for each image through its provenance group.

The scoped visual lane passed under receipt
`vv_resume/visual_acceptance brief11f-w -> passed`. Its accepted native editor
matrix covers 12 Apple cells and 18 Android cells. This handoff includes the
Apple matrix and a curated native Android example alongside the separate JVM
packet. The manifest binds the final verdict and evidence-selection artifacts
by hash and producer identifier. Full native interaction receipts and review
logs stay in the acceptance archive; they are not copied into the repository.

## Android packet and native example

The 69-image packet combines 65 outputs from source `35712b0688f866884240b6163ff29b8a26360235`
with four applicable rerun outputs from `812354414febba725078595ecadf4f9d5fb73540`.
Both producer runs passed. The later run replaces the folded Terminal Dashboard,
folded Terminal status tokens, unfolded two-pane Budget and unfolded two-pane
Dashboard entries. Three replacements have identical bytes to their original
entries; provenance still identifies the rerun. Other cells retain their
original source attribution. The final A21 change affects an editor's Next
predicate, which this generator does not open, so it required no packet rerun.

These are Roborazzi JVM renderings using Robolectric API 34, without an
acceptance overlay or installed APK. Configured viewports are 411×891dp folded
and 841×945dp unfolded at 420dpi. They do not establish physical Fold geometry
or native Android execution. The filenames preserve generator cases, including
profile restrictions that can redirect a requested destination to Dashboard.
Their fixture states and themes are encoded in the filenames; `terminal` marks
that appearance and the default packet uses Daylight.

The separate [filtered Activity frame](android-native/final-filter-empty.png)
is a native Android 16 emulator framebuffer from source
`47b97f256a9d205eff281ed4d84c32ab58c2d754`, with the reviewed r5 synthetic overlay.
Its installed APK hash is in the manifest. This is version 0.1.1, version code 2.
The configured cover viewport is 906×2284px at 420dpi, font scale 1.0, Daylight.
The system's physical display configuration was 2208×1840px; the override is
not a measured Galaxy cover. The accepted native Clear interaction restored
21 fixture rows, but that interaction is not proved by this single still.

## iPhone set

All 24 iPhone images are raw `simctl` framebuffers from the approved unsigned
Debug simulator acceptance build sequence. They retain version 0.5.0, build 44.
The environment was Xcode 26.6 build 17F113 and iOS 26.5 build 23F77.
Compact is iPhone SE, third generation, at 375×667pt and 2× scale. Wide is
iPhone 17 Pro Max at 440×956pt and 3× scale.

| Set | Count | Source and scope |
|---|---:|---|
| Home | 4 | `fa0d853b6b0942510ce1e65aff31233645a0d361`, final I16 fallback captures: compact light Large, wide dark Large, compact and wide dark Accessibility Large |
| Editors | 12 | `0716b7411c14aee80360f3e30ad80286a535bc5c`, Account, Transfer and Bill Pay × compact/wide × dark/light, Large text, keyboard and validation with visible disabled Save |
| Category | 8 | `abd13cd70bb33db906578f75e458ee120de4df3f`, placeholder and populated Category × compact/wide × dark/light, accepted I15 supplement to the editor matrix |

The manifest records the installed debug dylib hash for each revision. All
three use the same reviewed v5 overlay, whose SHA-256 is also recorded.
The I14 and I15 runs each passed 18 focused native tests. The final I16 revision
passed three affected chrome tests; earlier broader test results belong to
their original revisions. These images are accepted constituent evidence,
not a claim that the later combined delivery tree was installed.

## Scope and remaining checks

All content is approved synthetic fixture data. The iPhone fixture refuses
network transport and runs unpaired with canonical finance unloaded. Editor
fixtures use direct presentation, skip onboarding and disable the app lock.
Home uses the fixture without direct-editor launch flags. No original audit
image with unverified privacy provenance is included.

This completes the screenshot handoff portion of D1. It does not complete the
full tap-count inventory in #352. Direct fixture entry does not establish
production tap counts, pairing, authenticated submit, backend refresh or
protected-data and biometric lifecycle behavior. Physical hinge behavior,
haptics, spoken accessibility traversal and populated canonical iPhone Home
hero values remain unverified. Native large-content titles and navigation were
accepted in the full archive, but spoken VoiceOver and focus traversal were
not observed. Transport refusal is fixture isolation, not production security
acceptance. No pixel-fidelity claim is made against the excluded audit images.

No capture, image transformation, app build or test ran while packaging this
set. Packaging checks compare every copied PNG with its approved source hash,
validate portable local links, preserve the 12 historical PNGs and confirm
that application source trees are unchanged.
