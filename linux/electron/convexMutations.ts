// Paired-device enrollment and row mutations. MAIN PROCESS ONLY.
//
// The renderer supplies domain intent. This module supplies the fixed Convex
// path, deployment origin, device identity and credential. There is no generic
// "call a path" escape hatch, and no remote-authored text crosses its results.

import { createHash, randomBytes } from "node:crypto"

import {
  buildTransactionWriteRequest,
  canWriteDataOwnedBy,
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
  "btcAccount.upsert",
  "btcAccount.delete",
] as const satisfies readonly VogelVaultMutationKind[]

const MUTATION_KIND_SET: ReadonlySet<string> = new Set(MUTATION_KINDS)
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/
const PAIR_PART = /^[A-Za-z0-9_-]{8,256}$/
const MIN_INT64 = -(1n << 63n)
const MAX_INT64 = (1n << 63n) - 1n

class InvalidRequest extends Error {}
class InvalidResponse extends Error {}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

interface PairingClaim {
  readonly deploymentOrigin: string
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
  mutate(input: unknown): Promise<VogelVaultMutationResult>
  unpair(): Promise<VogelVaultUnpairResult>
}

export interface PairedDeviceControllerOptions {
  readonly store: DeviceCredentialStore
  readonly post: JsonPoster
  readonly writesEnabled: () => boolean
  readonly random?: (bytes: number) => Buffer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function authorize(actor: VogelVaultMember, owner: VogelVaultMember): void {
  if (!canWriteDataOwnedBy(actor, owner)) throw new InvalidRequest()
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
          ["card", "note"],
        )
        const { requestId, actor } = common(record)
        const owner = member(record["owner"])
        authorize(actor, owner)
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
        }
        // Reuse the shared sign, owner/source and exact-money contract.
        buildTransactionWriteRequest(actor, candidate)
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
        }
      }
      case "transaction.delete":
      case "todo.delete":
      case "btcBuy.delete":
      case "btcBillPay.delete": {
        const record = withCommon(input, kind, ["id", "owner"])
        const { requestId, actor } = common(record)
        const owner = member(record["owner"])
        authorize(actor, owner)
        return {
          kind,
          requestId,
          actor,
          id: boundedText(record["id"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner,
        }
      }
      case "btcAccount.delete": {
        const record = withCommon(input, kind, ["key", "owner"])
        const { requestId, actor } = common(record)
        const owner = member(record["owner"])
        authorize(actor, owner)
        return {
          kind,
          requestId,
          actor,
          key: boundedText(record["key"], PAIRED_DEVICE_LIMITS.maxIdentifier),
          owner,
        }
      }
      case "todo.upsert": {
        const record = withCommon(
          input,
          kind,
          ["id", "owner", "title", "done", "flagged"],
          ["lane", "project", "area", "due", "notes", "priority", "createdAt", "updatedAt", "completedAt"],
        )
        const { requestId, actor } = common(record)
        const owner = member(record["owner"])
        authorize(actor, owner)
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
        }
      }
      case "budgetCategory.upsert": {
        const record = withCommon(
          input,
          kind,
          ["month", "name", "budgetCents"],
          ["originalName", "icon"],
        )
        const { requestId, actor } = common(record)
        budgetSource(actor)
        return {
          kind,
          requestId,
          actor,
          month: exactMonth(record["month"]),
          name: boundedText(record["name"]),
          ...optionalField("originalName", optionalText(record, "originalName")),
          ...optionalField("icon", optionalText(record, "icon")),
          budgetCents: nonnegativeInt64(record["budgetCents"]),
        }
      }
      case "budgetCategory.delete": {
        const record = withCommon(input, kind, ["month", "name"])
        const { requestId, actor } = common(record)
        budgetSource(actor)
        return {
          kind,
          requestId,
          actor,
          month: exactMonth(record["month"]),
          name: boundedText(record["name"]),
        }
      }
      case "btcBuy.upsert": {
        const record = withCommon(
          input,
          kind,
          ["id", "owner", "date", "source", "sats", "priceUsdCents", "usdCents"],
          ["note", "buyStatus", "costBasisStatus", "loggedBy", "archimedesRequestId"],
        )
        const { requestId, actor } = common(record)
        const owner = member(record["owner"])
        authorize(actor, owner)
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
          ["platform", "note", "reference"],
        )
        const { requestId, actor } = common(record)
        const owner = member(record["owner"])
        authorize(actor, owner)
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
        }
      }
      case "btcAccount.upsert": {
        const record = withCommon(
          input,
          kind,
          ["key", "owner", "label", "custody", "sats", "asOf"],
          ["schemaVersion", "fiatValuation"],
        )
        const { requestId, actor } = common(record)
        const owner = member(record["owner"])
        authorize(actor, owner)
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
        }
      }
    }
  } catch {
    return null
  }
}

function transactionSource(owner: VogelVaultMember): string {
  if (owner === "victor" || owner === "rachel") return "transactions"
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
  actor: VogelVaultMember,
): { owner: "victor" | "mason"; sourceFile: "budget" | "mason-budget" } {
  if (actor === "victor" || actor === "rachel") {
    return { owner: "victor", sourceFile: "budget" }
  }
  if (actor === "mason") {
    return { owner: "mason", sourceFile: "mason-budget" }
  }
  throw new InvalidRequest()
}

function pairingClaim(value: unknown): PairingClaim {
  const record = exactObject(value, ["pairingInput", "deviceName"])
  const rawInput = boundedText(record["pairingInput"], PAIRED_DEVICE_LIMITS.maxPairingInput)
  const deviceName = boundedText(record["deviceName"], PAIRED_DEVICE_LIMITS.maxDeviceName)
  let parsed: URL
  try {
    parsed = new URL(rawInput)
  } catch {
    throw new InvalidRequest()
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    !(parsed.hostname === "convex.cloud" || parsed.hostname.endsWith(".convex.cloud"))
  ) {
    throw new InvalidRequest()
  }
  const fragment = new URLSearchParams(parsed.hash.slice(1))
  const values = fragment.getAll("pair")
  if ([...fragment.keys()].some((key) => key !== "pair") || values.length !== 1) {
    throw new InvalidRequest()
  }
  const rawPair = values[0]
  if (rawPair === undefined) throw new InvalidRequest()
  const parts = rawPair.split(".")
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
    deploymentOrigin: parsed.origin,
    pairId: parts[0],
    proofHash: createHash("sha256").update(rawPair, "utf8").digest("hex"),
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
      const wire = buildTransactionWriteRequest(request.actor, {
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
      })
      return { ...auth, owner: request.owner, ...wire.args }
    }
    case "transaction.delete":
      return {
        ...auth,
        entityId: request.id,
        owner: request.owner,
        sourceFile: transactionSource(request.owner),
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
      }
    case "todo.delete":
      return {
        ...auth,
        entityId: request.id,
        owner: request.owner,
        sourceFile: "todos",
      }
    case "budgetCategory.upsert": {
      const budget = budgetSource(request.actor)
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
      }
    }
    case "budgetCategory.delete": {
      const budget = budgetSource(request.actor)
      return {
        ...auth,
        ...budget,
        month: request.month,
        entityId: request.name,
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
      }
    case "btcBuy.delete":
      return {
        ...auth,
        entityId: request.id,
        owner: request.owner,
        sourceFile: btcBuySource(request.owner),
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
      }
    case "btcBillPay.delete":
      return {
        ...auth,
        entityId: request.id,
        owner: request.owner,
        sourceFile: "bitcoin-bill-pays",
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
      }
    }
    case "btcAccount.delete":
      return {
        ...auth,
        entityId: request.key,
        owner: request.owner,
        sourceFile: btcAccountSource(request.owner),
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
  if (!isRecord(envelope) || envelope["status"] !== "success") throw new InvalidResponse()
  return { value: envelope["value"] }
}

function remoteClassification(
  response: JsonPostResponse,
): "unauthorized" | "missing" | "conflict" | "expired" | "already-claimed" | null {
  if (response.httpStatus === 401 || response.httpStatus === 403) return "unauthorized"
  if (response.httpStatus !== 200) return null
  let envelope: unknown
  try {
    envelope = JSON.parse(response.body)
  } catch {
    return null
  }
  if (!isRecord(envelope) || envelope["status"] !== "error") return null
  const detail = envelope["errorData"] ?? envelope["errorMessage"]
  if (typeof detail !== "string") return null
  if (/unauthorized|revoked|unknown device/i.test(detail)) return "unauthorized"
  if (/already claimed/i.test(detail)) return "already-claimed"
  if (/expired/i.test(detail)) return "expired"
  if (/not found|missing/i.test(detail)) return "missing"
  if (/conflict|already exists|stale/i.test(detail)) return "conflict"
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
    "btcAccount.upsert",
    "btcAccount.delete",
  ],
} as const satisfies Readonly<Record<string, readonly VogelVaultMutationKind[]>>

function responseCapabilities(value: unknown): readonly VogelVaultMutationKind[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
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
    value.length === 0 ||
    value.length > MUTATION_KINDS.length ||
    value.some((kind) => typeof kind !== "string" || !MUTATION_KIND_SET.has(kind)) ||
    new Set(value).size !== value.length
  ) {
    throw new InvalidResponse()
  }
  return value as VogelVaultMutationKind[]
}

function pairValue(
  value: unknown,
  expectedDeviceId: string,
): { pairedAt: number; capabilities: readonly VogelVaultMutationKind[] } {
  if (!isRecord(value)) throw new InvalidResponse()
  if (
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
  const entityId = value["entityId"]
  if (
    typeof entityId !== "string" ||
    entityId.length === 0 ||
    entityId.length > PAIRED_DEVICE_LIMITS.maxIdentifier ||
    hasControlCharacter(entityId)
  ) {
    throw new InvalidResponse()
  }
  if (request.kind.endsWith(".upsert")) {
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
  let inFlight = 0

  return {
    async pair(input: unknown): Promise<VogelVaultPairingResult> {
      if (!options.writesEnabled()) return { status: "disabled" }
      let claim: PairingClaim
      try {
        claim = pairingClaim(input)
      } catch {
        return { status: "failed", code: "invalid-input" }
      }
      if (options.store.readiness() !== "ready") {
        return { status: "failed", code: "credential-storage" }
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
          mutationEndpoint(claim.deploymentOrigin),
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
      if (classified !== null) return { status: "failed", code: "unavailable" }

      let paired
      try {
        paired = pairValue(successEnvelope(response).value, deviceId)
      } catch {
        await bestEffortRevoke(options.post, {
          deploymentOrigin: claim.deploymentOrigin,
          deviceId,
          deviceCredential,
        })
        return { status: "failed", code: "invalid-response" }
      }
      const pending: Omit<DeviceCredentialSnapshot, "revision"> = {
        deploymentOrigin: claim.deploymentOrigin,
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
    },

    async status(): Promise<VogelVaultPairingStatus> {
      if (options.store.readiness() !== "ready") return { status: "unavailable" }
      try {
        const snapshot = await options.store.load()
        if (snapshot === null) return { status: "unpaired" }
        const capabilities = storedCapabilities(snapshot.capabilities)
        return { status: "paired", pairedAt: snapshot.pairedAt, capabilities }
      } catch {
        return { status: "unavailable" }
      }
    },

    async mutate(input: unknown): Promise<VogelVaultMutationResult> {
      const identity = safeIdentity(input)
      const request = validateMutationRequest(input)
      if (request === null) {
        return { ...identity, status: "failed", code: "invalid-request" }
      }
      if (!options.writesEnabled()) {
        return { ...identity, status: "disabled" }
      }
      if (options.store.readiness() !== "ready") {
        return { ...identity, status: "failed", code: "credential-storage" }
      }
      let snapshot: DeviceCredentialSnapshot | null
      try {
        snapshot = await options.store.load()
      } catch {
        return { ...identity, status: "failed", code: "credential-storage" }
      }
      if (snapshot === null) return { ...identity, status: "not-configured" }
      if (!snapshot.capabilities.includes(request.kind)) {
        return { ...identity, status: "unauthorized" }
      }
      if (inFlight >= PAIRED_DEVICE_LIMITS.maxInFlight) {
        return { ...identity, status: "failed", code: "unavailable" }
      }

      inFlight += 1
      try {
        const response = await options.post(
          mutationEndpoint(snapshot.deploymentOrigin),
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
        try {
          return mutationValue(successEnvelope(response).value, request)
        } catch {
          return { ...identity, status: "failed", code: "invalid-response" }
        }
      } catch {
        return { ...identity, status: "failed", code: "unavailable" }
      } finally {
        inFlight -= 1
      }
    },

    async unpair(): Promise<VogelVaultUnpairResult> {
      if (options.store.readiness() !== "ready") return { status: "unavailable" }
      let snapshot: DeviceCredentialSnapshot | null
      try {
        snapshot = await options.store.load()
      } catch {
        return { status: "unavailable" }
      }
      if (snapshot === null) return { status: "unpaired" }

      let response: JsonPostResponse
      try {
        response = await options.post(
          mutationEndpoint(snapshot.deploymentOrigin),
          requestBody(PAIRED_DEVICE_PATHS.revoke, {
            deviceId: snapshot.deviceId,
            deviceToken: snapshot.deviceCredential,
          }),
          PAIRED_DEVICE_LIMITS.maxResponseBytes,
        )
      } catch {
        // Remote-first by design: retain the credential so revocation can retry.
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
        if (!isRecord(value) || value["ok"] !== true || typeof value["revoked"] !== "boolean") {
          throw new InvalidResponse()
        }
        revoked = value["revoked"]
      } catch {
        return { status: "failed" }
      }
      const cleared = await options.store.clearIfCurrent(snapshot.revision).catch(() => false)
      return cleared ? { status: "ok", revoked } : { status: "unavailable" }
    },
  }
}
