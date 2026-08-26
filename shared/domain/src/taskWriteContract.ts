import { encodeConvexInt64, type ConvexInt64WireValue } from "./convexInt64.ts"
import { isFamilyMember, type FamilyMember } from "./family.ts"
import {
  CONVEX_WRITE_FORMAT,
  WriteContractError,
  parseWriteInt64,
} from "./writeContract.ts"

export const UPSERT_TASK_FROM_DEVICE_PATH = "tables:upsertTodoFromDevice" as const
export const DELETE_TASK_FROM_DEVICE_PATH = "tables:deleteTodoFromDevice" as const
export const RESTORE_TASK_FROM_DEVICE_PATH = "tables:restoreTodoFromDevice" as const

export const TASK_WRITE_SERVER_ERROR_CODES = [
  "PROFILE_BINDING_REQUIRED",
  "REVISION_REQUIRED",
  "ENTITY_CONFLICT",
  "ENTITY_DELETED",
  "ENTITY_NOT_FOUND",
  "OWNER_MISMATCH",
  "VALIDATION_FAILED",
] as const

export type TaskWriteServerErrorCode = (typeof TASK_WRITE_SERVER_ERROR_CODES)[number]

/** Non-secret view of an authenticated, profile-bound device session. */
export interface ProfileBoundTaskSession {
  readonly deviceId: string
  readonly profile: FamilyMember
}

export interface TaskWriteTodoInput {
  readonly id: string
  readonly owner: FamilyMember
  readonly title: string
  readonly done: boolean
  readonly flagged: boolean
  readonly lane?: string
  readonly project?: string
  readonly area?: string
  readonly due?: string
  readonly notes?: string
  readonly priority?: string | bigint
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly completedAt?: string
}

export interface TaskWriteTodoWire extends Omit<TaskWriteTodoInput, "priority"> {
  readonly priority?: ConvexInt64WireValue
}

interface TaskWriteAuthorityEchoes {
  readonly deviceId: string
  readonly activeProfile: FamilyMember
  readonly owner: FamilyMember
  readonly sourceFile: "todos"
}

export interface CreateTaskWriteRequest {
  readonly path: typeof UPSERT_TASK_FROM_DEVICE_PATH
  readonly format: typeof CONVEX_WRITE_FORMAT
  readonly args: TaskWriteAuthorityEchoes & {
    readonly operation: "create"
    readonly todo: TaskWriteTodoWire
  }
}

export interface UpdateTaskWriteRequest {
  readonly path: typeof UPSERT_TASK_FROM_DEVICE_PATH
  readonly format: typeof CONVEX_WRITE_FORMAT
  readonly args: TaskWriteAuthorityEchoes & {
    readonly operation: "update"
    readonly baseUpdatedAtMs: number
    readonly todo: TaskWriteTodoWire
  }
}

export interface DeleteTaskWriteRequest {
  readonly path: typeof DELETE_TASK_FROM_DEVICE_PATH
  readonly format: typeof CONVEX_WRITE_FORMAT
  readonly args: TaskWriteAuthorityEchoes & {
    readonly entityId: string
    readonly baseUpdatedAtMs: number
  }
}

export interface RestoreTaskWriteRequest {
  readonly path: typeof RESTORE_TASK_FROM_DEVICE_PATH
  readonly format: typeof CONVEX_WRITE_FORMAT
  readonly args: TaskWriteAuthorityEchoes & {
    readonly entityId: string
    readonly baseUpdatedAtMs: number
  }
}

/** Create is accepted only when the server finds an unused, untombstoned id. */
export function buildCreateTaskWriteRequest(
  session: unknown,
  candidate: unknown,
): CreateTaskWriteRequest {
  const authority = taskAuthorityEchoes(session)
  const input = closedRecord(candidate, "create", ["todo"])
  return {
    path: UPSERT_TASK_FROM_DEVICE_PATH,
    format: CONVEX_WRITE_FORMAT,
    args: {
      ...authority,
      operation: "create",
      todo: taskTodo(input.todo, authority.owner),
    },
  }
}

/** Update requires the exact revision returned by the authoritative server read. */
export function buildUpdateTaskWriteRequest(
  session: unknown,
  candidate: unknown,
): UpdateTaskWriteRequest {
  const authority = taskAuthorityEchoes(session)
  const input = closedRecord(candidate, "update", ["todo", "baseUpdatedAtMs"])
  return {
    path: UPSERT_TASK_FROM_DEVICE_PATH,
    format: CONVEX_WRITE_FORMAT,
    args: {
      ...authority,
      operation: "update",
      baseUpdatedAtMs: requiredRevision(input.baseUpdatedAtMs),
      todo: taskTodo(input.todo, authority.owner),
    },
  }
}

export function buildDeleteTaskWriteRequest(
  session: unknown,
  candidate: unknown,
): DeleteTaskWriteRequest {
  const authority = taskAuthorityEchoes(session)
  const input = closedRecord(candidate, "delete", ["entityId", "baseUpdatedAtMs"])
  return {
    path: DELETE_TASK_FROM_DEVICE_PATH,
    format: CONVEX_WRITE_FORMAT,
    args: {
      ...authority,
      entityId: requiredIdentifier(input.entityId, "entityId"),
      baseUpdatedAtMs: requiredRevision(input.baseUpdatedAtMs),
    },
  }
}

/** Restore names server-owned restore data and never sends replacement content. */
export function buildRestoreTaskWriteRequest(
  session: unknown,
  candidate: unknown,
): RestoreTaskWriteRequest {
  const authority = taskAuthorityEchoes(session)
  const input = closedRecord(candidate, "restore", ["entityId", "baseUpdatedAtMs"])
  return {
    path: RESTORE_TASK_FROM_DEVICE_PATH,
    format: CONVEX_WRITE_FORMAT,
    args: {
      ...authority,
      entityId: requiredIdentifier(input.entityId, "entityId"),
      baseUpdatedAtMs: requiredRevision(input.baseUpdatedAtMs),
    },
  }
}

function taskAuthorityEchoes(value: unknown): TaskWriteAuthorityEchoes {
  const session = closedRecord(value, "profile-bound task session", ["deviceId", "profile"])
  if (!isFamilyMember(session.profile)) {
    throw new WriteContractError(
      "invalid-actor",
      "profile-bound task session profile must be a known family member",
    )
  }
  return {
    deviceId: requiredIdentifier(session.deviceId, "deviceId"),
    activeProfile: session.profile,
    owner: session.profile,
    sourceFile: "todos",
  }
}

function taskTodo(value: unknown, boundProfile: FamilyMember): TaskWriteTodoWire {
  const todo = closedRecord(value, "todo", [
    "id", "owner", "title", "done", "flagged", "lane", "project", "area",
    "due", "notes", "priority", "createdAt", "updatedAt", "completedAt",
  ])
  if (!isFamilyMember(todo.owner)) {
    throw new WriteContractError("invalid-owner", "todo.owner must be a known family member")
  }
  if (todo.owner !== boundProfile) {
    throw new WriteContractError(
      "write-not-authorized",
      "todo.owner must echo the profile bound to the device session",
    )
  }
  if (typeof todo.done !== "boolean" || typeof todo.flagged !== "boolean") {
    throw new WriteContractError("invalid-input", "todo.done and todo.flagged must be booleans")
  }
  const priority = todo.priority === undefined
    ? undefined
    : encodeConvexInt64(requiredNonnegativeInt64(todo.priority, "todo.priority"))
  return {
    id: requiredIdentifier(todo.id, "todo.id"),
    owner: todo.owner,
    title: requiredString(todo.title, "todo.title"),
    done: todo.done,
    flagged: todo.flagged,
    ...optionalStringField(todo, "lane"),
    ...optionalStringField(todo, "project"),
    ...optionalStringField(todo, "area"),
    ...optionalStringField(todo, "due"),
    ...optionalStringField(todo, "notes"),
    ...(priority === undefined ? {} : { priority }),
    ...optionalStringField(todo, "createdAt"),
    ...optionalStringField(todo, "updatedAt"),
    ...optionalStringField(todo, "completedAt"),
  }
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WriteContractError(
      "invalid-input",
      "baseUpdatedAtMs must be an exact non-negative server revision",
    )
  }
  return value as number
}

function requiredNonnegativeInt64(value: unknown, field: string): bigint {
  const parsed = parseWriteInt64(value)
  if (parsed < 0n) {
    throw new WriteContractError("invalid-input", `${field} must be non-negative`)
  }
  return parsed
}

function closedRecord(
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WriteContractError("invalid-input", `${field} must be an object`)
  }
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).find((key) => !allowedKeys.includes(key))
  if (unexpected !== undefined) {
    throw new WriteContractError("invalid-input", `${field}.${unexpected} is not allowed`)
  }
  return record
}

function requiredIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field)
  if (
    identifier !== identifier.trim() ||
    identifier.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(identifier)
  ) {
    throw new WriteContractError(
      "invalid-input",
      `${field} must be at most 256 characters with no whitespace padding or controls`,
    )
  }
  return identifier
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WriteContractError("invalid-input", `${field} must be a non-empty string`)
  }
  return value
}

function optionalStringField(
  record: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = record[field]
  if (value === undefined) return {}
  if (typeof value !== "string") {
    throw new WriteContractError("invalid-input", `${field} must be a string when present`)
  }
  return { [field]: value }
}
