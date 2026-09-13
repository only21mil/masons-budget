# Screenshot evidence

The [2026-09-13 handoff](2026-09-13/README.md) is the current screenshot reference
for the reviewed mobile fixes. It contains an Android Roborazzi packet and
approved synthetic iPhone Simulator captures, with a separate native Android
example. Open the [image index](2026-09-13/index.md) for all 94 frames.

The 12 PNG files directly in this directory show the historical 2026-04-30 app,
as identified by the mobile audit. They predate the current Vogel Vault
interface and are not current design references or acceptance evidence.
Their paths and bytes remain unchanged for history. The
[historical hash inventory](2026-09-13/historical-png-sha256.json) records them
using repository-relative paths.

The Android packet source is
[DesignPacketTest.kt](../android/app/src/test/kotlin/com/sats21m/vogelvault/DesignPacketTest.kt).
The layout contract is [FOUNDATIONS.md](../Design/FOUNDATIONS.md).
