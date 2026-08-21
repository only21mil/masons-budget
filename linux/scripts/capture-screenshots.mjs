#!/usr/bin/env node
// Design packet capture.
//
// Serves the built renderer and drives headless Chromium over a matrix of
// page / profile / state / viewport targets, writing PNGs plus a manifest.
//
// Runs after `vite build`, needs no display, and touches no live backend — the
// harness renders the same sanitized fixtures the app does.
//
//   node scripts/capture-screenshots.mjs [--out <dir>] [--only <substring>]

import { createServer } from "node:http"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const distDir = join(root, "dist")

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const outDir = resolve(arg("--out", join(root, "screenshots")))
const only = arg("--only", null)

// ── Target matrix ───────────────────────────────────────────────────────────
// Chosen for reviewability, not exhaustiveness. Every page is captured at both
// widths in its normal state so the whole product can be read end to end; the
// non-normal states and the child profile are sampled on the pages where they
// actually differ. Any page dropped from a dimension is logged, never silent.

const COMPACT = { name: "1366", width: 1366, height: 900 }
const WIDE = { name: "1920", width: 1920, height: 1200 }

const ALL_PAGES = [
  "dashboard", "budget", "activity", "bitcoin", "bitcoin-buys", "bills",
  "net-worth",
  "today", "inbox", "upcoming", "flagged", "projects",
  "family", "sync-health", "export", "csv-import", "settings", "onboarding", "lock",
]

// Pages a child profile can reach (adult-only ones are excluded by the router).
const CHILD_PAGES = ["dashboard", "budget", "activity", "bitcoin", "net-worth", "today", "family"]

// Pages that read synced data, so the four non-normal states are meaningful.
const STATE_SAMPLE = ["dashboard", "budget", "activity", "net-worth", "today"]
const NON_NORMAL_STATES = ["stale", "error", "empty", "loading"]

function buildTargets() {
  const targets = []

  for (const page of ALL_PAGES) {
    targets.push({ page, profile: "victor", state: "normal", viewport: COMPACT })
    targets.push({ page, profile: "victor", state: "normal", viewport: WIDE })
  }

  for (const page of STATE_SAMPLE) {
    for (const state of NON_NORMAL_STATES) {
      targets.push({ page, profile: "victor", state, viewport: COMPACT })
    }
  }

  // Child profile: proves the reduced surface and the locked profile switcher.
  for (const page of CHILD_PAGES) {
    targets.push({ page, profile: "mason", state: "normal", viewport: COMPACT })
  }

  return only ? targets.filter((t) => JSON.stringify(t).includes(only)) : targets
}

// ── Static server ───────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
}

function serve(directory) {
  return new Promise((resolvePort) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://localhost")
      const relative = url.pathname === "/" ? "/index.html" : url.pathname
      const filePath = join(directory, decodeURIComponent(relative))

      if (!filePath.startsWith(directory) || !existsSync(filePath)) {
        response.writeHead(404).end("not found")
        return
      }
      response.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" })
      createReadStream(filePath).pipe(response)
    })
    server.listen(0, "127.0.0.1", () => resolvePort({ server, port: server.address().port }))
  })
}

// ── Capture ─────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(join(distDir, "screenshots.html"))) {
    console.error("capture-screenshots: dist/screenshots.html missing — run `vite build` first.")
    process.exit(1)
  }

  let chromium
  try {
    ({ chromium } = await import("playwright"))
  } catch {
    console.error("capture-screenshots: playwright is not installed.")
    console.error("  npm install && npx playwright install --with-deps chromium")
    process.exit(1)
  }

  const targets = buildTargets()
  await mkdir(outDir, { recursive: true })

  const { server, port } = await serve(distDir)
  const browser = await chromium.launch()
  const captured = []
  const failures = []

  try {
    for (const target of targets) {
      const { page: route, profile, state, viewport } = target
      const name = `${viewport.name}-${route}-${profile}-${state}.png`
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: "dark",
        reducedMotion: "reduce",
      })
      const tab = await context.newPage()

      const errors = []
      tab.on("pageerror", (error) => errors.push(String(error)))
      tab.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text())
      })

      const url =
        `http://127.0.0.1:${port}/screenshots.html` +
        `?page=${encodeURIComponent(route)}&profile=${profile}&state=${state}`

      try {
        await tab.goto(url, { waitUntil: "load", timeout: 20_000 })
        // Wait on the harness's own paint flag, not an arbitrary sleep.
        //
        // A selector rather than waitForFunction: the app's CSP forbids
        // unsafe-eval, so evaluating a string in the page is blocked, and a
        // function form would put a browser-context `document` reference inside
        // this Node file. Matching an attribute sidesteps both.
        await tab.waitForSelector('html[data-vv-ready="true"]', {
          state: "attached",
          timeout: 20_000,
        })
        await tab.screenshot({ path: join(outDir, name), fullPage: false })

        if (errors.length > 0) {
          failures.push({ name, reason: `console/page errors: ${errors.slice(0, 3).join(" | ")}` })
        } else {
          captured.push({ name, ...target, viewport: viewport.name })
        }
      } catch (error) {
        failures.push({ name, reason: String(error).split("\n")[0] })
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    server.close()
  }

  const manifest = {
    generated: "see workflow run metadata",
    total: targets.length,
    captured: captured.length,
    failed: failures.length,
    viewports: [COMPACT, WIDE],
    coverage: {
      pagesAtBothWidths: ALL_PAGES.length,
      stateSamplePages: STATE_SAMPLE,
      nonNormalStates: NON_NORMAL_STATES,
      childProfilePages: CHILD_PAGES,
      note:
        "Non-normal states and the child profile are sampled, not exhaustive. " +
        "The headless render matrix in test/routes.test.ts covers every " +
        "page x profile x state combination for correctness; this packet is for " +
        "visual review.",
    },
    shots: captured,
    failures,
  }
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`capture-screenshots: ${captured.length}/${targets.length} captured -> ${outDir}`)
  if (failures.length > 0) {
    console.error(`capture-screenshots: ${failures.length} FAILED`)
    for (const failure of failures) console.error(`  x ${failure.name}: ${failure.reason}`)
    process.exit(1)
  }
}

await main()
