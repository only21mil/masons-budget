// Plain serialisable contracts shared by Electron main/preload and the renderer.
// No Node or Electron types belong here.

export type VogelVaultMember = "victor" | "rachel" | "mason" | "maddox"
export type VogelVaultBtcScope = "visible" | "netWorth"

/** Main-owned profile session result; it carries no credential or capability value. */
export type VogelVaultReadProfileResult =
  | { readonly status: "active"; readonly profile: VogelVaultMember }
  | { readonly status: "rejected" }

export interface VogelVaultFiatValuation {
  readonly cents: bigint
  readonly priceCents?: bigint
  readonly quotedAt?: string
  readonly source?: string
  readonly confidence?: string
}

/**
 * Income row written atomically with the Bitcoin buy it funded.
 *
 * One user action, one write. The buy carries the only BTC balance posting, so
 * this block never travels with `amountSats` on a separate Income transaction —
 * both credit River and doing both would double the stack. `id`, `owner` and
 * `date` must equal the enclosing buy's, and `amountCents` must equal its
 * `usdCents`; the server rejects the write otherwise.
 */
export interface VogelVaultLinkedIncome {
  readonly id: string
  readonly owner: VogelVaultMember
  readonly date: string
  readonly amountCents: bigint
  readonly source: string
  readonly note?: string
  readonly loggedBy?: string
}

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
  readonly amountSats?: bigint
  readonly bitcoinAccountKey?: string
  readonly balancePostingVersion?: bigint
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
  /** Transition-only mirror; render fiatValuation instead. */
  readonly fiatCents: bigint
  readonly fiatValuation?: VogelVaultFiatValuation | null
  readonly asOf: string
  readonly schemaVersion: bigint
  readonly updatedAtMs: number
}

/**
 * Whether a bill pay comes out of a budget category or is a credit-card
 * payment that contributes no budget spend. Closed set; persist the wire
 * string, never a label.
 */
export type VogelVaultBillPayBudgetEffect = "budget_category" | "credit_card_payment"

export interface VogelVaultBtcBillPayRow {
  readonly billPayId: string
  readonly owner: VogelVaultMember
  readonly date: string
  readonly month: string
  readonly merchant: string
  readonly category: string
  /** Absent on rows written before the bill-pay budget amendment. */
  readonly budgetEffect?: VogelVaultBillPayBudgetEffect
  readonly amountUsdCents: bigint
  readonly btcSpentSats: bigint
  readonly btcPriceCents: bigint
  readonly platform?: string
  readonly note?: string
  readonly feeUsdCents: bigint
  readonly reference?: string
  readonly updatedAtMs: number
}

export interface VogelVaultBtcTransferRow {
  readonly transferId: string
  readonly owner: VogelVaultMember
  readonly date: string
  readonly month: string
  readonly fromAccountKey: string
  readonly toAccountKey: string
  readonly sats: bigint
  readonly feeSats: bigint
  readonly note?: string
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
  /** Transition-only mirror; render fiatValuation instead. */
  readonly fiatCents: bigint
  readonly fiatValuation?: VogelVaultFiatValuation | null
}

export interface VogelVaultBtcBalanceTotals {
  readonly sats: bigint
  /** Transition-only mirror; render fiatValuation instead. */
  readonly fiatCents: bigint
  readonly fiatValuation?: VogelVaultFiatValuation | null
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
  /** Confidence in the sats balance only. */
  readonly balanceConfidence?: string
  /** Transition-only alias for balanceConfidence. */
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

export interface VogelVaultFinanceLot {
  readonly date: string
  readonly type: string
  readonly pricePerShareCents: bigint
  readonly sharesDecimal: string
  readonly amountInvestedCents: bigint
  readonly note?: string
}

export interface VogelVaultFinanceHolding {
  readonly name: string
  readonly category: string
  readonly ticker?: string
  readonly valueCents: bigint
  readonly costBasisCents: bigint
  readonly gainBps: bigint
  readonly sharesDecimal: string
  readonly avgCostCents: bigint
  readonly currentPricePerShareCents: bigint
  readonly isProxy: boolean
  readonly proxyNote?: string
  readonly lots: readonly VogelVaultFinanceLot[]
}

export interface VogelVaultFinanceAccount {
  readonly key: string
  readonly owner: VogelVaultMember
  readonly provider: string
  readonly totalValueCents: bigint
  readonly weeklyContributionCents: bigint
  readonly weeklyContributionDay?: string
  readonly holdings: readonly VogelVaultFinanceHolding[]
}

/** Already account-scoped by the authenticated Convex query. */
export interface VogelVaultFinanceDocument {
  readonly lastUpdated: string
  readonly retirementTotalCents?: bigint
  readonly accounts: readonly VogelVaultFinanceAccount[]
  readonly updatedAtMs: number
}

export type VogelVaultMarketSymbol = "BTC" | "VOO" | "IBIT"
export type VogelVaultMarketQuoteStatus = "live" | "stale" | "unavailable"

export interface VogelVaultMarketQuote {
  readonly symbol: VogelVaultMarketSymbol
  readonly priceCents: bigint | null
  readonly source: string
  readonly fetchedAt: string | null
  readonly status: VogelVaultMarketQuoteStatus
}

/** Structurally complete even when one or more observations are unavailable. */
export interface VogelVaultMarketQuoteSnapshot {
  readonly quotes: readonly VogelVaultMarketQuote[]
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
  readonly btcTransfers: number
  readonly btcAccounts: number
  readonly income: number
  readonly balanceDocuments: number
  readonly budgetDocuments: number
  readonly btcBalanceDocuments: number
  readonly financeDocuments: number
}

/** Renderer-selected query shape. Main injects its per-sender profile after validation. */
export type VogelVaultRowRequest =
  | {
      readonly kind: "rowCounts"
    }
  | {
      readonly kind: "transactions"
      readonly month?: string
      readonly limit?: number
    }
  | {
      readonly kind: "todos"
      readonly done?: boolean
      readonly limit?: number
    }
  | {
      readonly kind: "income"
      readonly month?: string
      readonly limit?: number
    }
  | {
      readonly kind: "btcBuys"
      readonly scope: VogelVaultBtcScope
      readonly month?: string
      readonly limit?: number
    }
  | {
      readonly kind: "btcAccounts"
      readonly scope: VogelVaultBtcScope
    }
  | {
      readonly kind: "btcBillPays"
      readonly scope: VogelVaultBtcScope
      readonly month?: string
      readonly limit?: number
    }
  | {
      readonly kind: "btcTransfers"
      readonly scope: VogelVaultBtcScope
      readonly month?: string
      readonly limit?: number
    }
  | {
      readonly kind: "budget"
      readonly scope: "netWorth"
    }
  | {
      readonly kind: "btcSnapshotMeta"
      readonly scope: VogelVaultBtcScope
    }
  | {
      readonly kind: "btcBalanceDocuments"
      readonly scope: VogelVaultBtcScope
    }
  | {
      readonly kind: "finance"
      readonly scope: "netWorth"
    }
  | {
      /** Fixed BTC/VOO/IBIT query: the renderer cannot choose a symbol or URL. */
      readonly kind: "marketQuotes"
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
      readonly kind: "btcTransfers"
      readonly rows: readonly VogelVaultBtcTransferRow[]
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
  | {
      readonly status: "ok"
      readonly kind: "finance"
      readonly value: VogelVaultFinanceDocument | null
    }
  | {
      readonly status: "ok"
      readonly kind: "marketQuotes"
      readonly value: VogelVaultMarketQuoteSnapshot
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

// ── Paired-device writes ───────────────────────────────────────────────────
//
// This is the complete renderer-facing write vocabulary. It intentionally
// contains domain values only: deployment routing and device credentials stay
// on the main-process side of the boundary.

export type VogelVaultMutationKind =
  | "transaction.upsert"
  | "transaction.delete"
  | "todo.upsert"
  | "todo.delete"
  | "budgetCategory.upsert"
  | "budgetCategory.delete"
  | "btcBuy.upsert"
  | "btcBuy.delete"
  | "btcBillPay.upsert"
  | "btcBillPay.delete"
  | "btcTransfer.upsert"
  | "btcTransfer.delete"
  | "btcAccount.upsert"
  | "btcAccount.delete"

interface VogelVaultMutationBase {
  /** Correlates an optimistic renderer revision with exactly one reply. */
  readonly requestId: string
  /**
   * Non-authoritative UI intent for local audit/telemetry only.
   *
   * A paired Linux credential is household-wide authority. Neither main nor
   * Convex uses this renderer-controlled value to grant access.
   */
  readonly actor: VogelVaultMember
}

export type VogelVaultMutationRequest =
  | (VogelVaultMutationBase & {
      readonly kind: "transaction.upsert"
      readonly id: string
      readonly owner: VogelVaultMember
      readonly date: string
      readonly merchant: string
      readonly amountCents: bigint
      readonly transactionKind: "spend" | "credit"
      readonly category: string
      readonly card?: string
      readonly note?: string
      /** Present for sat-Income and for a Bitcoin-denominated payment source. */
      readonly amountSats?: bigint
      /** Required by the payment-source contract for lightning and on_chain. */
      readonly bitcoinAccountKey?: string
      /** Omit only for a create whose natural key has never existed. */
      readonly baseUpdatedAtMs?: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "transaction.delete"
      readonly id: string
      readonly owner: VogelVaultMember
      readonly baseUpdatedAtMs: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "todo.upsert"
      readonly id: string
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
      /** Omit only for a create whose natural key has never existed. */
      readonly baseUpdatedAtMs?: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "todo.delete"
      readonly id: string
      readonly owner: VogelVaultMember
      readonly baseUpdatedAtMs: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "budgetCategory.upsert"
      readonly owner: VogelVaultMember
      readonly month: string
      readonly name: string
      /** Previous category name when this write is an atomic rename. */
      readonly originalName?: string
      readonly icon?: string
      readonly budgetCents: bigint
      /** Enclosing budget-document revision; omit only when the document is new. */
      readonly baseUpdatedAtMs?: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "budgetCategory.delete"
      readonly owner: VogelVaultMember
      readonly month: string
      readonly name: string
      /** Enclosing budget-document revision. */
      readonly baseUpdatedAtMs: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "btcBuy.upsert"
      readonly id: string
      readonly owner: VogelVaultMember
      readonly date: string
      readonly source: string
      readonly sats: bigint
      readonly priceUsdCents: bigint
      readonly usdCents: bigint
      readonly note?: string
      readonly buyStatus?: string
      readonly costBasisStatus?: string
      readonly loggedBy?: string
      readonly archimedesRequestId?: string
      /** Present only when this buy was funded by income saved in the same action. */
      readonly linkedIncome?: VogelVaultLinkedIncome
      /** Omit only for a create whose natural key has never existed. */
      readonly baseUpdatedAtMs?: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "btcBuy.delete"
      readonly id: string
      readonly owner: VogelVaultMember
      readonly baseUpdatedAtMs: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "btcBillPay.upsert"
      readonly id: string
      readonly owner: VogelVaultMember
      readonly date: string
      readonly merchant: string
      readonly category: string
      /**
       * Required on every new client write. "credit_card_payment" must carry
       * the canonical "Credit Card Payment" category and contributes no
       * budget spend; "budget_category" requires a real selected category.
       */
      readonly budgetEffect: VogelVaultBillPayBudgetEffect
      readonly amountUsdCents: bigint
      readonly btcSpentSats: bigint
      readonly btcPriceCents: bigint
      readonly platform?: string
      readonly note?: string
      readonly feeUsdCents: bigint
      readonly reference?: string
      /** Omit only for a create whose natural key has never existed. */
      readonly baseUpdatedAtMs?: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "btcBillPay.delete"
      readonly id: string
      readonly owner: VogelVaultMember
      readonly baseUpdatedAtMs: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "btcTransfer.upsert"
      readonly id: string
      readonly owner: VogelVaultMember
      readonly date: string
      readonly fromAccountKey: string
      readonly toAccountKey: string
      readonly sats: bigint
      readonly feeSats: bigint
      readonly note?: string
      /** Omit only for a create whose natural key has never existed. */
      readonly baseUpdatedAtMs?: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "btcTransfer.delete"
      readonly id: string
      readonly owner: VogelVaultMember
      readonly baseUpdatedAtMs: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "btcAccount.upsert"
      readonly key: string
      readonly owner: VogelVaultMember
      readonly label: string
      readonly custody: "exchange" | "self_custody"
      readonly sats: bigint
      readonly asOf: string
      readonly schemaVersion?: bigint
      /**
       * Optional only when supplied by an authoritative source. The renderer
       * must not derive or invent a fiat valuation from the displayed BTC price.
       */
      readonly fiatValuation?: VogelVaultFiatValuation
      /** Enclosing BTC balance-document revision; omit only when it is new. */
      readonly baseUpdatedAtMs?: number
    })
  | (VogelVaultMutationBase & {
      readonly kind: "btcAccount.delete"
      readonly key: string
      readonly owner: VogelVaultMember
      /** Enclosing BTC balance-document revision. */
      readonly baseUpdatedAtMs: number
    })

export type VogelVaultMutationOutcome =
  | "inserted"
  | "updated"
  | "deleted"
  | "not-found"

/** Locally classified failure detail; never backend-authored text. */
export type VogelVaultMutationFailureCode =
  | "invalid-request"
  | "conflict"
  | "rejected"
  | "unavailable"
  | "invalid-response"
  | "credential-storage"

interface VogelVaultMutationReplyBase {
  readonly requestId: string
  readonly kind: VogelVaultMutationKind
}

/**
 * Exactly six outer states. Every non-success remains closed and text-free so
 * renderer copy is local, stable, and safe to announce.
 */
export type VogelVaultMutationResult =
  | (VogelVaultMutationReplyBase & {
      readonly status: "ok"
      readonly outcome: VogelVaultMutationOutcome
      readonly entityId: string
    })
  | (VogelVaultMutationReplyBase & { readonly status: "disabled" })
  | (VogelVaultMutationReplyBase & { readonly status: "not-configured" })
  | (VogelVaultMutationReplyBase & { readonly status: "unauthorized" })
  | (VogelVaultMutationReplyBase & { readonly status: "missing" })
  | (VogelVaultMutationReplyBase & {
      readonly status: "failed"
      readonly code: VogelVaultMutationFailureCode
    })

export interface VogelVaultPairingRequest {
  /** The complete one-time pairing value pasted or scanned by the user. */
  readonly pairingInput: string
  /** Local display label sent during the one-time claim. */
  readonly deviceName: string
}

export type VogelVaultPairingFailureCode =
  | "invalid-input"
  | "expired"
  | "already-claimed"
  | "cancelled"
  | "server-rejected"
  | "unavailable"
  | "invalid-response"
  | "credential-storage"

export type VogelVaultPairingResult =
  | {
      readonly status: "paired"
      readonly pairedAt: number
      readonly capabilities: readonly VogelVaultMutationKind[]
    }
  | { readonly status: "disabled" }
  | { readonly status: "failed"; readonly code: VogelVaultPairingFailureCode }

export type VogelVaultPairingStatus =
  | {
      readonly status: "paired"
      readonly pairedAt: number
      readonly capabilities: readonly VogelVaultMutationKind[]
      /** Effective local write switch and approved-origin state. */
      readonly writesEnabled: boolean
    }
  | { readonly status: "unpaired"; readonly writesEnabled: boolean }
  | { readonly status: "unavailable" }

export type VogelVaultUnpairResult =
  | { readonly status: "ok"; readonly revoked: boolean }
  | { readonly status: "unpaired" }
  | { readonly status: "cancelled" }
  | { readonly status: "unavailable" }
  | { readonly status: "failed" }
