// Plain serialisable contracts shared by Electron main/preload and the renderer.
// No Node or Electron types belong here.

export type VogelVaultMember = "victor" | "rachel" | "mason" | "maddox"
export type VogelVaultBtcScope = "visible" | "netWorth"

export interface VogelVaultTransactionRow {
  readonly txId: string
  readonly owner: VogelVaultMember
  readonly date: string
  readonly month: string
  readonly merchant: string
  readonly amountCents: bigint
  /** Signed budget contribution: positive spend, negative credit, zero income. */
  readonly spendAmount: bigint
  /** Rendering magnitude of spendAmount. */
  readonly displaySpendAmount: bigint
  readonly hasOppositeSpendSign: boolean
  readonly category: string
  readonly card?: string
  readonly note?: string
  readonly updatedAtMs: number
}

export interface VogelVaultTodoRow {
  readonly todoId: string
  readonly owner: VogelVaultMember
  readonly title: string
  readonly done: boolean
  readonly flagged: boolean
  readonly lane?: string
  readonly project?: string
  readonly area?: string
  readonly due?: string
  readonly notes?: string
  readonly priority?: bigint
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly completedAt?: string
  readonly updatedAtMs: number
}

export interface VogelVaultBtcBuyRow {
  readonly buyId: string
  readonly owner: VogelVaultMember
  readonly date: string
  readonly month: string
  readonly source: string
  readonly sats: bigint
  readonly priceUsdCents: bigint
  readonly usdCents: bigint
  readonly note?: string
  readonly status?: string
  readonly costBasisStatus?: string
  readonly loggedBy?: string
  readonly archimedesRequestId?: string
  readonly updatedAtMs: number
}

export interface VogelVaultBtcAccountRow {
  readonly key: string
  readonly owner: VogelVaultMember
  readonly label: string
  readonly custody: "exchange" | "self_custody"
  readonly sats: bigint
  readonly fiatCents: bigint
  readonly asOf: string
  readonly schemaVersion: bigint
  readonly updatedAtMs: number
}

export interface VogelVaultBtcBillPayRow {
  readonly billPayId: string
  readonly owner: VogelVaultMember
  readonly date: string
  readonly month: string
  readonly merchant: string
  readonly category: string
  readonly amountUsdCents: bigint
  readonly btcSpentSats: bigint
  readonly btcPriceCents: bigint
  readonly platform?: string
  readonly note?: string
  readonly feeUsdCents: bigint
  readonly reference?: string
  readonly updatedAtMs: number
}

export interface VogelVaultIncomeRow {
  readonly incomeId: string
  readonly owner: VogelVaultMember
  readonly date: string
  readonly month: string
  readonly amountCents: bigint
  readonly source: string
  readonly loggedBy?: string
  readonly note?: string
  readonly archimedesRequestId?: string
  readonly updatedAtMs: number
}

export interface VogelVaultBtcBalanceAccount {
  readonly key: string
  readonly label: string
  readonly custody: "exchange" | "self_custody"
  readonly sats: bigint
  readonly fiatCents: bigint
}

export interface VogelVaultBtcBalanceTotals {
  readonly sats: bigint
  readonly fiatCents: bigint
  readonly exchangeSats: bigint
  readonly selfCustodySats: bigint
}

export interface VogelVaultBtcBalanceDocument {
  readonly owner: VogelVaultMember
  readonly schemaVersion: bigint
  readonly asOf: string
  readonly accounts: readonly VogelVaultBtcBalanceAccount[]
  readonly totals: VogelVaultBtcBalanceTotals
  readonly source?: string
  readonly basis?: string
  readonly confidence?: string
  readonly updatedAtMs: number
}

export interface VogelVaultBudgetCategory {
  readonly name: string
  readonly icon?: string
  readonly budgetCents: bigint
}

export interface VogelVaultBudgetPaycheck {
  readonly date: string
  readonly platform?: string
  readonly source?: string
  readonly amountCents: bigint
  readonly netCents: bigint
  readonly note?: string
}

export interface VogelVaultBudgetIncome {
  readonly weeklyGrossCents: bigint
  readonly weeklyStrikeCents: bigint
  readonly weeklyRiverCents: bigint
  readonly payFrequency?: string
  readonly monthlyGrossCents: bigint
  readonly mtdIncomeCents: bigint
  readonly ytdIncomeCents: bigint
  readonly paychecks: readonly VogelVaultBudgetPaycheck[]
}

export interface VogelVaultBudgetHistoryEntry {
  readonly month: string
  readonly incomeCents: bigint
  readonly expensesCents: bigint
  readonly savingsBps: number
}

export interface VogelVaultBudgetDocument {
  readonly owner: VogelVaultMember
  readonly month: string
  readonly coinbaseOneBalanceCents: bigint
  readonly categories: readonly VogelVaultBudgetCategory[]
  readonly effectiveApr?: string
  readonly strategyNote?: string
  readonly income?: VogelVaultBudgetIncome
  readonly mtdIncomeCents: bigint
  readonly ytdIncomeCents: bigint
  readonly monthlyHistory: readonly VogelVaultBudgetHistoryEntry[]
  readonly updatedAtMs: number
}

export interface VogelVaultBtcSnapshotMeta {
  readonly owner: VogelVaultMember
  readonly schemaVersion: bigint
  readonly asOf: string
  readonly source?: string
  readonly basis?: string
  readonly confidence?: string
  readonly updatedAtMs: number
}

export interface VogelVaultRowCounts {
  readonly transactions: number
  readonly todos: number
  readonly btcBuys: number
  readonly btcBillPays: number
  readonly btcAccounts: number
  readonly income: number
  readonly balanceDocuments: number
  readonly budgetDocuments: number
  readonly btcBalanceDocuments: number
  readonly financeDocuments: number
}

export type VogelVaultRowRequest =
  | {
      readonly kind: "rowCounts"
    }
  | {
      readonly kind: "transactions"
      readonly viewer: VogelVaultMember
      readonly month?: string
      readonly limit?: number
    }
  | {
      readonly kind: "todos"
      readonly viewer: VogelVaultMember
      readonly done?: boolean
      readonly limit?: number
    }
  | {
      readonly kind: "income"
      readonly viewer: VogelVaultMember
      readonly month?: string
      readonly limit?: number
    }
  | {
      readonly kind: "btcBuys"
      readonly viewer: VogelVaultMember
      readonly scope: VogelVaultBtcScope
      readonly month?: string
      readonly limit?: number
    }
  | {
      readonly kind: "btcAccounts"
      readonly viewer: VogelVaultMember
      readonly scope: VogelVaultBtcScope
    }
  | {
      readonly kind: "btcBillPays"
      readonly viewer: VogelVaultMember
      readonly scope: VogelVaultBtcScope
      readonly month?: string
      readonly limit?: number
    }
  | {
      readonly kind: "budget"
      readonly viewer: VogelVaultMember
      readonly scope: "netWorth"
    }
  | {
      readonly kind: "btcSnapshotMeta"
      readonly viewer: VogelVaultMember
      readonly scope: VogelVaultBtcScope
    }
  | {
      readonly kind: "btcBalanceDocuments"
      readonly viewer: VogelVaultMember
      readonly scope: VogelVaultBtcScope
    }

export type VogelVaultRowSuccess =
  | {
      readonly status: "ok"
      readonly kind: "rowCounts"
      readonly value: VogelVaultRowCounts
    }
  | {
      readonly status: "ok"
      readonly kind: "transactions"
      readonly rows: readonly VogelVaultTransactionRow[]
      readonly complete: boolean
    }
  | {
      readonly status: "ok"
      readonly kind: "todos"
      readonly rows: readonly VogelVaultTodoRow[]
      readonly complete: boolean
    }
  | {
      readonly status: "ok"
      readonly kind: "income"
      readonly rows: readonly VogelVaultIncomeRow[]
      readonly complete: boolean
    }
  | {
      readonly status: "ok"
      readonly kind: "btcBuys"
      readonly rows: readonly VogelVaultBtcBuyRow[]
      readonly complete: boolean
    }
  | {
      readonly status: "ok"
      readonly kind: "btcAccounts"
      readonly rows: readonly VogelVaultBtcAccountRow[]
      readonly complete: boolean
    }
  | {
      readonly status: "ok"
      readonly kind: "btcBillPays"
      readonly rows: readonly VogelVaultBtcBillPayRow[]
      readonly complete: boolean
    }
  | {
      readonly status: "ok"
      readonly kind: "budget"
      readonly value: VogelVaultBudgetDocument | null
    }
  | {
      readonly status: "ok"
      readonly kind: "btcSnapshotMeta"
      readonly rows: readonly VogelVaultBtcSnapshotMeta[]
      readonly complete: boolean
    }
  | {
      readonly status: "ok"
      readonly kind: "btcBalanceDocuments"
      readonly rows: readonly VogelVaultBtcBalanceDocument[]
      readonly complete: boolean
    }

/** Closed, locally authored failures. No remote text or configuration detail crosses IPC. */
export type VogelVaultRowErrorCode =
  | "disabled"
  | "unconfigured"
  | "unauthorized"
  | "unavailable"
  | "invalid-request"
  | "invalid-response"
  | "response-too-large"
  | "incomplete-response"

export type VogelVaultRowResult =
  | VogelVaultRowSuccess
  | { readonly status: "error"; readonly code: VogelVaultRowErrorCode }
