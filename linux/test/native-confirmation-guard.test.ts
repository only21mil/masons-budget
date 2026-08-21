import { describe, expect, it, vi } from "vitest"

import { createNativeConfirmationGuard } from "../electron/nativeConfirmationGuard.ts"
import type {
  VogelVaultPairingResult,
  VogelVaultUnpairResult,
} from "../shared/ipc.ts"

describe("native confirmation guard", () => {
  it("fails a concurrent pair or unpair closed without starting another operation", async () => {
    const guard = createNativeConfirmationGuard()
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstOperation = vi.fn(async (): Promise<VogelVaultPairingResult> => {
      await firstGate
      return { status: "paired", pairedAt: 1, capabilities: [] }
    })
    const concurrentOperation = vi.fn(
      async (): Promise<VogelVaultUnpairResult> => ({ status: "ok", revoked: true }),
    )

    const first = guard.run<VogelVaultPairingResult>(
      { status: "failed", code: "cancelled" },
      firstOperation,
    )
    await expect(
      guard.run<VogelVaultUnpairResult>(
        { status: "cancelled" },
        concurrentOperation,
      ),
    ).resolves.toEqual({ status: "cancelled" })
    expect(concurrentOperation).not.toHaveBeenCalled()

    releaseFirst?.()
    await expect(first).resolves.toEqual({
      status: "paired",
      pairedAt: 1,
      capabilities: [],
    })
  })

  it("releases after success so a later confirmation can run", async () => {
    const guard = createNativeConfirmationGuard()
    const operation = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second")

    await expect(guard.run("busy", operation)).resolves.toBe("first")
    await expect(guard.run("busy", operation)).resolves.toBe("second")
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it("releases in finally after an operation rejects", async () => {
    const guard = createNativeConfirmationGuard()
    const failure = new Error("dialog failed")

    await expect(
      guard.run("busy", async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    await expect(
      guard.run("busy", async () => "recovered"),
    ).resolves.toBe("recovered")
  })
})
