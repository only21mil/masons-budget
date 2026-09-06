import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createPairedDeviceController } from "../electron/convexMutations.ts"
import {
  CredentialStorageError,
  createDeviceCredentialStore,
  type SafeStorageAdapter,
} from "../electron/deviceCredentialStore.ts"

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vv-device-store-"))
  roots.push(root)
  return root
}

function protectedStorage(
  overrides: Partial<SafeStorageAdapter> = {},
): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => {
      const text = value.toString("utf8")
      if (!text.startsWith("protected:")) throw new Error("invalid")
      return text.slice("protected:".length)
    },
    ...overrides,
  }
}

function fixture() {
  return {
    deploymentOrigin: "https://example.convex.cloud",
    deviceId: "abcdefghijklmnopqrs",
    deviceCredential: "abcdefghijklmnopqrstuvwxyz0123456789_AAAAAA",
    profile: "mason" as const,
    pairedAt: 1_774_000_000_000,
    capabilities: ["transaction.upsert", "transaction.delete"],
  } as const
}

describe("paired-device credential storage", () => {
  it.each([
    {
      label: "before app readiness",
      ready: false,
      backend: "gnome_libsecret",
      encryption: true,
      expected: "app-not-ready",
    },
    {
      label: "without encryption",
      ready: true,
      backend: "gnome_libsecret",
      encryption: false,
      expected: "encryption-unavailable",
    },
    {
      label: "with basic_text",
      ready: true,
      backend: "basic_text",
      encryption: true,
      expected: "unsafe-linux-backend",
    },
    {
      label: "with unknown backend",
      ready: true,
      backend: "unknown",
      encryption: true,
      expected: "unsafe-linux-backend",
    },
  ])("refuses storage $label", async ({ ready, backend, encryption, expected }) => {
    const store = createDeviceCredentialStore({
      appReady: () => ready,
      platform: "linux",
      safeStorage: protectedStorage({
        isEncryptionAvailable: () => encryption,
        getSelectedStorageBackend: () => backend,
      }),
      userDataPath: await temporaryRoot(),
    })

    expect(store.readiness()).toBe(expected)
    await expect(store.save(fixture())).rejects.toMatchObject({
      code: "unavailable",
    })
  })

  it("writes an encrypted 0600 file beneath a 0700 directory and round-trips", async () => {
    const root = await temporaryRoot()
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: root,
    })

    const saved = await store.save(fixture())
    const directory = path.join(root, "paired-device")
    const file = path.join(directory, "credential.json")
    const body = await readFile(file, "utf8")

    expect(body).not.toContain(fixture().deviceCredential)
    expect(body).not.toContain(fixture().deploymentOrigin)
    expect(body).not.toContain(fixture().deviceId)
    expect(body).not.toContain("transaction.upsert")
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await expect(store.load()).resolves.toEqual(saved)
  })

  it("round-trips the expanded budget copy grant in protected storage", async () => {
    const store = createDeviceCredentialStore({
      appReady: () => true, platform: "linux", safeStorage: protectedStorage(),
      userDataPath: await temporaryRoot(),
    })
    const saved = await store.save({ ...fixture(), capabilities: ["budgetPlan.copyForward"] })
    await expect(store.load()).resolves.toEqual(saved)
  })

  it("reads schema-1 credentials as explicitly unbound while new saves retain the profile", async () => {
    const root = await temporaryRoot()
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: root,
    })
    const saved = await store.save(fixture())
    expect(saved.profile).toBe("mason")

    const file = path.join(root, "paired-device", "credential.json")
    const envelope = JSON.parse(await readFile(file, "utf8")) as {
      schemaVersion: number
      encryptedPayload: string
    }
    const protectedPayload = Buffer.from(envelope.encryptedPayload, "base64").toString("utf8")
    const payload = JSON.parse(protectedPayload.slice("protected:".length)) as Record<string, unknown>
    payload.schemaVersion = 1
    delete payload.profile
    envelope.encryptedPayload = Buffer.from(
      `protected:${JSON.stringify(payload)}`,
      "utf8",
    ).toString("base64")
    await writeFile(file, JSON.stringify(envelope), { mode: 0o600 })

    await expect(store.load()).resolves.toEqual({ ...saved, profile: null })
  })

  it.each([
    ["deploymentOrigin", "https://attacker.convex.cloud"],
    ["deviceId", "attacker_device_abcdefghijkl"],
    ["capabilities", ["btcAccount.upsert"]],
  ])("rejects plaintext %s injection before opening a network request", async (field, value) => {
    const root = await temporaryRoot()
    const credentialStore = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: root,
    })
    await credentialStore.save(fixture())
    const file = path.join(root, "paired-device", "credential.json")
    const envelope = JSON.parse(await readFile(file, "utf8"))
    envelope[field] = value
    await writeFile(file, JSON.stringify(envelope), { mode: 0o600 })
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: credentialStore,
      writesEnabled: () => true,
      approvedDeploymentOrigin: () => fixture().deploymentOrigin,
      post,
    })

    await expect(controller.mutate({
      kind: "transaction.delete",
      requestId: "request_tamper",
      actor: "victor",
      id: "tx-1",
      owner: "victor",
      baseUpdatedAtMs: 100,
    }, "victor")).resolves.toMatchObject({ status: "failed", code: "credential-storage" })
    expect(post).not.toHaveBeenCalled()
  })

  it("fails closed on corrupt, oversized, and symlinked files", async () => {
    const root = await temporaryRoot()
    const directory = path.join(root, "paired-device")
    const file = path.join(directory, "credential.json")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: root,
    })

    await writeFile(file, "{not-json", { mode: 0o600 })
    await expect(store.load()).rejects.toBeInstanceOf(CredentialStorageError)

    await writeFile(file, "x".repeat(17 * 1024), { mode: 0o600 })
    await expect(store.load()).rejects.toMatchObject({ code: "invalid" })

    const target = path.join(root, "target")
    await writeFile(target, "{}", { mode: 0o600 })
    const { unlink } = await import("node:fs/promises")
    await unlink(file)
    await symlink(target, file)
    await expect(store.load()).rejects.toMatchObject({ code: "invalid" })
  })

  it("refuses capabilities outside the closed mutation vocabulary", async () => {
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: await temporaryRoot(),
    })

    await expect(store.save({
      ...fixture(),
      capabilities: ["admin.everything" as never],
    })).rejects.toMatchObject({ code: "invalid" })
  })

  it("preserves an explicit empty capability grant", async () => {
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: await temporaryRoot(),
    })

    const saved = await store.save({ ...fixture(), capabilities: [] })
    expect(saved.capabilities).toEqual([])
    await expect(store.load()).resolves.toEqual(saved)
  })

  it("rejects permissive and symlinked credential directories", async () => {
    const root = await temporaryRoot()
    const permissiveDirectory = path.join(root, "paired-device")
    await mkdir(permissiveDirectory, { mode: 0o700 })
    await chmod(permissiveDirectory, 0o755)
    const permissiveStore = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: root,
    })
    await expect(permissiveStore.load()).rejects.toMatchObject({ code: "invalid" })

    const linkedRoot = await temporaryRoot()
    const targetRoot = await temporaryRoot()
    await mkdir(path.join(targetRoot, "paired-device"), { mode: 0o700 })
    await symlink(path.join(targetRoot, "paired-device"), path.join(linkedRoot, "paired-device"))
    const linkedStore = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: linkedRoot,
    })
    await expect(linkedStore.load()).rejects.toMatchObject({ code: "invalid" })
  })

  it("clears only the credential revision that received the rejection", async () => {
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: await temporaryRoot(),
    })

    const first = await store.save(fixture())
    const second = await store.save({
      ...fixture(),
      deviceCredential: "replacement_abcdefghijklmnopqrstuvwxyz01234567",
    })

    await expect(store.clearIfCurrent(first.revision)).resolves.toBe(false)
    await expect(store.load()).resolves.toEqual(second)
    await expect(store.clearIfCurrent(second.revision)).resolves.toBe(true)
    await expect(store.load()).resolves.toBeNull()
  })
})
