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

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

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

const BILL_PAY_POINTER = "is recorded on the Bills page"
const HANDOFF_ACTION = "Record as River bill payment"
const BITCOIN_BLOCK =
  "This device cannot spend Bitcoin: its pairing lacks the Bitcoin write grant."

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

describe("the Bitcoin-spend capability block", () => {
  const lightningRow = rowOnSource("lightning", {
    amountSats: 140_000n,
    bitcoinAccountKey: "coldcard",
  })

  it("blocks a Bitcoin-denominated source when the pairing carries no Bitcoin grant", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: lightningRow,
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

  it("allows the Bitcoin spend once the grant is present", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: lightningRow,
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
    rowOnSource("lightning", { owner, amountSats: 140_000n, bitcoinAccountKey: "coldcard" })

  function accountOptions(markup: string): string[] {
    // "lightning" is deliberately absent from this list: it is both an account
    // key in the fixtures and a payment-source wire value, so it cannot tell
    // the two selects apart.
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

  it("scopes an adult editing a Mason row to Mason's accounts", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: spendRow("mason"),
        onClose: () => undefined,
      }),
    )
    expect(accountOptions(markup)).toEqual(["mason-stack"])
  })
})

describe("Income against a Bitcoin-denominated source", () => {
  const INCOME_BLOCK =
    "Income cannot use a Bitcoin payment source; record a Bitcoin buy instead."

  it("refuses the combination and names the Bitcoin buy instead", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("lightning", {
          category: "Income",
          amountSats: 140_000n,
          bitcoinAccountKey: "coldcard",
        }),
        onClose: () => undefined,
      }),
    )
    expect(markup).toContain(INCOME_BLOCK)
    // The two sats fields are mutually exclusive: this row shows the spend
    // field, so the optional sat-Income field is not on screen at all.
    expect(markup).toContain("Bitcoin spent (sats)")
    expect(markup).not.toContain("Bitcoin received (sats)")
  })

  it("leaves Income with no source on its optional sats field", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("", { category: "Income", amountSats: 250_000n }),
        onClose: () => undefined,
      }),
    )
    expect(markup).not.toContain(INCOME_BLOCK)
    expect(markup).toContain("Bitcoin received (sats)")
    expect(markup).not.toContain("Bitcoin spent (sats)")
  })

  it("leaves Income on a fiat card alone", () => {
    const markup = withState(
      createElement(TransactionFormDialog, {
        open: true,
        transaction: rowOnSource("coinbase_card", { category: "Income" }),
        onClose: () => undefined,
      }),
    )
    expect(markup).not.toContain(INCOME_BLOCK)
  })
})
