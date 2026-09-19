import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import type { VogelVaultRowRequest } from "../shared/ipc.ts"
import { resolveRemoteReadSettings } from "../electron/convexRead.ts"
import { createConvexRowRepository } from "../electron/convexRows.ts"

const settings = resolveRemoteReadSettings({
  VOGEL_VAULT_REMOTE_READ: "1",
  VOGEL_VAULT_CONVEX_URL: "https://framework-desktop.tail69757d.ts.net",
  VOGEL_VAULT_CONVEX_READ_TOKEN: "not-a-real-golden-test-secret",
})

const queryNames = new Map<string, string>([
  ["tables:rowCounts", "rowCounts"],
  ["tables:listTransactions", "listTransactions"],
  ["tables:listTodos", "listTodos"],
  ["tables:listBtcBuys", "listBtcBuys"],
  ["tables:listBtcAccounts", "listBtcAccounts"],
  ["tables:listBtcBillPays", "listBtcBillPays"],
  ["tables:getBudgetDocument", "getBudgetDocument"],
])

const requests: VogelVaultRowRequest[] = [
  { kind: "rowCounts" },
  { kind: "transactions", limit: 3 },
  { kind: "todos", limit: 3 },
  { kind: "btcBuys", scope: "visible", limit: 3 },
  { kind: "btcAccounts", scope: "visible" },
  { kind: "btcBillPays", scope: "visible", limit: 3 },
  { kind: "budget", scope: "netWorth" },
]

describe("production Convex wire captures", () => {
  it("validates every captured query through the real repository decoder", async () => {
    const seen = new Set<string>()
    const repository = createConvexRowRepository({
      configuration: () => ({ settings, generation: 1 }),
      post: (_endpoint, body) => {
        const request = JSON.parse(body) as {
          path: string
          format: string
        }
        const queryName = queryNames.get(request.path)
        if (queryName === undefined) throw new Error(`No golden capture for ${request.path}`)
        seen.add(queryName)
        return Promise.resolve({
          httpStatus: 200,
          body: readFileSync(
            new URL(
              `../../shared/domain/fixtures/convex-wire-golden/${queryName}.${request.format}.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        })
      },
    })

    for (const request of requests) {
      const result = await repository.query(request, "victor")
      if (request.kind === "transactions") {
        // The client derives presentation fields from the canonical amount,
        // even though the synthetic capture agrees with them.
        expect(result).toMatchObject({ status: "ok", kind: "transactions" })
        if (result.status !== "ok" || result.kind !== "transactions") {
          throw new Error("synthetic transaction capture did not decode")
        }
        expect(result.rows[0]).toMatchObject({
          amountCents: 1_000n,
          spendAmount: 1_000n,
          displaySpendAmount: 1_000n,
          hasOppositeSpendSign: false,
        })
        continue
      }
      if (request.kind === "btcAccounts") {
        // The synthetic capture deliberately models a bounded request and is
        // incomplete. This repository's public account request is unbounded,
        // so the real decoder must retain the incomplete-envelope signal
        // rather than treating it as live data.
        expect(result).toEqual({ status: "error", code: "incomplete-response" })
        continue
      }
      expect(result, request.kind).toMatchObject({ status: "ok", kind: request.kind })
    }
    expect(seen).toEqual(new Set(queryNames.values()))
  })
})
