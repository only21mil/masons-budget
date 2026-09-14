// The Electron-side half of the window smoke test.
//
// This file is the Electron entry point. It installs error traps and a window
// observer, then imports the REAL built main process (dist-electron/main.js)
// and lets it run untouched: the same single-instance lock, the same session
// hardening, the same BrowserWindow options, the same preload path. Nothing in
// the app is stubbed or overridden — the harness only watches.
//
// Observing from inside the main process rather than over the DevTools protocol
// is deliberate. It is the only way to see a preload failure, a main-process
// throw, or a dead renderer, and it avoids attaching a debugger to a hardened
// app just to look at it. See scripts/smoke-electron.mjs for the display story.
//
// Not run directly. scripts/smoke-electron.mjs launches it.

import { writeFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

import { app } from "electron"

// fileURLToPath, not URL.pathname: a checkout under a path with a space would
// otherwise resolve to a percent-encoded directory that does not exist.
const harnessRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// The normal smoke imports the current build. The packaged smoke points this at
// an app.asar extracted from the AppImage, so the exact shipped payload runs.
const appRoot = process.env.VV_SMOKE_APP_ROOT ? path.resolve(process.env.VV_SMOKE_APP_ROOT) : harnessRoot
const mainEntry = path.join(appRoot, "dist-electron", "main.js")

const reportPath = process.env.VV_SMOKE_REPORT
const outDir = process.env.VV_SMOKE_OUT_DIR
const budgetMs = Number(process.env.VV_SMOKE_BUDGET_MS ?? 60_000)

/** The window contract this test exists to hold. Sourced from electron/main.ts. */
const EXPECTED = {
  width: 1440,
  height: 900,
  // The ledger canvas of the saved treatment; a fresh profile is dark.
  backgroundColor: "#050505",
  // The body paints nothing so the window colour shows until the shell mounts.
  bodyBackground: "rgba(0, 0, 0, 0)",
  sidebarWide: 130,
  sidebarCompact: 130,
  // The stylesheet's compact pass is `max-width: 1365px`, so 1365 must switch to icon-only
  // and 1366 must not. Testing both sides is the only way to prove the
  // breakpoint is where the design says it is rather than merely nearby.
  breakpointCollapsesAt: 1365,
  breakpointHoldsAt: 1366,
  minWidth: 1100,
  minHeight: 700,
  bridgeKeys: [
    "exportCsv",
    "getPairingStatus",
    "getRemoteSnapshot",
    "getRuntimeInfo",
    "mutateConvexRow",
    "pairDevice",
    "queryConvexRows",
    "setReadProfile",
    "unpairDevice",
  ],
}

const checks = []
const rendererConsoleErrors = []
const mainProcessErrors = []
const networkAttempts = []
const artifacts = []

// Packaged smoke is intentionally offline. The renderer already has every
// request denied by main.ts; this trap covers the main process's only network
// primitive and turns any attempted Convex read into a named failed check.
if (process.env.VV_SMOKE_DENY_NETWORK === "1") {
  globalThis.fetch = async (input) => {
    const target = typeof input === "string" ? input : (input?.url ?? String(input))
    networkAttempts.push(target)
    throw new Error(`packaged smoke blocked network access to ${target}`)
  }
}

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

function fatal(stage, error) {
  mainProcessErrors.push(`${stage}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
}

// Traps first. A throw anywhere in the hardened main process — including inside
// the app's own whenReady handler — must land here and fail the run, not vanish
// into a process that quietly stays alive with no window.
process.on("uncaughtException", (error) => fatal("uncaughtException", error))
process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason))

/**
 * Electron 33 emits `console-message` with positional arguments and Electron 35+
 * emits a details object. Read both so this test does not silently stop
 * noticing renderer errors the day the runtime is upgraded.
 */
function readConsoleMessage(...args) {
  const [first, second, third] = args
  if (first && typeof first === "object" && "message" in first) {
    return { level: String(first.level ?? ""), message: String(first.message ?? "") }
  }
  return { level: String(second ?? ""), message: String(third ?? "") }
}

function isErrorLevel(level) {
  return level === "error" || level === "3"
}

const run = (contents, expression) => contents.executeJavaScript(expression, true)

/**
 * Poll the renderer until it agrees, or give up loudly.
 *
 * Every wait in this file is a condition with a deadline rather than a sleep. A
 * sleep long enough for a loaded CI runner is a sleep wasted on every green run,
 * and a sleep short enough to be quick is the thing that makes a smoke test
 * flaky and then ignored.
 */
async function waitFor(contents, label, expression, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      last = await run(contents, expression)
      if (predicate(last)) return last
    } catch (error) {
      last = `evaluation failed: ${String(error).split("\n")[0]}`
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}; last value ${JSON.stringify(last)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const MEASURE = `(() => {
  const sidebar = document.querySelector(".vv-sidebar")
  const label = document.querySelector(".vv-navitem__label")
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : -1,
    labelDisplay: label ? getComputedStyle(label).display : "absent",
    navItems: document.querySelectorAll(".vv-navitem").length,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    rootChildren: document.getElementById("root") ? document.getElementById("root").childElementCount : -1,
  }
})()`

/**
 * Resize by CONTENT size, never window size.
 *
 * The breakpoint is a CSS media query, so it reads the content box. Under a
 * window manager that draws decorations, a 1365px window is not a 1365px
 * viewport, and the test would be measuring the theme's border width.
 */
async function setViewport(window, width, height) {
  window.setContentSize(width, height)
  return waitFor(
    window.webContents,
    `viewport ${width}x${height}`,
    MEASURE,
    (m) => m.innerWidth === width && m.innerHeight === height,
  )
}

/**
 * Is the captured frame actually the dark ledger canvas?
 *
 * getBackgroundColor() only reports what the window was configured with; it says
 * nothing about what was drawn. A white flash, a failed stylesheet, or a blank
 * renderer all produce a window that still claims #050505. Counting dark pixels
 * in the real frame is the only version of this check that can fail.
 *
 * The threshold is a fraction, not "no light pixels": cream text and the orange
 * accent are supposed to be there.
 */
function darkPixelFraction(image) {
  const bitmap = image.toBitmap() // BGRA
  let sampled = 0
  let dark = 0
  // A prime stride so the sample never lands on a repeating column of chrome.
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4 * 997) {
    const luma = 0.2126 * bitmap[offset + 2] + 0.7152 * bitmap[offset + 1] + 0.0722 * bitmap[offset]
    sampled += 1
    if (luma < 64) dark += 1
  }
  return sampled === 0 ? 0 : dark / sampled
}

async function capture(window, name) {
  const image = await window.webContents.capturePage()
  const png = image.toPNG()
  const file = path.join(outDir, name)
  await writeFile(file, png)
  const size = image.getSize()
  artifacts.push({ file, bytes: png.length, width: size.width, height: size.height })
  return { image, png, size, file }
}

async function inspect(window) {
  const contents = window.webContents

  // ── The window itself ────────────────────────────────────────────────────
  const bounds = window.getBounds()
  record(
    "window opens at the configured size",
    bounds.width === EXPECTED.width && bounds.height === EXPECTED.height,
    `${bounds.width}x${bounds.height}, expected ${EXPECTED.width}x${EXPECTED.height}`,
  )

  const background = window.getBackgroundColor().toLowerCase()
  record(
    "window background is the Terminal ledger canvas",
    background === EXPECTED.backgroundColor,
    `${background}, expected ${EXPECTED.backgroundColor}`,
  )

  record(
    "window is shown after ready-to-show",
    window.isVisible(),
    window.isVisible() ? "visible" : "still hidden — the ready-to-show handler did not fire",
  )

  const minimum = window.getMinimumSize()
  record(
    "minimum size is enforced",
    minimum[0] === EXPECTED.minWidth && minimum[1] === EXPECTED.minHeight,
    `${minimum[0]}x${minimum[1]}`,
  )

  // ── The preload bridge ───────────────────────────────────────────────────
  // The most likely way this app dies on a fresh machine is a preload that does
  // not resolve: the window still opens, still paints its background, and the
  // renderer just never gets its bridge. Nothing headless catches that.
  const bridge = await run(
    contents,
    `({ present: typeof window.vogelVault === "object" && window.vogelVault !== null,
        keys: Object.keys(window.vogelVault || {}).sort(),
        ipcLeaked: typeof window.require !== "undefined" || typeof window.process !== "undefined" })`,
  )
  record(
    "preload bridge loaded from the packaged path",
    bridge.present && JSON.stringify(bridge.keys) === JSON.stringify(EXPECTED.bridgeKeys),
    `keys ${JSON.stringify(bridge.keys)}`,
  )
  record("renderer has no Node globals", !bridge.ipcLeaked, bridge.ipcLeaked ? "require or process is reachable" : "")

  // ── First paint ──────────────────────────────────────────────────────────
  const painted = await waitFor(contents, "the app shell to paint", MEASURE, (m) => m.navItems > 0)
  record("renderer painted the app shell", painted.navItems > 0, `${painted.navItems} nav items, ${painted.rootChildren} root children`)
  record(
    "body leaves the canvas to the window",
    painted.bodyBackground === EXPECTED.bodyBackground,
    `${painted.bodyBackground}, expected ${EXPECTED.bodyBackground}`,
  )

  const wide = await capture(window, "window-1440x900.png")
  const darkFraction = darkPixelFraction(wide.image)
  record(
    "the captured frame is dark, not a white flash",
    darkFraction >= 0.75,
    `${(darkFraction * 100).toFixed(1)}% of sampled pixels are dark`,
  )
  record("screenshot captured", wide.png.length > 1024, `${wide.size.width}x${wide.size.height}, ${wide.png.length} bytes`)

  // ── The 1365px breakpoint ────────────────────────────────────────────────
  const held = await setViewport(window, EXPECTED.breakpointHoldsAt, EXPECTED.height)
  record(
    `sidebar stays expanded at ${EXPECTED.breakpointHoldsAt}px`,
    held.sidebarWidth === EXPECTED.sidebarWide && held.labelDisplay !== "none",
    `${held.sidebarWidth}px, labels ${held.labelDisplay}`,
  )

  const collapsed = await setViewport(window, EXPECTED.breakpointCollapsesAt, EXPECTED.height)
  record(
    `sidebar switches to icon-only at ${EXPECTED.breakpointCollapsesAt}px`,
    collapsed.sidebarWidth === EXPECTED.sidebarCompact && collapsed.labelDisplay === "none",
    `${collapsed.sidebarWidth}px, labels ${collapsed.labelDisplay}`,
  )
  await capture(window, "window-1365x900-compact.png")

  // ── Scrolling ────────────────────────────────────────────────────────────
  // The current dashboard can legitimately fit exactly at the minimum window,
  // so fixture volume is not evidence that overflow works. Shrink to the
  // smallest allowed viewport, append a hidden test-only sentinel that is
  // taller than the real content well, prove the real well moves, then restore
  // and remove the sentinel. This holds the shell's scroll contract without
  // coupling packaging health to a particular route or data-rich fixture.
  await setViewport(window, EXPECTED.minWidth, EXPECTED.minHeight)
  const scroll = await run(
    contents,
    `(() => {
      const well = document.querySelector(".vv-content")
      if (!well) return { found: false }
      const overflowY = getComputedStyle(well).overflowY
      const baselineScrollHeight = well.scrollHeight
      const clientHeight = well.clientHeight
      const sentinel = document.createElement("div")
      sentinel.dataset.vvSmokeScrollSentinel = "true"
      sentinel.setAttribute("aria-hidden", "true")
      sentinel.style.cssText =
        "display:block;width:1px;height:" + (clientHeight + 64) +
        "px;min-height:" + (clientHeight + 64) +
        "px;visibility:hidden;pointer-events:none"
      well.append(sentinel)
      well.scrollTop = 0
      const start = well.scrollTop
      well.scrollTop = 10_000
      const max = well.scrollTop
      const scrollHeight = well.scrollHeight
      well.scrollTop = 0
      const restored = well.scrollTop
      sentinel.remove()
      return {
        found: true,
        overflowY,
        start,
        max,
        restored,
        scrollHeight,
        clientHeight,
        baselineScrollHeight,
        sentinelRemoved:
          document.querySelector("[data-vv-smoke-scroll-sentinel]") === null,
      }
    })()`,
  )
  record(
    "content well permits scrolling at the minimum window size",
    scroll.found &&
      scroll.overflowY === "auto" &&
      scroll.scrollHeight > scroll.clientHeight &&
      scroll.max > 0 &&
      scroll.restored === 0 &&
      scroll.sentinelRemoved,
    scroll.found
      ? `overflow-y ${scroll.overflowY}, baseline ${scroll.baselineScrollHeight}px, test content ${scroll.scrollHeight}px in a ${scroll.clientHeight}px well, scrolled to ${scroll.max}, sentinel removed ${scroll.sentinelRemoved}`
      : "no .vv-content element",
  )

  // Leave the window as the user would first see it, so the last frame on the
  // screen during an attended run matches the shipped default.
  await setViewport(window, EXPECTED.width, EXPECTED.height)
}

const windows = []
let readyToShow = false
let finishedLoad = null

function observe() {
  app.on("browser-window-created", (_event, window) => {
    windows.push(window)
    const contents = window.webContents

    window.once("ready-to-show", () => {
      readyToShow = true
    })

    contents.on("preload-error", (_event2, preloadPath, error) => {
      fatal("preload-error", new Error(`${preloadPath}: ${error?.message ?? error}`))
    })
    contents.on("did-fail-load", (_event2, code, description, url) => {
      fatal("did-fail-load", new Error(`${code} ${description} for ${url}`))
    })
    contents.on("render-process-gone", (_event2, details) => {
      fatal("render-process-gone", new Error(`${details.reason} (exit ${details.exitCode})`))
    })
    window.on("unresponsive", () => fatal("unresponsive", new Error("the window stopped responding")))
    contents.on("console-message", (...args) => {
      const { level, message } = readConsoleMessage(...args)
      if (isErrorLevel(level)) rendererConsoleErrors.push(message)
    })

    finishedLoad = new Promise((resolve, reject) => {
      contents.once("did-finish-load", resolve)
      contents.once("did-fail-load", (_event2, code, description) => reject(new Error(`load failed: ${code} ${description}`)))
    })
  })
}

async function runChecks() {
  // The app registers its own whenReady handler before this one runs and creates
  // the window there, so the window already exists by now.
  record("main process reached ready", app.isReady())
  record("exactly one window was created", windows.length === 1, `${windows.length} windows`)
  if (windows.length !== 1) return

  const window = windows[0]
  await finishedLoad
  // ready-to-show can arrive just after did-finish-load; give it its own wait
  // rather than asserting on a race.
  const showDeadline = Date.now() + 10_000
  while (!readyToShow && Date.now() < showDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  record("ready-to-show fired", readyToShow, readyToShow ? "" : "the window would have stayed hidden")

  await inspect(window)
}

const watchdog = setTimeout(() => {
  fatal("watchdog", new Error(`the smoke run exceeded its ${budgetMs}ms budget`))
  void finish()
}, budgetMs)

let finishing = false

async function finish() {
  if (finishing) return
  finishing = true
  clearTimeout(watchdog)

  if (process.env.VV_SMOKE_DENY_NETWORK === "1") {
    record(
      "packaged smoke made no main-process network requests",
      networkAttempts.length === 0,
      networkAttempts.slice(0, 3).join(" | "),
    )
  }
  record("no renderer console errors", rendererConsoleErrors.length === 0, rendererConsoleErrors.slice(0, 3).join(" | "))
  record("no main-process errors", mainProcessErrors.length === 0, mainProcessErrors.slice(0, 2).join(" | "))

  const failed = checks.filter((check) => !check.ok)
  const report = {
    passed: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    expected: EXPECTED,
    checks,
    rendererConsoleErrors,
    mainProcessErrors,
    networkAttempts,
    artifacts,
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
    },
  }

  try {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    console.error(`smoke: could not write the report — ${String(error)}`)
  }

  console.log(`\nsmoke: ${checks.length - failed.length}/${checks.length} checks passed`)
  for (const check of failed) console.error(`  x ${check.name}${check.detail ? ` — ${check.detail}` : ""}`)

  // exit, not quit: quit runs the app's own teardown and can hang on a window
  // that is already wedged, which is exactly the state worth reporting.
  app.exit(failed.length === 0 ? 0 : 1)
}

// ── Launch ──────────────────────────────────────────────────────────────────
//
// The ordering below is load-bearing.
//
// Electron emits `ready` only after the main entry module has FINISHED
// evaluating. Awaiting app.whenReady() at the top level of an ESM main is
// therefore a deadlock: evaluation waits on ready, ready waits on evaluation,
// and the process sits there until a watchdog kills it. Observed on
// 2026-07-26 — it cost an hour, so it is written down.
//
// Everything after import must hang off an event, never a top-level await.

if (!reportPath || !outDir) {
  console.error("smoke: VV_SMOKE_REPORT and VV_SMOKE_OUT_DIR must be set — run scripts/smoke-electron.mjs, not this file.")
  app.exit(2)
}

observe()

try {
  // The app under test. Imported, never modified.
  await import(pathToFileURL(mainEntry).href)
} catch (error) {
  fatal("import dist-electron/main.js", error)
}

app.whenReady().then(
  async () => {
    try {
      await runChecks()
    } catch (error) {
      fatal("harness", error)
    }
    await finish()
  },
  (error) => {
    fatal("whenReady", error)
    return finish()
  },
)
