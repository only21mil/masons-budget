import { type FamilyMember, ledgerOwner } from "./family.ts"
import { isConvexInt64 } from "./convexInt64.ts"
import type { BTCBillPay, Transaction } from "./readModel.ts"
import { spendAmount } from "./readModel.ts"
import { isIsoDate } from "./todo.ts"

export interface MoneyOutTransactionSource {
  readonly kind: "transaction"
  readonly row: Transaction
  readonly contributionCents: bigint
}

export interface MoneyOutBillPaySource {
  readonly kind: "btc_bill_pay"
  readonly row: BTCBillPay
  readonly principalCents: bigint
  readonly feeUsdCents: bigint
  readonly contributionCents: bigint
}

export type MoneyOutTodaySource = MoneyOutTransactionSource | MoneyOutBillPaySource

export interface MoneyOutToday {
  readonly date: string
  readonly owner: FamilyMember
  readonly totalCents: bigint
  readonly sources: readonly MoneyOutTodaySource[]
}

/**
 * Derive Money Out Today from the injected calendar day and source ledgers.
 * Adults use the canonical adult owner. Children use their exact profile owner.
 */
export function deriveMoneyOutToday(input: {
  readonly activeProfile: FamilyMember
  readonly date: string
  readonly transactions: readonly Transaction[]
  readonly billPays: readonly BTCBillPay[]
}): MoneyOutToday {
  if (!isIsoDate(input.date)) {
    throw new RangeError("date must be a real ISO calendar date in yyyy-MM-dd form")
  }

  const owner = ledgerOwner(input.activeProfile)
  const transactionSources: MoneyOutTransactionSource[] = input.transactions
    .filter((row) =>
      ledgerOwner(row.owner) === owner &&
      row.date === input.date &&
      row.category.toLowerCase() !== "income" &&
      row.category.toLowerCase() !== "credit card payment"
    )
    .map((row) => ({ kind: "transaction", row, contributionCents: spendAmount(row) }))
  const billPaySources: MoneyOutBillPaySource[] = input.billPays
    .filter((row) =>
      ledgerOwner(row.owner) === owner &&
      row.date === input.date &&
      row.budgetEffect !== "credit_card_payment"
    )
    .map((row) => ({
      kind: "btc_bill_pay",
      row,
      principalCents: row.amountUsd,
      feeUsdCents: row.feeUsd,
      contributionCents: checkedCentsAdd(row.amountUsd, row.feeUsd),
    }))
  const sources: MoneyOutTodaySource[] = [...transactionSources, ...billPaySources]

  return {
    date: input.date,
    owner,
    totalCents: sources.reduce(
      (total, source) => checkedCentsAdd(total, source.contributionCents),
      0n,
    ),
    sources,
  }
}

function checkedCentsAdd(left: bigint, right: bigint): bigint {
  const total = left + right
  if (!isConvexInt64(left) || !isConvexInt64(right) || !isConvexInt64(total)) {
    throw new RangeError("Money Out Today cents must fit signed int64")
  }
  return total
}
