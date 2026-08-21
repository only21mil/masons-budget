import { expect, test } from "vitest"

import type {
  PairingRequest,
  PairingResult,
  PairingStatus,
  RendererMutationKind,
  RendererMutationRequest,
  RendererMutationResult,
  UnpairResult,
} from "../src/renderer/data/mutations.ts"
import type {
  VogelVaultMutationKind,
  VogelVaultMutationRequest,
  VogelVaultMutationResult,
  VogelVaultPairingRequest,
  VogelVaultPairingResult,
  VogelVaultPairingStatus,
  VogelVaultUnpairResult,
} from "../shared/ipc.ts"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
      (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false

type Assert<T extends true> = T

const exactContractParity: readonly true[] = [
  true as Assert<Equal<RendererMutationKind, VogelVaultMutationKind>>,
  true as Assert<Equal<RendererMutationRequest, VogelVaultMutationRequest>>,
  true as Assert<Equal<RendererMutationResult, VogelVaultMutationResult>>,
  true as Assert<Equal<PairingRequest, VogelVaultPairingRequest>>,
  true as Assert<Equal<PairingResult, VogelVaultPairingResult>>,
  true as Assert<Equal<PairingStatus, VogelVaultPairingStatus>>,
  true as Assert<Equal<UnpairResult, VogelVaultUnpairResult>>,
]

test("renderer mutation and pairing types are exact aliases of the shared IPC contract", () => {
  expect(exactContractParity).toEqual([true, true, true, true, true, true, true])
})
