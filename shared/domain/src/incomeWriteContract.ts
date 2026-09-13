import { encodeConvexInt64, type ConvexInt64WireValue } from "./convexInt64.ts"
import { isFamilyMember, ledgerOwner, type FamilyMember } from "./family.ts"
import { isIsoDate } from "./todo.ts"
import { CONVEX_WRITE_FORMAT, WriteContractError, parseWriteInt64 } from "./writeContract.ts"

export const UPSERT_INCOME_FROM_DEVICE_PATH = "tables:upsertIncomeFromDevice" as const
export const DELETE_INCOME_FROM_DEVICE_PATH = "tables:deleteIncomeFromDevice" as const

export interface IncomeWriteRequest {
  readonly path: typeof UPSERT_INCOME_FROM_DEVICE_PATH
  readonly format: typeof CONVEX_WRITE_FORMAT
  readonly args: {
    readonly owner: FamilyMember
    readonly sourceFile: "income"
    readonly baseUpdatedAtMs?: number
    readonly income: {
      readonly id: string
      readonly owner: FamilyMember
      readonly date: string
      readonly amountCents: ConvexInt64WireValue
      readonly source: string
      readonly note?: string
    }
  }
}

/** Credentials are attached by the transport, never persisted in this request. */
export function buildIncomeWriteRequest(actor: unknown, candidate: unknown): IncomeWriteRequest {
  const record = requiredRecord(candidate)
  const income = requiredRecord(record.income)
  const owner = boundOwner(actor, record.owner)
  if (!isFamilyMember(income.owner) || ledgerOwner(income.owner) !== owner) {
    throw new WriteContractError("invalid-owner", "Income owner must match the request owner")
  }
  if (record.sourceFile !== "income") {
    throw new WriteContractError("source-owner-mismatch", 'sourceFile must be "income"')
  }
  const id = identifier(income.id)
  const date = requiredText(income.date, "date")
  if (!isIsoDate(date)) throw new WriteContractError("invalid-date", "Income needs a real yyyy-MM-dd date")
  const amount = parseWriteInt64(income.amountCents)
  if (amount <= 0n) throw new WriteContractError("invalid-input", "Income amountCents must be positive")
  const source = requiredText(income.source, "source")
  const note = income.note
  if (note !== undefined && (typeof note !== "string" || note.length > 16384 || /[\u0000-\u001f\u007f]/.test(note))) {
    throw new WriteContractError("invalid-input", "Income note must be text no longer than 16384 characters")
  }
  const revision = optionalRevision(record.baseUpdatedAtMs)
  return {
    path: UPSERT_INCOME_FROM_DEVICE_PATH, format: CONVEX_WRITE_FORMAT,
    args: { owner, sourceFile: "income", ...(revision === undefined ? {} : { baseUpdatedAtMs: revision }),
      income: { id, owner, date, amountCents: encodeConvexInt64(amount), source,
        ...(note === undefined ? {} : { note }) } },
  }
}

export function buildIncomeDeleteRequest(actor: unknown, candidate: unknown) {
  const record = requiredRecord(candidate)
  const owner = boundOwner(actor, record.owner)
  if (record.sourceFile !== "income") {
    throw new WriteContractError("source-owner-mismatch", 'sourceFile must be "income"')
  }
  const revision = optionalRevision(record.baseUpdatedAtMs)
  if (revision === undefined) throw new WriteContractError("invalid-input", "Income deletion requires baseUpdatedAtMs")
  return { path: DELETE_INCOME_FROM_DEVICE_PATH, format: CONVEX_WRITE_FORMAT,
    args: { owner, sourceFile: "income" as const, entityId: identifier(record.entityId), baseUpdatedAtMs: revision } }
}

function boundOwner(actor: unknown, owner: unknown): FamilyMember {
  if (!isFamilyMember(actor) || !isFamilyMember(owner) || ledgerOwner(actor) !== ledgerOwner(owner)) {
    throw new WriteContractError("write-not-authorized", "Income owner must match the active profile ledger")
  }
  return ledgerOwner(owner)
}
function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WriteContractError("invalid-input", "Income request must be an object")
  }
  return value as Record<string, unknown>
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WriteContractError("invalid-input", `${field} must be nonempty text no longer than 16384 characters`)
  }
  return value
}
function identifier(value: unknown): string {
  const id = requiredText(value, "id")
  if (id.length > 256 || id !== id.trim()) throw new WriteContractError("invalid-input", "Income id is too long")
  return id
}
function optionalRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WriteContractError("invalid-input", "baseUpdatedAtMs must be a nonnegative safe integer")
  }
  return value
}
