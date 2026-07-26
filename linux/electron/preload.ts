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

import { contextBridge, ipcRenderer } from "electron"

import { CSV_EXPORT_CHANNEL } from "./ipcChannels.ts"
import type { CsvExportRequest, CsvExportResult } from "./csvExport.ts"

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

contextBridge.exposeInMainWorld("vogelVault", {
  getRuntimeInfo: (): RuntimeInfo => runtimeInfo,
  exportCsv,
})
