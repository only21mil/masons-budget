// The renderer's view of the preload bridge. This must stay in sync with
// electron/preload.ts — and it must stay this small.
//
// The two sides cannot share one file: the renderer and the Electron layer are
// separate TypeScript projects (tsconfig.json vs tsconfig.electron.json) with
// different libs, deliberately, so the renderer cannot reach a Node type.
// scripts/qa-preload-boundary.mjs checks that the method names declared here
// match the ones the preload actually exposes.

export interface VogelVaultRuntimeInfo {
  readonly appName: string
  readonly appVersion: string
  readonly platform: string
  readonly electronVersion: string
  readonly chromeVersion: string
  readonly nodeVersionMajor: string
  readonly isDev: boolean
}

/**
 * A CSV export request. Cells are strings, always.
 *
 * Money is integer minor units everywhere in this app (bigint cents, bigint
 * sats), formatted to exact decimal text before it goes into a cell. It never
 * crosses this bridge as a number, because a number is a float and a float is
 * not money. The main process rejects a non-string cell.
 */
export interface VogelVaultCsvExportRequest {
  /** A file name, never a path. The main process sanitises it regardless. */
  readonly suggestedFileName: string
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

export type VogelVaultCsvExportResult =
  | { readonly status: "written"; readonly fileName: string; readonly rowCount: number }
  | { readonly status: "cancelled" }
  | { readonly status: "rejected"; readonly reason: string }

declare global {
  interface Window {
    /** Absent when running outside Electron (plain `vite dev` in a browser). */
    readonly vogelVault?: {
      getRuntimeInfo(): VogelVaultRuntimeInfo
      exportCsv(request: VogelVaultCsvExportRequest): Promise<VogelVaultCsvExportResult>
    }
  }
}

export {}
