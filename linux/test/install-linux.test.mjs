import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import test from "node:test"

import { installLinuxApp } from "../scripts/install-linux.mjs"

async function writeChecksums(appImage) {
  const checksum = createHash("sha256").update(await readFile(appImage)).digest("hex")
  const checksumFile = path.join(path.dirname(appImage), "SHA256SUMS")
  await writeFile(checksumFile, `${checksum}  ${path.basename(appImage)}\n`)
  return checksumFile
}

test("installed command aliases and desktop entry use one configured launcher", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "vogel-vault-install-test-"))
  try {
    const appImage = path.join(fixtureRoot, "candidate.AppImage")
    const icon = path.join(fixtureRoot, "icon.png")
    const fakeBin = path.join(fixtureRoot, "fake-bin")
    const prefix = path.join(fixtureRoot, "prefix")
    await mkdir(fakeBin)
    await writeFile(
      appImage,
      `#!/usr/bin/env bash
set -euo pipefail
[[ "\${VOGEL_VAULT_REMOTE_READ:-}" == "1" ]]
[[ "\${VOGEL_VAULT_CONVEX_URL:-}" == "https://keen-elephant-452.convex.cloud" ]]
[[ -n "\${VOGEL_VAULT_CONVEX_READ_TOKEN:-}" ]]
[[ "\${VOGEL_VAULT_DEVICE_WRITES:-}" == "1" ]]
printf 'configured:%s\n' "$1"
`,
      { mode: 0o755 },
    )
    await writeFile(icon, "fixture icon")
    const secretTool = path.join(fakeBin, "secret-tool")
    await writeFile(secretTool, "#!/usr/bin/env bash\nprintf '%s' 'fixture-only-token'\n", { mode: 0o755 })
    await chmod(secretTool, 0o755)

    const installed = await installLinuxApp({ appImage, prefix, iconSource: icon })
    assert.equal(await readlink(installed.command), installed.installedLauncher)
    assert.equal(await readlink(installed.launcherCommand), installed.installedLauncher)

    for (const command of [installed.command, installed.launcherCommand]) {
      const run = spawnSync(command, ["probe"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      })
      assert.equal(run.status, 0, run.stderr)
      assert.equal(run.stdout, "configured:probe\n")
    }

    const desktop = await readFile(installed.desktopEntry, "utf8")
    assert.match(desktop, new RegExp(`^Exec="${installed.command}" %U$`, "m"))
    assert.match(desktop, new RegExp(`^TryExec=${installed.command}$`, "m"))
    assert.doesNotMatch(desktop, /AppImage/)
    assert.equal(installed.backupAppImage, null)
    assert.equal(installed.verifiedChecksum, null)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test("verifies a sibling SHA256SUMS before replacing the AppImage and retains the previous version", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "vogel-vault-checksum-test-"))
  try {
    const artifactDir = path.join(fixtureRoot, "artifacts")
    const appImage = path.join(artifactDir, "Vogel-Vault-0.2.0-x86_64.AppImage")
    const icon = path.join(fixtureRoot, "icon.png")
    const prefix = path.join(fixtureRoot, "prefix")
    const installedAppImage = path.join(prefix, "opt", "vogel-vault", "Vogel-Vault.AppImage")
    await mkdir(artifactDir)
    await mkdir(path.dirname(installedAppImage), { recursive: true })
    await writeFile(appImage, "new AppImage")
    const checksumFile = await writeChecksums(appImage)
    await writeFile(icon, "fixture icon")
    await writeFile(installedAppImage, "previous AppImage")

    const installed = await installLinuxApp({ appImage, prefix, iconSource: icon })

    assert.equal(await readFile(installed.installedAppImage, "utf8"), "new AppImage")
    assert.equal(await readFile(installed.backupAppImage, "utf8"), "previous AppImage")
    assert.equal(installed.verifiedChecksum, checksumFile)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test("rejects a checksum mismatch without changing the installed AppImage", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "vogel-vault-checksum-mismatch-test-"))
  try {
    const appImage = path.join(fixtureRoot, "candidate.AppImage")
    const icon = path.join(fixtureRoot, "icon.png")
    const prefix = path.join(fixtureRoot, "prefix")
    const installedAppImage = path.join(prefix, "opt", "vogel-vault", "Vogel-Vault.AppImage")
    await mkdir(path.dirname(installedAppImage), { recursive: true })
    await writeFile(appImage, "tampered AppImage")
    await writeFile(path.join(fixtureRoot, "SHA256SUMS"), `${"0".repeat(64)}  candidate.AppImage\n`)
    await writeFile(icon, "fixture icon")
    await writeFile(installedAppImage, "working AppImage")

    await assert.rejects(
      installLinuxApp({ appImage, prefix, iconSource: icon }),
      /SHA-256 mismatch for candidate\.AppImage/,
    )
    assert.equal(await readFile(installedAppImage, "utf8"), "working AppImage")
    assert.equal(existsSync(`${installedAppImage}.backup`), false)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test("restores the previous AppImage when a later install step fails", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "vogel-vault-rollback-test-"))
  try {
    const appImage = path.join(fixtureRoot, "candidate.AppImage")
    const icon = path.join(fixtureRoot, "icon.png")
    const prefix = path.join(fixtureRoot, "prefix")
    const installedAppImage = path.join(prefix, "opt", "vogel-vault", "Vogel-Vault.AppImage")
    const installedIcon = path.join(prefix, "share", "icons", "hicolor", "512x512", "apps", "vogel-vault.png")
    await mkdir(path.dirname(installedAppImage), { recursive: true })
    await mkdir(installedIcon, { recursive: true })
    await writeFile(appImage, "replacement AppImage")
    await writeFile(icon, "fixture icon")
    await writeFile(installedAppImage, "working AppImage")

    await assert.rejects(installLinuxApp({ appImage, prefix, iconSource: icon }))
    assert.equal(await readFile(installedAppImage, "utf8"), "working AppImage")
    assert.equal(existsSync(`${installedAppImage}.backup`), false)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
