// Parity suite for the shared family/visibility contract.
//
// Every case here is driven by ../fixtures/visibility-cases.json, which is the
// same file the Android (Kotlin) suite loads. The fixture was ported case-for-
// case from MasonsBudget/MasonsBudgetTests/FamilyVisibilityTests.swift. If the
// Swift suite changes, update the fixture in the same commit and all three
// clients move together.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  type FamilyMember,
  allowedSwitchTargets,
  btcBuysDataFileName,
  canSeeDataOwnedBy,
  coerceOwner,
  hasDedicatedChildFinanceFiles,
  isAdult,
  ledgerOwner,
  netWorthScopeFor,
  sharesNetWorthWith,
  showsFullBudget,
  transactionsDataFileName,
  visibleTo,
} from "../src/family.ts"
import { parseCents, sum } from "../src/money.ts"
import {
  type Transaction,
  budgetTransactionsFor,
  spendAmount,
} from "../src/readModel.ts"

// The fixture file is language-neutral JSON, so it arrives untyped. Describing
// its shape here keeps the suite type-checked rather than silently `any`, and
// makes a fixture edit that breaks the contract a compile error.
interface PairCase {
  viewer: FamilyMember
  owner: FamilyMember
  expected: boolean
  note?: string
}
interface MemberCase<T> {
  member: FamilyMember
  expected: T
}
interface SampleTransaction {
  id: string
  merchant: string
  amount: string
  category: string
  owner: FamilyMember
  spendAmount: string
}
interface SampleAccount {
  key: string
  label: string
  custody: string
  btc: string
  owner: FamilyMember
}
type ByMember<T> = Record<FamilyMember, T>

interface Fixtures {
  members: FamilyMember[]
  adults: FamilyMember[]
  defaultOwner: FamilyMember
  ledgerOwner: MemberCase<FamilyMember>[]
  canSee: PairCase[]
  sharesNetWorth: PairCase[]
  allowedSwitchTargets: MemberCase<FamilyMember[]>[]
  showsFullBudget: MemberCase<boolean>[]
  transactionsDataFileName: MemberCase<string>[]
  btcBuysDataFileName: MemberCase<string>[]
  hasDedicatedChildFinanceFiles: MemberCase<boolean>[]
  sampleTransactions: SampleTransaction[]
  sampleAccounts: SampleAccount[]
  expectations: {
    visibleTransactionCount: ByMember<number>
    visibleTransactionMerchants: Partial<ByMember<string[]>>
    visibleAccountCount: ByMember<number>
    visibleAccountLabels: Partial<ByMember<string[]>>
    netWorthAccountLabels: ByMember<string[]>
    visibleSpend: ByMember<string>
    budgetSpend: ByMember<string>
    budgetOwners: ByMember<FamilyMember[]>
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "visibility-cases.json"), "utf8"),
) as Fixtures

const members = fixtures.members

test("canSeeDataOwnedBy matches the Swift contract", () => {
  for (const testCase of fixtures.canSee) {
    assert.equal(
      canSeeDataOwnedBy(testCase.viewer, testCase.owner),
      testCase.expected,
      `${testCase.viewer} → ${testCase.owner}${testCase.note ? ` (${testCase.note})` : ""}`,
    )
  }
})

test("every viewer/owner pair is covered", () => {
  assert.equal(fixtures.canSee.length, members.length * members.length)
})

test("Rachel sees Victor's data — the v0.3 regression", () => {
  assert.equal(canSeeDataOwnedBy("rachel", "victor"), true)
})

test("siblings stay isolated", () => {
  assert.equal(canSeeDataOwnedBy("mason", "maddox"), false)
  assert.equal(canSeeDataOwnedBy("maddox", "mason"), false)
})

test("sharesNetWorthWith keeps child stacks out of adult totals", () => {
  for (const testCase of fixtures.sharesNetWorth) {
    assert.equal(
      sharesNetWorthWith(testCase.viewer, testCase.owner),
      testCase.expected,
      `${testCase.viewer} → ${testCase.owner}`,
    )
  }
})

test("every viewer/owner net-worth pair is covered", () => {
  assert.equal(fixtures.sharesNetWorth.length, members.length * members.length)
})

test("sharesNetWorthWith is strictly narrower than canSeeDataOwnedBy", () => {
  for (const viewer of members) {
    for (const owner of members) {
      if (sharesNetWorthWith(viewer, owner)) {
        assert.equal(canSeeDataOwnedBy(viewer, owner), true, `${viewer} → ${owner}`)
      }
    }
  }
})

test("allowedSwitchTargets locks kids to their own profile", () => {
  for (const testCase of fixtures.allowedSwitchTargets) {
    assert.deepEqual(allowedSwitchTargets(testCase.member), testCase.expected)
  }
})

test("showsFullBudget tracks adulthood", () => {
  for (const testCase of fixtures.showsFullBudget) {
    assert.equal(showsFullBudget(testCase.member), testCase.expected)
    assert.equal(isAdult(testCase.member), testCase.expected)
  }
})

test("ledgerOwner keeps actor identity separate from canonical financial ownership", () => {
  for (const testCase of fixtures.ledgerOwner) {
    assert.equal(ledgerOwner(testCase.member), testCase.expected)
  }
})

test("retained data-file routing matches the shared fixture", () => {
  for (const testCase of fixtures.transactionsDataFileName) {
    assert.equal(transactionsDataFileName(testCase.member), testCase.expected)
  }
  for (const testCase of fixtures.btcBuysDataFileName) {
    assert.equal(btcBuysDataFileName(testCase.member), testCase.expected)
  }
  for (const testCase of fixtures.hasDedicatedChildFinanceFiles) {
    assert.equal(hasDedicatedChildFinanceFiles(testCase.member), testCase.expected)
  }
})

test("untagged records default to Victor, explicit owners survive", () => {
  assert.equal(coerceOwner(undefined), fixtures.defaultOwner)
  assert.equal(coerceOwner(null), fixtures.defaultOwner)
  assert.equal(coerceOwner("not-a-member"), fixtures.defaultOwner)
  assert.equal(coerceOwner("mason"), "mason")
})

// ── Collection filtering, mirroring the Swift filter tests ──────────────────

test("transaction filtering matches expected counts", () => {
  const transactions = fixtures.sampleTransactions
  for (const member of members) {
    assert.equal(
      visibleTo(member, transactions).length,
      fixtures.expectations.visibleTransactionCount[member],
      `${member} transaction visibility`,
    )
  }
})

test("children see only their own transactions", () => {
  for (const [member, merchants] of Object.entries(fixtures.expectations.visibleTransactionMerchants)) {
    assert.deepEqual(
      visibleTo(member as FamilyMember, fixtures.sampleTransactions).map((tx: { merchant: string }) => tx.merchant),
      merchants,
    )
  }
})

test("account filtering and net-worth scope diverge for children", () => {
  for (const member of members) {
    assert.equal(
      visibleTo(member, fixtures.sampleAccounts).length,
      fixtures.expectations.visibleAccountCount[member],
      `${member} account visibility`,
    )
    assert.deepEqual(
      netWorthScopeFor(member, fixtures.sampleAccounts).map((a: { label: string }) => a.label),
      fixtures.expectations.netWorthAccountLabels[member],
      `${member} net-worth scope`,
    )
  }
})

test("an adult sees Mason's account but excludes it from net worth", () => {
  const visible = visibleTo("victor", fixtures.sampleAccounts).map((a: { label: string }) => a.label)
  const netWorth = netWorthScopeFor("victor", fixtures.sampleAccounts).map((a: { label: string }) => a.label)
  assert.ok(visible.includes("Mason Strike"))
  assert.ok(!netWorth.includes("Mason Strike"))
})

test("visible spend retains child rows for adult oversight", () => {
  for (const member of members) {
    const total = sum(
      visibleTo(member, fixtures.sampleTransactions).map((tx: { spendAmount: string }) => parseCents(tx.spendAmount)),
    )
    assert.equal(
      total,
      parseCents(fixtures.expectations.visibleSpend[member]),
      `${member} visible spend`,
    )
  }
})

test("budget spend uses adult household scope and child self scope", () => {
  const transactions: Transaction[] = fixtures.sampleTransactions.map((transaction) => ({
    id: transaction.id,
    updatedAtMs: 1,
    date: "2026-07-01",
    merchant: transaction.merchant,
    amount: parseCents(transaction.amount),
    category: transaction.category,
    card: null,
    note: null,
    owner: transaction.owner,
  }))

  for (const member of members) {
    const scoped = budgetTransactionsFor(member, transactions)
    assert.deepEqual(
      [...new Set(scoped.map((transaction) => transaction.owner))],
      fixtures.expectations.budgetOwners[member],
      `${member} budget owners`,
    )
    assert.equal(
      sum(scoped.map(spendAmount)),
      parseCents(fixtures.expectations.budgetSpend[member]),
      `${member} budget spend`,
    )
  }
})

test("empty collections do not throw", () => {
  assert.deepEqual(visibleTo("mason", []), [])
  assert.deepEqual(netWorthScopeFor("mason", []), [])
})
