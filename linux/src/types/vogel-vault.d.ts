// The renderer's view of the preload bridge. This must stay in sync with
// electron/preload.ts — and it must stay this small.

export interface VogelVaultRuntimeInfo {
  readonly appName: string
  readonly appVersion: string
  readonly platform: string
  readonly electronVersion: string
  readonly chromeVersion: string
  readonly nodeVersionMajor: string
  readonly isDev: boolean
}

declare global {
  interface Window {
    /** Absent when running outside Electron (plain `vite dev` in a browser). */
    readonly vogelVault?: {
      getRuntimeInfo(): VogelVaultRuntimeInfo
    }
  }
}

export {}
