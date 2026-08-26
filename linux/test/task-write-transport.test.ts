import { describe, expect, it, vi } from "vitest"

import {
  PAIRED_DEVICE_PATHS,
  createPairedDeviceController,
} from "../electron/convexMutations.ts"
import type {
  DeviceCredentialSnapshot,
  DeviceCredentialStore,
} from "../electron/deviceCredentialStore.ts"
import type { JsonPoster } from "../electron/convexRead.ts"
import type { VogelVaultMutationRequest } from "../shared/ipc.ts"

const snapshot: DeviceCredentialSnapshot = {
  revision: "revision_task_profile_bound",
  deploymentOrigin: "https://household.convex.cloud",
  deviceId: "device_profile_mason",
  deviceCredential: "credential_abcdefghijklmnopqrstuvwxyz0123456789",
  profile: "mason",
  pairedAt: 1_787_702_400_000,
  capabilities: ["todo.upsert", "todo.delete", "todo.restore"],
}

function store(initial: DeviceCredentialSnapshot | null = snapshot): DeviceCredentialStore & {
  current: DeviceCredentialSnapshot | null
} {
  return {
    current: initial,
    readiness: () => "ready",
    async load() {
      return this.current
    },
    async save(input) {
      this.current = { ...input, revision: snapshot.revision }
      return this.current
    },
    async clearIfCurrent(revision) {
      if (this.current?.revision !== revision) return false
      this.current = null
      return true
    },
  }
}

function success(value: unknown) {
  return {
    httpStatus: 200,
    body: JSON.stringify({ status: "success", value }),
  }
}

function failure(code: string) {
  return {
    httpStatus: 200,
    body: JSON.stringify({
      status: "error",
      errorData: { code, message: "redacted", entityType: "todo", entityId: "task-01" },
    }),
  }
}

function todoUpsert(baseUpdatedAtMs?: number): VogelVaultMutationRequest {
  return {
    kind: "todo.upsert",
    requestId: "request_task_01",
    actor: "mason",
    id: "task-01",
    owner: "mason",
    title: "Pack school bag",
    done: false,
    flagged: true,
    priority: 2n,
    ...(baseUpdatedAtMs === undefined ? {} : { baseUpdatedAtMs }),
  }
}

function taskRequest(
  kind: "todo.delete" | "todo.restore",
  baseUpdatedAtMs = 1_787_702_400_456,
): VogelVaultMutationRequest {
  return {
    kind,
    requestId: `request_${kind.replace(".", "_")}`,
    actor: "mason",
    id: "task-01",
    owner: "mason",
    baseUpdatedAtMs,
  }
}

function controllerWithPost(post: JsonPoster, credentialStore = store()) {
  return createPairedDeviceController({
    store: credentialStore,
    writesEnabled: () => true,
    approvedDeploymentOrigin: () => snapshot.deploymentOrigin,
    post,
  })
}

describe("profile-bound Linux task-write transport", () => {
  it("labels a revisionless fresh-id write as create and injects consistency echoes", async () => {
    const post = vi.fn(async (_endpoint: string, body: string) => {
      const wire = JSON.parse(body)
      return success({ ok: true, entityId: wire.args.todo.id, outcome: "inserted" })
    })

    await expect(controllerWithPost(post).mutate(todoUpsert(), "mason")).resolves.toMatchObject({
      status: "ok",
      outcome: "inserted",
    })
    const wire = JSON.parse(post.mock.calls[0]?.[1] as string)
    expect(wire).toMatchObject({
      path: PAIRED_DEVICE_PATHS["todo.upsert"],
      format: "convex_encoded_json",
      args: {
        deviceId: snapshot.deviceId,
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        operation: "create",
        todo: { id: "task-01", owner: "mason" },
      },
    })
    expect(wire.args).not.toHaveProperty("baseUpdatedAtMs")
    expect(wire.args).not.toHaveProperty("actor")
  })

  it("labels an edit as update and sends the exact authoritative revision", async () => {
    const revision = 1_787_702_400_123
    const bodies: string[] = []
    const post = vi.fn(async (...args: [string, string]) => {
      bodies.push(args[1])
      return success({ ok: true, entityId: "task-01", outcome: "updated" })
    })

    await expect(controllerWithPost(post).mutate(todoUpsert(revision), "mason"))
      .resolves.toMatchObject({ status: "ok", outcome: "updated" })
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      args: { operation: "update", baseUpdatedAtMs: revision },
    })
  })

  it.each(["todo.delete", "todo.restore"] as const)(
    "sends exact revision and no replacement capsule for %s",
    async (kind) => {
      const revision = 1_787_702_400_456
      const bodies: string[] = []
      const post = vi.fn(async (...args: [string, string]) => {
        bodies.push(args[1])
        return kind === "todo.restore"
          ? success({ ok: true, entityId: "task-01", updatedAtMs: revision + 1 })
          : success({ ok: true, entityId: "task-01", removed: true })
      })

      const result = await controllerWithPost(post).mutate(taskRequest(kind, revision), "mason")
      const wire = JSON.parse(bodies[0]!)
      expect(wire.path).toBe(PAIRED_DEVICE_PATHS[kind])
      expect(wire.args).toMatchObject({
        activeProfile: "mason",
        owner: "mason",
        entityId: "task-01",
        baseUpdatedAtMs: revision,
      })
      expect(wire.args).not.toHaveProperty("todo")
      expect(result).toMatchObject({
        status: "ok",
        outcome: kind === "todo.restore" ? "restored" : "deleted",
      })
      if (kind === "todo.restore") {
        expect(result).toMatchObject({ updatedAtMs: revision + 1 })
      }
    },
  )

  it("refuses task owner, session, and stored-profile disagreement before network use", async () => {
    const post = vi.fn()
    const controller = controllerWithPost(post)

    await expect(controller.mutate({ ...todoUpsert(12), owner: "victor" }, "mason"))
      .resolves.toMatchObject({ status: "unauthorized" })
    await expect(controller.mutate({ ...todoUpsert(12), actor: "rachel", owner: "rachel" }, "rachel"))
      .resolves.toMatchObject({ status: "unauthorized" })
    expect(post).not.toHaveBeenCalled()
  })

  it("surfaces legacy unbound credentials without falling back to another write path", async () => {
    const post = vi.fn()
    const legacyStore = store({ ...snapshot, profile: null })

    await expect(controllerWithPost(post, legacyStore).mutate(todoUpsert(), "mason"))
      .resolves.toEqual({
        status: "failed",
        requestId: "request_task_01",
        kind: "todo.upsert",
        code: "PROFILE_BINDING_REQUIRED",
      })
    expect(post).not.toHaveBeenCalled()
    expect(legacyStore.current).not.toBeNull()
  })

  it.each([
    ["PROFILE_BINDING_REQUIRED", "PROFILE_BINDING_REQUIRED"],
    ["REVISION_REQUIRED", "REVISION_REQUIRED"],
  ] as const)("surfaces %s exactly and retains the device credential", async (serverCode, clientCode) => {
    const credentialStore = store()
    const post = vi.fn(async () => failure(serverCode))

    await expect(controllerWithPost(post, credentialStore).mutate(todoUpsert(42), "mason"))
      .resolves.toMatchObject({ status: "failed", code: clientCode })
    expect(post).toHaveBeenCalledOnce()
    expect(credentialStore.current).toBe(snapshot)
  })

  it.each(["todo.upsert", "todo.delete", "todo.restore"] as const)(
    "surfaces stale %s revisions as conflicts",
    async (kind) => {
      const request = kind === "todo.upsert" ? todoUpsert(41) : taskRequest(kind, 41)
      const post = vi.fn(async () => failure("ENTITY_CONFLICT"))

      await expect(controllerWithPost(post).mutate(request, "mason"))
        .resolves.toMatchObject({ status: "failed", code: "conflict" })
      expect(post).toHaveBeenCalledOnce()
    },
  )

  it("retries the same create id after an offline failure without changing the payload", async () => {
    const bodies: string[] = []
    const post = vi.fn(async (_endpoint: string, body: string) => {
      bodies.push(body)
      if (bodies.length === 1) throw new Error("offline")
      return success({ ok: true, entityId: "task-01", outcome: "inserted" })
    })
    const controller = controllerWithPost(post)
    const request = todoUpsert()

    await expect(controller.mutate(request, "mason")).resolves.toMatchObject({
      status: "failed",
      code: "unavailable",
    })
    await expect(controller.mutate(request, "mason")).resolves.toMatchObject({
      status: "ok",
      outcome: "inserted",
    })
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[0]!)).toEqual(JSON.parse(bodies[1]!))
  })
})
