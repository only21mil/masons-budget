// The Vogel Vault — Linux client, Electron main process.
//
// HARDENED BOUNDARY — do not loosen any of this without an explicit review.
// The renderer is treated as untrusted: it gets no Node integration, no remote
// module, a sandboxed renderer process, denied permissions, and no ability to
// navigate or spawn windows. The only surface it can reach is the narrow API in
// preload.ts, exposed through contextBridge.
//
// This mirrors the boundary the previous Linux client shipped with (SAT-1572).

import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { BrowserWindow, app, dialog, ipcMain, safeStorage, session, shell } from "electron"
import type { IpcMainInvokeEvent } from "electron"

import {
  type CsvExportResult,
  safeCsvFileName,
  serializeCsv,
  validateCsvRequest,
} from "./csvExport.ts"
import {
  type JsonPostResponse,
  type RemoteSnapshotResult,
  REMOTE_READ_LIMITS,
  createRemoteReadConfigurationProvider,
  createRemoteReader,
} from "./convexRead.ts"
import { createConvexRowRepository } from "./convexRows.ts"
import { createPairedDeviceController } from "./convexMutations.ts"
import { createDeviceCredentialStore } from "./deviceCredentialStore.ts"
import {
  CONVEX_MUTATION_CHANNEL,
  CONVEX_READ_CHANNEL,
  CONVEX_ROWS_CHANNEL,
  CSV_EXPORT_CHANNEL,
  DEVICE_PAIR_CHANNEL,
  DEVICE_PAIRING_STATUS_CHANNEL,
  DEVICE_UNPAIR_CHANNEL,
} from "./ipcChannels.ts"
import type {
  VogelVaultMutationResult,
  VogelVaultPairingResult,
  VogelVaultPairingStatus,
  VogelVaultRowResult,
  VogelVaultUnpairResult,
} from "../shared/ipc.ts"

const dirname = path.dirname(fileURLToPath(import.meta.url))

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(dirname, "../dist")

/** Origins the renderer is permitted to live on. Everything else is blocked. */
function isAllowedRendererUrl(target: string): boolean {
  if (DEV_SERVER_URL && target.startsWith(DEV_SERVER_URL)) return true
  if (target.startsWith("file://")) {
    const resolved = path.resolve(fileURLToPath(target))
    return resolved.startsWith(path.resolve(RENDERER_DIST))
  }
  return false
}

/**
 * Only http(s) links are handed to the user's browser. Anything else — file://,
 * javascript:, custom schemes — is dropped rather than passed to xdg-open.
 */
function isSafeExternalUrl(target: string): boolean {
  try {
    const { protocol } = new URL(target)
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

function hardenSession(): void {
  const defaultSession = session.defaultSession

  // Deny every permission request. This app needs none of them: no camera, no
  // microphone, no geolocation, no notifications, no clipboard reads.
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  defaultSession.setPermissionCheckHandler(() => false)

  // No renderer-initiated network access. All data reaches the renderer through
  // the main process, so any outbound request from the renderer is unexpected.
  defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details
    if (url.startsWith("devtools:") || url.startsWith("blob:") || url.startsWith("data:")) {
      callback({ cancel: false })
      return
    }
    callback({ cancel: !isAllowedRendererUrl(url) })
  })
}

/**
 * Only the app's own top-level frame may call into main.
 *
 * `will-navigate` and the window-open handler already keep the renderer on the
 * app shell, but an IPC handler is reachable from any frame that exists, so it
 * checks for itself rather than inheriting someone else's guarantee.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  return isAllowedRendererUrl(frame.url)
}

/**
 * CSV export. The renderer owns *what* is in the file; the main process owns
 * *where* it goes and *what bytes* are written.
 *
 * The renderer never supplies a path. It supplies rows and a suggested name;
 * the name is reduced to a bare, allowlisted file name and offered as the
 * default in a native save dialog, so the destination is always something the
 * user picked. The payload is re-validated here even though the renderer built
 * it — a compromised renderer is exactly the case this boundary exists for.
 */
let exportInFlight = false

function registerCsvExport(): void {
  ipcMain.handle(CSV_EXPORT_CHANNEL, async (event, payload: unknown): Promise<CsvExportResult> => {
    if (!isTrustedSender(event)) return { status: "rejected", reason: "Export came from an unrecognised frame." }

    // One dialog at a time. The renderer disables its own button while a write
    // runs, but main must not depend on the renderer behaving: a loop of
    // invokes would otherwise stack modal dialogs on the user's window.
    if (exportInFlight) return { status: "rejected", reason: "An export is already in progress." }

    const validation = validateCsvRequest(payload)
    if (!validation.ok) return { status: "rejected", reason: validation.reason }

    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return { status: "rejected", reason: "There is no window to attach a save dialog to." }

    exportInFlight = true
    try {
      const choice = await dialog.showSaveDialog(window, {
        title: "Export CSV",
        defaultPath: safeCsvFileName(validation.request.suggestedFileName),
        filters: [{ name: "CSV", extensions: ["csv"] }],
        // dontAddToRecent: an export is named after a family member and a data
        // set; it does not belong in a shared recent-documents list.
        properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"],
      })
      if (choice.canceled || !choice.filePath) return { status: "cancelled" }

      const body = serializeCsv(validation.request.columns, validation.request.rows)
      // 0600: household financial records, readable by this user only. The mode
      // applies on create; an existing file keeps whatever the user set.
      await writeFile(choice.filePath, body, { encoding: "utf8", mode: 0o600 })

      // Only the base name goes back. The renderer has no business learning the
      // directory layout of the machine it is running on.
      return {
        status: "written",
        fileName: path.basename(choice.filePath),
        rowCount: validation.request.rows.length,
      }
    } catch (error) {
      // The reason goes to the main-process log, not to the renderer: an fs
      // error message carries the absolute path the user just chose.
      console.error("csv export failed", error)
      return { status: "rejected", reason: "The file could not be written." }
    } finally {
      exportInFlight = false
    }
  })
}

// Convex reads. MAIN PROCESS ONLY, and switched off unless this machine's
// environment says otherwise — see electron/convexRead.ts for the settings and
// docs/convex-read-auth-cutover.md for why it ships off.
//
// Why the fetch is here and not in the renderer: `hardenSession` cancels every
// request the renderer's session makes, on purpose, and the renderer must never
// hold the deployment URL or the read credential in the first place. Node's
// global fetch does not run through Electron's session, so this call is
// unaffected by that block — which is exactly the asymmetry the boundary wants.

const REMOTE_READ_TIMEOUT_MS = 10_000

async function postJsonToDeployment(
  endpoint: string,
  requestBody: string,
  maxResponseBytes: number = REMOTE_READ_LIMITS.maxResponseBytes,
): Promise<JsonPostResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
    // A redirect would hand the read credential to whatever host the response
    // named. There is no legitimate redirect on a Convex query endpoint.
    redirect: "error",
    signal: AbortSignal.timeout(REMOTE_READ_TIMEOUT_MS),
  })

  const { text, truncated } = await readCappedText(response, maxResponseBytes)
  return { httpStatus: response.status, body: text, truncated }
}

/**
 * Read at most `maxBytes` and stop.
 *
 * A metadata listing is a few kilobytes. Buffering an unbounded body from a
 * misconfigured or hostile endpoint into the process that owns the window is not
 * something to leave to the endpoint's good manners.
 */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const stream = response.body
  if (!stream) return { text: "", truncated: false }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ""

  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > maxBytes) {
        await reader.cancel()
        return { text, truncated: true }
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }

  return { text: text + decoder.decode(), truncated: false }
}

const remoteReadConfiguration = createRemoteReadConfigurationProvider(() => process.env)

function registerRemoteSnapshot(): void {
  // Configuration is resolved per call, so disabling reads or rotating the
  // credential takes effect without a restart.
  const reader = createRemoteReader({
    settings: () => remoteReadConfiguration().settings,
    post: postJsonToDeployment,
  })

  ipcMain.handle(CONVEX_READ_CHANNEL, async (event): Promise<RemoteSnapshotResult> => {
    if (!isTrustedSender(event)) {
      return { status: "unavailable", reason: "The request came from an unrecognised frame." }
    }
    return reader.snapshot()
  })
}

function registerConvexRows(): void {
  const repository = createConvexRowRepository({
    configuration: remoteReadConfiguration,
    post: postJsonToDeployment,
  })

  ipcMain.handle(
    CONVEX_ROWS_CHANNEL,
    async (event, request: unknown): Promise<VogelVaultRowResult> => {
      if (!isTrustedSender(event)) return { status: "error", code: "invalid-request" }
      return repository.query(request)
    },
  )
}

function pairedDeviceWritesEnabled(): boolean {
  const value = process.env.VOGEL_VAULT_DEVICE_WRITES?.trim().toLowerCase()
  return value === undefined || value === "1" || value === "true"
}

/**
 * Paired-device writes. The controller is created only after Electron is ready:
 * safeStorage is not valid before that point, and its credential never leaves
 * the main process.
 */
function registerPairedDeviceWrites(): void {
  const store = createDeviceCredentialStore({
    appReady: () => app.isReady(),
    platform: process.platform,
    safeStorage,
    userDataPath: app.getPath("userData"),
  })
  const controller = createPairedDeviceController({
    store,
    post: postJsonToDeployment,
    writesEnabled: pairedDeviceWritesEnabled,
  })

  ipcMain.handle(
    DEVICE_PAIR_CHANNEL,
    async (event, request: unknown): Promise<VogelVaultPairingResult> => {
      if (!isTrustedSender(event)) return { status: "failed", code: "invalid-input" }
      return controller.pair(request)
    },
  )
  ipcMain.handle(
    DEVICE_PAIRING_STATUS_CHANNEL,
    async (event): Promise<VogelVaultPairingStatus> => {
      if (!isTrustedSender(event)) return { status: "unavailable" }
      return controller.status()
    },
  )
  ipcMain.handle(
    CONVEX_MUTATION_CHANNEL,
    async (event, request: unknown): Promise<VogelVaultMutationResult> => {
      if (!isTrustedSender(event)) {
        return {
          status: "failed",
          requestId: "invalid-request",
          kind: "transaction.upsert",
          code: "invalid-request",
        }
      }
      return controller.mutate(request)
    },
  )
  ipcMain.handle(
    DEVICE_UNPAIR_CHANNEL,
    async (event): Promise<VogelVaultUnpairResult> => {
      if (!isTrustedSender(event)) return { status: "unavailable" }
      return controller.unpair()
    },
  )
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: "#050505",
    autoHideMenuBar: true,
    title: "The Vogel Vault",
    webPreferences: {
      // .cjs, not .mjs — a sandboxed preload must be CommonJS.
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  })

  // A dark first paint — never flash white into a true-black UI.
  window.once("ready-to-show", () => window.show())

  // Block navigation away from the app shell entirely.
  window.webContents.on("will-navigate", (event, target) => {
    if (!isAllowedRendererUrl(target)) event.preventDefault()
  })

  // No popups. External links open in the user's real browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  // A renderer that tries to attach a webview is misbehaving; strip it.
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault()
  })

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL)
  } else {
    void window.loadFile(path.join(RENDERER_DIST, "index.html"))
  }

  return window
}

// Single instance — a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  void app.whenReady().then(() => {
    hardenSession()
    // Registered before the first window so no renderer can invoke a channel
    // that is not yet handled.
    registerCsvExport()
    registerRemoteSnapshot()
    registerConvexRows()
    registerPairedDeviceWrites()
    createWindow()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
