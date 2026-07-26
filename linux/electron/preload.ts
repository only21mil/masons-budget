// The Vogel Vault — Linux client, preload bridge.
//
// This is the ENTIRE surface the renderer can reach. Everything here is
// serialisable, read-only, and free of credentials.
//
// Runs sandboxed, so it is bundled to CommonJS and may only touch the small
// subset of APIs Electron grants a sandboxed preload.
//
// Rules, carried forward from the previous client's boundary review:
//   - Never expose the IPC surface, require, process, or any Node primitive.
//   - Never expose a Convex deployment credential or any other secret. The
//     renderer must not be able to read one even indirectly.
//   - Every addition here needs a boundary review; scripts/qa-preload-boundary.mjs
//     fails the build if this file grows a forbidden pattern.
//
// Reviewed addition, 2026-07-26 — CSV export. `ipcRenderer` is used here but is
// NOT handed to the renderer: the bridge exposes a named function that invokes
// one hard-coded channel and returns a plain object. The renderer cannot pick a
// channel, cannot listen, and cannot send. Everything it can influence is the
// serialisable payload, which the main process re-validates before it writes.

// Reviewed addition, 2026-07-26 — remote snapshot. Nothing about the deployment
// crosses this file: no URL, no credential, no argument the renderer chooses.
// The renderer asks "what does the deployment say there is?" and gets back a
// status plus file metadata, assembled in main. With the feature switched off —
// its default — the answer is `{ status: "disabled" }` and no socket is opened.

import { contextBridge, ipcRenderer } from "electron"

import { CONVEX_READ_CHANNEL, CSV_EXPORT_CHANNEL } from "./ipcChannels.ts"
import type { CsvExportRequest, CsvExportResult } from "./csvExport.ts"
import type { RemoteSnapshotResult } from "./convexRead.ts"

declare const __APP_VERSION__: string

export interface RuntimeInfo {
  readonly appName: string
  readonly appVersion: string
  readonly platform: string
  readonly electronVersion: string
  readonly chromeVersion: string
  /** Major only — the full version is fingerprintable detail the UI never needs. */
  readonly nodeVersionMajor: string
  readonly isDev: boolean
}

const versions = process.versions

const runtimeInfo: RuntimeInfo = {
  appName: "The Vogel Vault",
  appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.1.0",
  platform: process.platform,
  electronVersion: versions.electron ?? "unknown",
  chromeVersion: versions.chrome ?? "unknown",
  nodeVersionMajor: (versions.node ?? "unknown").split(".")[0] ?? "unknown",
  isDev: !("resourcesPath" in process) || String(process.resourcesPath).includes("node_modules"),
}

/**
 * Ask the main process to write a CSV.
 *
 * The renderer sends rows and a suggested file NAME. It never sends a path: the
 * destination comes from the OS save dialog the main process opens, so the only
 * writes that can happen are ones the user picked in a native dialog.
 */
function exportCsv(request: CsvExportRequest): Promise<CsvExportResult> {
  return ipcRenderer.invoke(CSV_EXPORT_CHANNEL, request) as Promise<CsvExportResult>
}

/**
 * Ask the main process what the deployment currently holds.
 *
 * Takes no argument, deliberately. There is nothing for the renderer to choose:
 * it cannot name a query, cannot name a host, and cannot supply anything that
 * ends up on the wire. What comes back is metadata — file names, versions,
 * timestamps — and a status, never financial content and never a secret.
 */
function getRemoteSnapshot(): Promise<RemoteSnapshotResult> {
  return ipcRenderer.invoke(CONVEX_READ_CHANNEL) as Promise<RemoteSnapshotResult>
}

contextBridge.exposeInMainWorld("vogelVault", {
  getRuntimeInfo: (): RuntimeInfo => runtimeInfo,
  exportCsv,
  getRemoteSnapshot,
})
