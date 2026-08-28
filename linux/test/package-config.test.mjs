import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

const linuxRoot = path.resolve(import.meta.dirname, "..")
const repositoryRoot = path.dirname(linuxRoot)

test("Linux packaging emits only the keyring-launcher-compatible AppImage", async () => {
  const packageJson = JSON.parse(await readFile(path.join(linuxRoot, "package.json"), "utf8"))
  assert.deepEqual(packageJson.build.linux.target, [{ target: "AppImage", arch: ["x64"] }])

  const packageScript = await readFile(path.join(linuxRoot, "scripts", "package-linux.mjs"), "utf8")
  const verifyScript = await readFile(
    path.join(linuxRoot, "scripts", "package-verify-linux.mjs"),
    "utf8",
  )
  const workflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "linux-package.yml"),
    "utf8",
  )

  assert.match(packageScript, /\[builderCli, "--linux", "AppImage", "--x64"/)
  assert.doesNotMatch(packageScript, /["']deb["']|\.deb/)
  assert.doesNotMatch(verifyScript, /dpkg-deb|\.deb/)
  assert.doesNotMatch(workflow, /\.deb|deb \+ AppImage/)
})
