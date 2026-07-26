#!/usr/bin/env node
// Boundary guard for the Electron main/preload surface.
//
// The renderer is untrusted. This script fails if the hardened settings are
// weakened or if the preload bridge grows a surface it should not have. It is
// static analysis on purpose — it runs without building or launching the app,
// so it is safe in CI and on a machine with no display.
//
// It also executes electron/csvExport.ts, the one module on the bridge that
// turns renderer input into bytes on disk. That module deliberately imports no
// Electron API so it can be run here directly (Node strips the types), and the
// rules it enforces — strings only, no control characters, no formula, exact
// money text — are worth proving rather than grepping for.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  CSV_LIMITS,
  safeCsvFileName,
  serializeCsv,
  validateCsvRequest,
} from "../electron/csvExport.ts"

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
const channelSource = stripComments(readFileSync(join(root, "electron", "ipcChannels.ts"), "utf8"))
const rendererTypes = stripComments(readFileSync(join(root, "src", "types", "vogel-vault.d.ts"), "utf8"))

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
  [/\brequire\s*\(/, "require() used"],
  [/exposeInMainWorld\([^)]*process\b/, "process exposed"],
  [/\bchild_process\b/, "child_process referenced"],
  [/\bnode:fs\b/, "filesystem access"],
  [/\b(token|secret|apiKey|api_key|password|deployKey)\b/i, "credential-shaped identifier"],
]

for (const [pattern, label] of forbiddenInPreload) {
  require_(!pattern.test(preloadSource), `preload: no ${label}`)
}

// Exactly one bridge. Growing this is a review event.
const exposedKeys = [...preloadSource.matchAll(/exposeInMainWorld\(\s*"([^"]+)"/g)].map((m) => m[1])
require_(
  exposedKeys.length === 1 && exposedKeys[0] === "vogelVault",
  `preload: exposes exactly one bridge named vogelVault (found: ${exposedKeys.join(", ") || "none"})`,
)

/**
 * The exact method list, by name.
 *
 * Reviewed 2026-07-26: getRuntimeInfo (read-only runtime facts) and exportCsv
 * (rows in, a user-chosen file out). Adding a third name here means widening
 * what an untrusted renderer can ask the main process to do, so it is a
 * deliberate edit to this list and nothing less. Never relax it to a count or a
 * wildcard.
 */
const ALLOWED_BRIDGE_METHODS = ["getRuntimeInfo", "exportCsv"]

const bridgeBody = preloadSource.slice(preloadSource.indexOf("exposeInMainWorld"))
const exposedMethods = [...bridgeBody.matchAll(/^\s{2}(\w+)[:,\n]/gm)].map((m) => m[1])
require_(
  exposedMethods.length === ALLOWED_BRIDGE_METHODS.length &&
    ALLOWED_BRIDGE_METHODS.every((name, index) => exposedMethods[index] === name),
  `preload: exposes exactly [${ALLOWED_BRIDGE_METHODS.join(", ")}] (found: ${exposedMethods.join(", ") || "none"})`,
)

// The renderer's declared view of the bridge must name the same methods, or the
// two halves of the boundary drift and the .d.ts stops being a description of
// anything real.
for (const method of ALLOWED_BRIDGE_METHODS) {
  require_(
    new RegExp(`\\b${method}\\s*\\(`).test(rendererTypes),
    `types: src/types/vogel-vault.d.ts declares ${method}`,
  )
}

// ── IPC surface ────────────────────────────────────────────────────────────
//
// ipcRenderer is allowed in the preload's own scope — that is how a bridge
// talks to main at all — but it must never be reachable from the renderer, and
// the renderer must not be able to choose a channel or listen for one.

require_(!/\bipcRenderer\b/.test(bridgeBody), "preload: ipcRenderer is not handed to the renderer")

const ipcMembers = [...preloadSource.matchAll(/\bipcRenderer\.(\w+)/g)].map((m) => m[1])
require_(
  ipcMembers.every((member) => member === "invoke"),
  `preload: only ipcRenderer.invoke is used (found: ${[...new Set(ipcMembers)].join(", ") || "none"})`,
)

// Channels come from the shared constant, so a renderer-supplied string can
// never become the channel name.
const invokedChannels = [...preloadSource.matchAll(/\bipcRenderer\.invoke\(\s*([^,)]+)/g)].map((m) =>
  m[1].trim(),
)
require_(
  invokedChannels.every((channel) => /^[A-Z][A-Z0-9_]*$/.test(channel)),
  `preload: every invoke targets a named channel constant (found: ${invokedChannels.join(", ") || "none"})`,
)

const declaredChannels = [...channelSource.matchAll(/export const (\w+) = "([^"]+)"/g)]
require_(declaredChannels.length === 1, `ipcChannels: declares exactly one channel (found: ${declaredChannels.length})`)

for (const [, name] of declaredChannels) {
  require_(preloadSource.includes(name), `preload: uses the declared channel ${name}`)
  require_(mainSource.includes(name), `main: handles the declared channel ${name}`)
}

// invoke/handle only. ipcMain.on would be a fire-and-forget surface with no
// reply and no natural place to return a refusal.
require_(/\bipcMain\.handle\(/.test(mainSource), "main: registers an ipcMain.handle")
require_(!/\bipcMain\.on\(/.test(mainSource), "main: no fire-and-forget ipcMain.on listener")

const handledChannels = [...mainSource.matchAll(/\bipcMain\.handle\(\s*([^,)]+)/g)].map((m) => m[1].trim())
require_(
  handledChannels.length === declaredChannels.length &&
    handledChannels.every((channel) => /^[A-Z][A-Z0-9_]*$/.test(channel)),
  `main: handles only declared channel constants (found: ${handledChannels.join(", ") || "none"})`,
)

// ── File writes ────────────────────────────────────────────────────────────
//
// The renderer may say what goes in a file. It may never say where the file
// goes: the destination comes from a native save dialog, and the only path
// handed to writeFile is the one that dialog returned.

require_(/\bdialog\.showSaveDialog\(/.test(mainSource), "main: the export destination comes from a save dialog")
require_(/\bsafeCsvFileName\(/.test(mainSource), "main: the suggested file name is sanitised")
require_(/\bvalidateCsvRequest\(/.test(mainSource), "main: the renderer payload is re-validated in main")
require_(/\bisTrustedSender\(/.test(mainSource), "main: IPC senders are checked")

const writeTargets = [...mainSource.matchAll(/\bwriteFile\(\s*([^,)]+)/g)].map((m) => m[1].trim())
require_(
  writeTargets.length > 0 && writeTargets.every((target) => target === "choice.filePath"),
  `main: writes only to the path the save dialog returned (found: ${writeTargets.join(", ") || "none"})`,
)

// ── The bytes that reach disk ──────────────────────────────────────────────
//
// Executed, not grepped. These are the rules that stop a renderer payload from
// becoming a formula, a second record, or a rounded amount.

const CRLF = "\r\n"

require_(
  serializeCsv(["a", "b"], [["1", "2"]]) === `a,b${CRLF}1,2${CRLF}`,
  "csv: rows are CRLF-terminated, including the last",
)

require_(
  serializeCsv(["merchant"], [['Fish "Co", Ltd']]) === `merchant${CRLF}"Fish ""Co"", Ltd"${CRLF}`,
  "csv: commas and quotes are escaped RFC 4180 style",
)

// A merchant name is attacker-controlled the moment a real bank feed is wired
// in; a spreadsheet would run it.
require_(
  serializeCsv(["m"], [["=SUM(A1:A9)"]]) === `m${CRLF}"'=SUM(A1:A9)"${CRLF}`,
  "csv: a formula-shaped cell is neutralised",
)

// ...but a negative amount must survive as a number, or the money column stops
// being summable in the tool people export CSV for.
require_(
  serializeCsv(["amount_usd"], [["-142.18"]]) === `amount_usd${CRLF}-142.18${CRLF}`,
  "csv: a negative decimal is written as a number, not text",
)

require_(
  validateCsvRequest({ suggestedFileName: "a.csv", columns: ["amount"], rows: [["1.00"]] }).ok,
  "csv: a well-formed string payload is accepted",
)

// The float trap: money is integer minor units, formatted to text by the
// renderer. A number arriving here means that discipline broke upstream.
require_(
  !validateCsvRequest({ suggestedFileName: "a.csv", columns: ["amount"], rows: [[1.005]] }).ok,
  "csv: a numeric cell is rejected",
)

require_(
  !validateCsvRequest({ suggestedFileName: "a.csv", columns: ["a", "b"], rows: [["1"]] }).ok,
  "csv: a short row is rejected",
)

require_(
  !validateCsvRequest({ suggestedFileName: "a.csv", columns: ["a"], rows: [["one\r\ntwo"]] }).ok,
  "csv: a cell containing a line break is rejected",
)

require_(
  !validateCsvRequest({
    suggestedFileName: "a.csv",
    columns: ["a"],
    rows: [["x".repeat(CSV_LIMITS.maxCellLength + 1)]],
  }).ok,
  "csv: an oversized cell is rejected",
)

require_(
  !validateCsvRequest({ suggestedFileName: "a.csv", columns: [], rows: [] }).ok,
  "csv: a payload with no columns is rejected",
)

// A header-only file is a legitimate export: zero rows is an answer.
require_(
  validateCsvRequest({ suggestedFileName: "a.csv", columns: ["a"], rows: [] }).ok,
  "csv: an empty row set is accepted",
)

const fileNameCases = [
  ["../../../etc/shadow", "shadow.csv"],
  ["..\\..\\windows\\system32\\evil.csv", "evil.csv"],
  ["/home/someone/.ssh/id", "id.csv"],
  ["", "vogel-vault-export.csv"],
  ["vogel-vault-transactions-victor-2026-07-26.csv", "vogel-vault-transactions-victor-2026-07-26.csv"],
]

for (const [input, expected] of fileNameCases) {
  const actual = safeCsvFileName(input)
  require_(actual === expected, `csv: ${JSON.stringify(input)} sanitises to ${expected} (got ${actual})`)
}

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`preload-boundary: FAIL — ${failures.length} of ${checks.length} checks failed\n`)
  for (const failure of failures) console.error(`  x ${failure}`)
  process.exit(1)
}

console.log(`preload-boundary: PASS — ${checks.length} checks`)
