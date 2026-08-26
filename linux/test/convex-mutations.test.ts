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
import {
  PAYMENT_SOURCES,
  paymentSourceBlockReason,
  paymentSourceChoiceTransition,
  paymentSourceRoute,
  transactionSubmission,
  type PaymentSource,
} from "../src/renderer/data/paymentSource.ts"

const revision = "revision_abcdefghijklmnop"
const snapshot: DeviceCredentialSnapshot = {
  revision,
  deploymentOrigin: "https://household.convex.cloud",
  deviceId: "device_abcdefghijklmnop",
  deviceCredential: "credential_abcdefghijklmnopqrstuvwxyz0123456789",
  profile: "victor",
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
      owner: "victor",
    })
    expect(validateMutationRequest({ ...billPay, owner: "mason" })).toBeNull()
    expect(validateMutationRequest({ ...billPay, owner: "rachel" })).toBeNull()
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
    const result = await controller.pair(
      { pairingInput, deviceName: "Fedora desktop" },
      "victor",
    )
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
    expect(localStore.current?.profile).toBe("victor")
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
    }, "victor")).resolves.toEqual({ status: "failed", code: "credential-storage" })
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
    }, "mason")).resolves.toEqual({
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
    }, "victor")).resolves.toEqual({ status: "failed", code: "invalid-input" })
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
    }, "victor")).resolves.toEqual({ status: "failed", code: "invalid-response" })
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

  it.each(["lightning", "on_chain"])(
    "forwards an edit-tagged retired %s posting byte-for-byte for Convex to compare",
    async (card) => {
      const calls: string[] = []
      const controller = createPairedDeviceController({
        store: store({
          ...snapshot,
          capabilities: ["transaction.upsert", "btcTransfer.upsert"],
        }),
        writesEnabled: () => true,
        approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
        post: async (_endpoint, body) => {
          calls.push(body)
          return success({ ok: true, entityId: "tx-1", outcome: "updated" })
        },
      })
      const storedAccountKey = " stored-account-key "

      await expect(controller.mutate({
        ...transactionRequest(),
        card,
        amountSats: 140_000n,
        bitcoinAccountKey: storedAccountKey,
        baseUpdatedAtMs: 7,
      }, "victor")).resolves.toMatchObject({ status: "ok", outcome: "updated" })

      const wire = JSON.parse(calls[0] ?? "{}")
      expect(wire.args.transaction).toMatchObject({
        card,
        amountSats: encodeConvexInt64(140_000n),
        bitcoinAccountKey: storedAccountKey,
      })
      expect(wire.args.baseUpdatedAtMs).toBe(7)
    },
  )

  it.each(["lightning", "on_chain"])(
    "rejects a new retired %s posting locally as an invalid request",
    async (card) => {
      const post = vi.fn()
      const controller = createPairedDeviceController({
        store: store({
          ...snapshot,
          capabilities: ["transaction.upsert", "btcTransfer.upsert"],
        }),
        writesEnabled: () => true,
        approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
        post,
      })

      await expect(controller.mutate({
        ...transactionRequest(),
        card,
        amountSats: 140_000n,
        bitcoinAccountKey: "stored-account-key",
      }, "victor")).resolves.toEqual({
        status: "failed",
        code: "invalid-request",
        requestId: "request_1234",
        kind: "transaction.upsert",
      })
      expect(post).not.toHaveBeenCalled()
    },
  )

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

  it("carries a linked income row on the single buy write and refuses a mismatched pair", async () => {
    const linked = {
      kind: "btcBuy.upsert" as const,
      requestId: "request_linked_income",
      actor: "victor" as const,
      id: "income-buy-01",
      owner: "victor" as const,
      date: "2026-08-03",
      source: "Employer",
      sats: 270_000n,
      priceUsdCents: 9_259_259_00n,
      usdCents: 250_000n,
      feeUsdCents: 125n,
      linkedIncome: {
        id: "income-buy-01",
        owner: "victor" as const,
        date: "2026-08-03",
        amountCents: 250_000n,
        source: "Employer",
        sourceFile: "income" as const,
      },
    }
    expect(validateMutationRequest(linked)).toMatchObject({
      feeUsdCents: 125n,
      linkedIncome: { id: "income-buy-01", amountCents: 250_000n },
    })
    expect(validateMutationRequest({ ...linked, feeUsdCents: -1n })).toBeNull()
    expect(validateMutationRequest({ ...linked, feeUsdCents: 1n << 63n })).toBeNull()

    // Every field the server requires to agree is re-checked here, so a request
    // that cannot be accepted never reaches the network.
    for (const broken of [
      { ...linked.linkedIncome, id: "some-other-id" },
      { ...linked.linkedIncome, date: "2026-08-04" },
      { ...linked.linkedIncome, amountCents: 250_001n },
      { ...linked.linkedIncome, owner: "mason" as const },
      { ...linked.linkedIncome, sourceFile: "paycheck" },
    ]) {
      expect(validateMutationRequest({ ...linked, linkedIncome: broken })).toBeNull()
    }

    let body: Record<string, unknown> | null = null
    const controller = createPairedDeviceController({
      store: store({
        ...snapshot,
        capabilities: ["btcBuy.upsert", "transaction.upsert"],
      }),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, raw) => {
        body = JSON.parse(raw) as Record<string, unknown>
        return success({ ok: true, entityId: "income-buy-01", outcome: "inserted" })
      },
    })
    await controller.mutate(linked, "victor")

    expect(body).toMatchObject({
      path: PAIRED_DEVICE_PATHS["btcBuy.upsert"],
      args: {
        sourceFile: "bitcoin-buys",
        buy: {
          id: "income-buy-01",
          usdCents: encodeConvexInt64(250_000n),
          feeUsdCents: encodeConvexInt64(125n),
        },
        linkedIncome: {
          id: "income-buy-01",
          owner: "victor",
          date: "2026-08-03",
          amountCents: encodeConvexInt64(250_000n),
          source: "Employer",
          sourceFile: "income",
        },
      },
    })
    if (body === null) throw new Error("expected a captured linked-income wire body")
    const wireLinkedIncome = (body["args"] as {
      linkedIncome: Record<string, unknown>
    }).linkedIncome
    expect(Object.keys(wireLinkedIncome).sort()).toEqual([
      "amountCents",
      "date",
      "id",
      "owner",
      "source",
      "sourceFile",
    ])
  })

  it("requires a positive exact budget-category deletion revision", () => {
    const request = {
      kind: "budgetCategory.delete" as const,
      requestId: "request_budget_delete_revision",
      actor: "mason" as const,
      owner: "mason" as const,
      month: "2026-08",
      name: "School",
      baseUpdatedAtMs: 1,
    }
    expect(validateMutationRequest(request)).toEqual(request)
    expect(validateMutationRequest({ ...request, baseUpdatedAtMs: 0 })).toBeNull()
    expect(validateMutationRequest({ ...request, baseUpdatedAtMs: 1.5 })).toBeNull()
  })

  it("pins the bill-pay platform on the wire over a legacy inbound label", async () => {
    let body: Record<string, unknown> | null = null
    const controller = createPairedDeviceController({
      store: store({ ...snapshot, capabilities: ["btcBillPay.upsert"] }),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post: async (_endpoint, raw) => {
        body = JSON.parse(raw) as Record<string, unknown>
        return success({ ok: true, entityId: "bill-platform-01", outcome: "updated" })
      },
    })

    await expect(controller.mutate({
      kind: "btcBillPay.upsert",
      requestId: "request_bill_platform",
      actor: "victor",
      id: "bill-platform-01",
      owner: "victor",
      date: "2026-08-03",
      merchant: "Internet Provider",
      category: "Utilities",
      budgetEffect: "budget_category",
      amountUsdCents: 7_999n,
      btcSpentSats: 85_000n,
      btcPriceCents: 9_410_000n,
      platform: "River",
      feeUsdCents: 40n,
    }, "victor")).resolves.toMatchObject({ status: "ok" })

    if (body === null) throw new Error("expected a captured bill-pay wire body")
    const wireBillPay = (body["args"] as {
      billPay: Record<string, unknown>
    }).billPay
    expect(wireBillPay.platform).toBe("river_bitcoin_bill_pay")
  })

  it("refuses a linked income row without the income grant", async () => {
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: store({ ...snapshot, capabilities: ["btcBuy.upsert"] }),
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
      post,
    })

    await expect(controller.mutate({
      kind: "btcBuy.upsert",
      requestId: "request_linked_ungranted",
      actor: "victor",
      id: "income-buy-02",
      owner: "victor",
      date: "2026-08-03",
      source: "Employer",
      sats: 270_000n,
      priceUsdCents: 9_259_259_00n,
      usdCents: 250_000n,
      linkedIncome: {
        id: "income-buy-02",
        owner: "victor",
        date: "2026-08-03",
        amountCents: 250_000n,
        source: "Employer",
        sourceFile: "income",
      },
    }, "victor")).resolves.toMatchObject({ status: "unauthorized" })
    expect(post).not.toHaveBeenCalled()
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

// The IPC boundary used to accept any string at all as `card`. These are the
// payloads a compromised or buggy renderer would send; every one of them has to
// die in main, where the closed matrix is re-checked rather than trusted.
describe("the payment-source matrix at the IPC boundary", () => {
  const SATS = 140_000n
  const ACCOUNT = "coldcard"

  function forged(extra: Record<string, unknown>): unknown {
    return validateMutationRequest({ ...transactionRequest(), ...extra })
  }

  it("refuses River Bitcoin Bill Pay on a transaction, whatever else it carries", () => {
    expect(forged({ card: "river_bitcoin_bill_pay" })).toBeNull()
    expect(forged({
      card: "river_bitcoin_bill_pay",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
    })).toBeNull()
    expect(forged({ card: "river_bitcoin_bill_pay", baseUpdatedAtMs: 7 })).toBeNull()
  })

  it.each([
    "River",
    "Zeus Lightning",
    "Zeus On-chain",
    "Strike",
    "Coinbase Card",
    "Aven",
    "SoFi Card",
    "Capital One VX",
    "River Bitcoin Bill Pay",
    "Lightning",
    "On-chain",
  ])("refuses the display label %s where a wire belongs, including on edits", (card) => {
    expect(forged({ card })).toBeNull()
    expect(forged({ card, baseUpdatedAtMs: 7 })).toBeNull()
  })

  it("refuses a Bitcoin spend with no sats", () => {
    expect(forged({ card: "river", bitcoinAccountKey: ACCOUNT })).toBeNull()
    expect(forged({ card: "zeus_lightning", bitcoinAccountKey: ACCOUNT })).toBeNull()
  })

  it("refuses a Bitcoin spend with no account to debit", () => {
    expect(forged({ card: "strike", amountSats: SATS })).toBeNull()
    expect(forged({ card: "zeus_on_chain", amountSats: SATS, bitcoinAccountKey: "   " }))
      .toBeNull()
  })

  it("refuses a fiat card carrying sats", () => {
    expect(forged({ card: "coinbase_card", amountSats: SATS })).toBeNull()
    expect(forged({ card: "capital_one_vx", amountSats: SATS })).toBeNull()
  })

  it("refuses a fiat card naming a Bitcoin account", () => {
    expect(forged({ card: "aven", bitcoinAccountKey: ACCOUNT })).toBeNull()
    expect(forged({ card: "sofi_card", bitcoinAccountKey: ACCOUNT })).toBeNull()
    // And an account key with no card at all names a debit nothing routes.
    expect(forged({ bitcoinAccountKey: ACCOUNT })).toBeNull()
  })

  it("leaves fiat card spend, refund, and Income semantics to the base contract", () => {
    expect(forged({ card: "coinbase_card" })).toMatchObject({
      card: "coinbase_card",
      transactionKind: "spend",
      category: "Home",
    })
    expect(forged({
      card: "coinbase_card",
      transactionKind: "credit",
      amountCents: -4_218n,
    })).toMatchObject({
      card: "coinbase_card",
      transactionKind: "credit",
      category: "Home",
    })
    expect(forged({
      card: "coinbase_card",
      transactionKind: "credit",
      category: "Income",
    })).toMatchObject({
      card: "coinbase_card",
      transactionKind: "credit",
      category: "Income",
    })
  })

  it("refuses an unknown card string on a create", () => {
    // The validator cannot read the stored row, so it cannot tell a card string
    // predating the closed list from one a caller invented. A create has no row
    // to inherit from, so it must use the enum.
    expect(forged({ card: "Debit" })).toBeNull()
    expect(forged({ card: " coinbase_card " })).toBeNull()
  })

  it("accepts an unknown card string on an edit, byte for byte", () => {
    // baseUpdatedAtMs fences the write against a row that already exists and is
    // entitled to keep its own string.
    expect(forged({ card: "Debit", baseUpdatedAtMs: 7 })).toMatchObject({
      card: "Debit",
      baseUpdatedAtMs: 7,
    })
    expect(forged({ card: " coinbase_card ", baseUpdatedAtMs: 7 })).toMatchObject({
      card: " coinbase_card ",
    })
  })

  it.each(["lightning", "on_chain"])(
    "accepts an edit-tagged retired %s payload for Convex's exact-row check",
    (card) => {
      const storedAccountKey = " stored-account-key "
      expect(forged({
        card,
        amountSats: SATS,
        bitcoinAccountKey: storedAccountKey,
        baseUpdatedAtMs: 7,
      })).toMatchObject({
        card,
        amountSats: SATS,
        bitcoinAccountKey: storedAccountKey,
        baseUpdatedAtMs: 7,
      })
    },
  )

  it.each(["lightning", "on_chain"])(
    "rejects malformed edit-tagged retired %s payloads inside the retired branch",
    (card) => {
      // Each edit marker forces the request past the new-create fence. Removing
      // any one retired-field/direction guard makes its matching assertion pass.
      expect(forged({
        card,
        bitcoinAccountKey: ACCOUNT,
        baseUpdatedAtMs: 7,
      })).toBeNull()
      expect(forged({
        card,
        amountSats: SATS,
        bitcoinAccountKey: "   ",
        baseUpdatedAtMs: 7,
      })).toBeNull()
      // The positive-int64 parser is the outer guard for this case; it rejects
      // the value before the retired branch can receive it.
      expect(forged({
        card,
        amountSats: 0n,
        bitcoinAccountKey: ACCOUNT,
        baseUpdatedAtMs: 7,
      })).toBeNull()
    },
  )

  it.each(["lightning", "on_chain"])(
    "rejects edit-tagged retired %s credit outside Income by transaction kind",
    (card) => {
      expect(forged({
        card,
        amountCents: -4_218n,
        amountSats: SATS,
        bitcoinAccountKey: ACCOUNT,
        transactionKind: "credit",
        category: "Home",
        baseUpdatedAtMs: 7,
      })).toBeNull()
    },
  )

  it.each(["lightning", "on_chain"])(
    "rejects edit-tagged retired %s spend on Income in the shared base contract",
    (card) => {
      // The retired branch deliberately has no duplicate category clause. If
      // it passes a spend on Income, the shared sign contract still rejects it.
      expect(forged({
        card,
        amountSats: SATS,
        bitcoinAccountKey: ACCOUNT,
        transactionKind: "spend",
        category: "Income",
        baseUpdatedAtMs: 7,
      })).toBeNull()
    },
  )

  it("accepts Bitcoin-native Income with positive sats and a receiving account", () => {
    expect(forged({
      card: "strike",
      category: "Income",
      transactionKind: "credit",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
    })).toMatchObject({
      card: "strike",
      category: "Income",
      transactionKind: "credit",
      amountSats: SATS,
      bitcoinAccountKey: ACCOUNT,
    })
  })

  it.each(["zeus_lightning", "zeus_on_chain"])(
    "refuses the Bitcoin-native source %s on a non-Income credit or refund",
    (card) => {
      expect(forged({
        card,
        transactionKind: "credit",
        amountSats: SATS,
        bitcoinAccountKey: ACCOUNT,
      })).toBeNull()
    },
  )

  it("keeps the sat-denominated Income row exactly as it was", () => {
    expect(forged({
      category: "Income",
      transactionKind: "credit",
      amountSats: 25_000n,
    })).toMatchObject({ category: "Income", amountSats: 25_000n })
    // Still Income-only, and still without an account it never had.
    expect(forged({ amountSats: 25_000n })).toBeNull()
    expect(forged({
      category: "Income",
      transactionKind: "credit",
      amountSats: 25_000n,
      bitcoinAccountKey: ACCOUNT,
    })).toBeNull()
  })

  it.each(["river", "zeus_lightning", "zeus_on_chain", "strike"])(
    "accepts the Bitcoin-native spend %s with exact sats and a named account",
    (card) => {
      expect(forged({ card, amountSats: SATS, bitcoinAccountKey: ACCOUNT }))
        .toMatchObject({ card, amountSats: SATS, bitcoinAccountKey: ACCOUNT })
    },
  )

  it.each(["lightning", "on_chain"])(
    "rejects a new retired %s source because legacy sources may only round-trip unchanged",
    (card) => {
      expect(forged({ card, amountSats: SATS, bitcoinAccountKey: ACCOUNT })).toBeNull()
    },
  )
})

// End to end in shape, not in transport: the renderer's own payload builder
// produces the source fields, and main's validator is the thing that judges
// them. A drift between the two shows up here rather than on the wire.
describe("form-built payloads through the main-process validator", () => {
  it.each(PAYMENT_SOURCES)("routes %s the way the matrix says", (source: PaymentSource) => {
    const built = transactionSubmission({
      source,
      amountSats: 140_000n,
      bitcoinAccountKey: "coldcard",
      kind: "spend",
      category: "Home",
    })
    const writesTransaction = paymentSourceRoute(source) === "transaction"
    // The form emits a card for the eight transaction sources only. River
    // Bitcoin Bill Pay never builds one.
    expect(built.card).toBe(writesTransaction ? source : undefined)
    const request = validateMutationRequest({
      ...transactionRequest(),
      // Forced on for River: the payload the form declines to build is exactly
      // the one a forged renderer would send, and main has to be the refusal.
      card: source,
      ...built,
    })
    if (!writesTransaction) {
      expect(request).toBeNull()
      return
    }
    expect(request).toMatchObject({ card: source, ...built })
  })

  it("restores one retired posting and keeps transition, form block, and main aligned", () => {
    const restored = paymentSourceChoiceTransition({
      sourceChoice: "strike",
      sats: "999999",
      bitcoinAccountKey: "new-account",
    }, "__legacy-card", {
      choice: "__legacy-card",
      card: "lightning",
      amountSats: 140_000n,
      bitcoinAccountKey: " stored-account ",
    })
    expect(restored).toEqual({
      sourceChoice: "__legacy-card",
      sats: "140000",
      bitcoinAccountKey: " stored-account ",
    })

    const formState = {
      source: null,
      legacyCard: "lightning",
      amountSats: BigInt(restored.sats),
      bitcoinAccountKey: restored.bitcoinAccountKey,
      kind: "spend" as const,
      category: "Home",
    }
    expect(paymentSourceBlockReason(formState)).toBeNull()
    const submission = transactionSubmission(formState)
    expect(submission).toEqual({
      card: "lightning",
      amountSats: 140_000n,
      bitcoinAccountKey: " stored-account ",
    })
    expect(validateMutationRequest({
      ...transactionRequest(),
      ...submission,
      baseUpdatedAtMs: 7,
    })).toMatchObject({ ...submission, baseUpdatedAtMs: 7 })
  })
})
