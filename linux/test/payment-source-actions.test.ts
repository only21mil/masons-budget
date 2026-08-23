// @vitest-environment happy-dom

// What a chosen payment source does to the transaction form.
//
// Two behaviours share this file because both are decided by the source the
// user picked: River hands the entry off to the bill-pay form instead of
// dead-ending on a pointer to the Bills page, and a Bitcoin-denominated source
// is refused outright on a device whose pairing carries no Bitcoin grant.
//
// Rendering here is static markup with no DOM, so a selection cannot be typed.
// Each render stages the selection through a stored row whose `card` already
// carries the wire value, which is exactly what the form reads back through
// `paymentSourceFromRow`.

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { FamilyMember } from "@vogel-vault/domain/family"
import type { Transaction } from "@vogel-vault/domain/readModel"
import { parseCents } from "@vogel-vault/domain/money"

import {
  BillPayFormDialog,
  TransactionFormDialog,
} from "../src/renderer/components/MutationForms.tsx"
import { AppStateProvider } from "../src/renderer/app/AppState.tsx"
import {
  type FixtureEnvelope,
  buildSanitizedFixtureEnvelope,
} from "../src/renderer/data/fixtures.ts"
import type {
  RendererMutationAdapter,
  RendererMutationKind,
} from "../src/renderer/data/mutations.ts"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const BILL_PAY_POINTER = "is recorded on the Bills page"
const HANDOFF_ACTION = "Record as River bill payment"
const BITCOIN_BLOCK =
  "This device cannot post Bitcoin: its pairing lacks the Bitcoin write grant."
const CHILD_BITCOIN_BLOCK =
  "Only adult profiles may record Bitcoin balance postings."

/** transactions:write and bitcoin:write, in the expanded kind vocabulary. */
const FULL_CAPABILITIES: readonly RendererMutationKind[] = [
  "transaction.upsert",
  "transaction.delete",
  "btcBuy.upsert",
  "btcBuy.delete",
  "btcBillPay.upsert",
  "btcBillPay.delete",
  "btcTransfer.upsert",
  "btcTransfer.delete",
  "btcAccount.upsert",
  "btcAccount.delete",
]

/** transactions:write alone: every Bitcoin kind is absent, proxy included. */
const TRANSACTIONS_ONLY: readonly RendererMutationKind[] = [
  "transaction.upsert",
  "transaction.delete",
]

const adapter: RendererMutationAdapter = {
  getPairingStatus: async () => ({
    status: "paired",
    pairedAt: 1,
    capabilities: FULL_CAPABILITIES,
    writesEnabled: true,
  }),
  pairDevice: async () => ({ status: "paired", pairedAt: 1, capabilities: FULL_CAPABILITIES }),
  mutateConvexRow: async (request) => ({
    status: "ok",
    requestId: request.requestId,
    kind: request.kind,
    outcome: "updated",
    entityId: "id" in request ? request.id : "key" in request ? request.key : request.name,
  }),
  unpairDevice: async () => ({ status: "ok", revoked: true }),
}

function liveEnvelope(profile: FamilyMember = "victor"): FixtureEnvelope {
  const base = buildSanitizedFixtureEnvelope(profile)
  return {
    ...base,
    transactions: { ...base.transactions, status: "live" },
    billPays: { ...base.billPays, status: "live" },
    btcBalanceDocument: { ...base.btcBalanceDocument, status: "live" },
  }
}

function withState(
  children: ReturnType<typeof createElement>,
  capabilities: readonly RendererMutationKind[] = FULL_CAPABILITIES,
  profile: FamilyMember = "victor",
): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialData: liveEnvelope(profile),
      initialDataOrigin: "remote",
      initialMutationCapabilities: [...capabilities],
      mutationAdapter: adapter,
      children,
    }),
  )
}

function rowOnSource(card: string, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: "transaction-source-01",
    updatedAtMs: 7,
    owner: "victor",
    date: "2026-08-14",
    merchant: "Duke Energy",
    amount: parseCents("128.45"),
    category: "Utilities",
    card,
    note: null,
    ...extra,
  }
}

describe("a stored retired Bitcoin posting through the real dialog submit", () => {
  it.each(["lightning", "on_chain"] as const)(
    "submits the exact well-formed %s posting instead of applying the sat-Income guard",
    async (card) => {
      const container = document.createElement("div")
      document.body.append(container)
      const root = createRoot(container)
      const mutateConvexRow = vi.fn<RendererMutationAdapter["mutateConvexRow"]>(
        async (request) => ({
          status: "ok",
          requestId: request.requestId,
          kind: request.kind,
          outcome: "updated",
          entityId: "id" in request ? request.id : "updated-row",
        }),
      )
      const onClose = vi.fn()
      const interactiveAdapter: RendererMutationAdapter = { ...adapter, mutateConvexRow }

      try {
        await act(async () => {
          root.render(createElement(AppStateProvider, {
            initialProfile: "victor",
            initialData: liveEnvelope("victor"),
            initialDataOrigin: "remote",
            initialMutationCapabilities: [...FULL_CAPABILITIES],
            initialPairingStatus: {
              status: "paired",
              pairedAt: 1,
              capabilities: FULL_CAPABILITIES,
              writesEnabled: true,
            },
            mutationAdapter: interactiveAdapter,
            children: createElement(TransactionFormDialog, {
              open: true,
              transaction: rowOnSource(card, {
                category: "Shopping",
                amountSats: 140_000n,
                bitcoinAccountKey: " stored-account ",
              }),
              onClose,
            }),
          }))
        })

        const form = container.querySelector("form")
        expect(form).not.toBeNull()
        await act(async () => {
          form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))
          await vi.waitFor(() => expect(mutateConvexRow).toHaveBeenCalledTimes(1))
        })

        expect(mutateConvexRow).toHaveBeenCalledWith(expect.objectContaining({
          kind: "transaction.upsert",
          card,
          amountSats: 140_000n,
          bitcoinAccountKey: " stored-account ",
          baseUpdatedAtMs: 7,
          transactionKind: "spend",
          category: "Shopping",
        }))
        expect(container.textContent).not.toContain("Bitcoin income must use the Income category")
        expect(onClose).toHaveBeenCalledTimes(1)
      } finally {
        await act(async () => root.unmount())
        container.remove()
      }
    },
  )
})

describe("the River hand-off on the transaction form", () => {
  it("offers the hand-off, and keeps the explanation, when a handler is supplied", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("river_bitcoin_bill_pay"),
        onRecordAsBillPay: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(markup).toContain(HANDOFF_ACTION)
    // The pointer stays: the hand-off explains itself before it is taken.
    expect(markup).toContain(BILL_PAY_POINTER)
  })

  it("keeps the plain block when no handler is supplied", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("river_bitcoin_bill_pay"),
        onClose: () => undefined,
      }),
    )
    expect(markup).toContain(BILL_PAY_POINTER)
    expect(markup).not.toContain(HANDOFF_ACTION)
  })

  it("offers no hand-off for a source that writes a transaction row", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("coinbase_card"),
        onRecordAsBillPay: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(markup).not.toContain(HANDOFF_ACTION)
    expect(markup).not.toContain(BILL_PAY_POINTER)
  })
})

describe("the bill-pay form opened from a hand-off", () => {
  it("renders the handed-over values on a new payment", () => {
    const markup = withState(
      createElement(BillPayFormDialog, {
        open: true,
        payment: null,
        prefill: {
          date: "2026-08-14",
          merchant: "Duke Energy",
          amountUsd: parseCents("128.45"),
          budgetEffect: "budget_category",
          platform: "river_bitcoin_bill_pay",
          category: "Utilities",
        },
        onClose: () => undefined,
      }),
    )
    expect(markup).toContain("Add bill payment")
    expect(markup).toContain('value="2026-08-14"')
    expect(markup).toContain('value="Duke Energy"')
    expect(markup).toContain('value="128.45"')
    expect(markup).toContain('value="Utilities"')
    // Nothing is written on the way across: the ledger values are still blank.
    expect(markup).toContain("Sats spent")
    expect(markup).toContain("BTC price (USD)")
  })

  it("opens a credit-card hand-off on its fixed category", () => {
    const markup = withState(
      createElement(BillPayFormDialog, {
        open: true,
        payment: null,
        prefill: {
          date: "2026-08-14",
          merchant: "Aven",
          amountUsd: parseCents("400.00"),
          budgetEffect: "credit_card_payment",
          platform: "river_bitcoin_bill_pay",
          category: "Credit Card Payment",
        },
        onClose: () => undefined,
      }),
    )
    expect(markup).toContain('value="Credit Card Payment"')
    expect(markup).toContain("Fixed for a credit card payment.")
  })

  it("lets a stored row win over a stale prefill", () => {
    const markup = withState(
      createElement(BillPayFormDialog, {
        open: true,
        payment: {
          id: "bill-01",
          updatedAtMs: 3,
          owner: "victor",
          date: "2026-07-02",
          merchant: "City Water",
          category: "Bills",
          budgetEffect: "budget_category",
          amountUsd: parseCents("64.00"),
          btcSpentSats: 70_000n,
          btcPrice: parseCents("91000.00"),
          feeUsd: parseCents("0.00"),
          platform: "river_bitcoin_bill_pay",
          reference: null,
          note: null,
        },
        prefill: {
          date: "2026-08-14",
          merchant: "Duke Energy",
          amountUsd: parseCents("128.45"),
          budgetEffect: "budget_category",
          platform: "river_bitcoin_bill_pay",
          category: "Utilities",
        },
        onClose: () => undefined,
      }),
    )
    expect(markup).toContain("Edit bill payment")
    expect(markup).toContain('value="City Water"')
    expect(markup).not.toContain('value="Duke Energy"')
  })
})

describe("the Bitcoin-posting capability block", () => {
  const bitcoinNativeRow = rowOnSource("zeus_lightning", {
    amountSats: 140_000n,
    bitcoinAccountKey: "coldcard",
  })

  it("blocks a Bitcoin-native source when the pairing carries no Bitcoin grant", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: bitcoinNativeRow,
        onClose: () => undefined,
      }),
      TRANSACTIONS_ONLY,
    )
    expect(markup).toContain(BITCOIN_BLOCK)
  })

  it("leaves a card source alone on the same device", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("coinbase_card"),
        onClose: () => undefined,
      }),
      TRANSACTIONS_ONLY,
    )
    expect(markup).not.toContain(BITCOIN_BLOCK)
  })

  it("allows the Bitcoin posting once the grant is present", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: bitcoinNativeRow,
        onClose: () => undefined,
      }),
    )
    expect(markup).not.toContain(BITCOIN_BLOCK)
  })

  it("blocks sat-denominated Income too, since that row carries amountSats", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("", { category: "Income", amountSats: 250_000n }),
        onClose: () => undefined,
      }),
      TRANSACTIONS_ONLY,
    )
    expect(markup).toContain(BITCOIN_BLOCK)
  })
})

// The account list is the effective LEDGER OWNER's net-worth scope, not the
// viewer's visibility. Adults can see Mason's stack; a household row still may
// not be paid out of it, and a Mason row may not be paid out of the household's.
describe("the Bitcoin account list on a Bitcoin-denominated source", () => {
  const spendRow = (owner: FamilyMember) =>
    rowOnSource("zeus_lightning", {
      owner,
      amountSats: 140_000n,
      bitcoinAccountKey: "coldcard",
    })

  function accountOptions(markup: string): string[] {
    // "lightning" is deliberately absent from this list because it is an account
    // key in the fixtures, not one of the account keys asserted below.
    return ["coldcard", "exchange-dca", "mason-stack", "maddox-stack"].filter((key) =>
      markup.includes(`value="${key}"`),
    )
  }

  it("offers Victor the adult household stack and neither child's", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: spendRow("victor"),
        onClose: () => undefined,
      }),
    )
    expect(accountOptions(markup)).toEqual(["coldcard", "exchange-dca"])
  })

  it("offers Rachel the identical list, since one household shares one stack", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: spendRow("victor"),
        onClose: () => undefined,
      }),
      FULL_CAPABILITIES,
      "rachel",
    )
    expect(accountOptions(markup)).toEqual(["coldcard", "exchange-dca"])
  })

  it("offers Mason his own stack and nothing else", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: spendRow("mason"),
        onClose: () => undefined,
      }),
      FULL_CAPABILITIES,
      "mason",
    )
    expect(accountOptions(markup)).toEqual(["mason-stack"])
  })

  it("blocks an adult from saving a Bitcoin spend on Mason's ledger", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: spendRow("mason"),
        onClose: () => undefined,
      }),
    )
    expect(accountOptions(markup)).toEqual(["mason-stack"])
    expect(markup).toContain(CHILD_BITCOIN_BLOCK)
    expect(markup).toMatch(/type="submit"[^>]*disabled/)
  })

  it.each(["lightning", "on_chain"])(
    "keeps the adult-owner gate on a stored retired %s posting",
    (card) => {
      const markup = withState(
        createElement(TransactionFormDialog, {
          open: true,
          transaction: rowOnSource(card, {
            owner: "mason",
            amountSats: 140_000n,
            bitcoinAccountKey: "mason-stack",
          }),
          onClose: () => undefined,
        }),
      )
      expect(markup).toContain(CHILD_BITCOIN_BLOCK)
      expect(markup).toMatch(/type="submit"[^>]*disabled/)
    },
  )
})

describe("Income against a payment source", () => {
  it("offers sats and an account for Bitcoin-native Income", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("strike", {
          category: "Income",
          amountSats: 140_000n,
          bitcoinAccountKey: "coldcard",
        }),
        onClose: () => undefined,
      }),
    )
    expect(markup).not.toContain("requires a spend outside Income")
    expect(markup).toContain("Bitcoin received (sats)")
    expect(markup).not.toContain("Bitcoin spent (sats)")
    expect(markup).toContain("Required. The account these sats enter.")
  })

  it("leaves Income with no source on its optional sats field", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("", { category: "Income", amountSats: 250_000n }),
        onClose: () => undefined,
      }),
    )
    expect(markup).toContain("Bitcoin received (sats)")
    expect(markup).not.toContain("Bitcoin spent (sats)")
  })

  it("does not offer spend-only fiat cards when adding Income", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: null,
        defaultCategory: "Income",
        onClose: () => undefined,
      }),
    )
    expect(markup).not.toContain('<option value="coinbase_card">Coinbase Card</option>')
    expect(markup).toContain('<option value="strike">Strike</option>')
  })
})
