import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import test from "node:test"

import { installLinuxApp } from "../scripts/install-linux.mjs"

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
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
