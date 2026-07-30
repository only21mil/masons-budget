#!/usr/bin/env node
// Boundary guard for the Electron main/preload surface.
//
// The renderer is untrusted. This script fails if the hardened settings are
// weakened or if the preload bridge grows a surface it should not have. It is
// static analysis on purpose — it runs without building or launching the app,
// so it is safe in CI and on a machine with no display.
//
// It also executes the three modules on the bridge that do something a grep cannot
// prove. They deliberately import no Electron API so they can be run here
// directly (Node strips the types), with no display, no build and no deployment:
//
//   - electron/csvExport.ts turns renderer input into bytes on disk. The rules —
//     strings only, no control characters, no formula, exact money text — are
//     worth proving rather than grepping for.
//   - electron/convexRead.ts holds the deployment URL and the read credential.
//     "Off by default", "the credential never reaches a log", and "server text
//     never reaches the renderer" are claims, and claims get executed here.
//   - electron/convexRows.ts validates the closed request union and projects only
//     public row DTOs, with canonical int64 decoding and local-only failures.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { inspect } from "node:util"

import {
  CSV_LIMITS,
  safeCsvFileName,
  serializeCsv,
  validateCsvRequest,
} from "../electron/csvExport.ts"
import {
  REMOTE_READ_LIMITS,
  createRemoteReader,
  parseSnapshotEnvelope,
  resolveRemoteReadSettings,
} from "../electron/convexRead.ts"
import {
  createConvexRowRepository,
  decodeConvexInt64,
  validateRowRequest,
} from "../electron/convexRows.ts"

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
const convexReadSource = stripComments(readFileSync(join(root, "electron", "convexRead.ts"), "utf8"))
const convexRowsSource = stripComments(readFileSync(join(root, "electron", "convexRows.ts"), "utf8"))
const convexMutationsSource = stripComments(
  readFileSync(join(root, "electron", "convexMutations.ts"), "utf8"),
)
const credentialStoreSource = stripComments(
  readFileSync(join(root, "electron", "deviceCredentialStore.ts"), "utf8"),
)
const sharedIpcSource = stripComments(readFileSync(join(root, "shared", "ipc.ts"), "utf8"))
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
 * (rows in, a user-chosen file out). Adding a name here means widening what an
 * untrusted renderer can ask the main process to do, so it is a deliberate edit
 * to this list and nothing less. Never relax it to a count or a wildcard.
 *
 * Reviewed addition, 2026-07-26 — getRemoteSnapshot. It takes no argument and
 * returns file metadata plus a status; the deployment URL and read credential
 * stay in the main process, and with the feature off (the default) no request is
 * made at all. The executed section at the bottom of this file is where that
 * claim is checked rather than asserted.
 */
const ALLOWED_BRIDGE_METHODS = [
  "getRuntimeInfo",
  "exportCsv",
  "getRemoteSnapshot",
  "queryConvexRows",
  "pairDevice",
  "getPairingStatus",
  "mutateConvexRow",
  "unpairDevice",
]

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

/**
 * The exact channel list, by name and order.
 *
 * This replaces an earlier "exactly one channel" count. Naming them is stricter,
 * not looser: a count would have let a second channel appear the moment anyone
 * bumped the number, whereas a rename or an unreviewed addition fails here.
 * Same rule as ALLOWED_BRIDGE_METHODS — edit it deliberately or not at all.
 *
 * Reviewed 2026-07-26: CSV_EXPORT_CHANNEL (rows in, a user-chosen file out) and
 * CONVEX_READ_CHANNEL (no argument in, file metadata out).
 */
const ALLOWED_CHANNEL_CONSTANTS = [
  "CSV_EXPORT_CHANNEL",
  "CONVEX_READ_CHANNEL",
  "CONVEX_ROWS_CHANNEL",
  "DEVICE_PAIR_CHANNEL",
  "DEVICE_PAIRING_STATUS_CHANNEL",
  "CONVEX_MUTATION_CHANNEL",
  "DEVICE_UNPAIR_CHANNEL",
]

const declaredChannels = [...channelSource.matchAll(/export const (\w+) = "([^"]+)"/g)]
const declaredChannelNames = declaredChannels.map(([, name]) => name)
require_(
  declaredChannelNames.length === ALLOWED_CHANNEL_CONSTANTS.length &&
    ALLOWED_CHANNEL_CONSTANTS.every((name, index) => declaredChannelNames[index] === name),
  `ipcChannels: declares exactly [${ALLOWED_CHANNEL_CONSTANTS.join(", ")}] (found: ${declaredChannelNames.join(", ") || "none"})`,
)

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

// Every handler checks its own sender. Counted rather than eyeballed: a new
// handler that forgets the check is the failure this is here to catch.
const senderChecks = [...mainSource.matchAll(/\bisTrustedSender\(event\)/g)].length
require_(
  senderChecks === handledChannels.length,
  `main: every handler checks its sender (${senderChecks} checks for ${handledChannels.length} handlers)`,
)

// ── The network side ───────────────────────────────────────────────────────
//
// The renderer is network-free by construction: hardenSession cancels every
// request its session makes. The Convex read therefore lives in main, and the
// renderer must not be able to learn where it goes or what it sends.

require_(!/\bfetch\s*\(/.test(preloadSource), "preload: does not reach the network")
require_(!/https?:\/\//.test(preloadSource), "preload: contains no URL")
require_(!/https?:\/\//.test(rendererTypes), "types: the renderer's view contains no URL")

// The credential and the deployment are configuration, never source. A literal
// URL here would be a deployment baked into the shipped bundle — the same
// mistake that left production readable to anyone who read this repo.
require_(!/https?:\/\//.test(convexReadSource), "convexRead: no deployment URL is hard-coded")
require_(
  !/\b(?:const|let|var)\s+\w*(?:token|secret|password)\w*\s*=\s*["'`]/i.test(convexReadSource),
  "convexRead: no credential is hard-coded",
)
require_(!/https?:\/\//.test(convexRowsSource), "convexRows: no deployment URL is hard-coded")

for (const [pattern, label] of [
  [/\btoken\b/i, "credential field"],
  [/\b(?:url|endpoint)\b/i, "network location field"],
  [/\b(?:path|filePath)\b/, "arbitrary path field"],
  [/\b(?:rawBody|responseBody|serverText)\b/, "remote body or text field"],
  [/\b(?:_id|_creationTime|migrationRaw|migrationSourceIndex)\b/, "private Convex or migration field"],
]) {
  require_(!pattern.test(sharedIpcSource), `shared IPC: no ${label}`)
  require_(!pattern.test(rendererTypes), `types: no ${label}`)
}

// A redirect would hand the read credential to whatever host the response named.
require_(/redirect:\s*"error"/.test(mainSource), "main: the deployment request refuses redirects")
require_(/AbortSignal\.timeout\(/.test(mainSource), "main: the deployment request is time-bounded")

// Paired-device credentials must stay in main and safeStorage must be usable
// before a pairing can be claimed. Linux's plaintext fallback is explicitly
// refused rather than silently weakening the store.
require_(mainSource.includes("safeStorage"), "main: paired credentials use Electron safeStorage")
require_(mainSource.includes("app.isReady()"), "main: safeStorage is guarded by Electron readiness")
require_(
  /app\.whenReady\(\)\.then\([\s\S]*registerPairedDeviceWrites\(\)/.test(mainSource) &&
    /function registerPairedDeviceWrites\(\)[\s\S]*app\.getPath\("userData"\)/.test(mainSource),
  "main: credential storage is registered only after Electron is ready",
)
require_(
  credentialStoreSource.includes('"basic_text"') &&
    credentialStoreSource.includes('"unknown"'),
  "credential store: unsafe Linux encryption backends are refused",
)
require_(
  credentialStoreSource.includes('open(temporaryPath, "wx", 0o600)') &&
    credentialStoreSource.includes("rename(temporaryPath, storePath)") &&
    credentialStoreSource.includes("chmod(directory, 0o700)"),
  "credential store: private atomic file replacement is preserved",
)
require_(
  !/https?:\/\//.test(convexMutationsSource),
  "convexMutations: no deployment URL is hard-coded",
)
require_(
  convexMutationsSource.includes('"convex_encoded_json"') &&
    convexMutationsSource.includes("/api/mutation"),
  "convexMutations: requests use the fixed Convex mutation endpoint and encoding",
)
require_(
  convexMutationsSource.includes("clearIfCurrent(snapshot.revision)"),
  "convexMutations: rejected credentials are cleared revision-safely",
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

// ── The Convex read path ───────────────────────────────────────────────────
//
// Executed, not grepped. Four claims are made about this feature, and each one
// is the kind that is true right up until someone edits the file:
//
//   1. it is off unless the machine's environment turns it on,
//   2. off means no request, not a request that is thrown away,
//   3. the credential goes on the wire and nowhere else — not into a log line,
//   4. nothing the deployment says reaches the renderer verbatim.

/** Obviously fake. A real credential must never appear in a file in this repo. */
const SAMPLE_CREDENTIAL = "not-a-real-read-credential-0000"
const SAMPLE_DEPLOYMENT = "https://example.invalid"

const enabledEnv = {
  VOGEL_VAULT_REMOTE_READ: "1",
  VOGEL_VAULT_CONVEX_URL: `${SAMPLE_DEPLOYMENT}/`,
  VOGEL_VAULT_CONVEX_READ_TOKEN: SAMPLE_CREDENTIAL,
}

// Claim 1 — off by default, and off for anything that is not an explicit yes.
for (const [value, label] of [
  [undefined, "unset"],
  ["", "empty"],
  ["0", '"0"'],
  ["false", '"false"'],
  ["yes", '"yes"'],
]) {
  const settings = resolveRemoteReadSettings({ ...enabledEnv, VOGEL_VAULT_REMOTE_READ: value })
  require_(
    settings.readiness === "disabled" && settings.endpoint === null && !settings.hasCredential,
    `convex: the switch is off when it is ${label}`,
  )
}

require_(
  resolveRemoteReadSettings({ ...enabledEnv, VOGEL_VAULT_CONVEX_URL: undefined }).readiness ===
    "unconfigured",
  "convex: enabled with no deployment is unconfigured",
)

// Cleartext would put the credential and the family's finances on the wire in
// the open. Refused, never downgraded.
require_(
  resolveRemoteReadSettings({ ...enabledEnv, VOGEL_VAULT_CONVEX_URL: "http://example.invalid" })
    .readiness === "insecure-endpoint",
  "convex: an http deployment is refused",
)

require_(
  resolveRemoteReadSettings({ ...enabledEnv, VOGEL_VAULT_CONVEX_READ_TOKEN: undefined })
    .readiness === "ready-unauthenticated",
  "convex: enabled without a credential is reported distinctly",
)

const readySettings = resolveRemoteReadSettings(enabledEnv)
require_(readySettings.readiness === "ready", "convex: a fully configured environment is ready")
require_(
  readySettings.endpoint === `${SAMPLE_DEPLOYMENT}/api/query`,
  `convex: the endpoint is the deployment's query path (got ${readySettings.endpoint})`,
)

// Claim 3 — the credential is unreachable through the ordinary accidents. These
// three are what console.log, a crash report and a JSON dump actually call.
const rendered = `${JSON.stringify(readySettings)} ${String(readySettings)} ${inspect(readySettings)}`
require_(!rendered.includes(SAMPLE_CREDENTIAL), "convex: the credential survives no logging path")
require_(rendered.includes("present"), "convex: presence is reported instead")

/** A reader over a poster that records what it was asked to send. */
function spyReader(env, respond) {
  const calls = []
  const reader = createRemoteReader({
    settings: () => resolveRemoteReadSettings(env),
    post: async (endpoint, requestBody) => {
      calls.push({ endpoint, requestBody })
      return respond(requestBody)
    },
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  })
  return { reader, calls }
}

const okListing = () => ({
  httpStatus: 200,
  body: JSON.stringify({
    status: "success",
    value: [{ name: "transactions.json", version: 7, updatedAt: 1_769_000_000_000 }],
  }),
})

// Claim 2 — off means no socket. Asserted on the transport, not on the answer.
const offRun = spyReader({}, okListing)
const offResult = await offRun.reader.snapshot()
require_(offResult.status === "disabled", `convex: a switched-off read answers disabled (got ${offResult.status})`)
require_(offRun.calls.length === 0, `convex: a switched-off read opens no socket (${offRun.calls.length} requests)`)

const insecureRun = spyReader({ ...enabledEnv, VOGEL_VAULT_CONVEX_URL: "http://example.invalid" }, okListing)
const insecureResult = await insecureRun.reader.snapshot()
require_(insecureResult.status === "unconfigured", "convex: an http deployment is never contacted")
require_(insecureRun.calls.length === 0, "convex: an http deployment opens no socket")

const authedRun = spyReader(enabledEnv, okListing)
const authedResult = await authedRun.reader.snapshot()
const authedRequest = JSON.parse(authedRun.calls[0]?.requestBody ?? "{}")
require_(
  authedRequest.path === "dataFiles:list" && authedRequest.format === "convex_encoded_json",
  `convex: the query is the metadata listing (got ${authedRequest.path})`,
)
require_(
  authedRequest.args?.token === SAMPLE_CREDENTIAL,
  "convex: the credential is attached to the request",
)
require_(
  authedResult.status === "ok" && authedResult.authenticated === true,
  "convex: a successful authenticated read reports itself as authenticated",
)
require_(
  authedResult.status === "ok" &&
    authedResult.files.length === 1 &&
    authedResult.files[0]?.name === "transactions.json",
  "convex: the listing becomes file metadata",
)

// Omitted, not blanked. While ALLOW_TOKENLESS_READ is set the server accepts
// this; the moment the hatch goes it fails closed, which is the signal the
// cutover needs every client to produce identically.
const anonRun = spyReader({ ...enabledEnv, VOGEL_VAULT_CONVEX_READ_TOKEN: undefined }, okListing)
const anonResult = await anonRun.reader.snapshot()
const anonRequest = JSON.parse(anonRun.calls[0]?.requestBody ?? "{}")
require_(
  !("token" in (anonRequest.args ?? {})),
  "convex: an absent credential is omitted rather than sent empty",
)
require_(
  anonResult.status === "ok" && anonResult.authenticated === false,
  "convex: an unauthenticated read says so",
)

// Concurrent invokes must not become concurrent requests. The renderer is
// untrusted and a loop of calls is not a reason to hammer the family's data.
const burstRun = spyReader(enabledEnv, () => new Promise((resolve) => setTimeout(() => resolve(okListing()), 5)))
await Promise.all([burstRun.reader.snapshot(), burstRun.reader.snapshot(), burstRun.reader.snapshot()])
require_(burstRun.calls.length === 1, `convex: concurrent reads coalesce (${burstRun.calls.length} requests)`)

// Coalescing does nothing about a renderer that awaits each call before making
// the next, so there is a floor between requests as well.
const pacedCalls = []
let fakeClockMs = 0
const pacedReader = createRemoteReader({
  settings: () => resolveRemoteReadSettings(enabledEnv),
  post: async () => {
    pacedCalls.push(1)
    return okListing()
  },
  now: () => new Date(fakeClockMs),
})
await pacedReader.snapshot()
await pacedReader.snapshot()
await pacedReader.snapshot()
require_(pacedCalls.length === 1, `convex: sequential reads are paced (${pacedCalls.length} requests)`)

fakeClockMs = REMOTE_READ_LIMITS.minIntervalMs
await pacedReader.snapshot()
require_(pacedCalls.length === 2, "convex: the pacing floor expires rather than caching forever")

// A transport that throws must not leak the thrown text — a fetch error message
// carries the URL, and a proxy can put anything after it.
const throwingRun = spyReader(enabledEnv, () => {
  throw new Error(`connect ECONNREFUSED ${SAMPLE_DEPLOYMENT} ${SAMPLE_CREDENTIAL}`)
})
const throwingResult = await throwingRun.reader.snapshot()
require_(
  throwingResult.status === "unavailable" && !JSON.stringify(throwingResult).includes(SAMPLE_CREDENTIAL),
  "convex: a transport failure reports a written reason, not the thrown text",
)

// Claim 4 — envelope classification, matched to scripts/verify-read-auth.sh so
// the app and the runbook cannot disagree about what the deployment just said.
const readAt = "2026-07-26T12:00:00.000Z"
const envelope = (body, httpStatus = 200, truncated = false) =>
  parseSnapshotEnvelope({ httpStatus, body, truncated }, readAt, true)

require_(
  envelope(
    JSON.stringify({
      status: "error",
      errorMessage: "[Request ID: test] Server Error",
      errorData: "Unauthorized: invalid read token",
    }),
  ).status === "unauthorized",
  "convex: a rejected credential is unauthorized, not a generic failure",
)

require_(
  envelope(
    JSON.stringify({
      status: "error",
      errorMessage: "[Request ID: test] Server Error",
      errorData: "Unauthorized: CONVEX_READ_TOKEN is not configured (fail-closed).",
    }),
  ).status === "unauthorized",
  "convex: the fail-closed rejection is also unauthorized",
)

// Trap 2 in the runbook: before the gated code is deployed, a `token` argument
// is an ArgumentValidationError and production answers with a bare Server Error.
require_(
  envelope("Server Error", 500).status === "unavailable",
  "convex: a non-200 is unavailable, not unauthorized",
)

require_(envelope("<html>nope</html>").status === "unavailable", "convex: a non-JSON answer is unavailable")
require_(
  envelope(JSON.stringify({ status: "success", value: { not: "a list" } })).status === "unavailable",
  "convex: a listing that is not a list is unavailable",
)
require_(
  envelope(JSON.stringify({ status: "success", value: [] }), 200, true).status === "unavailable",
  "convex: a truncated answer is unavailable",
)

// Server text is never propagated: a response body from this deployment is the
// household's financial data, and a reason ends up on screen and in a log.
const leaky = envelope(
  JSON.stringify({ status: "error", errorMessage: "balance for victor is 4242.18 at Chase" }),
)
require_(
  leaky.status === "unavailable" && !JSON.stringify(leaky).includes("4242.18"),
  "convex: server text never reaches the renderer",
)

// Financial content is not in the read model at all — only the three metadata
// fields. Anything else the deployment adds is dropped on the floor.
const extraFields = envelope(
  JSON.stringify({
    status: "success",
    value: [{ name: "budget.json", version: 3, updatedAt: 1, data: { balanceCents: 424_218 } }],
  }),
)
require_(
  extraFields.status === "ok" && !JSON.stringify(extraFields).includes("424218"),
  "convex: only name, version and updatedAt survive the read model",
)

const malformedRows = envelope(
  JSON.stringify({
    status: "success",
    value: [
      { name: "good.json", version: 1, updatedAt: 2 },
      { name: "good.json", version: 9, updatedAt: 9 },
      { name: "", version: 1, updatedAt: 2 },
      { name: "no-version.json", updatedAt: 2 },
      "not-an-object",
    ],
  }),
)
require_(
  malformedRows.status === "ok" && malformedRows.files.length === 1,
  `convex: duplicate and malformed entries are dropped (kept ${malformedRows.status === "ok" ? malformedRows.files.length : "n/a"})`,
)

const oversizedListing = envelope(
  JSON.stringify({
    status: "success",
    value: Array.from({ length: REMOTE_READ_LIMITS.maxFiles + 25 }, (_, index) => ({
      name: `file-${index}.json`,
      version: 1,
      updatedAt: 2,
    })),
  }),
)
require_(
  oversizedListing.status === "ok" && oversizedListing.files.length === REMOTE_READ_LIMITS.maxFiles,
  "convex: an oversized listing is capped",
)

// ── Convex row repository ──────────────────────────────────────────────────

for (const [encoded, expected] of [
  ["AAAAAAAAAIA=", -(1n << 63n)],
  ["//////////8=", -1n],
  ["AAAAAAAAAAA=", 0n],
  ["AQAAAAAAAAA=", 1n],
  ["AAEAAAAAAAA=", 256n],
  ["/////////38=", (1n << 63n) - 1n],
]) {
  require_(decodeConvexInt64({ $integer: encoded }) === expected, `rows: decodes canonical int64 ${expected}`)
}

for (const malformed of [
  { $integer: "AQAAAAAAAAA" },
  { $integer: "AQAAAAAAAAA_" },
  { $integer: "AQAAAAAAAAA=", extra: true },
  { $integer: "AQAAAAA=" },
]) {
  let rejected = false
  try {
    decodeConvexInt64(malformed)
  } catch {
    rejected = true
  }
  require_(rejected, `rows: rejects malformed int64 ${JSON.stringify(malformed)}`)
}

require_(
  validateRowRequest({ kind: "rowCounts" })?.kind === "rowCounts" &&
    validateRowRequest({ kind: "rowCounts", viewer: "victor" }) === null,
  "rows: rowCounts is metadata-only and accepts no renderer-selected scope",
)
require_(
  validateRowRequest({ kind: "transactions", viewer: "victor" })?.kind === "transactions",
  "rows: accepts a full transaction request with no limit",
)
require_(
  validateRowRequest({ kind: "btcAccounts", viewer: "victor" }) === null &&
    validateRowRequest({ kind: "btcBillPays", viewer: "victor" }) === null &&
    validateRowRequest({ kind: "budget", viewer: "victor" }) === null &&
    validateRowRequest({ kind: "budget", viewer: "victor", scope: "netWorth" })?.kind === "budget",
  "rows: BTC and budget scopes are explicit",
)
require_(
  validateRowRequest({ kind: "transactions", viewer: "victor", path: "dataFiles:get" }) === null,
  "rows: rejects an extra request field",
)
require_(
  validateRowRequest({ kind: "transactions", viewer: "Mason" }) === null,
  "rows: rejects a viewer outside the closed family union",
)

const rowResponses = []
let rowGeneration = 1
const rowRepository = createConvexRowRepository({
  configuration: () => ({ generation: rowGeneration, settings: readySettings }),
  post: async (_endpoint, requestBody) => {
    rowResponses.push(JSON.parse(requestBody))
    return {
      httpStatus: 200,
      body: JSON.stringify({
        status: "success",
        value: {
          complete: true,
          rows: [
            {
              txId: "test-1",
              owner: "victor",
              date: "2026-07-26",
              month: "2026-07",
              merchant: "Test merchant",
              amountCents: { $integer: "AQAAAAAAAAA=" },
              spendAmount: { $integer: "AQAAAAAAAAA=" },
              displaySpendAmount: { $integer: "AQAAAAAAAAA=" },
              hasOppositeSpendSign: false,
              category: "Other",
              updatedAtMs: 1,
            },
          ],
        },
      }),
    }
  },
  now: () => 1,
})

const rowResult = await rowRepository.query({ kind: "transactions", viewer: "victor" })
require_(
  rowResult.status === "ok" &&
    rowResult.kind === "transactions" &&
    rowResult.rows[0]?.amountCents === 1n &&
    rowResult.rows[0]?.spendAmount === 1n &&
    rowResult.rows[0]?.displaySpendAmount === 1n &&
    rowResult.rows[0]?.hasOppositeSpendSign === false,
  "rows: a strict public transaction DTO crosses with bigint money",
)
require_(
  rowResult.status === "ok" && !JSON.stringify(rowResult, (_key, value) => typeof value === "bigint" ? value.toString() : value).includes(SAMPLE_CREDENTIAL),
  "rows: configuration never reaches a result",
)
require_(
  rowResponses[0]?.path === "tables:listTransactions" && rowResponses[0]?.args?.token === SAMPLE_CREDENTIAL,
  "rows: a fixed path carries the credential only on the wire",
)

let tokenlessCalls = 0
const tokenlessRows = createConvexRowRepository({
  configuration: () => ({
    generation: 1,
    settings: resolveRemoteReadSettings({
      VOGEL_VAULT_REMOTE_READ: "1",
      VOGEL_VAULT_CONVEX_URL: "https://example.invalid",
    }),
  }),
  post: async () => {
    tokenlessCalls += 1
    return { httpStatus: 200, body: "{}" }
  },
})
const tokenlessResult = await tokenlessRows.query({ kind: "rowCounts" })
require_(
  tokenlessResult.status === "error" &&
    tokenlessResult.code === "unauthorized" &&
    tokenlessCalls === 0,
  "rows: missing read credentials classify as auth without opening a socket",
)

await rowRepository.query({ kind: "transactions", viewer: "victor" })
require_(rowResponses.length === 1, "rows: an identical request is cached within one config generation")
rowGeneration = 2
await rowRepository.query({ kind: "transactions", viewer: "victor" })
require_(rowResponses.length === 2, "rows: a new config generation cannot reuse the old cache")

const rowFailure = async (value, request = { kind: "transactions", viewer: "victor" }) => {
  const repository = createConvexRowRepository({
    configuration: () => ({ generation: 1, settings: readySettings }),
    post: async () => ({
      httpStatus: 200,
      body: JSON.stringify({ status: "success", value }),
    }),
  })
  return repository.query(request)
}

require_(
  (await rowFailure({ complete: false, rows: [] })).status === "error" &&
    (await rowFailure({ complete: false, rows: [] })).code === "incomplete-response",
  "rows: a full request fails closed when the server says it is incomplete",
)
const extensibleRowResult = await rowFailure({
  complete: true,
  rows: [{
    txId: "private-1", owner: "victor", date: "2026-07-26", month: "2026-07",
    merchant: "Nope", amountCents: { $integer: "AAAAAAAAAAA=" },
    spendAmount: { $integer: "AAAAAAAAAAA=" },
    displaySpendAmount: { $integer: "AAAAAAAAAAA=" },
    hasOppositeSpendSign: false, category: "Other",
    updatedAtMs: 1, migrationRaw: { secret: true },
  }],
  futureEnvelopeField: true,
})
require_(
  extensibleRowResult.status === "ok" &&
    extensibleRowResult.kind === "transactions" &&
    !Object.hasOwn(extensibleRowResult, "futureEnvelopeField") &&
    !Object.hasOwn(extensibleRowResult.rows[0] ?? {}, "migrationRaw"),
  "rows: unknown server fields are ignored and never cross the public DTO",
)
require_(
  (await rowFailure({
    complete: true,
    rows: [{
      txId: "hidden-1", owner: "victor", date: "2026-07-26", month: "2026-07",
      merchant: "Nope", amountCents: { $integer: "AAAAAAAAAAA=" },
      spendAmount: { $integer: "AAAAAAAAAAA=" },
      displaySpendAmount: { $integer: "AAAAAAAAAAA=" },
      hasOppositeSpendSign: false, category: "Other",
      updatedAtMs: 1,
    }],
  }, { kind: "transactions", viewer: "mason" })).status === "error",
  "rows: main asserts row visibility instead of trusting the server",
)

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`preload-boundary: FAIL — ${failures.length} of ${checks.length} checks failed\n`)
  for (const failure of failures) console.error(`  x ${failure}`)
  process.exit(1)
}

console.log(`preload-boundary: PASS — ${checks.length} checks`)
