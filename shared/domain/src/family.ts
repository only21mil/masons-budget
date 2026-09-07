// The Vogel Vault — shared family/visibility contract.
//
// This is a direct port of MasonsBudget/MasonsBudget/Models/SharedEnums.swift.
// The Swift enum is the source of truth; this file must stay behaviourally
// identical to it. Parity is enforced by fixtures/visibility-cases.json, which
// the TypeScript and Kotlin test suites both consume.
//
// HARD RULE (repo AGENTS.md): Victor and Rachel are ONE shared household and see
// identical data. Canonical untagged adult records default to owner "victor",
// so any strict `owner === activeMember` check empties Rachel's tabs. That bug
// shipped in v0.3. Always route visibility through canSeeDataOwnedBy — never
// strict equality.

export const FAMILY_MEMBERS = ["victor", "rachel", "mason", "maddox"] as const

export type FamilyMember = (typeof FAMILY_MEMBERS)[number]

export function isFamilyMember(value: unknown): value is FamilyMember {
  return typeof value === "string" && (FAMILY_MEMBERS as readonly string[]).includes(value)
}

/** Untagged adult records resolve to "victor", matching the Swift default. */
export const DEFAULT_OWNER: FamilyMember = "victor"

export function coerceOwner(value: unknown): FamilyMember {
  return isFamilyMember(value) ? value : DEFAULT_OWNER
}

const ADULTS: ReadonlySet<FamilyMember> = new Set<FamilyMember>(["victor", "rachel"])

export function isAdult(member: FamilyMember): boolean {
  return ADULTS.has(member)
}

/**
 * Canonical owner for financial ledger records.
 *
 * Victor and Rachel are one adult household whose durable records are stored
 * as Victor-owned. The active profile remains the actor/viewer; it must never
 * be copied into the owner field merely because Rachel initiated a write.
 */
export function ledgerOwner(member: FamilyMember): FamilyMember {
  return isAdult(member) ? DEFAULT_OWNER : member
}

/** Adults get the full budget/spending surface; kids get a Bitcoin-focused one. */
export function showsFullBudget(member: FamilyMember): boolean {
  return isAdult(member)
}

/**
 * Adults can see the household and the kids. Kids see only their own data.
 * Port of `FamilyMember.canSee(dataOwnedBy:)`.
 */
export function canSeeDataOwnedBy(viewer: FamilyMember, owner: FamilyMember): boolean {
  if (viewer === owner) return true
  if (isAdult(viewer)) return true
  return false
}

/**
 * Net-worth totals are household-scoped for adults, but child stacks must never
 * roll into adult totals. Port of `FamilyMember.sharesNetWorth(with:)`.
 *
 * Note this is deliberately narrower than canSeeDataOwnedBy: an adult can *see*
 * Mason's Strike balance on his profile, but it is not part of adult net worth.
 */
export function sharesNetWorthWith(viewer: FamilyMember, owner: FamilyMember): boolean {
  if (viewer === owner) return true
  return isAdult(viewer) && isAdult(owner)
}

/** Kids cannot switch out of their own profile. Port of `allowedSwitchTargets`. */
export function allowedSwitchTargets(member: FamilyMember): FamilyMember[] {
  return isAdult(member) ? [...FAMILY_MEMBERS] : [member]
}

/** Every profile switch is authenticated. Port of `requiresAuthToSwitch`. */
export function requiresAuthToSwitch(_member: FamilyMember): boolean {
  return true
}

export function displayName(member: FamilyMember): string {
  return member.charAt(0).toUpperCase() + member.slice(1)
}

export function profileDescription(member: FamilyMember): string {
  switch (member) {
    case "victor":
    case "rachel":
      return "Full budget, spending & Bitcoin"
    case "mason":
      return "Bitcoin stack & spending"
    case "maddox":
      return "Bitcoin stack & allowance"
  }
}

/**
 * Retained blob routing for the approval-gated whole-file writeback path.
 * Runtime clients read row tables and must not use this as a read plan.
 */
export function transactionsDataFileName(member: FamilyMember): string {
  switch (member) {
    case "victor":
    case "rachel":
      return "transactions"
    case "mason":
      return "mason-transactions"
    case "maddox":
      return "maddox-transactions"
  }
}

/** Retained buy-blob routing for approval-gated whole-file writeback. */
export function btcBuysDataFileName(member: FamilyMember): string {
  return member === "mason" ? "mason-bitcoin-buys" : "bitcoin-buys"
}

/** Mason has dedicated child finance blobs; Maddox currently has none. */
export function hasDedicatedChildFinanceFiles(member: FamilyMember): boolean {
  return member === "mason"
}

// ── Collection helpers ──────────────────────────────────────────────────────
// The clients should filter through these rather than hand-rolling predicates,
// so the v0.3 strict-equality regression cannot reappear per-view.

export interface Owned {
  readonly owner: FamilyMember
}

export function visibleTo<T extends Owned>(viewer: FamilyMember, items: readonly T[]): T[] {
  return items.filter((item) => canSeeDataOwnedBy(viewer, item.owner))
}

export function netWorthScopeFor<T extends Owned>(viewer: FamilyMember, items: readonly T[]): T[] {
  return items.filter((item) => sharesNetWorthWith(viewer, item.owner))
}
