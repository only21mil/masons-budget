import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { type FamilyMember, requiresAuthToSwitch } from "../src/family.ts"
import {
  canSeeTodoOwnedBy,
  canWriteTodoOwnedBy,
  todosForActiveProfile,
} from "../src/todo.ts"

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/todo-visibility-cases.json", import.meta.url), "utf8"),
) as {
  contractVersion: number
  matrix: Array<{ activeProfile: FamilyMember; owner: FamilyMember; expected: boolean }>
  sampleTodos: Array<{ id: string; title: string; owner: FamilyMember }>
  lists: Array<{ activeProfile: FamilyMember; expectedIds: string[] }>
}

test("todo exact-owner visibility and write authorization cover every profile pair", () => {
  assert.equal(fixture.contractVersion, 1)
  assert.equal(fixture.matrix.length, 16)
  for (const row of fixture.matrix) {
    assert.equal(canSeeTodoOwnedBy(row.activeProfile, row.owner), row.expected)
    assert.equal(canWriteTodoOwnedBy(row.activeProfile, row.owner), row.expected)
  }
})

test("todo lists never aggregate profiles", () => {
  for (const row of fixture.lists) {
    assert.deepEqual(
      todosForActiveProfile(row.activeProfile, fixture.sampleTodos).map((todo) => todo.id),
      row.expectedIds,
    )
  }
})

test("changing the active profile remains authentication-gated", () => {
  for (const profile of ["victor", "rachel", "mason", "maddox"] as const) {
    assert.equal(requiresAuthToSwitch(profile), true)
  }
})
