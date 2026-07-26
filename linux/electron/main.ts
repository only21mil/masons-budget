// The Vogel Vault — Linux client, Electron main process.
//
// HARDENED BOUNDARY — do not loosen any of this without an explicit review.
// The renderer is treated as untrusted: it gets no Node integration, no remote
// module, a sandboxed renderer process, denied permissions, and no ability to
// navigate or spawn windows. The only surface it can reach is the narrow API in
// preload.ts, exposed through contextBridge.
//
// This mirrors the boundary the previous Linux client shipped with (SAT-1572).

import { fileURLToPath } from "node:url"
import path from "node:path"

import { BrowserWindow, app, session, shell } from "electron"

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
    createWindow()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
