import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const sourceScript = path.join(repoRoot, "scripts/check-convex-wire-golden-provenance.mjs")

async function fixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "convex-wire-provenance-"))
  await mkdir(path.join(root, "scripts"), { recursive: true })
  await mkdir(path.join(root, "convex"), { recursive: true })
  await mkdir(path.join(root, "shared/domain"), { recursive: true })
  await cp(path.join(repoRoot, "package.json"), path.join(root, "package.json"))
  await cp(sourceScript, path.join(root, "scripts/check-convex-wire-golden-provenance.mjs"))
  await cp(
    path.join(repoRoot, "convex/schema.ts"),
    path.join(root, "convex/schema.ts"),
  )
  await cp(
    path.join(repoRoot, "convex/tables.ts"),
    path.join(root, "convex/tables.ts"),
  )
  await cp(
    path.join(repoRoot, "shared/domain/convex-wire-golden-provenance.json"),
    path.join(root, "shared/domain/convex-wire-golden-provenance.json"),
  )
  await cp(
    path.join(repoRoot, "shared/domain/fixtures/convex-wire-golden"),
    path.join(root, "shared/domain/fixtures/convex-wire-golden"),
    { recursive: true },
  )
  await symlink(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "dir")
  return root
}

function runGate(root) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/check-convex-wire-golden-provenance.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CONVEX_WIRE_GOLDEN_NOW: "2026-07-27" },
    },
  )
}

test("an unrelated schema table does not invalidate captured query provenance", async (t) => {
  const root = await fixtureRepo()
  t.after(() => rm(root, { force: true, recursive: true }))
  const schemaPath = path.join(root, "convex/schema.ts")
  const schema = await readFile(schemaPath, "utf8")
  const changed = schema.replace(
    "export default defineSchema({",
    `export default defineSchema({
  unrelatedAuditEvents: defineTable({
    message: v.string(),
  }),`,
  )
  assert.notEqual(changed, schema, "fixture must add an unrelated table")
  await writeFile(schemaPath, changed)

  const result = runGate(root)

  assert.equal(result.status, 0, result.stderr)
})

test("a comment edit inside a captured projection does not invalidate provenance", async (t) => {
  const root = await fixtureRepo()
  t.after(() => rm(root, { force: true, recursive: true }))
  const tablesPath = path.join(root, "convex/tables.ts")
  const tables = await readFile(tablesPath, "utf8")
  const changed = tables.replace(
    "// CANONICAL SOURCE: shared/domain/src/readModel.ts",
    "// Comment-only edit: projection behavior is unchanged.",
  )
  assert.notEqual(changed, tables, "fixture must edit a projection comment")
  await writeFile(tablesPath, changed)

  const result = runGate(root)

  assert.equal(result.status, 0, result.stderr)
})

test("an unprojected storage field does not change the public query shape", async (t) => {
  const root = await fixtureRepo()
  t.after(() => rm(root, { force: true, recursive: true }))
  const schemaPath = path.join(root, "convex/schema.ts")
  const schema = await readFile(schemaPath, "utf8")
  const changed = schema.replace(
    "migrationRaw: v.optional(v.any()),",
    `unprojectedMigrationNote: v.optional(v.string()),
    migrationRaw: v.optional(v.any()),`,
  )
  assert.notEqual(changed, schema, "fixture must add an unprojected transaction field")
  await writeFile(schemaPath, changed)

  const result = runGate(root)

  assert.equal(result.status, 0, result.stderr)
})

test("a captured query response-shape change invalidates provenance", async (t) => {
  const root = await fixtureRepo()
  t.after(() => rm(root, { force: true, recursive: true }))
  const tablesPath = path.join(root, "convex/tables.ts")
  const tables = await readFile(tablesPath, "utf8")
  const changed = tables.replace(
    "updatedAtMs: row.updatedAtMs,\n  };\n}\n\nfunction projectTodo",
    "updatedAtMs: row.updatedAtMs,\n    wireShapeChanged: true,\n  };\n}\n\nfunction projectTodo",
  )
  assert.notEqual(changed, tables, "fixture must change projectTransaction")
  await writeFile(tablesPath, changed)

  const result = runGate(root)

  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /query shape/i)
})
