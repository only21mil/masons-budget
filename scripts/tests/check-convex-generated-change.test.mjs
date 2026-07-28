import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const sourceScript = path.join(repoRoot, "scripts/check-convex-generated-change.sh")

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

async function fixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "convex-generated-change-"))
  await mkdir(path.join(root, "scripts"), { recursive: true })
  await mkdir(path.join(root, "convex/_generated"), { recursive: true })
  await cp(sourceScript, path.join(root, "scripts/check-convex-generated-change.sh"))
  await writeFile(path.join(root, "convex/schema.ts"), "export default {};\n")
  await writeFile(path.join(root, "convex/tables.ts"), "export const list = 1;\n")
  await writeFile(
    path.join(root, "convex/_generated/api.d.ts"),
    `import type * as tables from "../tables.js";
declare const fullApi: { tables: typeof tables };
`,
  )
  const schemaDigest = createHash("sha256")
    .update("export default {};\n")
    .digest("hex")
  await writeFile(
    path.join(root, "convex/_generated/schema.sha256"),
    `${schemaDigest}  convex/schema.ts\n`,
  )
  git(root, "init", "-q")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  git(root, "add", ".")
  git(root, "commit", "-qm", "base")
  return root
}

test("a new Convex source module requires regenerated API declarations", async (t) => {
  const root = await fixtureRepo()
  t.after(() => rm(root, { force: true, recursive: true }))
  const base = git(root, "rev-parse", "HEAD")
  await writeFile(path.join(root, "convex/newQuery.ts"), "export const query = 1;\n")
  git(root, "add", "convex/newQuery.ts")
  git(root, "commit", "-qm", "add module")

  const result = spawnSync(
    "bash",
    [path.join(root, "scripts/check-convex-generated-change.sh"), base, "HEAD"],
    { cwd: root, encoding: "utf8" },
  )

  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /module inventory/i)
})
