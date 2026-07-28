import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const sourceScript = path.join(repoRoot, "scripts/verify-convex-generated-freshness.sh")

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

test("authenticated freshness refuses a dirty generated tree before codegen", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "convex-generated-freshness-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  await mkdir(path.join(root, "scripts"), { recursive: true })
  await mkdir(path.join(root, "convex/_generated"), { recursive: true })
  await mkdir(path.join(root, "test-bin"), { recursive: true })
  await cp(sourceScript, path.join(root, "scripts/verify-convex-generated-freshness.sh"))
  await writeFile(path.join(root, "convex/_generated/api.d.ts"), "export {};\n")
  await writeFile(
    path.join(root, "test-bin/npm"),
    `#!/usr/bin/env bash
touch "${path.join(root, "npm-was-run")}"
exit 0
`,
    { mode: 0o755 },
  )
  git(root, "init", "-q")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  git(root, "add", ".")
  git(root, "commit", "-qm", "base")
  await writeFile(path.join(root, "convex/_generated/api.d.ts"), "export const dirty: true;\n")

  const result = spawnSync(
    "bash",
    [path.join(root, "scripts/verify-convex-generated-freshness.sh")],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "test-bin")}:${process.env.PATH}` },
    },
  )

  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /clean generated tree/i)
  await assert.rejects(access(path.join(root, "npm-was-run")))
})
