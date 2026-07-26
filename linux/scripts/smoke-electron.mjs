#!/usr/bin/env node
// Window smoke test — launches the real Electron binary and looks at the window.
//
// Everything else in this client is verified without a display: the render
// matrix runs in jsdom, the design packet runs in headless Chromium, and the
// preload guard is static analysis. None of them can tell you whether the
// hardened main process boots, whether the preload path resolves inside a
// sandboxed window, or whether anything at all appears on screen. This does.
//
//   npm run smoke                 # build first: npx vite build
//   npm run smoke -- --xvfb       # force a virtual display even if one exists
//   npm run smoke -- --require-window   # a missing display is a failure, not a skip
//
// ── Why this needs a display ────────────────────────────────────────────────
//
// Electron 33 cannot open an ordinary window with no display server. Measured
// on 2026-07-26 against electron 33.4.11:
//
//   --ozone-platform=headless          new BrowserWindow() never returns; the
//                                      main process JS thread blocks forever
//   --ozone-platform=headless + CDP    the DevTools endpoint accepts the socket,
//                                      answers nothing, and the browser process
//                                      segfaults
//   webPreferences.offscreen: true     works headlessly — but the app does not
//                                      set it, and electron.BrowserWindow is a
//                                      non-configurable getter, so a harness
//                                      cannot force it from outside
//
// So the options are a real display, a virtual one, or nothing. Offscreen
// rendering is available to whoever owns electron/main.ts, behind an env flag;
// it is not available to a script that refuses to modify the app it is testing.
//
// Order of preference: xvfb-run (deterministic, unattended, no window manager
// second-guessing the geometry) → an inherited display (an attended run on a
// real desktop, which is the higher-fidelity check) → skip.
//
// A skip exits 0 and says so in capital letters. It is not a pass, and
// --require-window turns it into a failure for anyone who wants that guarantee.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require_ = createRequire(import.meta.url)

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
function option(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

// Under linux/screenshots/, which is already git-ignored and already the
// directory CI uploads for visual review.
const outDir = resolve(option("--out", join(root, "screenshots", "smoke")))
const budgetMs = Number(option("--budget-ms", "60000"))
const requireWindow = flag("--require-window") || process.env.VV_SMOKE_REQUIRE_WINDOW === "1"

const EXIT_FAILED = 1
const EXIT_SETUP = 2
const EXIT_NO_DISPLAY = 3

function die(code, ...lines) {
  for (const line of lines) console.error(`smoke: ${line}`)
  process.exit(code)
}

// ── Preconditions ───────────────────────────────────────────────────────────

const required = [
  ["dist/index.html", "the renderer bundle"],
  ["dist-electron/main.js", "the main process bundle"],
  ["dist-electron/preload.cjs", "the preload bundle"],
]
const missing = required.filter(([file]) => !existsSync(join(root, file)))
if (missing.length > 0) {
  die(
    EXIT_SETUP,
    `missing ${missing.map(([file, what]) => `${file} (${what})`).join(", ")}`,
    "run `npx vite build` in linux/ first.",
  )
}

// The harness imports dist-electron/main.js by path. If package.json ever points
// `main` somewhere else, this test would keep passing while exercising a file
// the shipped app no longer runs.
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
if (pkg.main !== "dist-electron/main.js") {
  die(
    EXIT_SETUP,
    `package.json main is "${pkg.main}" but this test drives dist-electron/main.js.`,
    "point the harness at the real entry point before trusting a green run.",
  )
}

let electronBinary
try {
  electronBinary = require_("electron")
} catch {
  die(EXIT_SETUP, "the electron devDependency is not installed — run `npm ci`.")
}
if (typeof electronBinary !== "string" || !existsSync(electronBinary)) {
  die(EXIT_SETUP, "the electron binary is missing; `npm ci` did not complete its postinstall download.")
}

// ── Display ─────────────────────────────────────────────────────────────────

function onPath(command) {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean)
  return dirs.some((dir) => existsSync(join(dir, command)))
}

const inheritedDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
const hasXvfb = onPath("xvfb-run")

let mode
if (flag("--xvfb")) {
  if (!hasXvfb) die(EXIT_SETUP, "--xvfb was requested but xvfb-run is not on PATH.")
  mode = "xvfb"
} else if (hasXvfb) {
  mode = "xvfb"
} else if (inheritedDisplay) {
  mode = "inherited"
} else {
  mode = "none"
}

if (mode === "none") {
  const explanation = [
    "SKIPPED — no display available, so no window can be opened.",
    "",
    "  xvfb-run is not on PATH and neither DISPLAY nor WAYLAND_DISPLAY is set.",
    "  Electron 33 cannot open an ordinary window without a display server:",
    "  --ozone-platform=headless hangs inside new BrowserWindow() and its",
    "  DevTools endpoint segfaults. Offscreen rendering would work, but the app",
    "  does not enable it and it cannot be forced from outside the app.",
    "",
    "  Install xvfb (Debian/Ubuntu: apt-get install -y xvfb, Fedora: dnf install",
    "  -y xorg-x11-server-Xvfb) or run this on a desktop session.",
    "",
    "  Nothing about the window was verified. This is not a pass.",
  ]
  if (requireWindow) die(EXIT_NO_DISPLAY, ...explanation)
  for (const line of explanation) console.log(`smoke: ${line}`)
  process.exit(0)
}

// ── Launch ──────────────────────────────────────────────────────────────────

await mkdir(outDir, { recursive: true })
// A throwaway profile: the app takes a single-instance lock keyed on the user
// data directory, so without this a smoke run would silently no-op whenever
// Victor happens to have the real client open.
const profileDir = await mkdtemp(join(tmpdir(), "vv-smoke-"))
const reportPath = join(outDir, "smoke-report.json")
await rm(reportPath, { force: true })

const harness = join(root, "scripts", "smoke-electron-app.mjs")
const electronArgs = [harness, `--user-data-dir=${profileDir}`]
// The chromium sandbox needs unprivileged user namespaces, which several CI
// images deny. Opt in rather than disabling it by default — this app's whole
// design is a hardened renderer, and a smoke test should not be the thing that
// normalises turning that off.
if (process.env.VV_SMOKE_NO_SANDBOX === "1") electronArgs.push("--no-sandbox")

const command = mode === "xvfb" ? "xvfb-run" : electronBinary
const commandArgs =
  mode === "xvfb"
    ? ["-a", "--server-args=-screen 0 1920x1200x24", electronBinary, ...electronArgs]
    : electronArgs

console.log(`smoke: electron ${pkg.devDependencies?.electron ?? "?"} via ${mode === "xvfb" ? "xvfb-run (virtual display)" : `the inherited display (${process.env.WAYLAND_DISPLAY ?? process.env.DISPLAY})`}`)
if (mode === "inherited") console.log("smoke: a real window will appear on screen for a few seconds.")
console.log(`smoke: artifacts -> ${relative(process.cwd(), outDir) || outDir}`)

const environment = { ...process.env, VV_SMOKE_REPORT: reportPath, VV_SMOKE_OUT_DIR: outDir, VV_SMOKE_BUDGET_MS: String(budgetMs) }
// Set, the app loads the dev server instead of the built bundle — and the test
// would report on a Vite process that is not what CI builds.
delete environment.VITE_DEV_SERVER_URL

const child = spawn(command, commandArgs, { cwd: root, env: environment, stdio: ["ignore", "inherit", "inherit"] })

// The harness has its own budget; this one is the backstop for a process that
// wedges before the harness can arm it. Kill by pid — never by pattern.
let timedOut = false
const killTimer = setTimeout(() => {
  timedOut = true
  console.error(`smoke: no result after ${budgetMs + 15_000}ms — killing pid ${child.pid}.`)
  child.kill("SIGKILL")
}, budgetMs + 15_000)

const exitCode = await new Promise((resolveExit) => {
  child.on("error", (error) => {
    console.error(`smoke: could not launch ${command} — ${error.message}`)
    resolveExit(EXIT_SETUP)
  })
  child.on("exit", (code, signal) => resolveExit(signal ? 128 : (code ?? EXIT_FAILED)))
})
clearTimeout(killTimer)
await rm(profileDir, { recursive: true, force: true })

// ── Result ──────────────────────────────────────────────────────────────────

let report = null
try {
  report = JSON.parse(await readFile(reportPath, "utf8"))
} catch {
  // Falls through to the no-report branch below.
}

if (!report) {
  die(
    timedOut ? EXIT_FAILED : EXIT_SETUP,
    timedOut
      ? "the app never produced a result — it hung before finishing its checks."
      : `the app exited ${exitCode} without writing a report; see the output above.`,
  )
}

console.log(
  `smoke: ${report.total - report.failed}/${report.total} checks passed on electron ${report.runtime.electron} / chrome ${report.runtime.chrome}`,
)
for (const artifact of report.artifacts) {
  console.log(`smoke:   ${relative(root, artifact.file)} (${artifact.width}x${artifact.height}, ${artifact.bytes} bytes)`)
}

if (!report.passed || exitCode !== 0) {
  die(EXIT_FAILED, `FAILED — ${report.failed} check(s) failed. Details in ${relative(process.cwd(), reportPath)}.`)
}

console.log(`smoke: PASS — a real ${report.expected.width}x${report.expected.height} window opened and behaved.`)
