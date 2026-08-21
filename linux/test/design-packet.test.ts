// Guards the design packet against silent drift.
//
// scripts/capture-screenshots.mjs keeps its own page list because it is a plain
// Node script with no build step. That list can fall out of sync with the router,
// and the failure mode is quiet: a new page simply never gets photographed and
// nobody notices it was missing from review.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "vitest"

import { ALL_PAGES, resolvePage } from "../src/renderer/pages/index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const script = readFileSync(join(here, "..", "scripts", "capture-screenshots.mjs"), "utf8")

function arrayLiteral(name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(script)
  assert.ok(match, `${name} not found in capture-screenshots.mjs`)
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!)
}

test("the capture script photographs every route", () => {
  const scripted = arrayLiteral("ALL_PAGES")
  const actual = ALL_PAGES.map((page) => page.id)

  const missing = actual.filter((id) => !scripted.includes(id))
  const stale = scripted.filter((id) => !actual.includes(id))

  assert.deepEqual(missing, [], `routes missing from the design packet: ${missing.join(", ")}`)
  assert.deepEqual(stale, [], `design packet lists routes that no longer exist: ${stale.join(", ")}`)
  assert.equal(scripted.length, actual.length)
})

test("every sampled page in the capture script is a real route", () => {
  for (const name of ["CHILD_PAGES", "STATE_SAMPLE"]) {
    for (const id of arrayLiteral(name)) {
      assert.ok(
        ALL_PAGES.some((page) => page.id === id),
        `${name} lists "${id}", which is not a route`,
      )
    }
  }
})

test("child pages in the packet are actually reachable by a child", () => {
  // Photographing an adult-only page as Mason would silently capture the
  // fallback state instead of the page, which is worse than not capturing it.
  for (const id of arrayLiteral("CHILD_PAGES")) {
    assert.ok(resolvePage(id, "mason"), `CHILD_PAGES lists "${id}", which Mason cannot open`)
  }
})

test("the state sample only covers data-backed pages", () => {
  // A static page has no loading/error/stale rendering, so photographing it in
  // those states produces four identical images.
  const staticPages = new Set(["family", "settings", "export", "csv-import", "onboarding", "lock"])
  for (const id of arrayLiteral("STATE_SAMPLE")) {
    assert.ok(!staticPages.has(id), `STATE_SAMPLE includes static page "${id}"`)
  }
})
