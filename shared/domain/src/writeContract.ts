// The Vogel Vault — shared Convex row-write contract.
//
// This module validates client intent before a real mutation reaches Convex.
// The server remains authoritative and independently enforces these invariants.
// Credentials are intentionally outside this contract: clients inject the sync
// token at runtime after building and validating the non-secret request body.

import { encodeConvexInt64, type ConvexInt64WireValue } from "./convexInt64.ts"
import {
  type FamilyMember,
  canSeeDataOwnedBy,
  isFamilyMember,
  transactionsDataFileName,
} from "./family.ts"

export const CONVEX_WRITE_FORMAT = "convex_encoded_json" as const
export const UPSERT_TRANSACTION_PATH = "tables:upsertTransaction" as const

export type TransactionWriteKind = "spend" | "credit"

export type WriteContractErrorCode =
  | "invalid-actor"
  | "invalid-input"
  | "invalid-owner"
  | "write-not-authorized"
  | "invalid-minor-units"
  | "int64-out-of-range"
  | "zero-amount"
  | "income-must-be-credit"
  | "sign-disagrees"
  | "source-owner-mismatch"

export class WriteContractError extends Error {
  readonly code: WriteContractErrorCode

  constructor(code: WriteContractErrorCode, message: string) {
    super(message)
    this.name = "WriteContractError"
    this.code = code
  }
}

export interface TransactionWriteInput {
  readonly id: string
  readonly date: string
  readonly merchant: string
  /** Exact signed integer cents. Never dollars and never a JSON number. */
  readonly amountCents: string | bigint
  readonly kind: TransactionWriteKind
  readonly category: string
  readonly owner: FamilyMember
  readonly sourceFile: string
  readonly card?: string
  readonly note?: string
}

export interface TransactionWriteWire {
  readonly id: string
  readonly date: string
  readonly merchant: string
  readonly amountCents: ConvexInt64WireValue
  readonly kind: TransactionWriteKind
  readonly category: string
  readonly owner: FamilyMember
  readonly card?: string
  readonly note?: string
}

export interface TransactionWriteRequest {
  readonly path: typeof UPSERT_TRANSACTION_PATH
  readonly format: typeof CONVEX_WRITE_FORMAT
  readonly args: {
    readonly transaction: TransactionWriteWire
    readonly sourceFile: string
  }
}

/**
 * Write scope deliberately matches household visibility: adults may write the
 * shared household and either child's data; children may write only their own.
 * The sync token still gates the mutation at the transport/server boundary.
 */
export function canWriteDataOwnedBy(actor: FamilyMember, owner: FamilyMember): boolean {
  return canSeeDataOwnedBy(actor, owner)
}

/** Parse an exact integer minor-unit value without passing through float. */
export function parseWriteInt64(value: unknown): bigint {
  if (typeof value === "bigint") {
    return assertInt64Range(value)
  }
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
    throw new WriteContractError(
      "invalid-minor-units",
      "Minor units must be an exact base-10 integer string or bigint",
    )
  }

  return assertInt64Range(BigInt(value))
}

/**
 * Validate and encode one `tables:upsertTransaction` request.
 *
 * The returned args intentionally omit `token`; transport code must inject the
 * runtime secret centrally so fixtures and domain values never carry it.
 */
export function buildTransactionWriteRequest(
  actor: unknown,
  candidate: unknown,
): TransactionWriteRequest {
  if (!isFamilyMember(actor)) {
    throw new WriteContractError("invalid-actor", "Write actor must be a known family member")
  }
  if (!isRecord(candidate)) {
    throw new WriteContractError("invalid-input", "Transaction write input must be an object")
  }

  const owner = candidate.owner
  if (!isFamilyMember(owner)) {
    throw new WriteContractError("invalid-owner", "Transaction owner must be a known family member")
  }
  if (!canWriteDataOwnedBy(actor, owner)) {
    throw new WriteContractError(
      "write-not-authorized",
      `${actor} may not write data owned by ${owner}`,
    )
  }

  const sourceFile = requiredString(candidate.sourceFile, "sourceFile")
  const expectedSource = transactionsDataFileName(owner)
  if (sourceFile !== expectedSource) {
    throw new WriteContractError(
      "source-owner-mismatch",
      `Transaction source "${sourceFile}" does not belong to ${owner}; expected "${expectedSource}"`,
    )
  }

  const amountCents = parseWriteInt64(candidate.amountCents)
  const kind = transactionKind(candidate.kind)
  const category = requiredString(candidate.category, "category")
  requireTransactionSign(amountCents, owner, kind, category)

  const transaction: TransactionWriteWire = {
    id: requiredString(candidate.id, "id"),
    date: requiredString(candidate.date, "date"),
    merchant: requiredString(candidate.merchant, "merchant"),
    amountCents: encodeConvexInt64(amountCents),
    kind,
    category,
    owner,
    ...optionalWireString(candidate, "card"),
    ...optionalWireString(candidate, "note"),
  }

  return {
    path: UPSERT_TRANSACTION_PATH,
    format: CONVEX_WRITE_FORMAT,
    args: { transaction, sourceFile },
  }
}

function requireTransactionSign(
  amountCents: bigint,
  owner: FamilyMember,
  kind: TransactionWriteKind,
  category: string,
): void {
  if (amountCents === 0n) {
    throw new WriteContractError("zero-amount", "A zero-value transaction has no sign to check")
  }
  if (category === "Income" && kind !== "credit") {
    throw new WriteContractError(
      "income-must-be-credit",
      'A transaction categorised "Income" must have kind "credit"',
    )
  }

  const expectedNegative = category !== "Income" && kind === "credit"
  if ((amountCents < 0n) !== expectedNegative) {
    throw new WriteContractError(
      "sign-disagrees",
      `A ${kind} for ${owner} must be ${expectedNegative ? "negative" : "positive"}; ` +
        "purchases are positive and refunds are negative for every owner",
    )
  }
}

function assertInt64Range(value: bigint): bigint {
  const minimum = -(1n << 63n)
  const maximum = (1n << 63n) - 1n
  if (value < minimum || value > maximum) {
    throw new WriteContractError("int64-out-of-range", "Minor units must fit signed int64")
  }
  return value
}

function transactionKind(value: unknown): TransactionWriteKind {
  if (value === "spend" || value === "credit") return value
  throw new WriteContractError("invalid-input", 'Transaction kind must be "spend" or "credit"')
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WriteContractError("invalid-input", `${field} must be a non-empty string`)
  }
  return value
}

function optionalWireString(
  record: Record<string, unknown>,
  field: "card" | "note",
): Partial<Pick<TransactionWriteWire, "card" | "note">> {
  const value = record[field]
  if (value === undefined) return {}
  if (typeof value !== "string") {
    throw new WriteContractError("invalid-input", `${field} must be a string when present`)
  }
  return { [field]: value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
