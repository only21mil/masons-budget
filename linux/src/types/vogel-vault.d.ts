// The renderer's view of the preload API. This must stay in sync with
// electron/preload.ts — and it must stay this small.
//
// The two sides cannot share one file: the renderer and the Electron layer are
// separate TypeScript projects (tsconfig.json vs tsconfig.electron.json) with
// different libs, deliberately, so the renderer cannot reach a Node type.
// scripts/qa-preload-boundary.mjs checks that the method names declared here
// match the ones the preload actually exposes.

import type {
  VogelVaultMember,
  VogelVaultMutationRequest,
  VogelVaultMutationResult,
  VogelVaultPairingRequest,
  VogelVaultPairingResult,
  VogelVaultPairingStatus,
  VogelVaultReadProfileResult,
  VogelVaultRowRequest,
  VogelVaultRowResult,
  VogelVaultUnpairResult,
} from "../../shared/ipc.ts"

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
 * crosses this process boundary as a number, because a number is a float and a float is
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

/** One remote data file, metadata only. No financial content crosses in this. */
export interface VogelVaultRemoteDataFile {
  readonly name: string
  readonly version: number
  /** Epoch milliseconds. */
  readonly updatedAt: number
}

/**
 * What the renderer may learn about the remote deployment.
 *
 * Note what is not here: no URL, no host, no credential, no server-authored
 * text. Every `reason` is a sentence the main process wrote. The renderer cannot
 * reach the deployment and cannot be told how to.
 *
 * `disabled` is the shipped default and means no request was made at all — the
 * app renders the sanitized fixtures exactly as it did before this existed.
 * `authenticated` reports whether the read carried a credential, which is the
 * client-side confirmation step 4 of docs/convex-read-auth-cutover.md asks for.
 */
export type VogelVaultRemoteSnapshot =
  | {
      readonly status: "ok"
      /** ISO 8601, when main received the answer. */
      readonly readAt: string
      readonly authenticated: boolean
      readonly files: readonly VogelVaultRemoteDataFile[]
    }
  | { readonly status: "disabled" }
  | { readonly status: "unconfigured"; readonly reason: string }
  | { readonly status: "unauthorized" }
  | { readonly status: "unavailable"; readonly reason: string }

declare global {
  interface Window {
    /** Absent when running outside Electron (plain `vite dev` in a browser). */
    readonly vogelVault?: {
      getRuntimeInfo(): VogelVaultRuntimeInfo
      exportCsv(request: VogelVaultCsvExportRequest): Promise<VogelVaultCsvExportResult>
      /** Takes no argument: there is nothing here for the renderer to choose. */
      getRemoteSnapshot(): Promise<VogelVaultRemoteSnapshot>
      /** Closed row/document request union; main re-validates every field. */
      queryConvexRows(request: VogelVaultRowRequest): Promise<VogelVaultRowResult>
      /** Transition the main-owned finance-read profile under the family switch rules. */
      setReadProfile(profile: VogelVaultMember): Promise<VogelVaultReadProfileResult>
      /** Claim a one-time pairing without exposing the resulting credential. */
      pairDevice(request: VogelVaultPairingRequest): Promise<VogelVaultPairingResult>
      /** Credential-free local pairing state and closed mutation capabilities. */
      getPairingStatus(): Promise<VogelVaultPairingStatus>
      /** Closed domain mutation request; main owns authorization and transport. */
      mutateConvexRow(request: VogelVaultMutationRequest): Promise<VogelVaultMutationResult>
      /** Revoke the current paired device and clear its protected credential. */
      unpairDevice(): Promise<VogelVaultUnpairResult>
    }
  }
}

export {}
