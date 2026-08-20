import { createHash } from "node:crypto"

import { describe, expect, it, vi } from "vitest"
import { encodeConvexInt64 } from "@vogel-vault/domain"

import {
  PAIRED_DEVICE_PATHS,
  createPairedDeviceController,
  resolveApprovedDeploymentOrigin,
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

function failure(code: string, extra: Record<string, unknown> = {}) {
  return {
    httpStatus: 200,
    body: JSON.stringify({
      status: "error",
      errorData: { code, message: "redacted", ...extra },
    }),
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
  it("pins trusted routing to the one approved production origin", () => {
    expect(resolveApprovedDeploymentOrigin(
      "https://keen-elephant-452.convex.cloud/",
    )).toBe("https://keen-elephant-452.convex.cloud")
    expect(resolveApprovedDeploymentOrigin(
      "  https://keen-elephant-452.convex.cloud/  ",
    )).toBe("https://keen-elephant-452.convex.cloud")
    expect(resolveApprovedDeploymentOrigin(
      "https://other.convex.cloud/",
    )).toBeNull()
    expect(resolveApprovedDeploymentOrigin(
      "https://keen-elephant-452.convex.cloud.attacker.test/",
    )).toBeNull()
    expect(resolveApprovedDeploymentOrigin(
      "https://keen-elephant-452.convex.cloud/path",
    )).toBeNull()
  })

  it("enables pairing for an unpaired device with the local switch and an approved origin", async () => {
    const controller = createPairedDeviceController({
      store: store(null),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: vi.fn(),
    })

    await expect(controller.status()).resolves.toEqual({
      status: "unpaired",
      writesEnabled: true,
    })
  })

  it("keeps pairing disabled for an unpaired device when the local switch is off", async () => {
    const controller = createPairedDeviceController({
      store: store(null),
      writesEnabled: () => false,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: vi.fn(),
    })

    await expect(controller.status()).resolves.toEqual({
      status: "unpaired",
      writesEnabled: false,
    })
  })

  it("keeps pairing disabled for an unpaired device without an approved origin", async () => {
    const controller = createPairedDeviceController({
      store: store(null),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => null,
      post: vi.fn(),
    })

    await expect(controller.status()).resolves.toEqual({
      status: "unpaired",
      writesEnabled: false,
    })
  })

  it("disables paired-device grants when the stored origin no longer matches", async () => {
    const controller = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => "https://replacement.convex.cloud",
      post: vi.fn(),
    })

    await expect(controller.status()).resolves.toEqual({
      status: "paired",
      pairedAt: snapshot.pairedAt,
      capabilities: [],
      writesEnabled: false,
    })
  })

  it("carries an existing coarse Bitcoin write grant into the new transfer vocabulary", async () => {
    const post = vi.fn(async () =>
      success({ ok: true, entityId: "legacy-transfer", outcome: "inserted" })
    )
    const controller = createPairedDeviceController({
      store: store({
        ...snapshot,
        capabilities: [
          "btcBuy.upsert",
          "btcBuy.delete",
          "btcBillPay.upsert",
          "btcBillPay.delete",
          "btcAccount.upsert",
          "btcAccount.delete",
        ],
      }),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post,
    })

    await expect(controller.status()).resolves.toMatchObject({
      status: "paired",
      capabilities: expect.arrayContaining([
        "btcTransfer.upsert",
        "btcTransfer.delete",
      ]),
    })
    await expect(controller.mutate({
      kind: "btcTransfer.upsert",
      requestId: "request_legacy_transfer",
      actor: "victor",
      id: "legacy-transfer",
      owner: "victor",
      date: "2026-08-01",
      fromAccountKey: "river",
      toAccountKey: "coldcard",
      sats: 100_000n,
      feeSats: 250n,
    }, "victor")).resolves.toMatchObject({
      status: "ok",
      kind: "btcTransfer.upsert",
      entityId: "legacy-transfer",
    })
    expect(post).toHaveBeenCalledOnce()
  })

  it("does not infer transfer access from a partial legacy Bitcoin grant", async () => {
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: store({
        ...snapshot,
        capabilities: ["btcBuy.upsert", "btcAccount.upsert"],
      }),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post,
    })

    await expect(controller.mutate({
      kind: "btcTransfer.upsert",
      requestId: "request_partial_legacy_transfer",
      actor: "victor",
      id: "partial-legacy-transfer",
      owner: "victor",
      date: "2026-08-01",
      fromAccountKey: "river",
      toAccountKey: "coldcard",
      sats: 1n,
      feeSats: 0n,
    }, "victor")).resolves.toMatchObject({ status: "unauthorized" })
    expect(post).not.toHaveBeenCalled()
  })

  it("validates closed requests, including atomic budget-category renames", () => {
    expect(validateMutationRequest({
      kind: "budgetCategory.upsert",
      requestId: "request_rename",
      actor: "victor",
      owner: "victor",
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
    expect(validateMutationRequest({
      ...transactionRequest(),
      merchant: "  Hardware store  ",
      category: " Home ",
    })).toMatchObject({
      merchant: "  Hardware store  ",
      category: " Home ",
    })
  })

  it("requires a closed bill-pay budgetEffect and pins the credit-card category", () => {
    const billPay = {
      kind: "btcBillPay.upsert" as const,
      requestId: "request_bill_effect",
      actor: "victor" as const,
      id: "bill-01",
      owner: "victor" as const,
      date: "2026-08-01",
      merchant: "Internet Provider",
      category: "Utilities",
      budgetEffect: "budget_category" as const,
      amountUsdCents: 7_999n,
      btcSpentSats: 85_000n,
      btcPriceCents: 9_410_000n,
      feeUsdCents: 40n,
    }

    expect(validateMutationRequest(billPay)).toMatchObject({
      category: "Utilities",
      budgetEffect: "budget_category",
    })
    expect(validateMutationRequest({
      ...billPay,
      category: "Credit Card Payment",
      budgetEffect: "credit_card_payment",
    })).toMatchObject({
      category: "Credit Card Payment",
      budgetEffect: "credit_card_payment",
    })

    // Absent, misspelled, or open-ended values all fail closed.
    const withoutEffect: Record<string, unknown> = { ...billPay }
    delete withoutEffect["budgetEffect"]
    expect(validateMutationRequest(withoutEffect)).toBeNull()
    expect(validateMutationRequest({ ...billPay, budgetEffect: "budget" })).toBeNull()
    expect(validateMutationRequest({ ...billPay, budgetEffect: "" })).toBeNull()
    expect(validateMutationRequest({ ...billPay, budgetEffect: null })).toBeNull()

    // A credit-card payment carrying any other category is unclassifiable.
    expect(validateMutationRequest({
      ...billPay,
      budgetEffect: "credit_card_payment",
      category: "Utilities",
    })).toBeNull()
  })

  it("sends the bill-pay budgetEffect to the device upsert endpoint", async () => {
    const bodies: Record<string, unknown>[] = []
    const controller = createPairedDeviceController({
      store: store({ ...snapshot, capabilities: ["btcBillPay.upsert"] }),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, body) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>)
        return success({ ok: true, entityId: "bill-01", outcome: "inserted" })
      },
    })

    await expect(controller.mutate({
      kind: "btcBillPay.upsert",
      requestId: "request_bill_wire",
      actor: "victor",
      id: "bill-01",
      owner: "victor",
      date: "2026-08-01",
      merchant: "Internet Provider",
      category: "Utilities",
      budgetEffect: "budget_category",
      amountUsdCents: 7_999n,
      btcSpentSats: 85_000n,
      btcPriceCents: 9_410_000n,
      feeUsdCents: 40n,
    }, "victor")).resolves.toMatchObject({ status: "ok" })

    const wire = bodies[0] as { path: string; args: { billPay: Record<string, unknown> } }
    expect(wire.path).toBe(PAIRED_DEVICE_PATHS["btcBillPay.upsert"])
    expect(wire.args.billPay.budgetEffect).toBe("budget_category")
    expect(wire.args.billPay.category).toBe("Utilities")
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
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
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

    const pairingInput = "pair_identifier.secret_identifier"
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
    await expect(controller.status()).resolves.toEqual({
      ...result,
      writesEnabled: true,
    })
  })

  it("preflights protected storage and never claims when unavailable", async () => {
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: { ...store(null), readiness: () => "unsafe-linux-backend" },
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post,
    })

    await expect(controller.pair({
      pairingInput: "pair_identifier.secret_identifier",
      deviceName: "Fedora desktop",
    })).resolves.toEqual({ status: "failed", code: "credential-storage" })
    expect(post).not.toHaveBeenCalled()
  })

  it("accepts secret-only pairing codes and preserves an explicit empty grant", async () => {
    const localStore = store(null)
    const post = vi.fn(async (_endpoint: string, body: string) => {
      const wire = JSON.parse(body)
      return success({
        ok: true,
        deviceId: wire.args.deviceId,
        pairedAt: 1_774_000_000_000,
        capabilities: [],
      })
    })
    const controller = createPairedDeviceController({
      store: localStore,
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post,
    })

    await expect(controller.pair({
      pairingInput: "pair_identifier.secret_identifier",
      deviceName: "Fedora desktop",
    })).resolves.toEqual({
      status: "paired",
      pairedAt: 1_774_000_000_000,
      capabilities: [],
    })
    await expect(controller.status()).resolves.toEqual({
      status: "paired",
      pairedAt: 1_774_000_000_000,
      capabilities: [],
      writesEnabled: true,
    })

    const invalidController = createPairedDeviceController({
      store: store(null),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: vi.fn(),
    })
    await expect(invalidController.pair({
      pairingInput:
        "https://keen-elephant-452.convex.cloud/#pair=pair_identifier.secret_identifier",
      deviceName: "Fedora desktop",
    })).resolves.toEqual({ status: "failed", code: "invalid-input" })
  })

  it("best-effort revokes a claimed device when its response cannot be trusted", async () => {
    const paths: string[] = []
    const controller = createPairedDeviceController({
      store: store(null),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
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
      pairingInput: "pair_identifier.secret_identifier",
      deviceName: "Fedora desktop",
    })).resolves.toEqual({ status: "failed", code: "invalid-response" })
    expect(paths).toEqual([PAIRED_DEVICE_PATHS.claim, PAIRED_DEVICE_PATHS.revoke])
  })

  // Before this binding the payload's own `actor` was the only claim of
  // identity the main process had. A renderer operating as Mason could write
  // Victor's ledger — including Bitcoin balance legs — by declaring
  // `actor: "victor"`. The session, not the message, decides who is writing.
  it("refuses a mutation whose declared actor is not the window's session", async () => {
    const calls: string[] = []
    const controller = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (endpoint) => {
        calls.push(endpoint)
        return success({ ok: true, entityId: "tx-1", outcome: "updated" })
      },
    })

    const result = await controller.mutate(transactionRequest(), "mason")

    expect(result).toEqual({
      status: "unauthorized",
      requestId: "request_1234",
      kind: "transaction.upsert",
    })
    // The refusal must happen before anything reaches the deployment.
    expect(calls).toEqual([])
  })

  it("still writes when the declared actor matches the session", async () => {
    const bodies: Record<string, unknown>[] = []
    const controller = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, body) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>)
        return success({ ok: true, entityId: "tx-1", outcome: "updated" })
      },
    })

    const result = await controller.mutate(
      { ...transactionRequest(), actor: "mason", owner: "mason" },
      "mason",
    )

    expect(result.status).toBe("ok")
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      path: PAIRED_DEVICE_PATHS["transaction.upsert"],
    })
  })

  // A genuine actor is not automatically an allowed one. The session check
  // above proves who is writing; these prove what they may write: a child may
  // touch only their own effective ledger, while adults manage any of them.
  it("refuses a child session writing another member's ledger", async () => {
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post,
    })

    const result = await controller.mutate(
      { ...transactionRequest(), actor: "mason", owner: "victor" },
      "mason",
    )

    expect(result).toMatchObject({ status: "unauthorized" })
    expect(post).not.toHaveBeenCalled()
  })

  it("refuses a child session whose write canonicalizes onto the household ledger", async () => {
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post,
    })

    // Rachel finance canonicalizes to the household ledger owner (victor), so
    // a Mason session declaring owner=rachel is a cross-owner write in effect.
    const result = await controller.mutate(
      { ...transactionRequest(), actor: "mason", owner: "rachel" },
      "mason",
    )

    expect(result).toMatchObject({ status: "unauthorized" })
    expect(post).not.toHaveBeenCalled()
  })

  it("still lets a child write their own ledger", async () => {
    const localStore = store({
      ...snapshot,
      capabilities: ["budgetCategory.upsert"],
    })
    const bodies: Record<string, unknown>[] = []
    const controller = createPairedDeviceController({
      store: localStore,
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, body) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>)
        return success({ ok: true, entityId: "Dining", outcome: "updated" })
      },
    })

    const result = await controller.mutate({
      kind: "budgetCategory.upsert",
      requestId: "request_child_own",
      actor: "mason",
      owner: "mason",
      month: "2026-07",
      name: "Dining",
      budgetCents: 20_000n,
    }, "mason")

    expect(result.status).toBe("ok")
    expect(bodies[0]).toMatchObject({ args: { owner: "mason" } })
  })

  it("still lets an adult session manage a child's ledger", async () => {
    const localStore = store({
      ...snapshot,
      capabilities: ["budgetCategory.upsert"],
    })
    const bodies: Record<string, unknown>[] = []
    const controller = createPairedDeviceController({
      store: localStore,
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, body) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>)
        return success({ ok: true, entityId: "Dining", outcome: "updated" })
      },
    })

    const result = await controller.mutate({
      kind: "budgetCategory.upsert",
      requestId: "request_adult_child",
      actor: "victor",
      owner: "mason",
      month: "2026-07",
      name: "Dining",
      budgetCents: 20_000n,
    }, "victor")

    expect(result.status).toBe("ok")
    expect(bodies[0]).toMatchObject({ args: { owner: "mason" } })
  })

  it("uses only the fixed path, canonical int64, and main-held credential", async () => {
    const calls: { endpoint: string; body: string }[] = []
    const controller = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (endpoint, body) => {
        calls.push({ endpoint, body })
        return success({ ok: true, entityId: "tx-1", outcome: "updated" })
      },
    })

    const result = await controller.mutate(transactionRequest(), "victor")
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

  it("requires a Bitcoin grant before sending sat-denominated Income", async () => {
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post,
    })

    await expect(controller.mutate({
      kind: "transaction.upsert",
      requestId: "request_sat_income_without_bitcoin",
      actor: "victor",
      id: "income-without-bitcoin-grant",
      owner: "victor",
      date: "2026-08-01",
      merchant: "Bitcoin income",
      amountCents: 1n,
      amountSats: 25_000n,
      transactionKind: "credit",
      category: "Income",
    }, "victor")).resolves.toMatchObject({ status: "unauthorized" })
    expect(post).not.toHaveBeenCalled()
  })

  it("encodes Bitcoin Income sats and owned-account transfers through fixed paths", async () => {
    const bodies: Record<string, unknown>[] = []
    const controller = createPairedDeviceController({
      store: store({
        ...snapshot,
        capabilities: ["transaction.upsert", "btcTransfer.upsert"],
      }),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, body) => {
        const wire = JSON.parse(body) as Record<string, unknown>
        bodies.push(wire)
        return success({
          ok: true,
          entityId: wire.path === PAIRED_DEVICE_PATHS["transaction.upsert"]
            ? "income-1"
            : "transfer-1",
          outcome: "inserted",
        })
      },
    })

    await controller.mutate({
      kind: "transaction.upsert",
      requestId: "request_income",
      actor: "victor",
      id: "income-1",
      owner: "victor",
      date: "2026-08-01",
      merchant: "Bitcoin income",
      amountCents: 1n,
      amountSats: 25_000n,
      transactionKind: "credit",
      category: "Income",
    }, "victor")
    await controller.mutate({
      kind: "btcTransfer.upsert",
      requestId: "request_transfer",
      actor: "victor",
      id: "transfer-1",
      owner: "victor",
      date: "2026-08-01",
      fromAccountKey: "river",
      toAccountKey: "coldcard",
      sats: 100_000n,
      feeSats: 250n,
      note: "Move to self custody",
    }, "victor")

    expect(bodies[0]).toMatchObject({
      path: PAIRED_DEVICE_PATHS["transaction.upsert"],
      args: {
        transaction: { amountSats: encodeConvexInt64(25_000n) },
      },
    })
    expect(bodies[1]).toMatchObject({
      path: PAIRED_DEVICE_PATHS["btcTransfer.upsert"],
      args: {
        sourceFile: "btc-transfers",
        transfer: {
          fromAccountKey: "river",
          toAccountKey: "coldcard",
          sats: encodeConvexInt64(100_000n),
          feeSats: encodeConvexInt64(250n),
        },
      },
    })
    expect(validateMutationRequest({
      kind: "btcTransfer.upsert",
      requestId: "request_invalid",
      actor: "victor",
      id: "transfer-invalid",
      owner: "victor",
      date: "2026-08-01",
      fromAccountKey: "river",
      toAccountKey: "river",
      sats: 1n,
      feeSats: 0n,
    })).toBeNull()
  })

  // The actor must match the session (checked above); once it does, family
  // finance rows are still canonicalized onto the household ledger and the
  // actor never crosses the wire.
  it("canonicalizes Rachel finance onto the household ledger for a session-matching actor", async () => {
    const calls: Record<string, unknown>[] = []
    const controller = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, body) => {
        calls.push(JSON.parse(body))
        return success({ ok: true, entityId: "tx-rachel", outcome: "inserted" })
      },
    })

    await expect(controller.mutate({
      kind: "transaction.upsert",
      requestId: "request_rachel",
      actor: "victor",
      id: "tx-rachel",
      owner: "rachel",
      date: "2026-07-30",
      merchant: "Household",
      amountCents: 100n,
      transactionKind: "spend",
      category: "Home",
    }, "victor")).resolves.toMatchObject({ status: "ok" })

    expect(calls[0]).toMatchObject({
      args: {
        owner: "victor",
        sourceFile: "transactions",
        transaction: { owner: "victor" },
      },
    })
    expect(calls[0]).not.toHaveProperty("args.actor")
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
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, body) => {
        const wire = JSON.parse(body) as Record<string, unknown>
        bodies.push(wire)
        const path = wire.path
        return success({
          ok: true,
          entityId: path === PAIRED_DEVICE_PATHS["budgetCategory.upsert"]
            ? "Dining"
            : "cold-storage",
          outcome: "updated",
        })
      },
    })

    await controller.mutate({
      kind: "budgetCategory.upsert",
      requestId: "request_budget",
      actor: "victor",
      owner: "mason",
      month: "2026-07",
      name: "Dining",
      originalName: "Restaurants",
      budgetCents: 20_000n,
    }, "victor")
    await controller.mutate({
      kind: "btcAccount.upsert",
      requestId: "request_account",
      actor: "victor",
      key: "cold-storage",
      owner: "mason",
      label: "Cold storage",
      custody: "self_custody",
      sats: 2_100n,
      fiatValuation: { cents: 125_000n },
      asOf: "2026-07-30T12:00:00.000Z",
    }, "victor")

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
      actor: "victor",
      key: "cold-storage",
      owner: "mason",
      label: "Cold storage",
      custody: "self_custody",
      sats: 2_100n,
      asOf: "2026-07-30T12:00:00.000Z",
    }, "victor")).resolves.toMatchObject({ status: "ok" })
    expect(bodies[2]).not.toHaveProperty("args.account.fiatValuation")
  })

  it("returns the six closed mutation states and clears only rejected revision", async () => {
    const disabled = createPairedDeviceController({
      store: store(),
      writesEnabled: () => false,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: vi.fn(),
    })
    await expect(disabled.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "disabled",
    })

    const absent = createPairedDeviceController({
      store: store(null),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: vi.fn(),
    })
    await expect(absent.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "not-configured",
    })

    const unauthorizedStore = store()
    const unauthorized = createPairedDeviceController({
      store: unauthorizedStore,
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async () => ({
        ...failure("DEVICE_UNAUTHORIZED"),
      }),
    })
    await expect(unauthorized.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "unauthorized",
    })
    expect(unauthorizedStore.current).toBeNull()

    const missing = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async () => failure("ENTITY_NOT_FOUND", {
        entityType: "transaction",
        entityId: "tx-1",
      }),
    })
    await expect(missing.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "missing",
    })

    const rejected = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async () => failure("VALIDATION_FAILED"),
    })
    await expect(rejected.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "failed",
      code: "rejected",
    })

    const failed = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async () => ({ httpStatus: 200, body: "<not-json>" }),
    })
    await expect(failed.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "failed",
      code: "invalid-response",
    })
  })

  it("classifies only bounded structured error codes and exact success values", async () => {
    const plainTextStore = store()
    const plainText = createPairedDeviceController({
      store: plainTextStore,
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async () => ({
        httpStatus: 200,
        body: JSON.stringify({
          status: "error",
          errorData: "Unauthorized mobile device",
        }),
      }),
    })
    await expect(plainText.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "failed",
      code: "invalid-response",
    })
    expect(plainTextStore.current).not.toBeNull()

    const encodedErrorStore = store()
    const encodedError = createPairedDeviceController({
      store: encodedErrorStore,
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async () => ({
        httpStatus: 200,
        body: JSON.stringify({
          status: "error",
          errorMessage: "redacted",
          errorData: JSON.stringify({
            code: "DEVICE_UNAUTHORIZED",
            message: "redacted",
          }),
        }),
      }),
    })
    await expect(encodedError.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "unauthorized",
    })
    expect(encodedErrorStore.current).toBeNull()

    const wrongEntity = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async () => success({
        ok: true,
        entityId: "different-entity",
        outcome: "updated",
      }),
    })
    await expect(wrongEntity.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "failed",
      code: "invalid-response",
    })

    const extraKey = createPairedDeviceController({
      store: store(),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async () => success({
        ok: true,
        entityId: "tx-1",
        outcome: "updated",
        remoteText: "should not cross",
      }),
    })
    await expect(extraKey.mutate(transactionRequest(), "victor")).resolves.toMatchObject({
      status: "failed",
      code: "invalid-response",
    })
  })

  it("serializes mutation and unpair, preventing late credential races", async () => {
    const paths: string[] = []
    let releaseMutation: (() => void) | undefined
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    let markMutationStarted: (() => void) | undefined
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve
    })
    const localStore = store()
    const controller = createPairedDeviceController({
      store: localStore,
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, body) => {
        const wire = JSON.parse(body)
        paths.push(wire.path)
        if (wire.path === PAIRED_DEVICE_PATHS["transaction.upsert"]) {
          markMutationStarted?.()
          await mutationGate
          return success({ ok: true, entityId: "tx-1", outcome: "updated" })
        }
        return success({ ok: true, revoked: true })
      },
    })

    const mutation = controller.mutate(transactionRequest(), "victor")
    const unpair = controller.unpair()
    await mutationStarted
    expect(paths).toEqual([PAIRED_DEVICE_PATHS["transaction.upsert"]])
    releaseMutation?.()
    await expect(mutation).resolves.toMatchObject({ status: "ok" })
    await expect(unpair).resolves.toEqual({ status: "ok", revoked: true })
    expect(paths).toEqual([
      PAIRED_DEVICE_PATHS["transaction.upsert"],
      PAIRED_DEVICE_PATHS.revoke,
    ])
    expect(localStore.current).toBeNull()
  })

  it("disables effective grants without trapping or contacting a stale origin", async () => {
    const localStore = store()
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: localStore,
      writesEnabled: () => false,
      approvedDeploymentOrigin: () => "https://replacement.convex.cloud",
      post,
    })

    await expect(controller.status()).resolves.toEqual({
      status: "paired",
      pairedAt: snapshot.pairedAt,
      capabilities: [],
      writesEnabled: false,
    })
    await expect(controller.unpair()).resolves.toEqual({ status: "ok", revoked: false })
    expect(post).not.toHaveBeenCalled()
    expect(localStore.current).toBeNull()
  })

  it("keeps the credential when remote-first unpair cannot reach the server", async () => {
    const localStore = store()
    const controller = createPairedDeviceController({
      store: localStore,
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async () => {
        throw new Error("offline")
      },
    })

    await expect(controller.unpair()).resolves.toEqual({ status: "failed" })
    expect(localStore.current).toEqual(snapshot)
  })
})
