import {
  type FamilyMember,
  canSeeDataOwnedBy,
  ledgerOwner,
} from "@vogel-vault/domain/family"
import { isConvexInt64 } from "@vogel-vault/domain"
import type {
  BTCAccount,
  BTCBillPay,
  BTCBuy,
  BudgetCategory,
  TodoItem,
  Transaction,
} from "@vogel-vault/domain/readModel"

import type { FixtureEnvelope } from "./fixtures.ts"
import type {
  VogelVaultMutationKind,
  VogelVaultMutationRequest,
  VogelVaultMutationResult,
  VogelVaultPairingRequest,
  VogelVaultPairingResult,
  VogelVaultPairingStatus,
  VogelVaultUnpairResult,
} from "../../../shared/ipc.ts"

// Renderer code consumes the one shared preload contract directly. These
// aliases deliberately contain no local fields: a main-process contract change
// must fail this TypeScript project instead of silently compiling two dialects.
export type RendererMutationKind = VogelVaultMutationKind
export type RendererMutationRequest = VogelVaultMutationRequest
export type RendererMutationResult = VogelVaultMutationResult
export type PairingStatus = VogelVaultPairingStatus
export type PairingRequest = VogelVaultPairingRequest
export type PairingResult = VogelVaultPairingResult
export type UnpairResult = VogelVaultUnpairResult

export interface RendererMutationAdapter {
  getPairingStatus(): Promise<PairingStatus>
  pairDevice(request: PairingRequest): Promise<PairingResult>
  mutateConvexRow(request: RendererMutationRequest): Promise<RendererMutationResult>
  unpairDevice(): Promise<UnpairResult>
}

export type DataOrigin = "remote" | "fixture"

export const MUTATION_MESSAGES: Readonly<Record<RendererMutationResult["status"], string>> = {
  ok: "Saved.",
  disabled: "Editing is not available for this item in this build.",
  "not-configured": "Editing is not configured on this device.",
  unauthorized: "Your change was not authorized. Nothing was saved.",
  missing: "This item no longer exists. The latest rows will be reloaded.",
  failed: "The ledger could not be reached. Your change was rolled back; try again.",
}

export interface MutationGateInput {
  readonly dataOrigin: DataOrigin
  readonly bridgeAvailable: boolean
  readonly writesEnabled: boolean
  readonly capabilities: readonly RendererMutationKind[]
  readonly kind: RendererMutationKind
  readonly actor: FamilyMember
  readonly owner?: FamilyMember
  readonly freshness: string
  readonly selectedMonth?: string
  readonly persistedMonth?: string
}

export interface MutationGate {
  readonly allowed: boolean
  readonly reason: string | null
}

export function mutationGate(input: MutationGateInput): MutationGate {
  if (input.dataOrigin !== "remote") {
    return { allowed: false, reason: "Sample and fallback data cannot be edited." }
  }
  if (!input.bridgeAvailable) {
    return { allowed: false, reason: "The secure write bridge is unavailable." }
  }
  if (!input.writesEnabled) {
    return { allowed: false, reason: "Paired-device writes are disabled in this runtime." }
  }
  if (!input.capabilities.includes(input.kind)) {
    return { allowed: false, reason: "This operation is not enabled for the paired device." }
  }
  if (input.freshness === "error" || input.freshness === "loading" || input.freshness === "empty") {
    return { allowed: false, reason: "Wait for current remote rows before editing." }
  }
  if (input.owner && !canSeeDataOwnedBy(input.actor, input.owner)) {
    return { allowed: false, reason: "This profile cannot edit that owner's record." }
  }
  if (input.owner && !supportsMutationOwner(input.kind, input.owner)) {
    return {
      allowed: false,
      reason: "This profile has no supported durable source for that operation.",
    }
  }
  if (
    input.kind.startsWith("budgetCategory.") &&
    input.selectedMonth !== input.persistedMonth
  ) {
    return { allowed: false, reason: "Only the current persisted budget month can be edited." }
  }
  return { allowed: true, reason: null }
}

export function parseExactCents(value: string): bigint | null {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const sign = match[1] === "-" ? -1n : 1n
  const whole = BigInt(match[2]!)
  const fraction = BigInt((match[3] ?? "").padEnd(2, "0"))
  const cents = sign * (whole * 100n + fraction)
  return isConvexInt64(cents) ? cents : null
}

export function parseExactSats(value: string): bigint | null {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return null
  const sats = BigInt(normalized)
  return isConvexInt64(sats) ? sats : null
}

export function mutationOwner(
  kind: RendererMutationKind,
  actorOrStoredOwner: FamilyMember,
): FamilyMember {
  return kind.startsWith("todo.") ? actorOrStoredOwner : ledgerOwner(actorOrStoredOwner)
}

export function supportsMutationOwner(
  kind: RendererMutationKind,
  actorOrStoredOwner: FamilyMember,
): boolean {
  const owner = mutationOwner(kind, actorOrStoredOwner)
  if (kind.startsWith("todo.") || kind.startsWith("transaction.")) return true
  if (kind.startsWith("btcBillPay.")) return owner === "victor"
  return owner === "victor" || owner === "mason"
}

export function formatCentsInput(value: bigint): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  return `${negative ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n)
    .toString()
    .padStart(2, "0")}`
}

export function stableId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `${prefix}-${uuid}`
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function entityKey(request: RendererMutationRequest): string {
  switch (request.kind) {
    case "budgetCategory.upsert":
      return `budgetCategory:${request.month}:${request.originalName ?? request.name}`
    case "budgetCategory.delete":
      return `budgetCategory:${request.month}:${request.name}`
    case "btcAccount.upsert":
    case "btcAccount.delete":
      return `btcAccount:${request.owner}:${request.key}`
    default:
      return `${request.kind.split(".")[0]}:${request.owner}:${request.id}`
  }
}

export interface PendingMutation {
  readonly request: RendererMutationRequest
  readonly entityKey: string
  readonly revision: number
  readonly profile: FamilyMember
  readonly generation: number
  /** Exact object identity that was present when the optimistic change began. */
  readonly snapshot: unknown
}

export interface MutationControllerState {
  readonly nextRevision: number
  readonly pending: Readonly<Record<string, PendingMutation>>
  readonly committed: readonly PendingMutation[]
  readonly notice: { readonly tone: "positive" | "negative" | "warning"; readonly text: string } | null
}

export const EMPTY_MUTATION_CONTROLLER: MutationControllerState = {
  nextRevision: 1,
  pending: {},
  committed: [],
  notice: null,
}

export type BeginMutationResult =
  | { readonly status: "started"; readonly state: MutationControllerState; readonly pending: PendingMutation }
  | { readonly status: "busy"; readonly state: MutationControllerState }

export function beginMutation(
  state: MutationControllerState,
  request: RendererMutationRequest,
  data: FixtureEnvelope,
  profile: FamilyMember,
  generation: number,
): BeginMutationResult {
  const key = entityKey(request)
  if (
    state.pending[key] ||
    state.committed.some((mutation) => mutation.entityKey === key)
  ) {
    return { status: "busy", state }
  }
  const pending: PendingMutation = {
    request,
    entityKey: key,
    revision: state.nextRevision,
    profile,
    generation,
    snapshot: mutationSnapshot(data, request),
  }
  return {
    status: "started",
    pending,
    state: {
      ...state,
      nextRevision: state.nextRevision + 1,
      pending: { ...state.pending, [key]: pending },
      notice: null,
    },
  }
}

export function settleMutation(
  state: MutationControllerState,
  pending: PendingMutation,
  result: RendererMutationResult,
  profile: FamilyMember,
  generation: number,
): MutationControllerState {
  const current = state.pending[pending.entityKey]
  if (
    !current ||
    current.request.requestId !== result.requestId ||
    current.revision !== pending.revision ||
    current.profile !== profile ||
    current.generation !== generation ||
    result.kind !== current.request.kind
  ) {
    return state
  }
  const nextPending = { ...state.pending }
  delete nextPending[pending.entityKey]
  return {
    ...state,
    pending: nextPending,
    committed: result.status === "ok" ? [...state.committed, current] : state.committed,
    notice: {
      tone: result.status === "ok" ? "positive" : "negative",
      text: MUTATION_MESSAGES[result.status],
    },
  }
}

export function finishRefresh(
  state: MutationControllerState,
  profile: FamilyMember,
  generation: number,
  succeeded: boolean,
  requestIds?: readonly string[],
): MutationControllerState {
  const requested = requestIds ? new Set(requestIds) : null
  const applicable = state.committed.filter(
    (mutation) =>
      mutation.profile === profile &&
      mutation.generation === generation &&
      (requested === null || requested.has(mutation.request.requestId)),
  )
  if (applicable.length === 0) return state
  if (!succeeded) {
    return {
      ...state,
      notice: {
        tone: "warning",
        text: "Saved, but the latest rows could not be refreshed. Retry the refresh.",
      },
    }
  }
  const settled = new Set(applicable.map((mutation) => mutation.request.requestId))
  return {
    ...state,
    committed: state.committed.filter(
      (mutation) => !settled.has(mutation.request.requestId),
    ),
  }
}

export function optimisticEnvelope(
  data: FixtureEnvelope,
  state: MutationControllerState,
  profile: FamilyMember,
  generation: number,
): FixtureEnvelope {
  let result = data
  for (const mutation of [...state.committed, ...Object.values(state.pending)]) {
    if (mutation.profile === profile && mutation.generation === generation) {
      result = applyOptimisticMutation(result, mutation.request)
    }
  }
  return result
}

export function isEntityPending(
  state: MutationControllerState,
  kind: RendererMutationKind,
  owner: FamilyMember,
  id: string,
  month?: string,
): boolean {
  const key = kind.startsWith("budgetCategory.")
    ? `budgetCategory:${month ?? ""}:${id}`
    : kind.startsWith("btcAccount.")
      ? `btcAccount:${owner}:${id}`
      : `${kind.split(".")[0]}:${owner}:${id}`
  return Boolean(
    state.pending[key] ||
    state.committed.some((mutation) => mutation.entityKey === key),
  )
}

function mutationSnapshot(
  data: FixtureEnvelope,
  request: RendererMutationRequest,
): unknown {
  switch (request.kind) {
    case "transaction.upsert":
    case "transaction.delete":
      return data.transactions.value.find((row) => row.id === request.id)
    case "todo.upsert":
    case "todo.delete":
      return data.todos.value.find((row) => row.id === request.id)
    case "budgetCategory.upsert":
    case "budgetCategory.delete":
      return data.budget.value?.categories.find(
        (row) =>
          row.name === (
            request.kind === "budgetCategory.upsert"
              ? request.originalName ?? request.name
              : request.name
          ),
      )
    case "btcBuy.upsert":
    case "btcBuy.delete":
      return data.btcBuys.value.find((row) => row.id === request.id)
    case "btcBillPay.upsert":
    case "btcBillPay.delete":
      return data.billPays.value.find((row) => row.id === request.id)
    case "btcAccount.upsert":
    case "btcAccount.delete":
      return data.btcAccounts.value.find((row) => row.key === request.key)
  }
}

function replaceOrAppend<T>(
  rows: readonly T[],
  matches: (row: T) => boolean,
  replacement: T,
): readonly T[] {
  const index = rows.findIndex(matches)
  if (index < 0) return [replacement, ...rows]
  return rows.map((row, rowIndex) => (rowIndex === index ? replacement : row))
}

export function applyOptimisticMutation(
  data: FixtureEnvelope,
  request: RendererMutationRequest,
): FixtureEnvelope {
  switch (request.kind) {
    case "transaction.upsert": {
      const existing = data.transactions.value.find((item) => item.id === request.id)
      const row: Transaction = {
        id: request.id,
        updatedAtMs: existing?.updatedAtMs ?? 0,
        owner: request.owner,
        date: request.date,
        merchant: request.merchant,
        amount: request.amountCents,
        category: request.category,
        card: request.card ?? null,
        note: request.note ?? null,
      }
      return {
        ...data,
        transactions: {
          ...data.transactions,
          value: replaceOrAppend(data.transactions.value, (item) => item.id === row.id, row),
        },
      }
    }
    case "transaction.delete":
      return {
        ...data,
        transactions: {
          ...data.transactions,
          value: data.transactions.value.filter((row) => row.id !== request.id),
        },
      }
    case "todo.upsert": {
      const existing = data.todos.value.find((item) => item.id === request.id)
      const row: TodoItem = {
        id: request.id,
        updatedAtMs: existing?.updatedAtMs ?? 0,
        owner: request.owner,
        title: request.title,
        done: request.done,
        flagged: request.flagged,
        lane: request.lane ?? existing?.lane ?? null,
        priority: request.priority ?? existing?.priority ?? null,
        createdAt: request.createdAt ?? existing?.createdAt ?? null,
        updatedAt: request.updatedAt ?? existing?.updatedAt ?? null,
        completedAt: request.done
          ? request.completedAt ?? existing?.completedAt ?? null
          : null,
        project: request.project ?? null,
        area: request.area ?? null,
        due: request.due ?? null,
        notes: request.notes ?? null,
      }
      return {
        ...data,
        todos: {
          ...data.todos,
          value: replaceOrAppend(data.todos.value, (item) => item.id === row.id, row),
        },
      }
    }
    case "todo.delete":
      return {
        ...data,
        todos: { ...data.todos, value: data.todos.value.filter((row) => row.id !== request.id) },
      }
    case "budgetCategory.upsert": {
      const budget = data.budget.value
      if (!budget) return data
      const existingName = request.originalName ?? request.name
      const existing = budget.categories.find((row) => row.name === existingName)
      const row: BudgetCategory = {
        name: request.name,
        icon: request.icon ?? null,
        budget: request.budgetCents,
        spent: existing?.spent ?? 0n,
      }
      return {
        ...data,
        budget: {
          ...data.budget,
          value: {
            ...budget,
            categories: replaceOrAppend(
              budget.categories,
              (category) => category.name === existingName,
              row,
            ),
          },
        },
      }
    }
    case "budgetCategory.delete": {
      const budget = data.budget.value
      if (!budget) return data
      return {
        ...data,
        budget: {
          ...data.budget,
          value: {
            ...budget,
            categories: budget.categories.filter((row) => row.name !== request.name),
          },
        },
      }
    }
    case "btcBuy.upsert": {
      const existing = data.btcBuys.value.find((item) => item.id === request.id)
      const row: BTCBuy = {
        id: request.id,
        updatedAtMs: existing?.updatedAtMs ?? 0,
        owner: request.owner,
        date: request.date,
        source: request.source,
        sats: request.sats,
        priceUsd: request.priceUsdCents,
        usd: request.usdCents,
        note: request.note ?? null,
        status: request.buyStatus ?? null,
        costBasisStatus: request.costBasisStatus ?? null,
        loggedBy: request.loggedBy ?? null,
        archimedesRequestId:
          request.archimedesRequestId ?? existing?.archimedesRequestId ?? null,
      }
      return {
        ...data,
        btcBuys: {
          ...data.btcBuys,
          value: replaceOrAppend(data.btcBuys.value, (item) => item.id === row.id, row),
        },
      }
    }
    case "btcBuy.delete":
      return {
        ...data,
        btcBuys: { ...data.btcBuys, value: data.btcBuys.value.filter((row) => row.id !== request.id) },
      }
    case "btcBillPay.upsert": {
      const existing = data.billPays.value.find((item) => item.id === request.id)
      const row: BTCBillPay = {
        id: request.id,
        updatedAtMs: existing?.updatedAtMs ?? 0,
        owner: request.owner,
        date: request.date,
        merchant: request.merchant,
        category: request.category,
        amountUsd: request.amountUsdCents,
        btcSpentSats: request.btcSpentSats,
        btcPrice: request.btcPriceCents,
        platform: request.platform ?? null,
        note: request.note ?? null,
        feeUsd: request.feeUsdCents,
        reference: request.reference ?? null,
      }
      return {
        ...data,
        billPays: {
          ...data.billPays,
          value: replaceOrAppend(data.billPays.value, (item) => item.id === row.id, row),
        },
      }
    }
    case "btcBillPay.delete":
      return {
        ...data,
        billPays: { ...data.billPays, value: data.billPays.value.filter((row) => row.id !== request.id) },
      }
    case "btcAccount.upsert": {
      const existing = data.btcAccounts.value.find((row) => row.key === request.key)
      const row: BTCAccount = {
        key: request.key,
        updatedAtMs: existing?.updatedAtMs ?? 0,
        asOf: request.asOf,
        owner: request.owner,
        label: request.label,
        custody: request.custody,
        sats: request.sats,
        // Required legacy mirror only. No valuation object means USD remains unavailable.
        fiat: request.fiatValuation?.cents ?? existing?.fiat ?? 0n,
        fiatValuation: request.fiatValuation
          ? {
              cents: request.fiatValuation.cents,
              priceCents: request.fiatValuation.priceCents ?? null,
              quotedAt: request.fiatValuation.quotedAt ?? null,
              source: request.fiatValuation.source ?? null,
              confidence: request.fiatValuation.confidence ?? null,
            }
          : existing?.fiatValuation,
      }
      return {
        ...data,
        btcAccounts: {
          ...data.btcAccounts,
          value: replaceOrAppend(data.btcAccounts.value, (item) => item.key === row.key, row),
        },
      }
    }
    case "btcAccount.delete":
      return {
        ...data,
        btcAccounts: {
          ...data.btcAccounts,
          value: data.btcAccounts.value.filter((row) => row.key !== request.key),
        },
      }
  }
}
