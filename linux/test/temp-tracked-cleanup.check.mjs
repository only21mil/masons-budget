import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const temp = require("temp").track()

test("temp.track asynchronous cleanup removes a tracked file", async () => {
  const info = await new Promise((resolve, reject) => {
    temp.open("vogel-vault-temp-cleanup-", (error, opened) => {
      if (error) reject(error)
      else resolve(opened)
    })
  })

  await writeFile(info.path, "tracked by temp\n", "utf8")
  assert.equal(existsSync(info.path), true, "temp.open did not create its tracked file")

  const stats = await new Promise((resolve, reject) => {
    temp.cleanup((error, cleaned) => {
      if (error) reject(error)
      else resolve(cleaned)
    })
  })

  assert.equal(existsSync(info.path), false, "temp.cleanup left its tracked file behind")
  assert.ok(stats.files >= 1, `temp.cleanup reported only ${stats.files} removed files`)
})
