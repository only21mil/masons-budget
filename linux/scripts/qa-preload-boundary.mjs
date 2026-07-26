#!/usr/bin/env node
// Boundary guard for the Electron main/preload surface.
//
// The renderer is untrusted. This script fails if the hardened settings are
// weakened or if the preload bridge grows a surface it should not have. It is
// static analysis on purpose — it runs without building or launching the app,
// so it is safe in CI and on a machine with no display.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Strip comments before scanning. The boundary files document what they refuse
 * to expose ("never expose ipcRenderer", "no Convex token"), so scanning raw
 * text would flag the documentation itself. Only executable code is analysed.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

const mainSource = stripComments(readFileSync(join(root, "electron", "main.ts"), "utf8"))
const preloadSource = stripComments(readFileSync(join(root, "electron", "preload.ts"), "utf8"))

const failures = []
const checks = []

function require_(condition, label) {
  checks.push(label)
  if (!condition) failures.push(label)
}

// ── Required hardening in the main process ─────────────────────────────────
const requiredMainSettings = [
  ["contextIsolation: true", "contextIsolation is enabled"],
  ["nodeIntegration: false", "nodeIntegration is disabled"],
  ["nodeIntegrationInWorker: false", "nodeIntegration is disabled in workers"],
  ["nodeIntegrationInSubFrames: false", "nodeIntegration is disabled in subframes"],
  ["sandbox: true", "renderer sandbox is enabled"],
  ["webviewTag: false", "webview tag is disabled"],
  ["allowRunningInsecureContent: false", "insecure content is blocked"],
  ["setPermissionRequestHandler", "permission requests are handled"],
  ["setPermissionCheckHandler", "permission checks are handled"],
  ["setWindowOpenHandler", "window.open is intercepted"],
  ["will-navigate", "navigation is intercepted"],
  ["will-attach-webview", "webview attachment is intercepted"],
]

for (const [needle, label] of requiredMainSettings) {
  require_(mainSource.includes(needle), `main: ${label}`)
}

// The window-open handler must deny. Anything else lets the renderer spawn UI.
require_(/return\s*\{\s*action:\s*"deny"\s*\}/.test(mainSource), "main: window open handler denies")

// ── Forbidden patterns anywhere in the boundary ────────────────────────────
const forbidden = [
  [/\bnodeIntegration:\s*true/, "nodeIntegration enabled"],
  [/\bcontextIsolation:\s*false/, "contextIsolation disabled"],
  [/\bsandbox:\s*false/, "sandbox disabled"],
  [/\bwebSecurity:\s*false/, "webSecurity disabled"],
  [/\benableRemoteModule\b/, "remote module referenced"],
  [/@electron\/remote/, "@electron/remote imported"],
]

for (const [pattern, label] of forbidden) {
  require_(!pattern.test(mainSource), `main: no ${label}`)
  require_(!pattern.test(preloadSource), `preload: no ${label}`)
}

// ── Preload surface ────────────────────────────────────────────────────────
require_(preloadSource.includes("contextBridge.exposeInMainWorld"), "preload: uses contextBridge")

const forbiddenInPreload = [
  [/\bipcRenderer\b/, "ipcRenderer exposed"],
  [/\brequire\s*\(/, "require() used"],
  [/exposeInMainWorld\([^)]*process\b/, "process exposed"],
  [/\bchild_process\b/, "child_process referenced"],
  [/\bnode:fs\b/, "filesystem access"],
  [/\b(token|secret|apiKey|api_key|password|deployKey)\b/i, "credential-shaped identifier"],
]

for (const [pattern, label] of forbiddenInPreload) {
  require_(!pattern.test(preloadSource), `preload: no ${label}`)
}

// Exactly one bridge, exactly one method on it. Growing this is a review event.
const exposedKeys = [...preloadSource.matchAll(/exposeInMainWorld\(\s*"([^"]+)"/g)].map((m) => m[1])
require_(
  exposedKeys.length === 1 && exposedKeys[0] === "vogelVault",
  `preload: exposes exactly one bridge named vogelVault (found: ${exposedKeys.join(", ") || "none"})`,
)

const bridgeBody = preloadSource.slice(preloadSource.indexOf("exposeInMainWorld"))
const exposedMethods = [...bridgeBody.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])
require_(
  exposedMethods.length === 1 && exposedMethods[0] === "getRuntimeInfo",
  `preload: exposes only getRuntimeInfo (found: ${exposedMethods.join(", ") || "none"})`,
)

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`preload-boundary: FAIL — ${failures.length} of ${checks.length} checks failed\n`)
  for (const failure of failures) console.error(`  x ${failure}`)
  process.exit(1)
}

console.log(`preload-boundary: PASS — ${checks.length} checks`)
