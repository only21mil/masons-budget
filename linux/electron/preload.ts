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

import { contextBridge } from "electron"

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

contextBridge.exposeInMainWorld("vogelVault", {
  getRuntimeInfo: (): RuntimeInfo => runtimeInfo,
})
