import { encodeConvexInt64, type ConvexInt64WireValue } from "./convexInt64.ts"
import { isAdult, isFamilyMember, ledgerOwner, type FamilyMember } from "./family.ts"
import { isIsoDate } from "./todo.ts"
import { parseManualFeeUsdCents } from "./manualFee.ts"
import {
  CONVEX_WRITE_FORMAT,
  WriteContractError,
  parseWriteInt64,
} from "./writeContract.ts"

export const UPSERT_LINKED_INCOME_BUY_PATH = "tables:upsertBtcBuy" as const

export interface LinkedIncomeBuyWriteRequest {
  readonly path: typeof UPSERT_LINKED_INCOME_BUY_PATH
  readonly format: typeof CONVEX_WRITE_FORMAT
  readonly args: {
    readonly sourceFile: "bitcoin-buys"
    readonly buy: {
      readonly id: string
      readonly owner: "victor"
      readonly date: string
      readonly source: string
      readonly sats: ConvexInt64WireValue
      readonly priceUsdCents: ConvexInt64WireValue
      readonly usdCents: ConvexInt64WireValue
      readonly feeUsdCents: ConvexInt64WireValue
      readonly note?: string
    }
    readonly linkedIncome: {
      readonly id: string
      readonly owner: "victor"
      readonly date: string
      readonly amountCents: ConvexInt64WireValue
      readonly source: string
      readonly sourceFile: "income"
      readonly note?: string
    }
  }
}

/**
 * Describe one atomic canonical-income plus Bitcoin-buy request.
 *
 * The same stable caller-generated id identifies both rows. The buy is the only
 * side that carries sats, so retrying the pair cannot post the Bitcoin twice.
 */
export function buildLinkedIncomeBuyWriteRequest(
  actor: unknown,
  candidate: unknown,
): LinkedIncomeBuyWriteRequest {
  if (!isFamilyMember(actor) || !isAdult(actor)) {
    throw new WriteContractError(
      "write-not-authorized",
      "Linked Bitcoin-buy income is available only to an adult household actor",
    )
  }
  const record = requiredRecord(candidate, "Linked income Bitcoin buy")
  if (record.sourceFile !== "bitcoin-buys") {
    throw new WriteContractError("source-owner-mismatch", 'sourceFile must be "bitcoin-buys"')
  }

  const buy = requiredRecord(record.buy, "buy")
  const income = requiredRecord(record.linkedIncome, "linkedIncome")
  const buyOwner = canonicalAdultOwner(buy.owner, "buy.owner")
  const incomeOwner = canonicalAdultOwner(income.owner, "linkedIncome.owner")
  const id = requiredString(buy.id, "buy.id")
  const date = requiredDate(buy.date, "buy.date")
  const usdCents = positiveInt64(buy.usdCents, "buy.usdCents")
  let feeUsdCents: bigint
  try {
    feeUsdCents = parseManualFeeUsdCents(buy.feeUsdCents)
  } catch (error) {
    const message = error instanceof Error ? error.message : "buy.feeUsdCents is invalid"
    throw new WriteContractError(
      message.includes("int64") ? "int64-out-of-range" : "invalid-minor-units",
      message,
    )
  }

  if (
    requiredString(income.id, "linkedIncome.id") !== id ||
    requiredDate(income.date, "linkedIncome.date") !== date ||
    incomeOwner !== buyOwner
  ) {
    throw new WriteContractError(
      "invalid-input",
      "linkedIncome must have the same id, owner, and date as buy",
    )
  }
  if (income.sourceFile !== "income") {
    throw new WriteContractError(
      "source-owner-mismatch",
      'linkedIncome.sourceFile must be "income"',
    )
  }
  const amountCents = positiveInt64(income.amountCents, "linkedIncome.amountCents")
  if (amountCents !== usdCents) {
    throw new WriteContractError(
      "invalid-input",
      "linkedIncome.amountCents must equal buy.usdCents",
    )
  }

  const note = optionalString(buy.note, "buy.note")
  const incomeNote = optionalString(income.note, "linkedIncome.note")
  return {
    path: UPSERT_LINKED_INCOME_BUY_PATH,
    format: CONVEX_WRITE_FORMAT,
    args: {
      sourceFile: "bitcoin-buys",
      buy: {
        id,
        owner: buyOwner,
        date,
        source: requiredString(buy.source, "buy.source"),
        sats: encodeConvexInt64(positiveInt64(buy.sats, "buy.sats")),
        priceUsdCents: encodeConvexInt64(
          positiveInt64(buy.priceUsdCents, "buy.priceUsdCents"),
        ),
        usdCents: encodeConvexInt64(usdCents),
        feeUsdCents: encodeConvexInt64(feeUsdCents),
        ...(note === undefined ? {} : { note }),
      },
      linkedIncome: {
        id,
        owner: incomeOwner,
        date,
        amountCents: encodeConvexInt64(amountCents),
        source: requiredString(income.source, "linkedIncome.source"),
        sourceFile: "income",
        ...(incomeNote === undefined ? {} : { note: incomeNote }),
      },
    },
  }
}

function canonicalAdultOwner(value: unknown, field: string): "victor" {
  if (!isFamilyMember(value) || !isAdult(value)) {
    throw new WriteContractError("invalid-owner", `${field} must name an adult household owner`)
  }
  const owner: FamilyMember = ledgerOwner(value)
  if (owner !== "victor") throw new WriteContractError("invalid-owner", `${field} is unsupported`)
  return owner
}

function positiveInt64(value: unknown, field: string): bigint {
  const parsed = parseWriteInt64(value)
  if (parsed <= 0n) {
    throw new WriteContractError("invalid-input", `${field} must be positive`)
  }
  return parsed
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WriteContractError("invalid-input", `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WriteContractError("invalid-input", `${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new WriteContractError("invalid-input", `${field} must be a string when present`)
  }
  return value
}

function requiredDate(value: unknown, field: string): string {
  const date = requiredString(value, field)
  if (!isIsoDate(date)) {
    throw new WriteContractError("invalid-date", `${field} must be a real yyyy-MM-dd date`)
  }
  return date
}
