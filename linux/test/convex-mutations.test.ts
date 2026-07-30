import { createHash } from "node:crypto"

import { describe, expect, it, vi } from "vitest"
import { encodeConvexInt64 } from "@vogel-vault/domain"

import {
  PAIRED_DEVICE_PATHS,
  createPairedDeviceController,
  validateMutationRequest,
} from "../electron/convexMutations.ts"
import type {
  DeviceCredentialSnapshot,
  DeviceCredentialStore,
} from "../electron/deviceCredentialStore.ts"

const revision = "revision_abcdefghijklmnop"
const snapshot: DeviceCredentialSnapshot = {
  revision,
  deploymentOrigin: "https://household.convex.cloud",
  deviceId: "device_abcdefghijklmnop",
  deviceCredential: "credential_abcdefghijklmnopqrstuvwxyz0123456789",
  pairedAt: 1_774_000_000_000,
  capabilities: ["transaction.upsert", "transaction.delete"],
}

function store(initial: DeviceCredentialSnapshot | null = snapshot): DeviceCredentialStore & {
  current: DeviceCredentialSnapshot | null
} {
  return {
    current: initial,
    readiness: () => "ready",
    async load() {
      return this.current
    },
    async save(input) {
      this.current = { ...input, revision }
      return this.current
    },
    async clearIfCurrent(candidate) {
      if (this.current === null) return true
      if (candidate !== this.current.revision) return false
      this.current = null
      return true
    },
  }
}

function success(value: unknown) {
  return {
    httpStatus: 200,
    body: JSON.stringify({ status: "success", value }),
  }
}

function transactionRequest() {
  return {
    kind: "transaction.upsert" as const,
    requestId: "request_1234",
    actor: "victor" as const,
    id: "tx-1",
    owner: "victor" as const,
    date: "2026-07-30",
    merchant: "Hardware store",
    amountCents: 4_218n,
    transactionKind: "spend" as const,
    category: "Home",
  }
}

describe("paired-device main controller", () => {
  it("validates closed requests, including atomic budget-category renames", () => {
    expect(validateMutationRequest({
      kind: "budgetCategory.upsert",
      requestId: "request_rename",
      actor: "victor",
      month: "2026-07",
      name: "Dining",
      originalName: "Restaurants",
      icon: "utensils",
      budgetCents: 25_000n,
    })).toMatchObject({ originalName: "Restaurants" })

    expect(validateMutationRequest({
      ...transactionRequest(),
      injectedPath: "admin:deleteEverything",
    })).toBeNull()
    expect(validateMutationRequest({
      ...transactionRequest(),
      date: "2026-02-30",
    })).toBeNull()
  })

  it("claims with main-generated credentials, expands grants, and exposes no secret", async () => {
    const localStore = store(null)
    const calls: { endpoint: string; body: string }[] = []
    const random = vi
      .fn()
      .mockReturnValueOnce(Buffer.alloc(14, 1))
      .mockReturnValueOnce(Buffer.alloc(32, 2))
    const controller = createPairedDeviceController({
      store: localStore,
      writesEnabled: () => true,
      random,
      post: async (endpoint, body) => {
        calls.push({ endpoint, body })
        const parsed = JSON.parse(body)
        return success({
          ok: true,
          deviceId: parsed.args.deviceId,
          pairedAt: 1_774_000_000_000,
          capabilities: ["transactions:write", "budget:write"],
        })
      },
    })

    const pairingInput =
      "https://household.convex.cloud/#pair=pair_identifier.secret_identifier"
    const result = await controller.pair({ pairingInput, deviceName: "Fedora desktop" })
    const body = JSON.parse(calls[0]?.body ?? "{}")

    expect(calls[0]?.endpoint).toBe("https://household.convex.cloud/api/mutation")
    expect(body.path).toBe(PAIRED_DEVICE_PATHS.claim)
    expect(body.args.proofHash).toBe(
      createHash("sha256")
        .update("pair_identifier.secret_identifier")
        .digest("hex"),
    )
    expect(body.args.deviceToken).toHaveLength(43)
    expect(localStore.current?.deviceCredential).toBe(body.args.deviceToken)
    expect(result).toEqual({
      status: "paired",
      pairedAt: 1_774_000_000_000,
      capabilities: [
        "transaction.upsert",
        "transaction.delete",
        "budgetCategory.upsert",
        "budgetCategory.delete",
      ],
    })
    expect(JSON.stringify(result)).not.toContain(body.args.deviceToken)
    await expect(controller.status()).resolves.toEqual(result)
  })

  it("preflights protected storage and never claims when unavailable", async () => {
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: { ...store(null), readiness: () => "unsafe-linux-backend" },
      writesEnabled: () => true,
      post,
    })

    await expect(controller.pair({
      pairingInput: "https://household.convex.cloud/#pair=pair_identifier.secret_identifier",
      deviceName: "Fedora desktop",
    })).resolves.toEqual({ status: "failed", code: "credential-storage" })
    expect(post).not.toHaveBeenCalled()
  })

  it("best-effort revokes a claimed device when its response cannot be trusted", async () => {
    const paths: string[] = []
    const controller = createPairedDeviceController({
      store: store(null),
      writesEnabled: () => true,
      random: (bytes) => Buffer.alloc(bytes, 3),
      post: async (_endpoint, body) => {
        const wire = JSON.parse(body)
        paths.push(wire.path)
        if (wire.path === PAIRED_DEVICE_PATHS.claim) {
          return success({
            ok: true,
            deviceId: "different_device_id",
            pairedAt: 1_774_000_000_000,
            capabilities: ["todos:write"],
          })
        }
        return success({ ok: true, revoked: true })
      },
    })

    await expect(controller.pair({
      pairingInput: "https://household.convex.cloud/#pair=pair_identifier.secret_identifier",
      deviceName: "Fedora desktop",
    })).resolves.toEqual({ status: "failed", code: "invalid-response" })
    expect(paths).toEqual([PAIRED_DEVICE_PATHS.claim, PAIRED_DEVICE_PATHS.revoke])
  })

  it("uses only the fixed path, canonical int64, and main-held credential", async () => {
    const calls: { endpoint: string; body: string }[] = []
    const controller = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      post: async (endpoint, body) => {
        calls.push({ endpoint, body })
        return success({ ok: true, entityId: "tx-1", outcome: "updated" })
      },
    })

    const result = await controller.mutate(transactionRequest())
    const wire = JSON.parse(calls[0]?.body ?? "{}")

    expect(wire.path).toBe(PAIRED_DEVICE_PATHS["transaction.upsert"])
    expect(wire.format).toBe("convex_encoded_json")
    expect(wire.args.transaction.amountCents).toEqual(encodeConvexInt64(4_218n))
    expect(wire.args.deviceToken).toBe(snapshot.deviceCredential)
    expect(wire.args.owner).toBe("victor")
    expect(wire.args).not.toHaveProperty("actor")
    expect(result).toEqual({
      status: "ok",
      requestId: "request_1234",
      kind: "transaction.upsert",
      outcome: "updated",
      entityId: "tx-1",
    })
    expect(JSON.stringify(result)).not.toContain(snapshot.deviceCredential)
  })

  it("adapts renderer names to the exact budget and account backend contracts", async () => {
    const localStore = store({
      ...snapshot,
      capabilities: ["budgetCategory.upsert", "btcAccount.upsert"],
    })
    const bodies: Record<string, unknown>[] = []
    const controller = createPairedDeviceController({
      store: localStore,
      writesEnabled: () => true,
      post: async (_endpoint, body) => {
        const wire = JSON.parse(body) as Record<string, unknown>
        bodies.push(wire)
        return success({ ok: true, entityId: "entity", outcome: "updated" })
      },
    })

    await controller.mutate({
      kind: "budgetCategory.upsert",
      requestId: "request_budget",
      actor: "mason",
      month: "2026-07",
      name: "Dining",
      originalName: "Restaurants",
      budgetCents: 20_000n,
    })
    await controller.mutate({
      kind: "btcAccount.upsert",
      requestId: "request_account",
      actor: "mason",
      key: "cold-storage",
      owner: "mason",
      label: "Cold storage",
      custody: "self_custody",
      sats: 2_100n,
      fiatValuation: { cents: 125_000n },
      asOf: "2026-07-30T12:00:00.000Z",
    })

    expect(bodies[0]).toMatchObject({
      path: PAIRED_DEVICE_PATHS["budgetCategory.upsert"],
      args: {
        owner: "mason",
        sourceFile: "mason-budget",
        previousName: "Restaurants",
      },
    })
    expect(bodies[0]).not.toHaveProperty("args.originalName")
    expect(bodies[1]).toMatchObject({
      path: PAIRED_DEVICE_PATHS["btcAccount.upsert"],
      args: {
        owner: "mason",
        sourceFile: "son-balances",
        account: {
          fiatValuation: {
            cents: encodeConvexInt64(125_000n),
          },
        },
      },
    })
    expect(bodies[1]).not.toHaveProperty("args.account.fiatCents")

    await expect(controller.mutate({
      kind: "btcAccount.upsert",
      requestId: "request_no_fiat",
      actor: "mason",
      key: "cold-storage",
      owner: "mason",
      label: "Cold storage",
      custody: "self_custody",
      sats: 2_100n,
      asOf: "2026-07-30T12:00:00.000Z",
    })).resolves.toMatchObject({ status: "ok" })
    expect(bodies[2]).not.toHaveProperty("args.account.fiatValuation")
  })

  it("returns the six closed mutation states and clears only rejected revision", async () => {
    const disabled = createPairedDeviceController({
      store: store(),
      writesEnabled: () => false,
      post: vi.fn(),
    })
    await expect(disabled.mutate(transactionRequest())).resolves.toMatchObject({
      status: "disabled",
    })

    const absent = createPairedDeviceController({
      store: store(null),
      writesEnabled: () => true,
      post: vi.fn(),
    })
    await expect(absent.mutate(transactionRequest())).resolves.toMatchObject({
      status: "not-configured",
    })

    const unauthorizedStore = store()
    const unauthorized = createPairedDeviceController({
      store: unauthorizedStore,
      writesEnabled: () => true,
      post: async () => ({
        httpStatus: 200,
        body: JSON.stringify({ status: "error", errorData: "Unauthorized mobile device" }),
      }),
    })
    await expect(unauthorized.mutate(transactionRequest())).resolves.toMatchObject({
      status: "unauthorized",
    })
    expect(unauthorizedStore.current).toBeNull()

    const missing = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      post: async () => ({
        httpStatus: 200,
        body: JSON.stringify({ status: "error", errorData: "Row not found" }),
      }),
    })
    await expect(missing.mutate(transactionRequest())).resolves.toMatchObject({
      status: "missing",
    })

    const failed = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      post: async () => ({ httpStatus: 200, body: "<not-json>" }),
    })
    await expect(failed.mutate(transactionRequest())).resolves.toMatchObject({
      status: "failed",
      code: "invalid-response",
    })
  })

  it("keeps the credential when remote-first unpair cannot reach the server", async () => {
    const localStore = store()
    const controller = createPairedDeviceController({
      store: localStore,
      writesEnabled: () => true,
      post: async () => {
        throw new Error("offline")
      },
    })

    await expect(controller.unpair()).resolves.toEqual({ status: "failed" })
    expect(localStore.current).toEqual(snapshot)
  })
})
