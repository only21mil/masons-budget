// electron-builder afterPack hook: flip the Electron runtime fuses on the
// packaged Linux binary before the AppImage is assembled.
//
// Without this, the shipped binary still honours `ELECTRON_RUN_AS_NODE`,
// `NODE_OPTIONS`, and `--inspect`-style entry points, and Chromium cookies sit
// in plaintext — the fuse defaults. The install prefix is user-local by
// design, so raising this bar matters: a same-user payload swap should not
// gain a Node-restricted escape hatch into the main process.
//
// Deferred on Linux, deliberately: `EnableEmbeddedAsarIntegrityValidation` and
// `OnlyLoadAppFromAsar` are enforced by Electron on macOS and Windows only —
// the Linux runtime ignores the fuse bit and the toolchain cannot embed the
// integrity data. Payload tamper-evidence on Linux stays at the mandatory
// SHA256SUMS verification in install-linux.mjs.

const path = require("node:path")

const { FuseV1Options, FuseVersion, FuseState, flipFuses, getCurrentFuseWire } = require("@electron/fuses")

const FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return

  // The Linux packager owns the executable-name resolution (package.json
  // build.linux.executableName) — the same name it gives the unpacked binary.
  const executableName = context.packager.executableName ?? context.packager.appInfo.productFilename
  const executablePath = path.join(context.appOutDir, executableName)
  await flipFuses(executablePath, { version: FuseVersion.V1, ...FUSES })

  // Read the wire back and fail the build rather than ship a silently
  // unflipped binary. The wire carries raw states (DISABLE/ENABLE), not the
  // booleans the flip config takes.
  const wire = await getCurrentFuseWire(executablePath)
  for (const [fuse, expected] of Object.entries(FUSES)) {
    const expectedState = expected ? FuseState.ENABLE : FuseState.DISABLE
    if (wire[fuse] !== expectedState) {
      throw new Error(
        `Fuse ${FuseV1Options[fuse]} read back as ${wire[fuse]}, expected ${expectedState}: ${executablePath}`,
      )
    }
  }
  console.log("afterpack-fuses: Electron fuses flipped and verified on the packaged binary")
}
