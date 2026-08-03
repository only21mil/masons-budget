// Paired-device enrollment and row mutations. MAIN PROCESS ONLY.
//
// The renderer supplies domain intent. This module supplies the fixed Convex
// path, deployment origin, device identity and credential. There is no generic
// "call a path" escape hatch, and no remote-authored text crosses its results.

import { createHash, randomBytes } from "node:crypto"

import {
  buildTransactionWriteRequest,
  encodeConvexInt64,
  isFamilyMember,
} from "@vogel-vault/domain"

import type {
  VogelVaultFiatValuation,
  VogelVaultMember,
  VogelVaultMutationKind,
  VogelVaultMutationRequest,
  VogelVaultMutationResult,
  VogelVaultPairingResult,
  VogelVaultPairingStatus,
  VogelVaultUnpairResult,
} from "../shared/ipc.ts"
import type {
  DeviceCredentialSnapshot,
  DeviceCredentialStore,
} from "./deviceCredentialStore.ts"
import type { JsonPostResponse, JsonPoster } from "./convexRead.ts"
import { ADULTS } from "./readProfileSession.ts"

export const PAIRED_DEVICE_PATHS = {
  claim: "dataFiles:claimMobilePairing",
  revoke: "dataFiles:revokeMobileDevice",
  "transaction.upsert": "tables:upsertTransactionFromDevice",
  "transaction.delete": "tables:deleteTransactionFromDevice",
  "todo.upsert": "tables:upsertTodoFromDevice",
  "todo.delete": "tables:deleteTodoFromDevice",
  "budgetCategory.upsert": "tables:upsertBudgetCategoryFromDevice",
  "budgetCategory.delete": "tables:deleteBudgetCategoryFromDevice",
  "btcBuy.upsert": "tables:upsertBtcBuyFromDevice",
  "btcBuy.delete": "tables:deleteBtcBuyFromDevice",
  "btcBillPay.upsert": "tables:upsertBtcBillPayFromDevice",
  "btcBillPay.delete": "tables:deleteBtcBillPayFromDevice",
  "btcTransfer.upsert": "tables:upsertBtcTransferFromDevice",
  "btcTransfer.delete": "tables:deleteBtcTransferFromDevice",
  "btcAccount.upsert": "tables:upsertBtcAccountFromDevice",
  "btcAccount.delete": "tables:deleteBtcAccountFromDevice",
} as const

export const PAIRED_DEVICE_LIMITS = {
  maxResponseBytes: 1_048_576,
  maxPairingInput: 2_048,
  maxDeviceName: 80,
  maxRequestId: 128,
  maxIdentifier: 256,
  maxText: 16_384,
  maxInFlight: 4,
  maxMutationsPerMinute: 120,
} as const

const MUTATION_KINDS = [
  "transaction.upsert",
  "transaction.delete",
  "todo.upsert",
  "todo.delete",
  "budgetCategory.upsert",
  "budgetCategory.delete",
  "btcBuy.upsert",
  "btcBuy.delete",
  "btcBillPay.upsert",
  "btcBillPay.delete",
  "btcTransfer.upsert",
  "btcTransfer.delete",
  "btcAccount.upsert",
  "btcAccount.delete",
] as const satisfies readonly VogelVaultMutationKind[]

const MUTATION_KIND_SET: ReadonlySet<string> = new Set(MUTATION_KINDS)
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/
const PAIR_PART = /^[A-Za-z0-9_-]{8,256}$/
const MIN_INT64 = -(1n << 63n)
const MAX_INT64 = (1n << 63n) - 1n
const APPROVED_CONVEX_ORIGIN = "https://keen-elephant-452.convex.cloud"

class InvalidRequest extends Error {}
class InvalidResponse extends Error {}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

interface PairingClaim {
  readonly pairId: string
  readonly proofHash: string
  readonly deviceName: string
}

interface SuccessEnvelope {
  readonly value: unknown
}

export interface PairedDeviceController {
  pair(input: unknown): Promise<VogelVaultPairingResult>
  status(): Promise<VogelVaultPairingStatus>
  /**
   * `sessionActor` is the member this window is authenticated as, established
   * by the main process rather than by the request. It is required: without it
   * the payload's own `actor` would be the only claim of identity, and any
   * renderer could write another family member's ledger by declaring theirs.
   */
  mutate(
    input: unknown,
    sessionActor: VogelVaultMember,
  ): Promise<VogelVaultMutationResult>
  unpair(): Promise<VogelVaultUnpairResult>
}

export interface PairedDeviceControllerOptions {
  readonly store: DeviceCredentialStore
  readonly post: JsonPoster
  readonly writesEnabled: () => boolean
  /** Trusted main-process configuration, resolved again for every operation. */
  readonly approvedDeploymentOrigin: () => string | null
  readonly random?: (bytes: number) => Buffer
  readonly now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return Object.keys(record).every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(record, key))
}

/**
 * Resolve the one household deployment the main process approves.
 *
 * Pairing input never supplies transport routing. The environment is trusted
 * host configuration, but it is still parsed narrowly so a typo fails closed.
 */
export function resolveApprovedDeploymentOrigin(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 512) return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== APPROVED_CONVEX_ORIGIN
  ) {
    return null
  }
  return parsed.origin
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidRequest()
  const allowed = new Set([...required, ...optional])
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new InvalidRequest()
  }
  return value
}

function boundedText(
  value: unknown,
  max: number = PAIRED_DEVICE_LIMITS.maxText,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > max ||
    hasControlCharacter(value)
  ) {
    throw new InvalidRequest()
  }
  return value
}

function optionalText(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined
  return boundedText(record[key], PAIRED_DEVICE_LIMITS.maxText, true)
}

function optionalField<T>(
  key: string,
  value: T | undefined,
): { readonly [name: string]: T } | Record<string, never> {
  return value === undefined ? {} : { [key]: value }
}

function member(value: unknown): VogelVaultMember {
  if (!isFamilyMember(value)) throw new InvalidRequest()
  return value
}

function int64(value: unknown): bigint {
  if (typeof value !== "bigint" || value < MIN_INT64 || value > MAX_INT64) {
    throw new InvalidRequest()
  }
  return value
}

function positiveInt64(value: unknown): bigint {
  const parsed = int64(value)
  if (parsed <= 0n) throw new InvalidRequest()
  return parsed
}

function nonnegativeInt64(value: unknown): bigint {
  const parsed = int64(value)
  if (parsed < 0n) throw new InvalidRequest()
  return parsed
}

function exactDate(value: unknown): string {
  const date = boundedText(value, 10)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) throw new InvalidRequest()
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new InvalidRequest()
  }
  return date
}

function exactMonth(value: unknown): string {
  const month = boundedText(value, 7)
  if (!MONTH.test(month)) throw new InvalidRequest()
  return month
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRequest()
  }
  return value
}

function optionalRevision(record: Record<string, unknown>): number | undefined {
  return Object.hasOwn(record, "baseUpdatedAtMs")
    ? revision(record["baseUpdatedAtMs"])
    : undefined
}

function common(
  value: Record<string, unknown>,
): { requestId: string; actor: VogelVaultMember } {
  const requestId = boundedText(value["requestId"], PAIRED_DEVICE_LIMITS.maxRequestId)
  if (!REQUEST_ID.test(requestId)) throw new InvalidRequest()
  return { requestId, actor: member(value["actor"]) }
}

function withCommon(
  value: unknown,
  kind: VogelVaultMutationKind,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = exactObject(value, ["kind", "requestId", "actor", ...fields], optional)
  if (record["kind"] !== kind) throw new InvalidRequest()
  return record
}

function validateFiatValuation(value: unknown): VogelVaultFiatValuation {
  const record = exactObject(value, ["cents"], [
    "priceCents",
    "quotedAt",
    "source",
    "confidence",
  ])
  return {
    cents: int64(record["cents"]),
    ...optionalField(
      "priceCents",
      Object.hasOwn(record, "priceCents") ? nonnegativeInt64(record["priceCents"]) : undefined,
    ),
    ...optionalField("quotedAt", optionalText(record, "quotedAt")),
    ...optionalField("source", optionalText(record, "source")),
    ...optionalField("confidence", optionalText(record, "confidence")),
  }
}

/** Re-validate the structured-clone payload in main before any storage/network use. */
export function validateMutationRequest(input: unknown): VogelVaultMutationRequest | null {
  if (!isRecord(input) || typeof input["kind"] !== "string") return null
  const kind = input["kind"] as VogelVaultMutationKind
  if (!MUTATION_KIND_SET.has(kind)) return null

  try {
    switch (kind) {
      case "transaction.upsert": {
        const record = withCommon(
          input,
          kind,
          ["id", "owner", "date", "merchant", "amountCents", "transactionKind", "category"],
          ["card", "note", "amountSats", "baseUpdatedAtMs"],
        )
        const { requestId, actor } = common(record)
        const owner = canonicalFinancialOwner(member(record["owner"]))
        const sourceFile = transactionSource(owner)
        const transactionKind = record["transactionKind"]
        if (transactionKind !== "spend" && transactionKind !== "credit") throw new InvalidRequest()
        const card = optionalText(record, "card")
        const note = optionalText(record, "note")
        const candidate = {
          id: boundedText(record["id"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner,
          sourceFile,
          date: exactDate(record["date"]),
          merchant: boundedText(record["merchant"]),
          amountCents: int64(record["amountCents"]),
          kind: transactionKind,
          category: boundedText(record["category"]),
          ...optionalField("card", card),
          ...optionalField("note", note),
          ...optionalField(
            "amountSats",
            Object.hasOwn(record, "amountSats")
              ? positiveInt64(record["amountSats"])
              : undefined,
          ),
        }
        // Reuse the shared sign, owner/source and exact-money contract.
        buildTransactionWriteRequest(owner, candidate)
        return {
          kind,
          requestId,
          actor,
          id: candidate.id,
          owner,
          date: candidate.date,
          merchant: candidate.merchant,
          amountCents: candidate.amountCents,
          transactionKind,
          category: candidate.category,
          ...optionalField("card", card),
          ...optionalField("note", note),
          ...optionalField(
            "amountSats",
            Object.hasOwn(record, "amountSats")
              ? positiveInt64(record["amountSats"])
              : undefined,
          ),
          ...optionalField("baseUpdatedAtMs", optionalRevision(record)),
        }
      }
      case "transaction.delete":
      case "btcBuy.delete":
      case "btcBillPay.delete":
      case "btcTransfer.delete": {
        const record = withCommon(input, kind, ["id", "owner", "baseUpdatedAtMs"])
        const { requestId, actor } = common(record)
        return {
          kind,
          requestId,
          actor,
          id: boundedText(record["id"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner: canonicalFinancialOwner(member(record["owner"])),
          baseUpdatedAtMs: revision(record["baseUpdatedAtMs"]),
        }
      }
      case "todo.delete": {
        const record = withCommon(input, kind, ["id", "owner", "baseUpdatedAtMs"])
        const { requestId, actor } = common(record)
        return {
          kind,
          requestId,
          actor,
          id: boundedText(record["id"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner: member(record["owner"]),
          baseUpdatedAtMs: revision(record["baseUpdatedAtMs"]),
        }
      }
      case "btcAccount.delete": {
        const record = withCommon(input, kind, ["key", "owner", "baseUpdatedAtMs"])
        const { requestId, actor } = common(record)
        return {
          kind,
          requestId,
          actor,
          key: boundedText(record["key"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner: canonicalFinancialOwner(member(record["owner"])),
          baseUpdatedAtMs: revision(record["baseUpdatedAtMs"]),
        }
      }
      case "todo.upsert": {
        const record = withCommon(
          input,
          kind,
          ["id", "owner", "title", "done", "flagged"],
          [
            "lane", "project", "area", "due", "notes", "priority", "createdAt",
            "updatedAt", "completedAt", "baseUpdatedAtMs",
          ],
        )
        const { requestId, actor } = common(record)
        const owner = member(record["owner"])
        if (typeof record["done"] !== "boolean" || typeof record["flagged"] !== "boolean") {
          throw new InvalidRequest()
        }
        return {
          kind,
          requestId,
          actor,
          id: boundedText(record["id"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner,
          title: boundedText(record["title"]),
          done: record["done"],
          flagged: record["flagged"],
          ...optionalField("lane", optionalText(record, "lane")),
          ...optionalField("project", optionalText(record, "project")),
          ...optionalField("area", optionalText(record, "area")),
          ...optionalField("due", optionalText(record, "due")),
          ...optionalField("notes", optionalText(record, "notes")),
          ...optionalField(
            "priority",
            Object.hasOwn(record, "priority") ? int64(record["priority"]) : undefined,
          ),
          ...optionalField("createdAt", optionalText(record, "createdAt")),
          ...optionalField("updatedAt", optionalText(record, "updatedAt")),
          ...optionalField("completedAt", optionalText(record, "completedAt")),
          ...optionalField("baseUpdatedAtMs", optionalRevision(record)),
        }
      }
      case "budgetCategory.upsert": {
        const record = withCommon(
          input,
          kind,
          ["owner", "month", "name", "budgetCents"],
          ["originalName", "icon", "baseUpdatedAtMs"],
        )
        const { requestId, actor } = common(record)
        const owner = canonicalFinancialOwner(member(record["owner"]))
        budgetSource(owner)
        return {
          kind,
          requestId,
          actor,
          owner,
          month: exactMonth(record["month"]),
          name: boundedText(record["name"]),
          ...optionalField("originalName", optionalText(record, "originalName")),
          ...optionalField("icon", optionalText(record, "icon")),
          budgetCents: nonnegativeInt64(record["budgetCents"]),
          ...optionalField("baseUpdatedAtMs", optionalRevision(record)),
        }
      }
      case "budgetCategory.delete": {
        const record = withCommon(
          input,
          kind,
          ["owner", "month", "name", "baseUpdatedAtMs"],
        )
        const { requestId, actor } = common(record)
        const owner = canonicalFinancialOwner(member(record["owner"]))
        budgetSource(owner)
        return {
          kind,
          requestId,
          actor,
          owner,
          month: exactMonth(record["month"]),
          name: boundedText(record["name"]),
          baseUpdatedAtMs: revision(record["baseUpdatedAtMs"]),
        }
      }
      case "btcBuy.upsert": {
        const record = withCommon(
          input,
          kind,
          ["id", "owner", "date", "source", "sats", "priceUsdCents", "usdCents"],
          [
            "note", "buyStatus", "costBasisStatus", "loggedBy", "archimedesRequestId",
            "baseUpdatedAtMs",
          ],
        )
        const { requestId, actor } = common(record)
        const owner = canonicalFinancialOwner(member(record["owner"]))
        btcBuySource(owner)
        return {
          kind,
          requestId,
          actor,
          id: boundedText(record["id"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner,
          date: exactDate(record["date"]),
          source: boundedText(record["source"]),
          sats: positiveInt64(record["sats"]),
          priceUsdCents: positiveInt64(record["priceUsdCents"]),
          usdCents: positiveInt64(record["usdCents"]),
          ...optionalField("note", optionalText(record, "note")),
          ...optionalField("buyStatus", optionalText(record, "buyStatus")),
          ...optionalField("costBasisStatus", optionalText(record, "costBasisStatus")),
          ...optionalField("loggedBy", optionalText(record, "loggedBy")),
          ...optionalField("archimedesRequestId", optionalText(record, "archimedesRequestId")),
          ...optionalField("baseUpdatedAtMs", optionalRevision(record)),
        }
      }
      case "btcBillPay.upsert": {
        const record = withCommon(
          input,
          kind,
          [
            "id", "owner", "date", "merchant", "category", "amountUsdCents",
            "btcSpentSats", "btcPriceCents", "feeUsdCents",
          ],
          ["platform", "note", "reference", "baseUpdatedAtMs"],
        )
        const { requestId, actor } = common(record)
        const owner = canonicalFinancialOwner(member(record["owner"]))
        return {
          kind,
          requestId,
          actor,
          id: boundedText(record["id"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner,
          date: exactDate(record["date"]),
          merchant: boundedText(record["merchant"]),
          category: boundedText(record["category"]),
          amountUsdCents: positiveInt64(record["amountUsdCents"]),
          btcSpentSats: positiveInt64(record["btcSpentSats"]),
          btcPriceCents: positiveInt64(record["btcPriceCents"]),
          ...optionalField("platform", optionalText(record, "platform")),
          ...optionalField("note", optionalText(record, "note")),
          feeUsdCents: nonnegativeInt64(record["feeUsdCents"]),
          ...optionalField("reference", optionalText(record, "reference")),
          ...optionalField("baseUpdatedAtMs", optionalRevision(record)),
        }
      }
      case "btcTransfer.upsert": {
        const record = withCommon(
          input,
          kind,
          ["id", "owner", "date", "fromAccountKey", "toAccountKey", "sats", "feeSats"],
          ["note", "baseUpdatedAtMs"],
        )
        const { requestId, actor } = common(record)
        const owner = canonicalFinancialOwner(member(record["owner"]))
        const fromAccountKey = boundedText(
          record["fromAccountKey"],
          PAIRED_DEVICE_LIMITS.maxIdentifier,
        )
        const toAccountKey = boundedText(
          record["toAccountKey"],
          PAIRED_DEVICE_LIMITS.maxIdentifier,
        )
        if (fromAccountKey === toAccountKey) throw new InvalidRequest()
        return {
          kind,
          requestId,
          actor,
          id: boundedText(record["id"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner,
          date: exactDate(record["date"]),
          fromAccountKey,
          toAccountKey,
          sats: positiveInt64(record["sats"]),
          feeSats: nonnegativeInt64(record["feeSats"]),
          ...optionalField("note", optionalText(record, "note")),
          ...optionalField("baseUpdatedAtMs", optionalRevision(record)),
        }
      }
      case "btcAccount.upsert": {
        const record = withCommon(
          input,
          kind,
          ["key", "owner", "label", "custody", "sats", "asOf"],
          ["schemaVersion", "fiatValuation", "baseUpdatedAtMs"],
        )
        const { requestId, actor } = common(record)
        const owner = canonicalFinancialOwner(member(record["owner"]))
        btcAccountSource(owner)
        const custody = record["custody"]
        if (custody !== "exchange" && custody !== "self_custody") throw new InvalidRequest()
        return {
          kind,
          requestId,
          actor,
          key: boundedText(record["key"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner,
          label: boundedText(record["label"]),
          custody,
          sats: nonnegativeInt64(record["sats"]),
          asOf: boundedText(record["asOf"], 64),
          ...optionalField(
            "schemaVersion",
            Object.hasOwn(record, "schemaVersion")
              ? nonnegativeInt64(record["schemaVersion"])
              : undefined,
          ),
          ...optionalField(
            "fiatValuation",
            Object.hasOwn(record, "fiatValuation")
              ? validateFiatValuation(record["fiatValuation"])
              : undefined,
          ),
          ...optionalField("baseUpdatedAtMs", optionalRevision(record)),
        }
      }
    }
  } catch {
    return null
  }
}

function canonicalFinancialOwner(owner: VogelVaultMember): VogelVaultMember {
  return owner === "rachel" ? "victor" : owner
}

function transactionSource(owner: VogelVaultMember): string {
  if (owner === "victor") return "transactions"
  return `${owner}-transactions`
}

function btcBuySource(owner: VogelVaultMember): string {
  if (owner === "victor" || owner === "rachel") return "bitcoin-buys"
  if (owner === "mason") return "mason-bitcoin-buys"
  throw new InvalidRequest()
}

function btcAccountSource(owner: VogelVaultMember): string {
  if (owner === "victor" || owner === "rachel") return "btc-balance-snapshot"
  if (owner === "mason") return "son-balances"
  throw new InvalidRequest()
}

function budgetSource(
  owner: VogelVaultMember,
): { owner: "victor" | "mason"; sourceFile: "budget" | "mason-budget" } {
  if (owner === "victor") {
    return { owner: "victor", sourceFile: "budget" }
  }
  if (owner === "mason") {
    return { owner: "mason", sourceFile: "mason-budget" }
  }
  throw new InvalidRequest()
}

function pairingClaim(value: unknown): PairingClaim {
  const record = exactObject(value, ["pairingInput", "deviceName"])
  const rawInput = boundedText(record["pairingInput"], PAIRED_DEVICE_LIMITS.maxPairingInput)
  const deviceName = boundedText(record["deviceName"], PAIRED_DEVICE_LIMITS.maxDeviceName)
  const parts = rawInput.split(".")
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    !PAIR_PART.test(parts[0]) ||
    !PAIR_PART.test(parts[1])
  ) {
    throw new InvalidRequest()
  }
  return {
    pairId: parts[0],
    proofHash: createHash("sha256").update(rawInput, "utf8").digest("hex"),
    deviceName,
  }
}

function encoded(value: bigint): ReturnType<typeof encodeConvexInt64> {
  return encodeConvexInt64(value)
}

function encodeValuation(value: VogelVaultFiatValuation): Record<string, unknown> {
  return {
    cents: encoded(value.cents),
    ...optionalField(
      "priceCents",
      value.priceCents === undefined ? undefined : encoded(value.priceCents),
    ),
    ...optionalField("quotedAt", value.quotedAt),
    ...optionalField("source", value.source),
    ...optionalField("confidence", value.confidence),
  }
}

function mutationArgs(
  request: VogelVaultMutationRequest,
  snapshot: DeviceCredentialSnapshot,
): Record<string, unknown> {
  const auth = {
    deviceId: snapshot.deviceId,
    deviceToken: snapshot.deviceCredential,
  }
  switch (request.kind) {
    case "transaction.upsert": {
      const sourceFile = transactionSource(request.owner)
      const wire = buildTransactionWriteRequest(request.owner, {
        id: request.id,
        owner: request.owner,
        sourceFile,
        date: request.date,
        merchant: request.merchant,
        amountCents: request.amountCents,
        kind: request.transactionKind,
        category: request.category,
        ...optionalField("card", request.card),
        ...optionalField("note", request.note),
        ...optionalField("amountSats", request.amountSats),
      })
      return {
        ...auth,
        owner: request.owner,
        ...wire.args,
        transaction: {
          ...wire.args.transaction,
          ...optionalField(
            "amountSats",
            request.amountSats === undefined ? undefined : encoded(request.amountSats),
          ),
        },
        ...optionalField("baseUpdatedAtMs", request.baseUpdatedAtMs),
      }
    }
    case "transaction.delete":
      return {
        ...auth,
        entityId: request.id,
        owner: request.owner,
        sourceFile: transactionSource(request.owner),
        baseUpdatedAtMs: request.baseUpdatedAtMs,
      }
    case "todo.upsert":
      return {
        ...auth,
        owner: request.owner,
        sourceFile: "todos",
        todo: {
          id: request.id,
          owner: request.owner,
          title: request.title,
          done: request.done,
          flagged: request.flagged,
          ...optionalField("lane", request.lane),
          ...optionalField("project", request.project),
          ...optionalField("area", request.area),
          ...optionalField("due", request.due),
          ...optionalField("notes", request.notes),
          ...optionalField("priority", request.priority === undefined ? undefined : encoded(request.priority)),
          ...optionalField("createdAt", request.createdAt),
          ...optionalField("updatedAt", request.updatedAt),
          ...optionalField("completedAt", request.completedAt),
        },
        ...optionalField("baseUpdatedAtMs", request.baseUpdatedAtMs),
      }
    case "todo.delete":
      return {
        ...auth,
        entityId: request.id,
        owner: request.owner,
        sourceFile: "todos",
        baseUpdatedAtMs: request.baseUpdatedAtMs,
      }
    case "budgetCategory.upsert": {
      const budget = budgetSource(request.owner)
      return {
        ...auth,
        ...budget,
        month: request.month,
        ...optionalField("previousName", request.originalName),
        category: {
          name: request.name,
          ...optionalField("icon", request.icon),
          budgetCents: encoded(request.budgetCents),
        },
        ...optionalField("baseUpdatedAtMs", request.baseUpdatedAtMs),
      }
    }
    case "budgetCategory.delete": {
      const budget = budgetSource(request.owner)
      return {
        ...auth,
        ...budget,
        month: request.month,
        entityId: request.name,
        baseUpdatedAtMs: request.baseUpdatedAtMs,
      }
    }
    case "btcBuy.upsert":
      return {
        ...auth,
        owner: request.owner,
        buy: {
          id: request.id,
          owner: request.owner,
          date: request.date,
          source: request.source,
          sats: encoded(request.sats),
          priceUsdCents: encoded(request.priceUsdCents),
          usdCents: encoded(request.usdCents),
          ...optionalField("note", request.note),
          ...optionalField("status", request.buyStatus),
          ...optionalField("costBasisStatus", request.costBasisStatus),
          ...optionalField("loggedBy", request.loggedBy),
          ...optionalField("archimedesRequestId", request.archimedesRequestId),
        },
        sourceFile: btcBuySource(request.owner),
        ...optionalField("baseUpdatedAtMs", request.baseUpdatedAtMs),
      }
    case "btcBuy.delete":
      return {
        ...auth,
        entityId: request.id,
        owner: request.owner,
        sourceFile: btcBuySource(request.owner),
        baseUpdatedAtMs: request.baseUpdatedAtMs,
      }
    case "btcBillPay.upsert":
      return {
        ...auth,
        owner: request.owner,
        billPay: {
          id: request.id,
          owner: request.owner,
          date: request.date,
          merchant: request.merchant,
          category: request.category,
          amountUsdCents: encoded(request.amountUsdCents),
          btcSpentSats: encoded(request.btcSpentSats),
          btcPriceCents: encoded(request.btcPriceCents),
          ...optionalField("platform", request.platform),
          ...optionalField("note", request.note),
          feeUsdCents: encoded(request.feeUsdCents),
          ...optionalField("reference", request.reference),
        },
        sourceFile: "bitcoin-bill-pays",
        ...optionalField("baseUpdatedAtMs", request.baseUpdatedAtMs),
      }
    case "btcBillPay.delete":
      return {
        ...auth,
        entityId: request.id,
        owner: request.owner,
        sourceFile: "bitcoin-bill-pays",
        baseUpdatedAtMs: request.baseUpdatedAtMs,
      }
    case "btcTransfer.upsert":
      return {
        ...auth,
        owner: request.owner,
        sourceFile: "btc-transfers",
        transfer: {
          id: request.id,
          owner: request.owner,
          date: request.date,
          fromAccountKey: request.fromAccountKey,
          toAccountKey: request.toAccountKey,
          sats: encoded(request.sats),
          feeSats: encoded(request.feeSats),
          ...optionalField("note", request.note),
        },
        ...optionalField("baseUpdatedAtMs", request.baseUpdatedAtMs),
      }
    case "btcTransfer.delete":
      return {
        ...auth,
        entityId: request.id,
        owner: request.owner,
        sourceFile: "btc-transfers",
        baseUpdatedAtMs: request.baseUpdatedAtMs,
      }
    case "btcAccount.upsert": {
      return {
        ...auth,
        owner: request.owner,
        account: {
          key: request.key,
          owner: request.owner,
          label: request.label,
          custody: request.custody,
          sats: encoded(request.sats),
          asOf: request.asOf,
          ...optionalField(
            "schemaVersion",
            request.schemaVersion === undefined ? undefined : encoded(request.schemaVersion),
          ),
          ...optionalField(
            "fiatValuation",
            request.fiatValuation === undefined
              ? undefined
              : encodeValuation(request.fiatValuation),
          ),
        },
        sourceFile: btcAccountSource(request.owner),
        ...optionalField("baseUpdatedAtMs", request.baseUpdatedAtMs),
      }
    }
    case "btcAccount.delete":
      return {
        ...auth,
        entityId: request.key,
        owner: request.owner,
        sourceFile: btcAccountSource(request.owner),
        baseUpdatedAtMs: request.baseUpdatedAtMs,
      }
  }
}

function mutationEndpoint(origin: string): string {
  return `${origin}/api/mutation`
}

function requestBody(path: string, args: Record<string, unknown>): string {
  return JSON.stringify({ path, args, format: "convex_encoded_json" })
}

function successEnvelope(response: JsonPostResponse): SuccessEnvelope {
  if (
    response.truncated === true ||
    Buffer.byteLength(response.body, "utf8") > PAIRED_DEVICE_LIMITS.maxResponseBytes ||
    response.httpStatus !== 200
  ) {
    throw new InvalidResponse()
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(response.body)
  } catch {
    throw new InvalidResponse()
  }
  if (
    !isRecord(envelope) ||
    !exactKeys(envelope, ["status", "value"]) ||
    envelope["status"] !== "success"
  ) {
    throw new InvalidResponse()
  }
  return { value: envelope["value"] }
}

type RemoteErrorCode =
  | "CONFIG_MISSING"
  | "DEVICE_ID_CONFLICT"
  | "DEVICE_UNAUTHORIZED"
  | "ENTITY_CONFLICT"
  | "ENTITY_DELETED"
  | "ENTITY_NOT_FOUND"
  | "OWNER_MISMATCH"
  | "OWNER_SOURCE_MISMATCH"
  | "PAIRING_ALREADY_CLAIMED"
  | "PAIRING_EXPIRED"
  | "PAIRING_NOT_FOUND"
  | "PAIRING_PROOF_INVALID"
  | "REVISION_REQUIRED"
  | "VALIDATION_FAILED"

const REMOTE_ERROR_CODES: ReadonlySet<string> = new Set<RemoteErrorCode>([
  "CONFIG_MISSING",
  "DEVICE_ID_CONFLICT",
  "DEVICE_UNAUTHORIZED",
  "ENTITY_CONFLICT",
  "ENTITY_DELETED",
  "ENTITY_NOT_FOUND",
  "OWNER_MISMATCH",
  "OWNER_SOURCE_MISMATCH",
  "PAIRING_ALREADY_CLAIMED",
  "PAIRING_EXPIRED",
  "PAIRING_NOT_FOUND",
  "PAIRING_PROOF_INVALID",
  "REVISION_REQUIRED",
  "VALIDATION_FAILED",
])

function structuredRemoteError(response: JsonPostResponse): RemoteErrorCode | null {
  if (
    response.truncated === true ||
    Buffer.byteLength(response.body, "utf8") > 4_096 ||
    response.httpStatus !== 200
  ) {
    return null
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(response.body)
  } catch {
    return null
  }
  if (
    !isRecord(envelope) ||
    envelope["status"] !== "error" ||
    !exactKeys(envelope, ["status", "errorData"], ["errorMessage"])
  ) {
    return null
  }

  let data: unknown = envelope["errorData"]
  if (typeof data === "string" && data.length <= 2_048) {
    try {
      data = JSON.parse(data)
    } catch {
      return null
    }
  }
  if (
    !isRecord(data) ||
    !exactKeys(data, ["code", "message"], ["entityType", "entityId"]) ||
    typeof data["code"] !== "string" ||
    !REMOTE_ERROR_CODES.has(data["code"]) ||
    typeof data["message"] !== "string" ||
    data["message"].length > 1_024 ||
    (Object.hasOwn(data, "entityType") &&
      (typeof data["entityType"] !== "string" || data["entityType"].length > 64)) ||
    (Object.hasOwn(data, "entityId") &&
      (typeof data["entityId"] !== "string" ||
        data["entityId"].length > PAIRED_DEVICE_LIMITS.maxIdentifier))
  ) {
    return null
  }
  return data["code"] as RemoteErrorCode
}

function remoteClassification(
  response: JsonPostResponse,
): "unauthorized" | "missing" | "conflict" | "rejected" | "expired" | "already-claimed" | null {
  if (response.httpStatus === 401 || response.httpStatus === 403) return "unauthorized"
  const code = structuredRemoteError(response)
  if (code === "DEVICE_UNAUTHORIZED") return "unauthorized"
  if (code === "PAIRING_ALREADY_CLAIMED" || code === "DEVICE_ID_CONFLICT") {
    return "already-claimed"
  }
  if (code === "PAIRING_EXPIRED" || code === "PAIRING_NOT_FOUND") return "expired"
  if (code === "ENTITY_NOT_FOUND" || code === "ENTITY_DELETED") return "missing"
  if (code === "ENTITY_CONFLICT" || code === "REVISION_REQUIRED") return "conflict"
  if (code === "VALIDATION_FAILED") return "rejected"
  return null
}

const RESOURCE_CAPABILITIES = {
  "todos:write": ["todo.upsert", "todo.delete"],
  "transactions:write": ["transaction.upsert", "transaction.delete"],
  "budget:write": ["budgetCategory.upsert", "budgetCategory.delete"],
  "bitcoin:write": [
    "btcBuy.upsert",
    "btcBuy.delete",
    "btcBillPay.upsert",
    "btcBillPay.delete",
    "btcTransfer.upsert",
    "btcTransfer.delete",
    "btcAccount.upsert",
    "btcAccount.delete",
  ],
} as const satisfies Readonly<Record<string, readonly VogelVaultMutationKind[]>>

function responseCapabilities(value: unknown): readonly VogelVaultMutationKind[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw new InvalidResponse()
  }
  if (
    value.some(
      (capability) =>
        typeof capability !== "string" ||
        !Object.hasOwn(RESOURCE_CAPABILITIES, capability),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new InvalidResponse()
  }
  const resources = value as (keyof typeof RESOURCE_CAPABILITIES)[]
  return resources.flatMap((capability) => RESOURCE_CAPABILITIES[capability])
}

function storedCapabilities(value: unknown): readonly VogelVaultMutationKind[] {
  if (
    !Array.isArray(value) ||
    value.length > MUTATION_KINDS.length ||
    value.some((kind) => typeof kind !== "string" || !MUTATION_KIND_SET.has(kind)) ||
    new Set(value).size !== value.length
  ) {
    throw new InvalidResponse()
  }
  const capabilities = value as VogelVaultMutationKind[]
  const legacyBitcoinGrant = [
    "btcBuy.upsert",
    "btcBuy.delete",
    "btcBillPay.upsert",
    "btcBillPay.delete",
    "btcAccount.upsert",
    "btcAccount.delete",
  ] as const satisfies readonly VogelVaultMutationKind[]
  if (
    legacyBitcoinGrant.every((kind) => capabilities.includes(kind)) &&
    !capabilities.includes("btcTransfer.upsert") &&
    !capabilities.includes("btcTransfer.delete")
  ) {
    // Stored grants are the expanded renderer vocabulary, while Convex keeps
    // the durable coarse `bitcoin:write` capability. Preserve that original
    // grant across this vocabulary addition so existing paired desktops do
    // not need to re-pair merely to use the new Bitcoin transfer endpoint.
    return [...capabilities, "btcTransfer.upsert", "btcTransfer.delete"]
  }
  return capabilities
}

function pairValue(
  value: unknown,
  expectedDeviceId: string,
): { pairedAt: number; capabilities: readonly VogelVaultMutationKind[] } {
  if (!isRecord(value)) throw new InvalidResponse()
  if (
    !exactKeys(value, ["ok", "deviceId", "pairedAt", "capabilities"]) ||
    value["ok"] !== true ||
    value["deviceId"] !== expectedDeviceId ||
    typeof value["pairedAt"] !== "number" ||
    !Number.isSafeInteger(value["pairedAt"]) ||
    value["pairedAt"] < 0
  ) {
    throw new InvalidResponse()
  }
  return {
    pairedAt: value["pairedAt"],
    capabilities: responseCapabilities(value["capabilities"]),
  }
}

function mutationValue(
  value: unknown,
  request: VogelVaultMutationRequest,
): VogelVaultMutationResult {
  if (!isRecord(value) || value["ok"] !== true) throw new InvalidResponse()
  const isUpsert = request.kind.endsWith(".upsert")
  if (
    !exactKeys(
      value,
      isUpsert ? ["ok", "entityId", "outcome"] : ["ok", "entityId", "removed"],
    )
  ) {
    throw new InvalidResponse()
  }
  const entityId = value["entityId"]
  if (
    typeof entityId !== "string" ||
    entityId.length === 0 ||
    entityId.length > PAIRED_DEVICE_LIMITS.maxIdentifier ||
    hasControlCharacter(entityId)
  ) {
    throw new InvalidResponse()
  }
  let expectedEntityId: string
  switch (request.kind) {
    case "budgetCategory.upsert":
    case "budgetCategory.delete":
      expectedEntityId = request.name
      break
    case "btcAccount.upsert":
    case "btcAccount.delete":
      expectedEntityId = request.key
      break
    default:
      expectedEntityId = request.id
  }
  if (entityId !== expectedEntityId) throw new InvalidResponse()
  if (isUpsert) {
    const outcome = value["outcome"]
    if (outcome !== "inserted" && outcome !== "updated") throw new InvalidResponse()
    return {
      status: "ok",
      requestId: request.requestId,
      kind: request.kind,
      outcome,
      entityId,
    }
  }
  if (typeof value["removed"] !== "boolean") throw new InvalidResponse()
  return {
    status: "ok",
    requestId: request.requestId,
    kind: request.kind,
    outcome: value["removed"] ? "deleted" : "not-found",
    entityId,
  }
}

function safeIdentity(input: unknown): {
  requestId: string
  kind: VogelVaultMutationKind
} {
  if (isRecord(input)) {
    const candidateId = input["requestId"]
    const candidateKind = input["kind"]
    if (
      typeof candidateId === "string" &&
      REQUEST_ID.test(candidateId) &&
      typeof candidateKind === "string" &&
      MUTATION_KIND_SET.has(candidateKind)
    ) {
      return { requestId: candidateId, kind: candidateKind as VogelVaultMutationKind }
    }
  }
  return { requestId: "invalid-request", kind: "transaction.upsert" }
}

async function bestEffortRevoke(
  post: JsonPoster,
  snapshot: Pick<
    DeviceCredentialSnapshot,
    "deploymentOrigin" | "deviceId" | "deviceCredential"
  >,
): Promise<void> {
  await post(
    mutationEndpoint(snapshot.deploymentOrigin),
    requestBody(PAIRED_DEVICE_PATHS.revoke, {
      deviceId: snapshot.deviceId,
      deviceToken: snapshot.deviceCredential,
    }),
    PAIRED_DEVICE_LIMITS.maxResponseBytes,
  ).catch(() => undefined)
}

export function createPairedDeviceController(
  options: PairedDeviceControllerOptions,
): PairedDeviceController {
  const random = options.random ?? randomBytes
  const now = options.now ?? Date.now
  let lifecycleTail: Promise<void> = Promise.resolve()
  let queuedMutations = 0
  const mutationStarts: number[] = []

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = lifecycleTail.then(operation, operation)
    lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function mutationRateAvailable(): boolean {
    const cutoff = now() - 60_000
    while (mutationStarts[0] !== undefined && mutationStarts[0] <= cutoff) {
      mutationStarts.shift()
    }
    if (mutationStarts.length >= PAIRED_DEVICE_LIMITS.maxMutationsPerMinute) return false
    mutationStarts.push(now())
    return true
  }

  return {
    async pair(input: unknown): Promise<VogelVaultPairingResult> {
      if (!options.writesEnabled()) return { status: "disabled" }
      let claim: PairingClaim
      try {
        claim = pairingClaim(input)
      } catch {
        return { status: "failed", code: "invalid-input" }
      }
      const approvedOrigin = options.approvedDeploymentOrigin()
      if (approvedOrigin === null) return { status: "failed", code: "unavailable" }
      if (options.store.readiness() !== "ready") {
        return { status: "failed", code: "credential-storage" }
      }
      return exclusive(async () => {
        if (!options.writesEnabled()) return { status: "disabled" }
        if (options.approvedDeploymentOrigin() !== approvedOrigin) {
          return { status: "failed", code: "unavailable" }
        }
        try {
          if ((await options.store.load()) !== null) {
            return { status: "failed", code: "already-claimed" }
          }
        } catch {
          return { status: "failed", code: "credential-storage" }
        }

        const deviceId = random(14).toString("base64url")
        const deviceCredential = random(32).toString("base64url")
        let response: JsonPostResponse
        try {
          response = await options.post(
            mutationEndpoint(approvedOrigin),
            requestBody(PAIRED_DEVICE_PATHS.claim, {
              pairId: claim.pairId,
              proofHash: claim.proofHash,
              deviceName: claim.deviceName,
              deviceId,
              deviceToken: deviceCredential,
            }),
            PAIRED_DEVICE_LIMITS.maxResponseBytes,
          )
        } catch {
          return { status: "failed", code: "unavailable" }
        }

        const classified = remoteClassification(response)
        if (classified === "expired" || classified === "missing") {
          return { status: "failed", code: "expired" }
        }
        if (classified === "already-claimed") {
          return { status: "failed", code: "already-claimed" }
        }
        if (structuredRemoteError(response) !== null) {
          return { status: "failed", code: "server-rejected" }
        }

        let paired
        try {
          paired = pairValue(successEnvelope(response).value, deviceId)
        } catch {
          await bestEffortRevoke(options.post, {
            deploymentOrigin: approvedOrigin,
            deviceId,
            deviceCredential,
          })
          return { status: "failed", code: "invalid-response" }
        }
        const pending: Omit<DeviceCredentialSnapshot, "revision"> = {
          deploymentOrigin: approvedOrigin,
          deviceId,
          deviceCredential,
          pairedAt: paired.pairedAt,
          capabilities: paired.capabilities,
        }
        try {
          await options.store.save(pending)
        } catch {
          await bestEffortRevoke(options.post, pending)
          return { status: "failed", code: "credential-storage" }
        }
        return {
          status: "paired",
          pairedAt: paired.pairedAt,
          capabilities: paired.capabilities,
        }
      })
    },

    async status(): Promise<VogelVaultPairingStatus> {
      if (options.store.readiness() !== "ready") return { status: "unavailable" }
      return exclusive(async () => {
        try {
          const snapshot = await options.store.load()
          const approvedOrigin = options.approvedDeploymentOrigin()
          const writesEnabled = options.writesEnabled() &&
            approvedOrigin !== null
          if (snapshot === null) return { status: "unpaired", writesEnabled }
          const pairedWritesEnabled = writesEnabled &&
            snapshot.deploymentOrigin === approvedOrigin
          const capabilities = storedCapabilities(snapshot.capabilities)
          return {
            status: "paired",
            pairedAt: snapshot.pairedAt,
            capabilities: pairedWritesEnabled ? capabilities : [],
            writesEnabled: pairedWritesEnabled,
          }
        } catch {
          return { status: "unavailable" }
        }
      })
    },

    async mutate(
      input: unknown,
      sessionActor: VogelVaultMember,
    ): Promise<VogelVaultMutationResult> {
      const identity = safeIdentity(input)
      const request = validateMutationRequest(input)
      if (request === null) {
        return { ...identity, status: "failed", code: "invalid-request" }
      }
      // Refuse rather than silently rewriting the actor: a payload that
      // disagrees with the session is a renderer claiming an identity it was
      // not given, and quietly correcting it would hide that.
      if (request.actor !== sessionActor) {
        return { ...identity, status: "unauthorized" }
      }
      // A genuine actor is not automatically an allowed one. Every validated
      // request carries the EFFECTIVE owner its write will land on (family
      // finance has already canonicalized onto the household ledger), so a
      // child session may write only its own ledger; adults manage any of
      // them, matching the read-profile containment in readProfileSession.
      if (!ADULTS.has(sessionActor) && request.owner !== sessionActor) {
        return { ...identity, status: "unauthorized" }
      }
      if (!options.writesEnabled()) {
        return { ...identity, status: "disabled" }
      }
      const approvedOrigin = options.approvedDeploymentOrigin()
      if (approvedOrigin === null) return { ...identity, status: "not-configured" }
      if (options.store.readiness() !== "ready") {
        return { ...identity, status: "failed", code: "credential-storage" }
      }
      if (
        queuedMutations >= PAIRED_DEVICE_LIMITS.maxInFlight ||
        !mutationRateAvailable()
      ) {
        return { ...identity, status: "failed", code: "unavailable" }
      }

      queuedMutations += 1
      return exclusive(async () => {
        try {
          if (
            !options.writesEnabled() ||
            options.approvedDeploymentOrigin() !== approvedOrigin
          ) {
            return { ...identity, status: "not-configured" }
          }
          let snapshot: DeviceCredentialSnapshot | null
          try {
            snapshot = await options.store.load()
          } catch {
            return { ...identity, status: "failed", code: "credential-storage" }
          }
          if (snapshot === null) return { ...identity, status: "not-configured" }
          if (snapshot.deploymentOrigin !== approvedOrigin) {
            return { ...identity, status: "unauthorized" }
          }
          const capabilities = storedCapabilities(snapshot.capabilities)
          if (!capabilities.includes(request.kind)) {
            return { ...identity, status: "unauthorized" }
          }
          if (
            request.kind === "transaction.upsert" &&
            request.amountSats !== undefined &&
            !capabilities.includes("btcTransfer.upsert")
          ) {
            return { ...identity, status: "unauthorized" }
          }

          const response = await options.post(
            mutationEndpoint(approvedOrigin),
            requestBody(PAIRED_DEVICE_PATHS[request.kind], mutationArgs(request, snapshot)),
            PAIRED_DEVICE_LIMITS.maxResponseBytes,
          )
          const classified = remoteClassification(response)
          if (classified === "unauthorized") {
            await options.store.clearIfCurrent(snapshot.revision).catch(() => false)
            return { ...identity, status: "unauthorized" }
          }
          if (classified === "missing") return { ...identity, status: "missing" }
          if (classified === "conflict") {
            return { ...identity, status: "failed", code: "conflict" }
          }
          if (classified === "rejected") {
            return { ...identity, status: "failed", code: "rejected" }
          }
          if (structuredRemoteError(response) !== null) {
            return { ...identity, status: "failed", code: "invalid-response" }
          }
          try {
            return mutationValue(successEnvelope(response).value, request)
          } catch {
            return { ...identity, status: "failed", code: "invalid-response" }
          }
        } catch {
          return { ...identity, status: "failed", code: "unavailable" }
        } finally {
          queuedMutations -= 1
        }
      })
    },

    async unpair(): Promise<VogelVaultUnpairResult> {
      if (options.store.readiness() !== "ready") return { status: "unavailable" }
      return exclusive(async () => {
        let snapshot: DeviceCredentialSnapshot | null
        try {
          snapshot = await options.store.load()
        } catch {
          return { status: "unavailable" }
        }
        if (snapshot === null) return { status: "unpaired" }

        const approvedOrigin = options.approvedDeploymentOrigin()
        if (approvedOrigin === null || snapshot.deploymentOrigin !== approvedOrigin) {
          const cleared = await options.store.clearIfCurrent(snapshot.revision).catch(() => false)
          return cleared ? { status: "ok", revoked: false } : { status: "unavailable" }
        }

        let response: JsonPostResponse
        try {
          response = await options.post(
            mutationEndpoint(approvedOrigin),
            requestBody(PAIRED_DEVICE_PATHS.revoke, {
              deviceId: snapshot.deviceId,
              deviceToken: snapshot.deviceCredential,
            }),
            PAIRED_DEVICE_LIMITS.maxResponseBytes,
          )
        } catch {
          // Remote-first for an approved host: retain the credential for retry.
          return { status: "failed" }
        }
        const classified = remoteClassification(response)
        if (classified === "unauthorized" || classified === "missing") {
          const cleared = await options.store.clearIfCurrent(snapshot.revision).catch(() => false)
          return cleared ? { status: "ok", revoked: false } : { status: "unavailable" }
        }
        let revoked: boolean
        try {
          const value = successEnvelope(response).value
          if (
            !isRecord(value) ||
            !exactKeys(value, ["ok", "revoked"]) ||
            value["ok"] !== true ||
            typeof value["revoked"] !== "boolean"
          ) {
            throw new InvalidResponse()
          }
          revoked = value["revoked"]
        } catch {
          return { status: "failed" }
        }
        const cleared = await options.store.clearIfCurrent(snapshot.revision).catch(() => false)
        return cleared ? { status: "ok", revoked } : { status: "unavailable" }
      })
    },
  }
}
