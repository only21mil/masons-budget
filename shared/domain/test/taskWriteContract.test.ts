import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  TASK_WRITE_SERVER_ERROR_CODES,
  WriteContractError,
  buildCreateTaskWriteRequest,
  buildDeleteTaskWriteRequest,
  buildRestoreTaskWriteRequest,
  buildUpdateTaskWriteRequest,
  type ProfileBoundTaskSession,
  type TaskWriteServerErrorCode,
} from "../src/index.ts"

type FixtureOperation = "create" | "update" | "delete" | "restore"

interface AcceptedCase {
  name: string
  operation: FixtureOperation
  input: unknown
  expected: unknown
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/task-write-wire-cases.json", import.meta.url), "utf8"),
) as {
  contractVersion: number
  format: string
  session: ProfileBoundTaskSession
  accepted: AcceptedCase[]
  serverRejections: Array<{
    name: string
    operation: FixtureOperation
    errorCode: TaskWriteServerErrorCode
  }>
  syncTokenTaskWrites: { mode: string; interactive: boolean }
}

function build(operation: FixtureOperation, input: unknown) {
  switch (operation) {
    case "create": return buildCreateTaskWriteRequest(fixture.session, input)
    case "update": return buildUpdateTaskWriteRequest(fixture.session, input)
    case "delete": return buildDeleteTaskWriteRequest(fixture.session, input)
    case "restore": return buildRestoreTaskWriteRequest(fixture.session, input)
  }
}

test("profile-bound task writes match the shared golden wire payloads", () => {
  assert.equal(fixture.contractVersion, 1)
  assert.equal(fixture.format, "convex_encoded_json")
  for (const testCase of fixture.accepted) {
    assert.deepEqual(build(testCase.operation, testCase.input), testCase.expected, testCase.name)
  }
})

test("authority echoes always come from the profile-bound session", () => {
  for (const testCase of fixture.accepted) {
    const request = build(testCase.operation, testCase.input)
    assert.equal(request.args.activeProfile, fixture.session.profile, testCase.name)
    assert.equal(request.args.owner, fixture.session.profile, testCase.name)
    assert.equal(request.args.deviceId, fixture.session.deviceId, testCase.name)
  }

  const create = fixture.accepted.find((row) => row.operation === "create")!
  const input = create.input as { todo: Record<string, unknown> }
  assert.throws(
    () => buildCreateTaskWriteRequest(fixture.session, {
      todo: { ...input.todo, owner: "victor" },
    }),
    (error: unknown) =>
      error instanceof WriteContractError && error.code === "write-not-authorized",
  )
})

test("update delete and restore reject missing or inexact revisions", () => {
  const update = fixture.accepted.find((row) => row.operation === "update")!
  const updateInput = update.input as Record<string, unknown>
  const deleteInput = fixture.accepted.find((row) => row.operation === "delete")!.input
  const restoreInput = fixture.accepted.find((row) => row.operation === "restore")!.input

  assert.throws(
    () => buildUpdateTaskWriteRequest(fixture.session, { todo: updateInput.todo }),
    WriteContractError,
  )
  assert.equal(
    buildUpdateTaskWriteRequest(fixture.session, {
      ...updateInput,
      baseUpdatedAtMs: 0,
    }).args.baseUpdatedAtMs,
    0,
  )
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => buildUpdateTaskWriteRequest(fixture.session, {
        ...updateInput,
        baseUpdatedAtMs: revision,
      }),
      WriteContractError,
    )
  }
  assert.throws(
    () => buildDeleteTaskWriteRequest(fixture.session, {
      ...(deleteInput as Record<string, unknown>),
      baseUpdatedAtMs: undefined,
    }),
    WriteContractError,
  )
  assert.throws(
    () => buildRestoreTaskWriteRequest(fixture.session, {
      ...(restoreInput as Record<string, unknown>),
      baseUpdatedAtMs: undefined,
    }),
    WriteContractError,
  )
})

test("restore wire cannot carry a client-owned task or replacement capsule", () => {
  const restore = fixture.accepted.find((row) => row.operation === "restore")!
  const request = buildRestoreTaskWriteRequest(fixture.session, restore.input)
  assert.equal("todo" in request.args, false)
  assert.equal("capsule" in request.args, false)
  assert.throws(
    () => buildRestoreTaskWriteRequest(fixture.session, {
      ...(restore.input as Record<string, unknown>),
      todo: { id: "task-fresh-01", owner: "mason" },
    }),
    WriteContractError,
  )
})

test("fixture pins server authorization state and admin sync-token policy", () => {
  assert.deepEqual(
    [...new Set(fixture.serverRejections.map((row) => row.errorCode))].sort(),
    [
      "ENTITY_CONFLICT",
      "ENTITY_DELETED",
      "OWNER_MISMATCH",
      "PROFILE_BINDING_REQUIRED",
      "REVISION_REQUIRED",
    ],
  )
  for (const row of fixture.serverRejections) {
    assert.equal(TASK_WRITE_SERVER_ERROR_CODES.includes(row.errorCode), true, row.name)
  }
  assert.deepEqual(fixture.syncTokenTaskWrites, {
    mode: "admin-only",
    interactive: false,
  })
})

test("runtime credentials stay outside shared task payload fixtures", () => {
  const serialized = JSON.stringify(fixture)
  assert.equal(serialized.includes('"deviceToken"'), false)
  assert.equal(serialized.includes('"token"'), false)
})
