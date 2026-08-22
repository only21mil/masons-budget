import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const sourceScript = path.join(repoRoot, "scripts/check-convex-wire-golden-provenance.mjs")
const toolingModule = path.join(repoRoot, "scripts/convex-wire-golden.mjs")

async function fixtureRepo({ valueTestExitCode = 0, vitestLayout = "root" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "convex-wire-provenance-"))
  await mkdir(path.join(root, "scripts"), { recursive: true })
  await mkdir(path.join(root, "convex"), { recursive: true })
  await mkdir(path.join(root, "shared/domain"), { recursive: true })
  await mkdir(path.join(root, "linux/test"), { recursive: true })
  await cp(sourceScript, path.join(root, "scripts/check-convex-wire-golden-provenance.mjs"))
  await cp(toolingModule, path.join(root, "scripts/convex-wire-golden.mjs"))
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
  await writeFile(
    path.join(root, "linux/test/convex-wire-golden-values.test.ts"),
    "// Fixture test path for the provenance checker.\n",
  )
  if (vitestLayout === "root") {
    await mkdir(path.join(root, "node_modules/.bin"), { recursive: true })
  } else if (vitestLayout === "linux") {
    await mkdir(path.join(root, "linux/node_modules/.bin"), { recursive: true })
  } else if (vitestLayout !== "none") {
    throw new Error(`unsupported Vitest fixture layout: ${vitestLayout}`)
  }
  if (vitestLayout !== "none") {
    await writeFile(
      path.join(
        root,
        vitestLayout === "root" ? "node_modules/.bin/vitest" : "linux/node_modules/.bin/vitest",
      ),
      `#!/usr/bin/env node\nprocess.exit(${valueTestExitCode})\n`,
      { mode: 0o755 },
    )
  }
  return root
}

function capturedDate(root) {
  const provenance = JSON.parse(readFileSync(
    path.join(root, "shared/domain/convex-wire-golden-provenance.json"),
    "utf8",
  ))
  return provenance.capturedDate
}

function runGate(root, { now = capturedDate(root) } = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/check-convex-wire-golden-provenance.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CONVEX_WIRE_GOLDEN_NOW: now },
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

test("the repository-level Vitest runner executes the value test", async (t) => {
  const root = await fixtureRepo({ vitestLayout: "root" })
  t.after(() => rm(root, { force: true, recursive: true }))

  const result = runGate(root)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^PASS:/m)
})

test("the Linux-local Vitest runner is used when the root runner is absent", async (t) => {
  const root = await fixtureRepo({ vitestLayout: "linux" })
  t.after(() => rm(root, { force: true, recursive: true }))

  const result = runGate(root)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^PASS:/m)
})

test("the provenance gate fails closed when no Vitest runner exists", async (t) => {
  const root = await fixtureRepo({ vitestLayout: "none" })
  t.after(() => rm(root, { force: true, recursive: true }))

  const result = runGate(root)

  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /could not find Vitest runner/)
  assert.doesNotMatch(result.stdout, /^PASS:/m)
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

test("an attested query without a production capture still guards its shape", async (t) => {
  const root = await fixtureRepo()
  t.after(() => rm(root, { force: true, recursive: true }))
  const tablesPath = path.join(root, "convex/tables.ts")
  const tables = await readFile(tablesPath, "utf8")
  const changed = tables.replace(
    "incomeId: row.incomeId,\n    owner: row.owner,",
    "incomeId: row.incomeId,\n    wireShapeChanged: true,\n    owner: row.owner,",
  )
  assert.notEqual(changed, tables, "fixture must change projectIncome")
  await writeFile(tablesPath, changed)

  const result = runGate(root)

  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /query shape checksum mismatch for listIncome/)
})

test("a capture dated after the injected clock still fails loudly", async (t) => {
  const root = await fixtureRepo()
  t.after(() => rm(root, { force: true, recursive: true }))
  const captureDay = new Date(`${capturedDate(root)}T00:00:00.000Z`)
  captureDay.setUTCDate(captureDay.getUTCDate() - 1)

  const result = runGate(root, { now: captureDay.toISOString() })

  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /capture date .* is 1 days in the future/)
})

test("a failing Linux value decoder prevents a provenance pass", async (t) => {
  const root = await fixtureRepo({ valueTestExitCode: 1 })
  t.after(() => rm(root, { force: true, recursive: true }))

  const result = runGate(root)

  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /Linux production value test failed with exit 1/)
  assert.doesNotMatch(result.stdout, /^PASS:/m)
})
