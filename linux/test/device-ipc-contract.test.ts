import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  CONVEX_MUTATION_CHANNEL,
  CONVEX_READ_CHANNEL,
  CONVEX_ROWS_CHANNEL,
  CSV_EXPORT_CHANNEL,
  DEVICE_PAIR_CHANNEL,
  DEVICE_PAIRING_STATUS_CHANNEL,
  DEVICE_UNPAIR_CHANNEL,
  READ_PROFILE_CHANNEL,
} from "../electron/ipcChannels.ts"
import type {
  VogelVaultMutationFailureCode,
  VogelVaultMutationRequest,
  VogelVaultMutationResult,
  VogelVaultPairingFailureCode,
  VogelVaultPairingRequest,
  VogelVaultPairingResult,
  VogelVaultPairingStatus,
  VogelVaultUnpairResult,
} from "../shared/ipc.ts"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")

const requests = [
  {
    kind: "transaction.upsert",
    requestId: "request-01",
    actor: "victor",
    id: "transaction-01",
    owner: "victor",
    baseUpdatedAtMs: 100,
    date: "2026-07-30",
    merchant: "Example",
    amountCents: 1_025n,
    transactionKind: "spend",
    category: "Food",
  },
  {
    kind: "transaction.delete",
    requestId: "request-02",
    actor: "victor",
    id: "transaction-01",
    owner: "victor",
    baseUpdatedAtMs: 100,
  },
  {
    kind: "todo.upsert",
    requestId: "request-03",
    actor: "mason",
    id: "todo-01",
    owner: "mason",
    title: "Example",
    done: false,
    flagged: true,
    priority: 1n,
    baseUpdatedAtMs: 100,
  },
  {
    kind: "todo.delete",
    requestId: "request-04",
    actor: "mason",
    id: "todo-01",
    owner: "mason",
    baseUpdatedAtMs: 100,
  },
  {
    kind: "todo.restore",
    requestId: "request-restore",
    actor: "mason",
    id: "todo-01",
    owner: "mason",
    baseUpdatedAtMs: 100,
  },
  {
    kind: "budgetCategory.upsert",
    requestId: "request-05",
    actor: "victor",
    owner: "victor",
    month: "2026-07",
    name: "Food",
    budgetCents: 50_000n,
  },
  {
    kind: "budgetCategory.delete",
    requestId: "request-06",
    actor: "victor",
    owner: "victor",
    month: "2026-07",
    name: "Food",
    baseUpdatedAtMs: 100,
  },
  {
    kind: "budgetPlan.copyForward",
    requestId: "request-copy",
    actor: "victor",
    owner: "victor",
    fromMonth: "2026-08",
    toMonth: "2026-09",
    baseUpdatedAtMs: 100,
  },
  {
    kind: "btcBuy.upsert",
    requestId: "request-07",
    actor: "victor",
    id: "buy-01",
    owner: "victor",
    baseUpdatedAtMs: 100,
    date: "2026-07-30",
    source: "Example",
    sats: 100_000n,
    priceUsdCents: 10_000_000n,
    usdCents: 10_000n,
    // One action, one write: the income the purchase was funded by rides along
    // on the same request under the shared id.
    linkedIncome: {
      id: "buy-01",
      owner: "victor",
      date: "2026-07-30",
      amountCents: 10_000n,
      source: "Example",
      sourceFile: "income",
    },
  },
  {
    kind: "btcBuy.delete",
    requestId: "request-08",
    actor: "victor",
    id: "buy-01",
    owner: "victor",
    baseUpdatedAtMs: 100,
  },
  {
    kind: "btcBillPay.upsert",
    requestId: "request-09",
    actor: "victor",
    id: "bill-01",
    owner: "victor",
    baseUpdatedAtMs: 100,
    date: "2026-07-30",
    merchant: "Example",
    category: "Bills",
    budgetEffect: "budget_category",
    amountUsdCents: 10_000n,
    btcSpentSats: 100_000n,
    btcPriceCents: 10_000_000n,
    feeUsdCents: 100n,
  },
  {
    kind: "btcBillPay.delete",
    requestId: "request-10",
    actor: "victor",
    id: "bill-01",
    owner: "victor",
    baseUpdatedAtMs: 100,
  },
  {
    kind: "btcAccount.upsert",
    requestId: "request-11",
    actor: "victor",
    key: "cold-storage",
    owner: "victor",
    baseUpdatedAtMs: 100,
    label: "Cold storage",
    custody: "self_custody",
    sats: 1_000_000n,
    asOf: "2026-07-30T00:00:00Z",
  },
  {
    kind: "btcAccount.delete",
    requestId: "request-12",
    actor: "victor",
    key: "cold-storage",
    owner: "victor",
    baseUpdatedAtMs: 100,
  },
  {
    kind: "btcTransfer.upsert",
    requestId: "request-13",
    actor: "victor",
    id: "transfer-01",
    owner: "victor",
    date: "2026-07-30",
    fromAccountKey: "river",
    toAccountKey: "cold-storage",
    sats: 100_000n,
    feeSats: 250n,
  },
  {
    kind: "btcTransfer.delete",
    requestId: "request-14",
    actor: "victor",
    id: "transfer-01",
    owner: "victor",
    baseUpdatedAtMs: 100,
  },
] as const satisfies readonly VogelVaultMutationRequest[]

const mutationFailureCodes = [
  "invalid-request",
  "conflict",
  "rejected",
  "unavailable",
  "invalid-response",
  "credential-storage",
  "PROFILE_BINDING_REQUIRED",
  "REVISION_REQUIRED",
] as const satisfies readonly VogelVaultMutationFailureCode[]

const pairingFailureCodes = [
  "invalid-input",
  "expired",
  "already-claimed",
  "cancelled",
  "server-rejected",
  "unavailable",
  "invalid-response",
  "credential-storage",
] as const satisfies readonly VogelVaultPairingFailureCode[]

describe("paired-device IPC contract", () => {
  it("keeps the closed channel list in reviewed order", () => {
    expect([
      CSV_EXPORT_CHANNEL,
      CONVEX_READ_CHANNEL,
      CONVEX_ROWS_CHANNEL,
      READ_PROFILE_CHANNEL,
      DEVICE_PAIR_CHANNEL,
      DEVICE_PAIRING_STATUS_CHANNEL,
      CONVEX_MUTATION_CHANNEL,
      DEVICE_UNPAIR_CHANNEL,
    ]).toEqual([
      "vogel-vault:export-csv",
      "vogel-vault:read-remote-snapshot",
      "vogel-vault:query-convex-rows",
      "vogel-vault:set-read-profile",
      "vogel-vault:pair-device",
      "vogel-vault:get-pairing-status",
      "vogel-vault:mutate-convex-row",
      "vogel-vault:unpair-device",
    ])
  })

  it("has exactly sixteen closed mutation discriminators", () => {
    expect(requests.map((request) => request.kind)).toEqual([
      "transaction.upsert",
      "transaction.delete",
      "todo.upsert",
      "todo.delete",
      "todo.restore",
      "budgetCategory.upsert",
      "budgetCategory.delete",
      "budgetPlan.copyForward",
      "btcBuy.upsert",
      "btcBuy.delete",
      "btcBillPay.upsert",
      "btcBillPay.delete",
      "btcAccount.upsert",
      "btcAccount.delete",
      "btcTransfer.upsert",
      "btcTransfer.delete",
    ])
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(16)
  })

  it("keeps mutation results to six text-free outer states", () => {
    const results = [
      {
        status: "ok",
        requestId: "request-01",
        kind: "transaction.upsert",
        outcome: "inserted",
        entityId: "transaction-01",
      },
      { status: "disabled", requestId: "request-01", kind: "transaction.upsert" },
      { status: "not-configured", requestId: "request-01", kind: "transaction.upsert" },
      { status: "unauthorized", requestId: "request-01", kind: "transaction.upsert" },
      { status: "missing", requestId: "request-01", kind: "transaction.upsert" },
      {
        status: "failed",
        requestId: "request-01",
        kind: "transaction.upsert",
        code: "invalid-request",
      },
    ] as const satisfies readonly VogelVaultMutationResult[]

    expect(results.map((result) => result.status)).toEqual([
      "ok",
      "disabled",
      "not-configured",
      "unauthorized",
      "missing",
      "failed",
    ])
    expect(mutationFailureCodes).toHaveLength(8)
  })

  it("keeps pairing and unpairing results credential-free", () => {
    const request = {
      pairingInput: "one-time-pairing-value",
      deviceName: "Framework laptop",
    } satisfies VogelVaultPairingRequest
    const paired = {
      status: "paired",
      pairedAt: 1_753_891_200_000,
      capabilities: requests.map((candidate) => candidate.kind),
    } satisfies VogelVaultPairingResult
    const status = {
      ...paired,
      writesEnabled: true,
    } satisfies VogelVaultPairingStatus
    const unpaired = { status: "ok", revoked: true } satisfies VogelVaultUnpairResult

    expect(request).toEqual({
      pairingInput: "one-time-pairing-value",
      deviceName: "Framework laptop",
    })
    expect(status.status).toBe("paired")
    expect(unpaired).toEqual({ status: "ok", revoked: true })
    expect(pairingFailureCodes).toHaveLength(8)
  })

  it("exposes only the reviewed named methods and no generic IPC primitive", () => {
    const preload = readFileSync(join(root, "electron", "preload.ts"), "utf8")
    const bridgeBody = preload.slice(preload.indexOf("contextBridge.exposeInMainWorld"))
    const methods = [...bridgeBody.matchAll(/^\s{2}(\w+)[,:]/gm)].map((match) => match[1])

    expect(methods).toEqual([
      "getRuntimeInfo",
      "exportCsv",
      "getRemoteSnapshot",
      "queryConvexRows",
      "setReadProfile",
      "pairDevice",
      "getPairingStatus",
      "mutateConvexRow",
      "unpairDevice",
    ])
    expect(bridgeBody).not.toMatch(/\bipcRenderer\b/)
  })

  it("declares no transport or credential-shaped fields in the new shared contracts", () => {
    const shared = readFileSync(join(root, "shared", "ipc.ts"), "utf8")
    const writeContracts = shared.slice(shared.indexOf("// ── Paired-device writes"))

    expect(writeContracts).not.toMatch(
      /\breadonly\s+(?:token|url|endpoint|path|raw|serverText)\??\s*:/i,
    )
  })

  it("requires attached native confirmation and never opens renderer URLs externally", () => {
    const main = readFileSync(join(root, "electron", "main.ts"), "utf8")
    const pairHandler = main.slice(
      main.indexOf("ipcMain.handle(\n    DEVICE_PAIR_CHANNEL"),
      main.indexOf("ipcMain.handle(\n    DEVICE_PAIRING_STATUS_CHANNEL"),
    )
    const unpairHandler = main.slice(
      main.indexOf("ipcMain.handle(\n    DEVICE_UNPAIR_CHANNEL"),
      main.indexOf("function createWindow"),
    )

    expect(pairHandler.indexOf("dialog.showMessageBox(window")).toBeGreaterThan(0)
    expect(pairHandler).toContain("nativeConfirmation.run(")
    expect(pairHandler.indexOf("dialog.showMessageBox(window"))
      .toBeLessThan(pairHandler.indexOf("controller.pair(request,"))
    expect(pairHandler).toContain("Maximum possible grants: tasks, transactions, budget, and bitcoin")
    expect(pairHandler).toContain("confirmation.response !== 1")
    expect(unpairHandler.indexOf("dialog.showMessageBox(window")).toBeGreaterThan(0)
    expect(unpairHandler).toContain("nativeConfirmation.run(")
    expect(unpairHandler.indexOf("dialog.showMessageBox(window"))
      .toBeLessThan(unpairHandler.indexOf("controller.unpair()"))
    expect(main.match(/const nativeConfirmation = createNativeConfirmationGuard\(\)/g))
      .toHaveLength(1)
    expect(main.match(/nativeConfirmation\.run\(/g)).toHaveLength(2)
    expect(main).not.toContain("shell.openExternal")
    expect(main).not.toMatch(/\bimport\b[^\n]*\bshell\b[^\n]*\bfrom "electron"/)
  })
})
